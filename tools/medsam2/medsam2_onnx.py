"""MedSAM2's tracking through a volume, on the four ONNX graphs (export_onnx.py): the bookkeeping of SAM 2's video
predictor (sam2_video_predictor_npz.py, sam2_base.py), written out so it can be carried to TypeScript as it is.

A box on one slice (the conditioning frame) is segmented there, then tracked slice by slice, forward and back
(two runs, each from the box alone, as MedSAM2's 3-D inference does). For each tracked slice:
  memory bank = the conditioning slice (temporal slot 0) and the up to 6 slices just before it in the direction of
                travel (slot t_pos = 1 for the farthest .. 6 for the nearest), each its memory features (stored as
                bfloat16, as the predictor keeps them) and the constant memory position encoding;
  pointers    = the conditioning slice's object pointer (if it is behind) and those of the up to 15 slices before,
                each with its signed distance;
  heads       = no prompt: the best of the three multimask outputs by predicted IoU, and its token's pointer;
  memory      = the predicted mask (sigmoid) encoded, for the slices after.
The conditioning slice: features + no_mem_embed, the box's single mask (or, if it is unstable, the best multimask),
token 0's pointer, its memory from the mask binarized.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnxruntime as ort


def bf16(x: np.ndarray) -> np.ndarray:
    """float32 rounded to bfloat16 (round to nearest even), as float32."""
    u = np.ascontiguousarray(x, np.float32).view(np.uint32)
    u = (u + (0x7FFF + ((u >> 16) & 1))) & 0xFFFF0000
    return u.astype(np.uint32).view(np.float32)


def resize_bilinear(x: np.ndarray, h: int, w: int) -> np.ndarray:
    """(H0, W0) -> (h, w), bilinear, align_corners=False (PyTorch's F.interpolate)."""
    h0, w0 = x.shape
    ys = np.clip((np.arange(h) + 0.5) * (h0 / h) - 0.5, 0, None)
    xs = np.clip((np.arange(w) + 0.5) * (w0 / w) - 0.5, 0, None)
    y0 = np.minimum(np.floor(ys).astype(int), h0 - 1)
    x0 = np.minimum(np.floor(xs).astype(int), w0 - 1)
    y1, x1 = np.minimum(y0 + 1, h0 - 1), np.minimum(x0 + 1, w0 - 1)
    fy, fx = (ys - y0)[:, None], (xs - x0)[None, :]
    a, b = x[y0][:, x0], x[y0][:, x1]
    c, d = x[y1][:, x0], x[y1][:, x1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


class MedSAM2:
    def __init__(self, folder: str | Path, providers=("CPUExecutionProvider",)):
        folder = Path(folder)
        opts = ort.SessionOptions()
        self.encoder = ort.InferenceSession(str(folder / "encoder.onnx"), opts, providers=list(providers))
        self.attention = ort.InferenceSession(str(folder / "memory_attention.onnx"), opts, providers=list(providers))
        self.heads = ort.InferenceSession(str(folder / "heads.onnx"), opts, providers=list(providers))
        self.memenc = ort.InferenceSession(str(folder / "memory_encoder.onnx"), opts, providers=list(providers))
        self.c = json.loads((folder / "constants.json").read_text())
        self.no_mem_embed = np.array(self.c["no_mem_embed"], np.float32).reshape(1, -1, 1, 1)
        self.features: dict[int, dict[str, np.ndarray]] = {}

    def encode(self, images: np.ndarray, f: int) -> dict[str, np.ndarray]:
        """Slice f's features (images: (D, 3, 512, 512), already normalised), kept."""
        if f not in self.features:
            h0, h1, v, vp = self.encoder.run(None, {"image": images[f : f + 1].astype(np.float32)})
            self.features[f] = {"high0": h0, "high1": h1, "vision": v, "vision_pos": vp}
        return self.features[f]

    def _heads(self, pix, feats, coords, labels):
        masks, ious, ptrs, score = self.heads.run(None, {"pix": pix, "high0": feats["high0"], "high1": feats["high1"],
                                                        "point_coords": coords.astype(np.float32), "point_labels": labels.astype(np.int32)})
        return masks[0], ious[0], ptrs[0], float(score.reshape(-1)[0])

    def _stable(self, logits: np.ndarray) -> bool:
        d = self.c["stability_delta"]
        area_i, area_u = float((logits > d).sum()), float((logits > -d).sum())
        return (area_i / area_u if area_u > 0 else 1.0) >= self.c["stability_thresh"]

    def _memory(self, feats, mask_low, score, binarize: bool):
        mm, pos = self.memenc.run(None, {"vision": feats["vision"], "mask": mask_low[None, None].astype(np.float32),
                                         "object_score": np.array([[score]], np.float32), "binarize": np.array([1.0 if binarize else 0.0], np.float32)})
        return bf16(mm[0]), pos[0]

    def track(self, images: np.ndarray, key: int, box, height: int, width: int, reverse: bool):
        """Low-resolution (128 x 128) mask logits of each slice from `key` on, in the direction of travel."""
        num_frames = images.shape[0]
        S = self.c["image_size"]
        no_obj = self.c["no_obj_score"]
        nmem = self.c["num_maskmem"]
        # The conditioning slice.
        feats = self.encode(images, key)
        pix = (feats["vision"] + self.no_mem_embed).astype(np.float32)
        x0, y0, x1, y1 = box
        coords = np.array([[[x0, y0], [x1, y1]]], np.float64) / np.array([width, height]) * S
        masks, ious, ptrs, score = self._heads(pix, feats, coords, np.array([[2, 3]]))
        sel = 0 if self._stable(masks[0]) else 1 + int(np.argmax(ious[1:]))
        mask = masks[sel] if score > 0 else np.full_like(masks[sel], no_obj)
        mem, mem_pos = self._memory(feats, mask, score, binarize=True)
        cond = {"mask": mask, "ptr": ptrs[0], "mem": mem}
        out = {key: mask}
        non_cond: dict[int, dict] = {}
        max_ptrs = min(num_frames, self.c["max_obj_ptrs_in_encoder"])
        step = -1 if reverse else 1
        f = key + step
        while 0 <= f < num_frames:
            feats = self.encode(images, f)
            # Memory bank: the conditioning slice in slot 0, then the slices t_rel = 6 .. 1 before this one.
            mems, slots = [cond["mem"]], [nmem - 0 - 1]
            for t_pos in range(1, nmem):
                prev = non_cond.get(f - step * (nmem - t_pos))
                if prev is not None:
                    mems.append(prev["mem"])
                    slots.append(nmem - t_pos - 1)
            # Pointers: the conditioning slice's when it is behind, then the up to max_ptrs - 1 slices before.
            ptr_list, ptr_t = [], []
            if (key >= f) if reverse else (key <= f):
                ptr_list.append(cond["ptr"])
                ptr_t.append((f - key) * (-1 if reverse else 1))
            for t_diff in range(1, max_ptrs):
                t = f - step * t_diff
                if t < 0 or t >= num_frames:
                    break
                prev = non_cond.get(t)
                if prev is not None:
                    ptr_list.append(prev["ptr"])
                    ptr_t.append(t_diff)
            pix = self.attention.run(None, {
                "vision": feats["vision"], "vision_pos": feats["vision_pos"],
                "mem_feats": np.stack(mems).astype(np.float32), "mem_pos": np.repeat(mem_pos[None], len(mems), 0),
                "mem_tpos": np.array(slots, np.int64), "obj_ptrs": np.stack(ptr_list).astype(np.float32),
                "obj_tpos": np.array(ptr_t, np.float32), "t_diff_max": np.array(max_ptrs - 1, np.float32)})[0]
            masks, ious, ptrs, score = self._heads(pix, feats, np.zeros((1, 1, 2)), np.array([[-1]]))
            best = 1 + int(np.argmax(ious[1:]))
            mask = masks[best] if score > 0 else np.full_like(masks[best], no_obj)
            mem, _ = self._memory(feats, mask, score, binarize=False)
            non_cond[f] = {"mask": mask, "ptr": ptrs[best], "mem": mem}
            out[f] = mask
            f += step
        return out

    def segment(self, images: np.ndarray, key: int, box, height: int, width: int) -> np.ndarray:
        """(D, H, W) bool: forward and back from `key`, each slice's logits taken to the slice's size, > 0."""
        seg = np.zeros((images.shape[0], height, width), bool)
        for reverse in (False, True):
            for f, logits in self.track(images, key, box, height, width, reverse).items():
                seg[f] |= resize_bilinear(logits, height, width) > 0
        return seg
