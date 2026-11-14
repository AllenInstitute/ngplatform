"""An image within objects: the voxels of a stored level that lie inside closed meshes, at full
resolution where the budget allows, held as sparse bricks with no bounding box.

* Pages: the level is cut into pages of a few voxels (32 x 32 x 8 at 8 x 8 x 40 nm: roughly cubic in
  space).  A page is kept when a mesh's surface passes through it (sampled at the triangles' corners,
  edge midpoints and inner points, finer for triangles larger than a page) or when it lies wholly
  inside a mesh (pages between two surface pages along x, tested once at their first page's centre).
* Level: the finest stored level whose pages fit the budget (voxels, with their aprons).
* Bricks: each page read with a one-voxel apron (so trilinear samples near its faces read their true
  neighbours), every voxel outside the meshes set to 0, by the parity of a ray's crossings along x
  through the meshes' BVH (one ray a row of voxels, geometry.py).  Bricks are packed in an atlas.
* Tables: a top grid of cells of 16 pages a side (over the pages' bounds, so a few thousand entries
  for a whole cell), each kept cell an index into the sub-tables, one per kept cell, each page there
  its brick in the atlas, or -1.

Coordinates: meshes and the BVH in physical mm (the level's affine maps voxel index, centres at
integers, to them); the tracer takes world points to physical with world_from_physical's inverse.
"""

from __future__ import annotations

import math
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from . import detail, geometry, volumes

TOP = 16  # pages a top cell holds, each side
APRON = 1


@dataclass
class ObjectBricks:
    atlas: np.ndarray  # (az * bz, ay * by, ax * bx) uint8, b = page + 2 apron
    atlas_grid: tuple[int, int, int]  # bricks along x, y, z of the atlas
    page: tuple[int, int, int]  # voxels a page holds, x, y, z
    origin: tuple[int, int, int]  # the page index (x, y, z) of the top table's first cell's first page
    top: np.ndarray  # (tz, ty, tx) int32: a kept cell's sub-table, or -1
    sub: np.ndarray  # (n, TOP, TOP, TOP) int32 (z, y, x): a page's brick, or -1
    phys_from_voxel: np.ndarray  # 4x4: the level's voxel index -> physical mm
    level: str
    bricks: int
    inside_voxels: int
    value_range: tuple[float, float]  # the least and greatest kept value, 0..1
    stats: dict = field(default_factory=dict)
    # The values inside the objects (0..1, as the texture holds them): their percentiles, and p1..p99 as a window, so
    # a preset is placed on the objects' own histogram (the image within a cell spans a little of the whole's).
    percentiles: dict[float, float] = field(default_factory=dict)
    window: tuple[float, float] | None = None


def page_dims(voxel_mm) -> tuple[int, int, int]:
    """Voxels a page holds along x, y, z: about 0.5 µm a side (thin neurites waste little of a page), from 8 to
    32 voxels along the finest axis, the others as near the same length as a power of two allows (4..32)."""
    s = np.asarray(voxel_mm, np.float64)
    base = s.min()
    edge = min(max(5e-4, 8 * base), 32 * base)
    out = []
    for v in s:
        n = edge / v
        out.append(int(min(32, max(4, 2 ** round(math.log2(max(n, 1e-9)))))))
    return tuple(out)  # type: ignore[return-value]


def _samples(tris_vox: np.ndarray, page: np.ndarray) -> np.ndarray:
    """Points on each triangle (n, 3, 3 voxel coordinates): its corners, edge midpoints and centroid,
    and for a triangle longer than half a page a barycentric grid fine enough to meet every page it crosses."""
    a, b, c = tris_vox[:, 0], tris_vox[:, 1], tris_vox[:, 2]
    pts = [a, b, c, (a + b) / 2, (b + c) / 2, (c + a) / 2, (a + b + c) / 3]
    edge = np.max(np.stack([np.abs(b - a), np.abs(c - b), np.abs(a - c)]) / page, axis=(0, 2))
    k = np.ceil(edge * 2).astype(int)
    for kk in np.unique(k[k > 1]):
        kk = int(min(kk, 64))
        sel = k == kk if kk < 64 else k >= 64
        A, B, C = a[sel], b[sel], c[sel]
        for i in range(kk + 1):
            for j in range(kk + 1 - i):
                u, v = i / kk, j / kk
                pts.append(A + (B - A) * u + (C - A) * v)
    return np.concatenate(pts)


def surface_pages(tris_vox: np.ndarray, page) -> np.ndarray:
    """The pages (k, 3) int64, x y z, the triangles pass through."""
    p = np.asarray(page, np.float64)
    keys = np.floor((_samples(tris_vox, p) + 0.5) / p).astype(np.int64)
    return np.unique(keys, axis=0)


_KERNELS = r"""
extern "C" __global__ void inside(const float* tris, const int* tobj, const float* nodes, const int* kids, int n,
                                  const float* pts, int m, float dx, float dy, float dz, unsigned char* out) {
  V3 dir = v3(dx, dy, dz);
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= m) return;
  Geo G; G.tris = tris; G.kind = 0; G.tobj = tobj; G.nodes = nodes; G.kids = kids; G.n = n;
  V3 o = v3(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]);
  int c = 0, k;
  float t = 0.f;
  for (int g = 0; g < 4096; ++g) {
    float h = geohit(G, o, dir, t, 1e30f, &k);
    if (h < 0.f) break;
    ++c;
    t = h * 1.000001f + 1e-12f;
  }
  out[i] = (unsigned char)(c & 1);
}

// Rows of voxels: row r starts (its voxel 0) at starts[r] (physical) and steps by `step` a voxel; a voxel
// is inside when the crossings beyond it along the row's line are odd.
extern "C" __global__ void rowmask(const float* tris, const int* tobj, const float* nodes, const int* kids, int n,
                                   const float* starts, int m, float sx, float sy, float sz, int nvox, unsigned char* out) {
  V3 step = v3(sx, sy, sz);
  int r = blockIdx.x * blockDim.x + threadIdx.x;
  if (r >= m) return;
  Geo G; G.tris = tris; G.kind = 0; G.tobj = tobj; G.nodes = nodes; G.kids = kids; G.n = n;
  // From one voxel before the row: voxel k is at t = k + 1.
  V3 o = v3(starts[3 * r], starts[3 * r + 1], starts[3 * r + 2]) - step;
  float near[64];
  int nn = 0, total = 0, k;
  float t = 0.f;
  for (int g = 0; g < 4096; ++g) {
    float h = geohit(G, o, step, t, 1e30f, &k);
    if (h < 0.f) break;
    ++total;
    if (h <= nvox + 1 && nn < 64) near[nn++] = h;
    t = h * 1.000001f + 1e-7f;
  }
  // Hits come nearest first, so near[] is sorted.
  int j = 0;
  for (int v = 0; v < nvox; ++v) {
    float tv = v + 1.f;
    while (j < nn && near[j] <= tv) ++j;
    out[(long long)r * nvox + v] = (unsigned char)((total - j) & 1);
  }
}
"""

_mod = None


def _kernels():
    global _mod
    import cupy as cp

    if _mod is None:
        _mod = cp.RawModule(code=geometry.V3_PRELUDE + geometry.GEOMETRY_SOURCE + _KERNELS, options=("--std=c++14",))
    return _mod


# A direction off the axes and the triangles' edges, so a ray does not run along an edge or through a vertex exactly.
_SKEW = np.array([1.0, 1.3e-4, 2.9e-4])


def inside_points(bvh: geometry.Bvh, pts_phys: np.ndarray) -> np.ndarray:
    """Whether each point (physical) is inside the meshes: the parity of a ray's crossings."""
    import cupy as cp

    m = len(pts_phys)
    if m == 0 or bvh.n == 0:
        return np.zeros(m, bool)
    out = cp.zeros(m, cp.uint8)
    d = _SKEW / np.linalg.norm(_SKEW)
    _kernels().get_function("inside")(((m + 127) // 128,), (128,), (bvh.tris, bvh.tobj, bvh.nodes, bvh.kids, np.int32(bvh.n),
                                                                    cp.asarray(pts_phys, cp.float32), np.int32(m), *(np.float32(v) for v in d), out))
    return cp.asnumpy(out).astype(bool)


def interior_pages(surface: np.ndarray, inside_at: Callable[[np.ndarray], np.ndarray]) -> np.ndarray:
    """Pages with no surface lying inside a mesh: along each row of pages (fixed y, z), the gaps between
    surface pages whose first page's centre is inside (inside_at: page centres (k, 3) -> bool)."""
    if len(surface) == 0:
        return surface
    s = surface[np.lexsort((surface[:, 0], surface[:, 1], surface[:, 2]))]
    same = (s[1:, 1] == s[:-1, 1]) & (s[1:, 2] == s[:-1, 2])
    gap = same & (s[1:, 0] - s[:-1, 0] > 1)
    idx = np.flatnonzero(gap)
    if len(idx) == 0:
        return np.zeros((0, 3), np.int64)
    first = s[idx].copy()
    first[:, 0] += 1
    ok = inside_at(first)
    out = []
    for i, yes in zip(idx, ok):
        if yes:
            x0, x1 = s[i, 0] + 1, s[i + 1, 0]
            out.append(np.stack([np.arange(x0, x1), np.full(x1 - x0, s[i, 1]), np.full(x1 - x0, s[i, 2])], 1))
    return np.concatenate(out) if out else np.zeros((0, 3), np.int64)


def _to_vox(level: volumes.Level, phys: np.ndarray) -> np.ndarray:
    A = np.linalg.inv(np.asarray(level.affine, np.float64))
    return phys @ A[:3, :3].T + A[:3, 3]


def build(url: str, ms: volumes.Multiscale, tris_phys: np.ndarray, bvh: geometry.Bvh, budget: int,
          to_u8: Callable[[np.ndarray], np.ndarray], progress: Callable[[float, str], None] | None = None,
          cancelled: Callable[[], bool] = lambda: False, level: str | None = None,
          labels: tuple[str, volumes.Multiscale, list[int]] | None = None) -> ObjectBricks:
    """The image within the meshes (tris_phys (n, 3, 3), physical mm; bvh: theirs, in the same space), at the
    finest level whose bricks fit `budget` voxels (or `level`).  to_u8: a block of the level's values to uint8 (0..255 as 0..1).
    labels: (a segmentation's URL, its multiscale, the segment ids): a voxel is kept where its label is one of them
    (the segmentation's level of the same voxel size), not by the meshes, which are simplified from it; the meshes
    still choose the pages.  Without a level of that size, the meshes decide."""
    import cupy as cp

    say = progress or (lambda f, m: None)
    levels = [lv for lv in ms.levels if level is None or lv.path == level] or ms.levels
    chosen = None
    for lv in levels:  # finest first
        page = page_dims(lv.voxel_mm)
        brick = np.array(page) + 2 * APRON
        vox_tris = _to_vox(lv, tris_phys.reshape(-1, 3)).reshape(-1, 3, 3)
        surf = surface_pages(vox_tris, page)
        need = len(surf) * int(np.prod(brick))
        if need > budget and lv is not levels[-1]:
            continue
        P = np.asarray(page, np.float64)
        centre = lambda k, lv=lv, P=P: (np.asarray(k, np.float64) * P + (P - 1) / 2) @ np.asarray(lv.affine)[:3, :3].T + np.asarray(lv.affine)[:3, 3]
        inner = interior_pages(surf, lambda k: inside_points(bvh, centre(k)))
        pages = np.concatenate([surf, inner]) if len(inner) else surf
        need = len(pages) * int(np.prod(brick))
        if need > budget and lv is not levels[-1]:
            continue
        chosen = (lv, page, brick, pages, len(surf), len(inner))
        break
    assert chosen is not None
    lv, page, brick, pages, nsurf, ninner = chosen
    say(0.02, f"{lv.path}: {len(pages)} bricks ({nsurf} on the surface), {len(pages) * int(np.prod(brick)) / 1e6:.0f} M voxels")
    P = np.asarray(page, np.int64)
    B = np.asarray(brick, np.int64)
    shape_xyz = np.asarray(lv.shape[::-1], np.int64)  # level x, y, z (z, y, x arrays, see volumes.Level)

    # The atlas: bricks in rows of up to 128 along x and y.
    n = len(pages)
    ax = min(n, 128)
    ay = min(-(-n // ax), 128)
    az = -(-n // (ax * ay))

    # Pages read a group at a time (4 pages a side), each group one region with the apron through the
    # chunk cache, several groups at once; each page's brick kept as read, masked below.
    groups: dict[tuple, list[int]] = {}
    for i, k in enumerate(pages):
        groups.setdefault(tuple(k // 4), []).append(i)
    data = np.zeros((n, B[2], B[1], B[0]), np.uint8)
    # The segmentation's level of this voxel size, and its voxel index of this level's voxel 0 (a whole shift).
    seg = None
    if labels is not None:
        seg_url, seg_ms, seg_ids = labels
        A = np.asarray(lv.affine, np.float64)
        for sl in seg_ms.levels:
            S = np.asarray(sl.affine, np.float64)
            if np.allclose(S[:3, :3], A[:3, :3], rtol=1e-6, atol=0):
                shift = np.linalg.solve(S[:3, :3], A[:3, 3] - S[:3, 3])
                if np.allclose(shift, np.round(shift), atol=1e-3):
                    seg = (seg_url, seg_ms, sl, np.round(shift).astype(np.int64), np.asarray(sorted(set(seg_ids)), np.uint64))
                    break
    masks = np.zeros((n, B[2], B[1], B[0]), bool) if seg is not None else None
    done = [0]
    lock = threading.Lock()

    def read_group(item):
        g, members = item
        if cancelled():
            raise volumes.Cancelled("closed while loading")
        glo = np.asarray(g, np.int64) * 4 * P - APRON
        ghi = (np.asarray(g, np.int64) + 1) * 4 * P + APRON
        rlo, rhi = np.maximum(glo, 0), np.minimum(ghi, shape_xyz)
        region = np.zeros((ghi - glo)[::-1], np.uint8)
        if (rhi > rlo).all():
            got = detail.read_region(url, ms, lv, tuple(int(v) for v in rlo), tuple(int(v) for v in rhi), cancelled=cancelled, workers=8)
            if got is None:
                raise volumes.Cancelled("closed while loading")
            o = rlo - glo
            region[o[2]:o[2] + got.shape[0], o[1]:o[1] + got.shape[1], o[0]:o[0] + got.shape[2]] = to_u8(got)
        inside = None
        if seg is not None:
            seg_url, seg_ms, sl, shift, ids = seg
            sshape = np.asarray(sl.shape[::-1], np.int64)
            slo, shi = np.maximum(glo + shift, 0), np.minimum(ghi + shift, sshape)
            inside = np.zeros((ghi - glo)[::-1], bool)
            if (shi > slo).all():
                lab = detail.read_region(seg_url, seg_ms, sl, tuple(int(v) for v in slo), tuple(int(v) for v in shi), cancelled=cancelled, workers=8)
                if lab is None:
                    raise volumes.Cancelled("closed while loading")
                o = slo - shift - glo
                inside[o[2]:o[2] + lab.shape[0], o[1]:o[1] + lab.shape[1], o[0]:o[0] + lab.shape[2]] = np.isin(lab.astype(np.uint64, copy=False), ids)
        for i in members:
            a = pages[i] * P - APRON - glo  # the brick's corner in the region
            data[i] = region[a[2]:a[2] + B[2], a[1]:a[1] + B[1], a[0]:a[0] + B[0]]
            if inside is not None:
                masks[i] = inside[a[2]:a[2] + B[2], a[1]:a[1] + B[1], a[0]:a[0] + B[0]]
        with lock:
            done[0] += 1
            say(0.05 + 0.75 * done[0] / len(groups), f"read {lv.path}: {done[0]}/{len(groups)} groups of bricks")

    with ThreadPoolExecutor(max_workers=12) as ex:
        list(ex.map(read_group, groups.items()))

    # The mask: one ray a row of voxels (x), every row of every brick, in batches on the GPU.
    affine = np.asarray(lv.affine, np.float64)
    step_phys = (affine[:3, :3] @ (_SKEW / np.linalg.norm(_SKEW))).astype(np.float32)
    ys, zs = np.meshgrid(np.arange(B[1]), np.arange(B[2]), indexing="xy")
    row_off = np.stack([np.zeros(ys.size), ys.ravel(), zs.ravel()], 1)  # per row of a brick: (0, y, z), z slowest
    mod = _kernels()
    batch = max(1, (1 << 22) // len(row_off))  # about 4 M rows a launch
    inside_total = 0
    if masks is not None:
        # By the labels: no rays.
        data *= masks
        inside_total = int(masks[:, APRON:-APRON, APRON:-APRON, APRON:-APRON].sum())
    for b0 in range(0, n if masks is None else 0, batch):
        if cancelled():
            raise volumes.Cancelled("closed while loading")
        idx = np.arange(b0, min(n, b0 + batch))
        corner = (pages[idx] * P - APRON).astype(np.float64)  # (k, 3) voxel
        v0 = (corner[:, None, :] + row_off[None]).reshape(-1, 3)
        st = (v0 @ affine[:3, :3].T + affine[:3, 3]).astype(np.float32)
        m = len(st)
        mask = cp.zeros(m * int(B[0]), cp.uint8)
        mod.get_function("rowmask")(((m + 127) // 128,), (128,), (bvh.tris, bvh.tobj, bvh.nodes, bvh.kids, np.int32(bvh.n),
                                                                   cp.asarray(st), np.int32(m), *(np.float32(v) for v in step_phys), np.int32(B[0]), mask))
        mk = cp.asnumpy(mask).reshape(len(idx), B[2], B[1], B[0]).astype(bool)
        data[idx] *= mk
        inside_total += int(mk[:, APRON:-APRON, APRON:-APRON, APRON:-APRON].sum())
        say(0.8 + 0.15 * min(n, b0 + batch) / n, f"masked {min(n, b0 + batch)}/{n} bricks")
    nz = data[data > 0]
    lo_val, hi_val = (nz.min() / 255.0, nz.max() / 255.0) if nz.size else (0.0, 0.0)
    pct = {k: v / 255.0 for k, v in volumes.tissue_percentiles(nz, 0.0, 255.0).items()} if nz.size else {}
    del nz
    # Packed into the atlas, bricks in rows along x, then y, then layers along z.
    atlas = data.reshape(az, ay, ax, B[2], B[1], B[0]) if n == ax * ay * az else np.concatenate(
        [data, np.zeros((ax * ay * az - n, B[2], B[1], B[0]), np.uint8)]).reshape(az, ay, ax, B[2], B[1], B[0])
    atlas = np.ascontiguousarray(atlas.transpose(0, 3, 1, 4, 2, 5)).reshape(az * B[2], ay * B[1], ax * B[0])
    del data

    # The tables.
    pmin = pages.min(0)
    origin = (pmin // TOP) * TOP
    rel = pages - origin
    cell = rel // TOP
    tdims = cell.max(0) + 1
    top = np.full(tdims[::-1], -1, np.int32)
    cells, which = np.unique(cell, axis=0, return_inverse=True)
    top[cells[:, 2], cells[:, 1], cells[:, 0]] = np.arange(len(cells), dtype=np.int32)
    sub = np.full((len(cells), TOP, TOP, TOP), -1, np.int32)
    loc = rel % TOP
    sub[which.ravel(), loc[:, 2], loc[:, 1], loc[:, 0]] = np.arange(n, dtype=np.int32)
    return ObjectBricks(atlas, (ax, ay, az), tuple(int(v) for v in page), tuple(int(v) for v in origin), top, sub,
                        affine, lv.path, n, inside_total, (float(lo_val), float(max(hi_val, lo_val))),
                        {"surface_pages": nsurf, "interior_pages": ninner, "inside_by": "labels" if seg is not None else "mesh"}, pct,
                        (pct[1.0], pct[99.0]) if 1.0 in pct and 99.0 in pct and pct[99.0] > pct[1.0] else None)
