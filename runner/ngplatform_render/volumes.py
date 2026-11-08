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
under them; the store itself is never written.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

UNIT_MM = {
    "nanometer": 1e-6, "micrometer": 1e-3, "micron": 1e-3, "millimeter": 1.0, "centimeter": 10.0,
    "meter": 1e3, "nm": 1e-6, "um": 1e-3, "µm": 1e-3, "mm": 1.0, "cm": 10.0, "m": 1e3, "": 1.0,
}


def http_url(url: str) -> str:
    url = url.strip()
    for p in ("zarr3://", "zarr2://", "zarr://"):
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
    return Multiscale(url, names, spatial, levels, ms.get("name", ""), labels)


def _cache_dir() -> Path:
    d = Path(os.environ.get("NGP_RENDER_CACHE") or Path(os.environ.get("NGP_STATE_DIR", "~/.ngplatform-runner")).expanduser() / "render-cache")
    d.mkdir(parents=True, exist_ok=True)
    return d


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
    from_cache: bool = False
    window: tuple[float, float] | None = None  # a guess at the tissue's values (data units), for "window" presets


def _spatial_view(arr, ms: Multiscale):
    """An index tuple selecting the first entry of every non-spatial axis, and the z, y, x order."""
    sel = []
    for i, n in enumerate(ms.axes):
        sel.append(slice(None) if i in ms.spatial else 0)
    return tuple(sel)


def _order_zyx(a: np.ndarray, ms: Multiscale) -> np.ndarray:
    """Array of the spatial axes (in array order) transposed to z, y, x."""
    kept = [i for i in range(len(ms.axes)) if i in ms.spatial]
    names = [ms.axes[i] for i in kept]
    return np.transpose(a, [names.index(k) for k in ("z", "y", "x")])


def _read(url: str, level: Level, ms: Multiscale, progress: Callable[[float, str], None] | None,
          factor: int = 1, labels: bool = False) -> np.ndarray:
    """The level's spatial axes as a (z, y, x) array, read in chunk-aligned blocks; with
    factor > 1, each block reduced 2x at a time as it comes (so memory holds the output and
    one block), which is how levels are made here."""
    import zarr
    from concurrent.futures import ThreadPoolExecutor

    zarr.config.set({"async.concurrency": 64})
    g = zarr.open_group(store=_store(url), mode="r")
    arr = g[level.path]
    shard = getattr(arr, "shards", None) or arr.chunks
    zi, yi, xi = ms.spatial[2], ms.spatial[1], ms.spatial[0]
    n = (arr.shape[zi], arr.shape[yi], arr.shape[xi])
    # Blocks: the chunk (or shard) shape, grown to at least 64 MB and to a multiple of the factor.
    blk = [max(int(shard[i]), factor) for i in (zi, yi, xi)]
    itemsize = np.dtype(arr.dtype).itemsize
    while math.prod(blk) * itemsize < (64 << 20) and any(b < m for b, m in zip(blk, n)):
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
        z, y, x = b
        sel = [0] * len(ms.axes)
        for i, nm in enumerate(ms.axes):
            if i not in ms.spatial:
                sel[i] = 0
        stops = (min(n[0], z + blk[0]), min(n[1], y + blk[1]), min(n[2], x + blk[2]))
        sel[zi], sel[yi], sel[xi] = slice(z, stops[0]), slice(y, stops[1]), slice(x, stops[2])
        a = _order_zyx(np.asarray(arr[tuple(sel)]), ms)
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
        list(ex.map(one, boxes))
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


def guess_window(q: np.ndarray, lo: float, hi: float) -> tuple[float, float] | None:
    """A window over the tissue of a specimen in a mounting medium (data units): from just past
    the medium, on the side of it that holds more of the rest (tissue is usually denser), to as
    far again as the tissue's commonest value, so that value is at the window's middle whatever
    else (calcium, metal) the scan holds. The medium is the commonest value in a ring about the
    scan's axis just inside its sides, and only what lies within that ring counts, so what lies
    outside a round jar (the corners) does not."""
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


def hide_outside_cylinder(q: np.ndarray, fraction: float) -> None:
    """Clears (to the lowest value) what lies outside a cylinder about the volume's z axis, of
    `fraction` of its half widths in x and y: the jar around a specimen scanned by HiP-CT, whose
    wall is as dense as tissue. In place."""
    _, Y, X = q.shape
    yy, xx = np.mgrid[:Y, :X]
    r = np.hypot((yy - (Y - 1) / 2) / (Y / 2), (xx - (X - 1) / 2) / (X / 2))
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
         progress: Callable[[float, str], None] | None = None, make_from: str | None = None, factor: int | None = None) -> Loaded:
    """Reads the finest level with at most `budget` voxels (or the level named), making coarser
    levels from a finer stored one when no stored level is within 4x under the budget.
    `make_from` and `factor` (a power of 2) make a level from that stored level regardless."""
    t0 = time.time()
    ms = open_multiscale(url)
    is_labels = ms.labels if labels is None else labels

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
    key = hashlib.sha1(f"{http_url(url)}|{chosen.path}|{factor}|{int(is_labels)}|v1".encode()).hexdigest()
    cache = _cache_dir() / f"{key}.npy"
    made = factor > 1
    from_cache = False
    if made and cache.is_file():
        data = np.load(cache, mmap_mode=None)
        from_cache = True
        if progress:
            progress(1.0, f"level {chosen.path}/{factor}x from the cache")
    else:
        data = _read(url, chosen, ms, progress, factor, is_labels)
        if made:
            if not is_labels:
                src_dtype = np.dtype(chosen.dtype)
                if src_dtype.kind in "ui":
                    data = np.clip(np.rint(data), np.iinfo(src_dtype).min, np.iinfo(src_dtype).max).astype(src_dtype)
            tmp = cache.with_name(f"{cache.stem}.{os.getpid()}.{threading.get_ident()}.tmp.npy")
            np.save(tmp, data)
            os.replace(tmp, cache)
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
    return Loaded(q, A, lo, hi, pc, name, vox, src, time.time() - t0, made, from_cache, win)
