"""Writes geometry_vectors.json: primitives of each kind, the BVH the render computer builds over them (CUDA,
geometry.py) and its nearest hits for fixed rays. The browser's build (plugins/anatomical-rendering/geometry/
lbvh.ts) must give the same tree and hits; test_geometry.py checks the CUDA build still does.

    python make_geometry_vectors.py   # on a machine with CUDA
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import helpers  # noqa: F401 - puts the runner on the path
from ngplatform_render import geometry

OUT = Path(__file__).with_name("geometry_vectors.json")


def inputs():
    """The primitives (unsorted), kinds, objects and rays, the same every time."""
    rng = np.random.default_rng(7)
    c = rng.uniform(-1, 1, (160, 1, 3))
    tris = (c + rng.normal(0, 0.08, (160, 3, 3))).astype(np.float32).reshape(-1, 9)
    sph = geometry.spheres(rng.uniform(-1, 1, (40, 3)).astype(np.float32), rng.uniform(0.02, 0.1, 40).astype(np.float32))
    a = rng.uniform(-1, 1, (40, 3)).astype(np.float32)
    cone = geometry.cones(a, (a + rng.normal(0, 0.15, (40, 3))).astype(np.float32), rng.uniform(0.01, 0.06, 40).astype(np.float32), rng.uniform(0.01, 0.06, 40).astype(np.float32))
    prims = np.concatenate([tris, sph, cone]).astype(np.float32)
    kinds = np.array([geometry.TRIANGLE] * 160 + [geometry.SPHERE] * 40 + [geometry.CONE] * 40, np.int32)
    # Mixed, so the sort is not the input's order.
    mix = rng.permutation(len(prims))
    prims, kinds = prims[mix], kinds[mix]
    objects = (np.arange(len(prims)) % 7).astype(np.int32)
    # Most rays aimed at a primitive (from outside the scene), the rest anywhere.
    o = rng.normal(size=(120, 3))
    o *= 2.5 / np.linalg.norm(o, axis=1, keepdims=True)
    aim = prims[rng.integers(0, len(prims), 120)][:, :3] + rng.normal(0, 0.02, (120, 3))
    d = np.where(np.arange(120)[:, None] < 100, aim - o, rng.normal(size=(120, 3)))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    return prims, kinds, objects, o.astype(np.float32), d.astype(np.float32)


def built():
    """The CUDA build and its hits, as plain arrays."""
    import cupy as cp
    from test_geometry import _trace

    prims, kinds, objects, o, d = inputs()
    bvh = geometry.build(prims, objects, kinds=kinds)
    t, prim, _ = _trace(bvh, o, d)
    n = bvh.n
    return {
        "prims": cp.asnumpy(bvh.tris).reshape(-1).tolist(),
        "kinds": cp.asnumpy(bvh.kind).tolist(),
        "objects": cp.asnumpy(bvh.tobj).tolist(),
        "nodes": cp.asnumpy(bvh.nodes).reshape(-1).tolist(),
        "kids": cp.asnumpy(bvh.kids)[: n - 1].reshape(-1).tolist(),
        "t": t.tolist(),
        "prim": prim.tolist(),
    }


def main():
    prims, kinds, objects, o, d = inputs()
    out = {
        "about": "Primitives (9 floats each: geometry.py's layout), their kinds and objects, unsorted; the render computer's BVH over them (sorted primitives, nodes, kids) and each ray's nearest hit (t, sorted index; -1 none). Written by make_geometry_vectors.py.",
        "input": {"prims": prims.reshape(-1).tolist(), "kinds": kinds.tolist(), "objects": objects.tolist(), "origins": o.reshape(-1).tolist(), "directions": d.reshape(-1).tolist()},
        "built": built(),
    }
    OUT.write_text(json.dumps(out) + "\n")
    print(f"wrote {OUT} ({len(kinds)} primitives, {len(o)} rays)")


if __name__ == "__main__":
    main()
