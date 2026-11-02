/**
 * Label statistics, as Freeview's: an image's values inside a region (a
 * box, an ellipsoid, or a label of a label volume): the voxel count, the
 * volume, and the mean, standard deviation, minimum, maximum and median.
 *
 * The image is read as a block of voxels (x fastest) from `lo`; a region is
 * a test of a voxel's indices in that image.  Plain code, run in the
 * annotations worker, tested without one.
 */
import type { Mat4 } from "./geometry.js";

export interface Summary {
  count: number;
  mean: number;
  /** Standard deviation with n − 1 (as FreeSurfer's mri_segstats reports it). */
  sd: number;
  min: number;
  max: number;
  median: number;
}

/** The summary of some values (NaN ones left out); sorts `values` in place. */
export function summarise(values: Float32Array | Float64Array): Summary {
  let n = 0;
  let mean = 0;
  let m2 = 0;
  let min = Infinity;
  let max = -Infinity;
  // Welford: steady over millions of values.
  for (let i = 0; i < values.length; ++i) {
    const v = values[i];
    if (v !== v) continue;
    ++n;
    const d = v - mean;
    mean += d / n;
    m2 += d * (v - mean);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (n === 0) return { count: 0, mean: NaN, sd: NaN, min: NaN, max: NaN, median: NaN };
  // NaN sorts last in a typed array.
  values.sort();
  const median = n % 2 === 1 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
  return { count: n, mean, sd: n > 1 ? Math.sqrt(m2 / (n - 1)) : 0, min, max, median };
}

/** A region: which voxels of the image (by index) are in it. */
export type Region =
  /** A box or ellipsoid in another space: voxel → that space by `affine`, then inside [lo, hi] / the unit ball around `centre` scaled by `radii`. */
  | { kind: "box"; affine: number[]; lo: number[]; hi: number[] }
  | { kind: "ellipsoid"; affine: number[]; centre: number[]; radii: number[] }
  /** A label of a label volume: voxel → its voxel (nearest) by `affine`; `labels` is a block of it from `origin`, `size` voxels, x fastest. */
  | { kind: "label"; affine: number[]; labels: ArrayLike<number>; origin: number[]; size: number[]; value: number };

/** A test of image voxel indices for a region. */
export function regionTest(region: Region): (x: number, y: number, z: number) => boolean {
  const a = region.affine;
  const at = (x: number, y: number, z: number, r: number) => a[4 * r] * x + a[4 * r + 1] * y + a[4 * r + 2] * z + a[4 * r + 3];
  if (region.kind === "box") {
    const lo = region.lo.map((v, k) => Math.min(v, region.hi[k]));
    const hi = region.lo.map((v, k) => Math.max(v, region.hi[k]));
    return (x, y, z) => {
      for (let r = 0; r < 3; ++r) {
        const v = at(x, y, z, r);
        if (v < lo[r] || v > hi[r]) return false;
      }
      return true;
    };
  }
  if (region.kind === "ellipsoid") {
    const { centre, radii } = region;
    return (x, y, z) => {
      let s = 0;
      for (let r = 0; r < 3; ++r) {
        const d = at(x, y, z, r) - centre[r];
        // A flat axis (radius 0) takes the section it lies in.
        if (radii[r] === 0) {
          if (Math.abs(d) > 0.5) return false;
          continue;
        }
        s += (d / radii[r]) ** 2;
      }
      return s <= 1;
    };
  }
  const { labels, origin, size, value } = region;
  return (x, y, z) => {
    const i = Math.round(at(x, y, z, 0)) - origin[0];
    const j = Math.round(at(x, y, z, 1)) - origin[1];
    const k = Math.round(at(x, y, z, 2)) - origin[2];
    if (i < 0 || j < 0 || k < 0 || i >= size[0] || j >= size[1] || k >= size[2]) return false;
    return labels[i + size[0] * (j + size[1] * k)] === value;
  };
}

/**
 * The values of a block of the image (`size` voxels from voxel `lo`, x
 * fastest) inside a region.
 */
export function valuesInside(block: ArrayLike<number>, lo: number[], size: number[], inside: (x: number, y: number, z: number) => boolean): Float32Array {
  const out = new Float32Array(block.length);
  let n = 0;
  let at = 0;
  for (let k = 0; k < size[2]; ++k) {
    for (let j = 0; j < size[1]; ++j) {
      for (let i = 0; i < size[0]; ++i, ++at) {
        if (inside(lo[0] + i, lo[1] + j, lo[2] + k)) out[n++] = block[at];
      }
    }
  }
  return out.subarray(0, n);
}

/**
 * The image voxels a region can reach: the box of `corners` (points in the
 * region's space) mapped back to voxels by `toVoxel`, a voxel wider, inside
 * `[0, size)`.  Undefined when it misses the image.
 */
export function voxelBox(corners: number[][], toVoxel: Mat4, size: number[]): { lo: number[]; hi: number[] } | undefined {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of corners) {
    for (let r = 0; r < 3; ++r) {
      const v = toVoxel[4 * r] * p[0] + toVoxel[4 * r + 1] * p[1] + toVoxel[4 * r + 2] * p[2] + toVoxel[4 * r + 3];
      lo[r] = Math.min(lo[r], v);
      hi[r] = Math.max(hi[r], v);
    }
  }
  const a = lo.map((v) => Math.max(0, Math.floor(v) - 1));
  const b = hi.map((v, r) => Math.min(size[r], Math.ceil(v) + 2));
  return a.every((v, r) => v < b[r]) ? { lo: a, hi: b } : undefined;
}

/** The eight corners of a box between two points. */
export function corners(a: number[], b: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < 8; ++i) out.push([i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]]);
  return out;
}

/**
 * The finest level (finest first) whose box for a region is at most
 * `maxVoxels`; or the coarsest.  `boxAt` gives a level's box voxel count.
 */
export function levelWithin(levels: number, boxAt: (level: number) => number, maxVoxels: number): number {
  for (let i = 0; i < levels; ++i) if (boxAt(i) <= maxVoxels) return i;
  return levels - 1;
}
