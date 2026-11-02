"""Writes the .trx fixtures (stored, deflated, float16 positions) with
trx-python, and expected_trx.json: their streamlines as trx-python reads them.

    pip install trx-python && python generate_trx.py
"""
import json
import os
import zipfile

import nibabel as nib
import numpy as np
from nibabel.streamlines import Tractogram
from trx import trx_file_memmap as tmm

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(3)
lines = [(rng.uniform(-50, 50, 3) + rng.normal(0, 1.5, (int(rng.integers(2, 30)), 3)).cumsum(0)).astype(np.float32) for _ in range(25)]
fa = [rng.uniform(0, 1, (len(s), 1)).astype(np.float32) for s in lines]
weight = rng.uniform(0, 5, (25, 1)).astype(np.float32)
affine = np.diag([1.25, 1.25, 1.25, 1.0])
affine[:3, 3] = [-90, -126, -72]
reference = nib.Nifti1Image(np.zeros((145, 174, 145), np.uint8), affine)
trx = tmm.TrxFile.from_tractogram(Tractogram(lines, data_per_point={"fa": fa}, data_per_streamline={"weight": weight}, affine_to_rasmm=np.eye(4)), reference=reference)
tmm.save(trx, os.path.join(HERE, "tracks.trx"), compression_standard=zipfile.ZIP_STORED)
tmm.save(trx, os.path.join(HERE, "tracks_deflate.trx"), compression_standard=zipfile.ZIP_DEFLATED)
half = trx.deepcopy()
half.streamlines._data = half.streamlines._data.astype(np.float16)
tmm.save(half, os.path.join(HERE, "tracks_f16.trx"), compression_standard=zipfile.ZIP_STORED)

back = tmm.load(os.path.join(HERE, "tracks.trx"))
expected = {
    "streamlines": [s.tolist() for s in back.streamlines],
    "fa": [v.ravel().tolist() for v in back.data_per_vertex["fa"]],
    "weight": back.data_per_streamline["weight"].ravel().tolist(),
}
back16 = tmm.load(os.path.join(HERE, "tracks_f16.trx"))
with open(os.path.join(HERE, "expected_trx.json"), "w") as f:
    json.dump({"tracks.trx": expected, "tracks_deflate.trx": expected, "tracks_f16.trx": {"streamlines": [np.asarray(s, np.float32).tolist() for s in back16.streamlines]}}, f)
