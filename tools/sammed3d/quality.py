"""SAM-Med3D as the app runs it (plugins/segmentation/sammed3d*.ts), against a volume's ground truth, organ by organ:

- a 128 cube at 1.5 mm in the world's axes, sampled nearest from the scan, z-normalised over the values above 0;
- the ONNX graphs (fp16 weights by default); the 32 cube's logits trilinear to 128, above 0;
- back on the scan's voxels, each by the cube voxel nearest it; Dice against the truth over the whole scan.

Prompts, as a user would give them:

  click  one click at the organ's innermost voxel; the cube centred there.
  box    a 2-D box round the organ on the slice (of the scan's third axis) through the middle of its extent, with a
         click at the organ's innermost voxel on that slice; the cube centred on the box's middle on that slice.
  box30  the same on the slice at 30 % of its extent: a box off the organ's middle in depth.

  python quality.py IMAGE.nii.gz LABELS.nii.gz [ONNX_DIR=onnx16]
"""
import sys

import nibabel as nib
import numpy as np
import onnxruntime as ort
from scipy import ndimage

img = nib.load(sys.argv[1])
gt = np.asarray(nib.load(sys.argv[2]).dataobj).astype(np.int32)
graphs = sys.argv[3] if len(sys.argv) > 3 else "onnx16"
vol = np.asarray(img.dataobj, np.float32)
A = img.affine
Ainv = np.linalg.inv(A)
zooms = np.array(img.header.get_zooms()[:3])
enc = ort.InferenceSession(f"{graphs}/encoder.onnx")
dec = ort.InferenceSession(f"{graphs}/decoder.onnx")
S, SP = 128, 1.5
WORLD = (A[:3, :3] @ np.indices(vol.shape).reshape(3, -1)).T + A[:3, 3]
names = {1: "spleen", 2: "right kidney", 3: "left kidney", 4: "gallbladder", 5: "oesophagus", 6: "liver", 7: "stomach", 8: "aorta",
         9: "IVC", 10: "pancreas", 11: "right adrenal", 12: "left adrenal", 13: "duodenum", 14: "bladder", 15: "prostate/uterus"}


def upsample(low):
    p = np.maximum(0, (np.arange(S) + 0.5) * 32 / S - 0.5)
    i0 = np.minimum(31, np.floor(p).astype(int))
    i1 = np.minimum(31, i0 + 1)
    f = p - i0
    x = low[i0] * (1 - f)[:, None, None] + low[i1] * f[:, None, None]
    x = x[:, i0] * (1 - f)[None, :, None] + x[:, i1] * f[None, :, None]
    return x[:, :, i0] * (1 - f)[None, None, :] + x[:, :, i1] * f[None, None, :]


def segment(centre, click):
    """The cube round `centre` (world mm), one positive click at `click` (world mm): the scan's voxels selected."""
    origin = centre - (S - 1) / 2 * SP
    idx = np.indices((S, S, S)).reshape(3, -1).T
    vox = np.rint((Ainv[:3, :3] @ (origin + idx * SP).T).T + Ainv[:3, 3]).astype(int)
    ok = np.all((vox >= 0) & (vox < vol.shape), 1)
    vals = np.zeros(len(vox), np.float32)
    vals[ok] = vol[tuple(vox[ok].T)]
    pos = vals[vals > 0]
    m, s = (pos.mean(), pos.std(ddof=1)) if len(pos) > 1 else (0.0, 1.0)
    emb = enc.run(None, {"image": ((vals - m) / (s or 1)).reshape(1, 1, S, S, S).astype(np.float32)})[0]
    point = ((click - origin) / SP).astype(np.float32).reshape(1, 1, 3)
    low = dec.run(None, {"embedding": emb, "points": point, "labels": np.array([[1]], np.int32), "prev_mask": np.zeros((1, 1, 32, 32, 32), np.float32)})[0][0, 0]
    sel = upsample(low) > 0
    g = np.rint((WORLD - origin) / SP).astype(int)
    inside = np.all((g >= 0) & (g < S), 1)
    pred = np.zeros(len(g), bool)
    pred[inside] = sel[tuple(g[inside].T)]
    return pred.reshape(vol.shape)


world = lambda v: (A @ np.r_[v, 1])[:3]
rows = []
print(f"{'':20s} {'click':>6s} {'box':>6s} {'box30':>6s}")
for lab in sorted(int(v) for v in np.unique(gt) if v > 0):
    organ = gt == lab
    dice = lambda p: 2 * (p & organ).sum() / (p.sum() + organ.sum())
    dt = ndimage.distance_transform_edt(organ, sampling=zooms)
    deep = world(np.unravel_index(np.argmax(dt), dt.shape))
    r = [dice(segment(deep, deep))]
    zs = np.unique(np.argwhere(organ)[:, 2])
    for q in (0.5, 0.3):
        z = zs[int(q * (len(zs) - 1))]
        sl = np.argwhere(organ[:, :, z])
        centre = world(np.r_[(sl.min(0) + sl.max(0)) / 2, z])
        d2 = ndimage.distance_transform_edt(organ[:, :, z], sampling=zooms[:2])
        click = world(np.r_[np.unravel_index(np.argmax(d2), d2.shape), z])
        r.append(dice(segment(centre, click)))
    rows.append(r)
    print(f"{lab:2d} {names.get(lab, str(lab)):17s} " + " ".join(f"{d:6.3f}" for d in r), flush=True)
print(f"{'mean':20s} " + " ".join(f"{d:6.3f}" for d in np.mean(rows, 0)))
