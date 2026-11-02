"""Writes the .trk and .tck fixtures for the virtual zarr-vectors tests, with
nibabel, and expected.json: each file's streamlines in RAS+ mm as nibabel
reads them.

    python generate.py
"""
import json
import os

import nibabel as nib
import numpy as np
from nibabel.streamlines import Field, TckFile, Tractogram, TrkFile

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(7)


def streamlines(n, lo, hi):
    out = []
    for _ in range(n):
        k = int(rng.integers(2, 40))
        start = rng.uniform(lo, hi, 3)
        steps = rng.normal(0, 1.5, (k, 3)).cumsum(axis=0)
        out.append((start + steps).astype(np.float32))
    return out


def write(name, affine, voxel_order, dims, voxel_sizes, n, scalars=False, properties=False):
    lines = streamlines(n, [-60, -80, -40], [60, 60, 70])
    data_per_point = {"fa": [rng.uniform(0, 1, (len(s), 1)).astype(np.float32) for s in lines]} if scalars else {}
    data_per_streamline = {"weight": rng.uniform(0, 5, (n, 1)).astype(np.float32)} if properties else {}
    tractogram = Tractogram(lines, data_per_point=data_per_point, data_per_streamline=data_per_streamline, affine_to_rasmm=np.eye(4))
    header = {
        Field.VOXEL_TO_RASMM: affine,
        Field.VOXEL_ORDER: voxel_order,
        Field.DIMENSIONS: np.array(dims, dtype=np.int16),
        Field.VOXEL_SIZES: np.array(voxel_sizes, dtype=np.float32),
    }
    path = os.path.join(HERE, name)
    TrkFile(tractogram, header=header).save(path)
    back = nib.streamlines.load(path)
    return {
        "streamlines": [s.tolist() for s in back.streamlines],
        "fa": [v.ravel().tolist() for v in back.tractogram.data_per_point["fa"]] if scalars else None,
        "weight": back.tractogram.data_per_streamline["weight"].ravel().tolist() if properties else None,
    }


ras = np.diag([1.25, 1.25, 1.25, 1.0])
ras[:3, 3] = [-90, -126, -72]
las = np.diag([-2.0, 2.0, 2.5, 1.0])
las[:3, 3] = [90, -126, -72]
oblique = np.array([[0.0, -1.5, 0.2, 40], [1.4, 0.0, 0.1, -60], [0.1, 0.3, 2.0, -30], [0, 0, 0, 1]])

expected = {
    "ras.trk": write("ras.trk", ras, "RAS", [145, 174, 145], [1.25, 1.25, 1.25], 60),
    "las.trk": write("las.trk", las, "LAS", [91, 109, 91], [2, 2, 2.5], 40, scalars=True, properties=True),
    # The header's voxel order disagrees with the affine's: nibabel reorders.
    "lps_header_ras_affine.trk": write("lps_header_ras_affine.trk", ras, "LPS", [145, 174, 145], [1.25, 1.25, 1.25], 30),
    "oblique.trk": write("oblique.trk", oblique, "PRS", [100, 120, 80], [1.5, 1.4, 2.0], 30),
}
# The same kind of streamlines as an MRtrix .tck (scanner RAS+ mm, no header geometry).
tck_lines = streamlines(50, [-60, -80, -40], [60, 60, 70])
TckFile(Tractogram(tck_lines, affine_to_rasmm=np.eye(4))).save(os.path.join(HERE, "tracks.tck"))
back = nib.streamlines.load(os.path.join(HERE, "tracks.tck"))
expected["tracks.tck"] = {"streamlines": [s.tolist() for s in back.streamlines], "fa": None, "weight": None}

with open(os.path.join(HERE, "expected.json"), "w") as f:
    json.dump(expected, f)
print({k: len(v["streamlines"]) for k, v in expected.items()})
