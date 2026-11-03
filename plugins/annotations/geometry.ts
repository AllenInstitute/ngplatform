/**
 * Where things are: a grid of voxels (an image, a label volume) and an
 * annotation layer's coordinates, each placed in Neuroglancer's global space
 * through its layer's transform; lengths in millimetres; and the point of a
 * 2-D view under a pixel.
 *
 * Conventions, as in Registration: matrices are 4 × 4 row-major; a grid's
 * `voxelToRas` takes voxel indices (x, y, z; integers at voxel centres) to
 * RAS millimetres, as the volume reader gives it; Neuroglancer's matrices
 * are homogeneous and column-major, in multiples of each side's scales.
 */
import type { Json, LayerTransform } from "@ngplatform/sdk";
import { invert4, type Mat4, multiply4 } from "../registration/fit.js";
import { axisOrder } from "../registration/manual.js";

export type { Mat4 };

/** Millimetres in one step of a scale in a unit (metres or, unitless, as is). */
export const mmOf = (scale: number, unit: string): number => (unit === "m" ? scale * 1000 : scale);

/** Neuroglancer's global coordinate space: its dimensions in order, each scale in its unit. */
export interface GlobalSpace {
  names: string[];
  scales: number[];
  units: string[];
}

export function globalSpace(ng: Json): GlobalSpace {
  const dims = (ng.dimensions ?? {}) as Record<string, [number, string]>;
  const entries = Object.entries(dims);
  return { names: entries.map(([n]) => n), scales: entries.map(([, [s]]) => s), units: entries.map(([, [, u]]) => u) };
}

/** Distance between two global positions, in millimetres, over the spatial dimensions (those in metres). */
export function distanceMm(a: ArrayLike<number>, b: ArrayLike<number>, space: GlobalSpace): number {
  let s = 0;
  space.names.forEach((_, i) => {
    if (space.units[i] !== "m") return;
    const d = (a[i] - b[i]) * mmOf(space.scales[i], "m");
    if (Number.isFinite(d)) s += d * d;
  });
  return Math.sqrt(s);
}

/**
 * A layer's transform as a map of millimetres: its source's physical space
 * to the global one (rows the output dimensions, columns the input ones);
 * undefined unless it is 3-D.  Neuroglancer keeps the linear part as a
 * ratio of physical lengths and the translation in multiples of the output
 * scales.
 */
export function physical(t: LayerTransform, matrix: ArrayLike<number> = t.matrix): Mat4 | undefined {
  if (t.rank !== 3 || matrix.length !== 16) return undefined;
  const p = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) p[4 * r + c] = matrix[4 * c + r];
    p[4 * r + 3] = mmOf(t.output.scales[r], t.output.units[r]) * matrix[12 + r];
  }
  return p;
}

/** A grid of voxels placed in the global space: which global dimensions it spans, and voxels to their coordinates and back. */
export interface Placement {
  /** For the matrices' rows 0..2: the global dimension each is. */
  dims: [number, number, number];
  voxelToGlobal: Mat4;
  globalToVoxel: Mat4;
  /** Voxel indices to global millimetres (the same rows): for lengths and volumes. */
  voxelToMm: Mat4;
}

/**
 * Where a layer shows a grid it reads (voxel indices to RAS mm, `voxelToRas`):
 * the source's own transform (its default) takes its physical space to RAS
 * along the output axes; the layer's current one may have moved it since.
 */
export function placement(t: LayerTransform | undefined, voxelToRas: Mat4, space: GlobalSpace): Placement | undefined {
  if (t === undefined) return undefined;
  const m = physical(t);
  const d = physical(t, t.defaultMatrix);
  if (m === undefined || d === undefined) return undefined;
  const dims = t.output.names.map((n) => space.names.indexOf(n));
  if (dims.length !== 3 || dims.some((i) => i < 0)) return undefined;
  // RAS (x, y, z) to the output axes' order.
  const order = axisOrder(t.output.names);
  const toOutput = new Float64Array(16);
  toOutput[15] = 1;
  for (let k = 0; k < 3; ++k) toOutput[4 * order[k] + k] = 1;
  let voxelToMm: Mat4;
  try {
    voxelToMm = multiply4(multiply4(m, invert4(d)), multiply4(toOutput, voxelToRas));
  } catch {
    return undefined;
  }
  const toGlobal = new Float64Array(16);
  toGlobal[15] = 1;
  for (let r = 0; r < 3; ++r) toGlobal[5 * r] = 1 / mmOf(space.scales[dims[r]], space.units[dims[r]]);
  const voxelToGlobal = multiply4(toGlobal, voxelToMm);
  return { dims: dims as [number, number, number], voxelToGlobal, globalToVoxel: invert4(voxelToGlobal), voxelToMm };
}

/** A matrix's inverse, or undefined when it has none. */
export function invertOr(m: Mat4): Mat4 | undefined {
  try {
    return invert4(m);
  } catch {
    return undefined;
  }
}

/** A point through a 4 × 4 matrix. */
export function apply(m: ArrayLike<number>, p: ArrayLike<number>): [number, number, number] {
  return [0, 1, 2].map((r) => m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3]) as [number, number, number];
}

export { multiply4 as multiply };

/** A placed grid's map to its global dimensions, its rows in the order of `dims`; undefined if it spans others. */
function rowsFor(p: Placement, dims: number[]): Mat4 | undefined {
  const out = new Float64Array(16);
  out[15] = 1;
  for (let r = 0; r < 3; ++r) {
    const from = p.dims.indexOf(dims[r]);
    if (from < 0) return undefined;
    for (let c = 0; c < 4; ++c) out[4 * r + c] = p.voxelToGlobal[4 * from + c];
  }
  return out;
}

/** From one placed grid's voxels to another's (both in the same three global dimensions); undefined otherwise. */
export function between(from: Placement, to: Placement): Mat4 | undefined {
  const dims = [...from.dims].sort((a, b) => a - b);
  const a = rowsFor(from, dims);
  const b = rowsFor(to, dims);
  const inv = b && invertOr(b);
  return a && inv ? multiply4(inv, a) : undefined;
}

/** A global position (all dimensions) as the voxel coordinates of a placed grid. */
export function toVoxel(p: Placement, global: ArrayLike<number>): [number, number, number] {
  const g = p.dims.map((d) => global[d]);
  const m = p.globalToVoxel;
  return [0, 1, 2].map((r) => m[4 * r] * g[0] + m[4 * r + 1] * g[1] + m[4 * r + 2] * g[2] + m[4 * r + 3]) as [number, number, number];
}

/** Voxel coordinates of a placed grid as a global position, the other dimensions taken from `base`. */
export function toGlobal(p: Placement, voxel: ArrayLike<number>, base: ArrayLike<number>): number[] {
  const out = Array.from(base);
  const m = p.voxelToGlobal;
  for (let r = 0; r < 3; ++r) out[p.dims[r]] = m[4 * r] * voxel[0] + m[4 * r + 1] * voxel[1] + m[4 * r + 2] * voxel[2] + m[4 * r + 3];
  return out;
}

/** Edge lengths of a voxel in millimetres (the columns of the linear part). */
export function voxelEdges(voxelToMm: Mat4): [number, number, number] {
  return [0, 1, 2].map((c) => Math.hypot(voxelToMm[c], voxelToMm[4 + c], voxelToMm[8 + c])) as [number, number, number];
}

/** The volume of one voxel in mm³. */
export function voxelVolume(voxelToMm: Mat4): number {
  const m = voxelToMm;
  return Math.abs(m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]));
}

// -------------------------------------------------------- annotations

/**
 * An annotation layer's coordinates as global positions: Neuroglancer's
 * matrix (homogeneous, column-major, rank + 1 square) from the layer's
 * coordinates to its output dimensions, each in its own scale, then those
 * as global coordinates.  Dimensions it does not reach are NaN.
 */
export function annotationToGlobal(t: LayerTransform | undefined, space: GlobalSpace, rank: number): (point: ArrayLike<number>) => number[] {
  if (t === undefined || t.rank !== rank || t.matrix.length !== (rank + 1) * (rank + 1)) {
    // No transform known: the coordinates are taken as the global ones, in order.
    return (point) => space.names.map((_, i) => (i < point.length ? point[i] : NaN));
  }
  const R = rank;
  const m = t.matrix;
  const target = t.output.names.map((n) => space.names.indexOf(n));
  const ratio = t.output.names.map((_, r) => {
    const g = target[r];
    return g < 0 ? 1 : mmOf(t.output.scales[r], t.output.units[r]) / mmOf(space.scales[g], space.units[g]);
  });
  const scale = (c: number, r: number) => {
    const i = t.input.scales[c];
    const o = t.output.scales[r];
    return i > 0 && o > 0 ? i / o : 1;
  };
  return (point) => {
    const out = space.names.map(() => NaN);
    for (let r = 0; r < R; ++r) {
      const g = target[r];
      if (g < 0) continue;
      let v = m[R * (R + 1) + r];
      // The linear part is physical: each coefficient times the input's scale over the output's
      // (Neuroglancer's convention), the translation in the output's units.
      for (let c = 0; c < R; ++c) v += m[c * (R + 1) + r] * scale(c, r) * point[c];
      out[g] = v * ratio[r];
    }
    return out;
  };
}

/** A global position's spatial part in millimetres, as a vector over the dimensions in metres. */
export function spatialMm(global: ArrayLike<number>, space: GlobalSpace): number[] {
  const out: number[] = [];
  space.names.forEach((_, i) => {
    if (space.units[i] === "m") out.push(global[i] * mmOf(space.scales[i], "m"));
  });
  return out;
}

// ------------------------------------------------------------ 2-D views

/** What a 2-D view tells of a global position: pixels from its top left, and depth through its section. */
export type Project = (global: ArrayLike<number>) => { x: number; y: number; depth: number } | undefined;

/**
 * The inverse of a 2-D view's projection near `position`: the global
 * position under a pixel, on the section through `position`; with the
 * view's plane normal (as a global covector: depth per unit of each
 * dimension) and its pixels per unit of each dimension in the plane.
 * Undefined if the view does not show three dimensions there.
 */
export function unprojector(
  project: Project,
  position: ArrayLike<number>,
): { at(x: number, y: number): number[]; dims: number[]; depthPerUnit: number[]; pixelsPerUnit: number[] } | undefined {
  const base = Array.from(position);
  const p0 = project(base);
  if (p0 === undefined) return undefined;
  const dims: number[] = [];
  const columns: number[][] = [];
  for (let i = 0; i < base.length; ++i) {
    // Steps sized to move a hundred or so pixels: the view's matrix is single precision.
    let h = 1;
    let col: number[] | undefined;
    for (let attempt = 0; attempt < 3; ++attempt) {
      const q = base.slice();
      q[i] += h;
      const p = project(q);
      if (p === undefined) break;
      col = [(p.x - p0.x) / h, (p.y - p0.y) / h, (p.depth - p0.depth) / h];
      const size = Math.max(Math.abs(col[0]), Math.abs(col[1]), Math.abs(col[2]) * 100);
      if (!(size > 0)) {
        col = undefined;
        break;
      }
      const want = 100 / size;
      if (Math.abs(Math.log(want / h)) < 0.5) break;
      h = want;
    }
    if (col !== undefined && Math.max(Math.abs(col[0]), Math.abs(col[1]), Math.abs(col[2])) > 1e-12) {
      dims.push(i);
      columns.push(col);
    }
  }
  if (dims.length !== 3) return undefined;
  // J: rows x, y and depth; columns the dimensions shown.
  const Jm = new Float64Array(16);
  for (let r = 0; r < 3; ++r) for (let c = 0; c < 3; ++c) Jm[4 * r + c] = columns[c][r];
  Jm[15] = 1;
  let inv: Mat4;
  try {
    inv = invert4(Jm);
  } catch {
    return undefined;
  }
  return {
    dims,
    depthPerUnit: columns.map((c) => c[2]),
    pixelsPerUnit: columns.map((c) => Math.hypot(c[0], c[1])),
    at(x, y) {
      const d = [x - p0.x, y - p0.y, -p0.depth];
      const out = base.slice();
      for (let r = 0; r < 3; ++r) out[dims[r]] += inv[4 * r] * d[0] + inv[4 * r + 1] * d[1] + inv[4 * r + 2] * d[2];
      return out;
    },
  };
}
