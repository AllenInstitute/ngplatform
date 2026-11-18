"""A Zarr Vectors store as the path tracer's surfaces (geometry.py): streamlines, polylines and lines as
round cones a segment each, skeletons and graphs as round cones an edge each, point clouds as spheres,
meshes as triangles; read through the `zarr_vectors` package at the finest level within a budget of
vertices.  Positions are taken to the physical millimetres the anatomical renderer works in from the
store's axis units.

Colours: a streamline's segment by its direction (red x, green y, blue z, as tractography draws them),
anything else by its object (a colour from its id), or one colour where there are no objects; or as the
layer is coloured (its Display tab's Colour by, `look`: a group, in the store's colours or a palette's,
the groups not chosen hidden; or an attribute through a colour map between a low and a high value, what
lies outside hidden if asked), from the attributes read with the geometry (`colour`).
"""

from __future__ import annotations

import json
import re
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
    vertex: np.ndarray | None = None  # (n,) each primitive's vertex (a point's own, a segment's or a face's first), for its values
    values: dict[str, np.ndarray] = field(default_factory=dict)  # the attributes read, by shader id: a value per vertex


def store_url(url: str) -> str:
    """A layer's source (`…|zarr-vectors:`, `zarr-vectors://…`) as the store's http(s) URL or path, ending in /."""
    u = url.strip()
    if u.startswith("zarr-vectors://"):
        u = u[len("zarr-vectors://"):]
    u = http_url(u.split("|")[0])
    return u + "/"


def _zv(raw: bytes | str | None) -> tuple[dict, dict]:
    """A node's zarr.json as (its attributes, its Zarr Vectors properties), in format 0.9 or 0.10: 0.10 keeps
    every node's under `zarr_vectors` (`kind` saying which node it is); 0.9 a level's under
    `zarr_vectors_level`, an array's beside `zv_array`, the root's under `zarr_vectors`."""
    attrs = json.loads(raw).get("attributes", {}) if raw else {}
    zv = attrs.get("zarr_vectors")
    if isinstance(zv, dict) and "kind" in zv:
        return attrs, zv
    if "zarr_vectors_level" in attrs:
        return attrs, attrs["zarr_vectors_level"]
    return attrs, zv if isinstance(zv, dict) else attrs


def _levels(ds, base: str) -> list[tuple[int, int]]:
    """The store's levels and their vertex counts, from each level's metadata (finest first)."""
    from .precomputed import _get

    out = []
    for k in range(32):
        raw = _get(f"{base}{k}/zarr.json")
        if raw is None:
            break
        out.append((k, int(_zv(raw)[1].get("vertex_count") or 0)))
    return out


def _element(base: str, level: int) -> str | None:
    """A volume mesh's element (format 0.10's `element` on links/0: tetra, pyramid, wedge, hexahedron), or None."""
    from .precomputed import _get

    element = _zv(_get(f"{base}{level}/links/0/zarr.json"))[1].get("element")
    return None if element is None else str(element)


#: Each volume element's faces in VTK order, outward right-hand normals (zarr_vectors/core/elements.py's tables).
ELEMENT_FACES = {
    "tetra": ((0, 1, 3), (1, 2, 3), (2, 0, 3), (0, 2, 1)),
    "pyramid": ((0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)),
    "wedge": ((0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)),
    "hexahedron": ((0, 4, 7, 3), (1, 2, 6, 5), (0, 1, 5, 4), (3, 7, 6, 2), (0, 3, 2, 1), (4, 5, 6, 7)),
}


def fan(faces: np.ndarray) -> np.ndarray:
    """Polygon faces (F, k), each as k - 2 triangles fanned from its first corner, winding kept."""
    faces = np.asarray(faces, np.int64)
    if faces.ndim != 2 or faces.shape[1] < 3:
        return np.zeros((0, 3), np.int64)
    if faces.shape[1] == 3:
        return faces
    return np.concatenate([faces[:, [0, i, i + 1]] for i in range(1, faces.shape[1] - 1)])


def boundary_triangles(cells: np.ndarray, element: str) -> np.ndarray:
    """A volume mesh's surface: the cells' faces no other cell shares, wound outward, as triangles (quads split)."""
    table = ELEMENT_FACES[element]
    cells = np.asarray(cells, np.int64).reshape(-1, len({i for f in table for i in f}))
    out = []
    for size in sorted({len(f) for f in table}):
        faces = np.concatenate([cells[:, list(f)] for f in table if len(f) == size])
        if len(faces) == 0:
            continue
        _, inverse, counts = np.unique(np.sort(faces, axis=1), axis=0, return_inverse=True, return_counts=True)
        out.append(fan(faces[counts[inverse.ravel()] == 1]))
    return np.concatenate(out) if out else np.zeros((0, 3), np.int64)


def _unit_mm(base: str) -> float:
    """Millimetres a store unit is, from its axes (multiscales or the zarr_vectors block); 1 when it says none."""
    from .precomputed import _get

    raw = _get(f"{base}zarr.json")
    attrs, root = _zv(raw)
    # (Format 0.10's multiscales is the convention's object, its axes in the zarr_vectors block.)
    ms = attrs.get("multiscales")
    axes = (ms[0].get("axes") if isinstance(ms, list) and ms and isinstance(ms[0], dict) else None) or root.get("axes") or []
    units = [a.get("unit") for a in axes if isinstance(a, dict) and a.get("unit")]
    crs = root.get("crs", {}).get("units") if isinstance(root.get("crs"), dict) else None
    unit = units[0] if units else crs
    return float(UNIT_MM.get(unit or "", 1.0))


def shader_id(name: str) -> str:
    """An attribute's shader id, as the Zarr Vectors plugin makes it (colour_shader.ts attributeShaderId)."""
    if name.startswith("obj:"):
        name = f"obj_{name[4:]}"
    base = re.sub(r"[^a-zA-Z0-9_]", "_", name)
    if not re.match(r"[a-z]", base):
        base = f"a_{base}"
    return re.sub(r"__+", "_", base)


def _hash_colours(ids: np.ndarray) -> np.ndarray:
    """A colour per id: hues spread by the golden ratio, as the platform's palette."""
    h = (np.asarray(ids, np.float64) * 0.61803398875) % 1.0
    c = np.clip(np.abs(np.mod(h[:, None] * 6.0 + np.array([0.0, 4.0, 2.0]), 6.0) - 3.0) - 1.0, 0.0, 1.0)
    return (0.25 + 0.75 * c).astype(np.float32)


def load(url: str, budget: int = 4_000_000, radius_mm: float | None = None, level: int | None = None,
         progress: Callable[[float, str], None] | None = None, attributes: list[str] | None = None) -> Surfaces:
    """The store's geometry at the finest level of at most `budget` vertices (or `level`), as surfaces.
    radius_mm: tubes' and points' radius (default: a store's `radius` attribute, else 0.2% of its size).
    attributes: the vertex attributes to read beside it (shader ids, as a look names them); no others are
    read (a store may hold hundreds: a gene panel)."""
    import zarr_vectors as zv

    say = progress or (lambda f, m: None)
    base = store_url(url)
    ds = zv.open(base)
    levels = _levels(ds, base)
    if level is None:
        fits = [k for k, n in levels if 0 < n <= budget]
        level = fits[0] if fits else (levels[-1][0] if levels else 0)
    say(0.1, f"reading level {level} of {base.rstrip('/').split('/')[-1]}")
    try:
        held = list(ds.level(int(level)).attribute_names())
    except Exception:  # noqa: BLE001 - a store that cannot list them: none read by name
        held = []
    by_id = {shader_id(n): n for n in held}
    wanted = sorted({by_id[a] for a in (attributes or []) if a in by_id} | ({"radius"} & set(held)))
    r = ds.read(level=int(level), attributes=wanted)
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
    values = {shader_id(n): np.asarray(attrs[n], np.float64).reshape(len(pos), -1)[:, 0] for n in names if n != "radius" and len(np.asarray(attrs[n]).ravel()) >= len(pos)}

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
        vertex = a
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
        vertex = e[:, 0]
        vobj = np.asarray(r.object_ids).ravel() if r.object_ids is not None and len(np.asarray(r.object_ids)) == len(pos) else np.zeros(len(pos), np.int64)
        uniq, inv = np.unique(vobj[e[:, 0]], return_inverse=True)
        colours, objects = _hash_colours(uniq), inv.astype(np.int32)
        meta["edges"] = int(len(prims))
    elif kind == "mesh":
        # Polygon faces fanned into triangles; a volume mesh's cells (`element`) as their surface.
        element = _element(base, int(level))
        raw = np.asarray(r.faces if r.faces is not None else np.zeros((0, 3)), np.int64)
        if element in ELEMENT_FACES:
            f = boundary_triangles(raw, element)
            meta["element"] = element
            meta["cells"] = int(len(raw))
        elif element is not None:
            raise ValueError(f"the store's cells are {element!r} elements, which cannot be drawn (tetra, pyramid, wedge and hexahedron can)")
        else:
            f = fan(raw if raw.ndim == 2 else raw.reshape(-1, 3))
        prims = pos[f].reshape(-1, 9).astype(np.float32)
        kinds = np.full(len(prims), geometry.TRIANGLE, np.int32)
        vertex = f[:, 0]
        vobj = np.asarray(r.object_ids).ravel() if r.object_ids is not None and len(np.asarray(r.object_ids)) == len(pos) else np.zeros(len(pos), np.int64)
        uniq, inv = np.unique(vobj[f[:, 0]], return_inverse=True)
        colours, objects = _hash_colours(uniq), inv.astype(np.int32)
        meta["triangles"] = int(len(prims))
    else:  # point_cloud
        rad = per_vertex_r if per_vertex_r is not None else radius
        prims = geometry.spheres(pos, rad)
        kinds = np.full(len(prims), geometry.SPHERE, np.int32)
        vertex = np.arange(len(pos))
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
    meta["attributes"] = sorted(values)
    return Surfaces(prims, kinds, objects, colours, meta, vertex, values)


def _palette(groups: np.ndarray) -> np.ndarray:
    """Each group's palette colour, as the Colour by shader's zvPalette draws it."""
    k = np.floor(np.asarray(groups, np.float64) + 0.5)
    h = (k * 0.61803398875) % 1.0
    c = np.clip(np.abs(np.mod(h[:, None] * 6.0 + np.array([0.0, 4.0, 2.0]), 6.0) - 3.0) - 1.0, 0.0, 1.0)
    light = np.where(np.mod(k, 2.0) < 1.0, 0.75, 0.55)[:, None]
    dim = np.where(np.mod(np.floor(k / 2.0), 2.0) < 1.0, 1.0, 0.8)[:, None]
    return ((1.0 + (c - 1.0) * light) * dim).astype(np.float32)


def colour(s: Surfaces, look: dict | None) -> tuple[np.ndarray, np.ndarray | None]:
    """Each primitive's colour (n, 3) and whether it is hidden ((n,) uint8, or None: none is), as `look`
    colours the layer: by group ({"by": "group", "group": {"attribute", "colorAttribute", "colours":
    "stored" | "palette", "shown"}}) or by attribute ({"by": "attribute", "attribute", "lut": colours evenly
    over 0..1, "low", "high", "hideOutside"}); the store's own colours otherwise, or where the attributes
    the look names were not read."""
    own = s.colours[s.objects] if len(s.colours) else np.ones((len(s.prims), 3), np.float32)
    look = look or {}
    at = (lambda v: v[s.vertex]) if s.vertex is not None else (lambda v: v[: len(s.prims)])
    if look.get("by") == "group" and isinstance(look.get("group"), dict):
        g = look["group"]
        if g.get("attribute") not in s.values:
            return own, None
        groups = np.floor(at(s.values[g["attribute"]]) + 0.5)
        packed = s.values.get(g.get("colorAttribute") or "") if g.get("colours") == "stored" else None
        if packed is not None:
            v = np.floor(at(packed) + 0.5).astype(np.int64)
            out = (np.stack([(v >> 16) & 255, (v >> 8) & 255, v & 255], 1) / 255.0).astype(np.float32)
        else:
            out = _palette(groups)
        shown = g.get("shown")
        hide = None if shown is None else (~np.isin(groups, np.asarray(shown, np.float64))).astype(np.uint8)
        return out, hide
    if look.get("by") == "attribute" and look.get("attribute") in s.values:
        v = at(s.values[look["attribute"]])
        lut = np.asarray(look.get("lut") or [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]], np.float64).reshape(-1, 3)
        lo, hi = float(look.get("low", np.nanmin(v) if len(v) else 0.0)), float(look.get("high", np.nanmax(v) if len(v) else 1.0))
        t = np.clip((v - lo) / max(hi - lo, 1e-12), 0.0, 1.0)
        t = np.nan_to_num(t, nan=0.0) * (len(lut) - 1)
        i = np.minimum(np.floor(t).astype(np.int64), len(lut) - 2) if len(lut) > 1 else np.zeros(len(t), np.int64)
        f = (t - i)[:, None]
        out = (lut[i] * (1.0 - f) + lut[np.minimum(i + 1, len(lut) - 1)] * f).astype(np.float32)
        hide = (~((v >= lo) & (v <= hi))).astype(np.uint8) if look.get("hideOutside") else None
        return out, hide
    return own, None
