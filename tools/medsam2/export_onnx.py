"""MedSAM2 (SAM 2.1 Hiera-tiny, 512) as four ONNX graphs for the browser, each checked against PyTorch:

  encoder.onnx        image (1,3,512,512) -> high0 (1,32,128,128), high1 (1,64,64,64), vision (1,256,32,32), vision_pos
  memory_attention.onnx  vision, vision_pos, mem_feats (F,64,32,32), mem_pos (F,64,32,32), mem_tpos (F) int64,
                      obj_ptrs (P,256), obj_tpos (P) float, t_diff_max () float -> pix (1,256,32,32)
  heads.onnx          pix, high0, high1, point_coords (1,N,2) (512 px), point_labels (1,N) int32
                      -> masks (1,4,128,128), ious (1,4), obj_ptrs (1,4,256), object_score (1,1)
  memory_encoder.onnx vision, mask (1,1,128,128), object_score (1,1), binarize (1,) -> maskmem (1,64,32,32), maskmem_pos

The memory attention is written again here (same weights): RoPE in real numbers (ONNX has no complex type) and
the spatial memory and object-pointer tokens as separate inputs (only the spatial keys are rotated), so nothing
depends on slicing by a data-dependent length. constants.json: no_mem_embed and the model's settings.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "repo"))
from sam2.build_sam import build_sam2_video_predictor_npz  # noqa: E402
from sam2.modeling.sam2_utils import get_1d_sine_pe  # noqa: E402

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else HERE / "onnx")
OUT.mkdir(parents=True, exist_ok=True)
torch.manual_seed(0)

os.chdir(HERE / "repo")
model = build_sam2_video_predictor_npz("configs/sam2.1_hiera_t512.yaml", str(HERE / "repo/checkpoints/MedSAM2_latest.pt"), device="cpu")
model.eval()

# The trunk's position embedding is interpolated to the image's size at run time (an If in ONNX, whose branches'
# shapes disagree, which onnxruntime-web refuses); the image is always 512 x 512, so it is a constant: computed
# once and returned as it is, so the export holds it as a tensor.
_trunk = model.image_encoder.trunk
_pos_embed = _trunk._get_pos_embed
_pos_cache: dict = {}


def _fixed_pos_embed(hw):
    key = tuple(int(x) for x in hw)
    if key not in _pos_cache:
        with torch.no_grad():
            _pos_cache[key] = _pos_embed(key).detach().clone()
    return _pos_cache[key]


_trunk._get_pos_embed = _fixed_pos_embed


# ------------------------------------------------------------------ RoPE in real numbers

def rope_tables(attn) -> tuple[torch.Tensor, torch.Tensor]:
    fc = attn.freqs_cis  # (1024, D/2) complex
    return fc.real.float().contiguous(), fc.imag.float().contiguous()


def rotate(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    """x (B, H, N, D) with N a multiple of len(cos): each pair (x0, x1) turned by the angle of its position."""
    b, h, n, d = x.shape
    q = cos.shape[0]
    xr = x.reshape(b, h, -1, q, d // 2, 2)
    x0, x1 = xr[..., 0], xr[..., 1]
    out = torch.stack([x0 * cos - x1 * sin, x0 * sin + x1 * cos], dim=-1)
    return out.reshape(b, h, n, d)


class RopeAttn(torch.nn.Module):
    """A RoPEAttention (single head here) whose keys come in two parts: rotated (spatial) and not (pointers)."""

    def __init__(self, attn):
        super().__init__()
        self.a = attn
        cos, sin = rope_tables(attn)
        self.register_buffer("cos", cos)
        self.register_buffer("sin", sin)

    def heads(self, x):
        return self.a._separate_heads(x, self.a.num_heads)

    def forward(self, q, k_rot, v_rot, k_plain=None, v_plain=None):
        a = self.a
        q = self.heads(a.q_proj(q))
        k = rotate(self.heads(a.k_proj(k_rot)), self.cos, self.sin)
        v = self.heads(a.v_proj(v_rot))
        q = rotate(q, self.cos, self.sin)
        if k_plain is not None:
            k = torch.cat([k, self.heads(a.k_proj(k_plain))], dim=-2)
            v = torch.cat([v, self.heads(a.v_proj(v_plain))], dim=-2)
        out = F.scaled_dot_product_attention(q, k, v)
        return a.out_proj(a._recombine_heads(out))


class MemoryAttention(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m
        ma = m.memory_attention
        self.layers = ma.layers
        self.self_attn = torch.nn.ModuleList([RopeAttn(l.self_attn) for l in ma.layers])
        self.cross_attn = torch.nn.ModuleList([RopeAttn(l.cross_attn_image) for l in ma.layers])
        self.norm = ma.norm
        self.tpos = m.maskmem_tpos_enc  # (7, 1, 1, 64)
        self.ptr_tpos_proj = m.obj_ptr_tpos_proj
        self.C, self.mem_dim = m.hidden_dim, m.mem_dim

    def forward(self, vision, vision_pos, mem_feats, mem_pos, mem_tpos, obj_ptrs, obj_tpos, t_diff_max):
        # Tokens batch-first: (1, HW, C).
        curr = vision.flatten(2).transpose(1, 2)
        curr_pos = vision_pos.flatten(2).transpose(1, 2)
        # Spatial memory: each frame's (64, 32, 32) as 1024 tokens, its position + the temporal encoding of its slot.
        f = mem_feats.shape[0]
        mem = mem_feats.flatten(2).transpose(1, 2).reshape(1, -1, self.mem_dim)
        pos = (mem_pos.flatten(2).transpose(1, 2) + self.tpos[mem_tpos].reshape(f, 1, self.mem_dim)).reshape(1, -1, self.mem_dim)
        # Object pointers: each split into C / mem_dim tokens, with a sine encoding of how far away it is, projected.
        k = self.C // self.mem_dim
        ptr = obj_ptrs.reshape(1, -1, self.mem_dim)  # (P*k) tokens, in order
        ptr_pos = self.ptr_tpos_proj(get_1d_sine_pe(obj_tpos / t_diff_max, dim=self.C))  # (P, 64)
        ptr_pos = ptr_pos.repeat_interleave(k, dim=0).unsqueeze(0)
        out = curr + 0.1 * curr_pos
        for layer, sa, ca in zip(self.layers, self.self_attn, self.cross_attn):
            t2 = layer.norm1(out)
            out = out + sa(t2, t2, t2)
            t2 = layer.norm2(out)
            out = out + ca(t2, mem + pos, mem, ptr + ptr_pos, ptr)
            t2 = layer.norm3(out)
            out = out + layer.linear2(layer.activation(layer.linear1(t2)))
        out = self.norm(out)
        return out.transpose(1, 2).reshape(1, self.C, 32, 32)


class Encoder(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, image):
        out = self.m.forward_image(image)
        fpn, pos = out["backbone_fpn"], out["vision_pos_enc"]
        return fpn[0], fpn[1], fpn[2], pos[2]


class Heads(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, pix, high0, high1, point_coords, point_labels):
        m = self.m
        pe = m.sam_prompt_encoder
        # The prompt encoder's points (_embed_points, pad=True) without boolean-index assignment: a padding point
        # (label -1) appended, "not a point" for -1, each label's learned embedding added.
        pts = torch.cat([point_coords + 0.5, torch.zeros_like(point_coords[:, :1])], dim=1)
        lab = torch.cat([point_labels.float(), -torch.ones_like(point_labels[:, :1]).float()], dim=1).unsqueeze(-1)
        emb = pe.pe_layer.forward_with_coords(pts, pe.input_image_size)
        emb = torch.where(lab == -1, pe.not_a_point_embed.weight.reshape(1, 1, -1), emb)
        for k in range(4):
            emb = emb + (lab == k).float() * pe.point_embeddings[k].weight.reshape(1, 1, -1)
        sparse = emb
        dense = pe.no_mask_embed.weight.reshape(1, -1, 1, 1).expand(1, -1, pe.image_embedding_size[0], pe.image_embedding_size[1])
        masks, ious, tokens, score = m.sam_mask_decoder.predict_masks(
            image_embeddings=pix, image_pe=m.sam_prompt_encoder.get_dense_pe(), sparse_prompt_embeddings=sparse,
            dense_prompt_embeddings=dense, repeat_image=False, high_res_features=[high0, high1])
        ptrs = m.obj_ptr_proj(tokens)  # (1, 4, 256)
        appearing = (score > 0).float()[..., None]  # (1, 1, 1)
        ptrs = appearing * ptrs + (1 - appearing) * m.no_obj_ptr
        return masks, ious, ptrs, score


class MemoryEncoder(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, vision, mask, object_score, binarize):
        m = self.m
        high = F.interpolate(mask, size=(m.image_size, m.image_size), mode="bilinear", align_corners=False)
        mm = torch.where(binarize > 0.5, (high > 0).float(), torch.sigmoid(high))
        mm = mm * m.sigmoid_scale_for_mem_enc + m.sigmoid_bias_for_mem_enc
        out = m.memory_encoder(vision, mm, skip_mask_sigmoid=True)
        feats = out["vision_features"]
        appearing = (object_score > 0).float()[..., None, None]
        feats = feats + (1 - appearing) * m.no_obj_embed_spatial[..., None, None]
        return feats, out["vision_pos_enc"][-1]


# ------------------------------------------------------------------ checks against the model's own code

def close(a, b, what, tol=2e-4):
    a, b = np.asarray(a, np.float64), np.asarray(b, np.float64)
    err = float(np.max(np.abs(a - b)) / max(1.0, float(np.max(np.abs(b)))))
    print(f"  {what}: max rel diff {err:.2e}")
    assert err < tol, what
    return err


with torch.no_grad():
    img = torch.randn(1, 3, 512, 512)
    enc = Encoder(model)
    h0, h1, vis, vpos = enc(img)
    print("encoder", tuple(h0.shape), tuple(h1.shape), tuple(vis.shape), tuple(vpos.shape))

    # Memory attention, against the model's on the same memory (F frames, P pointers).
    ma = MemoryAttention(model).eval()
    Fn, P = 3, 5
    mem_feats = torch.randn(Fn, 64, 32, 32)
    _, mem_pos_one = MemoryEncoder(model)(vis, torch.randn(1, 1, 128, 128), torch.ones(1, 1), torch.zeros(1))
    mem_pos = mem_pos_one.expand(Fn, -1, -1, -1).contiguous()
    mem_tpos = torch.tensor([6, 1, 0])
    obj_ptrs, obj_tpos = torch.randn(P, 256), torch.tensor([3.0, 1, 2, 3, 4])
    t_diff_max = torch.tensor(15.0)
    mine = ma(vis, vpos, mem_feats, mem_pos, mem_tpos, obj_ptrs, obj_tpos, t_diff_max)
    memory = torch.cat([mem_feats[i].flatten(1).T[:, None] for i in range(Fn)] + [obj_ptrs.reshape(-1, 1, 64)])
    mpos = torch.cat([(mem_pos[i].flatten(1).T + model.maskmem_tpos_enc[int(mem_tpos[i])].reshape(1, 64))[:, None] for i in range(Fn)]
                     + [model.obj_ptr_tpos_proj(get_1d_sine_pe(obj_tpos / t_diff_max, dim=256)).repeat_interleave(4, 0)[:, None]])
    theirs = model.memory_attention(curr=[vis.flatten(2).permute(2, 0, 1)], curr_pos=[vpos.flatten(2).permute(2, 0, 1)],
                                    memory=memory, memory_pos=mpos, num_obj_ptr_tokens=P * 4)
    close(mine, theirs.permute(1, 2, 0).reshape(1, 256, 32, 32), "memory attention (rewritten) vs the model's")

    # Heads, against _forward_sam_heads (box prompt, single mask with stability fallback).
    heads = Heads(model)
    coords = torch.tensor([[[100.0, 120.0], [300.0, 330.0]]])
    labels = torch.tensor([[2, 3]], dtype=torch.int32)
    masks, ious, ptrs, score = heads(vis, h0, h1, coords, labels)
    ref_sparse, ref_dense = model.sam_prompt_encoder(points=(coords, labels), boxes=None, masks=None)
    ref_masks = model.sam_mask_decoder.predict_masks(image_embeddings=vis, image_pe=model.sam_prompt_encoder.get_dense_pe(), sparse_prompt_embeddings=ref_sparse,
        dense_prompt_embeddings=ref_dense, repeat_image=False, high_res_features=[h0, h1])[0]
    close(masks, ref_masks, "heads' masks (rewritten prompt embedding) vs the model's prompt encoder")
    ref = model._forward_sam_heads(vis, point_inputs={"point_coords": coords, "point_labels": labels}, high_res_features=[h0, h1], multimask_output=True)
    best = int(torch.argmax(ious[0, 1:])) + 1
    close(masks[0, 1:].clamp(min=-1024) if float(score) > 0 else masks[0, 1:] * 0 - 1024, ref[0][0], "heads' masks (multimask)")
    close(ptrs[0, best], ref[5][0], "heads' object pointer")

    menc = MemoryEncoder(model)
    feats, mpos1 = menc(vis, masks[:, 1:2], score, torch.ones(1))
    hr = F.interpolate(masks[:, 1:2], size=(512, 512), mode="bilinear", align_corners=False)
    rf, rp = model._encode_new_memory([vis.flatten(2).permute(2, 0, 1)], [(32, 32)], hr, score, is_mask_from_pts=True)
    close(feats, rf, "memory encoder")

    # ------------------------------------------------------------------ export
    import onnxruntime as ort

    def export(module, args, names, outs, dyn, file):
        path = OUT / file
        torch.onnx.export(module, args, str(path), input_names=names, output_names=outs, dynamic_axes=dyn, opset_version=17, do_constant_folding=True)
        sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        mb = path.stat().st_size / 1e6
        print(f"{file}: {mb:.1f} MB")
        return sess

    s = export(enc, (img,), ["image"], ["high0", "high1", "vision", "vision_pos"], None, "encoder.onnx")
    for a, b, n in zip(s.run(None, {"image": img.numpy()}), (h0, h1, vis, vpos), ["high0", "high1", "vision", "vision_pos"]):
        close(a, b, f"ONNX encoder {n}", 1e-3)

    s = export(ma, (vis, vpos, mem_feats, mem_pos, mem_tpos, obj_ptrs, obj_tpos, t_diff_max),
               ["vision", "vision_pos", "mem_feats", "mem_pos", "mem_tpos", "obj_ptrs", "obj_tpos", "t_diff_max"], ["pix"],
               {"mem_feats": {0: "F"}, "mem_pos": {0: "F"}, "mem_tpos": {0: "F"}, "obj_ptrs": {0: "P"}, "obj_tpos": {0: "P"}},
               "memory_attention.onnx")
    # Other numbers of frames and pointers than traced with.
    for fn, p in [(1, 1), (7, 16), (4, 9)]:
        args = (vis, vpos, torch.randn(fn, 64, 32, 32), mem_pos_one.expand(fn, -1, -1, -1).contiguous(), torch.randint(0, 7, (fn,)),
                torch.randn(p, 256), torch.arange(p).float() - 2, torch.tensor(float(max(p, 2) - 1)))
        want = ma(*args)
        got = s.run(None, {k: v.numpy() for k, v in zip(["vision", "vision_pos", "mem_feats", "mem_pos", "mem_tpos", "obj_ptrs", "obj_tpos", "t_diff_max"], args)})[0]
        close(got, want, f"ONNX memory attention, {fn} frames {p} pointers", 1e-3)

    s = export(heads, (vis, h0, h1, coords, labels), ["pix", "high0", "high1", "point_coords", "point_labels"],
               ["masks", "ious", "obj_ptrs", "object_score"], {"point_coords": {1: "N"}, "point_labels": {1: "N"}}, "heads.onnx")
    for c, l in [(coords, labels), (torch.zeros(1, 1, 2), -torch.ones(1, 1, dtype=torch.int32)),
                 (torch.tensor([[[100.0, 120.0], [300.0, 330.0], [200.0, 200.0]]]), torch.tensor([[2, 3, 1]], dtype=torch.int32))]:
        want = heads(vis, h0, h1, c, l)
        got = s.run(None, {"pix": vis.numpy(), "high0": h0.numpy(), "high1": h1.numpy(), "point_coords": c.numpy(), "point_labels": l.numpy()})
        for a, b, n in zip(got, want, ["masks", "ious", "obj_ptrs", "object_score"]):
            close(a, b, f"ONNX heads {n}, {c.shape[1]} points", 2e-3)

    s = export(menc, (vis, masks[:, 1:2], score, torch.ones(1)), ["vision", "mask", "object_score", "binarize"], ["maskmem", "maskmem_pos"], None, "memory_encoder.onnx")
    for b in (0.0, 1.0):
        want = menc(vis, masks[:, 2:3], score, torch.tensor([b]))
        got = s.run(None, {"vision": vis.numpy(), "mask": masks[:, 2:3].numpy(), "object_score": score.numpy(), "binarize": np.array([b], np.float32)})
        close(got[0], want[0], f"ONNX memory encoder (binarize {b})", 1e-3)

    constants = {
        "image_size": model.image_size, "num_maskmem": model.num_maskmem, "max_obj_ptrs_in_encoder": model.max_obj_ptrs_in_encoder,
        "mem_dim": model.mem_dim, "hidden_dim": model.hidden_dim, "no_obj_score": -1024.0,
        "stability_delta": float(model.sam_mask_decoder.dynamic_multimask_stability_delta),
        "stability_thresh": float(model.sam_mask_decoder.dynamic_multimask_stability_thresh),
        "pixel_mean": [0.485, 0.456, 0.406], "pixel_std": [0.229, 0.224, 0.225],
        "no_mem_embed": model.no_mem_embed.reshape(-1).tolist(),
    }
    (OUT / "constants.json").write_text(json.dumps(constants))
    print("constants.json written")
