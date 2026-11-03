/**
 * The geometry of drawing a store in a view: matrices from the store's
 * coordinates to a view's, which chunks a view sees, and which level of
 * detail to read.  Matrices are 4 × 4, column-major (as WebGL takes them),
 * in float64 until they are handed to a shader.  Pure, for the tests.
 */
import type { LayerTransform } from "@ngplatform/sdk";

export type Mat4 = Float64Array;

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a × b (column-major). */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; ++c) {
    for (let r = 0; r < 4; ++r) {
      let s = 0;
      for (let k = 0; k < 4; ++k) s += a[4 * k + r] * b[4 * c + k];
      out[4 * c + r] = s;
    }
  }
  return out;
}

/** A point through an affine or projective matrix: [x, y, z, w]. */
export function apply(m: ArrayLike<number>, p: ArrayLike<number>): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let r = 0; r < 4; ++r) out[r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r];
  return out;
}

/** The inverse of an affine matrix (last row 0 0 0 1); undefined when singular. */
export function invertAffine(m: ArrayLike<number>): Mat4 | undefined {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return undefined;
  const inv = new Float64Array(16);
  inv[0] = A / det;
  inv[4] = -(b * i - c * h) / det;
  inv[8] = (b * f - c * e) / det;
  inv[1] = B / det;
  inv[5] = (a * i - c * g) / det;
  inv[9] = -(a * f - c * d) / det;
  inv[2] = C / det;
  inv[6] = -(a * h - b * g) / det;
  inv[10] = (a * e - b * d) / det;
  for (let r = 0; r < 3; ++r) inv[12 + r] = -(inv[r] * m[12] + inv[4 + r] * m[13] + inv[8 + r] * m[14]);
  inv[15] = 1;
  return inv;
}

/**
 * The layer's transform as a map from store coordinates to global ones
 * (same layout as `transform.matrix`).  Neuroglancer keeps the matrix's
 * linear part in physical terms: an input of scale 1 mm read in a global
 * dimension of scale 0.5 mm counts two global units a store unit with an
 * identity matrix (render_coordinate_transform.ts, scaleTransformSubmatrix
 * multiplies each coefficient by the input's scale over the output's).
 * The translation is in output (global) units already.  Without this a
 * store drawn in a scene whose global scales differ from its own (a 1 mm
 * tractogram over a 1.25 mm or 0.5 mm image) lands scaled about the origin:
 * shifted, and the wrong size.
 */
export function storeToGlobal(transform: LayerTransform): Float64Array {
  const r = transform.rank;
  const n = r + 1;
  const out = Float64Array.from(transform.matrix);
  for (let o = 0; o < r; ++o) {
    const outScale = transform.output.scales[o];
    for (let j = 0; j < r; ++j) {
      const inScale = transform.input.scales[j];
      if (inScale > 0 && outScale > 0) out[n * j + o] *= inScale / outScale;
    }
  }
  return out;
}

/**
 * Store coordinates (the layer source's x, y, z) to three named global
 * dimensions (a 3-D view's display dimensions), through the layer's
 * transform; undefined when one is not among the layer's outputs.
 */
export function modelTo(transform: LayerTransform, names: string[]): Mat4 | undefined {
  const r = transform.rank;
  const n = r + 1;
  const M = storeToGlobal(transform);
  const out = new Float64Array(16);
  out[15] = 1;
  for (let i = 0; i < 3; ++i) {
    const g = transform.output.names.indexOf(names[i]);
    if (g < 0) return undefined;
    for (let j = 0; j < Math.min(3, r); ++j) out[4 * j + i] = M[n * j + g];
    out[12 + i] = M[n * r + g];
  }
  return out;
}

/**
 * Store directions to physical ones (column-major 3 × 3), for colouring by
 * direction: the layer's global x, y and z (or its first three outputs),
 * each in its own unit's metres, so x is red, y green and z blue.
 */
export function directionMatrix(transform: LayerTransform): Float32Array {
  const r = transform.rank;
  const n = r + 1;
  const names = transform.output.names;
  const M = storeToGlobal(transform);
  const axes = ["x", "y", "z"].every((a) => names.includes(a)) ? ["x", "y", "z"].map((a) => names.indexOf(a)) : [0, 1, 2];
  const out = new Float32Array(9);
  for (let i = 0; i < 3; ++i) {
    const g = axes[i];
    if (g >= r) continue;
    const scale = transform.output.scales[g] || 1;
    for (let j = 0; j < Math.min(3, r); ++j) out[3 * j + i] = M[n * j + g] * scale;
  }
  return out;
}

/** The chunks of a grid of `shape` that a box (store coordinates) touches: inclusive ranges. */
export function chunkRange(lower: number[], upper: number[], shape: number[]): { from: number[]; to: number[] } {
  return {
    from: [0, 1, 2].map((k) => Math.floor(lower[k] / shape[k])),
    to: [0, 1, 2].map((k) => Math.floor(upper[k] / shape[k])),
  };
}

/** The chunks of a range, in a list. */
export function chunksIn(range: { from: number[]; to: number[] }, limit = 1e6): number[][] {
  const out: number[][] = [];
  for (let x = range.from[0]; x <= range.to[0]; ++x) {
    for (let y = range.from[1]; y <= range.to[1]; ++y) {
      for (let z = range.from[2]; z <= range.to[2]; ++z) {
        out.push([x, y, z]);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** Whether any of a box (store coordinates) can show through a model → clip matrix: not wholly beyond one clip plane. */
export function boxInFrustum(modelToClip: ArrayLike<number>, lower: number[], upper: number[]): boolean {
  const corners: [number, number, number, number][] = [];
  for (let c = 0; c < 8; ++c) corners.push(apply(modelToClip, [c & 1 ? upper[0] : lower[0], c & 2 ? upper[1] : lower[1], c & 4 ? upper[2] : lower[2]]));
  for (let axis = 0; axis < 3; ++axis) {
    if (corners.every((p) => p[axis] < -p[3])) return false;
    if (corners.every((p) => p[axis] > p[3])) return false;
  }
  return true;
}

/** The box of chunk `coords` in a grid of `shape`. */
export function chunkBox(coords: number[], shape: number[]): { lower: number[]; upper: number[] } {
  return { lower: coords.map((c, k) => c * shape[k]), upper: coords.map((c, k) => (c + 1) * shape[k]) };
}

export interface LevelChoice {
  vertexCount: number | undefined;
  /** How many of its chunks the view touches, and how many it has in all (within the store's bounds). */
  visible: number;
  total: number;
}

/**
 * The finest level whose chunks in view hold about `budget` vertices or
 * fewer (levels finest first, as stores order them), assuming vertices
 * spread evenly over a level's chunks; the coarsest when none does.
 */
export function chooseLevel(levels: LevelChoice[], budget: number): number {
  for (let i = 0; i < levels.length; ++i) {
    const { vertexCount, visible, total } = levels[i];
    if (vertexCount === undefined || total === 0) continue;
    if ((vertexCount * visible) / total <= budget) return i;
  }
  return levels.length - 1;
}

/**
 * About how many pixels one store unit spans on screen around a point: the
 * mean over the three axes of a unit step's movement, in pixels.
 */
export function pixelsPerUnit(modelToClip: ArrayLike<number>, at: ArrayLike<number>, viewport: [number, number]): number {
  const c = apply(modelToClip, at);
  if (!(c[3] > 0)) return 0;
  let sum = 0;
  for (let k = 0; k < 3; ++k) {
    const p = [at[0], at[1], at[2]];
    p[k] += 1;
    const d = apply(modelToClip, p);
    if (!(d[3] > 0)) continue;
    const dx = ((d[0] / d[3] - c[0] / c[3]) * viewport[0]) / 2;
    const dy = ((d[1] / d[3] - c[1] / c[3]) * viewport[1]) / 2;
    sum += Math.hypot(dx, dy);
  }
  return sum / 3;
}

/**
 * The area (pixels) of the view that a box (store coordinates) can cover:
 * its corners' bounding rectangle on screen, within the view; the whole
 * view when a corner is behind the camera.
 */
export function screenArea(modelToClip: ArrayLike<number>, lower: number[], upper: number[], viewport: [number, number]): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let c = 0; c < 8; ++c) {
    const p = apply(modelToClip, [c & 1 ? upper[0] : lower[0], c & 2 ? upper[1] : lower[1], c & 4 ? upper[2] : lower[2]]);
    if (!(p[3] > 0)) return viewport[0] * viewport[1];
    const x = p[0] / p[3];
    const y = p[1] / p[3];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const w = Math.max(0, Math.min(1, x1) - Math.max(-1, x0)) / 2;
  const h = Math.max(0, Math.min(1, y1) - Math.max(-1, y0)) / 2;
  return Math.max(1, w * viewport[0] * h * viewport[1]);
}

/**
 * How many times over the lines drawn would cover the view: their length on
 * screen times their width, over the view's area (`share` of them showing,
 * for a 2-D view's slab).
 */
export function coverage(chunks: { length: number; pointCount: number; shown?: number }[], pixelsPerUnit: number, widthPx: number, area: number, share = 1): number {
  let covered = 0;
  // Of a chunk whose objects are not all shown (a layer's chosen segments), its share shown.
  for (const c of chunks) covered += (c.length * pixelsPerUnit * widthPx + c.pointCount * Math.PI * (1.5 * widthPx) ** 2) * (c.shown ?? 1);
  return area > 0 ? (covered * share) / area : 0;
}

/** The share of these chunks' lines and points shown (a layer's chosen segments), by weight; 1 with none. */
export function shownShare(chunks: { length: number; pointCount: number; shown?: number }[]): number {
  let total = 0;
  let shown = 0;
  for (const c of chunks) {
    const w = c.length + c.pointCount;
    total += w;
    shown += w * (c.shown ?? 1);
  }
  return total > 0 ? shown / total : 1;
}

/** At most this many times the Detail is read for a view showing a few of a layer's objects. */
export const MAX_SELECTION_BOOST = 4;

/**
 * The vertex budget for a view: the Detail, raised when only a share of the
 * objects shows (a layer's chosen segments: the vertices drawn, not those
 * read, are what Detail aims at, and a coarse level is only a sample of the
 * objects), at most MAX_SELECTION_BOOST times.
 */
export function vertexBudget(detail: number, share: number): number {
  return (detail * 1e6) / Math.max(1 / MAX_SELECTION_BOOST, Math.min(1, share));
}

/**
 * Automatic brightness: lines that would cover the view many times over are
 * each drawn dimmer, so a dense whole-brain view glows where bundles gather
 * instead of turning white, and the picture keeps its brightness as levels
 * of detail (with ten times the lines each) come and go.  Sparse views are
 * left alone.
 */
export function autoGain(cover: number): number {
  return 1 / Math.max(1, cover);
}

/**
 * The affine map a 2-D view gives, measured through its `project` (a global
 * position to pixels and depth): three rows (x px, y px, depth), each the
 * coefficients of every global coordinate and then a constant.  `base` is
 * the position measured around (the view's own, so the steps are small
 * beside it).
 */
export function measurePanel(project: (global: number[]) => { x: number; y: number; depth: number } | undefined, base: number[], step = 1): number[][] | undefined {
  const at = project(base);
  if (at === undefined) return undefined;
  const rows: number[][] = [[], [], []];
  for (let g = 0; g < base.length; ++g) {
    const moved = base.slice();
    moved[g] += step;
    const p = project(moved);
    if (p === undefined) return undefined;
    rows[0].push((p.x - at.x) / step);
    rows[1].push((p.y - at.y) / step);
    rows[2].push((p.depth - at.depth) / step);
  }
  const values = [at.x, at.y, at.depth];
  for (let i = 0; i < 3; ++i) {
    let s = 0;
    for (let g = 0; g < base.length; ++g) s += rows[i][g] * base[g];
    rows[i].push(values[i] - s);
  }
  return rows;
}

/**
 * Store coordinates to a 2-D view's (x px, y px, depth): the layer's
 * transform (to the global dimensions `globalNames`, in order) and then the
 * view's measured rows.
 */
export function modelToPanel(transform: LayerTransform, globalNames: string[], rows: number[][]): Mat4 {
  const r = transform.rank;
  const n = r + 1;
  const T = storeToGlobal(transform);
  const R = globalNames.length;
  const outputOf = globalNames.map((name) => transform.output.names.indexOf(name));
  const out = new Float64Array(16);
  out[15] = 1;
  for (let i = 0; i < 3; ++i) {
    for (let j = 0; j < 4; ++j) {
      if (j < 3 && j >= r) continue;
      // Column j of the store-to-global map: input j's coefficients, or (j = 3) the translation.
      const col = j < 3 ? j : r;
      let s = j === 3 ? rows[i][R] : 0;
      for (let g = 0; g < R; ++g) {
        const o = outputOf[g];
        if (o >= 0) s += rows[i][g] * T[n * col + o];
      }
      out[4 * j + i] = s;
    }
  }
  return out;
}

/** The global dimensions and the view's position, as a 2-D view's camera needs them. */
export interface Globals {
  names: string[];
  scales: number[];
  units: string[];
  position: number[];
}

/**
 * RAS millimetres to a 2-D view's (x px, y px, depth), column-major: the
 * global dimensions named x, y and z are RAS (as Neuroglancer shows NIfTI
 * and OME-Zarr in mm), the others held at the view's position.
 */
export function rasToPanel(globals: Globals, rows: number[][]): Float64Array {
  const R = globals.names.length;
  const out = new Float64Array(16);
  out[15] = 1;
  for (let i = 0; i < 3; ++i) {
    let constant = rows[i][R];
    for (let g = 0; g < R; ++g) {
      const axis = ["x", "y", "z"].indexOf(globals.names[g]);
      // Global units per millimetre on this dimension.
      const perMm = (globals.units[g] === "m" ? 1e-3 : 1) / globals.scales[g];
      if (axis === -1) constant += rows[i][g] * globals.position[g];
      else out[4 * axis + i] += rows[i][g] * perMm;
    }
    out[12 + i] = constant;
  }
  return out;
}

/** The section of a view as a plane on RAS mm (mm from it), from its RAS-to-panel map's depth row. */
export function sectionPlane(toPanel: ArrayLike<number>): [number, number, number, number] | undefined {
  const a = toPanel[2];
  const b = toPanel[6];
  const c = toPanel[10];
  const norm = Math.hypot(a, b, c);
  if (!(norm > 0)) return undefined;
  return [a / norm, b / norm, c / norm, toPanel[14] / norm];
}
