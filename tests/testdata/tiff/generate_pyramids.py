"""Writes the small pyramidal TIFFs tests/tiff_levels.test.ts reads, and
pyramid_expected.json: values of every level as tifffile reads them.

    python3 tests/testdata/tiff/generate_pyramids.py   (needs numpy and tifffile)

pyramid_subifds.ome.tif: OME-TIFF, 3 planes of 160 x 144 uint16, each page with
  two SubIFDs (80 x 72, 40 x 36), deflate-compressed, tiled 16 x 16.
pyramid_pages.tif: 2 planes of 80 x 40 uint8, each page followed by one
  reduced-resolution page (NewSubfileType 1) of 40 x 20, strips.
thumbnail.tif: 2 planes of 64 x 64 uint8 and one 16 x 16 thumbnail after the
  first page only (not a level).
"""
import json
from pathlib import Path

import numpy as np
import tifffile

out = Path(__file__).parent
expected = {}

# OME-TIFF with SubIFDs.
z, y, x = np.mgrid[0:3, 0:144, 0:160]
full = (x * 7 + y * 13 + z * 1000 + (x * y) % 5).astype(np.uint16)
levels = [full]
for _ in range(2):
    a = levels[-1]
    levels.append(a.reshape(a.shape[0], a.shape[1] // 2, 2, a.shape[2] // 2, 2).mean(axis=(2, 4)).astype(np.uint16))
with tifffile.TiffWriter(f"{out}/pyramid_subifds.ome.tif", ome=True) as tif:
    meta = {"axes": "ZYX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 0.5, "PhysicalSizeZ": 2.0}
    tif.write(levels[0], subifds=2, metadata=meta, tile=(16, 16), compression="zlib")
    for lvl in levels[1:]:
        tif.write(lvl, subfiletype=1, tile=(16, 16), compression="zlib")
with tifffile.TiffFile(f"{out}/pyramid_subifds.ome.tif") as t:
    s = t.series[0]
    read = [lvl.asarray() for lvl in s.levels]
    expected["subifds"] = {
        "shapes": [list(r.shape) for r in read],
        "samples": [[[int(zz), int(yy), int(xx), int(r[zz, yy, xx])] for zz, yy, xx in [(0, 0, 0), (2, r.shape[1] - 1, r.shape[2] - 1), (1, r.shape[1] // 2, r.shape[2] // 3)]] for r in read],
    }

# Reduced pages in the main chain, after each full page.
z, y, x = np.mgrid[0:2, 0:40, 0:80]
full8 = ((x * 3 + y * 5 + z * 50) % 256).astype(np.uint8)
half8 = full8.reshape(2, 20, 2, 40, 2).mean(axis=(2, 4)).astype(np.uint8)
with tifffile.TiffWriter(f"{out}/pyramid_pages.tif") as tif:
    for p in range(2):
        tif.write(full8[p], contiguous=False, rowsperstrip=8)
        tif.write(half8[p], subfiletype=1, contiguous=False, rowsperstrip=8)
expected["pages"] = {"shapes": [list(full8.shape), list(half8.shape)], "half": [[p, yy, xx, int(half8[p, yy, xx])] for p, yy, xx in [(0, 0, 0), (1, 19, 39), (1, 7, 11)]]}

# A thumbnail after the first page only: no level.
z, y, x = np.mgrid[0:2, 0:64, 0:64]
img = ((x + y + z) % 256).astype(np.uint8)
with tifffile.TiffWriter(f"{out}/thumbnail.tif") as tif:
    tif.write(img[0], contiguous=False)
    tif.write(img[0, ::4, ::4].copy(), subfiletype=1, contiguous=False)
    tif.write(img[1], contiguous=False)

json.dump(expected, open(f"{out}/pyramid_expected.json", "w"), indent=1)
