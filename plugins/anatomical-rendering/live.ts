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
 */
import type { Frame3d } from "@ngplatform/sdk";
import { VolumeClient } from "../volume-view/volume_client.js";
import type { ViewSpec } from "./client.js";
import { brickBounds, cameraAxes, invert, type Level8, type LocalPreset, mul, readLevel, rowMajor, TF_SIZE, transferTable } from "./local/local.js";

/** The voxels of the level read for the live image on a computer's session (this browser's renderer shares its own). */
export const LIVE_VOXELS = 32e6;
/** The longest side read; a level's texture must also fit the GPU's 3-D textures. */
const MAX_SIDE = 2048;
/** The bricks (voxels a side) the ray steps over where the preset leaves them clear. */
const BRICK = 8;
/** The light held for the object: cells a side at most, passes (the first for the light, then one path a cell each), layers a frame. */
export const LIGHT_SIDE = 96;
export const LIGHT_PASSES = 48;
const LAYERS_PER_DRAW = 8;
const ENV = { top: [0.85, 0.9, 1.0], horizon: [0.55, 0.55, 0.6], bottom: [0.12, 0.11, 0.1], scale: 0.6 };

/** A preset as the live image takes it: whole, with the view's overrides; "data" stops at the image's data values. */
export type LivePreset = LocalPreset & { window?: [number, number] | null };

/** What a frame is drawn with: the view the path tracer would be sent for it, and its preset. */
export interface LiveLook {
  view: ViewSpec;
  preset: LivePreset;
}

/**
 * The preset's colours and opacities at TF_SIZE values of the level (0..1
 * for 0..255): stops at data values (a preset as the host resolves it)
 * through the reader's window; a "window" preset through its window at
 * data values, else the window guessed here; percentiles of the tissue here.
 */
export function liveTable(preset: LivePreset, level: Pick<Level8, "range" | "pct" | "window">): Float32Array {
  const [lo, hi] = level.range;
  const to8 = (v: number) => ((v - lo) / (hi - lo || 1)) * 255;
  if (preset.domain === "data") return transferTable({ ...preset, stops: preset.stops.map((s) => ({ ...s, value: to8(s.value) })) }, level.pct);
  const w = preset.domain === "window" && preset.window ? ([to8(preset.window[0]), to8(preset.window[1])] as [number, number]) : level.window;
  return transferTable(preset, level.pct, w);
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

/** The shader's values for a view of a level, as the path tracer's parameter block has them (`LocalRenderer.pack`). */
export type LiveParams = ReturnType<typeof liveParams>;

export function liveParams(view: ViewSpec, preset: LivePreset, level: Pick<Level8, "size" | "voxelToRas">) {
  const inv = rowMajor(view.inv_view_projection);
  const wfp = view.world_from_physical ? rowMajor(view.world_from_physical) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const vfw = invert(mul(wfp, level.voxelToRas));
  const [right, up, back] = cameraAxes(inv);
  const ld = view.light?.direction ?? [0.4, 0.7, 0.6];
  let L = view.light?.camera_space === false ? ld : [0, 1, 2].map((i) => ld[0] * right[i] + ld[1] * up[i] + ld[2] * back[i]);
  const ln = Math.hypot(...L);
  L = L.map((x) => x / ln);
  const ls = preset.light_scale ?? 1;
  const env = { ...ENV, ...(preset.environment ?? {}) };
  const keepBox = view.boxes?.find((b) => b.keep);
  const crop = view.crop_fraction ?? (keepBox ? ([keepBox.lo, keepBox.hi] as [number[], number[]]) : undefined);
  const clips = (view.clips ?? []).slice(0, 6);
  return {
    // Column-major, for the shader.
    voxFromWorld: [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => vfw[4 * r + c])),
    worldFromVox: (() => {
      const wfv = mul(wfp, level.voxelToRas);
      return [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => wfv[4 * r + c]));
    })(),
    dims: level.size,
    cropLo: crop ? crop[0].map((f, a) => f * level.size[a] - 0.5) : [-1e9, -1e9, -1e9],
    cropHi: crop ? crop[1].map((f, a) => f * level.size[a] - 0.5) : [1e9, 1e9, 1e9],
    clips: Array.from({ length: 24 }, (_, i) => clips[i >> 2]?.[i & 3] ?? 0),
    nclip: clips.length,
    density: preset.density * (view.unit_mm ?? 1),
    shadeMix: preset.shade_mix ?? 0.8,
    gradScale: preset.gradient_scale ?? 40,
    roughness: preset.roughness ?? 0.45,
    specular: preset.specular ?? 0.15,
    phaseG: preset.phase_g ?? 0,
    albedo: preset.albedo ?? 0.9,
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

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// What both shaders read: the level, the table, the cuts, the light and the surroundings.
const COMMON = `precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform sampler2D uTf;
uniform mat4 uVoxFromWorld;
uniform vec3 uDims;
uniform vec3 uCropLo;
uniform vec3 uCropHi;
uniform vec4 uClips[6];
uniform int uNClip;
uniform float uDensity;
uniform float uPhaseG;
uniform float uAlbedo;
uniform vec3 uLightDir;
uniform vec3 uLightRgb;
uniform vec3 uEnvTop;
uniform vec3 uEnvHorizon;
uniform vec3 uEnvBottom;
uniform vec3 uEnvUp;
uniform float uEnvScale;
uniform float uCell;

float tex(vec3 v) { return texture(uVol, (v + 0.5) / uDims).r; }
vec4 tf(float t) { return texture(uTf, vec2((clamp(t, 0.0, 1.0) * ${TF_SIZE - 1}.0 + 0.5) / ${TF_SIZE}.0, 0.5)); }
bool cut(vec3 w, vec3 v) {
  if (any(lessThan(v, uCropLo)) || any(greaterThan(v, uCropHi))) return true;
  for (int i = 0; i < 6; ++i) {
    if (i >= uNClip) break;
    if (dot(uClips[i].xyz, w) + uClips[i].w < 0.0) return true;
  }
  return false;
}
float sigma(vec3 w, vec3 v) { return cut(w, v) ? 0.0 : uDensity * tf(tex(v)).a; }
// The transmittance from a point toward dir (world, unit), from 1.5 voxels to reach voxels away.
float clear(vec3 w, vec3 v, vec3 dir, float reach) {
  vec3 dv = mat3(uVoxFromWorld) * dir;
  float vox = 1.0 / max(length(dv), 1e-12);
  float T = 1.0;
  float before = 0.0;
  for (float d = 1.5; d < reach; d *= 2.0) {
    T *= exp(-sigma(w + dir * (d * vox), v + dv * (d * vox)) * (d - before) * vox);
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
// Where a ray from voxel point v, dv voxels a world unit, is in the level and its crop (world units from v).
vec2 span(vec3 v, vec3 dv) {
  vec3 bmin = max(vec3(-0.5), uCropLo - 0.5);
  vec3 bmax = min(uDims - 0.5, uCropHi + 0.5);
  vec3 safe = mix(dv, vec3(1e-12), lessThan(abs(dv), vec3(1e-12)));
  vec3 ta = (bmin - v) / safe;
  vec3 tb = (bmax - v) / safe;
  vec3 tlo = min(ta, tb);
  vec3 thi = max(ta, tb);
  return vec2(max(max(max(tlo.x, tlo.y), tlo.z), 0.0), min(min(thi.x, thi.y), thi.z));
}`;

// Each pixel's ray through the level, from the camera of this frame. Light as the path tracer's
// (pathtrace.wgsl: brdf_cos, hg, envlight), from the light held for the object; until it is, the
// light's through a short ray toward it and the surroundings' through one along the surface's normal.
const FS = (o: Frame3d["outputs"]) => `#version 300 es
${COMMON}
uniform highp sampler3D uOcc;
uniform bool uHasOcc;
uniform highp sampler3D uLight;
uniform bool uHasLight;
uniform mat4 uInvVP;
uniform mat4 uVP;
uniform vec4 uViewport;
uniform float uStep;
uniform float uShadeMix;
uniform float uGradScale;
uniform float uRoughness;
uniform float uSpecular;
uniform float uExposure;
uniform float uSplit;
layout(location = ${o.color}) out vec4 out_color;
layout(location = ${o.z}) out highp vec4 out_z;
layout(location = ${o.pick}) out highp vec4 out_pickId;

float noise() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }
vec4 lightAt(vec3 v) { return texture(uLight, (v + 0.5) / (uCell * vec3(textureSize(uLight, 0)))); }
vec3 brdfCos(vec3 n, vec3 wo, vec3 wl, vec3 albedo) {
  float cl = dot(n, wl);
  if (cl <= 0.0) return vec3(0.0);
  vec3 h = normalize(wo + wl);
  float e = max(1.0, 2.0 / max(uRoughness * uRoughness, 1e-4) - 2.0);
  float s = uSpecular * (e + 8.0) / 25.132741 * pow(max(dot(n, h), 0.0), e);
  return (albedo * ((1.0 - uSpecular) * 0.31830989) + vec3(s)) * cl;
}
void main() {
  // While the path-traced picture comes in over it, the object keeps the pixels it has not taken yet.
  if (noise() >= uSplit) discard;
  vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec4 a = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 ow = a.xyz / a.w;
  vec3 far = b.xyz / b.w;
  vec3 dw = normalize(far - ow);
  mat3 lin = mat3(uVoxFromWorld);
  vec3 ov = (uVoxFromWorld * vec4(ow, 1.0)).xyz;
  vec3 dv = lin * dw;
  vec3 safe = mix(dv, vec3(1e-12), lessThan(abs(dv), vec3(1e-12)));
  vec2 sp = span(ov, dv);
  float t0 = sp.x;
  float t1 = min(sp.y, length(far - ow));
  if (t1 <= t0) discard;
  float dt = uStep / length(dv);
  mat3 normalFrom = transpose(lin);
  vec3 around = (uEnvTop + 2.0 * uEnvHorizon + uEnvBottom) * (0.25 * uEnvScale);
  vec3 L = vec3(0.0);
  float T = 1.0;
  vec3 hit = vec3(0.0);
  bool met = false;
  float t = t0 + dt * noise();
  ivec3 grid = textureSize(uOcc, 0);
  for (int k = 0; k < 4096; ++k) {
    if (t >= t1 || T < 0.02) break;
    vec3 w = ow + dw * t;
    vec3 v = ov + dv * t;
    if (uHasOcc) {
      // A brick the preset leaves clear: on to where the ray leaves it, at the same phase of the steps.
      vec3 cell = clamp(floor((v + 0.5) / ${BRICK}.0), vec3(0.0), vec3(grid - 1));
      if (texelFetch(uOcc, ivec3(cell), 0).r == 0.0) {
        vec3 side = cell * ${BRICK}.0 - 0.5 + ${BRICK}.0 * step(0.0, safe);
        vec3 leave = (side - v) / safe;
        float gone = max(min(min(leave.x, leave.y), leave.z), 0.0);
        t += max(ceil(gone / dt), 1.0) * dt;
        continue;
      }
    }
    t += dt;
    float s = sigma(w, v);
    if (s <= 0.0) continue;
    float al = 1.0 - exp(-s * dt);
    vec3 albedo = tf(tex(v)).rgb * uAlbedo;
    vec3 g = vec3(tex(v + vec3(1.0, 0.0, 0.0)) - tex(v - vec3(1.0, 0.0, 0.0)),
                  tex(v + vec3(0.0, 1.0, 0.0)) - tex(v - vec3(0.0, 1.0, 0.0)),
                  tex(v + vec3(0.0, 0.0, 1.0)) - tex(v - vec3(0.0, 0.0, 1.0))) * 0.5;
    float gm = length(g);
    float edge = 1.0 - exp(-uGradScale * gm);
    float Tl;
    vec3 amb;
    if (uHasLight) {
      // The light held, half a cell out from a surface (so the tissue beneath it does not shade it).
      vec4 held = lightAt(v - (gm > 1e-6 ? g / gm : vec3(0.0)) * (0.5 * uCell * edge));
      Tl = held.a;
      amb = held.rgb;
    } else {
      Tl = clear(w, v, uLightDir, 25.0);
      // One ray stands for the path tracer's many directions to the surroundings: it shades only in part.
      amb = albedo * around * (0.35 + 0.65 * clear(w, v, uEnvUp, 13.0));
    }
    vec3 col = albedo * (uLightRgb * (hg(dot(dw, uLightDir), uPhaseG) * Tl) + amb);
    if (gm > 1e-6) {
      vec3 n = -normalize(normalFrom * g);
      if (dot(n, dw) > 0.0) n = -n;
      // What is held is the mean over every direction, the tissue's own light among it.
      vec3 sky = uHasLight ? amb : env(n) * (0.35 + 0.65 * clear(w, v, n, 13.0));
      vec3 surf = brdfCos(n, -dw, uLightDir, albedo) * uLightRgb * Tl + albedo * sky * (1.0 - uSpecular);
      col = mix(col, surf, uShadeMix * edge);
    }
    L += T * al * col;
    T *= 1.0 - al;
    if (!met && T <= 0.5) {
      met = true;
      hit = w;
    }
  }
  // As the picture: drawn where the ray met tissue, at the depth where it did.
  if (!met) discard;
  vec3 c = L / (1.0 - T) * uExposure;
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  c = clamp(c, 0.0, 1.0);
  c = mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  vec4 p = uVP * vec4(hit, 1.0);
  float d = clamp((p.z / p.w) * 0.5 + 0.5, 0.0, 0.99999);
  gl_FragDepth = d;
  out_color = vec4(c, 1.0);
  out_z = vec4(1.0 - d);
  out_pickId = vec4(0.0);
}`;

// One layer of the light held, a cell a pixel. Pass 0: how much of the light reaches the cell's centre
// (alpha). Later passes: one path from a point in the cell in a direction from all round, as the path
// tracer's (pathtrace.wgsl trace: up to three scatterings, the light at each through what pass 0
// found, the surroundings where it leaves), averaged into what the passes before found (colour).
const BAKE_FS = `#version 300 es
${COMMON}
uniform highp sampler3D uPrev;
uniform mat4 uWorldFromVox;
uniform int uLayer;
uniform int uPass;
uniform uint uSeed;
out vec4 o;

uint rs;
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float rnd() {
  rs = pcg(rs);
  return float(rs >> 8u) * (1.0 / 16777216.0);
}
vec3 world(vec3 v) { return (uWorldFromVox * vec4(v, 1.0)).xyz; }
vec3 sphere() {
  float z = 1.0 - 2.0 * rnd();
  float r = sqrt(max(0.0, 1.0 - z * z));
  float ph = 6.2831853 * rnd();
  return vec3(r * cos(ph), r * sin(ph), z);
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
  vec3 a = abs(w.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(a, w));
  return normalize(t * (sn * cos(ph)) + cross(w, t) * (sn * sin(ph)) + w * c);
}
// The transmittance from voxel point v toward dir (world, unit) to the level's edge, a voxel a step.
float transmit(vec3 v, vec3 dir) {
  vec3 dv = mat3(uVoxFromWorld) * dir;
  vec3 w = world(v);
  float dt = 1.0 / length(dv);
  float t1 = span(v, dv).y;
  float tau = 0.0;
  for (int k = 0; k < 4096; ++k) {
    float t = (float(k) + 0.5) * dt;
    if (t >= t1 || tau > 8.0) break;
    tau += sigma(w + dir * t, v + dv * t) * dt;
  }
  return exp(-tau);
}
// Where a ray from voxel point v toward dir first scatters (where its optical depth reaches -log(1 - u),
// 1.5 voxels a step); false when it leaves the level first.
bool collide(inout vec3 v, vec3 dir) {
  vec3 dv = mat3(uVoxFromWorld) * dir;
  vec3 w = world(v);
  float dt = 1.5 / length(dv);
  float t1 = span(v, dv).y;
  float target = -log(1.0 - rnd());
  float tau = 0.0;
  float t = dt * rnd();
  for (int k = 0; k < 4096; ++k) {
    if (t >= t1) return false;
    tau += sigma(w + dir * t, v + dv * t) * dt;
    if (tau >= target) {
      v += dv * t;
      return true;
    }
    t += dt;
  }
  return false;
}
float lightAt(vec3 v) { return texture(uPrev, (v + 0.5) / (uCell * vec3(textureSize(uPrev, 0)))).a; }
// The light arriving at voxel point v from direction -dir (dir: the way the path goes out from it).
vec3 incoming(vec3 v, vec3 dir) {
  vec3 thr = vec3(1.0);
  vec3 L = vec3(0.0);
  for (int bounce = 0; bounce < 3; ++bounce) {
    if (!collide(v, dir)) return L + thr * env(dir);
    thr *= tf(tex(v)).rgb * uAlbedo;
    L += thr * uLightRgb * (hg(dot(dir, uLightDir), uPhaseG) * lightAt(v));
    dir = hgdir(dir, uPhaseG);
  }
  return L;
}
void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  rs = pcg(uint(cell.x) + 1024u * uint(cell.y) + 1048576u * uint(cell.z)) ^ pcg(uSeed);
  vec3 v = (vec3(cell) + 0.5) * uCell - 0.5;
  if (uPass == 0) {
    o = vec4(0.0, 0.0, 0.0, transmit(v, uLightDir));
    return;
  }
  vec4 prev = texelFetch(uPrev, cell, 0);
  vec3 at = v + (vec3(rnd(), rnd(), rnd()) - 0.5) * uCell;
  o = vec4(mix(prev.rgb, incoming(at, sphere()), 1.0 / float(uPass)), prev.a);
}`;

/** The light held for the object, as it is being path-traced: two textures, one filled while the other is read. */
interface Held {
  key: string;
  /** The light's direction and the surroundings' up (world) when it was set: fixed to the object since. */
  lightDir: number[];
  envUp: number[];
  /** Passes done, and the layer of the pass under way. */
  pass: number;
  layer: number;
}

export class LiveVolume {
  /** The look of a frame; undefined: nothing to draw it with. */
  look: ((frame: Frame3d) => LiveLook | undefined) | undefined;
  /** Called when a level is ready to draw or could not be read, and as the light held is refined. */
  onChange: (() => void) | undefined;
  /** Called while the light held is being path-traced: the view should be drawn again. */
  onRedraw: (() => void) | undefined;
  private base = "";
  private url = "";
  private client: VolumeClient | undefined;
  private level: Level8 | undefined;
  private gl: WebGL2RenderingContext | undefined;
  private program: WebGLProgram | undefined;
  private programFor = "";
  private failed = false;
  private vao: WebGLVertexArrayObject | undefined;
  private vol: WebGLTexture | undefined;
  private tf: WebGLTexture | undefined;
  private uploaded: Level8 | undefined;
  private tfKey = "";
  private occ: WebGLTexture | undefined;
  /** Each brick's least and greatest value, once worked out (in slabs, after the level is set). */
  private bounds: { level: Level8; data: Float32Array } | undefined;
  private occFor: Float32Array | undefined;
  /** The light held: the textures read and filled, the framebuffer and program filling them; none where floats cannot be drawn to. */
  private held: Held | undefined;
  private lightRead: WebGLTexture | undefined;
  private lightFill: WebGLTexture | undefined;
  private fb: WebGLFramebuffer | undefined;
  private bake: WebGLProgram | undefined;
  private canBake = false;

  /** What the object shows, or why it shows nothing. */
  get text(): string {
    const h = this.held;
    if (!this.base || this.level === undefined || h === undefined || !this.canBake) return this.base;
    return `${this.base}; light ${h.pass >= LIGHT_PASSES ? "done" : `${Math.max(0, h.pass - 1)} of ${LIGHT_PASSES - 1} passes`}`;
  }

  /** Reads the level to draw from the image at `url` (once for each image). */
  async open(url: string): Promise<void> {
    if (url === this.url) return;
    this.close();
    this.url = url;
    try {
      this.client = new VolumeClient();
      this.base = "Object: reading the image";
      const level = await readLevel(this.client, url, LIVE_VOXELS, MAX_SIDE, (msg) => (this.base = `Object: ${msg}`));
      if (this.url !== url) return;
      this.setLevel(level, url);
    } catch (e) {
      if (this.url !== url) return;
      this.base = `Object: ${(e as Error).message}`;
      this.onChange?.();
    } finally {
      if (this.url === url) {
        this.client?.dispose();
        this.client = undefined;
      }
    }
  }

  /** The level to draw, read already (by this browser's path tracer) from the image at `url`. */
  setLevel(level: Level8, url: string): void {
    this.url = url;
    this.level = level;
    this.failed = false;
    this.held = undefined;
    this.base = `Object: level ${level.path} (${level.size.join(" × ")})`;
    this.onChange?.();
    void brickBounds(level.data, level.size, BRICK, () => this.level !== level).then((data) => {
      if (this.level !== level) return;
      this.bounds = { level, data };
      this.onChange?.();
    });
  }

  ready(): boolean {
    return this.level !== undefined && !this.failed;
  }

  /** Draws the frame; `split`: the share of pixels drawn (the rest are the picture's). False when it cannot be drawn. */
  draw(frame: Frame3d, split = 1): boolean {
    const level = this.level;
    const look = level && !this.failed ? this.look?.(frame) : undefined;
    if (level === undefined || look === undefined) return false;
    const gl = frame.gl;
    if (this.gl !== gl) this.reset(gl);
    if (Math.max(...level.size) > (gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number)) return this.fail(`the level is larger than this GPU's 3-D textures`);
    const key = JSON.stringify(frame.outputs);
    if (this.program === undefined || this.programFor !== key) {
      if (this.program) gl.deleteProgram(this.program);
      this.program = undefined;
      try {
        this.program = link(gl, VS, FS(frame.outputs));
        this.programFor = key;
      } catch (e) {
        return this.fail((e as Error).message);
      }
    }
    const { cell, grid } = lightGrid(level.size);
    if (this.uploaded !== level) {
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_3D, this.vol!);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, level.size[0], level.size[1], level.size[2], 0, gl.RED, gl.UNSIGNED_BYTE, level.data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      for (const t of [this.lightRead!, this.lightFill!]) {
        gl.bindTexture(gl.TEXTURE_3D, t);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, grid[0], grid[1], grid[2], 0, gl.RGBA, gl.HALF_FLOAT, null);
      }
      this.uploaded = level;
      this.tfKey = "";
      this.held = undefined;
    }
    const tfKey = JSON.stringify([look.preset.domain, look.preset.stops, look.preset.window ?? null]);
    const bounds = this.bounds?.level === level ? this.bounds.data : undefined;
    if (this.tfKey !== tfKey || this.occFor !== bounds) {
      const table = liveTable(look.preset, level);
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, this.tf!);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, TF_SIZE, 1, 0, gl.RGBA, gl.FLOAT, table);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_3D, this.occ!);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const g = level.size.map((n) => Math.ceil(n / BRICK));
      if (bounds !== undefined) gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, g[0], g[1], g[2], 0, gl.RED, gl.UNSIGNED_BYTE, occupancy(bounds, table));
      else gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      this.tfKey = tfKey;
      this.occFor = bounds;
    }
    const q = liveParams(look.view, look.preset, level);
    // What the light held depends on (not the camera): a change starts it again, the light set from the camera now.
    const light = look.view.light;
    const heldKey = JSON.stringify([tfKey, q.density, q.albedo, q.phaseG, q.lightRgb, q.envTop, q.envHorizon, q.envBottom, q.envScale, q.clips, q.cropLo, q.cropHi, light?.direction ?? null, light?.camera_space ?? true]);
    if (this.held?.key !== heldKey) this.held = { key: heldKey, lightDir: q.lightDir, envUp: q.envUp, pass: 0, layer: 0 };
    q.lightDir = this.held.lightDir;
    q.envUp = this.held.envUp;
    if (this.canBake && this.held.pass < LIGHT_PASSES) this.bakeSome(gl, q, cell, grid);

    const p = this.program;
    const u = (n: string) => gl.getUniformLocation(p, n);
    gl.useProgram(p);
    this.common(gl, p, q, cell);
    const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.uniform4f(u("uViewport"), vp[0], vp[1], vp[2], vp[3]);
    gl.uniformMatrix4fv(u("uInvVP"), false, frame.invViewProjection);
    gl.uniformMatrix4fv(u("uVP"), false, frame.viewProjection);
    // A voxel a step while the camera moves, half a voxel at rest.
    gl.uniform1f(u("uStep"), frame.moving ? 1 : 0.5);
    gl.uniform1f(u("uShadeMix"), q.shadeMix);
    gl.uniform1f(u("uGradScale"), q.gradScale);
    gl.uniform1f(u("uRoughness"), q.roughness);
    gl.uniform1f(u("uSpecular"), q.specular);
    gl.uniform1f(u("uExposure"), q.exposure);
    gl.uniform1f(u("uSplit"), split);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_3D, this.occ!);
    gl.uniform1i(u("uOcc"), 5);
    gl.uniform1i(u("uHasOcc"), bounds !== undefined ? 1 : 0);
    // The light held once it has the light and a path a cell.
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_3D, this.lightRead!);
    gl.uniform1i(u("uLight"), 4);
    gl.uniform1i(u("uHasLight"), this.canBake && this.held.pass >= 2 ? 1 : 0);
    gl.bindVertexArray(this.vao!);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    if (this.canBake && this.held.pass < LIGHT_PASSES) requestAnimationFrame(() => this.onRedraw?.());
    return true;
  }

  /** The uniforms both programs read, and the level and table on their units. */
  private common(gl: WebGL2RenderingContext, p: WebGLProgram, q: LiveParams, cell: number): void {
    const u = (n: string) => gl.getUniformLocation(p, n);
    gl.uniformMatrix4fv(u("uVoxFromWorld"), false, q.voxFromWorld);
    gl.uniform3fv(u("uDims"), q.dims);
    gl.uniform3fv(u("uCropLo"), q.cropLo);
    gl.uniform3fv(u("uCropHi"), q.cropHi);
    gl.uniform4fv(u("uClips"), q.clips);
    gl.uniform1i(u("uNClip"), q.nclip);
    gl.uniform1f(u("uDensity"), q.density);
    gl.uniform1f(u("uPhaseG"), q.phaseG);
    gl.uniform1f(u("uAlbedo"), q.albedo);
    gl.uniform3fv(u("uLightDir"), q.lightDir);
    gl.uniform3fv(u("uLightRgb"), q.lightRgb);
    gl.uniform3fv(u("uEnvTop"), q.envTop);
    gl.uniform3fv(u("uEnvHorizon"), q.envHorizon);
    gl.uniform3fv(u("uEnvBottom"), q.envBottom);
    gl.uniform3fv(u("uEnvUp"), q.envUp);
    gl.uniform1f(u("uEnvScale"), q.envScale);
    gl.uniform1f(u("uCell"), cell);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_3D, this.vol!);
    gl.uniform1i(u("uVol"), 6);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, this.tf!);
    gl.uniform1i(u("uTf"), 7);
  }

  /**
   * Path-traces LAYERS_PER_DRAW layers of the light held into the texture being filled, reading the
   * one filled before; a pass done, the two change places. Neuroglancer's framebuffer, viewport and
   * tests are as they were after.
   */
  private bakeSome(gl: WebGL2RenderingContext, q: LiveParams, cell: number, grid: [number, number, number]): void {
    const h = this.held!;
    if (this.bake === undefined) {
      try {
        this.bake = link(gl, VS, BAKE_FS);
      } catch (e) {
        this.canBake = false;
        this.base += ` (the light could not be held: ${(e as Error).message})`;
        return;
      }
    }
    const fb = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const mask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
    const caps = [gl.DEPTH_TEST, gl.BLEND, gl.SCISSOR_TEST, gl.CULL_FACE, gl.STENCIL_TEST].filter((c) => gl.isEnabled(c));
    for (const c of caps) gl.disable(c);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fb!);
    gl.viewport(0, 0, grid[0], grid[1]);
    const p = this.bake;
    const u = (n: string) => gl.getUniformLocation(p, n);
    gl.useProgram(p);
    this.common(gl, p, q, cell);
    gl.uniformMatrix4fv(u("uWorldFromVox"), false, q.worldFromVox);
    const pass = () => {
      gl.uniform1i(u("uPass"), h.pass);
      gl.uniform1ui(u("uSeed"), h.pass * 7919 + 17);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_3D, this.lightRead!);
      gl.uniform1i(u("uPrev"), 4);
    };
    pass();
    gl.bindVertexArray(this.vao!);
    for (let n = 0; n < LAYERS_PER_DRAW && h.pass < LIGHT_PASSES; ++n) {
      gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.lightFill!, 0, h.layer);
      gl.uniform1i(u("uLayer"), h.layer);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (++h.layer < grid[2]) continue;
      h.layer = 0;
      h.pass++;
      [this.lightRead, this.lightFill] = [this.lightFill, this.lightRead];
      pass();
      this.onChange?.();
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
    for (const c of caps) gl.enable(c);
  }

  /** Stops drawing (the picture drawn as before) and says why. */
  private fail(why: string): false {
    this.failed = true;
    this.base = `Object: ${why}`;
    this.onChange?.();
    return false;
  }

  private reset(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.program = undefined;
    this.programFor = "";
    this.bake = undefined;
    this.uploaded = undefined;
    this.tfKey = "";
    this.held = undefined;
    this.vao = gl.createVertexArray()!;
    const tex = (target: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(target, t);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.vol = tex(gl.TEXTURE_3D);
    this.tf = tex(gl.TEXTURE_2D);
    this.occ = tex(gl.TEXTURE_3D);
    this.occFor = undefined;
    // Drawing into float textures (the light held) needs this; without it the short rays stand in.
    this.canBake = gl.getExtension("EXT_color_buffer_float") !== null;
    this.lightRead = tex(gl.TEXTURE_3D);
    this.lightFill = tex(gl.TEXTURE_3D);
    this.fb = gl.createFramebuffer()!;
  }

  /** Lets the level and its GPU resources go. */
  close(): void {
    this.url = "";
    this.base = "";
    this.level = undefined;
    this.bounds = undefined;
    this.held = undefined;
    this.failed = false;
    this.client?.dispose();
    this.client = undefined;
    const gl = this.gl;
    if (gl !== undefined) {
      for (const p of [this.program, this.bake]) if (p) gl.deleteProgram(p);
      for (const t of [this.vol, this.tf, this.occ, this.lightRead, this.lightFill]) if (t) gl.deleteTexture(t);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.fb) gl.deleteFramebuffer(this.fb);
    }
    this.gl = undefined;
    this.program = undefined;
    this.bake = undefined;
    this.uploaded = undefined;
  }
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
