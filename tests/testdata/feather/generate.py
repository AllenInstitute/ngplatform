"""Writes Feather (Arrow IPC v2) point tables with pyarrow, and expected.json:
the same points in three compressions (LZ4, the default; ZSTD; none),
several record batches, a text column before the numbers, nulls, and
integer, boolean and half-float columns.

    python generate.py   (needs pyarrow)
"""
import json
import os

import numpy as np
import pyarrow as pa
import pyarrow.feather as feather

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(11)
n = 25
table = pa.table({
    "cell_type": pa.array([f"t{i % 3}" for i in range(n)]),
    "x_location": pa.array(rng.uniform(0, 100, n)),
    "y_location": pa.array(rng.uniform(0, 50, n).astype(np.float32)),
    "z_location": pa.array(rng.uniform(0, 10, n)),
    "qv": pa.array([None if i % 7 == 3 else float(i) for i in range(n)], pa.float64()),
    "count": pa.array(rng.integers(-5, 1000, n), pa.int64()),
    "small": pa.array(rng.integers(-100, 100, n), pa.int8()),
    "flag": pa.array([i % 2 == 0 for i in range(n)]),
    "half": pa.array(rng.uniform(0, 4, n).astype(np.float16)),
})
for name, compression in [("points_lz4.feather", "lz4"), ("points_zstd.feather", "zstd"), ("points_plain.feather", "uncompressed")]:
    feather.write_feather(table, os.path.join(HERE, name), compression=compression, chunksize=10)
# Enough repetition that every buffer is stored compressed (small ones may be kept as they are).
big = pa.table({"x": pa.array(np.repeat(np.arange(500, dtype=np.float64), 8)), "y": pa.array(np.tile(np.arange(8, dtype=np.float64), 500)), "label": pa.array(np.repeat(np.arange(40, dtype=np.int32), 100))})
for name, compression in [("grid_lz4.feather", "lz4"), ("grid_zstd.feather", "zstd")]:
    feather.write_feather(big, os.path.join(HERE, name), compression=compression, chunksize=1500)

expected = {c: [None if v is None else float(v) for v in table[c].to_pylist()] for c in table.column_names if c != "cell_type"}
with open(os.path.join(HERE, "expected.json"), "w") as f:
    json.dump(expected, f)
print("written")
