"""Makes the .npy test files.  Each array is indexed [z, y, x] (C order) or
stored Fortran-ordered, so the reader's x-fastest view can be checked:
expected.json gives, per file, the shape as x, y, z(, t) and the values
with x varying fastest.  Run: python generate.py"""
import json
import numpy as np

rng = np.random.default_rng(3)
arrays = {
    "zyx_int16.npy": rng.integers(-500, 500, size=(5, 6, 7)).astype("<i2"),
    "fortran_float32.npy": np.asfortranarray(rng.normal(size=(7, 6, 5)).astype("<f4")),
    "big_uint16.npy": rng.integers(0, 60000, size=(3, 4, 5)).astype(">u2"),
    "tzyx_uint8.npy": rng.integers(0, 255, size=(2, 3, 4, 5)).astype("u1"),
}
expected = {}
for name, a in arrays.items():
    np.save(name, a)
    # x fastest: for C order the last axis is x, so transpose to [x, y, z(, t)] and ravel Fortran-wise.
    xyz = a if np.isfortran(a) else a.transpose(tuple(reversed(range(a.ndim))))
    expected[name] = {"shape": [int(s) for s in xyz.shape], "values": xyz.ravel(order="F").astype(np.float64).round(5).tolist()}
json.dump(expected, open("expected.json", "w"))
