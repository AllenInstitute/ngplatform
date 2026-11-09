/**
 * Track density maps: how many of a group's streamlines pass through each
 * voxel of a grid over the store (each streamline counted once a voxel), as
 * a NIfTI-1 image in RAS+ millimetres, which loads onto the store's space
 * (and into MRtrix, FSL, DSI Studio or nibabel).
 *
 * The grid covers the store's bounds, at the voxel size asked for, else 1 mm
 * for brain-sized stores and a round size giving at most 256 voxels across
 * for others (voxelSize).  Segments are walked in steps of half a voxel.
 */
import type { StoreInfo } from "./roi_worker.js";
import { millimetres } from "./trk.js";

export interface DensityGrid {
  /** The centre of the first voxel, mm (RAS+). */
  origin: [number, number, number];
  dims: [number, number, number];
  /** Voxel size, mm. */
  voxel: number;
  /** Store coordinates to mm, per axis: mm = (x + offset) * scale. */
  scale: [number, number, number];
  offset: [number, number, number];
}

/**
 * The grid's voxel size, mm: 1 mm for stores 25.6 to 256 mm across (brains,
 * as track density maps usually are), else a round size (1, 2, 2.5 or 5
 * times a power of ten) giving at most 256 voxels across.
 */
export function voxelSize(extent: number): number {
  if (!(extent > 0)) return 1;
  if (extent > 25.6 && extent <= 256) return 1;
  const want = extent / 256;
  const power = 10 ** Math.floor(Math.log10(want));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((v) => v >= want * (1 - 1e-9)) ?? 10 * power;
}

/** The most voxels a density grid may have: a count and a stamp each, 8 bytes a voxel (256 MB). */
export const MAX_DENSITY_VOXELS = 2 ** 25;

/** The store's bounds in mm (RAS+): low and high corners. */
function boundsMm(info: StoreInfo): { lo: number[]; hi: number[]; scale: [number, number, number]; offset: [number, number, number] } {
  const scale = millimetres(info);
  const offset = [0, 1, 2].map((k) => info.coordinateOffset?.[k] ?? 0) as [number, number, number];
  const lo = [0, 1, 2].map((k) => Math.min(info.bounds.lower[k], info.bounds.upper[k]) * scale[k] + offset[k] * scale[k]);
  const hi = [0, 1, 2].map((k) => Math.max(info.bounds.lower[k], info.bounds.upper[k]) * scale[k] + offset[k] * scale[k]);
  return { lo, hi, scale, offset };
}

/** The voxel size a store's density map has unless another is asked for, mm. */
export function defaultVoxel(info: StoreInfo): number {
  const { lo, hi } = boundsMm(info);
  return voxelSize(Math.max(...hi.map((h, k) => h - lo[k])));
}

/**
 * The grid over the store's bounds, of `voxel` mm voxels (else
 * defaultVoxel).  Throws when that is more than MAX_DENSITY_VOXELS voxels,
 * saying the smallest voxel that fits.
 */
export function densityGrid(info: StoreInfo, voxel = defaultVoxel(info)): DensityGrid {
  if (!(voxel > 0) || !Number.isFinite(voxel)) throw new Error(`a voxel size must be more than 0 mm, not ${voxel}`);
  const { lo, hi, scale, offset } = boundsMm(info);
  const origin = lo.map((v) => Math.floor(v / voxel) * voxel) as [number, number, number];
  const dims = hi.map((v, k) => Math.max(1, Math.floor((v - origin[k]) / voxel + 0.5) + 1)) as [number, number, number];
  if (dims[0] * dims[1] * dims[2] > MAX_DENSITY_VOXELS) {
    const smallest = Math.cbrt(((hi[0] - lo[0] + voxel) * (hi[1] - lo[1] + voxel) * (hi[2] - lo[2] + voxel)) / MAX_DENSITY_VOXELS);
    throw new Error(`${voxel} mm voxels make a ${dims.join(" × ")} grid, too many to count in the page: use ${Number((smallest * 1.05).toPrecision(2))} mm or more`);
  }
  return { origin, dims, voxel, scale, offset };
}

/**
 * Adds some streamlines (store coordinates, as the region worker gives them)
 * to `counts`, a voxel each pass; `stamp` (one int a voxel, kept between
 * batches) remembers the last streamline counted there, numbered from `first`.
 */
export function addDensity(
  curves: { offsets: Uint32Array; positions: Float32Array },
  grid: DensityGrid,
  counts: Float32Array,
  stamp: Int32Array,
  first: number,
): void {
  const { origin, dims, voxel, scale, offset } = grid;
  const [nx, ny, nz] = dims;
  const p = curves.positions;
  const mm = (v: number, k: number) => (p[3 * v + k] + offset[k]) * scale[k];
  const mark = (x: number, y: number, z: number, track: number) => {
    const i = Math.round((x - origin[0]) / voxel);
    const j = Math.round((y - origin[1]) / voxel);
    const k = Math.round((z - origin[2]) / voxel);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    const at = i + nx * (j + ny * k);
    if (stamp[at] === track) return;
    stamp[at] = track;
    counts[at] += 1;
  };
  const tracks = curves.offsets.length - 1;
  for (let t = 0; t < tracks; ++t) {
    const track = first + t + 1;
    const a = curves.offsets[t];
    const b = curves.offsets[t + 1];
    if (b <= a) continue;
    mark(mm(a, 0), mm(a, 1), mm(a, 2), track);
    for (let v = a + 1; v < b; ++v) {
      const x0 = mm(v - 1, 0);
      const y0 = mm(v - 1, 1);
      const z0 = mm(v - 1, 2);
      const dx = mm(v, 0) - x0;
      const dy = mm(v, 1) - y0;
      const dz = mm(v, 2) - z0;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (voxel / 2)));
      for (let s = 1; s <= steps; ++s) mark(x0 + (dx * s) / steps, y0 + (dy * s) / steps, z0 + (dz * s) / steps, track);
    }
  }
}

/** The top of a density map's display range: the 99th percentile of its non-zero voxels (at least 1). */
export function displayMax(values: Float32Array): number {
  let nonZero = 0;
  for (const x of values) if (x > 0) nonZero++;
  if (nonZero === 0) return 1;
  const step = Math.max(1, Math.floor(nonZero / 100_000));
  const sample: number[] = [];
  let seen = 0;
  for (const x of values) if (x > 0 && seen++ % step === 0) sample.push(x);
  sample.sort((a, b) => a - b);
  return Math.max(1, sample[Math.floor(0.99 * (sample.length - 1))]);
}

/** A NIfTI-1 file (.nii) of float32 values on the grid: sform and qform to RAS+ mm. */
export function niftiFile(values: Float32Array, grid: DensityGrid, description: string): Uint8Array {
  const out = new Uint8Array(352 + values.byteLength);
  const v = new DataView(out.buffer);
  v.setInt32(0, 348, true);
  [3, ...grid.dims, 1, 1, 1, 1].forEach((d, k) => v.setInt16(40 + 2 * k, d, true));
  v.setInt16(70, 16, true); // float32
  v.setInt16(72, 32, true);
  [1, grid.voxel, grid.voxel, grid.voxel, 0, 0, 0, 0].forEach((d, k) => v.setFloat32(76 + 4 * k, d, true));
  v.setFloat32(108, 352, true); // vox_offset
  v.setFloat32(112, 1, true); // scl_slope
  v.setFloat32(124, displayMax(values), true); // cal_max (cal_min 0)
  out[123] = 2; // millimetres
  const text = new TextEncoder().encode(description.slice(0, 79));
  out.set(text, 148);
  // qform: identity rotation, the origin; sform the same, as rows.
  v.setInt16(252, 2, true); // qform_code: aligned
  v.setInt16(254, 2, true); // sform_code: aligned
  grid.origin.forEach((o, k) => v.setFloat32(268 + 4 * k, o, true)); // qoffset
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) v.setFloat32(280 + 16 * r + 4 * c, r === c ? grid.voxel : 0, true);
    v.setFloat32(280 + 16 * r + 12, grid.origin[r], true);
  }
  out.set([110, 43, 49, 0], 344); // "n+1"
  out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 352);
  return out;
}
