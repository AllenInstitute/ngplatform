"""Neuroglancer precomputed images (precomputed://…): each scale as an array (z, y, x) sliced like a zarr
array.  Chunks are read whole, unsharded (`x0-x1_y0-y1_z0-z1`) or from `neuroglancer_uint64_sharded_v1`
shards (the shard index, then the minishard's, then the chunk, as ranges), raw or JPEG, gzip or not.
One channel; compressed_segmentation is not read here."""

from __future__ import annotations

import gzip
import io
import json
import math
import threading
from pathlib import Path

import numpy as np


def is_precomputed(url: str) -> bool:
    return url.strip().startswith("precomputed://")


def base_url(url: str) -> str:
    """The scale directory's parent as an http(s) URL or a path: precomputed://, a `|…` suffix and the trailing / dropped."""
    from .volumes import http_url

    u = url.strip()
    if u.startswith("precomputed://"):
        u = u[len("precomputed://"):]
    return http_url(u.split("|")[0])


def _get(url: str, start: int | None = None, end: int | None = None) -> bytes | None:
    """An object, or the bytes [start, end) of it; None when it is not there."""
    from .volumes import _http_request

    if url.startswith(("http://", "https://")):
        got = _http_request(url, None if start is None else {"Range": f"bytes={start}-{end - 1}"})
        if got is None:
            return None
        body = got[0]
        # A server that ignores ranges sends it all.
        return body[start:end] if start is not None and got[1] is None and len(body) > end - start else body
    p = Path(url)
    if not p.is_file():
        return None
    with p.open("rb") as f:
        if start is None:
            return f.read()
        f.seek(start)
        return f.read(end - start)


def info(url: str) -> dict:
    b = _get(f"{base_url(url)}/info")
    if b is None:
        raise FileNotFoundError(f"{url}: no info file")
    return json.loads(b)


def _fmix32(h: int) -> int:
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & 0xFFFFFFFF
    return h ^ (h >> 16)


def _rotl(x: int, r: int) -> int:
    return ((x << r) | (x >> (32 - r))) & 0xFFFFFFFF


def murmurhash3_x86_128_64(key: int, seed: int = 0) -> int:
    """The low 64 bits of MurmurHash3_x86_128 of a uint64 (8 bytes, little-endian), as Neuroglancer's shards hash ids."""
    data = key.to_bytes(8, "little")
    c1, c2, c3, c4 = 0x239B961B, 0xAB0E9789, 0x38B34AE5, 0xA1E38B93
    h1 = h2 = h3 = h4 = seed
    # No whole 16-byte block: the 8 bytes are the tail (k1 from bytes 0-3, k2 from bytes 4-7).
    k2 = int.from_bytes(data[4:8], "little")
    k2 = (k2 * c2) & 0xFFFFFFFF
    k2 = _rotl(k2, 16)
    k2 = (k2 * c3) & 0xFFFFFFFF
    h2 ^= k2
    k1 = int.from_bytes(data[0:4], "little")
    k1 = (k1 * c1) & 0xFFFFFFFF
    k1 = _rotl(k1, 15)
    k1 = (k1 * c2) & 0xFFFFFFFF
    h1 ^= k1
    n = 8
    h1 ^= n
    h2 ^= n
    h3 ^= n
    h4 ^= n
    h1 = (h1 + h2 + h3 + h4) & 0xFFFFFFFF
    h2 = (h2 + h1) & 0xFFFFFFFF
    h3 = (h3 + h1) & 0xFFFFFFFF
    h4 = (h4 + h1) & 0xFFFFFFFF
    h1, h2, h3, h4 = _fmix32(h1), _fmix32(h2), _fmix32(h3), _fmix32(h4)
    h1 = (h1 + h2 + h3 + h4) & 0xFFFFFFFF
    h2 = (h2 + h1) & 0xFFFFFFFF
    return h1 | (h2 << 32)


def compressed_morton(pos: tuple[int, int, int], grid: tuple[int, int, int]) -> int:
    """A chunk's id in a sharded scale: its grid position (x, y, z) with the bits interleaved, each axis only
    for as many bits as its grid needs."""
    bits = [max(0, (g - 1).bit_length()) for g in grid]
    code, j = 0, 0
    for i in range(max(bits)):
        for d in range(3):
            if i < bits[d]:
                code |= ((pos[d] >> i) & 1) << j
                j += 1
    return code


class PrecomputedArray:
    """One scale (z, y, x), sliced like a zarr array; missing chunks read as 0."""

    def __init__(self, url: str, scale: dict, data_type: str, channels: int = 1):
        if channels != 1:
            raise ValueError(f"{url}: a precomputed image of {channels} channels (one is read here)")
        self.base = base_url(url)
        self.scale = scale
        self.key = scale["key"]
        self.encoding = scale.get("encoding", "raw")
        if self.encoding not in ("raw", "jpeg"):
            raise ValueError(f"{url}: the {self.encoding} encoding is not read here (raw and jpeg only)")
        sx, sy, sz = (int(v) for v in scale["size"])
        cx, cy, cz = (int(v) for v in scale["chunk_sizes"][0])
        self.offset = tuple(int(v) for v in scale.get("voxel_offset", [0, 0, 0]))  # x, y, z
        self.size_xyz = (sx, sy, sz)
        self.chunk_xyz = (cx, cy, cz)
        self.shape = (sz, sy, sx)
        self.chunks = (cz, cy, cx)
        self.dtype = np.dtype(data_type)
        self.grid = tuple(-(-s // c) for s, c in zip(self.size_xyz, self.chunk_xyz))
        self.sharding = scale.get("sharding")
        self._shard_index: dict[str, bytes | None] = {}
        self._minishards: dict[tuple[str, int], dict[int, tuple[int, int]]] = {}
        self._lock = threading.Lock()

    # ----------------------------------------------------------------- chunks
    def _decode(self, raw: bytes, full_xyz: tuple[int, int, int]) -> np.ndarray:
        fx, fy, fz = full_xyz
        if self.encoding == "jpeg":
            from PIL import Image

            img = np.asarray(Image.open(io.BytesIO(raw)).convert("L"))  # (y * z, x)
            return img.reshape(fz, fy, fx).astype(self.dtype, copy=False)
        a = np.frombuffer(raw, self.dtype, count=fx * fy * fz)
        return a.reshape(fz, fy, fx)  # Fortran order x, y, z read as C order z, y, x

    def _unsharded(self, g: tuple[int, int, int]) -> bytes | None:
        lo = [self.offset[d] + g[d] * self.chunk_xyz[d] for d in range(3)]
        hi = [min(lo[d] + self.chunk_xyz[d], self.offset[d] + self.size_xyz[d]) for d in range(3)]
        name = "_".join(f"{a}-{b}" for a, b in zip(lo, hi))
        raw = _get(f"{self.base}/{self.key}/{name}")
        if raw is not None and raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return raw

    def _sharded(self, g: tuple[int, int, int]) -> bytes | None:
        sh = self.sharding
        cid = compressed_morton(g, self.grid)
        h = cid >> int(sh["preshift_bits"])
        if sh.get("hash", "identity") != "identity":
            h = murmurhash3_x86_128_64(h)
        mbits, sbits = int(sh["minishard_bits"]), int(sh["shard_bits"])
        minishard = h & ((1 << mbits) - 1)
        shard = (h >> mbits) & ((1 << sbits) - 1)
        name = f"{shard:0{max(1, -(-sbits // 4))}x}.shard" if sbits else "0.shard"
        url = f"{self.base}/{self.key}/{name}"
        index_bytes = 16 << mbits
        with self._lock:
            known = name in self._shard_index
        if not known:
            idx = _get(url, 0, index_bytes)
            with self._lock:
                self._shard_index[name] = idx
        idx = self._shard_index[name]
        if idx is None:
            return None
        mk = (name, minishard)
        with self._lock:
            entries = self._minishards.get(mk)
        if entries is None:
            a, b = np.frombuffer(idx, "<u8", count=2, offset=16 * minishard)
            entries = {}
            if b > a:
                m = _get(url, index_bytes + int(a), index_bytes + int(b))
                if m is None:
                    return None
                if sh.get("minishard_index_encoding", "raw") == "gzip":
                    m = gzip.decompress(m)
                t = np.frombuffer(m, "<u8").reshape(3, -1).astype(np.uint64)
                ids = np.cumsum(t[0])
                starts = np.cumsum(t[1]) + np.concatenate([[0], np.cumsum(t[2])[:-1]]).astype(np.uint64)
                for i, s, n in zip(ids.tolist(), starts.tolist(), t[2].tolist()):
                    entries[int(i)] = (int(s), int(n))
            with self._lock:
                self._minishards[mk] = entries
        hit = entries.get(cid)
        if hit is None:
            return None
        s, n = hit
        raw = _get(url, index_bytes + s, index_bytes + s + n)
        if raw is not None and sh.get("data_encoding", "raw") == "gzip":
            raw = gzip.decompress(raw)
        return raw

    def _block(self, bz: int, by: int, bx: int) -> np.ndarray:
        g = (bx, by, bz)
        full = tuple(min(self.chunk_xyz[d], self.size_xyz[d] - g[d] * self.chunk_xyz[d]) for d in range(3))
        raw = self._sharded(g) if self.sharding else self._unsharded(g)
        if raw is None:
            return np.zeros(full[::-1], self.dtype)
        return self._decode(raw, full)

    def __getitem__(self, sel):
        from concurrent.futures import ThreadPoolExecutor

        sl = [s if isinstance(s, slice) else slice(s, s + 1) for s in sel]
        lo = [s.start or 0 for s in sl]
        hi = [s.stop if s.stop is not None else n for s, n in zip(sl, self.shape)]
        rng = [range(lo[k] // self.chunks[k], (hi[k] - 1) // self.chunks[k] + 1) for k in range(3)]
        keys = [(z, y, x) for z in rng[0] for y in rng[1] for x in rng[2]]
        out = np.zeros([h - l for l, h in zip(lo, hi)], self.dtype)

        def one(b):
            a = self._block(*b)
            o = [b[k] * self.chunks[k] for k in range(3)]
            s_out = tuple(slice(max(lo[k], o[k]) - lo[k], min(hi[k], o[k] + a.shape[k]) - lo[k]) for k in range(3))
            s_in = tuple(slice(max(lo[k], o[k]) - o[k], min(hi[k], o[k] + a.shape[k]) - o[k]) for k in range(3))
            out[s_out] = a[s_in]

        with ThreadPoolExecutor(max_workers=16) as ex:
            list(ex.map(one, keys))
        return out


def open_precomputed(url: str):
    """The image's scales as a Multiscale (finest first), each level's affine from its resolution (nm) and voxel offset."""
    from .volumes import Level, Multiscale

    meta = info(url)
    if meta.get("type") not in ("image", "segmentation"):
        raise ValueError(f"{url}: a precomputed {meta.get('type')}, not an image or segmentation")
    levels = []
    for s in meta["scales"]:
        res = np.asarray(s["resolution"], np.float64) * 1e-6  # nm -> mm
        off = np.asarray(s.get("voxel_offset", [0, 0, 0]), np.float64)
        A = np.eye(4)
        A[:3, :3] = np.diag(res)
        A[:3, 3] = (off + 0.5) * res  # a voxel's centre: voxel i spans [offset + i, offset + i + 1) resolutions, as Neuroglancer draws it
        sx, sy, sz = (int(v) for v in s["size"])
        levels.append(Level(s["key"], (sz, sy, sx), str(np.dtype(meta["data_type"])), A, tuple(float(v) for v in res)))
    levels.sort(key=lambda lv: math.prod(lv.shape))
    levels.reverse()
    ms = Multiscale(url, ["z", "y", "x"], [2, 1, 0], levels, base_url(url).split("/")[-1], meta.get("type") == "segmentation", False)
    ms.precomputed = meta
    return ms


def level_array(url: str, ms, path: str) -> PrecomputedArray:
    meta = ms.precomputed
    scale = next(s for s in meta["scales"] if s["key"] == path)
    return PrecomputedArray(url, scale, meta["data_type"], int(meta.get("num_channels", 1)))
