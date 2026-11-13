"""Geometry on the GPU for the path tracer: triangles, round cones (a tube between two points, a radius at
each: a streamline's or a skeleton's segment) and spheres (a point), in a linear BVH (Karras 2012) built
in parallel, and the device functions that trace a ray through it.

Build: each primitive's centre gets a 30-bit Morton code in the scene's box; the codes (with the
primitive's index below them, so equal codes stay distinct) are sorted; each internal node finds its range
and split from the common prefixes of its neighbours' keys (one thread a node); then each leaf walks up,
and the second child to arrive at a node writes its box (an atomic counter per node).  Nodes 0..n-2 are
internal (0 the root), n-1..2n-2 the leaves in sorted order.

Layout on the GPU (what GEOMETRY_SOURCE reads):
  tris   float32 (n, 9): the primitives, sorted as the leaves are: a triangle's corners; a round cone's
         a xyz, its radius there, b xyz, its radius there (and a 0); a sphere's centre and radius (and 0s)
  kind   int32 (n): each sorted primitive's kind, TRIANGLE, CONE or SPHERE (or none: all triangles)
  tobj   int32 (n): each sorted primitive's object (an index into the objects' colours)
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

// cent: each primitive's centre (its box's), 3 floats.
extern "C" __global__ void morton(const float* cent, int n, const float* lo, const float* inv, u64* keys) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  const float* t = cent + 3 * i;
  unsigned int c[3];
  for (int a = 0; a < 3; ++a) {
    float m = t[a];
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

// pbox: each sorted primitive's box (lo xyz, hi xyz).
extern "C" __global__ void boxes(const float* pbox, const int* kids, const int* parent, int n, float* nodes, int* flags) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  int node = n - 1 + i;
  const float* t = pbox + 6 * i;
  float* b = nodes + 6 * node;
  for (int a = 0; a < 6; ++a) b[a] = t[a];
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
#define GEO_TRIANGLE 0
#define GEO_CONE 1
#define GEO_SPHERE 2
struct Geo {
  const float* tris;   // sorted primitives, 9 floats each
  const int* kind;     // each sorted primitive's kind, or null: all triangles
  const int* tobj;     // each sorted primitive's object
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

__device__ __forceinline__ int geokind(const Geo& G, int i) { return G.kind == 0 ? GEO_TRIANGLE : G.kind[i]; }

// A sphere (centre c, radius r): the ray's entry (o, unit direction d), else -1 (from inside: its exit).
__device__ __forceinline__ float spherehit(V3 c, float r, V3 o, V3 d) {
  V3 oc = o - c;
  float b = dot3(oc, d), h = b * b - (dot3(oc, oc) - r * r);
  if (h < 0.f) return -1.f;
  h = sqrtf(h);
  float t = -b - h;
  return t > 0.f ? t : -b + h;
}

// A round cone (a tube from a, radius ra, to b, radius rb, with round ends; Quilez's intersector): the ray's
// entry (o, unit direction d), else -1.
__device__ float conehit(V3 pa, float ra, V3 pb, float rb, V3 o, V3 d) {
  V3 ba = pb - pa, oa = o - pa, ob = o - pb;
  float rr = ra - rb, m0 = dot3(ba, ba), m1 = dot3(ba, oa), m2 = dot3(ba, d), m3 = dot3(d, oa);
  float m5 = dot3(oa, oa), m6 = dot3(ob, d), m7 = dot3(ob, ob);
  float d2 = m0 - rr * rr;
  float k2 = d2 - m2 * m2, k1 = d2 * m3 - m1 * m2 + m2 * rr * ra, k0 = d2 * m5 - m1 * m1 + m1 * rr * ra * 2.f - m0 * ra * ra;
  float h = k1 * k1 - k0 * k2;
  if (h < 0.f) return -1.f;
  float t = (-sqrtf(h) - k1) / k2;
  float y = m1 - ra * rr + t * m2;
  if (y > 0.f && y < d2) return t;
  float best = 1e30f;
  float h1 = m3 * m3 - m5 + ra * ra, h2 = m6 * m6 - m7 + rb * rb;
  if (h1 > 0.f) best = -m3 - sqrtf(h1);
  if (h2 > 0.f) best = fminf(best, -m6 - sqrtf(h2));
  return best < 1e29f ? best : -1.f;
}

// Primitive i's entry along the ray (o, direction d, any length: distances in its units), or -1.
__device__ __forceinline__ float primhit(const Geo& G, int i, V3 o, V3 d) {
  int k = geokind(G, i);
  if (k == GEO_TRIANGLE) return trihit(G, i, o, d);
  const float* t = G.tris + 9 * i;
  float len = sqrtf(dot3(d, d));
  V3 u = d * (1.f / fmaxf(len, 1e-30f));
  float s = k == GEO_SPHERE ? spherehit(v3(t[0], t[1], t[2]), t[3], o, u) : conehit(v3(t[0], t[1], t[2]), t[3], v3(t[4], t[5], t[6]), t[7], o, u);
  return s < 0.f ? -1.f : s / fmaxf(len, 1e-30f);
}

// A round cone's signed distance at p (Quilez's sdRoundCone).
__device__ float conedist(V3 p, V3 a, float r1, V3 b, float r2) {
  V3 ba = b - a;
  float l2 = dot3(ba, ba), rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1.f / l2;
  V3 pa = p - a;
  float y = dot3(pa, ba), z = y - l2;
  V3 xv = pa * l2 - ba * y;
  float x2 = dot3(xv, xv), y2 = y * y * l2, z2 = z * z * l2;
  float k = (rr > 0.f ? 1.f : rr < 0.f ? -1.f : 0.f) * rr * rr * x2;
  if ((z > 0.f ? 1.f : -1.f) * a2 * z2 > k) return sqrtf(x2 + z2) * il2 - r2;
  if ((y > 0.f ? 1.f : -1.f) * a2 * y2 < k) return sqrtf(x2 + y2) * il2 - r1;
  return (sqrtf(x2 * a2 * il2) + y * rr) * il2 - r1;
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
    float t = primhit(G, 0, o, d);
    if (t > tmin && t < best) { *tri = 0; return t; }
    return -1.f;
  }
  if (!nodehit(G, 0, o, inv, best, &tin)) return -1.f;
  stack[sp++] = 0;
  while (sp > 0) {
    int k = stack[--sp];
    if (k >= n - 1) {
      int i = k - (n - 1);
      float t = primhit(G, i, o, d);
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

// Primitive i's unit normal at p on it: a triangle's as wound; a sphere's or a round cone's outwards.
__device__ V3 geonormal(const Geo& G, int i, V3 p) {
  int k = geokind(G, i);
  if (k == GEO_TRIANGLE) return trinormal(G, i);
  const float* t = G.tris + 9 * i;
  if (k == GEO_SPHERE) return norm3(p - v3(t[0], t[1], t[2]));
  V3 a = v3(t[0], t[1], t[2]), b = v3(t[4], t[5], t[6]);
  float e = 1e-3f * fmaxf(t[3] + t[7], 1e-12f);
  return norm3(v3(conedist(p + v3(e, 0.f, 0.f), a, t[3], b, t[7]) - conedist(p - v3(e, 0.f, 0.f), a, t[3], b, t[7]),
                  conedist(p + v3(0.f, e, 0.f), a, t[3], b, t[7]) - conedist(p - v3(0.f, e, 0.f), a, t[3], b, t[7]),
                  conedist(p + v3(0.f, 0.f, e), a, t[3], b, t[7]) - conedist(p - v3(0.f, 0.f, e), a, t[3], b, t[7])));
}
"""


TRIANGLE, CONE, SPHERE = 0, 1, 2


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
    kind: object = None  # None: all triangles

    def nbytes(self) -> int:
        return int(self.tris.nbytes + self.tobj.nbytes + self.nodes.nbytes + self.kids.nbytes + (self.kind.nbytes if self.kind is not None else 0))


_mod = None


def _kernels():
    global _mod
    import cupy as cp

    if _mod is None:
        _mod = cp.RawModule(code=_BUILD, options=("--std=c++14",))
    return _mod


def boxes_of(prims: np.ndarray, kinds: np.ndarray | None) -> np.ndarray:
    """Each primitive's box (n, 6): lo xyz, hi xyz."""
    p = prims.reshape(-1, 9)
    tri = p[:, :9].reshape(-1, 3, 3)
    out = np.concatenate([tri.min(1), tri.max(1)], 1)
    if kinds is not None:
        cone = kinds == CONE
        if cone.any():
            a, ra, b, rb = p[cone, 0:3], p[cone, 3:4], p[cone, 4:7], p[cone, 7:8]
            out[cone] = np.concatenate([np.minimum(a - ra, b - rb), np.maximum(a + ra, b + rb)], 1)
        sph = kinds == SPHERE
        if sph.any():
            c, r = p[sph, 0:3], p[sph, 3:4]
            out[sph] = np.concatenate([c - r, c + r], 1)
    return out.astype(np.float32)


def cones(starts: np.ndarray, ends: np.ndarray, r0, r1=None) -> np.ndarray:
    """Round cones (n, 9) from segment starts and ends (n, 3) and their radii (a number, or one a segment)."""
    n = len(starts)
    r0 = np.broadcast_to(np.asarray(r0, np.float32), (n,))
    r1 = r0 if r1 is None else np.broadcast_to(np.asarray(r1, np.float32), (n,))
    return np.concatenate([starts, r0[:, None], ends, r1[:, None], np.zeros((n, 1))], 1).astype(np.float32)


def spheres(centres: np.ndarray, r) -> np.ndarray:
    """Spheres (n, 9) from centres (n, 3) and radii (a number, or one a sphere)."""
    n = len(centres)
    r = np.broadcast_to(np.asarray(r, np.float32), (n,))
    return np.concatenate([centres, r[:, None], np.zeros((n, 5))], 1).astype(np.float32)


def build(tris: np.ndarray, objects: np.ndarray | None = None, device: int | None = None, kinds: np.ndarray | None = None) -> Bvh:
    """A BVH over primitives (n, 9), float32, in world units: triangles ((n, 3, 3) too), or of `kinds`
    (TRIANGLE, CONE, SPHERE, as cones() and spheres() lay them out); objects: each primitive's object."""
    import cupy as cp

    t = np.ascontiguousarray(np.asarray(tris, np.float32).reshape(-1, 9))
    n = len(t)
    obj = np.zeros(n, np.int32) if objects is None else np.ascontiguousarray(objects, np.int32)
    kk = None if kinds is None or not np.any(np.asarray(kinds) != TRIANGLE) else np.ascontiguousarray(kinds, np.int32)
    pbox = boxes_of(t, kk)
    with cp.cuda.Device(device if device is not None else cp.cuda.runtime.getDevice()):
        m = _kernels()
        T = cp.asarray(t)
        lo, hi = pbox[:, :3].min(0), pbox[:, 3:].max(0)
        ext = np.maximum(hi - lo, 1e-12)
        th = 256
        keys = cp.empty(n, cp.uint64)
        cent = cp.asarray(((pbox[:, :3] + pbox[:, 3:]) / 2).astype(np.float32))
        m.get_function("morton")(((n + th - 1) // th,), (th,), (cent, np.int32(n), cp.asarray(lo, cp.float32), cp.asarray(1.0 / ext, cp.float32), keys))
        order = cp.argsort(keys)
        keys = keys[order]
        T = T[order]
        O = cp.asarray(obj)[order]
        K = cp.asarray(kk)[order] if kk is not None else None
        B = cp.asarray(pbox)[order]
        kids = cp.zeros((max(n - 1, 1), 2), cp.int32)
        parent = cp.full(max(2 * n - 1, 1), -1, cp.int32)
        if n > 1:
            m.get_function("karras")(((n - 1 + th - 1) // th,), (th,), (keys, np.int32(n), kids, parent))
        nodes = cp.zeros((max(2 * n - 1, 1), 6), cp.float32)
        flags = cp.zeros(max(n - 1, 1), cp.int32)
        m.get_function("boxes")(((n + th - 1) // th,), (th,), (B, kids, parent, np.int32(n), nodes, flags))
        cp.cuda.Device().synchronize()
    return Bvh(T, O, nodes, kids, n, lo, hi, K)
