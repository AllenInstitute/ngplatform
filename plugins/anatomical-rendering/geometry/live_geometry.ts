/**
 * Surfaces in the live object (live.ts): the packed blocks (surfaces.ts)
 * as one data texture, and the GLSL that traces a ray through them, the
 * render computer's intersectors (geometry.py's trihit, spherehit,
 * conehit) in GLSL ES 3.00 over the wide BVH (wide.ts).
 *
 * One RGBA32UI texture holds, a row-aligned region each: the vertices
 * (xyz as float bits, and a normal or radius), the primitives (three
 * vertices, and kind << 30 | object), the wide nodes (4 texels each) and
 * the objects (colour, and the layer + 1, 0 when hidden, as float bits).
 *
 * The geometry is in physical millimetres; a ray is taken there by
 * uGeoFromWorld without being made unit length, so its t is the world
 * ray's. A hit is kept only where its layer's cuts and crop keep it, so a
 * cut opens a cell and the ray goes on to what is behind.
 *
 * Each layer has its own material (SurfaceMaterial). A layer less than
 * opaque is stochastically so: a ray passes each of its primitives with
 * the chance it is clear (a hash of the ray and the primitive), so the
 * path tracer's samples average to the opacity and a shadow ray to the
 * light let through.
 */
import type { Surfaces } from "./surfaces.js";
import { WIDE } from "./wide.js";

/** Layers whose surfaces are traced together (their own cuts and crops each). */
export const GEO_LAYERS = 4;
/** The most primitives traced. */
export const GEO_MAX = 8e6;

/** A layer's surfaces' material: how opaque, rough, glossy (the specular share) and bright of themselves. */
export interface SurfaceMaterial {
  opacity: number;
  roughness: number;
  specular: number;
  /** Light given off, times the surface's colour (as the key light's 1). */
  emission: number;
}

/** The material a geometry layer has until it is given one. */
export const DEFAULT_SURFACE: SurfaceMaterial = { opacity: 1, roughness: 0.45, specular: 0.15, emission: 0 };

/** What a frame draws of the surfaces held: their objects' colours, each layer's cuts, crop and material. */
export interface LiveGeometryLook {
  /** Per object (the surfaces' numbering): r, g, b, and the layer + 1 (0: hidden). */
  colours: Float32Array;
  /** Changes when the colours do. */
  key: string;
  /** Per layer (as the colours number them): its cuts (world planes), its crop (millimetres; null: none), its material. */
  layers: { clips: number[][]; crop: [number[], number[]] | null; material: SurfaceMaterial }[];
  exposure: number;
  /**
   * Per layer, this frame's pick IDs: the first (0: none) for its first object (`first`) and each of its `count`
   * objects after. Not in `key`: they change from frame to frame.
   */
  picks?: { base: number; first: number; count: number }[];
}

/** The pick uniforms and geoPickOf (an object's pick ID this frame; 0 none): for passes that draw picks. */
export const GEO_PICK_GLSL = `
uniform ivec3 uGeoPick[${GEO_LAYERS}];
float geoPickOf(int obj) {
  for (int i = 0; i < ${GEO_LAYERS}; ++i) {
    ivec3 p = uGeoPick[i];
    if (p.x > 0 && obj >= p.y && obj < p.y + p.z) return float(p.x + obj - p.y);
  }
  return 0.0;
}`;

/** The GLSL: uniforms, the traversal and the surface at a hit. `maxClips`: cuts a layer. */
export function geometryGlsl(width: number, maxClips: number): string {
  const shift = Math.log2(width);
  return `
#define GEO_W ${width}
#define GEO_SHIFT ${shift}
#define GEO_LAYERS ${GEO_LAYERS}
uniform highp usampler2D uGeo;
uniform int uGeoN;
uniform int uGeoRoot;
uniform int uGeoPrimAt;
uniform int uGeoNodeAt;
uniform int uGeoObjAt;
uniform mat4 uGeoFromWorld;
uniform vec4 uGeoClips[${maxClips} * GEO_LAYERS];
uniform int uGeoNClip[GEO_LAYERS];
uniform vec3 uGeoCropLo[GEO_LAYERS];
uniform vec3 uGeoCropHi[GEO_LAYERS];
// Per layer: roughness, specular share, emission, opacity.
uniform vec4 uGeoMat[GEO_LAYERS];
// The material at the last surface met (geoSurface).
float geoRough = 0.45, geoSpec = 0.15, geoEmit = 0.0;
// How far (world) a ray leaving a surface starts from it.
uniform float uGeoEps;
${GEO_PICK_GLSL}

uvec4 geoFetch(int i) { return texelFetch(uGeo, ivec2(i & (GEO_W - 1), i >> GEO_SHIFT), 0); }
// Vertex v: xyz, and its radius (a sphere's or a tube end's).
vec4 geoVert(uint v) { return uintBitsToFloat(geoFetch(int(v))); }
uvec4 geoPrim(int i) { return geoFetch(uGeoPrimAt + i); }
vec4 geoObj(int o) { return uintBitsToFloat(geoFetch(uGeoObjAt + o)); }

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
// Primitive i: t along (o, d any length), its barycentrics (a triangle's) and object.
float geoPrimHit(int i, vec3 o, vec3 d, out vec2 uv, out int obj) {
  uvec4 p = geoPrim(i);
  uint kind = p.w >> 30;
  obj = int(p.w & 0x3fffffffu);
  uv = vec2(0.0);
  if (kind == 0u) return geoTri(geoVert(p.x).xyz, geoVert(p.y).xyz, geoVert(p.z).xyz, o, d, uv);
  float len = max(length(d), 1e-30);
  vec3 u = d / len;
  vec4 a = geoVert(p.x);
  float s;
  if (kind == 2u) s = geoSphere(a.xyz, a.w, o, u);
  else {
    vec4 b = geoVert(p.y);
    s = geoCone(a.xyz, a.w, b.xyz, b.w, o, u);
  }
  return s < 0.0 ? -1.0 : s / len;
}
// A number in [0, 1) for the ray (o, d) at primitive i: whether a layer less than opaque stops it there.
float geoHash(int i, vec3 o, vec3 d) {
  uvec3 a = floatBitsToUint(o), b = floatBitsToUint(d);
  uint h = uint(i) * 2654435761u ^ a.x ^ (a.y * 2246822519u) ^ (a.z * 3266489917u) ^ (b.x * 668265263u) ^ (b.y * 374761393u) ^ (b.z * 1274126177u);
  h ^= h >> 16;
  h *= 2246822519u;
  h ^= h >> 13;
  h *= 3266489917u;
  h ^= h >> 16;
  return float(h >> 8) / 16777216.0;
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
// The nearest kept surface the world ray (ow, dw) meets in (tmin, tmax): its t (-1: none), primitive and
// barycentrics. anyHit: the first found (a shadow ray's). Through the wide nodes: a node's four children's boxes
// from one fetch, a primitive tested where its box is met, the nodes met searched nearest first.
float geoTrace(vec3 ow, vec3 dw, float tmin, float tmax, bool anyHit, out int prim, out vec2 uv) {
  prim = -1;
  uv = vec2(0.0);
  if (uGeoN <= 0) return -1.0;
  vec3 o = (uGeoFromWorld * vec4(ow, 1.0)).xyz;
  vec3 d = mat3(uGeoFromWorld) * dw;
  vec3 inv = 1.0 / mix(d, vec3(1e-20), lessThan(abs(d), vec3(1e-20)));
  float best = tmax;
  int stack[64];
  int sp = 0;
  stack[sp++] = uGeoRoot;
  for (int it = 0; it < 65536; ++it) {
    if (sp == 0) break;
    int at = uGeoNodeAt + 4 * stack[--sp];
    uvec4 h = geoFetch(at), ql = geoFetch(at + 1), qh = geoFetch(at + 2), ch = geoFetch(at + 3);
    vec3 org = uintBitsToFloat(h.xyz);
    vec3 sc = exp2(vec3(ivec3(h.w & 255u, (h.w >> 8) & 255u, (h.w >> 16) & 255u) - 127));
    int count = int(h.w >> 24);
    // The nodes met, farthest first.
    float kt[4];
    int kn[4];
    int nk = 0;
    for (int c = 0; c < 4; ++c) {
      if (c >= count) break;
      uint sh = uint(8 * c);
      vec3 lo = org + vec3((ql.xyz >> sh) & 255u) * sc;
      vec3 hi = org + vec3((qh.xyz >> sh) & 255u) * sc;
      vec3 ta = (lo - o) * inv, tb = (hi - o) * inv;
      vec3 tn = min(ta, tb), tf = max(ta, tb);
      float t0 = max(max(tn.x, tn.y), max(tn.z, 0.0));
      float t1 = min(min(tf.x, tf.y), min(tf.z, best));
      if (t0 > t1) continue;
      uint ref = ch[c];
      if ((ref & 0x80000000u) != 0u) {
        int i = int(ref & 0x7fffffffu);
        vec2 bc;
        int obj;
        float t = geoPrimHit(i, o, d, bc, obj);
        if (t <= tmin || t >= best) continue;
        float layer = geoObj(obj).a;
        if (layer < 0.5) continue;
        int li = int(layer) - 1;
        float op = uGeoMat[li].w;
        if ((op < 1.0 && geoHash(i, ow, dw) >= op) || !geoKept(li, ow + dw * t, o + d * t)) continue;
        best = t;
        prim = i;
        uv = bc;
        if (anyHit) return best;
        continue;
      }
      int j = nk;
      while (j > 0 && kt[j - 1] < t0) {
        kt[j] = kt[j - 1];
        kn[j] = kn[j - 1];
        --j;
      }
      kt[j] = t0;
      kn[j] = int(ref);
      ++nk;
    }
    for (int j = 0; j < 4; ++j) {
      if (j >= nk) break;
      if (sp < 64) stack[sp++] = kn[j];
    }
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
// The surface at a hit of the world ray (ow, dw) at t: its world normal (facing the ray) and colour; its layer's
// material in geoRough, geoSpec and geoEmit.
void geoSurface(int prim, vec2 uv, vec3 ow, vec3 dw, float t, out vec3 nw, out vec3 colour) {
  uvec4 q = geoPrim(prim);
  uint kind = q.w >> 30;
  vec4 ob = geoObj(int(q.w & 0x3fffffffu));
  colour = ob.rgb;
  vec4 mat = uGeoMat[clamp(int(ob.a) - 1, 0, GEO_LAYERS - 1)];
  geoRough = mat.x;
  geoSpec = mat.y;
  geoEmit = mat.z;
  vec3 p = (uGeoFromWorld * vec4(ow + dw * t, 1.0)).xyz;
  vec3 n;
  if (kind == 0u) {
    uvec4 a = geoFetch(int(q.x)), b = geoFetch(int(q.y)), c = geoFetch(int(q.z));
    if (a.w == 0xffffffffu || b.w == 0xffffffffu || c.w == 0xffffffffu) n = vec3(0.0);
    else n = geoOct(a.w) * (1.0 - uv.x - uv.y) + geoOct(b.w) * uv.x + geoOct(c.w) * uv.y;
    if (dot(n, n) < 1e-12) n = cross(uintBitsToFloat(b.xyz) - uintBitsToFloat(a.xyz), uintBitsToFloat(c.xyz) - uintBitsToFloat(a.xyz));
  } else if (kind == 2u) {
    n = p - geoVert(q.x).xyz;
  } else {
    vec4 a4 = geoVert(q.x), b4 = geoVert(q.y);
    float e = 1e-3 * max(a4.w + b4.w, 1e-12);
    vec3 a = a4.xyz, b = b4.xyz;
    n = vec3(geoConeDist(p + vec3(e, 0.0, 0.0), a, a4.w, b, b4.w) - geoConeDist(p - vec3(e, 0.0, 0.0), a, a4.w, b, b4.w),
             geoConeDist(p + vec3(0.0, e, 0.0), a, a4.w, b, b4.w) - geoConeDist(p - vec3(0.0, e, 0.0), a, a4.w, b, b4.w),
             geoConeDist(p + vec3(0.0, 0.0, e), a, a4.w, b, b4.w) - geoConeDist(p - vec3(0.0, 0.0, e), a, a4.w, b, b4.w));
  }
  // Normals to the world: the inverse transpose of world-to-geometry's inverse is its transpose.
  nw = normalize(transpose(mat3(uGeoFromWorld)) * n);
  if (dot(nw, dw) > 0.0) nw = -nw;
}
// The object at primitive prim.
int geoObjectOf(int prim) { return int(geoPrim(prim).w & 0x3fffffffu); }
// The surface's light toward -wo from the key light (wl), as brdfCos with the material of the surface last met.
vec3 geoBrdfCos(vec3 n, vec3 wo, vec3 wl, vec3 albedo) {
  float cl = dot(n, wl);
  if (cl <= 0.0) return vec3(0.0);
  vec3 h = normalize(wo + wl);
  float e = max(1.0, 2.0 / max(geoRough * geoRough, 1e-4) - 2.0);
  float s = geoSpec * (e + 8.0) / 25.132741 * pow(max(dot(n, h), 0.0), e);
  return (albedo * ((1.0 - geoSpec) * 0.31830989) + vec3(s)) * cl;
}
`;
}

/** The data texture's width: 4096 where the GPU allows (a power of two). */
export function geoWidth(maxSize: number): number {
  return maxSize >= 4096 ? 4096 : 2048;
}

/** Where each region starts (texels, row-aligned), and the rows they take. */
export function geoLayout(s: Surfaces, width: number): { primAt: number; nodeAt: number; objAt: number; rows: number } {
  const up = (x: number) => Math.ceil(x / width) * width;
  const primAt = up(s.vertices.length / 4);
  const nodeAt = up(primAt + s.prims.length / 4);
  const objAt = up(nodeAt + (s.nodes.length / WIDE) * 4);
  const rows = Math.ceil((objAt + Math.max(s.objectCount, 1)) / width);
  return { primAt, nodeAt, objAt, rows };
}

/** The data texture's contents but the objects' (they change apart): vertices, primitives, nodes. */
export function geoData(s: Surfaces, width: number): Uint32Array {
  const { primAt, nodeAt, rows } = geoLayout(s, width);
  const out = new Uint32Array(rows * width * 4);
  out.set(s.vertices, 0);
  out.set(s.prims, 4 * primAt);
  out.set(s.nodes, 4 * nodeAt);
  return out;
}

/** GPU memory the surfaces take (bytes): the data texture's. */
export function geoBytes(s: Surfaces, width = 4096): number {
  return geoLayout(s, width).rows * width * 16;
}

/** The surfaces on the GPU: the data texture, uploaded once; the objects' colours when they change. */
export class GeometryTextures {
  data: WebGLTexture | undefined;
  private uploaded: Surfaces | undefined;
  private objKey = "";
  width = 4096;
  layout = { primAt: 0, nodeAt: 0, objAt: 0, rows: 0 };

  /** Uploads what changed; why not, when the surfaces do not fit this GPU's textures. */
  upload(gl: WebGL2RenderingContext, s: Surfaces, look: LiveGeometryLook): string | undefined {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.width = geoWidth(max);
    if (this.uploaded !== s) {
      const layout = geoLayout(s, this.width);
      if (layout.rows > max) return `the surfaces are larger than this GPU's textures (${s.n.toLocaleString()} primitives)`;
      this.data ??= exact(gl, gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, this.data);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, this.width, layout.rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, geoData(s, this.width));
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
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, objAt / this.width, this.width, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, new Uint32Array(out.buffer));
      this.objKey = look.key;
    }
    return undefined;
  }

  /** The surfaces' uniforms and texture (on `unit`) for program `p`. */
  bind(gl: WebGL2RenderingContext, p: WebGLProgram, unit: number, s: Surfaces, look: LiveGeometryLook, geoFromWorld: number[], maxClips: number, eps: number): void {
    const u = (name: string) => gl.getUniformLocation(p, name);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.data!);
    gl.uniform1i(u("uGeo"), unit);
    gl.uniform1i(u("uGeoN"), s.n);
    gl.uniform1i(u("uGeoRoot"), s.root);
    gl.uniform1i(u("uGeoPrimAt"), this.layout.primAt);
    gl.uniform1i(u("uGeoNodeAt"), this.layout.nodeAt);
    gl.uniform1i(u("uGeoObjAt"), this.layout.objAt);
    gl.uniformMatrix4fv(u("uGeoFromWorld"), false, new Float32Array([0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => geoFromWorld[4 * r + c]))));
    const layers = Array.from({ length: GEO_LAYERS }, (_, i) => look.layers[i]);
    gl.uniform4fv(u("uGeoClips"), new Float32Array(layers.flatMap((l) => Array.from({ length: maxClips }, (_, i) => l?.clips[i] ?? [0, 0, 0, 0]).flat())));
    gl.uniform1iv(u("uGeoNClip"), new Int32Array(layers.map((l) => Math.min(l?.clips.length ?? 0, maxClips))));
    gl.uniform3fv(u("uGeoCropLo"), new Float32Array(layers.flatMap((l) => l?.crop?.[0] ?? [-1e30, -1e30, -1e30])));
    gl.uniform3fv(u("uGeoCropHi"), new Float32Array(layers.flatMap((l) => l?.crop?.[1] ?? [1e30, 1e30, 1e30])));
    gl.uniform4fv(u("uGeoMat"), new Float32Array(layers.flatMap((l) => {
      const m = l?.material ?? DEFAULT_SURFACE;
      return [m.roughness, m.specular, m.emission, m.opacity];
    })));
    gl.uniform1f(u("uGeoEps"), eps);
    bindPicks(gl, p, look);
  }

  dispose(gl: WebGL2RenderingContext | undefined): void {
    if (gl && this.data) gl.deleteTexture(this.data);
    this.data = undefined;
    this.uploaded = undefined;
    this.objKey = "";
  }
}

/** The frame's pick IDs (GEO_PICK_GLSL's uniforms) for program `p`. */
export function bindPicks(gl: WebGL2RenderingContext, p: WebGLProgram, look: LiveGeometryLook): void {
  const picks = Array.from({ length: GEO_LAYERS }, (_, i) => look.picks?.[i]);
  gl.uniform3iv(gl.getUniformLocation(p, "uGeoPick"), new Int32Array(picks.flatMap((x) => (x && x.base > 0 ? [x.base, x.first, x.count] : [0, 0, 0]))));
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
