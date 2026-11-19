/**
 * The image as an object in the 3-D view, drawn with each frame's own
 * camera. One level of the image (8-bit, as the browser's path tracer reads
 * it) is a 3-D texture ray-marched in the panel's own pass, front to back:
 * the preset's colours and opacities, its surface and volume shading, the
 * light and the surroundings' light, through the same tone map. So it
 * turns, pans and zooms with the view at once, never lagging it.
 *
 * The light is held in the object too: a coarser 3-D texture (at most
 * LIGHT_SIDE cells a side) of how much of the light reaches each cell
 * (marched to the level's edge) and the light arriving there from all
 * round, path-traced as the path tracer does (scattering up to three times,
 * the surroundings where a path leaves), a few layers each frame and
 * refined over LIGHT_PASSES passes. The light keeps the direction it had
 * when it was set, fixed to the object as the camera turns about it. Until
 * the first passes are done, short rays toward the light and along the
 * normal stand in. Region colours, light maps and depth of field are the
 * path tracer's only.
 *
 * Several images (up to MAX_VOLUMES: an overview and volumes of interest
 * within it, say) are drawn as one volume: each its own level, table,
 * material, crop and cuts, placed by its layer's transform. Where they
 * overlap both are there: their extinctions add, and the colour is each
 * one's in its share of the extinction. One ray steps through them all, a
 * voxel of the finest it is in a step; the light held covers all of them.
 */
import type { Frame3d } from "@ngplatform/sdk";
import { VolumeClient } from "../volume-view/volume_client.js";
import type { ViewSpec } from "./client.js";
import { brickBounds, cameraAxes, invert, type Level8, type LevelPreset, levelTable, mul, readLevel, rowMajor, TF_SIZE } from "./local/local.js";
import { bindPicks, GEO_PICK_GLSL, GeometryTextures, geometryGlsl, geoWidth, type LiveGeometryLook } from "./geometry/live_geometry.js";
import type { Surfaces } from "./geometry/surfaces.js";
import { drawColourBlended } from "./blend.js";

/** The voxels of the level read for the object by default (Quality › Object); this browser's path tracer shares its own. */
export const LIVE_VOXELS = 64e6;
/** The longest side read; a level's texture must also fit the GPU's 3-D textures. */
const MAX_SIDE = 2048;
/** The bricks (voxels a side) the ray steps over where the preset leaves them clear. */
const BRICK = 8;
/** The light held for the object: cells a side at most, passes (the first for the light, then one path a cell each), layers a frame. */
export const LIGHT_SIDE = 96;
export const LIGHT_PASSES = 48;
const LAYERS_PER_DRAW = 8;
/** At fewest, 1 row in this many path-traced a pass (a slow GPU, or a heavy scene). */
const MAX_ROWS = 64;
/** The view at rest is path-traced once the camera has been still this long, up to the view's samples (at most MAX_TRACED). */
const STILL_MS = 150;
const MAX_TRACED = 1024;
const ENV = { top: [0.85, 0.9, 1.0], horizon: [0.55, 0.55, 0.6], bottom: [0.12, 0.11, 0.1], scale: 0.6 };

/** A preset as the live image takes it: whole, with the view's overrides; "data" stops at the image's data values. */
export type LivePreset = LevelPreset;
/** The preset's table at the level's values (`levelTable`). */
export const liveTable = levelTable;

/**
 * What a frame is drawn with: the view the path tracer would be sent for it, and the images drawn together as one
 * volume, each with its preset and where its layer's transform moves it (millimetres, column-major). The first
 * image's preset gives the light, the surroundings and the exposure, and the crops are fractions of it.
 */
export interface LiveLook {
  view: ViewSpec;
  volumes: LiveVolumeSpec[];
  /** The surroundings' light (else the preset's): its colours above, at and below the horizon and its strength. */
  env?: LiveEnv;
  /** The light turns with the camera: the light held is path-traced again only once the camera rests. */
  lightFollows?: boolean;
  /** The surfaces held (`putSurfaces`) as this frame draws them; none: not drawn. */
  geometry?: LiveGeometryLook;
}

/** One image of a look: its preset, its placement, and its own crop (fractions of it; null: none) and cuts (else the view's). */
export interface LiveVolumeSpec {
  url: string;
  preset: LivePreset;
  /** The table to draw with (TF_SIZE RGBA entries), else the preset's at the level's values; `key` names it. */
  table?: { rgba: Float32Array; key: string };
  placement?: ArrayLike<number>;
  crop?: [number[], number[]] | null;
  clips?: number[][];
}

export interface LiveEnv {
  top?: number[];
  horizon?: number[];
  bottom?: number[];
  scale?: number;
}

/**
 * Which bricks the table leaves clear: 0 for a brick whose values (least
 * and greatest, pairs 0..1 from `brickBounds`) all have no opacity, else 255.
 */
export function occupancy(bounds: Float32Array, table: Float32Array): Uint8Array {
  // Opaque entries up to each one, so a brick's range is one subtraction.
  const opaque = new Int32Array(TF_SIZE + 1);
  for (let i = 0; i < TF_SIZE; ++i) opaque[i + 1] = opaque[i] + (table[4 * i + 3] > 0 ? 1 : 0);
  const out = new Uint8Array(bounds.length / 2);
  for (let i = 0; i < out.length; ++i) {
    const a = Math.max(0, Math.floor(bounds[2 * i] * (TF_SIZE - 1)));
    const b = Math.min(TF_SIZE - 1, Math.ceil(bounds[2 * i + 1] * (TF_SIZE - 1)));
    out[i] = b >= a && opaque[b + 1] - opaque[a] > 0 ? 255 : 0;
  }
  return out;
}

/** The cells of the light held for a level: voxels a cell side, and cells along x, y and z. */
export function lightGrid(size: readonly number[]): { cell: number; grid: [number, number, number] } {
  const cell = Math.max(1, Math.ceil(Math.max(...size) / LIGHT_SIDE));
  return { cell, grid: [0, 1, 2].map((a) => Math.ceil(size[a] / cell)) as [number, number, number] };
}

/** The most volumes drawn together as one: each takes two of the GPU's texture units (WebGL 2 promises 16). */
export const MAX_VOLUMES = 5;
/** The most cuts (planes) a volume is cut by. */
export const MAX_CLIPS = 6;

/** The shader's values for a view of a level, as the path tracer's parameter block has them (`LocalRenderer.pack`). */
export type LiveParams = ReturnType<typeof liveParams>;

/**
 * `placement`: where the layer's own transform moves the image from where its metadata puts it (millimetres to
 * millimetres, column-major; a volume of interest placed in an overview), applied before the view's world.
 */
export function liveParams(
  view: ViewSpec,
  preset: LivePreset,
  level: Pick<Level8, "size" | "voxelToRas">,
  placement?: ArrayLike<number>,
  own: { crop?: [number[], number[]] | null; clips?: number[][]; env?: LiveEnv } = {},
) {
  const inv = rowMajor(view.inv_view_projection);
  const wfp = view.world_from_physical ? rowMajor(view.world_from_physical) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const ras = placement ? mul(rowMajor(placement), level.voxelToRas) : level.voxelToRas;
  const wfv = mul(wfp, ras);
  const vfw = invert(wfv);
  const [right, up, back] = cameraAxes(inv);
  const ld = view.light?.direction ?? [0.4, 0.7, 0.6];
  let L = view.light?.camera_space === false ? ld : [0, 1, 2].map((i) => ld[0] * right[i] + ld[1] * up[i] + ld[2] * back[i]);
  const ln = Math.hypot(...L);
  L = L.map((x) => x / ln);
  const ls = preset.light_scale ?? 1;
  const env = { ...ENV, ...(preset.environment ?? {}), ...(own.env ?? {}) };
  const keepBox = view.boxes?.find((b) => b.keep);
  const crop = own.crop !== undefined ? (own.crop ?? undefined) : (view.crop_fraction ?? (keepBox ? ([keepBox.lo, keepBox.hi] as [number[], number[]]) : undefined));
  const clips = (own.clips ?? view.clips ?? []).slice(0, MAX_CLIPS);
  return {
    // Column-major, for the shader.
    voxFromWorld: [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => vfw[4 * r + c])),
    worldFromVox: [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => wfv[4 * r + c])),
    dims: level.size,
    cropLo: crop ? crop[0].map((f, a) => f * level.size[a] - 0.5) : [-1e9, -1e9, -1e9],
    cropHi: crop ? crop[1].map((f, a) => f * level.size[a] - 0.5) : [1e9, 1e9, 1e9],
    clips: Array.from({ length: 4 * MAX_CLIPS }, (_, i) => clips[i >> 2]?.[i & 3] ?? 0),
    nclip: clips.length,
    density: preset.density * (view.unit_mm ?? 1),
    shadeMix: preset.shade_mix ?? 0.8,
    gradScale: preset.gradient_scale ?? 40,
    roughness: preset.roughness ?? 0.45,
    specular: preset.specular ?? 0.15,
    phaseG: preset.phase_g ?? 0,
    albedo: preset.albedo ?? 0.9,
    inset: preset.surface_inset ?? 0,
    maxBounces: view.max_bounces ?? 4,
    exposure: preset.exposure ?? 1,
    lightDir: L,
    lightRgb: (view.light?.rgb ?? [3.2, 3.0, 2.8]).map((x) => x * ls),
    envTop: env.top!,
    envHorizon: env.horizon!,
    envBottom: env.bottom!,
    envUp: up,
    envScale: env.scale ?? 1,
  };
}

/** A voxel's size in the world (the cube root of its volume there): which of two volumes is the finer. */
export function voxelWorldSize(worldFromVox: readonly number[]): number {
  const m = worldFromVox;
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  return Math.cbrt(Math.abs(det));
}

/**
 * The box the light held covers, in the world (axis-aligned, about every volume), its cell's side, and cells along
 * x, y and z: at most LIGHT_SIDE along the longest side.
 */
export function lightBox(volumes: readonly { worldFromVox: readonly number[]; dims: readonly number[] }[]): { lo: number[]; cell: number; grid: [number, number, number] } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { worldFromVox: m, dims } of volumes) {
    for (let c = 0; c < 8; ++c) {
      const v = [0, 1, 2].map((a) => ((c >> a) & 1 ? dims[a] - 0.5 : -0.5));
      for (let r = 0; r < 3; ++r) {
        const w = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r];
        lo[r] = Math.min(lo[r], w);
        hi[r] = Math.max(hi[r], w);
      }
    }
  }
  const extent = [0, 1, 2].map((a) => Math.max(hi[a] - lo[a], 1e-9));
  const cell = Math.max(...extent) / LIGHT_SIDE;
  return { lo, cell, grid: [0, 1, 2].map((a) => Math.max(1, Math.ceil(extent[a] / cell))) as [number, number, number] };
}

/** One volume as the shaders take it: its level, its table, and its values for the view. */
interface Drawn {
  vol: Vol;
  q: LiveParams;
}

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * What the shaders read, for `n` volumes drawn as one: each volume's level, its row of the table, its clear bricks,
 * its material, its crop and its cuts; the light and the surroundings. The volumes are in order, finest first.
 * Where they overlap, both are there: the extinction at a point is the sum of theirs. A ray carries where it is in
 * each volume and when it is inside each (and its crop). Samplers in arrays may be indexed only by constants in
 * GLSL ES 3.00, so each volume's are their own, chosen in a chain of ifs.
 */
const COMMON = (n: number) => {
  const each = (f: (k: number) => string) => Array.from({ length: n }, (_, k) => f(k)).join("\n");
  const chain = (f: (k: number) => string, otherwise: string) => `${Array.from({ length: n }, (_, k) => `if (k == ${k}) ${f(k)}`).join("\n  else ")}\n  ${otherwise}`;
  return `precision highp float;
precision highp sampler3D;
#define N ${n}
${each((k) => `uniform sampler3D uVol${k};\nuniform highp sampler3D uOcc${k};`)}
uniform sampler2D uTf;
uniform bool uHasOcc[N];
uniform mat4 uVoxFromWorld[N];
uniform vec3 uDims[N];
uniform float uDensity[N];
uniform float uPhaseG[N];
uniform float uAlbedo[N];
uniform float uShadeMix[N];
uniform float uGradScale[N];
uniform float uRoughness[N];
uniform float uSpecular[N];
uniform float uInset[N];
uniform vec3 uCropLo[N];
uniform vec3 uCropHi[N];
uniform vec4 uClips[${MAX_CLIPS * n}];
uniform int uNClip[N];
uniform vec3 uLightDir;
uniform vec3 uLightRgb;
uniform vec3 uEnvTop;
uniform vec3 uEnvHorizon;
uniform vec3 uEnvBottom;
uniform vec3 uEnvUp;
uniform float uEnvScale;
uniform vec3 uLightLo;
uniform float uCellW;

struct Ray {
  vec3 o;
  vec3 d;
  vec3 ov[N];
  vec3 dv[N];
  float vox[N];
  float tin[N];
  float tout[N];
  float t0;
  float t1;
};

float tex(int k, vec3 v) {
  ${chain((k) => `return texture(uVol${k}, (v + 0.5) / uDims[${k}]).r;`, "return 0.0;")}
}
bool occupied(int k, vec3 cell) {
  ${chain((k) => `return texelFetch(uOcc${k}, ivec3(clamp(cell, vec3(0.0), vec3(textureSize(uOcc${k}, 0) - 1))), 0).r != 0.0;`, "return true;")}
}
vec4 tf(int k, float t) { return texture(uTf, vec2((clamp(t, 0.0, 1.0) * ${TF_SIZE - 1}.0 + 0.5) / ${TF_SIZE}.0, (float(k) + 0.5) / float(N))); }
vec3 grad(int k, vec3 v) {
  return vec3(tex(k, v + vec3(1.0, 0.0, 0.0)) - tex(k, v - vec3(1.0, 0.0, 0.0)),
              tex(k, v + vec3(0.0, 1.0, 0.0)) - tex(k, v - vec3(0.0, 1.0, 0.0)),
              tex(k, v + vec3(0.0, 0.0, 1.0)) - tex(k, v - vec3(0.0, 0.0, 1.0))) * 0.5;
}
// The gradient in the world: the way the value rises there.
vec3 worldGrad(int k, vec3 g) { return transpose(mat3(uVoxFromWorld[k])) * g; }
vec3 safeDir(vec3 dv) { return mix(dv, vec3(1e-12), lessThan(abs(dv), vec3(1e-12))); }
// Where a ray (origin o, unit direction d, world) is in the box lo..hi of a space it is ov + dv t in.
vec2 slab(vec3 ov, vec3 dv, vec3 lo, vec3 hi) {
  vec3 safe = safeDir(dv);
  vec3 ta = (lo - ov) / safe;
  vec3 tb = (hi - ov) / safe;
  vec3 tlo = min(ta, tb);
  vec3 thi = max(ta, tb);
  return vec2(max(max(tlo.x, tlo.y), tlo.z), min(min(thi.x, thi.y), thi.z));
}
// A ray from o toward d: where it is in each volume, and when it is inside each and inside its crop.
Ray ray(vec3 o, vec3 d) {
  Ray r;
  r.o = o;
  r.d = d;
  r.t0 = 1e30;
  r.t1 = -1e30;
  for (int k = 0; k < N; ++k) {
    r.ov[k] = (uVoxFromWorld[k] * vec4(o, 1.0)).xyz;
    r.dv[k] = mat3(uVoxFromWorld[k]) * d;
    r.vox[k] = 1.0 / max(length(r.dv[k]), 1e-12);
    vec2 s = slab(r.ov[k], r.dv[k], max(vec3(-0.5), uCropLo[k]), min(uDims[k] - 0.5, uCropHi[k]));
    r.tin[k] = max(s.x, 0.0);
    r.tout[k] = s.y;
    if (r.tout[k] > r.tin[k]) {
      r.t0 = min(r.t0, r.tin[k]);
      r.t1 = max(r.t1, r.tout[k]);
    }
  }
  return r;
}
// The ray's helpers read it in place (macros): passing a Ray, arrays and all, to a function copies it at every step.
#define INSIDE(r, j, t) ((t) >= r.tin[j] && (t) < r.tout[j])
// The voxel (world units) of the finest volume the ray is in at t; 1e30: none.
#define FINEST(r, t, m) m = 1e30; for (int j_ = 0; j_ < N; ++j_) { if (INSIDE(r, j_, t)) m = min(m, r.vox[j_]); }
// Where the ray next enters a volume after t (1e30: none).
#define NEXT_IN(r, t, n) n = 1e30; for (int j_ = 0; j_ < N; ++j_) { if (r.tout[j_] > r.tin[j_] && r.tin[j_] > (t)) n = min(n, r.tin[j_]); }
// How far the ray goes from t through bricks every volume it is in leaves clear, cut short where it enters another; 0: not clear.
#define CLEAR_RUN(r, t, run) run = 1e30; for (int j_ = 0; j_ < N; ++j_) { if (INSIDE(r, j_, t)) run = min(run, clearRun(j_, r.ov[j_] + r.dv[j_] * (t), r.dv[j_])); } { float n2_; NEXT_IN(r, t, n2_) run = run >= 1e29 ? 0.0 : min(run, n2_ - (t)); }
// The extinction at t: the sum of every volume's the ray is in there.
#define SIGMA(r, t, s) s = 0.0; { vec3 w_ = r.o + r.d * (t); for (int j_ = 0; j_ < N; ++j_) { if (INSIDE(r, j_, t)) s += sigma(j_, w_, r.ov[j_] + r.dv[j_] * (t)); } }
// World point w is cut away from volume k.
bool clipped(int k, vec3 w) {
  for (int i = 0; i < ${MAX_CLIPS}; ++i) {
    if (i >= uNClip[k]) break;
    vec4 c = uClips[k * ${MAX_CLIPS} + i];
    if (dot(c.xyz, w) + c.w < 0.0) return true;
  }
  return false;
}
// The extinction of volume k at world point w, voxel point v.
float sigma(int k, vec3 w, vec3 v) { return clipped(k, w) ? 0.0 : uDensity[k] * tf(k, tex(k, v)).a; }
// In a brick of volume k that its table leaves clear, how far (world units) a ray (dv voxels a world unit) at voxel
// point v goes before it leaves the brick; else 0.
float clearRun(int k, vec3 v, vec3 dv) {
  if (!uHasOcc[k]) return 0.0;
  vec3 cell = floor((v + 0.5) / ${BRICK}.0);
  if (occupied(k, cell)) return 0.0;
  vec3 safe = safeDir(dv);
  vec3 side = cell * ${BRICK}.0 - 0.5 + ${BRICK}.0 * step(0.0, safe);
  vec3 leave = (side - v) / safe;
  return max(min(min(leave.x, leave.y), leave.z), 0.0);
}
// The transmittance from world point w toward dir (unit), from 1.5 voxels to reach voxels away (of the volume it starts in).
float clear(vec3 w, vec3 dir, float reach) {
  Ray r = ray(w, dir);
  float vox;
  FINEST(r, 0.0, vox)
  if (vox >= 1e29) return 1.0;
  float T = 1.0;
  float before = 0.0;
  for (float d = 1.5; d < reach; d *= 2.0) {
    float t = d * vox;
    float s;
    SIGMA(r, t, s)
    T *= exp(-s * (d - before) * vox);
    before = d;
  }
  return T;
}
vec3 env(vec3 d) {
  float u = dot(d, uEnvUp);
  return (u > 0.0 ? uEnvHorizon * (1.0 - u) + uEnvTop * u : uEnvHorizon * (1.0 + u) + uEnvBottom * (-u)) * uEnvScale;
}
float hg(float c, float g) {
  float d = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (12.566371 * d * sqrt(d));
}
float phongExp(int k) { return max(1.0, 2.0 / max(uRoughness[k] * uRoughness[k], 1e-4) - 2.0); }
vec3 brdfCos(int k, vec3 n, vec3 wo, vec3 wl, vec3 albedo) {
  float cl = dot(n, wl);
  if (cl <= 0.0) return vec3(0.0);
  vec3 h = normalize(wo + wl);
  float e = phongExp(k);
  float s = uSpecular[k] * (e + 8.0) / 25.132741 * pow(max(dot(n, h), 0.0), e);
  return (albedo * ((1.0 - uSpecular[k]) * 0.31830989) + vec3(s)) * cl;
}
`;
};

// Random numbers and directions, for the light held and the path tracer.
const RANDOM = `uint rs;
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float rnd() {
  rs = pcg(rs);
  return float(rs >> 8u) * (1.0 / 16777216.0);
}
mat3 basis(vec3 n) {
  vec3 a = abs(n.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(a, n));
  return mat3(t, cross(n, t), n);
}
vec3 sphere() {
  float z = 1.0 - 2.0 * rnd();
  float r = sqrt(max(0.0, 1.0 - z * z));
  float ph = 6.2831853 * rnd();
  return vec3(r * cos(ph), r * sin(ph), z);
}
vec3 cosdir(vec3 n) {
  float u1 = rnd();
  float r = sqrt(u1);
  float ph = 6.2831853 * rnd();
  return normalize(basis(n) * vec3(r * cos(ph), r * sin(ph), sqrt(max(0.0, 1.0 - u1))));
}
vec3 hgdir(vec3 w, float g) {
  float u1 = rnd();
  float c = 1.0 - 2.0 * u1;
  if (abs(g) >= 1e-3) {
    float s = (1.0 - g * g) / (1.0 - g + 2.0 * g * u1);
    c = (1.0 + g * g - s * s) / (2.0 * g);
  }
  float sn = sqrt(max(0.0, 1.0 - c * c));
  float ph = 6.2831853 * rnd();
  return normalize(basis(w) * vec3(sn * cos(ph), sn * sin(ph), c));
}
// The transmittance from world point w toward dir (unit) to where it leaves every volume, a voxel (of the volume it
// is in) a step.
float transmit(vec3 w, vec3 dir) {
#ifdef CUT_SHADOW
  return 1.0;
#endif
#ifdef GEO
  // A surface in the way: none of the light.
  if (geoAny(w, dir, uGeoEps, 1e30)) return 0.0;
#endif
  Ray r = ray(w, dir);
  float tau = 0.0;
  float v0;
  FINEST(r, r.t0, v0)
  float t = r.t0 + 0.5 * (v0 < 1e29 ? v0 : 0.0);
  for (int i = 0; i < 4096; ++i) {
    if (t >= r.t1 || tau > 8.0) break;
    float dt;
    FINEST(r, t, dt)
    if (dt >= 1e29) {
      float n_;
      NEXT_IN(r, t, n_)
      t = n_;
      continue;
    }
    float run;
    CLEAR_RUN(r, t, run)
    if (run > 0.0) {
      t += max(ceil(run / dt), 1.0) * dt;
      continue;
    }
    float s;
    SIGMA(r, t, s)
    tau += s * dt;
    t += dt;
  }
  return exp(-tau);
}
// Moves world point w to where a ray toward dir first scatters (where its optical depth reaches -log(1 - u),
// stepVox voxels a step), and says which volume it is in there; false when it leaves every volume first.
bool collideTo(inout vec3 w, out int at, vec3 dir, float stepVox, float tmax) {
  Ray r = ray(w, dir);
  float tEnd = min(r.t1, tmax);
  float target = -log(1.0 - rnd());
  float tau = 0.0;
  at = -1;
  float v0;
  FINEST(r, r.t0, v0)
  float t = r.t0 + stepVox * (v0 < 1e29 ? v0 : 0.0) * rnd();
  for (int i = 0; i < 8192; ++i) {
    if (t >= tEnd) return false;
    float vox;
    FINEST(r, t, vox)
    if (vox >= 1e29) {
      float n_;
      NEXT_IN(r, t, n_)
      t = n_;
      continue;
    }
    float dt = stepVox * vox;
    float run;
    CLEAR_RUN(r, t, run)
    if (run > 0.0) {
      t += max(ceil(run / dt), 1.0) * dt;
      continue;
    }
    float s;
    SIGMA(r, t, s)
    tau += s * dt;
    if (tau >= target) {
      w = r.o + r.d * t;
      // The volume that scattered it: each in its share of the extinction there.
      float pick = rnd() * s;
      for (int j = 0; j < N; ++j) {
        if (!INSIDE(r, j, t)) continue;
        at = j;
        pick -= sigma(j, w, r.ov[j] + r.dv[j] * t);
        if (pick <= 0.0) break;
      }
      return true;
    }
    t += dt;
  }
  return false;
}
bool collide(inout vec3 w, out int at, vec3 dir, float stepVox) { return collideTo(w, at, dir, stepVox, 1e30); }
#ifdef GEO
// What a ray from w toward dir meets first: 0 nothing (it leaves); 1 the volumes, scattering in volume at (w moved
// there); 2 a surface (w moved there; its normal facing the ray, and its colour).
int scatterEvent(inout vec3 w, out int at, out vec3 sn, out vec3 sc, vec3 dir, float stepVox) {
  int prim;
  vec2 uv;
  sn = vec3(0.0);
  sc = vec3(0.0);
#ifdef CUT_GEO
  float ts = -1.0;
  prim = 0;
  uv = vec2(0.0);
#else
  float ts = geoHit(w, dir, uGeoEps, 1e30, prim, uv);
#endif
  vec3 w0 = w;
#ifndef CUT_VOLUME
  if (collideTo(w, at, dir, stepVox, ts > 0.0 ? ts : 1e30)) return 1;
#endif
  if (ts < 0.0) return 0;
  geoSurface(prim, uv, w0, dir, ts, sn, sc);
  w = w0 + dir * ts + sn * uGeoEps;
  return 2;
}
// A direction off a surface (normal n, toward wo): a glossy lobe about the mirror direction at its specular
// share, else cosine-weighted (the throughput then takes the colour); false: below the surface.
bool geoBounce(vec3 n, vec3 wo, vec3 albedo, inout vec3 thr, out vec3 nd) {
  if (rnd() < geoSpec) {
    vec3 rf = normalize(n * (2.0 * dot(n, wo)) - wo);
    float e = max(1.0, 2.0 / max(geoRough * geoRough, 1e-4) - 2.0);
    float ct = pow(rnd(), 1.0 / (e + 1.0));
    float st = sqrt(max(0.0, 1.0 - ct * ct));
    float ph = 6.2831853 * rnd();
    nd = normalize(basis(rf) * vec3(st * cos(ph), st * sin(ph), ct));
    return dot(nd, n) > 0.0;
  }
  nd = cosdir(n);
  thr *= albedo;
  return true;
}
#endif
// Where world point w is in volume k (voxels).
vec3 voxOf(int k, vec3 w) { return (uVoxFromWorld[k] * vec4(w, 1.0)).xyz; }`;

// The tone map (pathtrace.wgsl tonemap), and the dither that shares pixels between two images.
const TONE = `vec3 tone(vec3 c) {
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  c = clamp(c, 0.0, 1.0);
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float noise() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }`;

// Each pixel's ray through the volumes, from the camera of this frame. Light as the path tracer's
// (pathtrace.wgsl: brdf_cos, hg, envlight), from the light held for the object; until it is, the
// light's through a short ray toward it and the surroundings' through one along the surface's normal.
const FS = (o: Frame3d["outputs"], n: number, geoW = 0) => one(n, `#version 300 es
${COMMON(n)}
${TONE}
${geoW ? `#define GEO
${geometryGlsl(geoW, MAX_CLIPS)}` : ""}
uniform highp sampler3D uLight;
uniform bool uHasLight;
uniform float uHeldAround;
uniform mat4 uInvVP;
uniform mat4 uVP;
uniform vec4 uViewport;
uniform float uStep;
uniform float uExposure;
uniform vec2 uBand;
layout(location = ${o.color}) out vec4 out_color;
layout(location = ${o.z}) out highp vec4 out_z;
layout(location = ${o.pick}) out highp vec4 out_pickId;

vec4 lightAt(vec3 w) { return texture(uLight, (w - uLightLo) / (uCellW * vec3(textureSize(uLight, 0)))); }
// The light sent toward the camera (along -dw) from world point w: its colour, the way its value rises (world),
// how much it is a surface, and the material of volume k (the one with the most extinction there).
vec3 shade(int k, vec3 w, vec3 albedo, vec3 gw, float edge, vec3 dw, vec3 around) {
  vec3 up = length(gw) > 1e-12 ? normalize(gw) : vec3(0.0);
  // The light held, half a cell out from a surface (so the tissue beneath it does not shade it): the
  // light's share once it has been marched; the surroundings' coming in as paths gather (a few paths a
  // cell are blotchy), short rays standing in until then.
  vec4 held = uHasLight ? lightAt(w - up * (0.5 * uCellW * edge)) : vec4(0.0);
  float Tl = uHasLight ? held.a : clear(w, uLightDir, 25.0);
  // One ray stands for the path tracer's many directions to the surroundings: it shades only in part.
  vec3 amb = uHeldAround < 1.0 ? albedo * around * (0.35 + 0.65 * clear(w, uEnvUp, 13.0)) : vec3(0.0);
  amb = mix(amb, held.rgb, uHeldAround);
  vec3 col = albedo * (uLightRgb * (hg(dot(dw, uLightDir), uPhaseG[k]) * Tl) + amb);
  if (edge > 1e-6 && length(gw) > 1e-12) {
    vec3 nrm = -up;
    if (dot(nrm, dw) > 0.0) nrm = -nrm;
    // What is held is the mean over every direction, the tissue's own light among it.
    vec3 sky = uHeldAround < 1.0 ? env(nrm) * (0.35 + 0.65 * clear(w, nrm, 13.0)) : vec3(0.0);
    sky = mix(sky, held.rgb, uHeldAround);
    vec3 surf = brdfCos(k, nrm, -dw, uLightDir, albedo) * uLightRgb * Tl + albedo * sky * (1.0 - uSpecular[k]);
    col = mix(col, surf, uShadeMix[k] * edge);
  }
  return col;
}
void main() {
  // The pixels this image draws while another (the path-traced one) comes in over it.
  float kn = noise();
  if (kn < uBand.x || kn >= uBand.y) discard;
  vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec4 a = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 ow = a.xyz / a.w;
  vec3 far = b.xyz / b.w;
  vec3 dw = normalize(far - ow);
  Ray r = ray(ow, dw);
  float t1 = min(r.t1, length(far - ow));
  // The surfaces, nearest first (met as solid: each blended in at its opacity): the volumes are marched up to
  // each, then on from it.
  float tEnd = length(far - ow);
  float tVol = t1;
  float ts = -1.0;
  int sPrim = -1;
  vec2 sUv = vec2(0.0);
#ifdef GEO
  geoSolid = true;
  ts = geoHit(ow, dw, 0.0, tEnd, sPrim, sUv);
  if (ts > 0.0) t1 = min(tVol, ts);
#endif
  if (t1 <= r.t0 && ts < 0.0) discard;
  vec3 around = (uEnvTop + 2.0 * uEnvHorizon + uEnvBottom) * (0.25 * uEnvScale);
  vec3 L = vec3(0.0);
  float T = 1.0;
  vec3 hit = vec3(0.0);
  bool met = false;
  float pick = 0.0;
  // The volumes met (their picture opaque there); else the surfaces' coverage.
  bool volMet = false;
  float v0;
  FINEST(r, r.t0, v0)
  float t = r.t0 + uStep * (v0 < 1e29 ? v0 : 0.0) * noise();
  for (int seg = 0; seg < 3; ++seg) {
  for (int i = 0; i < 4096; ++i) {
    if (t >= t1 || T < 0.02) break;
    float vox;
    FINEST(r, t, vox)
    if (vox >= 1e29) {
      float n_;
      NEXT_IN(r, t, n_)
      t = n_;
      continue;
    }
    float dt = uStep * vox;
    // Bricks every volume here leaves clear: on to where the ray leaves them, at the same phase of the steps.
    float run;
    CLEAR_RUN(r, t, run)
    if (run > 0.0) {
      t += max(ceil(run / dt), 1.0) * dt;
      continue;
    }
    vec3 w = r.o + r.d * t;
    // Every volume here: their extinctions add, their colours, gradients and surfaces each in its share; lit once.
    float s = 0.0;
    float most = 0.0;
    int km = 0;
    vec3 albedo = vec3(0.0);
    vec3 gw = vec3(0.0);
    float edge = 0.0;
    for (int k = 0; k < N; ++k) {
      if (!INSIDE(r, k, t)) continue;
      vec3 v = r.ov[k] + r.dv[k] * t;
      if (clipped(k, w)) continue;
      vec4 c = tf(k, tex(k, v));
      float sk = uDensity[k] * c.a;
      if (sk <= 0.0) continue;
      vec3 g = grad(k, v);
      s += sk;
      albedo += sk * c.rgb * uAlbedo[k];
      gw += sk * worldGrad(k, g);
      edge += sk * (1.0 - exp(-uGradScale[k] * length(g)));
      if (sk > most) {
        most = sk;
        km = k;
      }
    }
    t += dt;
    if (s <= 0.0) continue;
    vec3 col = shade(km, w, albedo / s, gw / s, edge / s, dw, around);
    float al = 1.0 - exp(-s * dt);
    L += T * al * col;
    T *= 1.0 - al;
    if (!volMet && T <= 0.5) {
      volMet = true;
      if (!met) {
        met = true;
        hit = w;
      }
    }
  }
#ifdef GEO
  if (ts <= 0.0 || T < 0.02) break;
  {
    // The surface, lit as the volume is: the key light (the nearest surface's shadow from the surfaces, then through
    // the volumes as held; those behind it as held), and the surroundings' by its normal.
    vec3 w = ow + dw * ts;
    vec3 nrm;
    vec3 albedo;
    geoSurface(sPrim, sUv, ow, dw, ts, nrm, albedo);
    float op = geoOpac;
    vec3 p = w + nrm * (1e-5 * ts);
    // (The light held includes the surfaces' shadows, softly: read half a cell out, off the surface's own.)
    float held = uHasLight ? lightAt(p + nrm * (0.5 * uCellW)).a : clear(p, uLightDir, 25.0);
    float Tl = seg == 0 && geoAny(p, uLightDir, uGeoEps, 1e30) ? 0.0 : held;
    vec3 sky = env(nrm);
    sky = mix(sky, uHasLight ? lightAt(p + nrm * (0.5 * uCellW)).rgb : sky, uHeldAround * 0.5);
    vec3 col = geoBrdfCos(nrm, -dw, uLightDir, albedo) * uLightRgb * Tl + albedo * (sky * (1.0 - geoSpec) + geoEmit);
    L += T * op * col;
    if (!met) {
      met = true;
      hit = w;
      // The surface is what the pixel shows first: its segment picked there.
      pick = geoPickOf(geoObjectOf(sPrim));
    }
    T *= 1.0 - op;
  }
  if (T < 0.02) break;
  // The next surface behind it; the volumes on from it.
  t = max(t, ts);
  ts = geoHit(ow, dw, ts + uGeoEps, tEnd, sPrim, sUv);
  t1 = ts > 0.0 ? min(tVol, ts) : tVol;
#else
  break;
#endif
  }
  // As the picture: drawn where the ray met tissue, at the depth where it did.
  if (!met) discard;
  vec3 c = tone(L / max(1.0 - T, 1e-6) * uExposure);
  vec4 p = uVP * vec4(hit, 1.0);
  float d = clamp((p.z / p.w) * 0.5 + 0.5, 0.0, 0.99999);
  gl_FragDepth = d;
  // Opaque where the volumes are met; else as much as the surfaces cover (blended where the GPU can).
  out_color = vec4(c, volMet ? 1.0 : 1.0 - T);
  out_z = vec4(1.0 - d);
  out_pickId = vec4(pick);
}`);

// One layer of the light held, a cell a pixel. Pass 0: how much of the light reaches the cell's centre
// (alpha). Later passes: one path from a point in the cell in a direction from all round, as the path
// tracer's (up to three scatterings, the light at each through what pass 0 found, the surroundings
// where it leaves), averaged into what the passes before found (colour).
const BAKE_FS = (n: number, geoW = 0) => one(n, `#version 300 es
${COMMON(n)}
${geoW ? `#define GEO
${geometryGlsl(geoW, MAX_CLIPS)}` : ""}
${RANDOM}
uniform highp sampler3D uPrev;
uniform int uLayer;
uniform int uPass;
uniform uint uSeed;
out vec4 o;

float lightAt(vec3 w) { return texture(uPrev, (w - uLightLo) / (uCellW * vec3(textureSize(uPrev, 0)))).a; }
// The light arriving at world point w from direction -dir (dir: the way the path goes out from it).
vec3 incoming(vec3 w, vec3 dir) {
  vec3 thr = vec3(1.0);
  vec3 L = vec3(0.0);
  for (int bounce = 0; bounce < 3; ++bounce) {
    int k;
#ifdef GEO
    vec3 sn, sc;
    int ev = scatterEvent(w, k, sn, sc, dir, 1.5);
    if (ev == 0) return L + thr * env(dir);
    if (ev == 2) {
      // A surface (those less than opaque met by chance): the key light on it and its own, then on off it.
      L += thr * (geoBrdfCos(sn, -dir, uLightDir, sc) * uLightRgb * transmit(w, uLightDir) + sc * geoEmit);
      vec3 nd;
      if (!geoBounce(sn, -dir, sc, thr, nd)) return L;
      dir = nd;
      continue;
    }
#else
    if (!collide(w, k, dir, 1.5)) return L + thr * env(dir);
#endif
    vec3 vk = voxOf(k, w);
    thr *= tf(k, tex(k, vk)).rgb * uAlbedo[k];
    L += thr * uLightRgb * (hg(dot(dir, uLightDir), uPhaseG[k]) * lightAt(w));
    dir = hgdir(dir, uPhaseG[k]);
  }
  return L;
}
void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  rs = pcg(uint(cell.x) + 1024u * uint(cell.y) + 1048576u * uint(cell.z)) ^ pcg(uSeed);
  vec3 w = uLightLo + (vec3(cell) + 0.5) * uCellW;
  if (uPass == 0) {
    o = vec4(0.0, 0.0, 0.0, transmit(w, uLightDir));
    return;
  }
  vec4 prev = texelFetch(uPrev, cell, 0);
  vec3 at = w + (vec3(rnd(), rnd(), rnd()) - 0.5) * uCellW;
  float a = prev.a;
#ifdef GEO
  // Surfaces much thinner than a cell: the light reaching the cell is the mean over points in it, not its centre's.
  a = mix(prev.a, transmit(at, uLightDir), 1.0 / float(uPass + 1));
#endif
  o = vec4(mix(prev.rgb, incoming(at, sphere()), 1.0 / float(uPass)), a);
}`);

// One sample a pixel of the view at rest, path-traced as pathtrace.wgsl's trace (the same light,
// surface and volume scattering, bounces and roulette), added to the samples before: colour and
// coverage (a path that met tissue), and the depth where the pixel's ray first meets tissue and the
// samples taken. Only the rows uRow of every uRows are traced in a pass; the others are copied.
const TRACE_FS = (n: number, geoW = 0) => one(n, `#version 300 es
${GPU_CUTS.map((c) => `#define CUT_${c.toUpperCase()}`).join("\n")}
${COMMON(n)}
${geoW ? `#define GEO
${geometryGlsl(geoW, MAX_CLIPS)}` : ""}
${RANDOM}
uniform sampler2D uPrevSum;
uniform sampler2D uPrevAux;
uniform mat4 uInvVP;
uniform mat4 uVP;
uniform vec2 uSize;
uniform uint uSeed;
uniform int uRows;
uniform int uRow;
uniform int uMaxBounces;
layout(location = 0) out vec4 oSum;
layout(location = 1) out vec4 oAux;

// The GL depth where the ray first meets tissue (half its light gone), half a voxel a step; 1 for none.
float glDepth(vec3 w) {
  vec4 p = uVP * vec4(w, 1.0);
  return clamp((p.z / p.w) * 0.5 + 0.5, 0.0, 0.99999);
}
// The depth where the ray first meets tissue or a surface; the surface's object + 1 when it is one (else 0).
float firstHit(vec3 ow, vec3 dw, out float obj) {
  float tsurf = 1e30;
  obj = 0.0;
  float sObj = 0.0;
#ifdef GEO
  {
    int p_;
    vec2 c_;
    // The camera's ray meets a surface less than opaque as solid (as the trace's first step does): by the layer's
    // chance instead, the same pixels missed it in every pass, and were left out (a fixed speckle).
    geoSolid = true;
    float h = geoHit(ow, dw, 0.0, 1e30, p_, c_);
    if (h > 0.0) {
      tsurf = h;
      sObj = float(geoObjectOf(p_) + 1);
    }
  }
#endif
  Ray r = ray(ow, dw);
  float T = 1.0;
  float t = r.t0;
  for (int i = 0; i < 8192; ++i) {
    if (t >= min(r.t1, tsurf)) break;
    float vox;
    FINEST(r, t, vox)
    if (vox >= 1e29) {
      float n_;
      NEXT_IN(r, t, n_)
      t = n_;
      continue;
    }
    float dt = 0.5 * vox;
    float run;
    CLEAR_RUN(r, t, run)
    if (run > 0.0) {
      t += max(ceil(run / dt), 1.0) * dt;
      continue;
    }
    float s;
    SIGMA(r, t, s)
    T *= exp(-s * dt);
    if (T <= 0.5) return glDepth(ow + dw * t);
    t += dt;
  }
  if (tsurf >= 1e30) return 1.0;
  obj = sObj;
  return glDepth(ow + dw * tsurf);
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 sum = texelFetch(uPrevSum, px, 0);
  vec4 aux = texelFetch(uPrevAux, px, 0);
  if (px.y % uRows != uRow) {
    oSum = sum;
    oAux = aux;
    return;
  }
  rs = pcg(uint(px.x) + 8192u * uint(px.y)) ^ pcg(uSeed);
  vec2 jitter = aux.g == 0.0 ? vec2(0.5) : vec2(rnd(), rnd());
  vec2 ndc = (vec2(px) + jitter) / uSize * 2.0 - 1.0;
  vec4 a = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 w = a.xyz / a.w;
  vec3 dir = normalize(b.xyz / b.w - w);
#ifndef CUT_FIRST
  if (aux.g == 0.0) {
    float ob;
    aux.r = firstHit(w, dir, ob);
    aux.b = ob;
  }
#endif
  vec3 L = vec3(0.0);
  vec3 thr = vec3(1.0);
  float alpha = 0.0;
  // Surfaces less than opaque passed through (not bounces).
  int passes = 0;
  for (int step_ = 0; step_ <= 48; ++step_) {
    int bounce = step_ - passes;
#ifdef CUT_BOUNCES
    if (bounce > 0) break;
#endif
    if (bounce > uMaxBounces || bounce > 16) break;
    int k;
#ifdef GEO
    // The camera's ray meets each surface (its light at its opacity, then through it as often as it is clear);
    // a bounce's passes those less than opaque by chance, as a shadow ray does (cheaper: no ray begun again).
    geoSolid = bounce == 0;
    vec3 sn, sc;
    int ev = scatterEvent(w, k, sn, sc, dir, 0.5);
    if (ev == 0) {
      if (bounce > 0) L += thr * env(dir);
      break;
    }
    if (ev == 2) {
      // A surface: the key light on it (shadowed by surfaces and the volumes) and its own, at its opacity; then on
      // through it as often as it is clear, else a bounce off it. (Met by chance: opaque, as it was met.)
      float op = geoSolid ? geoOpac : 1.0;
      // (A shadow ray at a surface much less than opaque only now and then, weighted to the same mean.)
      float pd = max(op, 0.3);
      if (pd >= 1.0 || rnd() < pd) {
        float Ts = transmit(w, uLightDir);
        if (Ts > 0.0) L += thr * (op / pd) * geoBrdfCos(sn, -dir, uLightDir, sc) * uLightRgb * Ts;
      }
      L += thr * op * sc * geoEmit;
      if (op < 1.0 && rnd() >= op) {
        w -= sn * (2.0 * uGeoEps);
        ++passes;
        continue;
      }
      if (bounce == 0) alpha = 1.0;
      vec3 nd;
      if (!geoBounce(sn, -dir, sc, thr, nd)) break;
      dir = nd;
      if (bounce >= 2) {
        float q = min(0.95, max(thr.x, max(thr.y, thr.z)));
        if (rnd() > q) break;
        thr /= q;
      }
      continue;
    }
    if (bounce == 0) alpha = 1.0;
#else
    if (!collide(w, k, dir, 0.5)) {
      if (bounce > 0) L += thr * env(dir);
      break;
    }
    if (bounce == 0) alpha = 1.0;
#endif
    vec3 v = voxOf(k, w);
    vec3 albedo = tf(k, tex(k, v)).rgb * uAlbedo[k];
    vec3 g = grad(k, v);
    float gm = length(g);
    if (uInset[k] > 0.0 && gm > 1e-6) {
      // The colour a little way along the gradient, on the more opaque side: the tissue beneath a surface. Only
      // where the collision lies in a surface's partial volume (under 0.3 of the opacity of the tissue beneath it),
      // as pathtrace.wgsl does: everywhere, every point beside a thin bright line took the line's colour, and lines
      // and edges spread out to both sides as the path-traced picture came in.
      vec3 d = g * (uInset[k] / gm);
      vec4 ca = tf(k, tex(k, v + d));
      vec4 cb = tf(k, tex(k, v - d));
      if (tf(k, tex(k, v)).a < 0.3 * max(ca.a, cb.a)) albedo = (ca.a >= cb.a ? ca : cb).rgb * uAlbedo[k];
    }
    float psurf = uShadeMix[k] * (1.0 - exp(-uGradScale[k] * gm));
    vec3 wo = -dir;
    float Tl = transmit(w, uLightDir);
    if (rnd() < psurf) {
      vec3 nrm = -normalize(worldGrad(k, g));
      if (dot(nrm, wo) < 0.0) nrm = -nrm;
      if (Tl > 0.0) L += thr * brdfCos(k, nrm, wo, uLightDir, albedo) * uLightRgb * Tl;
      vec3 nd;
      if (rnd() < uSpecular[k]) {
        vec3 rf = normalize(nrm * (2.0 * dot(nrm, wo)) - wo);
        float ct = pow(rnd(), 1.0 / (phongExp(k) + 1.0));
        float st = sqrt(max(0.0, 1.0 - ct * ct));
        float ph = 6.2831853 * rnd();
        nd = normalize(basis(rf) * vec3(st * cos(ph), st * sin(ph), ct));
        if (dot(nd, nrm) <= 0.0) break;
      } else {
        nd = cosdir(nrm);
        thr *= albedo;
      }
      dir = nd;
    } else {
      if (Tl > 0.0) L += thr * albedo * uLightRgb * (hg(dot(dir, uLightDir), uPhaseG[k]) * Tl);
      thr *= albedo;
      dir = hgdir(dir, uPhaseG[k]);
    }
    if (bounce >= 2) {
      float q = min(0.95, max(thr.x, max(thr.y, thr.z)));
      if (rnd() > q) break;
      thr /= q;
    }
  }
  oSum = sum + vec4(L, alpha);
  oAux = vec4(aux.r, aux.g + 1.0, aux.b, 0.0);
}`);

// The path-traced samples so far in the 3-D view: their mean where most met tissue, at the depth where
// the pixel's ray first meets it, through the same tone map.
const COMPOSITE_FS = (o: Frame3d["outputs"]) => `#version 300 es
precision highp float;
uniform sampler2D uSum;
uniform sampler2D uAux;
uniform vec4 uViewport;
uniform float uExposure;
uniform vec2 uBand;
// Blended by coverage (where the colour output alone can be blended): the least drawn; else 0.5, opaque.
uniform float uMinCover;
layout(location = ${o.color}) out vec4 out_color;
layout(location = ${o.z}) out highp vec4 out_z;
layout(location = ${o.pick}) out highp vec4 out_pickId;
precision highp int;
${GEO_PICK_GLSL}
${TONE}
void main() {
  float k = noise();
  if (k < uBand.x || k >= uBand.y) discard;
  ivec2 px = ivec2(gl_FragCoord.xy - uViewport.xy);
  vec4 s = texelFetch(uSum, px, 0);
  vec4 ax = texelFetch(uAux, px, 0);
  vec2 a = ax.rg;
  float cover = a.g >= 1.0 ? s.a / a.g : 0.0;
  if (cover < uMinCover || s.a <= 0.0 || a.r >= 1.0) discard;
  gl_FragDepth = a.r;
  // Where only some of a pixel's paths met something (a dendrite thinner than the pixel): that share of it.
  out_color = vec4(tone(s.rgb / s.a * uExposure), uMinCover < 0.5 ? cover : 1.0);
  out_z = vec4(1.0 - a.r);
  // A surface first met there: its segment picked.
  out_pickId = vec4(ax.b > 0.0 ? geoPickOf(int(ax.b) - 1) : 0.0);
}`;

/**
 * One volume: its uniforms indexed by a constant, not by the volume a sample is in (which a compiler cannot know is
 * always the first), so they are read as plainly as a single volume's always were.
 */
function one(n: number, src: string): string {
  return n === 1 ? src.replace(/\[(k|j_)\]/g, "[0]") : src;
}

/** The shaders' sources for `n` volumes (for checking that they compile, and for the drawer). */
export const SHADERS = { VS, FS, BAKE_FS, TRACE_FS, COMPOSITE_FS };

/** The light held for the object, as it is being path-traced: two textures, one filled while the other is read. */
interface Held {
  key: string;
  /** The light's direction and the surroundings' up (world) when it was set: fixed to the object since. */
  lightDir: number[];
  envUp: number[];
  /** Passes done, and the layer of the pass under way and the row in it. */
  pass: number;
  layer: number;
  row: number;
}

/**
 * The GPU's work kept to a frame or so at a time, so that no submission runs long enough for the GPU's watchdog to
 * reset it (losing the context: on a GPU that also drives a display, a few seconds): one batch in flight (a fence
 * after it; nothing more sent until it is done), and in how many frames it was seen done, for sizing the next.
 * Frames, not milliseconds: a fence can only be looked at when a frame is drawn, so the time to the frame it is seen
 * done in says as much about the frames (which other work may make long) as about the batch.
 */
export class GpuPacer {
  private sync: WebGLSync | null = null;
  private frames = 0;

  /**
   * Whether the last batch is done, looked at once a frame: then in how many frames (1: by the next frame; null
   * when there was none); undefined while it is not.
   */
  done(gl: WebGL2RenderingContext): number | null | undefined {
    if (this.sync === null) return null;
    this.frames++;
    if (gl.getSyncParameter(this.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return undefined;
    gl.deleteSync(this.sync);
    this.sync = null;
    return this.frames;
  }

  /** After a batch: a fence behind it. */
  sent(gl: WebGL2RenderingContext): void {
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.frames = 0;
  }

  /** Forgets a batch (its context lost or its work dropped). */
  reset(gl: WebGL2RenderingContext | undefined): void {
    if (this.sync !== null && gl && !gl.isContextLost()) gl.deleteSync(this.sync);
    this.sync = null;
  }
}

/** A batch done by the next frame: the next is made larger. Seen done only this many frames on: smaller. */
const SLOW_FRAMES = 3;

/**
 * Debugging the GPU's time (localStorage ngplatform.gputiming set): each batch of the light and of path tracing
 * waited for (a pixel read back) and its time logged as "[gpu] …". Slows drawing; for measuring only.
 */
const GPU_TIMING = (() => {
  try {
    return typeof localStorage !== "undefined" && !!localStorage.getItem("ngplatform.gputiming");
  } catch {
    return false;
  }
})();
/**
 * Debugging the trace's cost (localStorage ngplatform.gpucut, a comma list): parts of the path-tracing pass left
 * out, to time the rest: first (the first-hit depth), shadow (shadow rays: all lit), volume (the volume march),
 * geo (the surfaces), bounces (the first event only). The picture is then wrong; for measuring only.
 */
const GPU_CUTS: string[] = (() => {
  try {
    return typeof localStorage !== "undefined" ? (localStorage.getItem("ngplatform.gpucut") ?? "").split(",").map((x) => x.trim()).filter((x) => /^[a-z]+$/.test(x)) : [];
  } catch {
    return [];
  }
})();
/** Waits for the GPU (a pixel of framebuffer `fb` read back) and logs how long `what` took since `t0`. */
function gpuTimed(gl: WebGL2RenderingContext, fb: WebGLFramebuffer, t0: number, what: string): void {
  const was = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, was);
  console.log(`[gpu] ${what}: ${(performance.now() - t0).toFixed(1)} ms`);
}

/** One image held: its level once read, its bricks' bounds, and its textures on the GPU. */
interface Vol {
  url: string;
  /** The voxels it was read within. */
  voxels: number;
  level?: Level8;
  bounds?: Float32Array;
  /** What it says while being read, or why it could not be. */
  text: string;
  failed?: boolean;
  tex?: WebGLTexture;
  occ?: WebGLTexture;
  uploaded?: Level8;
  occKey?: string;
}

/** The voxels each image is read within, when `count` are drawn together within `voxels`: a share, but not too small a one. */
export function shareOf(voxels: number, count: number): number {
  return count <= 1 ? voxels : Math.max(voxels / count, Math.min(voxels, 32e6));
}

/** Texture units: the path tracing's sums and counts, the light held, the table, then each volume's level and bricks. */
const UNIT = { sum: 2, aux: 3, light: 4, tf: 5, vol: 6 };

export class LiveVolume {
  /** The look of a frame; undefined: nothing to draw it with. */
  look: ((frame: Frame3d) => LiveLook | undefined) | undefined;
  /** Called when a level is ready to draw or could not be read, and as the light held is refined. */
  onChange: (() => void) | undefined;
  /** Called while the light held is being path-traced: the view should be drawn again. */
  onRedraw: (() => void) | undefined;
  /** The images wanted, in the order asked for (the first is the one cropped by and lit for). */
  private wanted: string[] = [];
  private readonly vols = new Map<string, Vol>();
  /** The images still to read, one at a time. */
  private reading: Promise<void> = Promise.resolve();
  private gl: WebGL2RenderingContext | undefined;
  private programs = new Map<string, WebGLProgram>();
  private failed = "";
  private vao: WebGLVertexArrayObject | undefined;
  private tf: WebGLTexture | undefined;
  private tfKey = "";
  /** The light held: the textures read and filled, the grid they hold, the framebuffer filling them; none where floats cannot be drawn to. */
  private held: Held | undefined;
  private readonly bakePacer = new GpuPacer();
  private readonly tracePacer = new GpuPacer();
  /** Rows of the light's grid a batch (0: not yet sized). */
  private bakeRows = 0;
  private lightRead: WebGLTexture | undefined;
  private lightFill: WebGLTexture | undefined;
  private lightGridKey = "";
  private fb: WebGLFramebuffer | undefined;
  private canBake = false;
  /**
   * The view at rest, path-traced: the samples' sums (colour, coverage) and each pixel's depth and
   * count, read and filled in turn; the camera and look they are of, and since when it has been still.
   */
  private traced: Traced | undefined;
  private traceKey = "";
  private stillSince = 0;
  private settle: ReturnType<typeof setTimeout> | undefined;
  private sumRead: WebGLTexture | undefined;
  private sumFill: WebGLTexture | undefined;
  private auxRead: WebGLTexture | undefined;
  private auxFill: WebGLTexture | undefined;
  private traceSize = [0, 0];
  private traceFb: WebGLFramebuffer | undefined;
  /** The surfaces traced with the volumes (meshes: `putSurfaces`), and their textures. */
  private surfaces: Surfaces | undefined;
  private surfacesText = "";
  private readonly geoTex = new GeometryTextures();
  /** A volume of nothing about the surfaces, drawn when they are drawn alone (the shaders take at least one volume). */
  private empty: { key: string; vol: Vol } | undefined;

  /** What the object shows, or why it shows nothing. */
  get text(): string {
    const vols = this.wanted.map((u) => this.vols.get(u)).filter((v): v is Vol => v !== undefined);
    if (vols.length === 0 && !this.surfaces) return "";
    const one = vols.length === 1;
    const lines = vols.map((v) => (one ? v.text : `${v.text} (${shortName(v.url)})`));
    if (this.surfaces) lines.push(this.surfacesText);
    const base = this.failed ? `Object: ${this.failed}` : lines.join("\n");
    const h = this.held;
    if (this.failed || !this.ready() || h === undefined || !this.canBake) return base;
    const traced = this.traced && this.traced.samples >= 1 ? `; path-traced, ${Math.floor(this.traced.samples)} samples` : "";
    return `${base}\n${vols.length > 1 ? `${vols.length} images as one volume; ` : ""}light ${h.pass >= LIGHT_PASSES ? "done" : `${Math.max(0, h.pass - 1)} of ${LIGHT_PASSES - 1} passes`}${traced}`;
  }

  /**
   * Reads the levels to draw from the images at `urls` (once for each image and size; the others let go): the
   * finest of each within its share of `voxels`. The first is the one the crops are fractions of.
   */
  async open(urls: string | string[], voxels = LIVE_VOXELS): Promise<void> {
    const list = [...new Set(typeof urls === "string" ? [urls] : urls)].slice(0, MAX_VOLUMES);
    const each = shareOf(voxels, list.length);
    for (const [url, v] of this.vols) if (!list.includes(url) || v.voxels !== each) this.drop(url);
    this.wanted = list;
    this.failed = "";
    const todo = list.filter((u) => !this.vols.has(u));
    for (const url of todo) this.vols.set(url, { url, voxels: each, text: "Object: waiting to read the image" });
    if (todo.length === 0) return;
    this.onChange?.();
    const read = async (url: string) => {
      const v = this.vols.get(url);
      if (v === undefined || v.level !== undefined) return;
      const client = new VolumeClient();
      try {
        v.text = "Object: reading the image";
        this.onChange?.();
        const level = await readLevel(client, url, each, MAX_SIDE, (msg) => {
          v.text = `Object: ${msg}`;
          this.onChange?.();
        });
        if (this.vols.get(url) !== v) return;
        this.held = undefined;
        this.put(v, level);
      } catch (e) {
        if (this.vols.get(url) !== v) return;
        v.failed = true;
        v.text = `Object: ${(e as Error).message}`;
        this.onChange?.();
      } finally {
        client.dispose();
      }
    };
    // One at a time: several large images read at once would hold their chunks together.
    const run = this.reading.then(async () => {
      for (const url of todo) await read(url);
    });
    this.reading = run.catch(() => undefined);
    await run;
  }

  /** The level to draw, read already (by this browser's path tracer) from the image at `url`: drawn alone. */
  setLevel(level: Level8, url: string): void {
    for (const u of [...this.vols.keys()]) if (u !== url) this.drop(u);
    this.wanted = [url];
    this.failed = "";
    const v = this.vols.get(url) ?? { url, voxels: Math.round(level.size[0] * level.size[1] * level.size[2]), text: "" };
    this.vols.set(url, v);
    this.held = undefined;
    this.put(v, level);
  }

  private put(v: Vol, level: Level8): void {
    v.level = level;
    v.failed = false;
    v.bounds = undefined;
    v.text = `Object: level ${level.path} (${level.size.join(" × ")})`;
    this.onChange?.();
    void brickBounds(level.data, level.size, BRICK, () => v.level !== level || this.vols.get(v.url) !== v).then((data) => {
      if (v.level !== level || this.vols.get(v.url) !== v) return;
      v.bounds = data;
      this.onChange?.();
    });
  }

  /** Lets an image go, and its textures. */
  private drop(url: string): void {
    const v = this.vols.get(url);
    if (v === undefined) return;
    this.vols.delete(url);
    const gl = this.gl;
    if (gl) for (const t of [v.tex, v.occ]) if (t) gl.deleteTexture(t);
    this.held = undefined;
    this.tfKey = "";
  }

  ready(): boolean {
    return !this.failed && (this.surfaces !== undefined || this.wanted.some((u) => this.vols.get(u)?.level !== undefined));
  }

  /** Surfaces traced with the volumes (undefined: none); `text` says what they are. */
  putSurfaces(s: Surfaces | undefined, text = ""): void {
    if (this.surfaces === s) return;
    this.surfaces = s;
    this.surfacesText = text;
    this.held = undefined;
    this.onChange?.();
  }

  /** The surfaces held. */
  get heldSurfaces(): Surfaces | undefined {
    return this.surfaces;
  }

  /** A volume of nothing filling the surfaces' box (millimetres), for frames that draw the surfaces alone. */
  private emptyAbout(s: Surfaces): Vol {
    const lo = s.lo, hi = s.hi;
    const key = JSON.stringify([lo, hi]);
    if (this.empty?.key === key) return this.empty.vol;
    if (this.empty && this.gl) for (const t of [this.empty.vol.tex, this.empty.vol.occ]) if (t) this.gl.deleteTexture(t);
    const ext = [0, 1, 2].map((a) => Math.max(hi[a] - lo[a], 1e-9));
    const c = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
    const level: Level8 = { data: new Uint8Array([0]), size: [1, 1, 1], voxelToRas: [ext[0], 0, 0, c[0], 0, ext[1], 0, c[1], 0, 0, ext[2], c[2], 0, 0, 0, 1], range: [0, 255], pct: new Map(), window: undefined, path: "surfaces" };
    const vol: Vol = { url: "surfaces:", voxels: 1, level, text: "" };
    this.empty = { key, vol };
    return vol;
  }

  /** The level held for the first image, once read. */
  get heldLevel(): Level8 | undefined {
    return this.wanted.length ? this.vols.get(this.wanted[0])?.level : undefined;
  }

  /** The level held for the image at `url`, once read. */
  levelOf(url: string): Level8 | undefined {
    return this.vols.get(url)?.level;
  }

  /** Draws the frame; `split`: the share of pixels drawn (the rest are the picture's). False when it cannot be drawn. */
  draw(frame: Frame3d, split = 1): boolean {
    const look = this.failed ? undefined : this.look?.(frame);
    if (look === undefined) return false;
    const gl = frame.gl;
    // The GPU reset the page's drawing (a draw ran past its watchdog, or the driver restarted): nothing more can be
    // drawn in this context; said so, not as a texture too small (every limit reads 0 then).
    if (gl.isContextLost()) return this.fail("the GPU stopped this page's drawing (its WebGL context was lost): reload the page to draw again");
    if (this.gl !== gl) this.reset(gl);
    const maxSide = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    // The images of the look that are read (and fit this GPU), in its order.
    const asked = look.volumes;
    const shown: { vol: Vol; spec: LiveLook["volumes"][number] }[] = [];
    for (const spec of asked) {
      const vol = this.vols.get(spec.url);
      if (vol?.level === undefined) continue;
      if (Math.max(...vol.level.size) > maxSide) {
        vol.text = "Object: the level is larger than this GPU's 3-D textures";
        continue;
      }
      shown.push({ vol, spec });
      if (shown.length >= MAX_VOLUMES) break;
    }
    // The surfaces, where the look draws them: two texture units of their own, so a volume fewer.
    const surf = look.geometry !== undefined && this.surfaces !== undefined && this.surfaces.n > 0 ? this.surfaces : undefined;
    if (surf !== undefined) {
      if (shown.length >= MAX_VOLUMES) shown.length = MAX_VOLUMES - 1;
      const why = this.geoTex.upload(gl, surf, look.geometry!);
      if (why !== undefined) {
        this.surfacesText = `Surfaces: ${why}`;
        return false;
      }
      if (shown.length === 0) {
        const preset = { name: "Surfaces", domain: "data", stops: [], density: 0, exposure: look.geometry!.exposure } as unknown as LivePreset;
        shown.push({ vol: this.emptyAbout(surf), spec: { url: "surfaces:", preset, table: { rgba: new Float32Array(TF_SIZE * 4), key: "empty" }, crop: [[2, 2, 2], [-1, -1, -1]], clips: [] } });
      }
    }
    if (shown.length === 0) return false;
    const n = shown.length;
    const geoW = surf !== undefined ? geoWidth(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0;
    const program = this.program(gl, `fs ${n} ${geoW} ${JSON.stringify(frame.outputs)}`, () => FS(frame.outputs, n, geoW));
    if (program === undefined) return false;

    // Each image's level on the GPU, and its table's row and clear bricks.
    const tables = shown.map(({ vol, spec }) => spec.table?.rgba ?? liveTable(spec.preset, vol.level!));
    const tfKeys = shown.map(({ vol, spec }) => JSON.stringify([vol.url, vol.level!.path, spec.table?.key ?? null, spec.table ? null : [spec.preset.domain, spec.preset.stops, spec.preset.window ?? null]]));
    shown.forEach(({ vol }, i) => this.upload(gl, vol, tables[i], tfKeys[i]));
    const drawn: Drawn[] = shown.map(({ vol, spec }) => ({ vol, q: liveParams(look.view, spec.preset, vol.level!, spec.placement, { crop: spec.crop, clips: spec.clips, env: look.env }) }));
    const primary = drawn[0].q;
    // Finest first: where volumes overlap, a ray steps a voxel of the finest.
    const order = drawn.map((d, i) => ({ d, i, size: voxelWorldSize(d.q.worldFromVox) })).sort((a, b) => a.size - b.size || a.i - b.i);
    const sorted = order.map((o) => o.d);
    const tfKey = JSON.stringify(order.map((o) => tfKeys[o.i]));
    if (this.tfKey !== tfKey) {
      const rows = new Float32Array(TF_SIZE * 4 * n);
      order.forEach((o, row) => rows.set(tables[o.i], row * TF_SIZE * 4));
      gl.activeTexture(gl.TEXTURE0 + UNIT.tf);
      gl.bindTexture(gl.TEXTURE_2D, this.tf!);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, TF_SIZE, n, 0, gl.RGBA, gl.FLOAT, rows);
      this.tfKey = tfKey;
    }
    // The light held covers the surfaces too.
    const wfp = look.view.world_from_physical ? rowMajor(look.view.world_from_physical) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const about = surf ? [{ worldFromVox: colMajor(mul(wfp, this.emptyAbout(surf).level!.voxelToRas)), dims: [1, 1, 1] }] : [];
    const box = lightBox([...sorted.map((d) => d.q), ...about]);
    const gridKey = JSON.stringify(box.grid);
    if (this.lightGridKey !== gridKey) {
      for (const t of [this.lightRead!, this.lightFill!]) {
        gl.bindTexture(gl.TEXTURE_3D, t);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, box.grid[0], box.grid[1], box.grid[2], 0, gl.RGBA, gl.HALF_FLOAT, null);
      }
      this.lightGridKey = gridKey;
      this.held = undefined;
    }
    // What the light held depends on (not the camera): a change starts it again, the light set from the camera now.
    const light = look.view.light;
    const materials = sorted.map((d) => [d.vol.url, d.vol.level!.path, d.q.density, d.q.albedo, d.q.phaseG, d.q.worldFromVox, d.q.clips.slice(0, 4 * d.q.nclip), d.q.cropLo, d.q.cropHi]);
    // A light that turns with the camera: its direction to a degree or so, so a still camera keeps what is held.
    const dir = primary.lightDir.map((x) => Math.round(x * 50) / 50);
    const geoKey = surf ? [surf.n, surf.lo, surf.hi, look.geometry!.key, look.geometry!.layers] : null;
    const heldKey = JSON.stringify([tfKey, materials, geoKey, primary.lightRgb, primary.envTop, primary.envHorizon, primary.envBottom, primary.envScale, box, dir, light?.camera_space ?? true]);
    if (this.held?.key !== heldKey) this.held = { key: heldKey, lightDir: primary.lightDir, envUp: primary.envUp, pass: 0, layer: 0, row: 0 };
    primary.lightDir = this.held.lightDir;
    primary.envUp = this.held.envUp;
    // A ray leaving a surface starts 2e-5 of the scene away from it (float32 hits are good to about 1e-6 of it).
    const diag = box.cell * Math.hypot(...box.grid);
    const scene: Scene = { n, drawn: sorted, primary, box, geo: surf ? { surf, look: look.geometry!, geoFromWorld: invert(wfp), geoW, eps: 2e-5 * diag } : undefined };
    // A light that turns with the camera is held again once the camera rests; short rays stand in while it moves.
    const baking = !(look.lightFollows && frame.moving);
    if (this.canBake && baking && this.held.pass < LIGHT_PASSES) this.bakeSome(gl, scene);

    // The view at rest is path-traced, a pass a frame, once the camera has been still a moment; the
    // samples take the object's pixels from 4 samples on, all of them by 32.
    const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const max = Math.min(MAX_TRACED, look.view.max_samples ?? 256);
    const shading = sorted.map((d) => [d.q.shadeMix, d.q.gradScale, d.q.roughness, d.q.specular, d.q.inset]);
    const traceKey = JSON.stringify([heldKey, Array.from(frame.invViewProjection), vp[2], vp[3], shading, primary.maxBounces, max]);
    const now = performance.now();
    if (traceKey !== this.traceKey) {
      this.traceKey = traceKey;
      this.stillSince = now;
      this.traced = undefined;
    }
    if (this.canBake && !frame.moving && now - this.stillSince >= STILL_MS) this.traceSome(gl, scene, frame, vp[2], vp[3], max);
    else if (this.canBake) {
      // A frame after the camera stops, to start path-tracing it.
      clearTimeout(this.settle);
      this.settle = setTimeout(() => this.onRedraw?.(), STILL_MS + 20);
    }
    const r = Math.min(1, Math.max(0, ((this.traced?.samples ?? 0) - 4) / 28));
    const traced = r * r * (3 - 2 * r);

    if (traced < 1) {
      const p = program;
      const u = (name: string) => gl.getUniformLocation(p, name);
      gl.useProgram(p);
      this.common(gl, p, scene);
      gl.uniform4f(u("uViewport"), vp[0], vp[1], vp[2], vp[3]);
      gl.uniformMatrix4fv(u("uInvVP"), false, frame.invViewProjection);
      gl.uniformMatrix4fv(u("uVP"), false, frame.viewProjection);
      // A voxel a step while the camera moves, half a voxel at rest.
      gl.uniform1f(u("uStep"), frame.moving ? 1 : 0.5);
      gl.uniform1f(u("uExposure"), primary.exposure);
      gl.uniform2f(u("uBand"), 0, split * (1 - traced));
      // The light held: its light once marched (pass 0); its surroundings' coming in over passes 2 to 16.
      gl.activeTexture(gl.TEXTURE0 + UNIT.light);
      gl.bindTexture(gl.TEXTURE_3D, this.lightRead!);
      gl.uniform1i(u("uLight"), UNIT.light);
      const held = this.canBake && baking ? this.held.pass : 0;
      gl.uniform1i(u("uHasLight"), held >= 1 ? 1 : 0);
      gl.uniform1f(u("uHeldAround"), Math.min(1, Math.max(0, (held - 2) / 14)));
      // Surfaces less than opaque over nothing: the colour output blended by how much they cover, where it can be alone.
      gl.bindVertexArray(this.vao!);
      if (surf !== undefined) drawColourBlended(gl, frame.outputs.color, () => gl.drawArrays(gl.TRIANGLES, 0, 3), false);
      else gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const composite = traced > 0 ? this.program(gl, `composite ${JSON.stringify(frame.outputs)}`, () => COMPOSITE_FS(frame.outputs), true) : undefined;
    if (composite !== undefined) {
      const p = composite;
      const u = (name: string) => gl.getUniformLocation(p, name);
      gl.useProgram(p);
      gl.uniform4f(u("uViewport"), vp[0], vp[1], vp[2], vp[3]);
      gl.uniform1f(u("uExposure"), primary.exposure);
      gl.uniform2f(u("uBand"), split * (1 - traced), split);
      // The colour output blended by coverage (the depth and pick outputs not): blend.ts, in two passes where the
      // GPU cannot blend one output alone, so a pixel partly covered is never cut at half its paths (speckle).
      gl.uniform1f(u("uMinCover"), 0.02);
      gl.activeTexture(gl.TEXTURE0 + UNIT.sum);
      gl.bindTexture(gl.TEXTURE_2D, this.sumRead!);
      gl.uniform1i(u("uSum"), UNIT.sum);
      gl.activeTexture(gl.TEXTURE0 + UNIT.aux);
      gl.bindTexture(gl.TEXTURE_2D, this.auxRead!);
      gl.uniform1i(u("uAux"), UNIT.aux);
      bindPicks(gl, p, look.geometry ?? { colours: new Float32Array(), key: "", layers: [], exposure: 1 });
      gl.bindVertexArray(this.vao!);
      drawColourBlended(gl, frame.outputs.color, () => gl.drawArrays(gl.TRIANGLES, 0, 3), false);
    }
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    // A still asked for: path-traced into its own textures once the light is held (the view's frames go on).
    if (this.stillJob !== undefined) this.stillSome(gl, scene);
    const tracing = this.traced !== undefined && this.traced.samples < max;
    if (this.canBake && (this.held.pass < LIGHT_PASSES || tracing || this.stillJob !== undefined)) requestAnimationFrame(() => this.onRedraw?.());
    return true;
  }

  /** The still being path-traced: its camera and size, its textures (as the view's), and who waits for it. */
  private stillJob: {
    view: StillView;
    target: { sumRead: WebGLTexture; sumFill: WebGLTexture; auxRead: WebGLTexture; auxFill: WebGLTexture; traced?: Traced };
    progress: (fraction: number) => void;
    resolve: (image: StillImage) => void;
    reject: (e: Error) => void;
  } | undefined;

  /**
   * A still of the view: path-traced at its own size to `samples`, with the light held as the view's (after the
   * frames draw it). Resolves to its pixels (RGBA, top row first; alpha: how much of the pixel met something).
   */
  still(view: StillView, progress: (fraction: number) => void = () => {}): Promise<StillImage> {
    const gl = this.gl;
    if (gl === undefined || !this.canBake) return Promise.reject(new Error("this browser cannot path-trace here"));
    this.stillJob?.reject(new Error("another still"));
    this.dropStill();
    // Read texel by texel, as the view's (float textures filtered are incomplete where they cannot be).
    const tex = () => {
      const t = this.texture(gl, gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, view.width, view.height, 0, gl.RGBA, gl.FLOAT, null);
      return t;
    };
    return new Promise((resolve, reject) => {
      this.stillJob = { view, target: { sumRead: tex(), sumFill: tex(), auxRead: tex(), auxFill: tex() }, progress, resolve, reject };
      this.onRedraw?.();
    });
  }

  /** Stops the still being path-traced (its promise refused). */
  cancelStill(): void {
    this.stillJob?.reject(new Error("cancelled"));
    this.dropStill();
  }

  private dropStill(): void {
    const j = this.stillJob;
    this.stillJob = undefined;
    if (j && this.gl) for (const t of [j.target.sumRead, j.target.sumFill, j.target.auxRead, j.target.auxFill]) this.gl.deleteTexture(t);
  }

  /** Some passes of the still (about 30 ms of the GPU's a frame), once the light is held; read back when done. */
  private stillSome(gl: WebGL2RenderingContext, scene: Scene): void {
    const j = this.stillJob!;
    if (this.held!.pass < LIGHT_PASSES) {
      j.progress(0.2 * (this.held!.pass / LIGHT_PASSES));
      return;
    }
    const v = j.view;
    // The view's textures set aside while the still's take their place.
    const own = { sumRead: this.sumRead, sumFill: this.sumFill, auxRead: this.auxRead, auxFill: this.auxFill, size: this.traceSize, traced: this.traced };
    const t = j.target;
    [this.sumRead, this.sumFill, this.auxRead, this.auxFill, this.traceSize, this.traced] = [t.sumRead, t.sumFill, t.auxRead, t.auxFill, [v.width, v.height], t.traced];
    const started = performance.now();
    try {
      do {
        this.traceSome(gl, scene, { invViewProjection: v.invViewProjection, viewProjection: v.viewProjection } as Frame3d, v.width, v.height, v.samples, 4);
        gl.finish();
      } while ((this.traced?.samples ?? 0) < v.samples && performance.now() - started < 30);
    } finally {
      [t.sumRead, t.sumFill, t.auxRead, t.auxFill, t.traced] = [this.sumRead!, this.sumFill!, this.auxRead!, this.auxFill!, this.traced];
      [this.sumRead, this.sumFill, this.auxRead, this.auxFill, this.traceSize, this.traced] = [own.sumRead, own.sumFill, own.auxRead, own.auxFill, own.size, own.traced];
    }
    const done = t.traced?.samples ?? 0;
    j.progress(0.2 + 0.8 * Math.min(1, done / v.samples));
    if (done < v.samples) return;
    const image = this.readStill(gl, t.sumRead, t.auxRead, v, scene.primary.exposure);
    this.dropStill();
    j.resolve(image);
  }

  /** The still's sums as pixels: each the mean of the samples that met something, tone-mapped; alpha its share of them. */
  private readStill(gl: WebGL2RenderingContext, sum: WebGLTexture, aux: WebGLTexture, v: StillView, exposure: number): StillImage {
    const read = (t: WebGLTexture) => {
      const out = new Float32Array(v.width * v.height * 4);
      const was = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.traceFb!);
      // The texture alone (the trace's second output may be it, and a texture in two places does not read).
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, v.width, v.height, gl.RGBA, gl.FLOAT, out);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, was);
      return out;
    };
    const s = read(sum), a = read(aux);
    const rgba = new Uint8ClampedArray(v.width * v.height * 4);
    for (let y = 0; y < v.height; ++y) {
      for (let x = 0; x < v.width; ++x) {
        const i = 4 * (y * v.width + x), o = 4 * ((v.height - 1 - y) * v.width + x);
        const hits = s[i + 3], count = a[i + 1];
        if (hits <= 0 || count <= 0) continue;
        for (let c = 0; c < 3; ++c) rgba[o + c] = Math.round(255 * toneOf((s[i + c] / hits) * exposure));
        rgba[o + 3] = Math.round(255 * Math.min(1, hits / count));
      }
    }
    return { width: v.width, height: v.height, rgba };
  }

  /**
   * Blends colour output `color` alone by its alpha (the depth and pick outputs not), where the GPU can
   * (OES_draw_buffers_indexed) and nothing blends already: what undoes it; undefined where it cannot.
   */

  /** An image's level on the GPU (once), and its clear bricks under its table (again when the table changes). */
  private upload(gl: WebGL2RenderingContext, v: Vol, table: Float32Array, tfKey: string): void {
    const level = v.level!;
    v.tex ??= this.texture(gl, gl.TEXTURE_3D);
    v.occ ??= this.texture(gl, gl.TEXTURE_3D);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (v.uploaded !== level) {
      gl.activeTexture(gl.TEXTURE0 + UNIT.vol);
      gl.bindTexture(gl.TEXTURE_3D, v.tex);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, level.size[0], level.size[1], level.size[2], 0, gl.RED, gl.UNSIGNED_BYTE, level.data);
      v.uploaded = level;
      v.occKey = undefined;
    }
    const occKey = `${tfKey} ${v.bounds !== undefined}`;
    if (v.occKey !== occKey) {
      gl.activeTexture(gl.TEXTURE0 + UNIT.vol);
      gl.bindTexture(gl.TEXTURE_3D, v.occ);
      const g = level.size.map((s) => Math.ceil(s / BRICK));
      if (v.bounds !== undefined) gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, g[0], g[1], g[2], 0, gl.RED, gl.UNSIGNED_BYTE, occupancy(v.bounds, table));
      else gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
      v.occKey = occKey;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  /** A program, made once for its key; undefined (and the object off, saying why) when it cannot be made. */
  private program(gl: WebGL2RenderingContext, key: string, fs: () => string, optional = false): WebGLProgram | undefined {
    const had = this.programs.get(key);
    if (had !== undefined) return had;
    try {
      const p = link(gl, VS, fs());
      this.programs.set(key, p);
      return p;
    } catch (e) {
      if (optional) {
        this.canBake = false;
        return undefined;
      }
      this.fail((e as Error).message);
      return undefined;
    }
  }

  /** The uniforms every program reads, and the levels, table and clear bricks on their units. */
  private common(gl: WebGL2RenderingContext, p: WebGLProgram, s: Scene): void {
    const u = (name: string) => gl.getUniformLocation(p, name);
    const q = s.primary;
    const each = (f: (q: LiveParams) => number) => new Float32Array(s.drawn.map((d) => f(d.q)));
    gl.uniformMatrix4fv(u("uVoxFromWorld"), false, new Float32Array(s.drawn.flatMap((d) => d.q.voxFromWorld)));
    gl.uniform3fv(u("uDims"), new Float32Array(s.drawn.flatMap((d) => d.q.dims)));
    gl.uniform1fv(u("uDensity"), each((x) => x.density));
    gl.uniform1fv(u("uPhaseG"), each((x) => x.phaseG));
    gl.uniform1fv(u("uAlbedo"), each((x) => x.albedo));
    gl.uniform1fv(u("uShadeMix"), each((x) => x.shadeMix));
    gl.uniform1fv(u("uGradScale"), each((x) => x.gradScale));
    gl.uniform1fv(u("uRoughness"), each((x) => x.roughness));
    gl.uniform1fv(u("uSpecular"), each((x) => x.specular));
    gl.uniform1fv(u("uInset"), each((x) => x.inset));
    gl.uniform1iv(u("uHasOcc"), new Int32Array(s.drawn.map((d) => (d.vol.bounds !== undefined ? 1 : 0))));
    // Each volume's crop (a box in its voxels) and cuts.
    gl.uniform3fv(u("uCropLo"), new Float32Array(s.drawn.flatMap((d) => d.q.cropLo)));
    gl.uniform3fv(u("uCropHi"), new Float32Array(s.drawn.flatMap((d) => d.q.cropHi)));
    gl.uniform4fv(u("uClips"), new Float32Array(s.drawn.flatMap((d) => d.q.clips)));
    gl.uniform1iv(u("uNClip"), new Int32Array(s.drawn.map((d) => d.q.nclip)));
    gl.uniform3fv(u("uLightDir"), q.lightDir);
    gl.uniform3fv(u("uLightRgb"), q.lightRgb);
    gl.uniform3fv(u("uEnvTop"), q.envTop);
    gl.uniform3fv(u("uEnvHorizon"), q.envHorizon);
    gl.uniform3fv(u("uEnvBottom"), q.envBottom);
    gl.uniform3fv(u("uEnvUp"), q.envUp);
    gl.uniform1f(u("uEnvScale"), q.envScale);
    gl.uniform3fv(u("uLightLo"), s.box.lo);
    gl.uniform1f(u("uCellW"), s.box.cell);
    gl.activeTexture(gl.TEXTURE0 + UNIT.tf);
    gl.bindTexture(gl.TEXTURE_2D, this.tf!);
    gl.uniform1i(u("uTf"), UNIT.tf);
    s.drawn.forEach((d, k) => {
      gl.activeTexture(gl.TEXTURE0 + UNIT.vol + k);
      gl.bindTexture(gl.TEXTURE_3D, d.vol.tex!);
      gl.uniform1i(u(`uVol${k}`), UNIT.vol + k);
      gl.activeTexture(gl.TEXTURE0 + UNIT.vol + s.n + k);
      gl.bindTexture(gl.TEXTURE_3D, d.vol.occ!);
      gl.uniform1i(u(`uOcc${k}`), UNIT.vol + s.n + k);
    });
    // The surfaces, on the units after the volumes'.
    const g = s.geo;
    if (g !== undefined) this.geoTex.bind(gl, p, UNIT.vol + 2 * s.n, g.surf, g.look, g.geoFromWorld, MAX_CLIPS, g.eps);
  }

  /** Draws into framebuffer `fb` (`w` × `h`); Neuroglancer's framebuffer, viewport, colour mask and tests are as they were after. */
  private offscreen(gl: WebGL2RenderingContext, fb: WebGLFramebuffer, w: number, h: number, draw: () => void): void {
    const was = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const mask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
    const caps = [gl.DEPTH_TEST, gl.BLEND, gl.SCISSOR_TEST, gl.CULL_FACE, gl.STENCIL_TEST].filter((c) => gl.isEnabled(c));
    for (const c of caps) gl.disable(c);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao!);
    draw();
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, was);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
    for (const c of caps) gl.enable(c);
  }

  /**
   * Path-traces some rows of the light held into the texture being filled, reading the one filled before; a pass
   * done, the two change places. As many rows as the GPU does within a frame or two (bakeRows: up to LAYERS_PER_DRAW
   * layers, down to a row), the next batch sent once the last is done.
   */
  private bakeSome(gl: WebGL2RenderingContext, s: Scene): void {
    const h = this.held!;
    const geoW = s.geo?.geoW ?? 0;
    const p = this.program(gl, `bake ${s.n} ${geoW}`, () => BAKE_FS(s.n, geoW), true);
    if (p === undefined) return;
    const u = (name: string) => gl.getUniformLocation(p, name);
    const grid = s.box.grid;
    const frames = this.bakePacer.done(gl);
    if (frames === undefined) return;
    // Sized by the last batch: a new grid starts at an eighth of a layer.
    if (this.bakeRows === 0) this.bakeRows = Math.max(1, grid[1] >> 3);
    else if (frames !== null && frames >= SLOW_FRAMES) this.bakeRows = Math.max(1, Math.floor(this.bakeRows / 2));
    else if (frames === 1) this.bakeRows = Math.min(LAYERS_PER_DRAW * grid[1], this.bakeRows * 2);
    this.offscreen(gl, this.fb!, grid[0], grid[1], () => {
      gl.useProgram(p);
      this.common(gl, p, s);
      const pass = () => {
        gl.uniform1i(u("uPass"), h.pass);
        gl.uniform1ui(u("uSeed"), h.pass * 7919 + 17);
        gl.activeTexture(gl.TEXTURE0 + UNIT.light);
        gl.bindTexture(gl.TEXTURE_3D, this.lightRead!);
        gl.uniform1i(u("uPrev"), UNIT.light);
      };
      pass();
      const t0 = GPU_TIMING ? performance.now() : 0;
      const at = `pass ${h.pass} layer ${h.layer} row ${h.row}`;
      // Bands of rows (a scissor), layer after layer.
      gl.enable(gl.SCISSOR_TEST);
      for (let left = this.bakeRows; left > 0 && h.pass < LIGHT_PASSES; ) {
        const rows = Math.min(left, grid[1] - h.row);
        gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.lightFill!, 0, h.layer);
        gl.uniform1i(u("uLayer"), h.layer);
        gl.scissor(0, h.row, grid[0], rows);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        left -= rows;
        h.row += rows;
        if (h.row < grid[1]) continue;
        h.row = 0;
        if (++h.layer < grid[2]) continue;
        h.layer = 0;
        h.pass++;
        [this.lightRead, this.lightFill] = [this.lightFill, this.lightRead];
        pass();
        this.onChange?.();
      }
      gl.disable(gl.SCISSOR_TEST);
      if (GPU_TIMING) gpuTimed(gl, this.fb!, t0, `light ${this.bakeRows} rows of ${grid.join("×")} from ${at}`);
    });
    this.bakePacer.sent(gl);
  }

  /**
   * One pass of path tracing of the view at rest (`w` × `h`): a sample in each traced row, added to the
   * sums read into the ones filled, which then change places. Every `rows`-th row is traced in a pass:
   * more rows a pass while frames come quickly, fewer while they are slow.
   */
  private traceSome(gl: WebGL2RenderingContext, s: Scene, frame: Frame3d, w: number, h: number, max: number, fixedRows?: number): void {
    const geoW = s.geo?.geoW ?? 0;
    const p = this.program(gl, `trace ${s.n} ${geoW}`, () => TRACE_FS(s.n, geoW), true);
    if (p === undefined) return;
    if (this.traceSize[0] !== w || this.traceSize[1] !== h) {
      for (const [t, f] of [[this.sumRead, gl.RGBA32F], [this.sumFill, gl.RGBA32F], [this.auxRead, gl.RGBA32F], [this.auxFill, gl.RGBA32F]] as const) {
        gl.bindTexture(gl.TEXTURE_2D, t!);
        gl.texImage2D(gl.TEXTURE_2D, 0, f, w, h, 0, gl.RGBA, gl.FLOAT, null);
      }
      this.traceSize = [w, h];
      this.traced = undefined;
    }
    const fb = this.traceFb!;
    if (this.traced === undefined) {
      // A new view: no samples yet.
      this.offscreen(gl, fb, w, h, () => {
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sumRead!, 0);
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.auxRead!, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
        gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
      });
      this.traced = { samples: 0, pass: 0, rows: fixedRows ?? 2, last: 0 };
    }
    const t = this.traced;
    if (t.samples >= max) return;
    // One pass in flight; its rows (1 of every `rows`) sized by how long the last took.
    const frames = this.tracePacer.done(gl);
    if (frames === undefined) return;
    if (frames !== null && frames >= SLOW_FRAMES && t.rows < MAX_ROWS) t.rows *= 2;
    else if (frames === 1 && t.rows > 1) t.rows /= 2;
    t.last = performance.now();
    const u = (name: string) => gl.getUniformLocation(p, name);
    this.offscreen(gl, fb, w, h, () => {
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sumFill!, 0);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.auxFill!, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.useProgram(p);
      this.common(gl, p, s);
      gl.uniformMatrix4fv(u("uInvVP"), false, frame.invViewProjection);
      gl.uniformMatrix4fv(u("uVP"), false, frame.viewProjection);
      gl.uniform2f(u("uSize"), w, h);
      gl.uniform1ui(u("uSeed"), t.pass * 7919 + 101);
      gl.uniform1i(u("uRows"), t.rows);
      gl.uniform1i(u("uRow"), t.pass % t.rows);
      gl.uniform1i(u("uMaxBounces"), s.primary.maxBounces);
      gl.activeTexture(gl.TEXTURE0 + UNIT.sum);
      gl.bindTexture(gl.TEXTURE_2D, this.sumRead!);
      gl.uniform1i(u("uPrevSum"), UNIT.sum);
      gl.activeTexture(gl.TEXTURE0 + UNIT.aux);
      gl.bindTexture(gl.TEXTURE_2D, this.auxRead!);
      gl.uniform1i(u("uPrevAux"), UNIT.aux);
      const t0 = GPU_TIMING ? performance.now() : 0;
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (GPU_TIMING) gpuTimed(gl, fb, t0, `trace ${w}×${h}, 1 row in ${t.rows}, pass ${t.pass}`);
    });
    [this.sumRead, this.sumFill] = [this.sumFill, this.sumRead];
    [this.auxRead, this.auxFill] = [this.auxFill, this.auxRead];
    this.tracePacer.sent(gl);
    t.pass++;
    t.samples += 1 / t.rows;
    if (Math.floor(t.samples) !== Math.floor(t.samples - 1 / t.rows)) this.onChange?.();
  }

  /** Stops drawing (the picture drawn as before) and says why. */
  private fail(why: string): false {
    this.failed = why;
    this.onChange?.();
    return false;
  }

  private texture(gl: WebGL2RenderingContext, target: number): WebGLTexture {
    const t = gl.createTexture()!;
    gl.bindTexture(target, t);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return t;
  }

  private reset(gl: WebGL2RenderingContext): void {
    this.bakePacer.reset(this.gl);
    this.tracePacer.reset(this.gl);
    this.bakeRows = 0;
    this.gl = gl;
    this.programs = new Map();
    this.tfKey = "";
    this.held = undefined;
    this.lightGridKey = "";
    for (const v of this.vols.values()) [v.tex, v.occ, v.uploaded, v.occKey] = [undefined, undefined, undefined, undefined];
    this.geoTex.dispose(undefined);
    this.empty = undefined;
    this.vao = gl.createVertexArray()!;
    this.tf = this.texture(gl, gl.TEXTURE_2D);
    // Drawing into float textures (the light held) needs this; without it the short rays stand in.
    this.canBake = gl.getExtension("EXT_color_buffer_float") !== null;
    this.lightRead = this.texture(gl, gl.TEXTURE_3D);
    this.lightFill = this.texture(gl, gl.TEXTURE_3D);
    this.fb = gl.createFramebuffer()!;
    // The path tracing's sums and counts: floats read texel by texel (not filtered).
    const exact = () => {
      const t = this.texture(gl, gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    [this.sumRead, this.sumFill, this.auxRead, this.auxFill] = [exact(), exact(), exact(), exact()];
    this.traceSize = [0, 0];
    this.traceFb = gl.createFramebuffer()!;
    this.traced = undefined;
  }

  /** Lets the levels and their GPU resources go. */
  close(): void {
    this.cancelStill();
    for (const url of [...this.vols.keys()]) this.drop(url);
    this.geoTex.dispose(this.gl);
    if (this.empty && this.gl) for (const t of [this.empty.vol.tex, this.empty.vol.occ]) if (t) this.gl.deleteTexture(t);
    this.empty = undefined;
    this.surfaces = undefined;
    this.wanted = [];
    this.failed = "";
    this.held = undefined;
    this.traced = undefined;
    this.traceKey = "";
    clearTimeout(this.settle);
    const gl = this.gl;
    if (gl !== undefined) {
      for (const p of this.programs.values()) gl.deleteProgram(p);
      for (const t of [this.tf, this.lightRead, this.lightFill, this.sumRead, this.sumFill, this.auxRead, this.auxFill]) if (t) gl.deleteTexture(t);
      if (this.vao) gl.deleteVertexArray(this.vao);
      for (const f of [this.fb, this.traceFb]) if (f) gl.deleteFramebuffer(f);
    }
    this.gl = undefined;
    this.programs = new Map();
  }
}

/** What a frame's programs are given: the volumes drawn (finest first), the first image's values (light, surroundings), and the light held's box. */
interface Scene {
  n: number;
  drawn: Drawn[];
  primary: LiveParams;
  box: ReturnType<typeof lightBox>;
  /** The surfaces drawn with the volumes: theirs, the frame's look of them, world to their space, the data's width, a ray's start off them. */
  geo?: { surf: Surfaces; look: LiveGeometryLook; geoFromWorld: number[]; geoW: number; eps: number };
}

/** A row-major 4 × 4 as column-major (lightBox's matrices are the shader's). */
function colMajor(m: readonly number[]): number[] {
  return [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => m[4 * r + c]));
}

/** An image's name from its store's address, for the readout. */
function shortName(url: string): string {
  return url.replace(/\/+$/, "").split("/").pop()?.replace(/\.(ome\.)?zarr$/, "") ?? url;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram()!;
  const shaders = [sh(gl.VERTEX_SHADER, vs), sh(gl.FRAGMENT_SHADER, fs)];
  for (const s of shaders) gl.attachShader(p, s);
  gl.linkProgram(p);
  for (const s of shaders) gl.deleteShader(s);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(log ?? "link");
  }
  return p;
}

/** The view's path-tracing progress: samples (fractions while rows are traced in turn), passes, rows a pass, the last pass's time. */
interface Traced {
  samples: number;
  pass: number;
  rows: number;
  last: number;
}

/** A still's camera (column-major, as Frame3d's), size and samples. */
export interface StillView {
  invViewProjection: Float32Array;
  viewProjection: Float32Array;
  width: number;
  height: number;
  samples: number;
}

/** A still's pixels: RGBA, the top row first. */
export interface StillImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** TONE's tone map and sRGB, for one channel. */
function toneOf(x: number): number {
  const c = Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}
