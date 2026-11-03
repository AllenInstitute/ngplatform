"""Writes the TIFF stacks tests/tiff.test.ts reads, and expected.json: each
stack's shape, voxel size and the SHA-256 of its voxels in the order the
virtual store serves them (planes z fastest then channels or time points,
then y, then x; little-endian).

    python3 tests/testdata/tiff/generate.py   (needs numpy and tifffile)
"""
import hashlib
import json
from pathlib import Path

import numpy as np
import tifffile

HERE = Path(__file__).parent
rng = np.random.default_rng(7)
expected = {}


def ramp(shape, dtype):
    a = np.arange(np.prod(shape), dtype=np.float64).reshape(shape)
    return ((a * 7) % 251).astype(dtype) if np.dtype(dtype).itemsize == 1 else ((a * 7919) % 30011).astype(dtype)


def note(name, logical, size, dim):
    expected[name] = {
        "dim": list(dim),
        "size": [round(float(s), 6) for s in size],
        "sha256": hashlib.sha256(np.ascontiguousarray(logical).astype(logical.dtype.newbyteorder("<")).tobytes()).hexdigest(),
    }


# Strips, no compression.
a = ramp((4, 13, 17), np.uint16)
tifffile.imwrite(HERE / "strips_u16.tif", a, rowsperstrip=5, photometric="minisblack")
note("strips_u16.tif", a, (1, 1, 1), (17, 13, 4))

# Big-endian, LZW with the horizontal predictor.
tifffile.imwrite(HERE / "lzw_predictor_be.tif", a, byteorder=">", compression="lzw", predictor=True, photometric="minisblack")
note("lzw_predictor_be.tif", a, (1, 1, 1), (17, 13, 4))

# Random bytes: LZW codes reach 12 bits and the table is cleared.
r = rng.integers(0, 256, (2, 96, 80), dtype=np.uint8)
tifffile.imwrite(HERE / "lzw_random_u8.tif", r, compression="lzw", photometric="minisblack")
note("lzw_random_u8.tif", r, (1, 1, 1), (80, 96, 2))

# Tiles (the edges partial), deflate.
t = ramp((3, 40, 50), np.uint8)
tifffile.imwrite(HERE / "tiles_deflate_u8.tif", t, tile=(16, 16), compression="zlib", photometric="minisblack")
note("tiles_deflate_u8.tif", t, (1, 1, 1), (50, 40, 3))

# PackBits, signed.
p = (ramp((2, 9, 11), np.uint8).astype(np.int16) - 128).astype(np.int8)
p[:, 3:6, :] = -5
tifffile.imwrite(HERE / "packbits_i8.tif", p, compression="packbits", photometric="minisblack")
note("packbits_i8.tif", p, (1, 1, 1), (11, 9, 2))

# BigTIFF, float32.
f = (ramp((3, 7, 6), np.uint16).astype(np.float32) / 3).astype(np.float32)
tifffile.imwrite(HERE / "bigtiff_f32.tif", f, bigtiff=True, photometric="minisblack")
note("bigtiff_f32.tif", f, (1, 1, 1), (6, 7, 3))

# An ImageJ hyperstack: 3 slices of 2 channels (pages channel fastest), 0.25 µm pixels, 2 µm slices.
h = ramp((3, 2, 10, 12), np.uint16)  # z, c, y, x
tifffile.imwrite(HERE / "imagej_channels.tif", h, imagej=True, resolution=(4.0, 4.0), metadata={"axes": "ZCYX", "spacing": 2.0, "unit": "um"})
note("imagej_channels.tif", h.transpose(1, 0, 2, 3), (0.25, 0.25, 2.0), (12, 10, 3, 1, 2))

# OME-TIFF, z of 4 with 3 time points (pages z fastest), sizes in nanometres.
o = ramp((3, 4, 8, 9), np.uint16)  # t, z, y, x
tifffile.imwrite(HERE / "ome_time.ome.tif", o, metadata={"axes": "TZYX", "PhysicalSizeX": 500, "PhysicalSizeXUnit": "nm", "PhysicalSizeY": 500, "PhysicalSizeYUnit": "nm", "PhysicalSizeZ": 1.5, "PhysicalSizeZUnit": "µm"}, photometric="minisblack")
note("ome_time.ome.tif", o, (0.5, 0.5, 1.5), (9, 8, 4, 3))

# A stack with a thumbnail (a reduced-resolution page) after it.
with tifffile.TiffWriter(HERE / "with_thumbnail.tif") as w:
    s = ramp((2, 12, 14), np.uint8)
    for plane in s:
        w.write(plane, photometric="minisblack", contiguous=False)
    w.write(s[0, ::2, ::2].copy(), subfiletype=1, photometric="minisblack", contiguous=False)
note("with_thumbnail.tif", s, (1, 1, 1), (14, 12, 2))

# RGB, LZW with the predictor (per sample), and tiled RGBA: served packed, R lowest, alpha 255 for RGB.
def packed(rgb):
    alpha = np.full(rgb.shape[:-1] + (1,), 255, np.uint8) if rgb.shape[-1] == 3 else np.zeros((), np.uint8)
    rgba = np.concatenate([rgb, alpha], axis=-1) if rgb.shape[-1] == 3 else rgb
    return rgba.view("<u4")[..., 0]


c = ramp((2, 9, 13, 3), np.uint8)
tifffile.imwrite(HERE / "rgb_lzw.tif", c, photometric="rgb", compression="lzw", predictor=True)
note("rgb_lzw.tif", packed(c), (1, 1, 1), (13, 9, 2))
t4 = ramp((1, 40, 36, 4), np.uint8)
tifffile.imwrite(HERE / "rgba_tiles.tif", t4, photometric="rgb", extrasamples=["unassalpha"], tile=(16, 16))
note("rgba_tiles.tif", packed(t4), (1, 1, 1), (36, 40, 1))

# The floating-point predictor: float32 tiles, deflate; float64 strips, big-endian, LZW.
fp = (ramp((2, 21, 19), np.uint16).astype(np.float32) / 7 - 300).astype(np.float32)
tifffile.imwrite(HERE / "float_predictor_f32.tif", fp, tile=(16, 16), compression="zlib", predictor=3, photometric="minisblack")
note("float_predictor_f32.tif", fp, (1, 1, 1), (19, 21, 2))
fd = (ramp((3, 11, 13), np.uint16).astype(np.float64) * 1e-3 - 4.5)
tifffile.imwrite(HERE / "float_predictor_f64_be.tif", fd, byteorder=">", compression="lzw", predictor=3, rowsperstrip=4, photometric="minisblack")
note("float_predictor_f64_be.tif", fd, (1, 1, 1), (13, 11, 3))

# 16-bit RGB (LZW, the horizontal predictor) and RGBA: served by each sample's top 8 bits.
c16 = ramp((2, 9, 11, 3), np.uint16) * 2
tifffile.imwrite(HERE / "rgb16_lzw.tif", c16, photometric="rgb", compression="lzw", predictor=True)
note("rgb16_lzw.tif", packed((c16 >> 8).astype(np.uint8)), (1, 1, 1), (11, 9, 2))
r16 = ramp((1, 10, 12, 4), np.uint16) * 2
tifffile.imwrite(HERE / "rgba16.tif", r16, photometric="rgb", extrasamples=["unassalpha"])
note("rgba16.tif", packed((r16 >> 8).astype(np.uint8)), (1, 1, 1), (12, 10, 1))

(HERE / "expected.json").write_text(json.dumps(expected, indent=1) + "\n")
print("\n".join(f"{k}: {(HERE / k).stat().st_size} bytes" for k in expected))
