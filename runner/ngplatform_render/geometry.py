"""Triangles on the GPU for the path tracer: a linear BVH (Karras 2012) built in parallel, and the device
functions that trace a ray through it.

Build: each triangle's centroid gets a 30-bit Morton code in the scene's box; the codes (with the
triangle's index below them, so equal codes stay distinct) are sorted; each internal node finds its range
and split from the common prefixes of its neighbours' keys (one thread a node); then each leaf walks up,
and the second child to arrive at a node writes its box (an atomic counter per node).  Nodes 0..n-2 are
internal (0 the root), n-1..2n-2 the leaves in sorted order.

Layout on the GPU (what GEOMETRY_SOURCE reads):
  tris   float32 (n, 9): the triangles' corners, sorted as the leaves are
  tobj   int32 (n): each sorted triangle's object (an index into the objects' colours)
  nodes  float32 (2n-1, 6): each node's box (lo xyz, hi xyz)
  kids   int32 (n-1, 2): each internal node's children (node indices)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

_BUILD = r"""
typedef unsigned long long u64;

__device__ __forceinline__ unsigned int expand10(unsigned int v) {
  v = (v * 0x00010001u) & 0xFF0000FFu;
  v = (v * 0x00000101u) & 0x0F00F00Fu;
  v = (v * 0x00000011u) & 0xC30C30C3u;
  v = (v * 0x00000005u) & 0x49249249u;
  return v;
}

extern "C" __global__ void morton(const float* tris, int n, const float* lo, const float* inv, u64* keys) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  const float* t = tris + 9 * i;
  unsigned int c[3];
  for (int a = 0; a < 3; ++a) {
    float m = (t[a] + t[3 + a] + t[6 + a]) * (1.f / 3.f);
    float u = fminf(fmaxf((m - lo[a]) * inv[a], 0.f), 1.f);
    c[a] = min((unsigned int)(u * 1024.f), 1023u);
  }
  unsigned int code = (expand10(c[0]) << 2) | (expand10(c[1]) << 1) | expand10(c[2]);
  keys[i] = ((u64)code << 32) | (u64)i;
}

__device__ __forceinline__ int delta(const u64* k, int n, int i, int j) {
  if (j < 0 || j >= n) return -1;
  return __clzll(k[i] ^ k[j]);
}

extern "C" __global__ void karras(const u64* k, int n, int* kids, int* parent) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n - 1) return;
  int d = (delta(k, n, i, i + 1) - delta(k, n, i, i - 1)) >= 0 ? 1 : -1;
  int dmin = delta(k, n, i, i - d);
  int lmax = 2;
  while (delta(k, n, i, i + lmax * d) > dmin) lmax *= 2;
  int l = 0;
  for (int t = lmax / 2; t >= 1; t /= 2)
    if (delta(k, n, i, i + (l + t) * d) > dmin) l += t;
  int j = i + l * d;
  int dnode = delta(k, n, i, j);
  int s = 0;
  for (int t = (l + 1) / 2;; t = (t + 1) / 2) {
    if (delta(k, n, i, i + (s + t) * d) > dnode) s += t;
    if (t == 1) break;
  }
  int g = i + s * d + min(d, 0);
  int left = (min(i, j) == g) ? (n - 1 + g) : g;
  int right = (max(i, j) == g + 1) ? (n - 1 + g + 1) : g + 1;
  kids[2 * i] = left;
  kids[2 * i + 1] = right;
  parent[left] = i;
  parent[right] = i;
}

extern "C" __global__ void boxes(const float* tris, const int* kids, const int* parent, int n, float* nodes, int* flags) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  int node = n - 1 + i;
  const float* t = tris + 9 * i;
  float* b = nodes + 6 * node;
  for (int a = 0; a < 3; ++a) {
    b[a] = fminf(t[a], fminf(t[3 + a], t[6 + a]));
    b[3 + a] = fmaxf(t[a], fmaxf(t[3 + a], t[6 + a]));
  }
  if (n == 1) return;
  int p = parent[node];
  while (p >= 0) {
    __threadfence();
    if (atomicAdd(flags + p, 1) == 0) return;  // the first child to arrive: the other writes the box
    const float* l = nodes + 6 * kids[2 * p];
    const float* r = nodes + 6 * kids[2 * p + 1];
    float* o = nodes + 6 * p;
    for (int a = 0; a < 3; ++a) {
      o[a] = fminf(l[a], r[a]);
      o[3 + a] = fmaxf(l[3 + a], r[3 + a]);
    }
    __threadfence();
    p = p == 0 ? -1 : parent[p];
  }
}
"""

# The vector type and operators GEOMETRY_SOURCE needs, for modules that do not have kernels.SOURCE's.
V3_PRELUDE = r"""
struct V3 { float x, y, z; };
__device__ __forceinline__ V3 v3(float x, float y, float z) { V3 r; r.x = x; r.y = y; r.z = z; return r; }
__device__ __forceinline__ V3 operator+(V3 a, V3 b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
__device__ __forceinline__ V3 operator-(V3 a, V3 b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
__device__ __forceinline__ V3 operator*(V3 a, float s) { return v3(a.x * s, a.y * s, a.z * s); }
__device__ __forceinline__ float dot3(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
__device__ __forceinline__ V3 cross3(V3 a, V3 b) { return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
__device__ __forceinline__ V3 norm3(V3 a) { float l = sqrtf(dot3(a, a)); return l > 0.f ? a * (1.f / l) : v3(0.f, 0.f, 1.f); }
"""

# Device code the tracer includes (needs V3 and its operators, defined before it in kernels.SOURCE).
GEOMETRY_SOURCE = r"""
struct Geo {
  const float* tris;   // sorted triangles, 9 floats each
  const int* tobj;     // each sorted triangle's object
  const float* nodes;  // boxes, 6 floats a node
  const int* kids;     // internal nodes' children
  int n;               // triangles (0: none)
};

// Möller-Trumbore: the distance along the ray to triangle i, or -1.
__device__ __forceinline__ float trihit(const Geo& G, int i, V3 o, V3 d) {
  const float* t = G.tris + 9 * i;
  V3 a = v3(t[0], t[1], t[2]), e1 = v3(t[3] - t[0], t[4] - t[1], t[5] - t[2]), e2 = v3(t[6] - t[0], t[7] - t[1], t[8] - t[2]);
  V3 p = cross3(d, e2);
  float det = dot3(e1, p);
  if (fabsf(det) < 1e-20f) return -1.f;
  float inv = 1.f / det;
  V3 s = o - a;
  float u = dot3(s, p) * inv;
  if (u < 0.f || u > 1.f) return -1.f;
  V3 q = cross3(s, e1);
  float v = dot3(d, q) * inv;
  if (v < 0.f || u + v > 1.f) return -1.f;
  return dot3(e2, q) * inv;
}

// The ray's entry and exit of node k's box, slabs with the direction's inverse.
__device__ __forceinline__ bool nodehit(const Geo& G, int k, V3 o, V3 inv, float tmax, float* tin) {
  const float* b = G.nodes + 6 * k;
  float tx0 = (b[0] - o.x) * inv.x, tx1 = (b[3] - o.x) * inv.x;
  float ty0 = (b[1] - o.y) * inv.y, ty1 = (b[4] - o.y) * inv.y;
  float tz0 = (b[2] - o.z) * inv.z, tz1 = (b[5] - o.z) * inv.z;
  float t0 = fmaxf(fmaxf(fminf(tx0, tx1), fminf(ty0, ty1)), fmaxf(fminf(tz0, tz1), 0.f));
  float t1 = fminf(fminf(fmaxf(tx0, tx1), fmaxf(ty0, ty1)), fminf(fmaxf(tz0, tz1), tmax));
  *tin = t0;
  return t0 <= t1;
}

// The nearest triangle the ray (origin o, unit direction d) meets in (tmin, tmax): its distance, and its
// sorted index in *tri; -1 when none.
__device__ float geohit(const Geo& G, V3 o, V3 d, float tmin, float tmax, int* tri) {
  if (G.n <= 0) return -1.f;
  V3 inv = v3(1.f / (fabsf(d.x) > 1e-20f ? d.x : 1e-20f), 1.f / (fabsf(d.y) > 1e-20f ? d.y : 1e-20f),
              1.f / (fabsf(d.z) > 1e-20f ? d.z : 1e-20f));
  float best = tmax;
  int hit = -1;
  int stack[64];
  int sp = 0;
  int n = G.n;
  float tin;
  if (n == 1) {
    float t = trihit(G, 0, o, d);
    if (t > tmin && t < best) { *tri = 0; return t; }
    return -1.f;
  }
  if (!nodehit(G, 0, o, inv, best, &tin)) return -1.f;
  stack[sp++] = 0;
  while (sp > 0) {
    int k = stack[--sp];
    if (k >= n - 1) {
      int i = k - (n - 1);
      float t = trihit(G, i, o, d);
      if (t > tmin && t < best) { best = t; hit = i; }
      continue;
    }
    int l = G.kids[2 * k], r = G.kids[2 * k + 1];
    float tl, tr;
    bool hl = nodehit(G, l, o, inv, best, &tl), hr = nodehit(G, r, o, inv, best, &tr);
    if (hl && hr) {
      // The nearer child on top, so it is searched first and narrows `best` for the other.
      if (tl < tr) { stack[sp++] = r; stack[sp++] = l; } else { stack[sp++] = l; stack[sp++] = r; }
    } else if (hl) {
      stack[sp++] = l;
    } else if (hr) {
      stack[sp++] = r;
    }
    if (sp > 62) sp = 62;  // a degenerate tree deeper than the stack: drop rather than overrun
  }
  if (hit < 0) return -1.f;
  *tri = hit;
  return best;
}

// Triangle i's unit normal (as wound: (b - a) x (c - a)).
__device__ __forceinline__ V3 trinormal(const Geo& G, int i) {
  const float* t = G.tris + 9 * i;
  return norm3(cross3(v3(t[3] - t[0], t[4] - t[1], t[5] - t[2]), v3(t[6] - t[0], t[7] - t[1], t[8] - t[2])));
}
"""


@dataclass
class Bvh:
    """A BVH on the GPU (cupy arrays), as the module's docstring lays it out."""

    tris: object
    tobj: object
    nodes: object
    kids: object
    n: int
    lo: np.ndarray
    hi: np.ndarray

    def nbytes(self) -> int:
        return int(self.tris.nbytes + self.tobj.nbytes + self.nodes.nbytes + self.kids.nbytes)


_mod = None


def _kernels():
    global _mod
    import cupy as cp

    if _mod is None:
        _mod = cp.RawModule(code=_BUILD, options=("--std=c++14",))
    return _mod


def build(tris: np.ndarray, objects: np.ndarray | None = None, device: int | None = None) -> Bvh:
    """A BVH over triangles (n, 3, 3) or (n, 9), float32, in world units; objects: each triangle's object."""
    import cupy as cp

    t = np.ascontiguousarray(np.asarray(tris, np.float32).reshape(-1, 9))
    n = len(t)
    obj = np.zeros(n, np.int32) if objects is None else np.ascontiguousarray(objects, np.int32)
    with cp.cuda.Device(device if device is not None else cp.cuda.runtime.getDevice()):
        m = _kernels()
        T = cp.asarray(t)
        pts = t.reshape(-1, 3)
        lo, hi = pts.min(0), pts.max(0)
        ext = np.maximum(hi - lo, 1e-12)
        th = 256
        keys = cp.empty(n, cp.uint64)
        m.get_function("morton")(((n + th - 1) // th,), (th,), (T, np.int32(n), cp.asarray(lo, cp.float32), cp.asarray(1.0 / ext, cp.float32), keys))
        order = cp.argsort(keys)
        keys = keys[order]
        T = T[order]
        O = cp.asarray(obj)[order]
        kids = cp.zeros((max(n - 1, 1), 2), cp.int32)
        parent = cp.full(max(2 * n - 1, 1), -1, cp.int32)
        if n > 1:
            m.get_function("karras")(((n - 1 + th - 1) // th,), (th,), (keys, np.int32(n), kids, parent))
        nodes = cp.zeros((max(2 * n - 1, 1), 6), cp.float32)
        flags = cp.zeros(max(n - 1, 1), cp.int32)
        m.get_function("boxes")(((n + th - 1) // th,), (th,), (T, kids, parent, np.int32(n), nodes, flags))
        cp.cuda.Device().synchronize()
    return Bvh(T, O, nodes, kids, n, lo, hi)
