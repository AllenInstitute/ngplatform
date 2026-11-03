"""Writes TIFFs and their vzip archives zarrified by refkv, and expected.json:
the sha256 of every key's value as refkv's own reader resolves it.

    tiles.tif / .vzip         16 x 16 tiles, deflate (numcodecs.zlib)
    strips.tif / .vzip        8-row strips, uncompressed
    lzw_delta.tif / .vzip     8-row strips, LZW with the horizontal predictor
                              (refkv.tiff_lzw and imagecodecs_delta)

The image is (arange(40 * 50) * 7) % 3001 as uint16, 40 rows by 50 columns.

    python generate.py   (needs Python 3.12 or later with refkv[images]==0.2.0 and tifffile)
"""
import hashlib
import json
import os

import numpy as np
import tifffile
from refkv.zarrify import zarrify

HERE = os.path.dirname(os.path.abspath(__file__))
a = (np.arange(40 * 50, dtype=np.uint16).reshape(40, 50) * 7) % 3001
tifffile.imwrite(f"{HERE}/tiles.tif", a, tile=(16, 16), compression="zlib", photometric="minisblack")
tifffile.imwrite(f"{HERE}/strips.tif", a, rowsperstrip=8, photometric="minisblack")
tifffile.imwrite(f"{HERE}/lzw_delta.tif", a, rowsperstrip=8, compression="lzw", predictor=True, photometric="minisblack")
expected = {}
for name in ["tiles", "strips", "lzw_delta"]:
    store = zarrify(f"{HERE}/{name}.tif")
    store.save(f"{HERE}/{name}.vzip")
    expected[name] = {k: hashlib.sha256(bytes(store.get(k))).hexdigest() for k in sorted(store.list())}
with open(f"{HERE}/expected.json", "w") as f:
    json.dump(expected, f, indent=1)
print("written")
