/**
 * Between Neuroglancer's global coordinates and a layer's source
 * coordinates, in any number of dimensions (an image's t, x, y and z; an
 * annotation layer's x, y, z).
 *
 * A layer transform (the SDK's `LayerTransform`) is homogeneous and
 * column-major; its linear part is a ratio of physical lengths and its
 * translation is in multiples of the output scales (as Neuroglancer keeps
 * them).  A source coordinate is a multiple of its input scale: for an
 * OME-Zarr image, a voxel index, with voxel centres at whole numbers.
 */
import type { LayerTransform } from "@ngplatform/sdk";

/** Neuroglancer's global coordinate space: its dimensions in order, each scale in its unit. */
export interface GlobalSpace {
  names: string[];
  scales: number[];
  units: string[];
}

export function globalSpace(ng: unknown): GlobalSpace {
  const dims = ((ng as { dimensions?: Record<string, [number, string]> })?.dimensions ?? {}) as Record<string, [number, string]>;
  const entries = Object.entries(dims);
  return { names: entries.map(([n]) => n), scales: entries.map(([, [s]]) => s), units: entries.map(([, [, u]]) => u) };
}

/** A square matrix's inverse (row-major rows), or undefined when it has none. */
export function invert(m: number[][]): number[][] | undefined {
  const n = m.length;
  const a = m.map((row, r) => [...row, ...Array.from({ length: n }, (_, c) => (c === r ? 1 : 0))]);
  for (let c = 0; c < n; ++c) {
    let pivot = c;
    for (let r = c + 1; r < n; ++r) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (!(Math.abs(a[pivot][c]) > 1e-300)) return undefined;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const p = a[c][c];
    for (let k = 0; k < 2 * n; ++k) a[c][k] /= p;
    for (let r = 0; r < n; ++r) {
      if (r === c) continue;
      const f = a[r][c];
      if (f !== 0) for (let k = 0; k < 2 * n; ++k) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row) => row.slice(n));
}

/** A layer's output dimension name as a global one: a local (`t'`) or channel (`c^`) dimension is not global. */
const isGlobal = (name: string) => !/['^]$/.test(name);

/**
 * A layer's map between global positions and its source coordinates.  Its
 * output dimensions that are not global (local or channel ones) are taken
 * at 0.
 */
export class LayerMap {
  /** For each output dimension, the global dimension it is (-1 when none). */
  readonly dims: number[];
  /** The linear part (physical), row r output, column c input. */
  private readonly linear: number[][];
  private readonly inverse: number[][] | undefined;

  constructor(
    readonly transform: LayerTransform,
    readonly space: GlobalSpace,
  ) {
    const n = transform.rank;
    const m = transform.matrix;
    this.dims = transform.output.names.map((name) => (isGlobal(name) ? space.names.indexOf(name) : -1));
    this.linear = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => m[(n + 1) * c + r]));
    this.inverse = invert(this.linear);
  }

  get rank(): number {
    return this.transform.rank;
  }

  /** The source's dimension names, without a local or channel mark. */
  get inputNames(): string[] {
    return this.transform.input.names.map((n) => n.replace(/['^]$/, ""));
  }

  /** Whether the map can be inverted (global positions to source coordinates). */
  get invertible(): boolean {
    return this.inverse !== undefined;
  }

  /** Source coordinates to a global position (dimensions the layer does not span are taken from `base`, else NaN). */
  toGlobal(input: ArrayLike<number>, base?: ArrayLike<number>): number[] {
    const { rank: n, matrix: m, input: ins, output: outs } = this.transform;
    const out = Array.from({ length: this.space.names.length }, (_, i) => (base === undefined ? NaN : base[i]));
    for (let r = 0; r < n; ++r) {
      const g = this.dims[r];
      if (g === -1) continue;
      let physical = 0;
      for (let c = 0; c < n; ++c) physical += this.linear[r][c] * input[c] * ins.scales[c];
      physical += m[(n + 1) * n + r] * outs.scales[r];
      out[g] = physical / this.space.scales[g];
    }
    return out;
  }

  /** A global position to source coordinates; undefined when the map has no inverse. */
  toInput(global: ArrayLike<number>): number[] | undefined {
    const inverse = this.inverse;
    if (inverse === undefined) return undefined;
    const { rank: n, matrix: m, input: ins, output: outs } = this.transform;
    const physical = Array.from({ length: n }, (_, r) => {
      const g = this.dims[r];
      const at = g === -1 ? 0 : global[g] * this.space.scales[g];
      return (Number.isFinite(at) ? at : 0) - m[(n + 1) * n + r] * outs.scales[r];
    });
    return Array.from({ length: n }, (_, c) => {
      let s = 0;
      for (let r = 0; r < n; ++r) s += inverse[c][r] * physical[r];
      return s / ins.scales[c];
    });
  }

  /** Where the array starts along source dimension `c`: -0.5 for OME-Zarr, whose voxel centres are whole numbers. */
  lower(c: number): number {
    const lo = this.transform.input.bounds?.lower[c];
    return lo !== undefined && Number.isFinite(lo) ? lo : -0.5;
  }

  /** The voxel (array index) holding a source coordinate along dimension `c`. */
  voxelOf(c: number, coordinate: number): number {
    return Math.floor(coordinate - this.lower(c));
  }

  /** The source coordinate of voxel `index`'s centre along dimension `c`. */
  centreOf(c: number, index: number): number {
    return this.lower(c) + index + 0.5;
  }
}
