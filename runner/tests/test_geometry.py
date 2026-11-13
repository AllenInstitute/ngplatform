"""The triangle BVH (geometry.py): built on the GPU, every ray's nearest hit as brute force finds it, on
random triangles and on a closed mesh (a sphere), where a ray from outside crosses it an even number of times."""

from __future__ import annotations

import numpy as np
import pytest

import helpers  # noqa: F401 - puts the runner on the path

cp = pytest.importorskip("cupy")
try:
    cp.cuda.runtime.getDeviceCount()
except Exception:  # pragma: no cover - no GPU
    pytest.skip("no CUDA device", allow_module_level=True)

from ngplatform_render import geometry  # noqa: E402

_PRELUDE = geometry.V3_PRELUDE

_TEST = r"""
extern "C" __global__ void rays(const float* tris, const int* tobj, const float* nodes, const int* kids, int n,
                                const float* o, const float* d, int m, float* t, int* tri, int* crossings) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= m) return;
  Geo G; G.tris = tris; G.tobj = tobj; G.nodes = nodes; G.kids = kids; G.n = n;
  V3 oo = v3(o[3 * i], o[3 * i + 1], o[3 * i + 2]), dd = v3(d[3 * i], d[3 * i + 1], d[3 * i + 2]);
  int k = -1;
  t[i] = geohit(G, oo, dd, 0.f, 1e30f, &k);
  tri[i] = k;
  // Every crossing along the ray, one hit after another.
  int c = 0;
  float at = 0.f;
  for (int g = 0; g < 1000; ++g) {
    int kk;
    float h = geohit(G, oo, dd, at, 1e30f, &kk);
    if (h < 0.f) break;
    ++c;
    at = h + 1e-5f;
  }
  crossings[i] = c;
}
"""


def _trace(bvh, o, d):
    mod = cp.RawModule(code=_PRELUDE + geometry.GEOMETRY_SOURCE + _TEST)
    m = len(o)
    t, tri, cr = cp.zeros(m, cp.float32), cp.zeros(m, cp.int32), cp.zeros(m, cp.int32)
    mod.get_function("rays")(((m + 127) // 128,), (128,), (bvh.tris, bvh.tobj, bvh.nodes, bvh.kids, np.int32(bvh.n),
                                                         cp.asarray(o, cp.float32), cp.asarray(d, cp.float32), np.int32(m), t, tri, cr))
    return cp.asnumpy(t), cp.asnumpy(tri), cp.asnumpy(cr)


def _brute(tris, o, d):
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    e1, e2 = b - a, c - a
    out = np.full(len(o), -1.0)
    for i in range(len(o)):
        p = np.cross(d[i], e2)
        det = np.einsum("ij,ij->i", e1, p)
        ok = np.abs(det) > 1e-20
        inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
        s = o[i] - a
        u = np.einsum("ij,ij->i", s, p) * inv
        q = np.cross(s, e1)
        v = (q @ d[i]) * inv
        t = np.einsum("ij,ij->i", e2, q) * inv
        hit = ok & (u >= 0) & (u <= 1) & (v >= 0) & (u + v <= 1) & (t > 0)
        if hit.any():
            out[i] = t[hit].min()
    return out


def test_nearest_hits_match_brute_force_on_random_triangles():
    rng = np.random.default_rng(1)
    centres = rng.uniform(-1, 1, (3000, 1, 3))
    tris = (centres + rng.normal(0, 0.05, (3000, 3, 3))).astype(np.float32)
    bvh = geometry.build(tris)
    o = rng.uniform(-2, 2, (2000, 3))
    d = rng.normal(size=(2000, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    t, tri, _ = _trace(bvh, o, d)
    want = _brute(tris.astype(np.float64), o, d)
    hit = want > 0
    assert hit.sum() > 200
    np.testing.assert_array_equal(t > 0, hit)
    np.testing.assert_allclose(t[hit], want[hit], rtol=1e-4, atol=1e-5)
    # The triangle reported is one at that distance.
    sorted_tris = cp.asnumpy(bvh.tris).reshape(-1, 3, 3)
    for i in np.flatnonzero(hit)[:50]:
        assert abs(_brute(sorted_tris[tri[i]:tri[i] + 1].astype(np.float64), o[i:i + 1], d[i:i + 1])[0] - want[i]) < 1e-4


def _sphere(n=40):
    th = np.linspace(0, np.pi, n)
    ph = np.linspace(0, 2 * np.pi, 2 * n, endpoint=False)
    v = np.stack([np.sin(th)[:, None] * np.cos(ph), np.sin(th)[:, None] * np.sin(ph), np.cos(th)[:, None] + 0 * ph], -1).reshape(-1, 3)
    f = []
    w = 2 * n
    for i in range(n - 1):
        for j in range(w):
            a, b, c, e = i * w + j, i * w + (j + 1) % w, (i + 1) * w + j, (i + 1) * w + (j + 1) % w
            f += [(a, c, b), (b, c, e)]
    f = np.array(f)
    tris = v[f]
    keep = np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1) > 1e-9
    return tris[keep].astype(np.float32)


def test_a_ray_from_outside_crosses_a_closed_mesh_an_even_number_of_times():
    tris = _sphere()
    bvh = geometry.build(tris, np.arange(len(tris)) % 3)
    rng = np.random.default_rng(2)
    o = rng.normal(size=(500, 3))
    o *= 3 / np.linalg.norm(o, axis=1, keepdims=True)
    target = rng.uniform(-0.5, 0.5, (500, 3))
    d = target - o
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    t, _, crossings = _trace(bvh, o, d)
    assert (t > 0).all()
    assert (crossings == 2).mean() > 0.99
    # The tree's root holds every triangle.
    root = cp.asnumpy(bvh.nodes[0])
    pts = tris.reshape(-1, 3)
    np.testing.assert_allclose(root[:3], pts.min(0), atol=1e-6)
    np.testing.assert_allclose(root[3:], pts.max(0), atol=1e-6)
