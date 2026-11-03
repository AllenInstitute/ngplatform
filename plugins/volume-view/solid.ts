/**
 * The solid, drawn in Neuroglancer's 3-D view: a coarse level of an image
 * held as one 3-D texture and ray-marched to its tissue surface, with the
 * octant facing the camera cut away at the view's position.
 *
 * It writes depth, so Neuroglancer's own drawing (tracts, meshes,
 * annotations, and the sections) depth-tests against it: tissue hides what
 * is inside it, and the cut shows it.  Sections show only on the cut's
 * three faces (sectionClip).  Where a ray leaves the cut through a face in
 * tissue, the coarse value is drawn a hair behind the face, so
 * Neuroglancer's section there (at full resolution) wins when Sections is
 * on, and the coarse one shows when it is off; through a face outside the
 * tissue, the solid behind is drawn a hair in front of it, so the section's
 * empty surround does not hide it.
 *
 * Tissue is whatever differs from the background by more than the
 * threshold: darker than a pale background (a stain) or brighter than a
 * dark one (an MRI), as the volume's border shows.  Empty space is skipped
 * with a coarse grid of block maxima.  Coordinates are Neuroglancer's
 * display coordinates throughout (see Frame3d).
 *
 * The whole image from a coarse level, and finer levels over it: bricks
 * of several levels at once (./bricks.ts), finer near the camera and the
 * cut, held in one 3-D texture (the atlas) and found through a page table;
 * or, where the atlas cannot be made, a box of one finer level (the detail,
 * around the position).  At each point the ray samples the finest brick
 * held there (or the detail), steps and shades at its voxel size; elsewhere
 * the coarse level.  The coarse level's empty-space grid, background and
 * contrast window serve all (the same image, read through one window).
 */
import type { Drawer3d, Frame3d } from "@ngplatform/sdk";
import { BRICK, type BrickLevel, type BrickLoader, brickLevels, BrickSet, type BrickView, MAX_LEVELS, SLOT } from "./bricks.js";
import { invert, type Mat4, multiply } from "./ome.js";

const BLOCK = 8;
/** Most bytes the bricks' atlas takes on the GPU. */
const ATLAS_BYTES = 128 * 1024 * 1024;

const VS = `#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const fs = (outputs: Frame3d["outputs"], bricks: boolean) => `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp usampler3D;
${bricks ? "#define BRICKS" : ""}
const int MAX_LEVELS = ${MAX_LEVELS};
const float BRICK = ${BRICK}.0;
const float SLOT = ${SLOT}.0;
uniform sampler3D uVolume;
uniform sampler3D uOccupancy;
uniform mat4 uInvViewProj;
uniform mat4 uViewProj;
uniform mat4 uWorldToTex;
uniform vec3 uOccScale;
uniform vec3 uBoxLo;
uniform vec3 uBoxHi;
uniform float uStep;
uniform float uBlockStep;
uniform float uThreshold;
uniform bool uCut;
uniform vec3 uCutPoint;
uniform vec3 uCutSide;
uniform vec3 uVoxel;
uniform bool uDarkBackground;
uniform vec2 uWindow;
uniform bool uHasDetail;
uniform sampler3D uDetail;
uniform mat4 uWorldToDetail;
uniform float uDetailStep;
uniform vec3 uDetailVoxel;
#ifdef BRICKS
uniform sampler3D uAtlas;
uniform highp usampler3D uPages;
uniform vec3 uAtlasTexel;
uniform int uFirstLevel;
uniform int uLevelCount;
uniform mat4 uWorldToLevel[MAX_LEVELS];
uniform ivec3 uPageOffset[MAX_LEVELS];
uniform ivec3 uPageGrid[MAX_LEVELS];
uniform float uLevelStep[MAX_LEVELS];
uniform vec3 uLevelVoxel[MAX_LEVELS];
#endif
in vec2 vNdc;
layout(location = ${outputs.color}) out vec4 out_color;
layout(location = ${outputs.z}) out highp vec4 out_z;
layout(location = ${outputs.pick}) out highp vec4 out_pickId;

vec2 slab(vec3 o, vec3 inv, vec3 lo, vec3 hi, out vec3 tExit) {
  vec3 a = (lo - o) * inv;
  vec3 b = (hi - o) * inv;
  vec3 tmin = min(a, b);
  tExit = max(a, b);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tExit.x, tExit.y), tExit.z));
}

vec3 texOf(vec3 p) { return (uWorldToTex * vec4(p, 1.0)).xyz; }

// Inside the detail box (its texture coordinates, half a voxel in from its edges).
bool inDetail(vec3 p, out vec3 tc) {
  if (!uHasDetail) return false;
  tc = (uWorldToDetail * vec4(p, 1.0)).xyz;
  return all(greaterThan(tc, vec3(0.0))) && all(lessThan(tc, vec3(1.0)));
}

// A value and where it came from: the step and voxel there, and the brick
// (level -1: the coarse level or the detail).
struct Sample {
  float v;
  float stepSize;
  vec3 voxel;
  int level;
  vec3 brick;
  bool constant;
};

Sample sampleAt(vec3 p) {
  Sample s;
  s.level = -1;
  s.brick = vec3(0.0);
  s.constant = false;
#ifdef BRICKS
  // The finest brick held here, from the finest level allowed.
  for (int l = 0; l < MAX_LEVELS; ++l) {
    if (l >= uLevelCount) break;
    if (l < uFirstLevel) continue;
    vec3 x = (uWorldToLevel[l] * vec4(p, 1.0)).xyz;
    vec3 b = floor((x + 0.5) / BRICK);
    ivec3 bi = ivec3(b);
    if (any(lessThan(bi, ivec3(0))) || any(greaterThanEqual(bi, uPageGrid[l]))) continue;
    uvec4 e = texelFetch(uPages, uPageOffset[l] + bi, 0);
    if (e.a == 0u) continue;
    s.level = l;
    s.brick = b;
    s.stepSize = uLevelStep[l];
    s.voxel = uLevelVoxel[l];
    s.constant = e.a == 2u;
    // The slot's voxel 0 is the brick's voxel -1 (the apron).
    s.v = s.constant ? float(e.r) / 255.0 : texture(uAtlas, (vec3(e.rgb) * SLOT + x - b * BRICK + 1.5) * uAtlasTexel).r;
    return s;
  }
#else
  vec3 dc;
  if (inDetail(p, dc)) {
    s.v = texture(uDetail, dc).r;
    s.stepSize = uDetailStep;
    s.voxel = uDetailVoxel;
    return s;
  }
#endif
  s.stepSize = uStep;
  s.voxel = uVoxel;
  vec3 tc = texOf(p);
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) s.v = uDarkBackground ? 0.0 : 1.0;
  else s.v = texture(uVolume, tc).r;
  return s;
}

float raw(vec3 p) { return sampleAt(p).v; }

#ifdef BRICKS
// Where the ray leaves brick b of level l.
float brickExit(vec3 o, vec3 d, int l, vec3 b) {
  mat4 m = uWorldToLevel[l];
  vec3 dl = mat3(m) * d;
  vec3 tExit;
  return slab((m * vec4(o, 1.0)).xyz, 1.0 / (dl + vec3(equal(dl, vec3(0.0))) * 1e-9), b * BRICK - 0.5, b * BRICK + BRICK - 0.5, tExit).y;
}
#endif

// The tissue's range stretched to black..white.
float shown(float v) {
  return clamp((v - uWindow.x) / max(uWindow.y - uWindow.x, 1e-3), 0.0, 1.0);
}

// How like the background a point is: 1 is background, lower is tissue.
float value(vec3 p) {
  float v = raw(p);
  return uDarkBackground ? 1.0 - v : v;
}

float occupied(vec3 p) {
  vec3 tc = texOf(p) * uOccScale;
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) return 0.0;
  return texture(uOccupancy, tc).r;
}

bool removed(vec3 p) {
  if (!uCut) return false;
  vec3 s = (p - uCutPoint) * uCutSide;
  return s.x > 0.0 && s.y > 0.0 && s.z > 0.0;
}

void main() {
  vec4 n = uInvViewProj * vec4(vNdc, -1.0, 1.0);
  vec4 f = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 o = n.xyz / n.w;
  vec3 d = f.xyz / f.w - o;
  float far = length(d);
  d /= far;
  vec3 inv = 1.0 / (d + vec3(equal(d, vec3(0.0))) * 1e-9);
  vec3 unused;
  vec2 box = slab(o, inv, uBoxLo, uBoxHi, unused);
  float t = max(box.x, 0.0);
  box.y = min(box.y, far);
  if (t >= box.y) discard;
  vec2 oct = vec2(1.0, 0.0);
  vec3 octExit = vec3(0.0);
  if (uCut) {
    vec3 up = step(0.0, uCutSide);
    vec3 lo = mix(uBoxLo - 1.0, uCutPoint, up);
    vec3 hi = mix(uCutPoint, uBoxHi + 1.0, up);
    oct = slab(o, inv, lo, hi, octExit);
  }
  float threshold = 1.0 - uThreshold;
  bool hit = false;
  bool face = false;
  // Where the ray left the cut through a face that is not tissue there.
  float emptyFace = -1.0;
  float before = t;
  for (int i = 0; i < 4096; ++i) {
    if (t > box.y) break;
    if (oct.x < oct.y && t >= oct.x && t < oct.y) {
      t = oct.y + 1e-4 * uStep;
      face = true;
      if (value(o + d * t) >= threshold) emptyFace = t;
      continue;
    }
    vec3 p = o + d * t;
    if (occupied(p) < uThreshold) {
      before = t;
      t += uBlockStep;
      face = false;
      continue;
    }
    Sample s = sampleAt(p);
    if ((uDarkBackground ? 1.0 - s.v : s.v) < threshold) {
      hit = true;
      break;
    }
    face = false;
    before = t;
#ifdef BRICKS
    if (s.constant) {
      // A brick of background throughout: on to where the ray leaves it (or meets the cut).
      float exit = brickExit(o, d, s.level, s.brick);
      if (t < oct.x && oct.x < oct.y) exit = min(exit, oct.x);
      before = max(t, exit - 1e-3 * s.stepSize);
      t = max(exit, t) + 0.05 * s.stepSize;
      continue;
    }
#endif
    t += s.stepSize;
  }
  if (!hit) discard;
  vec3 p = o + d * t;
  vec3 colour;
  float behind = 0.0;
  if (face) {
    colour = vec3(shown(raw(p)));
    behind = 2e-5;
  } else {
    // Down to a tenth of a step where the surface is (a jump over empty
    // blocks or a brick of background is many of a fine level's voxels).
    float a = before;
    float b = t;
    float within = 0.1 * sampleAt(p).stepSize;
    for (int k = 0; k < 16; ++k) {
      if (b - a < within) break;
      float m = 0.5 * (a + b);
      vec3 q = o + d * m;
      if (!removed(q) && value(q) < threshold) b = m; else a = m;
    }
    t = b;
    p = o + d * t;
    vec3 h = sampleAt(p).voxel;
    vec3 g = vec3(
      value(p + vec3(h.x, 0.0, 0.0)) - value(p - vec3(h.x, 0.0, 0.0)),
      value(p + vec3(0.0, h.y, 0.0)) - value(p - vec3(0.0, h.y, 0.0)),
      value(p + vec3(0.0, 0.0, h.z)) - value(p - vec3(0.0, 0.0, h.z))) / h;
    vec3 normal = length(g) > 1e-6 ? normalize(g) : -d;
    if (dot(normal, d) > 0.0) normal = -normal;
    float tissue = raw(p - normal * 2.0 * h);
    vec3 base = vec3(0.25 + 0.75 * shown(tissue));
    vec3 light = normalize(-d + vec3(0.0, 0.0, 0.35));
    float diffuse = max(dot(normal, light), 0.0);
    float spec = pow(max(dot(reflect(-light, normal), -d), 0.0), 24.0);
    colour = base * (0.28 + 0.72 * diffuse) + 0.12 * spec;
  }
  // Through a face that is not tissue, the section shows only background
  // there: the solid behind it is drawn at the face, a hair in front.
  vec3 at = emptyFace > 0.0 && !face ? o + d * emptyFace : p;
  if (emptyFace > 0.0 && !face) behind = -2e-5;
  vec4 clip = uViewProj * vec4(at, 1.0);
  float depth = clamp(clip.z / clip.w * 0.5 + 0.5 + behind, 0.0, 1.0);
  gl_FragDepth = depth;
  out_color = vec4(colour, 1.0);
  out_z = vec4(1.0 - depth);
  out_pickId = vec4(0.0);
}`;

/** The mean of the values on a volume's six faces (`data` x fastest). */
export function borderMean(data: Uint8Array, size: [number, number, number]): number {
  const [nx, ny, nz] = size;
  let sum = 0;
  let count = 0;
  for (let z = 0; z < nz; ++z) {
    for (let y = 0; y < ny; ++y) {
      const row = (z * ny + y) * nx;
      if (z === 0 || z === nz - 1 || y === 0 || y === ny - 1) {
        for (let x = 0; x < nx; ++x) sum += data[row + x];
        count += nx;
      } else {
        sum += data[row] + data[row + nx - 1];
        count += 2;
      }
    }
  }
  return count === 0 ? 255 : sum / count;
}

/**
 * The 1st to 99.5th percentiles (0..1) of the values that are clearly
 * tissue: more than 8% of the range away from the background.
 */
export function tissueWindow(data: Uint8Array, darkBackground: boolean): [number, number] {
  const counts = new Float64Array(256);
  for (let i = 0; i < data.length; ++i) counts[data[i]]++;
  const [from, to] = darkBackground ? [21, 256] : [0, 235];
  let total = 0;
  for (let v = from; v < to; ++v) total += counts[v];
  if (total === 0) return [0, 1];
  const at = (q: number) => {
    let seen = 0;
    for (let v = from; v < to; ++v) {
      seen += counts[v];
      if (seen >= q * total) return v;
    }
    return to - 1;
  };
  const lo = at(0.01);
  const hi = Math.max(at(0.995), lo + 1);
  return [lo / 255, hi / 255];
}

/** Row-major (as ome.ts keeps them) to column-major float32, as WebGL takes them. */
function gl4(m: Mat4): Float32Array {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) out[4 * c + r] = m[4 * r + c];
  return out;
}

export interface SolidOptions {
  /** Tissue starts where a value differs from the background by more than this (0..1). */
  threshold: number;
  cut: boolean;
}

/** Bricks of the image's finer levels, and how to read them. */
export interface BrickSource {
  /** The same key, the same levels: only `finest` may change. */
  key: string;
  /** The levels finer than the whole one, finest first. */
  levels: BrickLevel[];
  /** The finest level to draw bricks of (its index among the image's levels). */
  finest: number;
  load: BrickLoader;
}

interface Volume {
  data: Uint8Array;
  size: [number, number, number];
  /** Voxel (x, y, z) to display coordinates, row-major. */
  voxelToDisplay: Mat4;
}

/**
 * Display coordinates of RAS millimetres: one row per displayed dimension
 * (named x, y or z), scaled by its unit.  Undefined when the view does not
 * show x, y and z.
 */
export function displayOfRas(dimensions: Frame3d["dimensions"]): Mat4 | undefined {
  const m = new Float64Array(16);
  m[15] = 1;
  for (let i = 0; i < 3; ++i) {
    const axis = ["x", "y", "z"].indexOf(dimensions.names[i]);
    if (axis === -1) return undefined;
    const unit = dimensions.units[i];
    const metres = unit === "m" ? 1e-3 : 1;
    m[4 * i + axis] = metres / dimensions.scales[i];
  }
  return m;
}

export class SolidDrawer implements Drawer3d {
  options: SolidOptions = { threshold: 0.08, cut: true };
  private program: WebGLProgram | undefined;
  private programFor: string | undefined;
  private vao: WebGLVertexArrayObject | undefined;
  private gl: WebGL2RenderingContext | undefined;
  private volumeTexture: WebGLTexture | undefined;
  private occupancy: WebGLTexture | undefined;
  private uploaded: Volume | undefined;
  private pending: Volume | undefined;
  /** The finer box, its texture, and whether it waits to be uploaded (null: to be taken away). */
  private detail: Volume | undefined;
  private detailTexture: WebGLTexture | undefined;
  private detailPending: Volume | null | undefined;
  private voxelToRas: Mat4 | undefined;
  private occScale: [number, number, number] = [1, 1, 1];
  private darkBackground = true;
  private window: [number, number] = [0, 1];
  private voxelSize = 1;
  /** Where bricks come from; their CPU side; the atlas (and its slots a side) and page table. */
  private brickSource: BrickSource | undefined;
  private bricks: BrickSet | undefined;
  private atlas: WebGLTexture | undefined;
  private atlasSlots = 0;
  private pageTexture: WebGLTexture | undefined;
  /** The view the bricks were last chosen for, and the choice waiting for the view to settle. */
  private chosenFor: string | undefined;
  private choosing: ReturnType<typeof setTimeout> | undefined;
  /** Why bricks cannot be drawn on this GPU (then the detail box is). */
  bricksFailed: string | undefined;
  /** A brick arrived, the bricks were chosen again, or they failed. */
  onBricks: (() => void) | undefined;
  /** Why nothing is drawn, for the panel. */
  problem: string | undefined;
  onProblem: (() => void) | undefined;

  /** The volume to draw: voxels (x fastest), its size, and voxel (x, y, z) to RAS mm. */
  setVolume(data: Uint8Array, size: [number, number, number], voxelToRas: Mat4, voxelSize: number): void {
    this.voxelToRas = voxelToRas;
    this.voxelSize = voxelSize;
    this.darkBackground = borderMean(data, size) < 128;
    this.window = tissueWindow(data, this.darkBackground);
    this.pending = { data, size, voxelToDisplay: voxelToRas };
  }

  /** A box of a finer level, drawn inside the volume where it covers it (voxels as the volume's, x fastest); undefined takes it away. */
  setDetail(data: Uint8Array | undefined, size?: [number, number, number], voxelToRas?: Mat4): void {
    this.detailPending = data === undefined ? null : { data, size: size!, voxelToDisplay: voxelToRas! };
  }

  /** Draws bricks of finer levels over the whole one; undefined stops. */
  setBricks(source: BrickSource | undefined): void {
    if (source?.key !== this.brickSource?.key) this.dropBricks();
    this.brickSource = source;
  }

  /** The bricks: held, slots, being read, wanted; and the levels they come from (indices among the image's). */
  brickStatus(): { held: number; slots: number; loading: number; wanted: number; levels: number[] } | undefined {
    const b = this.bricks;
    if (b === undefined) return undefined;
    const finest = this.brickSource?.finest ?? 0;
    return { held: b.held, slots: b.slots, loading: b.pending, wanted: b.wanted.length, levels: b.levels.map((l) => l.index).filter((i) => i >= finest) };
  }

  private dropBricks(): void {
    this.bricks?.dispose();
    this.bricks = undefined;
    this.chosenFor = undefined;
    clearTimeout(this.choosing);
    if (this.pageTexture && this.gl) this.gl.deleteTexture(this.pageTexture);
    this.pageTexture = undefined;
  }

  /**
   * The atlas (as many slots as the budget and MAX_3D_TEXTURE_SIZE allow),
   * the page table, and the bricks' CPU side; on failure, `bricksFailed`
   * says why.
   */
  private makeBricks(gl: WebGL2RenderingContext, source: BrickSource, context: Volume): void {
    const max = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    const fit = brickLevels(source.levels, max);
    const perAxis = Math.min(Math.floor(max / SLOT), Math.floor(Math.cbrt(ATLAS_BYTES / SLOT ** 3)));
    const fail = (why: string) => {
      this.bricksFailed = why;
      if (this.atlas) gl.deleteTexture(this.atlas);
      this.atlas = undefined;
      this.dropBricks();
      this.onBricks?.();
    };
    if (perAxis < 2) return fail(`3-D textures here are at most ${max} voxels a side`);
    if (fit === undefined) return fail("the levels' page tables do not fit in a 3-D texture");
    for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; ++i);
    if (this.atlas === undefined || this.atlasSlots !== perAxis) {
      if (this.atlas) gl.deleteTexture(this.atlas);
      this.atlas = gl.createTexture()!;
      this.atlasSlots = perAxis;
      gl.bindTexture(gl.TEXTURE_3D, this.atlas);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8, perAxis * SLOT, perAxis * SLOT, perAxis * SLOT);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    }
    const size = fit.layout.size;
    this.pageTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.pageTexture);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8UI, size[0], size[1], size[2]);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_3D, null);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) return fail(error === gl.OUT_OF_MEMORY ? "the GPU has no memory for the bricks" : `the bricks' textures could not be made (WebGL error ${error})`);
    this.bricks = new BrickSet(fit.levels, fit.layout, perAxis, { data: context.data, size: context.size, voxelToRas: context.voxelToDisplay, darkBackground: this.darkBackground }, source.load);
    this.bricks.onChange = () => this.onBricks?.();
  }

  /** Bricks read since the last frame into the atlas, and page entries changed into the page table. */
  private uploadBricks(gl: WebGL2RenderingContext, bricks: BrickSet): void {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (bricks.uploads.length > 0) {
      gl.bindTexture(gl.TEXTURE_3D, this.atlas!);
      for (const { slot, data } of bricks.uploads) {
        const [x, y, z] = bricks.slotAt(slot);
        gl.texSubImage3D(gl.TEXTURE_3D, 0, x * SLOT, y * SLOT, z * SLOT, SLOT, SLOT, SLOT, gl.RED, gl.UNSIGNED_BYTE, data);
      }
      bricks.uploads = [];
    }
    const dirty = bricks.takeDirty();
    if (dirty.length > 0) {
      const [w, h, d] = bricks.layout.size;
      gl.bindTexture(gl.TEXTURE_3D, this.pageTexture!);
      if (dirty.length > 256) {
        gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, w, h, d, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, bricks.pages);
      } else {
        for (const t of dirty) gl.texSubImage3D(gl.TEXTURE_3D, 0, t % w, Math.floor(t / w) % h, Math.floor(t / (w * h)), 1, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, bricks.pages, 4 * t);
      }
    }
    gl.bindTexture(gl.TEXTURE_3D, null);
  }

  /**
   * Chooses the bricks again once the view (or the threshold, cut or finest
   * level) has stayed the same a moment.
   */
  private chooseBricks(frame: Frame3d, bricks: BrickSet, toDisplay: Mat4, side: number[], finest: number): void {
    const cut = this.options.cut ? { point: [...frame.position], side } : undefined;
    const view: BrickView = {
      viewProjection: Float64Array.from(frame.viewProjection),
      invViewProjection: Float64Array.from(frame.invViewProjection),
      height: frame.height,
      toDisplay,
      cut,
      threshold: this.options.threshold,
      finest,
    };
    const key = JSON.stringify([Array.from(view.viewProjection, (v) => v.toPrecision(5)), frame.height, cut, view.threshold, finest]);
    if (key === this.chosenFor) return;
    this.chosenFor = key;
    clearTimeout(this.choosing);
    this.choosing = setTimeout(() => {
      if (this.bricks !== bricks) return;
      bricks.choose(view);
      this.onBricks?.();
    }, 150);
  }

  get hasDetail(): boolean {
    return this.detailPending !== null && (this.detailPending !== undefined || this.detail !== undefined);
  }

  private uploadDetail(gl: WebGL2RenderingContext, detail: Volume | null): void {
    if (this.detailTexture) gl.deleteTexture(this.detailTexture);
    this.detailTexture = undefined;
    this.detail = detail ?? undefined;
    if (detail === null) return;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.detailTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.detailTexture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, detail.size[0], detail.size[1], detail.size[2], 0, gl.RED, gl.UNSIGNED_BYTE, detail.data);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_3D, null);
  }

  get hasVolume(): boolean {
    return this.pending !== undefined || this.uploaded !== undefined;
  }

  isReady(): boolean {
    return true;
  }

  private setProblem(problem: string | undefined): void {
    if (problem === this.problem) return;
    this.problem = problem;
    this.onProblem?.();
  }

  private compile(gl: WebGL2RenderingContext, outputs: Frame3d["outputs"], bricks: boolean): WebGLProgram | undefined {
    const key = JSON.stringify([outputs, bricks]);
    if (this.program !== undefined && this.programFor === key) return this.program;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader did not compile");
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs(outputs, bricks)));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program did not link");
    if (this.program) gl.deleteProgram(this.program);
    this.program = program;
    this.programFor = key;
    this.vao ??= gl.createVertexArray()!;
    return program;
  }

  private upload(gl: WebGL2RenderingContext, volume: Volume): void {
    const { data, size } = volume;
    if (this.volumeTexture) gl.deleteTexture(this.volumeTexture);
    if (this.occupancy) gl.deleteTexture(this.occupancy);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.volumeTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTexture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, size[0], size[1], size[2], 0, gl.RED, gl.UNSIGNED_BYTE, data);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    const dark = this.darkBackground;
    // Block maxima of the tissue (difference from the background), grown by a block.
    const blocks = size.map((s) => Math.ceil(s / BLOCK)) as [number, number, number];
    const occ = new Uint8Array(blocks[0] * blocks[1] * blocks[2]);
    for (let z = 0; z < size[2]; ++z) {
      const bz = (z / BLOCK) | 0;
      for (let y = 0; y < size[1]; ++y) {
        const by = (y / BLOCK) | 0;
        let i = (z * size[1] + y) * size[0];
        const row = (bz * blocks[1] + by) * blocks[0];
        for (let x = 0; x < size[0]; ++x, ++i) {
          const v = dark ? data[i] : 255 - data[i];
          const b = row + ((x / BLOCK) | 0);
          if (v > occ[b]) occ[b] = v;
        }
      }
    }
    const grown = new Uint8Array(occ.length);
    for (let z = 0; z < blocks[2]; ++z) {
      for (let y = 0; y < blocks[1]; ++y) {
        for (let x = 0; x < blocks[0]; ++x) {
          let m = 0;
          for (let dz = -1; dz <= 1; ++dz) {
            for (let dy = -1; dy <= 1; ++dy) {
              for (let dx = -1; dx <= 1; ++dx) {
                const X = x + dx;
                const Y = y + dy;
                const Z = z + dz;
                if (X < 0 || Y < 0 || Z < 0 || X >= blocks[0] || Y >= blocks[1] || Z >= blocks[2]) continue;
                const v = occ[(Z * blocks[1] + Y) * blocks[0] + X];
                if (v > m) m = v;
              }
            }
          }
          grown[(z * blocks[1] + y) * blocks[0] + x] = m;
        }
      }
    }
    this.occupancy = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.occupancy);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, blocks[0], blocks[1], blocks[2], 0, gl.RED, gl.UNSIGNED_BYTE, grown);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_3D, null);
    this.occScale = size.map((s, k) => s / (blocks[k] * BLOCK)) as [number, number, number];
    this.uploaded = volume;
    // The bricks know where tissue is from the whole level: made again for this one.
    this.dropBricks();
  }

  /**
   * The volume's box in display coordinates, a voxel's extent along each
   * display axis, and the side of the position the camera is on.
   */
  private geometry(frame: Omit<Frame3d, "gl">, toDisplay: Mat4, size: [number, number, number]) {
    const voxelToDisplay = multiply(toDisplay, this.voxelToRas!);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; ++c) {
      const v = [0, 1, 2].map((k) => ((c >> k) & 1 ? size[k] - 0.5 : -0.5));
      for (let r = 0; r < 3; ++r) {
        const w = voxelToDisplay[4 * r] * v[0] + voxelToDisplay[4 * r + 1] * v[1] + voxelToDisplay[4 * r + 2] * v[2] + voxelToDisplay[4 * r + 3];
        lo[r] = Math.min(lo[r], w);
        hi[r] = Math.max(hi[r], w);
      }
    }
    const voxel = [0, 1, 2].map((r) => Math.hypot(voxelToDisplay[4 * r], voxelToDisplay[4 * r + 1], voxelToDisplay[4 * r + 2]));
    // The camera's direction, from the near plane's centre to the far one's.
    const inv = frame.invViewProjection;
    const at = (z: number) => {
      const w = inv[11] * z + inv[15];
      return [0, 1, 2].map((r) => (inv[8 + r] * z + inv[12 + r]) / w);
    };
    const near = at(-1);
    const far = at(1);
    const side = [0, 1, 2].map((k) => (far[k] - near[k] > 0 ? -1 : 1));
    return { voxelToDisplay, lo, hi, voxel, side };
  }

  /** Sections show only on the cut's three faces: within the removed octant, inside the volume. */
  sectionClip(frame: Omit<Frame3d, "gl">): { lower: number[]; upper: number[] } | undefined {
    const volume = this.uploaded ?? this.pending;
    if (volume === undefined || this.voxelToRas === undefined) return undefined;
    const toDisplay = displayOfRas(frame.dimensions);
    if (toDisplay === undefined) return undefined;
    if (!this.options.cut) return { lower: [1, 1, 1], upper: [0, 0, 0] };
    const { lo, hi, voxel, side } = this.geometry(frame, toDisplay, volume.size);
    const margin = Math.min(...voxel) * 0.01;
    const p = frame.position;
    return {
      lower: [0, 1, 2].map((k) => (side[k] > 0 ? p[k] : lo[k]) - margin),
      upper: [0, 1, 2].map((k) => (side[k] > 0 ? hi[k] : p[k]) + margin),
    };
  }

  draw(frame: Frame3d): void {
    const { gl } = frame;
    if (this.gl !== gl) {
      this.dropBricks();
      this.atlas = undefined;
      this.gl = gl;
      this.program = undefined;
      this.vao = undefined;
      if (this.uploaded) this.pending ??= this.uploaded;
      if (this.detail) this.detailPending ??= this.detail;
    }
    if (this.pending !== undefined) {
      this.upload(gl, this.pending);
      this.pending = undefined;
    }
    if (this.detailPending !== undefined) {
      this.uploadDetail(gl, this.detailPending);
      this.detailPending = undefined;
    }
    const volume = this.uploaded;
    if (volume === undefined || this.voxelToRas === undefined) return;
    const toDisplay = displayOfRas(frame.dimensions);
    if (toDisplay === undefined) {
      this.setProblem(`The 3-D view shows ${frame.dimensions.names.join(", ")}; the volume needs x, y and z.`);
      return;
    }
    this.setProblem(undefined);
    const { size } = volume;
    const { voxelToDisplay, lo, hi, voxel, side } = this.geometry(frame, toDisplay, size);
    const source = this.brickSource;
    if (source !== undefined && this.bricks === undefined && this.bricksFailed === undefined) this.makeBricks(gl, source, volume);
    const bricks = source !== undefined ? this.bricks : undefined;
    // The finest brick level drawn (its place among the bricks' levels).
    let finest = 0;
    if (bricks !== undefined) {
      this.uploadBricks(gl, bricks);
      finest = Math.max(0, bricks.levels.findIndex((l) => l.index >= source!.finest));
      this.chooseBricks(frame, bricks, toDisplay, side, finest);
    }
    const program = this.compile(gl, frame.outputs, bricks !== undefined);
    if (program === undefined) return;
    const texOfVoxel = Float64Array.from([1 / size[0], 0, 0, 0.5 / size[0], 0, 1 / size[1], 0, 0.5 / size[1], 0, 0, 1 / size[2], 0.5 / size[2], 0, 0, 0, 1]);
    const worldToTex = multiply(texOfVoxel, invert(voxelToDisplay));
    const step = Math.min(...voxel) * (frame.moving ? 0.9 : 0.45);

    gl.useProgram(program);
    const u = (name: string) => gl.getUniformLocation(program, name);
    gl.uniformMatrix4fv(u("uInvViewProj"), false, frame.invViewProjection);
    gl.uniformMatrix4fv(u("uViewProj"), false, frame.viewProjection);
    gl.uniformMatrix4fv(u("uWorldToTex"), false, gl4(worldToTex));
    gl.uniform3fv(u("uOccScale"), this.occScale);
    gl.uniform3fv(u("uBoxLo"), lo);
    gl.uniform3fv(u("uBoxHi"), hi);
    gl.uniform1f(u("uStep"), step);
    gl.uniform1f(u("uBlockStep"), Math.min(...voxel) * BLOCK * 0.5);
    gl.uniform1f(u("uThreshold"), this.options.threshold);
    gl.uniform1i(u("uCut"), this.options.cut ? 1 : 0);
    gl.uniform3fv(u("uCutPoint"), frame.position);
    gl.uniform3fv(u("uCutSide"), side);
    gl.uniform3fv(u("uVoxel"), voxel);
    gl.uniform1i(u("uDarkBackground"), this.darkBackground ? 1 : 0);
    gl.uniform2fv(u("uWindow"), this.window);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTexture!);
    gl.uniform1i(u("uVolume"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.occupancy!);
    gl.uniform1i(u("uOccupancy"), 1);
    // The detail box: display coordinates to its texture's, its step and voxel.
    const detail = this.detail;
    gl.uniform1i(u("uHasDetail"), detail !== undefined && this.detailTexture !== undefined ? 1 : 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.detailTexture ?? this.volumeTexture!);
    gl.uniform1i(u("uDetail"), 2);
    if (detail !== undefined) {
      const ds = detail.size;
      const detailToDisplay = multiply(toDisplay, detail.voxelToDisplay);
      const texOfDetail = Float64Array.from([1 / ds[0], 0, 0, 0.5 / ds[0], 0, 1 / ds[1], 0, 0.5 / ds[1], 0, 0, 1 / ds[2], 0.5 / ds[2], 0, 0, 0, 1]);
      gl.uniformMatrix4fv(u("uWorldToDetail"), false, gl4(multiply(texOfDetail, invert(detailToDisplay))));
      const dv = [0, 1, 2].map((r) => Math.hypot(detailToDisplay[4 * r], detailToDisplay[4 * r + 1], detailToDisplay[4 * r + 2]));
      gl.uniform1f(u("uDetailStep"), Math.min(...dv) * (frame.moving ? 0.9 : 0.45));
      gl.uniform3fv(u("uDetailVoxel"), dv);
    }
    if (bricks !== undefined) {
      // Per brick level: display coordinates to its voxels, its page table's place and size, its step and voxel.
      const worldToLevel = new Float32Array(16 * MAX_LEVELS);
      const offsets = new Int32Array(3 * MAX_LEVELS);
      const grids = new Int32Array(3 * MAX_LEVELS);
      const steps = new Float32Array(MAX_LEVELS);
      const voxels = new Float32Array(3 * MAX_LEVELS);
      bricks.levels.forEach((l, i) => {
        const m = multiply(toDisplay, l.voxelToRas);
        worldToLevel.set(gl4(invert(m)), 16 * i);
        offsets.set(bricks.layout.offsets[i], 3 * i);
        grids.set(bricks.layout.grids[i], 3 * i);
        const v = [0, 1, 2].map((r) => Math.hypot(m[4 * r], m[4 * r + 1], m[4 * r + 2]));
        voxels.set(v, 3 * i);
        steps[i] = Math.min(...v) * (frame.moving ? 0.9 : 0.45);
      });
      gl.uniformMatrix4fv(u("uWorldToLevel"), false, worldToLevel);
      gl.uniform3iv(u("uPageOffset"), offsets);
      gl.uniform3iv(u("uPageGrid"), grids);
      gl.uniform1fv(u("uLevelStep"), steps);
      gl.uniform3fv(u("uLevelVoxel"), voxels);
      gl.uniform1i(u("uLevelCount"), bricks.levels.length);
      gl.uniform1i(u("uFirstLevel"), finest);
      gl.uniform3fv(u("uAtlasTexel"), new Array(3).fill(1 / (bricks.slotsPerAxis * SLOT)));
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_3D, this.atlas!);
      gl.uniform1i(u("uAtlas"), 3);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_3D, this.pageTexture!);
      gl.uniform1i(u("uPages"), 4);
    }
    gl.bindVertexArray(this.vao!);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (bricks !== undefined) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_3D, null);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_3D, null);
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, null);
    void this.voxelSize;
  }

  dispose(): void {
    const gl = this.gl;
    if (gl === undefined) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.volumeTexture) gl.deleteTexture(this.volumeTexture);
    if (this.occupancy) gl.deleteTexture(this.occupancy);
    if (this.detailTexture) gl.deleteTexture(this.detailTexture);
    this.dropBricks();
    if (this.atlas) gl.deleteTexture(this.atlas);
    this.program = this.vao = this.volumeTexture = this.occupancy = this.detailTexture = this.atlas = undefined;
    this.gl = undefined;
  }
}
