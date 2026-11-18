"""Inputs and outputs of each ONNX graph on a real slice, for web/check.mjs to compare the browser's with:
web/ref/<name>.bin (raw, little-endian) and web/ref/manifest.json (shapes, dtypes).

    python save_refs.py VOLUME.nii.gz [axis] [key] [x0 y0 x1 y1]
"""
import json
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import onnxruntime as ort
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / "web" / "ref"
OUT.mkdir(parents=True, exist_ok=True)
axis = int(sys.argv[2]) if len(sys.argv) > 2 else 2
vol = np.moveaxis(np.asarray(nib.load(sys.argv[1]).get_fdata(), np.float32), axis, 0)
D, H, W = vol.shape
key = int(sys.argv[3]) if len(sys.argv) > 3 else D // 2
box = [float(v) for v in sys.argv[4:8]] if len(sys.argv) > 7 else [W * 0.3, H * 0.3, W * 0.7, H * 0.7]
lo, hi = np.percentile(vol, [0.5, 99.5])
u8 = np.uint8(np.clip((vol - lo) / (hi - lo), 0, 1) * 255)


def prep(s):
    a = np.asarray(Image.fromarray(s).convert("RGB").resize((512, 512))).transpose(2, 0, 1).astype(np.float32) / 255
    return ((a - np.array([0.485, 0.456, 0.406], np.float32)[:, None, None]) / np.array([0.229, 0.224, 0.225], np.float32)[:, None, None])[None]


S = {n: ort.InferenceSession(str(HERE / "onnx" / f"{n}.onnx")) for n in ["encoder", "heads", "memory_encoder", "memory_attention"]}
manifest = {}


def save(name, arr):
    arr = np.ascontiguousarray(arr)
    dt = {np.dtype(np.int32): "int32", np.dtype(np.int64): "int64"}.get(arr.dtype, "float32")
    arr = arr.astype(dt)
    arr.tofile(OUT / f"{name}.bin")
    manifest[name] = {"shape": list(arr.shape), "dtype": dt}


img = prep(u8[key])
save("image", img)
h0, h1, v, vp = S["encoder"].run(None, {"image": img})
for n, a in zip(["high0", "high1", "vision", "vision_pos"], [h0, h1, v, vp]):
    save(n, a)
c = json.loads((HERE / "onnx" / "constants.json").read_text())
pix = (v + np.array(c["no_mem_embed"], np.float32).reshape(1, -1, 1, 1)).astype(np.float32)
coords = (np.array([[box[:2], box[2:]]], np.float32) / np.array([W, H], np.float32) * 512).astype(np.float32)
labels = np.array([[2, 3]], np.int32)
for n, a in [("pix", pix), ("point_coords", coords), ("point_labels", labels)]:
    save(n, a)
m, i, p, sc = S["heads"].run(None, {"pix": pix, "high0": h0, "high1": h1, "point_coords": coords, "point_labels": labels})
for n, a in zip(["masks", "ious", "obj_ptrs", "object_score"], [m, i, p, sc]):
    save(n, a)
mask = m[:, 0:1]
save("mask", mask)
mm, mp = S["memory_encoder"].run(None, {"vision": v, "mask": mask, "object_score": sc, "binarize": np.array([1.0], np.float32)})
save("maskmem", mm)
save("maskmem_pos", mp)
_, _, vb, vpb = S["encoder"].run(None, {"image": prep(u8[min(key + 1, D - 1)])})
feeds = {"vision": vb, "vision_pos": vpb, "mem_feats": np.concatenate([mm, mm]), "mem_pos": np.concatenate([mp, mp]),
         "mem_tpos": np.array([6, 5], np.int64), "obj_ptrs": np.stack([p[0, 0], p[0, 1]]).astype(np.float32),
         "obj_tpos": np.array([1, 1], np.float32), "t_diff_max": np.array(15, np.float32)}
for k, a in feeds.items():
    save("ma_" + k, a)
save("pix2", S["memory_attention"].run(None, feeds)[0])
(OUT / "manifest.json").write_text(json.dumps(manifest))
print(len(manifest), "arrays in", OUT)
