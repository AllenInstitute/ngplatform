"""The ONNX tracker (medsam2_onnx.py) against MedSAM2's own PyTorch video predictor, on a volume, from a box:
each slice's mask (Dice, and pixels that differ) and low-resolution logits, forward and back.

    python compare.py VOLUME.nii.gz [axis] [key] [x0 y0 x1 y1]
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import nibabel as nib
import numpy as np
import torch
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "repo"))
from medsam2_onnx import MedSAM2, resize_bilinear  # noqa: E402
from sam2.build_sam import build_sam2_video_predictor_npz  # noqa: E402

path = sys.argv[1]
axis = int(sys.argv[2]) if len(sys.argv) > 2 else 2
vol = np.moveaxis(np.asarray(nib.load(path).get_fdata(), np.float32), axis, 0)  # (D, H, W)
D, H, W = vol.shape
key = int(sys.argv[3]) if len(sys.argv) > 3 else D // 2
# Windowed to 0..255 (0.5 to 99.5 percentiles), as MedSAM2's inference takes a CT window to uint8.
lo, hi = np.percentile(vol, [0.5, 99.5])
u8 = np.uint8(np.clip((vol - lo) / (hi - lo), 0, 1) * 255)
if len(sys.argv) > 7:
    box = [float(v) for v in sys.argv[4:8]]
else:
    ys, xs = np.nonzero(u8[key] > 20)
    box = [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())]
print(f"volume {D} x {H} x {W}, key slice {key}, box {box}")

# MedSAM2's preprocessing (medsam2_infer_3D_CT.py): grey to RGB, resized to 512 (PIL's default), / 255, ImageNet norm.
imgs = np.stack([np.asarray(Image.fromarray(s).convert("RGB").resize((512, 512))).transpose(2, 0, 1) for s in u8]).astype(np.float32) / 255.0
mean = np.array([0.485, 0.456, 0.406], np.float32)[:, None, None]
std = np.array([0.229, 0.224, 0.225], np.float32)[:, None, None]
imgs = (imgs - mean) / std

# PyTorch, float32 on the CPU.
os.chdir(HERE / "repo")
pred = build_sam2_video_predictor_npz("configs/sam2.1_hiera_t512.yaml", str(HERE / "repo/checkpoints/MedSAM2_latest.pt"), device="cpu")
t0 = time.time()
ref = np.zeros((D, H, W), bool)
ref_logits = {}
with torch.inference_mode():
    state = pred.init_state(torch.from_numpy(imgs), H, W)
    for reverse in (False, True):
        pred.add_new_points_or_box(inference_state=state, frame_idx=key, obj_id=1, box=np.array(box))
        for f, _, logits in pred.propagate_in_video(state, reverse=reverse):
            ref[f] |= (logits[0, 0] > 0).numpy()
        for f, out in state["output_dict"]["cond_frame_outputs"].items():
            ref_logits[(reverse, f)] = out["pred_masks"][0, 0].numpy()
        for f, out in state["output_dict"]["non_cond_frame_outputs"].items():
            ref_logits[(reverse, f)] = out["pred_masks"][0, 0].numpy()
        pred.reset_state(state)
t_ref = time.time() - t0

m = MedSAM2(HERE / (os.environ.get("ONNX_DIR") or "onnx"))
t0 = time.time()
mine = np.zeros((D, H, W), bool)
diffs = []
for reverse in (False, True):
    for f, logits in m.track(imgs, key, box, H, W, reverse).items():
        mine[f] |= resize_bilinear(logits, H, W) > 0
        r = ref_logits[(reverse, f)]
        diffs.append(float(np.max(np.abs(np.clip(logits, -32, 32) - np.clip(r, -32, 32)))))
t_onnx = time.time() - t0

def dice(a, b):
    s = a.sum() + b.sum()
    return 1.0 if s == 0 else 2 * (a & b).sum() / s

per = [dice(mine[f], ref[f]) for f in range(D)]
print(f"PyTorch {t_ref:.1f} s, ONNX {t_onnx:.1f} s (CPU)")
print(f"voxels: PyTorch {int(ref.sum())}, ONNX {int(mine.sum())}, differing {int((ref ^ mine).sum())}")
print(f"Dice over the volume {dice(mine, ref):.5f}; per slice: min {min(per):.4f}, slices below 0.99: {sum(p < 0.99 for p in per)}")
print(f"low-res logits, largest difference on a slice: median {np.median(diffs):.2e}, max {max(diffs):.2e}")
np.save(HERE / "last_mine.npy", mine)
np.save(HERE / "last_ref.npy", ref)
