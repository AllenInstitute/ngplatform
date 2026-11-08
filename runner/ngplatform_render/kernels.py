"""The path tracer's CUDA kernels, and the layout of the parameter block they read.

One thread per pixel.  A pass adds one sample to every pixel of the
accumulation buffer; the image is the buffer's mean, tone-mapped.

The volume is a participating medium.  At a point x with texture value
t (the source's values scaled to 0..1), the transfer function gives a
colour and an opacity a(t); the extinction is sigma = density * a(t)
(per display unit), times a label's opacity when a label volume is
given, and 0 where x is cut away.  Free paths are sampled by delta
(Woodcock) tracking against a majorant grid: the largest sigma in each
brick of the volume, from the brick's least and greatest texture value
(Novák et al. 2018).  A collision scatters either off a surface, with
the gradient as its normal (diffuse plus a glossy lobe), or in the
volume, with a Henyey-Greenstein phase function; the probability of the
surface comes from the gradient's magnitude (Kroes et al. 2012,
"hybrid scattering").  At each collision the key light (directional)
is sampled with a shadow ray whose transmittance is estimated by ratio
tracking; the environment light is reached by paths that leave the
volume.  The key light is a delta light and the environment is never
sampled directly, so no contribution is counted twice.
"""

from __future__ import annotations

import json
from pathlib import Path

# Names of the float parameters, in order.  Vectors take consecutive slots.
_FIELDS: list[tuple[str, int]] = [(f["name"], f["size"]) for f in json.loads((Path(__file__).parent / "params.json").read_text())["fields"]]

OFFSETS: dict[str, int] = {}
_o = 0
for _name, _n in _FIELDS:
    OFFSETS[_name] = _o
    _o += _n
NPARAMS = _o

TF_SIZE = 1024

_DEFINES = "\n".join(f"#define P_{k} {v}" for k, v in OFFSETS.items())

SOURCE = (
    "#define TF_SIZE %d\n" % TF_SIZE
    + _DEFINES
    + r"""
typedef unsigned long long u64;
typedef unsigned int u32;

struct V3 { float x, y, z; };
__device__ __forceinline__ V3 v3(float x, float y, float z) { V3 r; r.x = x; r.y = y; r.z = z; return r; }
__device__ __forceinline__ V3 operator+(V3 a, V3 b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
__device__ __forceinline__ V3 operator-(V3 a, V3 b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
__device__ __forceinline__ V3 operator*(V3 a, float s) { return v3(a.x * s, a.y * s, a.z * s); }
__device__ __forceinline__ V3 operator*(V3 a, V3 b) { return v3(a.x * b.x, a.y * b.y, a.z * b.z); }
__device__ __forceinline__ float dot3(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
__device__ __forceinline__ V3 cross3(V3 a, V3 b) { return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
__device__ __forceinline__ float len3(V3 a) { return sqrtf(dot3(a, a)); }
__device__ __forceinline__ V3 norm3(V3 a) { float l = len3(a); return l > 0.f ? a * (1.f / l) : v3(0.f, 0.f, 1.f); }
__device__ __forceinline__ V3 pv(const float* P, int o) { return v3(P[o], P[o + 1], P[o + 2]); }

// PCG hash, and a per-thread stream of uniforms.
__device__ __forceinline__ u32 pcg(u32 v) {
  u32 state = v * 747796405u + 2891336453u;
  u32 word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
struct Rng { u32 s; };
__device__ __forceinline__ float rnd(Rng& r) { r.s = pcg(r.s); return (r.s >> 8) * (1.0f / 16777216.0f); }

// Homogeneous transform of (x, y, z, w) by a column-major 4x4.
__device__ __forceinline__ void mul4(const float* M, float x, float y, float z, float w, float* o) {
  for (int i = 0; i < 4; ++i) o[i] = M[i] * x + M[4 + i] * y + M[8 + i] * z + M[12 + i] * w;
}
// 3x4 row-major affine of a point / of a direction.
__device__ __forceinline__ V3 aff(const float* A, V3 p) {
  return v3(A[0] * p.x + A[1] * p.y + A[2] * p.z + A[3], A[4] * p.x + A[5] * p.y + A[6] * p.z + A[7],
            A[8] * p.x + A[9] * p.y + A[10] * p.z + A[11]);
}
__device__ __forceinline__ V3 lin(const float* A, V3 d) {
  return v3(A[0] * d.x + A[1] * d.y + A[2] * d.z, A[4] * d.x + A[5] * d.y + A[6] * d.z, A[8] * d.x + A[9] * d.y + A[10] * d.z);
}
__device__ __forceinline__ V3 lin3(const float* A, V3 d) {  // 3x3 row-major
  return v3(A[0] * d.x + A[1] * d.y + A[2] * d.z, A[3] * d.x + A[4] * d.y + A[5] * d.z, A[6] * d.x + A[7] * d.y + A[8] * d.z);
}

struct Scene {
  const float* P;
  cudaTextureObject_t vol;   // texture values 0..1, linear filtering, unnormalised coordinates
  const float* tf;           // TF_SIZE x (r, g, b, a)
  const float* maj;          // majorant per brick (extinction per display unit)
  const unsigned short* lab; // label volume (x fastest), or null
  const float* lut;          // NLUT x (r, g, b, opacity scale)
  const float* lutflags;     // NLUT x (keep-when-cut)
};

__device__ __forceinline__ float texval(const Scene& S, V3 v) {
  // v: voxel index coordinates (centre of voxel i at i); texture centres are at i + 0.5.
  return tex3D<float>(S.vol, v.x + 0.5f, v.y + 0.5f, v.z + 0.5f);
}

__device__ __forceinline__ float4 tflookup(const Scene& S, float t) {
  float f = fminf(fmaxf(t, 0.f), 1.f) * (TF_SIZE - 1);
  int i = min((int)f, TF_SIZE - 2);
  float w = f - i;
  const float* a = S.tf + 4 * i;
  return make_float4(a[0] + w * (a[4] - a[0]), a[1] + w * (a[5] - a[1]), a[2] + w * (a[6] - a[2]), a[3] + w * (a[7] - a[3]));
}

__device__ __forceinline__ bool cut(const float* P, V3 w, V3 v) {
  if (v.x < P[P_CROP_LO] || v.y < P[P_CROP_LO + 1] || v.z < P[P_CROP_LO + 2]) return true;
  if (v.x > P[P_CROP_HI] || v.y > P[P_CROP_HI + 1] || v.z > P[P_CROP_HI + 2]) return true;
  int n = (int)P[P_NCLIP];
  for (int i = 0; i < n; ++i) {
    const float* c = P + P_CLIPS + 4 * i;
    if (c[0] * w.x + c[1] * w.y + c[2] * w.z + c[3] < 0.f) return true;
  }
  return false;
}

// The medium at world point w (voxel point v): extinction, and colour in rgb.
__device__ __forceinline__ float medium(const Scene& S, V3 w, V3 v, V3* rgb) {
  const float* P = S.P;
  float t = texval(S, v);
  float4 c = tflookup(S, t);
  float sigma = P[P_DENSITY] * c.w;
  V3 col = v3(c.x, c.y, c.z);
  bool keep = false;
  if (P[P_HAS_LABELS] > 0.f) {
    V3 lv = aff(P + P_LABEL_FROM_WORLD, w);
    int ix = __float2int_rn(lv.x), iy = __float2int_rn(lv.y), iz = __float2int_rn(lv.z);
    int lx = (int)P[P_LDIMS], ly = (int)P[P_LDIMS + 1], lz = (int)P[P_LDIMS + 2];
    if (ix >= 0 && iy >= 0 && iz >= 0 && ix < lx && iy < ly && iz < lz) {
      int lab = S.lab[((u64)iz * ly + iy) * lx + ix];
      int nl = (int)P[P_NLUT];
      if (lab < nl && S.lut[4 * lab] >= 0.f) {  // a negative red: the label leaves the medium as it is
        const float* L = S.lut + 4 * lab;
        sigma *= L[3];
        keep = S.lutflags[lab] > 0.f;
      }
      if (rgb) {
        // The colour from the 8 nearest label voxels, weighted trilinearly, so coarse labels do not show their voxels.
        float fx = floorf(lv.x), fy = floorf(lv.y), fz = floorf(lv.z);
        float wx = lv.x - fx, wy = lv.y - fy, wz = lv.z - fz;
        V3 acc = v3(0.f, 0.f, 0.f);
        float wsum = 0.f;
        for (int k = 0; k < 8; ++k) {
          int jx = (int)fx + (k & 1), jy = (int)fy + ((k >> 1) & 1), jz = (int)fz + ((k >> 2) & 1);
          if (jx < 0 || jy < 0 || jz < 0 || jx >= lx || jy >= ly || jz >= lz) continue;
          int l2 = S.lab[((u64)jz * ly + jy) * lx + jx];
          float w = ((k & 1) ? wx : 1.f - wx) * (((k >> 1) & 1) ? wy : 1.f - wy) * (((k >> 2) & 1) ? wz : 1.f - wz);
          V3 c2 = col;
          if (l2 < nl && S.lut[4 * l2] >= 0.f) c2 = v3(S.lut[4 * l2], S.lut[4 * l2 + 1], S.lut[4 * l2 + 2]);
          acc = acc + c2 * w;
          wsum += w;
        }
        if (wsum > 0.f) {
          float m = P[P_LABEL_MIX];
          col = col * (1.f - m) + acc * (m / wsum);
        }
      }
    }
  }
  if (!keep && cut(P, w, v)) sigma = 0.f;
  if (rgb) *rgb = col;
  return sigma;
}

// The ray's interval inside the volume's box [-0.5, n - 0.5] (voxel coordinates), as world distances.
__device__ __forceinline__ bool boxhit(const float* P, V3 ov, V3 dv, float* t0, float* t1) {
  float lo = 0.f, hi = 1e30f;
  float o[3] = {ov.x, ov.y, ov.z}, d[3] = {dv.x, dv.y, dv.z};
  for (int a = 0; a < 3; ++a) {
    float bmin = fmaxf(-0.5f, P[P_CROP_LO + a] - 0.5f), bmax = fminf(P[P_DIMS + a] - 0.5f, P[P_CROP_HI + a] + 0.5f);
    if (fabsf(d[a]) < 1e-12f) {
      if (o[a] < bmin || o[a] > bmax) return false;
      continue;
    }
    float inv = 1.f / d[a];
    float ta = (bmin - o[a]) * inv, tb = (bmax - o[a]) * inv;
    if (ta > tb) { float s = ta; ta = tb; tb = s; }
    lo = fmaxf(lo, ta);
    hi = fminf(hi, tb);
  }
  *t0 = lo; *t1 = hi;
  return hi > lo;
}

// Walks the majorant grid along the ray (world origin ow, unit direction dw; voxel origin ov, direction dv)
// from t0 to t1.  mode 0: delta tracking, returns the collision distance or -1 when the ray leaves.
// mode 1: ratio tracking, returns the transmittance.
__device__ float track(const Scene& S, V3 ow, V3 dw, V3 ov, V3 dv, float t0, float t1, Rng& rng, int mode) {
  const float* P = S.P;
  float B = P[P_BRICK];
  int gx = (int)P[P_MGRID], gy = (int)P[P_MGRID + 1], gz = (int)P[P_MGRID + 2];
  float T = 1.f;
  float t = t0;
  // Brick coordinates of the start (bricks start at voxel -0.5).
  V3 p = ov + dv * (t + 1e-4f);
  int c[3] = {(int)floorf((p.x + 0.5f) / B), (int)floorf((p.y + 0.5f) / B), (int)floorf((p.z + 0.5f) / B)};
  int g[3] = {gx, gy, gz};
  float d[3] = {dv.x, dv.y, dv.z}, o[3] = {ov.x, ov.y, ov.z};
  int step[3];
  float tnext[3], tdelta[3];
  for (int a = 0; a < 3; ++a) {
    c[a] = max(0, min(g[a] - 1, c[a]));
    if (d[a] > 0.f) { step[a] = 1; tnext[a] = ((c[a] + 1) * B - 0.5f - o[a]) / d[a]; tdelta[a] = B / d[a]; }
    else if (d[a] < 0.f) { step[a] = -1; tnext[a] = (c[a] * B - 0.5f - o[a]) / d[a]; tdelta[a] = -B / d[a]; }
    else { step[a] = 0; tnext[a] = 1e30f; tdelta[a] = 1e30f; }
  }
  for (int guard = 0; guard < 4096 && t < t1; ++guard) {
    int ax = (tnext[0] < tnext[1]) ? ((tnext[0] < tnext[2]) ? 0 : 2) : ((tnext[1] < tnext[2]) ? 1 : 2);
    float tend = fminf(tnext[ax], t1);
    float mj = S.maj[((u64)c[2] * gy + c[1]) * gx + c[0]];
    if (mj > 0.f) {
      for (int k = 0; k < 1024; ++k) {
        t -= logf(1.f - rnd(rng)) / mj;
        if (t >= tend) break;
        V3 w = ow + dw * t, v = ov + dv * t;
        float s = medium(S, w, v, 0);
        if (mode == 0) {
          if (rnd(rng) * mj < s) return t;
        } else {
          T *= fmaxf(0.f, 1.f - s / mj);
          if (T < 0.05f) {  // Russian roulette on low transmittance
            if (rnd(rng) < 0.5f) return 0.f;
            T *= 2.f;
          }
        }
      }
    }
    t = tend;
    if (t >= t1) break;
    c[ax] += step[ax];
    if (c[ax] < 0 || c[ax] >= g[ax]) break;
    tnext[ax] += tdelta[ax];
  }
  return mode == 0 ? -1.f : T;
}

__device__ __forceinline__ V3 envlight(const float* P, V3 d) {
  float u = dot3(d, pv(P, P_ENV_UP));
  V3 top = pv(P, P_ENV_TOP), hor = pv(P, P_ENV_HORIZON), bot = pv(P, P_ENV_BOTTOM);
  V3 c = u > 0.f ? hor * (1.f - u) + top * u : hor * (1.f + u) + bot * (-u);
  return c * P[P_ENV_SCALE];
}

__device__ __forceinline__ void basis(V3 n, V3* t, V3* b) {
  V3 a = fabsf(n.x) > 0.9f ? v3(0.f, 1.f, 0.f) : v3(1.f, 0.f, 0.f);
  *t = norm3(cross3(a, n));
  *b = cross3(n, *t);
}

__device__ __forceinline__ V3 cosdir(V3 n, Rng& r) {
  float u1 = rnd(r), u2 = rnd(r);
  float rr = sqrtf(u1), ph = 6.2831853f * u2;
  V3 t, b; basis(n, &t, &b);
  return norm3(t * (rr * cosf(ph)) + b * (rr * sinf(ph)) + n * sqrtf(fmaxf(0.f, 1.f - u1)));
}

__device__ __forceinline__ float hg(float c, float g) {
  float d = 1.f + g * g - 2.f * g * c;
  return (1.f - g * g) / (12.566371f * d * sqrtf(d));
}

// Samples a Henyey-Greenstein direction around w (the direction the light travels on).
__device__ __forceinline__ V3 hgdir(V3 w, float g, Rng& r) {
  float u1 = rnd(r), u2 = rnd(r);
  float c;
  if (fabsf(g) < 1e-3f) c = 1.f - 2.f * u1;
  else { float s = (1.f - g * g) / (1.f - g + 2.f * g * u1); c = (1.f + g * g - s * s) / (2.f * g); }
  float sn = sqrtf(fmaxf(0.f, 1.f - c * c)), ph = 6.2831853f * u2;
  V3 t, b; basis(w, &t, &b);
  return norm3(t * (sn * cosf(ph)) + b * (sn * sinf(ph)) + w * c);
}

__device__ __forceinline__ float phong_exp(float rough) { return fmaxf(1.f, 2.f / fmaxf(rough * rough, 1e-4f) - 2.f); }

// Diffuse + normalised Blinn-Phong, times cos(theta_l).
__device__ __forceinline__ V3 brdf_cos(V3 n, V3 wo, V3 wl, V3 albedo, float spec, float rough) {
  float cl = dot3(n, wl);
  if (cl <= 0.f) return v3(0.f, 0.f, 0.f);
  V3 h = norm3(wo + wl);
  float e = phong_exp(rough);
  float s = spec * (e + 8.f) / 25.132741f * powf(fmaxf(dot3(n, h), 0.f), e);
  return (albedo * ((1.f - spec) * 0.31830989f) + v3(s, s, s)) * cl;
}

__device__ __forceinline__ void ray(const float* P, int x, int y, int W, int H, float jx, float jy, Rng& rng, V3* o, V3* d, bool lens) {
  float nx = ((x + jx) / W) * 2.f - 1.f, ny = 1.f - ((y + jy) / H) * 2.f;
  float a[4], b[4];
  mul4(P + P_INVVP, nx, ny, -1.f, 1.f, a);
  mul4(P + P_INVVP, nx, ny, 1.f, 1.f, b);
  V3 n = v3(a[0] / a[3], a[1] / a[3], a[2] / a[3]);
  V3 f = v3(b[0] / b[3], b[1] / b[3], b[2] / b[3]);
  V3 dir = norm3(f - n);
  if (lens && P[P_APERTURE] > 0.f) {
    // Thin lens: the camera's centre and the point in focus along this pixel's ray.
    float e[4];
    mul4(P + P_INVVP, 0.f, 0.f, 1.f, 0.f, e);
    V3 eye = fabsf(e[3]) > 1e-12f ? v3(e[0] / e[3], e[1] / e[3], e[2] / e[3]) : n;
    float c[4];
    mul4(P + P_INVVP, 0.f, 0.f, 1.f, 1.f, c);
    V3 fwd = norm3(v3(c[0] / c[3], c[1] / c[3], c[2] / c[3]) - eye);
    float cosd = fmaxf(dot3(dir, fwd), 1e-3f);
    V3 focus = eye + dir * (P[P_FOCUS] / cosd);
    V3 t, bb; basis(fwd, &t, &bb);
    float r = P[P_APERTURE] * sqrtf(rnd(rng)), ph = 6.2831853f * rnd(rng);
    V3 lens = eye + t * (r * cosf(ph)) + bb * (r * sinf(ph));
    n = lens;
    dir = norm3(focus - lens);
  }
  *o = n; *d = dir;
}

extern "C" __global__ void trace(const float* P, cudaTextureObject_t vol, const float* tf, const float* maj,
                                 const unsigned short* lab, const float* lut, const float* lutflags,
                                 float4* accum, int W, int H) {
  int x = blockIdx.x * blockDim.x + threadIdx.x, y = blockIdx.y * blockDim.y + threadIdx.y;
  if (x >= W || y >= H) return;
  Scene S; S.P = P; S.vol = vol; S.tf = tf; S.maj = maj; S.lab = lab; S.lut = lut; S.lutflags = lutflags;
  Rng rng; rng.s = pcg((u32)(y * W + x) ^ pcg((u32)P[P_FRAME] * 9781u + 1u));
  V3 ow, dw;
  ray(P, x, y, W, H, rnd(rng), rnd(rng), rng, &ow, &dw, true);
  const float* A = P + P_VOX_FROM_WORLD;
  V3 L = v3(0.f, 0.f, 0.f), thr = v3(1.f, 1.f, 1.f);
  float alpha = 0.f;
  int maxb = (int)P[P_MAX_BOUNCES];
  V3 ldir = pv(P, P_LIGHT_DIR), lrgb = pv(P, P_LIGHT_RGB);
  for (int bounce = 0; bounce <= maxb; ++bounce) {
    V3 ov = aff(A, ow), dv = lin(A, dw);
    float t0, t1, tc = -1.f;
    if (boxhit(P, ov, dv, &t0, &t1)) tc = track(S, ow, dw, ov, dv, t0, t1, rng, 0);
    if (tc < 0.f) {
      if (bounce == 0) {
        L = pv(P, P_BG) * P[P_BG + 3];
        alpha = P[P_BG + 3];
      } else {
        L = L + thr * envlight(P, dw);
      }
      break;
    }
    if (bounce == 0) alpha = 1.f;
    V3 w = ow + dw * tc, v = ov + dv * tc;
    V3 col;
    medium(S, w, v, &col);
    V3 albedo = col * P[P_ALBEDO];
    // Gradient in voxel space, then in world space (transpose of the linear part).
    float h = 1.f;
    V3 gv = v3(texval(S, v + v3(h, 0.f, 0.f)) - texval(S, v - v3(h, 0.f, 0.f)),
               texval(S, v + v3(0.f, h, 0.f)) - texval(S, v - v3(0.f, h, 0.f)),
               texval(S, v + v3(0.f, 0.f, h)) - texval(S, v - v3(0.f, 0.f, h))) * 0.5f;
    float gm = len3(gv);
    float psurf = P[P_SHADE_MIX] * (1.f - expf(-P[P_GRAD_SCALE] * gm));
    V3 wo = dw * -1.f;
    V3 sw = w;
    // Key light: a shadow ray by ratio tracking.
    V3 lvo = aff(A, sw), lvd = lin(A, ldir);
    float s0, s1, Tl = 1.f;
    if (boxhit(P, lvo, lvd, &s0, &s1)) Tl = track(S, sw, ldir, lvo, lvd, fmaxf(s0, 0.f), s1, rng, 1);
    if (rnd(rng) < psurf) {
      V3 n = norm3(lin3(P + P_WORLD_NORMAL, gv)) * -1.f;  // pointing from high values to low
      if (dot3(n, wo) < 0.f) n = n * -1.f;
      float spec = P[P_SPECULAR], rough = P[P_ROUGHNESS];
      if (Tl > 0.f) L = L + thr * brdf_cos(n, wo, ldir, albedo, spec, rough) * lrgb * Tl;
      V3 nd;
      if (rnd(rng) < spec) {
        V3 r = norm3(n * (2.f * dot3(n, wo)) - wo);
        float e = phong_exp(rough);
        float u1 = rnd(rng), u2 = rnd(rng);
        float ct = powf(u1, 1.f / (e + 1.f)), st = sqrtf(fmaxf(0.f, 1.f - ct * ct)), ph = 6.2831853f * u2;
        V3 t, b; basis(r, &t, &b);
        nd = norm3(t * (st * cosf(ph)) + b * (st * sinf(ph)) + r * ct);
        if (dot3(nd, n) <= 0.f) break;
      } else {
        nd = cosdir(n, rng);
        thr = thr * albedo;
      }
      dw = nd;
    } else {
      float g = P[P_PHASE_G];
      if (Tl > 0.f) L = L + thr * albedo * lrgb * (hg(dot3(dw, ldir), g) * Tl);
      thr = thr * albedo;
      dw = hgdir(dw, g, rng);
    }
    ow = sw;
    if (bounce >= 2) {
      float q = fminf(0.95f, fmaxf(thr.x, fmaxf(thr.y, thr.z)));
      if (rnd(rng) > q) break;
      thr = thr * (1.f / q);
    }
  }
  int i = y * W + x;
  float4 a = accum[i];
  accum[i] = make_float4(a.x + L.x, a.y + L.y, a.z + L.z, a.w + alpha);
}

// Where each pixel's ray first becomes mostly opaque: GL depth (0..1) and the world distance, or 1 / -1.
extern "C" __global__ void firsthit(const float* P, cudaTextureObject_t vol, const float* tf, const float* maj,
                                    const unsigned short* lab, const float* lut, const float* lutflags,
                                    float* depth, int W, int H) {
  int x = blockIdx.x * blockDim.x + threadIdx.x, y = blockIdx.y * blockDim.y + threadIdx.y;
  if (x >= W || y >= H) return;
  Scene S; S.P = P; S.vol = vol; S.tf = tf; S.maj = maj; S.lab = lab; S.lut = lut; S.lutflags = lutflags;
  Rng rng; rng.s = 1u;
  V3 ow, dw;
  ray(P, x, y, W, H, 0.5f, 0.5f, rng, &ow, &dw, false);
  const float* A = P + P_VOX_FROM_WORLD;
  V3 ov = aff(A, ow), dv = lin(A, dw);
  float t0, t1;
  float out = 1.f, dist = -1.f;
  if (boxhit(P, ov, dv, &t0, &t1)) {
    float vlen = len3(dv);
    float dt = P[P_STEP] / fmaxf(vlen, 1e-12f);
    float acc = 0.f;
    for (float t = t0; t < t1; t += dt) {
      V3 w = ow + dw * t, v = ov + dv * t;
      float s = medium(S, w, v, 0);
      acc = 1.f - (1.f - acc) * expf(-s * dt);
      if (acc >= P[P_OPAQUE_LIMIT]) {
        float c[4];
        const float* VP = P + P_VP;
        mul4(VP, w.x, w.y, w.z, 1.f, c);
        out = fminf(fmaxf((c[2] / c[3]) * 0.5f + 0.5f, 0.f), 1.f);
        dist = t;
        break;
      }
    }
  }
  depth[2 * (y * W + x)] = out;
  depth[2 * (y * W + x) + 1] = dist;
}

// The majorant of each brick: density times the largest opacity the transfer function gives between the
// brick's least and greatest texture value (and 0 for bricks wholly outside the crop box).
extern "C" __global__ void majorant(const float* P, const float* tf, const float* bmin, const float* bmax, float* maj, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  float lo = fminf(fmaxf(bmin[i], 0.f), 1.f), hi = fminf(fmaxf(bmax[i], 0.f), 1.f);
  int a = (int)floorf(lo * (TF_SIZE - 1)), b = min(TF_SIZE - 1, (int)ceilf(hi * (TF_SIZE - 1)));
  float m = 0.f;
  for (int k = a; k <= b; ++k) m = fmaxf(m, tf[4 * k + 3]);
  maj[i] = P[P_DENSITY] * m;
}

// Mean of the accumulation buffer, exposure, ACES tone curve (Narkowicz's fit), sRGB, 8 bits.
extern "C" __global__ void tonemap(const float4* accum, float inv_n, float exposure, unsigned char* rgba, int W, int H) {
  int x = blockIdx.x * blockDim.x + threadIdx.x, y = blockIdx.y * blockDim.y + threadIdx.y;
  if (x >= W || y >= H) return;
  float4 a = accum[y * W + x];
  float c[3] = {a.x * inv_n * exposure, a.y * inv_n * exposure, a.z * inv_n * exposure};
  int o = 4 * (y * W + x);
  for (int k = 0; k < 3; ++k) {
    float v = c[k];
    v = (v * (2.51f * v + 0.03f)) / (v * (2.43f * v + 0.59f) + 0.14f);
    v = fminf(fmaxf(v, 0.f), 1.f);
    v = v <= 0.0031308f ? 12.92f * v : 1.055f * powf(v, 1.f / 2.4f) - 0.055f;
    rgba[o + k] = (unsigned char)(v * 255.f + 0.5f);
  }
  rgba[o + 3] = (unsigned char)(fminf(fmaxf(a.w * inv_n, 0.f), 1.f) * 255.f + 0.5f);
}
"""
)
