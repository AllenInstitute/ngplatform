"""Volume meshes (format 0.10's `element`) as the path tracer's surfaces (vectors.py): their cells' boundary,
wound outward, from the stores the Zarr Vectors plugin's tests use too (plugins/zarr-vectors/testdata,
written by zarr-vectors-py with volume elements: a cube of 162 tetrahedra, in one chunk and in 2 x 2 x 2).
No GPU: only reading. Skipped where zarr_vectors cannot read format 0.10."""

from __future__ import annotations

import json

import numpy as np
import pytest

from helpers import RUNNER

from ngplatform_render import geometry, vectors  # noqa: E402

zv = pytest.importorskip("zarr_vectors")
DATA = RUNNER.parent / "plugins" / "zarr-vectors" / "testdata"
EXPECTED = json.loads((DATA / "volume_tets.json").read_text())


def _readable(store: str) -> bool:
    try:
        zv.open(str(DATA / store) + "/").read(level=0)
    except Exception:  # noqa: BLE001 - a zarr_vectors without format 0.10
        return False
    return True


def _named(triangles: np.ndarray) -> set[str]:
    """Triangles (n, 9) as their corners' positions, from the least corner on (the winding kept)."""
    out = set()
    for t in np.asarray(triangles, np.float64).reshape(-1, 3, 3):
        s = [" ".join(f"{x:.4f}" for x in p) for p in t]
        at = min(range(3), key=lambda i: s[i])
        out.add(" | ".join(s[(at + k) % 3] for k in range(3)))
    return out


PYTHON = _named(np.array([[EXPECTED["vertices"][v] for v in f] for faces in EXPECTED["boundary"] for f in faces]))


@pytest.mark.parametrize("store", ["volume_tets1.zarrvectors", "volume_tets2.zarrvectors"])
def test_drawn_as_the_boundary_zarr_vectors_gives(store):
    if not _readable(store):
        pytest.skip("this zarr_vectors does not read format 0.10")
    s = vectors.load(str(DATA / store))
    assert s.meta["element"] == "tetra" and s.meta["cells"] == 162
    assert (s.kinds == geometry.TRIANGLE).all()
    # (The store's unit is the millimetre, so positions are as written.)
    assert _named(s.prims) == PYTHON
    assert len(s.prims) == len(PYTHON)


def test_each_element_wound_outward():
    corners = {
        "tetra": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
        "pyramid": [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1]],
        "wedge": [[0, 0, 0], [0, 1, 0], [1, 0, 0], [0, 0, 1], [0, 1, 1], [1, 0, 1]],
        "hexahedron": [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    }
    for element, pts in corners.items():
        p = np.array(pts, np.float64)
        tris = vectors.boundary_triangles(np.arange(len(p))[None], element)
        a, b, c = p[tris[:, 0]], p[tris[:, 1]], p[tris[:, 2]]
        outward = np.einsum("ij,ij->i", np.cross(b - a, c - a), a - p.mean(0))
        assert (outward > 0).all(), element
        # Two cells on one face: that face is inside, not drawn.
    two = vectors.boundary_triangles(np.array([[0, 1, 2, 3], [0, 2, 1, 4]]), "tetra")
    assert len(two) == 6 and not any(sorted(t) == [0, 1, 2] for t in two.tolist())


def test_polygon_faces_are_fanned():
    quads = np.array([[0, 1, 2, 3]])
    assert vectors.fan(quads).tolist() == [[0, 1, 2], [0, 2, 3]]
    assert vectors.fan(np.array([[4, 5, 6]])).tolist() == [[4, 5, 6]]
