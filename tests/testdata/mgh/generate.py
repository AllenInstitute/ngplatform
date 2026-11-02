"""Makes the MGH test files: small volumes with an oblique placement, as
FreeSurfer's own reader (via nibabel) writes and reads them.
Run with a Python that has nibabel: python generate.py"""
import json
import numpy as np
import nibabel as nib

rng = np.random.default_rng(7)
theta = np.deg2rad(20)
rot = np.array([[np.cos(theta), -np.sin(theta), 0], [np.sin(theta), np.cos(theta), 0], [0, 0, 1]])
affine = np.eye(4)
affine[:3, :3] = rot @ np.diag([1.5, 2.0, 2.5]) @ np.array([[-1, 0, 0], [0, 0, 1], [0, -1, 0]])
affine[:3, 3] = [12.0, -30.0, 8.0]

expected = {}
short = rng.integers(-300, 3000, size=(7, 6, 5)).astype(np.int16)
nib.save(nib.MGHImage(short, affine), "short.mgz")
floats = rng.normal(size=(4, 3, 2, 3)).astype(np.float32)  # three frames
nib.save(nib.MGHImage(floats, affine), "frames.mgh")
for name, data in [("short.mgz", short), ("frames.mgh", floats)]:
    img = nib.load(name)
    expected[name] = {
        "shape": [int(s) for s in img.shape],
        "affine": np.asarray(img.affine).round(6).tolist(),
        # Fortran order: i fastest, as the store's voxels are.
        "voxels": np.asarray(img.dataobj, dtype=np.float64).ravel(order="F").round(6).tolist(),
    }
with open("expected.json", "w") as f:
    json.dump(expected, f)
