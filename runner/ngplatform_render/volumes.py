"""Volumes for the renderer, read from OME-Zarr (0.4, 0.5 and 0.6; local, http(s), gs:// and s3://).

`open_multiscale(url)` reads the metadata: each stored level's shape and
its affine from voxel index coordinates to physical millimetres.
`load(url, budget)` reads one level into memory, the finest that has at
most `budget` voxels.  When the store has no level near the budget (a
store of one level, say, or levels 4x apart), coarser levels are made
from the finest stored level that is larger, as it is read: by the mean
of each 2x2x2 block for images, by majority vote for labels, 2x at a
time, so they are levels the store could have held.  Levels made this
way are kept in a cache on disk, since they cost a read of the level
under them, and so are stored levels read from a server, which cost a
download; the store itself is never written.  The cache is keyed by the
store, the level's metadata and a stamp of it (its file's time, or the
server's ETag or Last-Modified), so a store written again is read again,
and it is kept within a size (least recently used out first).

An image with channels or time points (OME axes of type "channel" and
"time", or named c and t) is read at one of each: `channel` and `time`,
0 unless asked.

A sharded level on a server is read a whole shard at a time, a large
shard as ranges read at once (one connection carries a fraction of what
several do), then decoded here.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import time as _time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

UNIT_MM = {
    "nanometer": 1e-6, "micrometer": 1e-3, "micron": 1e-3, "millimeter": 1.0, "centimeter": 10.0,
    "meter": 1e3, "nm": 1e-6, "um": 1e-3, "µm": 1e-3, "mm": 1.0, "cm": 10.0, "m": 1e3, "": 1.0,
}


def is_n5(url: str) -> bool:
    """An N5 multiscale (n5://..., as Neuroglancer and the Human Organ Atlas name them, or ….n5)."""
    u = url.strip().rstrip("/")
    return u.startswith("n5://") or u.endswith(".n5")


def http_url(url: str) -> str:
    url = url.strip()
    for p in ("zarr3://", "zarr2://", "zarr://", "n5://", "precomputed://"):
        if url.startswith(p):
            url = url[len(p):]
    url = url.split("|")[0]
    if url.startswith("gs://"):
        url = "https://storage.googleapis.com/" + url[5:]
    elif url.startswith("s3://"):
        b, _, rest = url[5:].partition("/")
        url = f"https://{b}.s3.amazonaws.com/{rest}"
    return url.rstrip("/")


def _store(url: str):
    import zarr.storage

    u = http_url(url)
    if u.startswith(("http://", "https://")):
        return zarr.storage.FsspecStore.from_url(u, read_only=True)
    return zarr.storage.LocalStore(u, read_only=True)


@dataclass
class Level:
    path: str
    shape: tuple[int, ...]  # array shape, all axes
    dtype: str
    affine: np.ndarray  # 4x4: (x, y, z voxel index, 1) -> physical mm (x, y, z)
    voxel_mm: tuple[float, float, float]  # x, y, z


@dataclass
class Multiscale:
    url: str
    axes: list[str]  # array axes' names
    spatial: list[int]  # indices of the x, y, z axes in the array
    levels: list[Level]
    name: str = ""
    labels: bool = False
    n5: bool = False
    types: list[str] = field(default_factory=list)  # array axes' OME types ("space", "channel", "time", or "")
    precomputed: dict | None = None  # a Neuroglancer precomputed image's info (precomputed.py)

    def channel_axis(self) -> int | None:
        return _axis_of(self, "channel", ("c", "channel", "ch"))

    def time_axis(self) -> int | None:
        return _axis_of(self, "time", ("t", "time"))

    def fixed(self, channel: int | None = None, time: int | None = None) -> dict[int, int]:
        """The index each non-spatial axis is read at: `channel` and `time` on theirs (0 when not given), 0 on any
        other. A ValueError that says what the image has when either is out of range or has no axis."""
        shape = self.levels[0].shape
        out = {i: 0 for i in range(len(self.axes)) if i not in self.spatial}
        for what, axis, k in (("channel", self.channel_axis(), channel), ("time point", self.time_axis(), time)):
            if k is None:
                continue
            k = int(k)
            n = shape[axis] if axis is not None else 1
            if axis is None and k != 0:
                raise ValueError(f"{what} {k}: this image has no {what} axis")
            if not 0 <= k < n:
                raise ValueError(f"{what} {k} is out of range: this image has {n} ({what}s 0-{n - 1})")
            if axis is not None:
                out[axis] = k
        return out

    def counts(self) -> dict[str, Any]:
        """The image's axes, and how many channels and time points it has (1 when it has no such axis)."""
        shape = self.levels[0].shape
        c, t = self.channel_axis(), self.time_axis()
        return {"axes": list(self.axes), "channels": int(shape[c]) if c is not None else 1, "times": int(shape[t]) if t is not None else 1}


def _axis_of(ms: "Multiscale", kind: str, names: tuple[str, ...]) -> int | None:
    for i, ty in enumerate(ms.types):
        if i not in ms.spatial and ty == kind:
            return i
    for i, n in enumerate(ms.axes):
        if i not in ms.spatial and n.lower() in names:
            return i
    return None


class Cancelled(Exception):
    """A read stopped because whoever wanted it no longer does (a session closed while it loaded)."""


class N5Array:
    """A level of an N5 multiscale as an array (z, y, x) that can be sliced like a zarr array: blocks
    (x, y, z fastest-last, big-endian, blosc/gzip/raw) read over HTTP or from disk, in parallel."""

    def __init__(self, base: str, path: str):
        self.base, self.path = base.rstrip("/"), path
        a = _n5_json(f"{self.base}/{path}/attributes.json")
        dims, block = a["dimensions"], a["blockSize"]  # x, y, z
        self.shape = (int(dims[2]), int(dims[1]), int(dims[0]))
        self.chunks = (int(block[2]), int(block[1]), int(block[0]))
        self.dtype = np.dtype(a["dataType"])
        comp = a.get("compression") or {"type": "raw"}
        self._codec = None
        if comp.get("type") == "blosc":
            from numcodecs import Blosc

            self._codec = Blosc(cname=comp.get("cname", "lz4"), clevel=int(comp.get("clevel", 5)), shuffle=int(comp.get("shuffle", 1)))
        elif comp.get("type") == "gzip":
            from numcodecs import GZip

            self._codec = GZip(level=int(comp.get("level", 5)))
        elif comp.get("type") not in (None, "raw"):
            raise ValueError(f"N5 compression {comp.get('type')!r} is not read here")

    def _block(self, bz: int, by: int, bx: int) -> np.ndarray:
        cz, cy, cx = self.chunks
        full = (min(cz, self.shape[0] - bz * cz), min(cy, self.shape[1] - by * cy), min(cx, self.shape[2] - bx * cx))
        raw = _n5_bytes(f"{self.base}/{self.path}/{bx}/{by}/{bz}")
        if raw is None:
            return np.zeros(full, self.dtype)
        mode, nd = int.from_bytes(raw[0:2], "big"), int.from_bytes(raw[2:4], "big")
        dims = [int.from_bytes(raw[4 + 4 * i: 8 + 4 * i], "big") for i in range(nd)]  # x, y, z
        off = 4 + 4 * nd + (4 if mode == 1 else 0)
        data = raw[off:]
        if self._codec is not None:
            data = self._codec.decode(data)
        a = np.frombuffer(data, self.dtype.newbyteorder(">"), count=int(np.prod(dims))).astype(self.dtype)
        a = a.reshape(dims[::-1])  # z, y, x
        out = np.zeros(full, self.dtype)
        out[: a.shape[0], : a.shape[1], : a.shape[2]] = a[: full[0], : full[1], : full[2]]
        return out

    def __getitem__(self, sel):
        from concurrent.futures import ThreadPoolExecutor

        sl = [s if isinstance(s, slice) else slice(s, s + 1) for s in sel]
        lo = [s.start or 0 for s in sl]
        hi = [s.stop if s.stop is not None else n for s, n in zip(sl, self.shape)]
        rng = [range(lo[k] // self.chunks[k], (hi[k] - 1) // self.chunks[k] + 1) for k in range(3)]
        keys = [(z, y, x) for z in rng[0] for y in rng[1] for x in rng[2]]
        if len(keys) == 1 and all(lo[k] == keys[0][k] * self.chunks[k] for k in range(3)):
            # One whole block (as detail.read_region asks for them): no copy, no threads.
            a = self._block(*keys[0])
            if tuple(h - l for l, h in zip(lo, hi)) == a.shape:
                return a
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


_connections = threading.local()


def _http_get(url: str) -> bytes | None:
    """GET over a connection kept open per thread and host (a new TLS handshake for every block of a
    region costs more than the block): the body, or None for a 403 or 404."""
    got = _http_request(url)
    return None if got is None else got[0]


#: A whole object larger than this is read as ranges of this size at once: one connection to GCS carries
#: about 20 MB/s, eight about 50, sixteen to thirty-two about 70.
PART_BYTES = 4 << 20
_parts_pool = None


def _http_get_whole(url: str) -> bytes | None:
    """A whole object (None for a 403 or 404), its first PART_BYTES asked for first and, when it is larger,
    the rest as ranges of that size read at once on connections of their own."""
    global _parts_pool
    from concurrent.futures import ThreadPoolExecutor

    got = _http_request(url, {"Range": f"bytes=0-{PART_BYTES - 1}"})
    if got is None:
        return None
    first, total = got
    if total is None or total <= len(first):
        return first  # the whole object (a server that ignores ranges sends it all)
    if _parts_pool is None:
        _parts_pool = ThreadPoolExecutor(max_workers=32, thread_name_prefix="ngp-parts")
    starts = range(len(first), total, PART_BYTES)

    def part(a: int) -> bytes:
        got = _http_request(url, {"Range": f"bytes={a}-{min(total, a + PART_BYTES) - 1}"})
        if got is None or len(got[0]) != min(total, a + PART_BYTES) - a:
            raise OSError(f"{url}: a part of it could not be read")
        return got[0]

    return first + b"".join(_parts_pool.map(part, starts))


def _http_request(url: str, headers: dict[str, str] | None = None) -> tuple[bytes, int | None] | None:
    """A GET (with `headers`): the body and, for a range, the object's whole size; None for a 403 or 404."""
    import http.client
    from urllib.parse import urlsplit

    u = urlsplit(url)
    conns = getattr(_connections, "d", None)
    if conns is None:
        conns = _connections.d = {}
    key = (u.scheme, u.netloc)
    path = u.path + (f"?{u.query}" if u.query else "")
    for attempt in range(3):
        c = conns.get(key)
        if c is None:
            c = (http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection)(u.netloc, timeout=120)
            conns[key] = c
        try:
            c.request("GET", path, headers={"User-Agent": "ngplatform-render", **(headers or {})})
            r = c.getresponse()
            body = r.read()
            span = r.getheader("Content-Range")
        except (http.client.HTTPException, OSError):
            # A connection the server closed while idle: open another.
            c.close()
            conns.pop(key, None)
            if attempt == 2:
                raise
            continue
        if r.status in (403, 404):
            return None
        if r.status >= 400:
            raise OSError(f"HTTP {r.status} for {url}")
        total = int(span.rpartition("/")[2]) if (r.status == 206 and span and not span.endswith("*")) else None
        return body, total
    return None


def _n5_bytes(url: str) -> bytes | None:
    if url.startswith(("http://", "https://")):
        return _http_get(url)
    p = Path(url)
    return p.read_bytes() if p.is_file() else None


def _n5_json(url: str) -> dict:
    b = _n5_bytes(url)
    if b is None:
        raise FileNotFoundError(url)
    return json.loads(b)


def _open_n5(url: str) -> Multiscale:
    """An N5 multiscale (s0, s1, ... with downsamplingFactors and resolution at the top) as levels (z, y, x arrays)."""
    base = http_url(url)
    top = _n5_json(f"{base}/attributes.json")
    res = np.asarray(top.get("resolution") or top.get("pixelResolution", {}).get("dimensions") or [1, 1, 1], np.float64)  # x, y, z
    units = top.get("units") or [top.get("pixelResolution", {}).get("unit", "um")] * 3
    mm = np.array([UNIT_MM.get(u, UNIT_MM.get({"um": "micrometer", "nm": "nanometer", "mm": "millimeter"}.get(u, u), 1.0)) for u in units])
    factors = top.get("downsamplingFactors") or top.get("scales") or [[1, 1, 1]]
    levels = []
    for k, f in enumerate(factors):
        try:
            arr = N5Array(base, f"s{k}")
        except FileNotFoundError:
            break
        f = np.asarray(f, np.float64)
        A = np.eye(4)
        A[:3, :3] = np.diag(res * f * mm)
        A[:3, 3] = (f - 1) / 2 * res * mm  # a coarse voxel's centre: the mean of the fine voxels it holds
        levels.append(Level(f"s{k}", arr.shape, str(arr.dtype), A, tuple(float(x) for x in res * f * mm)))
    levels.sort(key=lambda lv: math.prod(lv.shape))
    levels.reverse()
    return Multiscale(url, ["z", "y", "x"], [2, 1, 0], levels, base.rstrip("/").split("/")[-1], False, True)


def level_array(url: str, ms: Multiscale, path: str):
    """A level's array: zarr's, an N5Array, or a precomputed scale's."""
    import zarr

    if ms.precomputed is not None:
        from .precomputed import level_array as precomputed_level

        return precomputed_level(url, ms, path)
    if ms.n5:
        return N5Array(http_url(url), path)
    return zarr.open_group(store=_store(url), mode="r")[path]


def _mat_scale_translate(transforms: list[dict], ndim: int) -> np.ndarray:
    """The homogeneous matrix (array axis order) of a list of OME transforms."""
    M = np.eye(ndim + 1)
    for t in transforms:
        kind = t.get("type")
        if kind == "sequence":
            M = _mat_scale_translate(t.get("transformations", []), ndim) @ M
        elif kind == "scale":
            S = np.eye(ndim + 1)
            S[:ndim, :ndim] = np.diag(t["scale"])
            M = S @ M
        elif kind == "translation":
            T = np.eye(ndim + 1)
            T[:ndim, ndim] = t["translation"]
            M = T @ M
        elif kind == "affine":
            A = np.asarray(t["affine"], np.float64)
            if A.shape == (ndim, ndim + 1):
                A = np.vstack([A, np.eye(ndim + 1)[-1]])
            M = A @ M
        elif kind == "identity":
            pass
        else:
            raise ValueError(f"unsupported OME-Zarr transformation {kind!r}")
    return M


def open_multiscale(url: str) -> Multiscale:
    import zarr

    from .precomputed import is_precomputed, open_precomputed

    if is_precomputed(url):
        return open_precomputed(url)
    if is_n5(url):
        return _open_n5(url)
    store = _store(url)
    g = zarr.open_group(store=store, mode="r")
    attrs = dict(g.attrs)
    ome = attrs.get("ome", attrs)
    ms = ome["multiscales"][0]
    labels = "image-label" in ome or "labels" in url.lower().split("/")[-1]
    if "axes" in ms:
        axes_meta = ms["axes"]
    else:
        cs = ms.get("coordinateSystems") or []
        axes_meta = cs[0]["axes"] if cs else []
    names = [a["name"] if isinstance(a, dict) else str(a) for a in axes_meta]
    types = [str(a.get("type") or "") if isinstance(a, dict) else "" for a in axes_meta]
    units = [a.get("unit", "") if isinstance(a, dict) else "" for a in axes_meta]
    ndim = len(names)
    spatial = [names.index(k) for k in ("x", "y", "z") if k in names]
    if len(spatial) != 3:
        raise ValueError(f"{url}: needs x, y and z axes (has {names})")
    top = _mat_scale_translate(ms.get("coordinateTransformations", []) or [], ndim)
    levels = []
    for d in ms["datasets"]:
        arr = g[d["path"]]
        M = top @ _mat_scale_translate(d.get("coordinateTransformations", []) or [], ndim)
        # Rows/columns of x, y, z only, then units to mm.
        A = np.eye(4)
        for r, ar in enumerate(spatial):
            for c, ac in enumerate(spatial):
                A[r, c] = M[ar, ac]
            A[r, 3] = M[ar, ndim]
        mm = np.array([UNIT_MM.get(units[i], 1.0) for i in spatial])
        A[:3, :] *= mm[:, None]
        vox = tuple(float(np.linalg.norm(A[:3, c])) for c in range(3))
        levels.append(Level(d["path"], tuple(arr.shape), str(arr.dtype), A, vox))
    levels.sort(key=lambda lv: math.prod(lv.shape))
    levels.reverse()  # finest first
    return Multiscale(url, names, spatial, levels, ms.get("name", ""), labels, types=types)


def _cache_dir() -> Path:
    d = Path(os.environ.get("NGP_RENDER_CACHE") or Path(os.environ.get("NGP_STATE_DIR", "~/.ngplatform-runner")).expanduser() / "render-cache")
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_max_bytes() -> int:
    """How large the cache of made levels may grow ($NGP_RENDER_CACHE_GB, 20 GB by default)."""
    return int(float(os.environ.get("NGP_RENDER_CACHE_GB", "20")) * (1 << 30))


_cache_lock = threading.Lock()


def cache_entries(d: Path | None = None) -> list[tuple[float, int, Path]]:
    """The made levels in the cache: (last used, bytes, file), least recently used first."""
    d = d or _cache_dir()
    out = []
    for p in d.glob("*.npy"):
        if p.name.endswith(".tmp.npy"):
            continue
        try:
            st = p.stat()
        except FileNotFoundError:
            continue
        out.append((st.st_mtime, st.st_size, p))
    out.sort()
    return out


def cache_evict(keep: Path | None = None, max_bytes: int | None = None) -> list[Path]:
    """Deletes the least recently used made levels until the cache is within its size (all but `keep`); those deleted."""
    cap = cache_max_bytes() if max_bytes is None else max_bytes
    gone = []
    with _cache_lock:
        entries = cache_entries()
        total = sum(n for _, n, _ in entries)
        for _, n, p in entries:
            if total <= cap:
                break
            if p == keep:
                continue
            try:
                p.unlink()
            except FileNotFoundError:
                pass
            total -= n
            gone.append(p)
    return gone


def cache_info() -> dict[str, Any]:
    entries = cache_entries()
    return {"folder": str(_cache_dir()), "files": len(entries), "mb": round(sum(n for _, n, _ in entries) / (1 << 20)),
            "max_mb": round(cache_max_bytes() / (1 << 20))}


def _metadata_files(url: str, ms: Multiscale, level: Level) -> list[str]:
    if ms.precomputed is not None:
        from .precomputed import base_url

        return [f"{base_url(url)}/info"]
    base = http_url(url)
    if ms.n5:
        return [f"{base}/{level.path}/attributes.json"]
    return [f"{base}/{level.path}/zarr.json", f"{base}/{level.path}/.zarray"]


def content_stamp(url: str, ms: Multiscale, level: Level) -> str:
    """What says whether a level's array has been written again: its metadata file's bytes with its time and size
    (on this computer, and the array folder's time), or the server's ETag or Last-Modified; the level's shape and
    type when neither can be had."""
    import urllib.request

    parts = [f"{level.shape}|{level.dtype}"]
    for f in _metadata_files(url, ms, level):
        try:
            if f.startswith(("http://", "https://")):
                req = urllib.request.Request(f, method="HEAD", headers={"User-Agent": "ngplatform-render"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    tag = r.headers.get("ETag") or r.headers.get("Last-Modified")
                if tag:
                    parts.append(tag)
                    break
                body = _http_get(f)
                if body is not None:
                    parts.append(hashlib.sha1(body).hexdigest())
                    break
            else:
                p = Path(f.removeprefix("file://"))
                if p.is_file():
                    st, dst = p.stat(), p.parent.stat()
                    parts.append(f"{st.st_mtime_ns}|{st.st_size}|{dst.st_mtime_ns}|{hashlib.sha1(p.read_bytes()).hexdigest()}")
                    break
        except Exception:  # noqa: BLE001 - a store that will not say: its shape and type only
            continue
    return "|".join(parts)


def _reduce2(block: np.ndarray, labels: bool) -> np.ndarray:
    """2x2x2 reduction of a (2a, 2b, 2c) array: mean, or for labels the majority."""
    z, y, x = (s // 2 * 2 for s in block.shape)
    b = block[:z, :y, :x]
    v = b.reshape(z // 2, 2, y // 2, 2, x // 2, 2).transpose(0, 2, 4, 1, 3, 5).reshape(z // 2, y // 2, x // 2, 8)
    if not labels:
        return v.mean(axis=-1, dtype=np.float32)
    counts = (v[..., :, None] == v[..., None, :]).sum(axis=-1)
    pick = counts.argmax(axis=-1)
    return np.take_along_axis(v, pick[..., None], axis=-1)[..., 0]


@dataclass
class Loaded:
    data: np.ndarray  # (nz, ny, nx), as stored (labels) or uint8 / uint16 (images)
    affine: np.ndarray  # 4x4 voxel (x, y, z) -> physical mm
    lo: float
    hi: float
    percentiles: dict[float, float]
    level: str  # stored path, or "<path>/2x" etc. when made here
    voxel_mm: tuple[float, float, float]
    source_shape: tuple[int, int, int]
    seconds: float = 0.0
    made: bool = False  # made by downsampling here (from the cache, or now)
    from_cache: bool = False  # from the disk cache: a made level, or a stored level of a store on a server
    window: tuple[float, float] | None = None  # a guess at the tissue's values (data units), for "window" presets
    quantiles: list[float] | None = None  # the tissue's values at QUANTILES (data units), for matching histograms
    channel: int = 0  # the channel and time point read (0 for an image without those axes)
    time: int = 0
    counts: dict[str, Any] = field(default_factory=dict)  # Multiscale.counts(): its axes, channels and time points
    medium: str = ""  # the specimen lies in a mounting medium, the tissue "above" or "below" it (medium_side); else ""


def _order_zyx(a: np.ndarray, ms: Multiscale) -> np.ndarray:
    """Array of the spatial axes (in array order) transposed to z, y, x."""
    kept = [i for i in range(len(ms.axes)) if i in ms.spatial]
    names = [ms.axes[i] for i in kept]
    return np.transpose(a, [names.index(k) for k in ("z", "y", "x")])


#: A level is read in blocks of at least this many bytes (a whole number of its chunks or shards).
READ_BLOCK_BYTES = 64 << 20


def _remote(url: str) -> bool:
    return http_url(url).startswith(("http://", "https://"))


class _WholeShards:
    """Reads a sharded zarr v3 level over HTTP a whole shard at a time, a large shard as ranges read at once
    (_http_get_whole), its chunks decoded here. zarr's own reader reads a whole shard on one connection, which
    carries about 20 MB/s from GCS (a 100 MB shard of the 20 µm deep-brain store took 5-6 s).
    `read(sel)` reads a box (slices of every axis), fetching the shards it touches."""

    def __init__(self, url: str, path: str, arr):
        from zarr.core.buffer import default_buffer_prototype

        self.base = f"{http_url(url)}/{path}"
        self.arr = arr
        self.meta = arr.metadata.to_buffer_dict(default_buffer_prototype())
        self.shards = tuple(int(s) for s in arr.shards)

    def keys(self, sel: tuple) -> list[str]:
        """The keys of the shards a box touches (slices of every axis, or an index)."""
        import itertools

        rng = []
        for s, n, sh in zip(sel, self.arr.shape, self.shards):
            lo, hi = (s.start or 0, n if s.stop is None else s.stop) if isinstance(s, slice) else (s, s + 1)
            rng.append(range(lo // sh, (hi - 1) // sh + 1))
        return [self.arr.metadata.encode_chunk_key(c) for c in itertools.product(*rng)]

    def read(self, sel: tuple) -> np.ndarray:
        import zarr
        from zarr.core.buffer.cpu import Buffer

        d = dict(self.meta)
        for k in self.keys(sel):
            body = _http_get_whole(f"{self.base}/{k}")
            if body is not None:  # no shard: the fill value, as zarr reads it
                d[k] = Buffer.from_bytes(body)
        return np.asarray(zarr.open_array(store=zarr.storage.MemoryStore(d), mode="r")[sel])


def _read(url: str, level: Level, ms: Multiscale, progress: Callable[[float, str], None] | None,
          factor: int = 1, labels: bool = False, fixed: dict[int, int] | None = None,
          cancelled: Callable[[], bool] | None = None) -> np.ndarray:
    """The level's spatial axes as a (z, y, x) array, read in chunk-aligned blocks; with
    factor > 1, each block reduced 2x at a time as it comes (so memory holds the output and
    one block), which is how levels are made here. Non-spatial axes are read at `fixed`
    (axis: index; 0 for any not given). Stops (Cancelled) between blocks once `cancelled()`."""
    fixed = fixed or {}
    import zarr
    from concurrent.futures import ThreadPoolExecutor

    zarr.config.set({"async.concurrency": 64})
    arr = level_array(url, ms, level.path)
    shard = getattr(arr, "shards", None) or arr.chunks
    # A sharded level on a server: whole shards, one GET each (blocks are whole shards, so each is read once).
    whole = _WholeShards(url, level.path, arr) if (not ms.n5 and ms.precomputed is None and getattr(arr, "shards", None) and _remote(url)) else None
    zi, yi, xi = ms.spatial[2], ms.spatial[1], ms.spatial[0]
    n = (arr.shape[zi], arr.shape[yi], arr.shape[xi])
    # Blocks: the chunk (or shard) shape, grown to at least 64 MB and to a multiple of the factor.
    blk = [max(int(shard[i]), factor) for i in (zi, yi, xi)]
    itemsize = np.dtype(arr.dtype).itemsize
    while math.prod(blk) * itemsize < READ_BLOCK_BYTES and any(b < m for b, m in zip(blk, n)):
        k = int(np.argmin([b / m for b, m in zip(blk, n)]))
        blk[k] = min(blk[k] * 2, max(n[k], blk[k]))
    blk = [-(-b // factor) * factor for b in blk]
    out_shape = tuple(m // factor if factor > 1 else m for m in n)
    out_dtype = np.float32 if (factor > 1 and not labels) else np.dtype(arr.dtype)
    out = np.zeros(out_shape, out_dtype)
    boxes = [(z, y, x) for z in range(0, n[0], blk[0]) for y in range(0, n[1], blk[1]) for x in range(0, n[2], blk[2])]
    done = [0]
    lock = threading.Lock()

    def one(b):
        if cancelled is not None and cancelled():
            raise Cancelled("closed while loading")
        z, y, x = b
        sel: list[Any] = [0] * len(ms.axes)
        for i in range(len(ms.axes)):
            if i not in ms.spatial:
                sel[i] = fixed.get(i, 0)
        stops = (min(n[0], z + blk[0]), min(n[1], y + blk[1]), min(n[2], x + blk[2]))
        sel[zi], sel[yi], sel[xi] = slice(z, stops[0]), slice(y, stops[1]), slice(x, stops[2])
        a = _order_zyx(whole.read(tuple(sel)) if whole is not None else np.asarray(arr[tuple(sel)]), ms)
        f = factor
        while f > 1:
            a = _reduce2(a, labels)
            f //= 2
        oz, oy, ox = z // factor, y // factor, x // factor
        out[oz:oz + a.shape[0], oy:oy + a.shape[1], ox:ox + a.shape[2]] = a
        with lock:
            done[0] += 1
            if progress:
                progress(done[0] / len(boxes), f"read {level.path}" + (f" -> {factor}x" if factor > 1 else "") + f" {done[0]}/{len(boxes)} blocks")

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(one, b) for b in boxes]
        try:
            for f in futures:
                f.result()
        except BaseException:
            for f in futures:
                f.cancel()
            raise
    return out


def _quantize(a: np.ndarray, labels: bool):
    """Images as uint8 / uint16 with the data value at 0 and at the top (lo, hi)."""
    if labels:
        return a, 0.0, 1.0
    if a.dtype == np.uint8:
        return a, 0.0, 255.0
    if a.dtype == np.uint16:
        return a, 0.0, 65535.0
    f = a.astype(np.float32, copy=False)
    finite = f[np.isfinite(f)]
    lo, hi = (float(finite.min()), float(finite.max())) if finite.size else (0.0, 1.0)
    if hi <= lo:
        hi = lo + 1.0
    q = np.clip((np.nan_to_num(f, nan=lo) - lo) / (hi - lo) * 65535.0 + 0.5, 0, 65535).astype(np.uint16)
    return q, lo, hi


PERCENTILES = (0.5, 1, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 98, 99, 99.5, 99.9)


def tissue_percentiles(q: np.ndarray, lo: float, hi: float) -> dict[float, float]:
    """Percentiles (in data units) of the values above the background: the values above the
    lowest 1% of the histogram's range that holds the most voxels at its low end (0 for
    most stores)."""
    if q.dtype == np.uint8:
        h = np.bincount(q.ravel(), minlength=256).astype(np.float64)
        top = 255.0
    else:
        h = np.bincount((q.ravel() >> 4).astype(np.int64), minlength=4096).astype(np.float64)
        top = 4095.0
    # Background: the bins at the bottom up to the first local minimum after the low peak.
    peak = int(np.argmax(h[: max(2, len(h) // 10)]))
    bg = peak
    while bg + 1 < len(h) and h[bg + 1] <= h[bg]:
        bg += 1
    tissue = h.copy()
    tissue[: bg + 1] = 0
    if tissue.sum() == 0:
        tissue = h
    c = np.cumsum(tissue) / tissue.sum()
    out = {}
    for p in PERCENTILES:
        i = int(np.searchsorted(c, p / 100.0))
        out[p] = lo + (hi - lo) * (min(i, len(h) - 1) / top)
    out[0.0] = lo + (hi - lo) * ((bg + 1) / top)
    return out


QUANTILES = tuple(range(1, 100))  # the tissue's percentiles a scan's histogram is matched by


def tissue_quantiles(q: np.ndarray, lo: float, hi: float, window: tuple[float, float]) -> list[float] | None:
    """The tissue's values (data units) at QUANTILES: the voxels inside a ring about the scan's axis (as
    guess_window), on the tissue's side of the window's edge at the medium (above it when the window
    starts there), up to 3 windows past it (not the jar's wall). For matching one scan's histogram to
    another's (presets.histogram)."""
    if q.ndim != 3 or min(q.shape) < 8:
        return None
    s = q[::2, ::2, ::2]
    _, Y, X = s.shape
    yy, xx = np.mgrid[:Y, :X]
    r = np.hypot((yy - (Y - 1) / 2) / (Y / 2), (xx - (X - 1) / 2) / (X / 2))
    top = 255.0 if q.dtype == np.uint8 else 65535.0
    v = lo + (hi - lo) * s[:, r < 0.9].astype(np.float32) / top
    w0, w1 = window
    u = (v - w0) / (w1 - w0)
    above = window_side(q, lo, hi, window) == "above"
    t = v[(u > 0.1) & (u < 3.0)] if above else v[(u < 0.9) & (u > -2.0)]
    if t.size < 1000:
        return None
    return [float(x) for x in np.percentile(t, QUANTILES)]


def window_side(q: np.ndarray, lo: float, hi: float, window: tuple[float, float]) -> str:
    """Which side of the medium the tissue is: "above" when the window starts at the medium's edge (most
    organs), "below" when it ends there (tissue less dense than its medium)."""
    s = q[::4, ::4, ::4]
    top = 255.0 if q.dtype == np.uint8 else 65535.0
    v = lo + (hi - lo) * s.astype(np.float32) / top
    w0, w1 = window
    # The medium is the commonest value: the window's low end sits just above it, or its high end just below.
    h, e = np.histogram(v, bins=512, range=(lo, hi))
    m = 0.5 * (e[np.argmax(h[1:]) + 1] + e[np.argmax(h[1:]) + 2])
    return "above" if abs(m - w0) <= abs(m - w1) else "below"


def _ring_medium(q: np.ndarray) -> tuple[int, int, np.ndarray, float] | None:
    """What guess_window reads, every 2nd voxel: the commonest value bar 0 in a ring about the scan's axis just
    inside its sides (r 0.75..0.9 of its half widths), as a bin `m` (of 16 values for 16-bit data), and its band's
    half-width `w` (bins, to a fifth of its peak); the counts within r 0.9 (bar 0); and the share of the ring in
    the band, every voxel counted (0 too)."""
    if q.ndim != 3 or min(q.shape) < 8:
        return None
    s = q[::2, ::2, ::2]
    _, Y, X = s.shape
    yy, xx = np.mgrid[:Y, :X]
    r = np.hypot((yy - (Y - 1) / 2) / (Y / 2), (xx - (X - 1) / 2) / (X / 2))
    ring = s[:, (r > 0.75) & (r < 0.9)]
    inside = s[:, r < 0.9]
    top = 255 if q.dtype == np.uint8 else 65535
    shift = 0 if q.dtype == np.uint8 else 4
    nb = (top >> shift) + 1
    h = np.bincount((ring.ravel() >> shift).astype(np.int64), minlength=nb).astype(np.float64)
    total = h.sum()
    h[0] = 0
    if h.sum() == 0:
        return None
    hs = np.convolve(h, np.ones(5) / 5, mode="same")
    m = int(np.argmax(hs))
    j0 = m
    while j0 > 0 and hs[j0] > 0.2 * hs[m]:
        j0 -= 1
    j1 = m
    while j1 < nb - 1 and hs[j1] > 0.2 * hs[m]:
        j1 += 1
    w = max(m - j0, j1 - m, 2)
    allh = np.bincount((inside.ravel() >> shift).astype(np.int64), minlength=nb).astype(np.float64)
    allh[0] = 0
    return m, w, allh, float(h[max(1, m - w): m + w + 1].sum() / total)


MEDIUM_SHARE = 0.3  # of the ring the medium's band fills, at least
MEDIUM_RISE = 5.0  # the medium's value above the scan's 0, in half-widths of its band, at least


def medium_side(q: np.ndarray, lo: float, hi: float, window: tuple[float, float] | None) -> str:
    """Whether the specimen lies in a mounting medium (HiP-CT's ethanol and agar), and on which side of it the
    tissue is: "above" or "below" (window_side), else "". A medium fills the scan's sides: its band (as
    guess_window finds it) holds MEDIUM_SHARE of the ring or more, every voxel counted (a masked scan's ring is
    mostly 0, and what a band of tissue holds of the rest is little: 0.17 at most in the scans tried, against 0.47
    to 0.95 for HiP-CT organs in their jars); and it is a material, not the background: its value lies
    MEDIUM_RISE half-widths of its band or more above the scan's 0 (8.7 or more for the jars; the air about an
    MR head, at 0 with noise as wide as its value, 2.5)."""
    rm = _ring_medium(q)
    if rm is None or window is None:
        return ""
    m, w, _, share = rm
    if share < MEDIUM_SHARE or m < MEDIUM_RISE * w:
        return ""
    return window_side(q, lo, hi, window)


def guess_window(q: np.ndarray, lo: float, hi: float) -> tuple[float, float] | None:
    """A window over the tissue of a specimen in a mounting medium (data units): from just past
    the medium, on the side of it that holds more of the rest (tissue is usually denser), to as
    far again as the tissue's commonest value, so that value is at the window's middle whatever
    else (calcium, metal) the scan holds. The medium is the commonest value in a ring about the
    scan's axis just inside its sides, and only what lies within that ring counts, so what lies
    outside a round jar (the corners) does not."""
    rm = _ring_medium(q)
    if rm is None:
        return None
    m, w, allh, _ = rm
    top = 255 if q.dtype == np.uint8 else 65535
    shift = 0 if q.dtype == np.uint8 else 4
    above, below = allh[m + w:], allh[: max(0, m - w)]
    unit = (hi - lo) / top * (1 << shift)
    at = lambda k: lo + k * unit
    def middle(x: np.ndarray) -> int:
        """Bins from the window's edge (x[0]) to the tissue's commonest value: the largest peak
        clear of the edge (the medium's tail falls away from it), or else the 99th percentile."""
        nz = np.flatnonzero(x)
        if nz.size == 0:
            return 1
        k = max(5, (int(nz[-1]) + 1) // 40) | 1  # smoothing over a 40th of the values' range (stepped data combs)
        hs = np.convolve(x, np.ones(k) / k, mode="same")
        best = -1
        for i in range(k, len(hs) - 1):
            low = hs[: i - k // 2].min()
            if hs[i] >= hs[i - 1] and hs[i] > hs[i + 1] and hs[i] > 1.3 * low and hs[i] > 0.05 * hs.max() and (best < 0 or hs[i] > hs[best]):
                best = i
        if best < 0:
            best = int(np.searchsorted(np.cumsum(x) / x.sum(), 0.99)) // 2
        return max(best, 1)

    if above.sum() >= below.sum() and above.sum() > 0:
        return at(m + w), at(m + w + 2 * middle(above))
    if below.sum() > 0:
        edge = max(0, m - w)
        return at(edge - 2 * middle(below[::-1])), at(edge)
    return None


def hide_outside_cylinder(q: np.ndarray, fraction: float, origin: tuple[int, int, int] = (0, 0, 0),
                          whole: tuple[int, int, int] | None = None) -> None:
    """Clears (to the lowest value) what lies outside a cylinder about the volume's z axis, of
    `fraction` of its half widths in x and y: the jar around a specimen scanned by HiP-CT, whose
    wall is as dense as tissue. In place. For a region of a level (detail.py): its first voxel
    `origin` (x, y, z) in the level, and the level's size `whole` (x, y, z)."""
    _, Y, X = q.shape
    WX, WY = (whole[0], whole[1]) if whole else (X, Y)
    yy, xx = np.mgrid[:Y, :X]
    yy, xx = yy + origin[1], xx + origin[0]
    r = np.hypot((yy - (WY - 1) / 2) / (WY / 2), (xx - (WX - 1) / 2) / (WX / 2))
    q[:, r > fraction] = 0


def tissue_box(q: np.ndarray, affine: np.ndarray, background: float, lo: float, hi: float) -> tuple[list[float], list[float]] | None:
    """The box (physical mm, x, y, z) holding the voxels above the background, from every 4th voxel."""
    top = 255.0 if q.dtype == np.uint8 else 65535.0
    t = (background - lo) / (hi - lo) * top if hi > lo else 0
    s = q[::4, ::4, ::4] > t
    if not s.any():
        return None
    idx = [np.flatnonzero(s.any(axis=tuple(a for a in range(3) if a != k))) for k in range(3)]  # z, y, x
    vlo = np.array([idx[2][0], idx[1][0], idx[0][0]], np.float64) * 4
    vhi = np.array([idx[2][-1], idx[1][-1], idx[0][-1]], np.float64) * 4 + 3
    corners = np.array([[x, y, z, 1.0] for x in (vlo[0], vhi[0]) for y in (vlo[1], vhi[1]) for z in (vlo[2], vhi[2])])
    w = (affine @ corners.T).T[:, :3]
    return w.min(axis=0).tolist(), w.max(axis=0).tolist()


def load(url: str, budget: int = 400_000_000, labels: bool | None = None, level: str | None = None,
         progress: Callable[[float, str], None] | None = None, make_from: str | None = None, factor: int | None = None,
         channel: int | None = None, time: int | None = None, cancelled: Callable[[], bool] | None = None) -> Loaded:
    """Reads the finest level with at most `budget` voxels (or the level named), making coarser
    levels from a finer stored one when no stored level is within 4x under the budget.
    `make_from` and `factor` (a power of 2) make a level from that stored level regardless.
    `channel` and `time` pick those of an image that has them (checked against its axes: a
    ValueError when out of range). Stops (Cancelled) between blocks once `cancelled()`."""
    t0 = _time.time()
    ms = open_multiscale(url)
    is_labels = ms.labels if labels is None else labels
    fixed = ms.fixed(channel, time)
    ci, ti = ms.channel_axis(), ms.time_axis()
    at_c, at_t = (fixed.get(ci, 0) if ci is not None else 0), (fixed.get(ti, 0) if ti is not None else 0)

    def nvox(lv: Level) -> int:
        return math.prod(lv.shape[i] for i in ms.spatial)

    if make_from is not None:
        chosen = next(lv for lv in ms.levels if lv.path == make_from)
        factor = int(factor or 2)
        if factor & (factor - 1):
            raise ValueError("factor must be a power of 2")
    elif level is not None:
        chosen = next(lv for lv in ms.levels if lv.path == level)
        factor = 1
    else:
        fitting = [lv for lv in ms.levels if nvox(lv) <= budget]
        larger = [lv for lv in ms.levels if nvox(lv) > budget]
        chosen, factor = (fitting[0] if fitting else ms.levels[-1]), 1
        if larger and (not fitting or nvox(fitting[0]) * 4 < budget):
            # A level made here, 2x at a time from the smallest stored level above the budget.
            base = larger[-1]
            f = 1
            while nvox(base) / (f ** 3) > budget:
                f *= 2
            if not fitting or nvox(base) / f ** 3 > nvox(fitting[0]):
                chosen, factor = base, f
    made = factor > 1
    from_cache = False
    cache = None
    if made or _remote(url):
        # Levels made here, and stored levels of a store on a server (read again for every session otherwise).
        # The store, the level, how it was made, the channel and time point, and a stamp of the level's metadata:
        # a store written again (a new stamp) is read again, not served from the cache.
        stamp = content_stamp(url, ms, chosen)
        key = hashlib.sha1(f"{http_url(url)}|{chosen.path}|{factor}|{int(is_labels)}|{sorted(fixed.items())}|{stamp}|v2".encode()).hexdigest()
        cache = _cache_dir() / f"{key}.npy"
    if cache is not None and cache.is_file():
        data = np.load(cache, mmap_mode=None)
        from_cache = True
        try:
            os.utime(cache)  # used now: the last to go
        except OSError:
            pass
        if progress:
            progress(1.0, f"level {chosen.path}" + (f"/{factor}x" if made else "") + " from the cache")
    else:
        data = _read(url, chosen, ms, progress, factor, is_labels, fixed, cancelled)
        if made and not is_labels:
            src_dtype = np.dtype(chosen.dtype)
            if src_dtype.kind in "ui":
                data = np.clip(np.rint(data), np.iinfo(src_dtype).min, np.iinfo(src_dtype).max).astype(src_dtype)
        if cache is not None:
            _cache_put(cache, data)
    A = chosen.affine.copy()
    if factor > 1:
        # Voxel i of the coarse level covers voxels f*i .. f*i + f - 1: its centre is at f*i + (f - 1) / 2.
        S = np.diag([factor, factor, factor, 1.0])
        S[:3, 3] = (factor - 1) / 2.0
        A = A @ S
    q, lo, hi = _quantize(data, is_labels)
    pc = {} if is_labels else tissue_percentiles(q, lo, hi)
    vox = tuple(float(np.linalg.norm(A[:3, c])) for c in range(3))
    name = chosen.path if factor == 1 else f"{chosen.path}/{factor}x"
    src = tuple(chosen.shape[i] for i in ms.spatial)
    win = None if is_labels else guess_window(q, lo, hi)
    qs = tissue_quantiles(q, lo, hi, win) if win else None
    side = medium_side(q, lo, hi, win) if qs else ""
    return Loaded(q, A, lo, hi, pc, name, vox, src, _time.time() - t0, made, from_cache, win, qs, at_c, at_t, ms.counts(), side)


def _cache_put(cache: Path, data: np.ndarray) -> None:
    """Keeps a made level in the cache, when it fits within the cache's size and the disk has room for it; the
    least recently used levels go to make room."""
    import shutil

    if data.nbytes > cache_max_bytes():
        return
    try:
        if shutil.disk_usage(cache.parent).free < data.nbytes + (1 << 30):
            cache_evict(max_bytes=max(0, sum(n for _, n, _ in cache_entries()) - data.nbytes))
            if shutil.disk_usage(cache.parent).free < data.nbytes + (1 << 30):
                return  # not kept: made again next time
        tmp = cache.with_name(f"{cache.stem}.{os.getpid()}.{threading.get_ident()}.tmp.npy")
        np.save(tmp, data)
        os.replace(tmp, cache)
    except OSError:
        return
    cache_evict(keep=cache)
