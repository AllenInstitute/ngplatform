/**
 * What SAM-Med3D (SAM-Med3D-turbo, Apache-2.0; a 3-D Segment Anything on
 * 128³ crops of CT and MRI at 1.5 mm) needs around it, as pure functions
 * (the model runs in ./sammed3d_worker.ts; tools/sammed3d/ exports it and
 * checks it against PyTorch):
 *
 * - **The cube**: 128 voxels a side in the world's axes (RAS, as the model's
 *   training canonicalised them), centred on the prompt, at the model's 1.5 mm
 *   (coarser when a box needs it), read from the coarsest level of the image
 *   no coarser than that.
 * - **The model's image**: the cube's values, x slowest (the tensor's
 *   order), z-normalised over the voxels above 0 (torchio's ZNormalization
 *   with `x > 0` as its mask), what lies outside the image 0.
 * - **Points**: label voxels as the cube's voxel coordinates (x, y, z).
 * - **The mask back**: the decoder's 32³ logits taken to 128³ (trilinear, as
 *   the model's inference does), above 0 selected, put on the label grid
 *   within the bounding box of what is selected (nearest).
 */
import { invertOr, multiply } from "../annotations/geometry.js";
import type { Vec3 } from "./kernels.js";
import type { Mask } from "./quick_select.js";

export const SAMMED3D_SIZE = 128;
export const SAMMED3D_LOW = 32;
/** The spacing it was trained at (mm). */
export const SAMMED3D_SPACING = 1.5;
/** The most label voxels a mask may span (its bounding box): more asks for a coarser label volume. */
export const MASK_BUDGET = 256e6;

type M4 = Float64Array;

function apply(m: ArrayLike<number>, p: ArrayLike<number>): Vec3 {
  return [0, 1, 2].map((r) => m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3]) as Vec3;
}

export interface Cube {
  /** Cube voxel → label voxel, and back (row-major 4 × 4). */
  gridToLabel: M4;
  labelToGrid: M4;
  /** Its voxel's side (mm), and the image level read for it. */
  spacing: number;
  level: number;
  /** Its centre (label voxels). */
  centre: Vec3;
}

/**
 * The cube round `centre` (label voxels), at `spacing` mm: its axes the world's (RAS), voxel i at
 * centre + (i − 63.5) · spacing mm; read from the coarsest of the image's `levels` (voxel sizes, finest
 * first) no coarser than the spacing (the finest when all are).
 */
export function cubeAt(centre: Vec3, labelToRas: ArrayLike<number>, spacing: number, levels: number[]): Cube {
  const c = apply(labelToRas, centre);
  const half = (SAMMED3D_SIZE - 1) / 2;
  const gridToRas = Float64Array.from([spacing, 0, 0, c[0] - half * spacing, 0, spacing, 0, c[1] - half * spacing, 0, 0, spacing, c[2] - half * spacing, 0, 0, 0, 1]);
  const rasToLabel = invertOr(Float64Array.from(labelToRas));
  if (rasToLabel === undefined) throw new Error("The label volume's voxels have no place in the world.");
  const gridToLabel = multiply(rasToLabel, gridToRas) as M4;
  const labelToGrid = invertOr(gridToLabel)! as M4;
  let level = 0;
  levels.forEach((size, i) => {
    if (size <= spacing * 1.0001) level = i;
  });
  return { gridToLabel, labelToGrid, spacing, level, centre };
}

/** The spacing for a box `extentMm` across (its longest side): the model's 1.5 mm, or coarser so the box fills at most 80 % of the cube. */
export function spacingFor(extentMm: number): number {
  return Math.max(SAMMED3D_SPACING, extentMm / (0.8 * SAMMED3D_SIZE));
}

/**
 * The cube's values (`grid`: x fastest, as read) as the model's image: x slowest, NaN as 0, z-normalised by the
 * mean and spread (n − 1) of the values above 0.
 */
export function modelVolume(grid: Float32Array): Float32Array {
  const S = SAMMED3D_SIZE;
  let n = 0;
  let sum = 0;
  for (let i = 0; i < grid.length; ++i) {
    const v = grid[i];
    if (v > 0) {
      ++n;
      sum += v;
    }
  }
  const mean = n ? sum / n : 0;
  let ss = 0;
  for (let i = 0; i < grid.length; ++i) {
    const v = grid[i];
    if (v > 0) ss += (v - mean) ** 2;
  }
  const std = n > 1 ? Math.sqrt(ss / (n - 1)) : 1;
  const scale = std > 0 ? 1 / std : 1;
  const out = new Float32Array(S * S * S);
  for (let z = 0; z < S; ++z) {
    for (let y = 0; y < S; ++y) {
      for (let x = 0; x < S; ++x) {
        const v = grid[x + S * (y + S * z)];
        out[(x * S + y) * S + z] = ((v === v ? v : 0) - mean) * scale;
      }
    }
  }
  return out;
}

/** A label voxel as the cube's voxel coordinates (x, y, z), as the model takes a point. */
export function pointInCube(cube: Cube, at: Vec3): Vec3 {
  return apply(cube.labelToGrid, at);
}

/** The 32³ logits (x slowest) taken to 128³ (trilinear, align_corners false), selected above 0 (x slowest). */
export function upsampleMask(low: Float32Array): Uint8Array {
  const L = SAMMED3D_LOW;
  const S = SAMMED3D_SIZE;
  const idx = new Int32Array(S * 2);
  const frac = new Float32Array(S);
  for (let i = 0; i < S; ++i) {
    const p = Math.max(0, ((i + 0.5) * L) / S - 0.5);
    const i0 = Math.min(L - 1, Math.floor(p));
    idx[2 * i] = i0;
    idx[2 * i + 1] = Math.min(L - 1, i0 + 1);
    frac[i] = p - i0;
  }
  const at = (a: number, b: number, c: number) => low[(a * L + b) * L + c];
  const out = new Uint8Array(S * S * S);
  for (let a = 0; a < S; ++a) {
    const a0 = idx[2 * a], a1 = idx[2 * a + 1], fa = frac[a];
    for (let b = 0; b < S; ++b) {
      const b0 = idx[2 * b], b1 = idx[2 * b + 1], fb = frac[b];
      for (let c = 0; c < S; ++c) {
        const c0 = idx[2 * c], c1 = idx[2 * c + 1], fc = frac[c];
        const v =
          (1 - fa) * ((1 - fb) * ((1 - fc) * at(a0, b0, c0) + fc * at(a0, b0, c1)) + fb * ((1 - fc) * at(a0, b1, c0) + fc * at(a0, b1, c1))) +
          fa * ((1 - fb) * ((1 - fc) * at(a1, b0, c0) + fc * at(a1, b0, c1)) + fb * ((1 - fc) * at(a1, b1, c0) + fc * at(a1, b1, c1)));
        if (v > 0) out[(a * S + b) * S + c] = 1;
      }
    }
  }
  return out;
}

/**
 * The cube's selected voxels (`selected`: 128³, x slowest) on the label grid (`volume`: its size): each label
 * voxel within the box round them, by the cube voxel nearest its centre. Throws when that box is over `budget`
 * label voxels (a label volume much finer than the model).
 */
export function maskOnLabels(selected: Uint8Array, cube: Cube, volume: Vec3, budget = MASK_BUDGET): Mask {
  const S = SAMMED3D_SIZE;
  let lo = [S, S, S];
  let hi = [-1, -1, -1];
  for (let a = 0; a < S; ++a)
    for (let b = 0; b < S; ++b)
      for (let c = 0; c < S; ++c) {
        if (!selected[(a * S + b) * S + c]) continue;
        const v = [a, b, c];
        lo = lo.map((x, k) => Math.min(x, v[k]));
        hi = hi.map((x, k) => Math.max(x, v[k]));
      }
  if (hi[0] < 0) return { lo: [0, 0, 0], size: [0, 0, 0], data: new Uint8Array(0) };
  // The label box round the selected cube voxels (their corners, half a voxel out).
  const llo = [Infinity, Infinity, Infinity];
  const lhi = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; ++corner) {
    const g = [0, 1, 2].map((k) => ((corner >> k) & 1 ? hi[k] + 0.5 : lo[k] - 0.5));
    const p = apply(cube.gridToLabel, g);
    for (let k = 0; k < 3; ++k) {
      llo[k] = Math.min(llo[k], p[k]);
      lhi[k] = Math.max(lhi[k], p[k]);
    }
  }
  const mlo = llo.map((v) => Math.max(0, Math.floor(v))) as Vec3;
  const mhi = lhi.map((v, k) => Math.min(volume[k], Math.ceil(v) + 1)) as Vec3;
  const size = mhi.map((v, k) => Math.max(0, v - mlo[k])) as Vec3;
  const count = size[0] * size[1] * size[2];
  if (count > budget) {
    throw new Error(`The mask would span ${Math.round(count / 1e6)} million label voxels: SAM-Med3D sees ${cube.spacing.toFixed(1)} mm voxels, so make the label volume coarser (at least ${(cube.spacing / 4).toFixed(2)} mm) for 3-D AI segmentation.`);
  }
  const data = new Uint8Array(count);
  const m = cube.labelToGrid;
  let i = 0;
  for (let z = 0; z < size[2]; ++z) {
    for (let y = 0; y < size[1]; ++y) {
      const pz = mlo[2] + z;
      const py = mlo[1] + y;
      // Along x the cube's coordinates change by the matrix's first column.
      let gx = m[0] * mlo[0] + m[1] * py + m[2] * pz + m[3];
      let gy = m[4] * mlo[0] + m[5] * py + m[6] * pz + m[7];
      let gz = m[8] * mlo[0] + m[9] * py + m[10] * pz + m[11];
      for (let x = 0; x < size[0]; ++x, ++i) {
        const a = Math.round(gx);
        const b = Math.round(gy);
        const c = Math.round(gz);
        if (a >= 0 && b >= 0 && c >= 0 && a < S && b < S && c < S && selected[(a * S + b) * S + c]) data[i] = 1;
        gx += m[0];
        gy += m[4];
        gz += m[8];
      }
    }
  }
  return { lo: mlo, size, data };
}
