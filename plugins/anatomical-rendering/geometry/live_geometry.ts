/**
 * Surfaces in the live object (live.ts): the BVH and its primitives as data
 * textures, and the GLSL that traces a ray through them, the render
 * computer's traversal and intersectors (geometry.py's geohit, trihit,
 * spherehit, conehit) in GLSL ES 3.00.
 *
 * One RGBA32F texture holds, a row-aligned region each: the primitives
 * (3 texels: their 9 floats, then kind and object), the nodes (2 texels:
 * lo xyz and the left child, hi xyz and the right; leaves' children -1)
 * and the objects (1 texel: colour, and the layer + 1, 0 when hidden).
 * An RGBA32UI texture holds each primitive's corners' normals. Indices are
 * floats (exact below 2^24: at most 8 M primitives).
 *
 * The geometry is in physical millimetres; a ray is taken there by
 * uGeoFromWorld without being made unit length, so its t is the world
 * ray's. A hit is kept only where its layer's cuts and crop keep it, so a
 * cut opens a cell and the ray goes on to what is behind.
 */
import type { Surfaces } from "./surfaces.js";

/** Layers whose surfaces are traced together (their own cuts and crops each). */
export const GEO_LAYERS = 4;
/** The most primitives (indices are exact as floats). */
export const GEO_MAX = 8e6;

/** What a frame draws of the surfaces held: their objects' colours, each layer's cuts and crop, the material. */
export interface LiveGeometryLook {
  /** Per object (the surfaces' numbering): r, g, b, and the layer + 1 (0: hidden). */
  colours: Float32Array;
  /** Changes when the colours do. */
  key: string;
  /** Per layer (as the colours number them): its cuts (world planes) and its crop (millimetres; null: none). */
  layers: { clips: number[][]; crop: [number[], number[]] | null }[];
  roughness: number;
  specular: number;
  exposure: number;
}

/** The GLSL: uniforms, the traversal and the surface at a hit. `maxClips`: cuts a layer. */
export function geometryGlsl(width: number, maxClips: number): string {
  const shift = Math.log2(width);
  return `
#define GEO_W ${width}
#define GEO_SHIFT ${shift}
#define GEO_LAYERS ${GEO_LAYERS}
uniform highp sampler2D uGeoData;
uniform highp usampler2D uGeoNorm;
uniform int uGeoN;
uniform int uGeoNodeAt;
uniform int uGeoObjAt;
uniform mat4 uGeoFromWorld;
uniform vec4 uGeoClips[${maxClips} * GEO_LAYERS];
uniform int uGeoNClip[GEO_LAYERS];
uniform vec3 uGeoCropLo[GEO_LAYERS];
uniform vec3 uGeoCropHi[GEO_LAYERS];
uniform float uGeoRough;
uniform float uGeoSpec;
// How far (world) a ray leaving a surface starts from it.
uniform float uGeoEps;

ivec2 geoAt(int i) { return ivec2(i & (GEO_W - 1), i >> GEO_SHIFT); }
vec4 geoData(int i) { return texelFetch(uGeoData, geoAt(i), 0); }
vec4 geoObj(int o) { return geoData(uGeoObjAt + o); }

// Möller-Trumbore: t along (o, d any length), and the barycentrics; -1 when none.
float geoTri(vec3 a, vec3 b, vec3 c, vec3 o, vec3 d, out vec2 uv) {
  vec3 e1 = b - a, e2 = c - a;
  vec3 p = cross(d, e2);
  float det = dot(e1, p);
  uv = vec2(0.0);
  if (abs(det) < 1e-30) return -1.0;
  float inv = 1.0 / det;
  vec3 s = o - a;
  float u = dot(s, p) * inv;
  if (u < 0.0 || u > 1.0) return -1.0;
  vec3 q = cross(s, e1);
  float v = dot(d, q) * inv;
  if (v < 0.0 || u + v > 1.0) return -1.0;
  uv = vec2(u, v);
  return dot(e2, q) * inv;
}
float geoSphere(vec3 c, float r, vec3 o, vec3 d) {
  vec3 oc = o - c;
  float b = dot(oc, d), h = b * b - (dot(oc, oc) - r * r);
  if (h < 0.0) return -1.0;
  h = sqrt(h);
  float t = -b - h;
  return t > 0.0 ? t : -b + h;
}
float geoCone(vec3 pa, float ra, vec3 pb, float rb, vec3 o, vec3 d) {
  vec3 ba = pb - pa, oa = o - pa, ob = o - pb;
  float rr = ra - rb, m0 = dot(ba, ba), m1 = dot(ba, oa), m2 = dot(ba, d), m3 = dot(d, oa);
  float m5 = dot(oa, oa), m6 = dot(ob, d), m7 = dot(ob, ob);
  float d2 = m0 - rr * rr;
  float k2 = d2 - m2 * m2, k1 = d2 * m3 - m1 * m2 + m2 * rr * ra, k0 = d2 * m5 - m1 * m1 + m1 * rr * ra * 2.0 - m0 * ra * ra;
  float h = k1 * k1 - k0 * k2;
  if (h < 0.0) return -1.0;
  float t = (-sqrt(h) - k1) / k2;
  float y = m1 - ra * rr + t * m2;
  if (y > 0.0 && y < d2) return t;
  float best = 1e30;
  float h1 = m3 * m3 - m5 + ra * ra, h2 = m6 * m6 - m7 + rb * rb;
  if (h1 > 0.0) best = -m3 - sqrt(h1);
  if (h2 > 0.0) best = min(best, -m6 - sqrt(h2));
  return best < 1e29 ? best : -1.0;
}
// Primitive i: t along (o, d any length), its barycentrics (a triangle's), kind and object.
float geoPrimHit(int i, vec3 o, vec3 d, out vec2 uv, out int obj) {
  vec4 p0 = geoData(3 * i), p1 = geoData(3 * i + 1), p2 = geoData(3 * i + 2);
  int kind = int(p2.y);
  obj = int(p2.z);
  uv = vec2(0.0);
  if (kind == 0) return geoTri(p0.xyz, vec3(p0.w, p1.xy), vec3(p1.zw, p2.x), o, d, uv);
  float len = max(length(d), 1e-30);
  vec3 u = d / len;
  float s = kind == 2 ? geoSphere(p0.xyz, p0.w, o, u) : geoCone(p0.xyz, p0.w, vec3(p1.xyz), p1.w, o, u);
  return s < 0.0 ? -1.0 : s / len;
}
// Kept at world point w (geometry point p) for layer li: inside its crop, cut away by none of its cuts.
bool geoKept(int li, vec3 w, vec3 p) {
  if (any(lessThan(p, uGeoCropLo[li])) || any(greaterThan(p, uGeoCropHi[li]))) return false;
  for (int i = 0; i < ${maxClips}; ++i) {
    if (i >= uGeoNClip[li]) break;
    vec4 c = uGeoClips[li * ${maxClips} + i];
    if (dot(c.xyz, w) + c.w < 0.0) return false;
  }
  return true;
}
// Node k's box: the ray's entry, or -1 when it misses within tmax (o, inv: the ray in geometry space).
float geoBox(int k, vec3 o, vec3 inv, float tmax, out int left, out int right) {
  vec4 lo = geoData(uGeoNodeAt + 2 * k), hi = geoData(uGeoNodeAt + 2 * k + 1);
  left = int(lo.w);
  right = int(hi.w);
  vec3 ta = (lo.xyz - o) * inv, tb = (hi.xyz - o) * inv;
  vec3 tn = min(ta, tb), tf = max(ta, tb);
  float t0 = max(max(tn.x, tn.y), max(tn.z, 0.0));
  float t1 = min(min(tf.x, tf.y), min(tf.z, tmax));
  return t0 <= t1 ? t0 : -1.0;
}
// The nearest kept surface the world ray (ow, dw) meets in (tmin, tmax): its t (-1: none), primitive and
// barycentrics. anyHit: the first found (a shadow ray's).
float geoTrace(vec3 ow, vec3 dw, float tmin, float tmax, bool anyHit, out int prim, out vec2 uv) {
  prim = -1;
  uv = vec2(0.0);
  int n = uGeoN;
  if (n <= 0) return -1.0;
  vec3 o = (uGeoFromWorld * vec4(ow, 1.0)).xyz;
  vec3 d = mat3(uGeoFromWorld) * dw;
  vec3 inv = 1.0 / mix(d, vec3(1e-20), lessThan(abs(d), vec3(1e-20)));
  float best = tmax;
  int stack[48];
  int sp = 0;
  int l_, r_;
  if (n == 1) stack[sp++] = 0;
  else if (geoBox(0, o, inv, best, l_, r_) >= 0.0) stack[sp++] = 0;
  for (int it = 0; it < 65536; ++it) {
    if (sp == 0) break;
    int node = stack[--sp];
    if (n == 1 || node >= n - 1) {
      int i = n == 1 ? 0 : node - (n - 1);
      vec2 c;
      int obj;
      float t = geoPrimHit(i, o, d, c, obj);
      if (t <= tmin || t >= best) continue;
      float layer = geoObj(obj).a;
      if (layer < 0.5 || !geoKept(int(layer) - 1, ow + dw * t, o + d * t)) continue;
      best = t;
      prim = i;
      uv = c;
      if (anyHit) break;
      continue;
    }
    int l = int(geoData(uGeoNodeAt + 2 * node).w), r = int(geoData(uGeoNodeAt + 2 * node + 1).w);
    int ll, lr, rl, rr;
    float tl = geoBox(l, o, inv, best, ll, lr);
    float tr = geoBox(r, o, inv, best, rl, rr);
    // The nearer child on top, so it is searched first and narrows the other.
    if (tl >= 0.0 && tr >= 0.0) {
      if (tl < tr) { stack[sp++] = r; stack[sp++] = l; } else { stack[sp++] = l; stack[sp++] = r; }
    } else if (tl >= 0.0) stack[sp++] = l;
    else if (tr >= 0.0) stack[sp++] = r;
    if (sp > 46) sp = 46;
  }
  return prim < 0 ? -1.0 : best;
}
float geoHit(vec3 ow, vec3 dw, float tmin, float tmax, out int prim, out vec2 uv) { return geoTrace(ow, dw, tmin, tmax, false, prim, uv); }
bool geoAny(vec3 ow, vec3 dw, float tmin, float tmax) {
  int p;
  vec2 c;
  return geoTrace(ow, dw, tmin, tmax, true, p, c) >= 0.0;
}
vec3 geoOct(uint p) {
  vec2 e = unpackSnorm2x16(p);
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return normalize(n);
}
// A round cone's signed distance at p (Quilez's sdRoundCone).
float geoConeDist(vec3 p, vec3 a, float r1, vec3 b, float r2) {
  vec3 ba = b - a;
  float l2 = dot(ba, ba), rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1.0 / l2;
  vec3 pa = p - a;
  float y = dot(pa, ba), z = y - l2;
  vec3 xv = pa * l2 - ba * y;
  float x2 = dot(xv, xv), y2 = y * y * l2, z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
// The surface at a hit of the world ray (ow, dw) at t: its world normal (facing the ray) and colour.
void geoSurface(int prim, vec2 uv, vec3 ow, vec3 dw, float t, out vec3 nw, out vec3 colour) {
  vec4 p0 = geoData(3 * prim), p1 = geoData(3 * prim + 1), p2 = geoData(3 * prim + 2);
  int kind = int(p2.y);
  colour = geoObj(int(p2.z)).rgb;
  vec3 p = (uGeoFromWorld * vec4(ow + dw * t, 1.0)).xyz;
  vec3 n;
  if (kind == 0) {
    uvec4 q = texelFetch(uGeoNorm, geoAt(prim), 0);
    n = geoOct(q.x) * (1.0 - uv.x - uv.y) + geoOct(q.y) * uv.x + geoOct(q.z) * uv.y;
    if (dot(n, n) < 1e-12) n = cross(vec3(p1.zw, p2.x) - p0.xyz, vec3(p0.w, p1.xy) - p0.xyz);
  } else if (kind == 2) {
    n = p - p0.xyz;
  } else {
    float e = 1e-3 * max(p0.w + p1.w, 1e-12);
    vec3 a = p0.xyz, b = p1.xyz;
    n = vec3(geoConeDist(p + vec3(e, 0.0, 0.0), a, p0.w, b, p1.w) - geoConeDist(p - vec3(e, 0.0, 0.0), a, p0.w, b, p1.w),
             geoConeDist(p + vec3(0.0, e, 0.0), a, p0.w, b, p1.w) - geoConeDist(p - vec3(0.0, e, 0.0), a, p0.w, b, p1.w),
             geoConeDist(p + vec3(0.0, 0.0, e), a, p0.w, b, p1.w) - geoConeDist(p - vec3(0.0, 0.0, e), a, p0.w, b, p1.w));
  }
  // Normals to the world: the inverse transpose of world-to-geometry's inverse is its transpose.
  nw = normalize(transpose(mat3(uGeoFromWorld)) * n);
  if (dot(nw, dw) > 0.0) nw = -nw;
}
// The surface's light toward -wo from the key light (wl), as brdfCos with the surfaces' material.
vec3 geoBrdfCos(vec3 n, vec3 wo, vec3 wl, vec3 albedo) {
  float cl = dot(n, wl);
  if (cl <= 0.0) return vec3(0.0);
  vec3 h = normalize(wo + wl);
  float e = max(1.0, 2.0 / max(uGeoRough * uGeoRough, 1e-4) - 2.0);
  float s = uGeoSpec * (e + 8.0) / 25.132741 * pow(max(dot(n, h), 0.0), e);
  return (albedo * ((1.0 - uGeoSpec) * 0.31830989) + vec3(s)) * cl;
}
`;
}

/** The data texture's width: 4096 where the GPU allows (a power of two). */
export function geoWidth(maxSize: number): number {
  return maxSize >= 4096 ? 4096 : 2048;
}

/** The texels the data takes (row-aligned regions), and where the nodes and objects start. */
export function geoLayout(s: Surfaces, width: number): { nodeAt: number; objAt: number; rows: number } {
  const n = s.bvh.n;
  const up = (x: number) => Math.ceil(x / width) * width;
  const nodeAt = up(3 * n);
  const objAt = up(nodeAt + 2 * Math.max(2 * n - 1, 1));
  const rows = Math.ceil((objAt + Math.max(s.objectCount, 1)) / width);
  return { nodeAt, objAt, rows };
}

/** The data texture's contents but the objects' (they change apart): primitives, then nodes. */
export function geoData(s: Surfaces, width: number): Float32Array {
  const { nodeAt, objAt, rows } = geoLayout(s, width);
  const b = s.bvh, n = b.n;
  const out = new Float32Array(rows * width * 4);
  for (let i = 0; i < n; ++i) {
    out.set(b.prims.subarray(9 * i, 9 * i + 9), 12 * i);
    out[12 * i + 9] = b.kinds[i];
    out[12 * i + 10] = b.objects[i];
  }
  const nodes = Math.max(2 * n - 1, 1);
  for (let k = 0; k < nodes && n > 0; ++k) {
    const o = 4 * (nodeAt + 2 * k);
    out.set(b.nodes.subarray(6 * k, 6 * k + 3), o);
    out.set(b.nodes.subarray(6 * k + 3, 6 * k + 6), o + 4);
    const internal = k < n - 1;
    out[o + 3] = internal ? b.kids[2 * k] : -1;
    out[o + 7] = internal ? b.kids[2 * k + 1] : -1;
  }
  void objAt;
  return out;
}

/** The surfaces on the GPU: the data and normals textures, uploaded once; the objects' colours when they change. */
export class GeometryTextures {
  data: WebGLTexture | undefined;
  norm: WebGLTexture | undefined;
  private uploaded: Surfaces | undefined;
  private objKey = "";
  width = 4096;
  layout = { nodeAt: 0, objAt: 0, rows: 0 };

  /** Uploads what changed; false (and why) when the surfaces do not fit this GPU's textures. */
  upload(gl: WebGL2RenderingContext, s: Surfaces, look: LiveGeometryLook): string | undefined {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.width = geoWidth(max);
    if (this.uploaded !== s) {
      const layout = geoLayout(s, this.width);
      const normRows = Math.ceil(Math.max(s.bvh.n, 1) / this.width);
      if (layout.rows > max || normRows > max) return `the surfaces are larger than this GPU's textures (${s.bvh.n.toLocaleString()} primitives)`;
      this.data ??= exact(gl, gl.TEXTURE_2D);
      this.norm ??= exact(gl, gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, this.data);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.width, layout.rows, 0, gl.RGBA, gl.FLOAT, geoData(s, this.width));
      const norm = new Uint32Array(normRows * this.width * 4);
      norm.set(s.normals);
      gl.bindTexture(gl.TEXTURE_2D, this.norm);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, this.width, normRows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, norm);
      this.uploaded = s;
      this.layout = layout;
      this.objKey = "";
    }
    if (this.objKey !== look.key) {
      // The objects' rows: their colours and layers, the rest of the last row 0.
      const { objAt } = this.layout;
      const rows = Math.ceil(Math.max(s.objectCount, 1) / this.width);
      const out = new Float32Array(rows * this.width * 4);
      out.set(look.colours.subarray(0, Math.min(look.colours.length, out.length)));
      gl.bindTexture(gl.TEXTURE_2D, this.data!);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, objAt / this.width, this.width, rows, gl.RGBA, gl.FLOAT, out);
      this.objKey = look.key;
    }
    return undefined;
  }

  /** The surfaces' uniforms and textures (on `unit` and the next) for program `p`. */
  bind(gl: WebGL2RenderingContext, p: WebGLProgram, unit: number, s: Surfaces, look: LiveGeometryLook, geoFromWorld: number[], maxClips: number, eps: number): void {
    const u = (name: string) => gl.getUniformLocation(p, name);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.data!);
    gl.uniform1i(u("uGeoData"), unit);
    gl.activeTexture(gl.TEXTURE0 + unit + 1);
    gl.bindTexture(gl.TEXTURE_2D, this.norm!);
    gl.uniform1i(u("uGeoNorm"), unit + 1);
    gl.uniform1i(u("uGeoN"), s.bvh.n);
    gl.uniform1i(u("uGeoNodeAt"), this.layout.nodeAt);
    gl.uniform1i(u("uGeoObjAt"), this.layout.objAt);
    gl.uniformMatrix4fv(u("uGeoFromWorld"), false, new Float32Array([0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => geoFromWorld[4 * r + c]))));
    const layers = Array.from({ length: GEO_LAYERS }, (_, i) => look.layers[i]);
    gl.uniform4fv(u("uGeoClips"), new Float32Array(layers.flatMap((l) => Array.from({ length: maxClips }, (_, i) => l?.clips[i] ?? [0, 0, 0, 0]).flat())));
    gl.uniform1iv(u("uGeoNClip"), new Int32Array(layers.map((l) => Math.min(l?.clips.length ?? 0, maxClips))));
    gl.uniform3fv(u("uGeoCropLo"), new Float32Array(layers.flatMap((l) => l?.crop?.[0] ?? [-1e30, -1e30, -1e30])));
    gl.uniform3fv(u("uGeoCropHi"), new Float32Array(layers.flatMap((l) => l?.crop?.[1] ?? [1e30, 1e30, 1e30])));
    gl.uniform1f(u("uGeoRough"), look.roughness);
    gl.uniform1f(u("uGeoSpec"), look.specular);
    gl.uniform1f(u("uGeoEps"), eps);
  }

  dispose(gl: WebGL2RenderingContext | undefined): void {
    if (gl) for (const t of [this.data, this.norm]) if (t) gl.deleteTexture(t);
    this.data = this.norm = undefined;
    this.uploaded = undefined;
    this.objKey = "";
  }
}

/** A texture read texel by texel. */
function exact(gl: WebGL2RenderingContext, target: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(target, t);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
