"""Makes the Parquet test files with pyarrow: a Xenium-like transcript table
(x_location, y_location, z_location in micrometres, a gene name, a quality
value), compressed with snappy and with zstd.  Run: python generate.py"""
import json
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

rng = np.random.default_rng(11)
n = 1000
table = pa.table({
    "transcript_id": pa.array(np.arange(n, dtype=np.uint64)),
    "feature_name": pa.array([f"GENE{i % 7}" for i in range(n)]),
    "x_location": pa.array(rng.uniform(0, 500, n).astype(np.float32)),
    "y_location": pa.array(rng.uniform(0, 400, n).astype(np.float32)),
    "z_location": pa.array(rng.uniform(5, 15, n).astype(np.float32)),
    "qv": pa.array(rng.uniform(10, 40, n)),
})
for codec in ["snappy", "zstd"]:
    pq.write_table(table, f"transcripts_{codec}.parquet", compression=codec, row_group_size=300)
json.dump({
    "positions": np.stack([table["x_location"].to_numpy(), table["y_location"].to_numpy(), table["z_location"].to_numpy()], axis=1).astype(float).ravel().tolist(),
    "qv": table["qv"].to_numpy().tolist(),
}, open("expected.json", "w"))
