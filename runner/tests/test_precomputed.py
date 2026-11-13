"""Neuroglancer precomputed images read as levels (precomputed.py): unsharded and sharded scales, raw and
gzip, the voxel offset and resolution as the affine, and the shard hash as Neuroglancer computes it."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np

import helpers  # noqa: F401 - puts the runner on the path

from ngplatform_render import precomputed, volumes


def test_the_shard_hash_is_neuroglancers():
    # murmurHash3_x86_128Hash64Bits_Bigint(0, k) in neuroglancer/util/hash.ts.
    assert precomputed.murmurhash3_x86_128_64(0) == 5148371408780832321
    assert precomputed.murmurhash3_x86_128_64(1) == 16770674756601302682
    assert precomputed.murmurhash3_x86_128_64(12345) == 2103515819662501136
    assert precomputed.murmurhash3_x86_128_64(2**63 - 1) == 1274706573695557738


def test_compressed_morton_codes_interleave_only_the_bits_each_axis_needs():
    assert precomputed.compressed_morton((1, 0, 0), (2, 2, 2)) == 1
    assert precomputed.compressed_morton((0, 1, 0), (2, 2, 2)) == 2
    assert precomputed.compressed_morton((0, 0, 1), (2, 2, 2)) == 4
    # x needs 2 bits, y and z none: x alone.
    assert precomputed.compressed_morton((3, 0, 0), (4, 1, 1)) == 3


def _write_unsharded(root: Path, key: str, vol: np.ndarray, chunk: tuple[int, int, int], offset: tuple[int, int, int]):
    """vol: (z, y, x); chunk and offset: x, y, z.  Each chunk gzip'd."""
    (root / key).mkdir(parents=True)
    sz, sy, sx = vol.shape
    for z in range(0, sz, chunk[2]):
        for y in range(0, sy, chunk[1]):
            for x in range(0, sx, chunk[0]):
                a = vol[z:z + chunk[2], y:y + chunk[1], x:x + chunk[0]]
                lo = (x + offset[0], y + offset[1], z + offset[2])
                hi = (lo[0] + a.shape[2], lo[1] + a.shape[1], lo[2] + a.shape[0])
                name = "_".join(f"{a0}-{b0}" for a0, b0 in zip(lo, hi))
                (root / key / name).write_bytes(gzip.compress(np.ascontiguousarray(a).tobytes()))


def _write_sharded(root: Path, key: str, vol: np.ndarray, chunk: tuple[int, int, int], sharding: dict):
    """One shard (shard_bits 0): the shard index, the chunks, then each minishard's index (ids, offsets, sizes, delta-coded)."""
    (root / key).mkdir(parents=True)
    sz, sy, sx = vol.shape
    grid = (-(-sx // chunk[0]), -(-sy // chunk[1]), -(-sz // chunk[2]))
    mbits = sharding["minishard_bits"]
    chunks: dict[int, list[tuple[int, bytes]]] = {}
    for gz in range(grid[2]):
        for gy in range(grid[1]):
            for gx in range(grid[0]):
                a = vol[gz * chunk[2]:(gz + 1) * chunk[2], gy * chunk[1]:(gy + 1) * chunk[1], gx * chunk[0]:(gx + 1) * chunk[0]]
                cid = precomputed.compressed_morton((gx, gy, gz), grid)
                m = (cid >> sharding["preshift_bits"]) & ((1 << mbits) - 1)
                chunks.setdefault(m, []).append((cid, gzip.compress(np.ascontiguousarray(a).tobytes())))
    data, indices, at = b"", {}, 0
    for m, items in sorted(chunks.items()):
        items.sort()
        ids, offs, sizes, prev_end, prev_id = [], [], [], 0, 0
        for cid, b in items:
            ids.append(cid - prev_id)
            offs.append(at - prev_end)
            sizes.append(len(b))
            data += b
            prev_id, prev_end, at = cid, at + len(b), at + len(b)
        indices[m] = gzip.compress(np.array([ids, offs, sizes], "<u8").tobytes())
    shard_index = np.zeros((1 << mbits, 2), "<u8")
    tail = b""
    for m in range(1 << mbits):
        if m in indices:
            shard_index[m] = (len(data) + len(tail), len(data) + len(tail) + len(indices[m]))
            tail += indices[m]
    (root / key / "0.shard").write_bytes(shard_index.tobytes() + data + tail)


def test_scales_read_as_levels_with_their_offset_and_resolution(tmp_path):
    rng = np.random.default_rng(0)
    fine = rng.integers(1, 255, (20, 24, 40), dtype=np.uint8)  # z, y, x
    coarse = fine[::2, ::2, ::2].copy()
    sharding = {"@type": "neuroglancer_uint64_sharded_v1", "hash": "identity", "preshift_bits": 1, "minishard_bits": 1,
                "shard_bits": 0, "minishard_index_encoding": "gzip", "data_encoding": "gzip"}
    info = {
        "type": "image", "data_type": "uint8", "num_channels": 1,
        "scales": [
            {"key": "8_8_40", "size": [40, 24, 20], "resolution": [8, 8, 40], "voxel_offset": [100, 200, 10],
             "chunk_sizes": [[16, 16, 8]], "encoding": "raw"},
            {"key": "16_16_80", "size": [20, 12, 10], "resolution": [16, 16, 80], "voxel_offset": [50, 100, 5],
             "chunk_sizes": [[8, 8, 4]], "encoding": "raw", "sharding": sharding},
        ],
    }
    (tmp_path / "info").write_text(json.dumps(info))
    _write_unsharded(tmp_path, "8_8_40", fine, (16, 16, 8), (100, 200, 10))
    _write_sharded(tmp_path, "16_16_80", coarse, (8, 8, 4), sharding)

    url = f"precomputed://{tmp_path}"
    ms = volumes.open_multiscale(url)
    assert [lv.path for lv in ms.levels] == ["8_8_40", "16_16_80"]
    assert ms.levels[0].shape == (20, 24, 40)
    np.testing.assert_allclose(ms.levels[0].voxel_mm, (8e-6, 8e-6, 40e-6))
    np.testing.assert_allclose(ms.levels[0].affine[:3, 3], (100.5 * 8e-6, 200.5 * 8e-6, 10.5 * 40e-6))
    np.testing.assert_array_equal(volumes.level_array(url, ms, "8_8_40")[0:20, 0:24, 0:40], fine)
    np.testing.assert_array_equal(volumes.level_array(url, ms, "16_16_80")[0:10, 0:12, 0:20], coarse)
    # A part across chunks.
    np.testing.assert_array_equal(volumes.level_array(url, ms, "16_16_80")[3:9, 2:11, 5:17], coarse[3:9, 2:11, 5:17])
