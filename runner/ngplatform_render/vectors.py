"""A Zarr Vectors store as the path tracer's surfaces (geometry.py): streamlines, polylines and lines as
round cones a segment each, skeletons and graphs as round cones an edge each, point clouds as spheres,
meshes as triangles; read through the `zarr_vectors` package at the finest level within a budget of
vertices.  Positions are taken to the physical millimetres the anatomical renderer works in from the
store's axis units.

Colours: a streamline's segment by its direction (red x, green y, blue z, as tractography draws them),
anything else by its object (a colour from its id), or one colour where there are no objects.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from . import geometry
from .volumes import UNIT_MM, http_url


@dataclass
class Surfaces:
    prims: np.ndarray  # (n, 9) float32, as geometry.build takes them
    kinds: np.ndarray  # (n,) int32
    objects: np.ndarray  # (n,) int32: each primitive's colour (an index into colours)
    colours: np.ndarray  # (m, 3) float32
    meta: dict = field(default_factory=dict)


def store_url(url: str) -> str:
    """A layer's source (`…|zarr-vectors:`, `zarr-vectors://…`) as the store's http(s) URL or path, ending in /."""
    u = url.strip()
    if u.startswith("zarr-vectors://"):
        u = u[len("zarr-vectors://"):]
    u = http_url(u.split("|")[0])
    return u + "/"


def _levels(ds, base: str) -> list[tuple[int, int]]:
    """The store's levels and their vertex counts, from each level's metadata (finest first)."""
    from .precomputed import _get

    out = []
    for k in range(32):
        raw = _get(f"{base}{k}/zarr.json")
        if raw is None:
            break
        lv = json.loads(raw).get("attributes", {}).get("zarr_vectors_level", {})
        out.append((k, int(lv.get("vertex_count") or 0)))
    return out


def _unit_mm(base: str) -> float:
    """Millimetres a store unit is, from its axes (multiscales or the zarr_vectors block); 1 when it says none."""
    from .precomputed import _get

    raw = _get(f"{base}zarr.json")
    attrs = json.loads(raw).get("attributes", {}) if raw else {}
    axes = (attrs.get("multiscales") or [{}])[0].get("axes") or attrs.get("zarr_vectors", {}).get("axes") or []
    units = [a.get("unit") for a in axes if isinstance(a, dict) and a.get("unit")]
    crs = attrs.get("zarr_vectors", {}).get("crs", {}).get("units") if isinstance(attrs.get("zarr_vectors", {}).get("crs"), dict) else None
    unit = units[0] if units else crs
    return float(UNIT_MM.get(unit or "", 1.0))


def _hash_colours(ids: np.ndarray) -> np.ndarray:
    """A colour per id: hues spread by the golden ratio, as the platform's palette."""
    h = (np.asarray(ids, np.float64) * 0.61803398875) % 1.0
    c = np.clip(np.abs(np.mod(h[:, None] * 6.0 + np.array([0.0, 4.0, 2.0]), 6.0) - 3.0) - 1.0, 0.0, 1.0)
    return (0.25 + 0.75 * c).astype(np.float32)


def load(url: str, budget: int = 4_000_000, radius_mm: float | None = None, level: int | None = None,
         progress: Callable[[float, str], None] | None = None) -> Surfaces:
    """The store's geometry at the finest level of at most `budget` vertices (or `level`), as surfaces.
    radius_mm: tubes' and points' radius (default: a store's `radius` attribute, else 0.2% of its size)."""
    import zarr_vectors as zv

    say = progress or (lambda f, m: None)
    base = store_url(url)
    ds = zv.open(base)
    levels = _levels(ds, base)
    if level is None:
        fits = [k for k, n in levels if 0 < n <= budget]
        level = fits[0] if fits else (levels[-1][0] if levels else 0)
    say(0.1, f"reading level {level} of {base.rstrip('/').split('/')[-1]}")
    r = ds.read(level=int(level))
    mm = _unit_mm(base)
    pos = np.asarray(r.positions, np.float64)[:, :3] * mm
    kind = str(r.kind)
    lo, hi = (pos.min(0), pos.max(0)) if len(pos) else (np.zeros(3), np.zeros(3))
    size = float(np.linalg.norm(hi - lo)) or 1.0
    radius = radius_mm
    attrs = r.attributes
    names = list(attrs.names()) if attrs is not None and hasattr(attrs, "names") else []
    per_vertex_r = np.asarray(attrs["radius"], np.float64).ravel() * mm if "radius" in names else None
    if radius is None and per_vertex_r is None:
        radius = 0.002 * size
    meta = {"kind": kind, "level": int(level), "vertices": int(len(pos)), "unit_mm": mm}

    if kind in ("streamline", "polyline", "line"):
        starts, ends, seg_obj = [], [], []
        parts = r.parts if r.parts else (slice(0, len(pos)),)
        for j, sl in enumerate(parts):
            idx = np.arange(len(pos))[sl]
            if len(idx) < 2:
                continue
            starts.append(idx[:-1])
            ends.append(idx[1:])
            seg_obj.append(np.full(len(idx) - 1, j))
        a = np.concatenate(starts) if starts else np.zeros(0, np.int64)
        b = np.concatenate(ends) if ends else np.zeros(0, np.int64)
        rad_a = per_vertex_r[a] if per_vertex_r is not None else radius
        rad_b = per_vertex_r[b] if per_vertex_r is not None else radius
        prims = geometry.cones(pos[a], pos[b], rad_a, rad_b)
        kinds = np.full(len(prims), geometry.CONE, np.int32)
        if kind == "streamline":
            d = np.abs(pos[b] - pos[a])
            colours = (d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-12)).astype(np.float32)
            objects = np.arange(len(prims), dtype=np.int32)
        else:
            objs = np.concatenate(seg_obj) if seg_obj else np.zeros(0, np.int64)
            colours = _hash_colours(np.arange(len(parts)))
            objects = objs.astype(np.int32)
        meta["segments"] = int(len(prims))
    elif kind in ("skeleton", "graph"):
        e = np.asarray(r.edges, np.int64).reshape(-1, 2) if r.edges is not None else np.zeros((0, 2), np.int64)
        rad_a = per_vertex_r[e[:, 0]] if per_vertex_r is not None else radius
        rad_b = per_vertex_r[e[:, 1]] if per_vertex_r is not None else radius
        prims = geometry.cones(pos[e[:, 0]], pos[e[:, 1]], rad_a, rad_b)
        kinds = np.full(len(prims), geometry.CONE, np.int32)
        vobj = np.asarray(r.object_ids).ravel() if r.object_ids is not None and len(np.asarray(r.object_ids)) == len(pos) else np.zeros(len(pos), np.int64)
        uniq, inv = np.unique(vobj[e[:, 0]], return_inverse=True)
        colours, objects = _hash_colours(uniq), inv.astype(np.int32)
        meta["edges"] = int(len(prims))
    elif kind == "mesh":
        f = np.asarray(r.faces, np.int64).reshape(-1, 3)
        prims = pos[f].reshape(-1, 9).astype(np.float32)
        kinds = np.full(len(prims), geometry.TRIANGLE, np.int32)
        vobj = np.asarray(r.object_ids).ravel() if r.object_ids is not None and len(np.asarray(r.object_ids)) == len(pos) else np.zeros(len(pos), np.int64)
        uniq, inv = np.unique(vobj[f[:, 0]], return_inverse=True)
        colours, objects = _hash_colours(uniq), inv.astype(np.int32)
        meta["triangles"] = int(len(prims))
    else:  # point_cloud
        rad = per_vertex_r if per_vertex_r is not None else radius
        prims = geometry.spheres(pos, rad)
        kinds = np.full(len(prims), geometry.SPHERE, np.int32)
        vobj = np.asarray(r.object_ids).ravel() if r.object_ids is not None and len(np.asarray(r.object_ids)) == len(pos) else None
        if vobj is not None:
            uniq, inv = np.unique(vobj, return_inverse=True)
            colours, objects = _hash_colours(uniq), inv.astype(np.int32)
        else:
            colours, objects = np.array([[0.85, 0.82, 0.75]], np.float32), np.zeros(len(prims), np.int32)
        meta["points"] = int(len(prims))
    if len(colours) == 0:
        colours = np.array([[0.85, 0.82, 0.75]], np.float32)
    meta["radius_mm"] = None if radius is None else float(radius)
    return Surfaces(prims, kinds, objects, colours, meta)
