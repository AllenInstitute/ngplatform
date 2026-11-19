"""SAM-Med3D-turbo (MedIM's model, Apache-2.0) as two ONNX graphs for the browser, each checked against PyTorch:

  encoder.onnx  image (1,1,128,128,128) (z-normalised) -> embedding (1,384,8,8,8)
  decoder.onnx  embedding, points (1,N,3) (voxels of the 128 cube, its axes in order), labels (1,N) int32
                (1 wanted, 0 not), prev_mask (1,1,32,32,32) (the last low-res logits; zeros at first)
                -> mask (1,1,32,32,32) logits, iou (1,1)

The prompt encoder's points are written again without boolean-index assignment (same arithmetic). constants.json:
the crop size and the training spacing.
"""
import json
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from sam_med3d_model import build_sam3D_vit_b_ori  # noqa: E402

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else HERE / "onnx")
OUT.mkdir(parents=True, exist_ok=True)
torch.manual_seed(0)
model = build_sam3D_vit_b_ori()
state = torch.load(HERE / "turbo.pth", map_location="cpu", weights_only=True)["model_state_dict"]
missing, unexpected = model.load_state_dict(state, strict=True), None
model.eval()


class Encoder(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, image):
        return self.m.image_encoder(image)


class Decoder(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, embedding, points, labels, prev_mask):
        pe = self.m.prompt_encoder
        pts = torch.cat([points + 0.5, torch.zeros_like(points[:, :1])], dim=1)
        lab = torch.cat([labels.float(), -torch.ones_like(labels[:, :1]).float()], dim=1).unsqueeze(-1)
        emb = pe.pe_layer.forward_with_coords(pts, pe.input_image_size)
        emb = torch.where(lab == -1, pe.not_a_point_embed.weight.reshape(1, 1, -1), emb)
        for k in range(2):
            emb = emb + (lab == k).float() * pe.point_embeddings[k].weight.reshape(1, 1, -1)
        dense = pe._embed_masks(prev_mask)
        masks, iou = self.m.mask_decoder(image_embeddings=embedding, image_pe=pe.get_dense_pe(), sparse_prompt_embeddings=emb,
                                         dense_prompt_embeddings=dense, multimask_output=False)
        return masks, iou


def close(a, b, what, tol=2e-4):
    a, b = np.asarray(a, np.float64), np.asarray(b, np.float64)
    err = float(np.max(np.abs(a - b)) / max(1.0, float(np.max(np.abs(b)))))
    print(f"  {what}: max rel diff {err:.2e}")
    assert err < tol, what


with torch.no_grad():
    import time
    img = torch.randn(1, 1, 128, 128, 128)
    enc, dec = Encoder(model), Decoder(model)
    t0 = time.time()
    emb = enc(img)
    print(f"encoder (PyTorch, CPU): {time.time() - t0:.1f} s, {tuple(emb.shape)}")
    pts = torch.tensor([[[64.0, 60.0, 70.0], [40.0, 80.0, 64.0]]])
    lab = torch.tensor([[1, 0]], dtype=torch.int32)
    prev = torch.zeros(1, 1, 32, 32, 32)
    masks, iou = dec(emb, pts, lab, prev)
    # Against the model's own prompt encoder and decoder, as SAM-Med3D's inference calls them.
    sparse, dense = model.prompt_encoder(points=[pts, lab.long()], boxes=None, masks=prev)
    ref, ref_iou = model.mask_decoder(image_embeddings=emb, image_pe=model.prompt_encoder.get_dense_pe(), sparse_prompt_embeddings=sparse, dense_prompt_embeddings=dense)
    close(masks, ref, "decoder (rewritten prompt embedding) vs the model's")
    print("mask", tuple(masks.shape), "iou", tuple(iou.shape))

    import onnxruntime as ort
    torch.onnx.export(enc, (img,), str(OUT / "encoder.onnx"), input_names=["image"], output_names=["embedding"], opset_version=17, do_constant_folding=True)
    s = ort.InferenceSession(str(OUT / "encoder.onnx"))
    t0 = time.time()
    got = s.run(None, {"image": img.numpy()})[0]
    print(f"encoder.onnx: {(OUT / 'encoder.onnx').stat().st_size / 1e6:.1f} MB, onnxruntime CPU {time.time() - t0:.1f} s")
    close(got, emb, "ONNX encoder", 1e-3)
    torch.onnx.export(dec, (emb, pts, lab, prev), str(OUT / "decoder.onnx"), input_names=["embedding", "points", "labels", "prev_mask"],
                      output_names=["mask", "iou"], dynamic_axes={"points": {1: "N"}, "labels": {1: "N"}}, opset_version=17, do_constant_folding=True)
    s = ort.InferenceSession(str(OUT / "decoder.onnx"))
    print(f"decoder.onnx: {(OUT / 'decoder.onnx').stat().st_size / 1e6:.1f} MB")
    for p, l, pm in [(pts, lab, prev), (pts[:, :1], lab[:, :1], prev), (torch.rand(1, 5, 3) * 128, torch.tensor([[1, 1, 0, 1, 0]], dtype=torch.int32), masks)]:
        want = dec(emb, p, l, pm)
        got = s.run(None, {"embedding": emb.numpy(), "points": p.numpy(), "labels": l.numpy(), "prev_mask": pm.numpy()})
        close(got[0], want[0], f"ONNX decoder mask, {p.shape[1]} points", 1e-3)
        close(got[1], want[1], f"ONNX decoder iou, {p.shape[1]} points", 1e-3)
    (OUT / "constants.json").write_text(json.dumps({"crop": 128, "spacing_mm": 1.5, "low": 32, "model": "SAM-Med3D-turbo"}))
    print("constants.json written")
