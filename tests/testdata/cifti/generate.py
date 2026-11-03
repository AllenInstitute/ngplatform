"""Writes a 12-vertex left surface (GIFTI) and CIFTI-2 files on it and a
right hemisphere, as nibabel writes them, and expected.json: each map's
values on the left surface's vertices (null where the file has none, the
medial wall) and its label table.

    sub.L.midthickness.surf.gii   the surface
    sub.thickness.dscalar.nii     two maps (thickness, myelin), float32
    sub.aparc.dlabel.nii          one parcellation with a label table

    python generate.py   (needs nibabel)
"""
import json
import os

import nibabel as nib
import numpy as np
from nibabel import cifti2 as ci
from nibabel.gifti import GiftiDataArray, GiftiImage

HERE = os.path.dirname(os.path.abspath(__file__))
N = 12
rng = np.random.default_rng(3)

coords = rng.normal(size=(N, 3)).astype(np.float32) * 10
faces = np.array([[0, 1, 2], [2, 3, 4], [4, 5, 6], [6, 7, 8], [8, 9, 10], [10, 11, 0]], np.int32)
GiftiImage(darrays=[
    GiftiDataArray(coords, intent="NIFTI_INTENT_POINTSET", datatype="NIFTI_TYPE_FLOAT32"),
    GiftiDataArray(faces, intent="NIFTI_INTENT_TRIANGLE", datatype="NIFTI_TYPE_INT32"),
]).to_filename(os.path.join(HERE, "sub.L.midthickness.surf.gii"))

# Left: all but vertices 3 and 4 (a "medial wall"); right: 8 of its 12, listed out of order.
left = np.array([v for v in range(N) if v not in (3, 4)])
right = np.array([11, 0, 5, 2, 9, 7, 1, 4])
axis = ci.BrainModelAxis.from_surface(left, N, "CortexLeft") + ci.BrainModelAxis.from_surface(right, N, "CortexRight")
columns = len(left) + len(right)

scalars = rng.uniform(1, 4, size=(2, columns)).astype(np.float32)
ci.Cifti2Image(scalars, header=(ci.ScalarAxis(["thickness", "myelin"]), axis)).to_filename(os.path.join(HERE, "sub.thickness.dscalar.nii"))

codes = rng.integers(0, 3, size=(1, columns)).astype(np.float32)
table = {0: ("???", (0, 0, 0, 0)), 1: ("precentral", (0.2, 0.4, 0.8, 1)), 2: ("postcentral", (0.9, 0.1, 0.1, 1))}
ci.Cifti2Image(codes, header=(ci.LabelAxis(["aparc"], [table]), axis)).to_filename(os.path.join(HERE, "sub.aparc.dlabel.nii"))


def on_left(row, fill):
    out = [fill] * N
    for k, v in enumerate(left):
        out[int(v)] = float(row[k])
    return out


expected = {
    "thickness": on_left(scalars[0], None),
    "myelin": on_left(scalars[1], None),
    "aparc": on_left(codes[0], 0.0),
    "aparc_labels": {str(k): [name, list(rgba)] for k, (name, rgba) in table.items()},
}
with open(os.path.join(HERE, "expected.json"), "w") as f:
    json.dump(expected, f, indent=1)
print("written")
