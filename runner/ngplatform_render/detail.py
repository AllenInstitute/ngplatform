"""Finer detail where the view looks: a region of a finer stored level, beside the coarse level
that holds the whole volume.

The renderer keeps the whole volume at one coarse level (volumes.load, within the session's
budget). When the view comes close, a second texture holds the region in view at a finer
level, and rays are tracked through it there and through the coarse level everywhere else, so
light that scatters or is shadowed outside the field of view still meets the rest of the
volume (kernels.track).

* plan: from the view and the depth where each pixel's ray first meets tissue, the box around
  what is seen (and some depth behind it), at the finest stored level that fits a voxel budget
  and is no finer than a pixel there; or None, when the coarse level is as fine as that.
* read_region: a box of a level, read chunk by chunk through a ChunkCache, so a view moved a
  little reads only the chunks it had not.
* DetailLoader: reads the region asked for last, in a thread, and hands it over when done; a
  newer request cuts an older read short.
"""

from __future__ import annotations

import math
import os
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

import numpy as np

from . import volumes


class ChunkCache:
    """Chunks (z, y, x arrays) by (store, level, chunk index), least recently used out first."""

    def __init__(self, max_bytes: int | None = None):
        gb = float(os.environ.get("NGP_RENDER_CHUNK_CACHE_GB", "8"))
        self.max_bytes = int(max_bytes if max_bytes is not None else gb * (1 << 30))
        self.bytes = 0
        self._d: OrderedDict[tuple, np.ndarray] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: tuple) -> np.ndarray | None:
        with self._lock:
            a = self._d.get(key)
            if a is not None:
                self._d.move_to_end(key)
            return a

    def put(self, key: tuple, a: np.ndarray) -> None:
        with self._lock:
            if key in self._d:
                return
            self._d[key] = a
            self.bytes += a.nbytes
            while self.bytes > self.max_bytes and len(self._d) > 1:
                _, old = self._d.popitem(last=False)
                self.bytes -= old.nbytes


CACHE = ChunkCache()


def voxel_size(world_from_voxel: np.ndarray) -> float:
    """The mean voxel edge (the cube root of the voxel's volume), in the matrix's units."""
    return float(abs(np.linalg.det(np.asarray(world_from_voxel, np.float64)[:3, :3])) ** (1 / 3))


def pixel_rays(inv_view_projection: np.ndarray, width: int, height: int, xs: np.ndarray, ys: np.ndarray):
    """Origins (on the near plane) and unit directions of the rays through pixel centres, as kernels.ray makes them."""
    inv = np.asarray(inv_view_projection, np.float64)
    nx = ((xs + 0.5) / width) * 2 - 1
    ny = 1 - ((ys + 0.5) / height) * 2

    def unproject(z):
        p = np.stack([nx, ny, np.full_like(nx, z), np.ones_like(nx)], -1) @ inv.T
        return p[..., :3] / p[..., 3:4]

    o, f = unproject(-1.0), unproject(1.0)
    d = f - o
    return o, d / np.linalg.norm(d, axis=-1, keepdims=True)


def plan(inv_view_projection, width: int, height: int, dist: np.ndarray, levels: list[tuple[tuple[int, int, int], np.ndarray]],
         coarse_voxel: float, budget: float, margin: float = 0.25, samples: int = 24):
    """The detail for a view: (index into `levels`, the box to load lo (x, y, z), hi (exclusive), and
    the box the view needs, within it: a detail already held that holds that need not be read again),
    or None.

    dist: (H, W) world distance along each pixel's ray to where it first meets tissue (-1: never).
    levels: the stored levels finer than the coarse one, finest first: (shape x, y, z; world from voxel).
    coarse_voxel: the coarse level's voxel size (world units). budget: voxels the region may hold.
    """
    H, W = dist.shape
    ys, xs = np.meshgrid(np.linspace(0, H - 1, samples), np.linspace(0, W - 1, samples), indexing="ij")
    ys, xs = ys.round().astype(int).ravel(), xs.round().astype(int).ravel()
    d = dist[ys, xs]
    hit = d >= 0
    if not hit.any():
        return None
    o, dw = pixel_rays(inv_view_projection, width, height, xs * width / W, ys * height / H)
    o, dw, d = o[hit], dw[hit], d[hit]
    p = o + dw * d[:, None]
    # How deep behind the surface to hold: half the width of what is seen, at least 8 coarse voxels.
    span = float(np.max(p.max(0) - p.min(0))) if len(p) > 1 else 0.0
    depth = max(0.5 * span, 8 * coarse_voxel)
    pts = np.concatenate([p - dw * (2 * coarse_voxel), p + dw * depth])
    # A pixel's width where the view is nearest: the angle between neighbouring pixels' rays times the distance.
    c = np.array([width / 2, width / 2 + 1]), np.array([height / 2, height / 2])
    _, dd = pixel_rays(inv_view_projection, width, height, *c)
    angle = float(np.linalg.norm(dd[1] - dd[0]))
    near = float(np.percentile(d, 10))
    footprint = max(angle * near, 1e-9)
    for i, (shape, wfv) in enumerate(levels):
        vs = voxel_size(wfv)
        if vs >= 0.95 * coarse_voxel:
            return None  # no finer than the coarse level
        if vs < 0.7 * footprint:
            continue  # finer than a pixel: no use
        v = (np.c_[pts, np.ones(len(pts))] @ np.linalg.inv(wfv).T)[:, :3]
        lo0, hi0 = v.min(0), v.max(0)
        n = np.asarray(shape, np.float64)
        need_lo = np.clip(np.floor(lo0) - 1, 0, n - 1).astype(int)
        need_hi = np.clip(np.ceil(hi0) + 2, 1, n).astype(int)
        pad = (hi0 - lo0) * margin + 2
        lo = np.clip(np.floor(lo0 - pad), 0, n - 1).astype(int)
        hi = np.clip(np.ceil(hi0 + pad) + 1, 1, n).astype(int)
        if (hi > lo).all() and math.prod((hi - lo).tolist()) > budget and math.prod((need_hi - need_lo).tolist()) <= budget:
            lo, hi = need_lo, need_hi  # the margin does not fit; what is needed does
        if (hi > lo).all() and math.prod((hi - lo).tolist()) <= budget:
            t = lambda a: tuple(int(x) for x in a)  # noqa: E731
            return i, t(lo), t(hi), t(need_lo), t(need_hi)
    return None


def contains(outer, inner) -> bool:
    """Whether box `outer` (lo, hi) holds box `inner`."""
    return all(a <= b for a, b in zip(outer[0], inner[0])) and all(a >= b for a, b in zip(outer[1], inner[1]))


_arrays: dict[tuple[str, str], object] = {}


def _array(url: str, path: str):
    import zarr

    key = (url, path)
    if key not in _arrays:
        zarr.config.set({"async.concurrency": 64})
        _arrays[key] = zarr.open_group(store=volumes._store(url), mode="r")[path]
    return _arrays[key]


def read_region(url: str, ms: volumes.Multiscale, level: volumes.Level, lo: tuple[int, int, int], hi: tuple[int, int, int],
                cache: ChunkCache | None = None, cancelled: Callable[[], bool] = lambda: False,
                progress: Callable[[float], None] | None = None, workers: int = 16) -> np.ndarray | None:
    """Voxels lo .. hi - 1 (x, y, z) of a level as a (z, y, x) array, chunk by chunk through the
    cache; None when cancelled."""
    cache = cache if cache is not None else CACHE
    arr = _array(url, level.path)
    chunks = getattr(arr, "chunks")
    xi, yi, zi = ms.spatial
    axes = (zi, yi, xi)
    lo_zyx, hi_zyx = (lo[2], lo[1], lo[0]), (hi[2], hi[1], hi[0])
    ch = [int(chunks[a]) for a in axes]
    n = [int(arr.shape[a]) for a in axes]
    ranges = [range(lo_zyx[k] // ch[k], (hi_zyx[k] - 1) // ch[k] + 1) for k in range(3)]
    out = np.empty([hi_zyx[k] - lo_zyx[k] for k in range(3)], np.dtype(arr.dtype))
    keys = [(cz, cy, cx) for cz in ranges[0] for cy in ranges[1] for cx in ranges[2]]

    def one(c):
        if cancelled():
            return False
        key = (url, level.path, c)
        a = cache.get(key)
        if a is None:
            sel = [0] * len(ms.axes)
            for k in range(3):
                sel[axes[k]] = slice(c[k] * ch[k], min(n[k], (c[k] + 1) * ch[k]))
            a = volumes._order_zyx(np.asarray(arr[tuple(sel)]), ms)
            cache.put(key, a)
        # The part of this chunk inside the box.
        s_out, s_in = [], []
        for k in range(3):
            c0 = c[k] * ch[k]
            a0, a1 = max(lo_zyx[k], c0), min(hi_zyx[k], c0 + a.shape[k])
            s_out.append(slice(a0 - lo_zyx[k], a1 - lo_zyx[k]))
            s_in.append(slice(a0 - c0, a1 - c0))
        out[tuple(s_out)] = a[tuple(s_in)]
        return True

    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for ok in ex.map(one, keys):
            if not ok:
                ex.shutdown(cancel_futures=True)
                return None
            done += 1
            if progress:
                progress(done / len(keys))
    return None if cancelled() else out


class DetailLoader:
    """Reads the region last asked for, in a thread; `on_ready(request, data)` when one is read."""

    def __init__(self, url: str, ms: volumes.Multiscale, on_ready: Callable[[dict, np.ndarray], None],
                 quantize: Callable[[np.ndarray], np.ndarray]):
        self.url, self.ms, self.on_ready, self.quantize = url, ms, on_ready, quantize
        self._cond = threading.Condition()
        self._gen = 0
        self._want: dict | None = None
        self.status: dict = {"state": "none"}
        self.closed = False
        threading.Thread(target=self._run, daemon=True).start()

    def request(self, req: dict) -> None:
        """Read `req` (level: index into ms.levels, lo, hi), unless it is what is being read already."""
        with self._cond:
            cur = self._want
            if cur is not None and (cur["level"], cur["lo"], cur["hi"]) == (req["level"], req["lo"], req["hi"]):
                return
            self._gen += 1
            self._want = dict(req, gen=self._gen)
            self._cond.notify_all()

    def cancel(self) -> None:
        with self._cond:
            self._gen += 1
            self._want = None
            if self.status.get("state") == "loading":
                self.status = {"state": "none"}

    def close(self) -> None:
        self.closed = True
        self.cancel()
        with self._cond:
            self._cond.notify_all()

    def _run(self) -> None:
        while not self.closed:
            with self._cond:
                while not self.closed and (self._want is None or self._want.get("taken")):
                    self._cond.wait(timeout=1.0)
                if self.closed:
                    return
                req = self._want
                req["taken"] = True
                gen = req["gen"]
            level = self.ms.levels[req["level"]]
            vox = math.prod(h - l for l, h in zip(req["lo"], req["hi"]))
            self.status = {"state": "loading", "level": level.path, "voxel_mm": list(level.voxel_mm), "voxels": vox, "progress": 0.0}

            def progress(f, gen=gen):
                if self._gen == gen:
                    self.status = {**self.status, "progress": round(f, 3)}

            try:
                data = read_region(self.url, self.ms, level, req["lo"], req["hi"], cancelled=lambda gen=gen: self._gen != gen or self.closed,
                                   progress=progress)
                if data is None or self._gen != gen:
                    continue
                data = self.quantize(data)
            except Exception as e:  # noqa: BLE001 - reported in the session's status
                self.status = {"state": "failed", "error": f"{type(e).__name__}: {e}"}
                continue
            with self._cond:
                if self._gen != gen:
                    continue
                self._want = None
            self.status = {"state": "ready", "level": level.path, "voxel_mm": list(level.voxel_mm), "voxels": vox}
            self.on_ready(req, data)
