/**
 * Grow, shrink and smooth a segment (pure, on boxes of the label grid):
 *
 * - **Grow** by r mm: every voxel whose centre is within r of the segment's
 *   (an exact Euclidean distance transform, the voxel's own sides along each
 *   axis, so a ball in millimetres on an anisotropic grid).
 * - **Shrink** by r mm: every voxel of the segment within r of one outside it
 *   leaves it (voxels beyond the volume's edge are not outside).
 * - **Smooth** by σ mm: the segment's mask blurred by a Gaussian of σ (each
 *   axis in its own voxels), above one half kept: corners and steps rounded,
 *   specks and pinholes smaller than about σ gone, the volume about the same.
 *
 * A segment of any size is done tile by tile (`tiles`), each tile read with a
 * halo as wide as the operation reaches, so memory stays bounded; the editor
 * works out every tile's changes before writing any, so no tile reads another's.
 * In one section (`axis` given), the same in 2-D: nothing along the axis.
 */
import type { LabelVolume } from "./label_volume.js";
import type { Vec3 } from "./kernels.js";

export type MorphOp = "grow" | "shrink" | "smooth";

/** A tile's core voxels (written) and the box read round it (`lo`..`hi`, exclusive). */
export interface MorphTile {
  core: { lo: Vec3; hi: Vec3 };
  read: { lo: Vec3; hi: Vec3 };
}

/** The core's side, in voxels: 128³ cores read at most a few hundred MB with any halo kept to a sensible size. */
export const TILE = 128;
/** The widest halo (voxels each side) a tile reads: an amount needing more is refused as too large for the voxels. */
export const MAX_HALO = 96;
const FAR = 1e20;

/** How far (voxels, per axis) the operation reaches from a voxel: r for grow and shrink, 3σ for smooth (0 along `axis` in one section). */
export function halo(op: MorphOp, amountMm: number, spacing: ArrayLike<number>, axis?: number): Vec3 {
  return [0, 1, 2].map((k) => (k === axis ? 0 : Math.ceil(((op === "smooth" ? 3 : 1) * amountMm) / spacing[k]) + 1)) as Vec3;
}

/**
 * The tiles covering `box` (the segment's painted box), each core within the volume: for grow and smooth the box
 * is widened by the halo first (they can reach beyond the segment). Tiles' read boxes are the core and halo, within
 * the volume.
 */
export function tiles(op: MorphOp, box: { lo: Vec3; hi: Vec3 }, reach: Vec3, size: Vec3, axis?: number, tile = TILE): MorphTile[] {
  const lo = box.lo.map((v, k) => Math.max(0, op === "shrink" ? v : v - reach[k])) as Vec3;
  const hi = box.hi.map((v, k) => Math.min(size[k], op === "shrink" ? v : v + reach[k])) as Vec3;
  const step = [0, 1, 2].map((k) => (k === axis ? 1 : tile));
  const out: MorphTile[] = [];
  for (let z = lo[2]; z < hi[2]; z += step[2])
    for (let y = lo[1]; y < hi[1]; y += step[1])
      for (let x = lo[0]; x < hi[0]; x += step[0]) {
        const cl = [x, y, z] as Vec3;
        const ch = cl.map((v, k) => Math.min(hi[k], v + step[k])) as Vec3;
        out.push({
          core: { lo: cl, hi: ch },
          read: { lo: cl.map((v, k) => Math.max(0, v - reach[k])) as Vec3, hi: ch.map((v, k) => Math.min(size[k], v + reach[k])) as Vec3 },
        });
      }
  return out;
}

/** Whether each voxel of a box (x fastest) is `value`, read chunk by chunk. */
export function readMask(volume: LabelVolume, value: number, lo: Vec3, hi: Vec3): Uint8Array {
  const n = hi.map((v, k) => v - lo[k]);
  const out = new Uint8Array(n[0] * n[1] * n[2]);
  const C = 64;
  for (let cz = lo[2] >> 6; cz <= (hi[2] - 1) >> 6; ++cz)
    for (let cy = lo[1] >> 6; cy <= (hi[1] - 1) >> 6; ++cy)
      for (let cx = lo[0] >> 6; cx <= (hi[0] - 1) >> 6; ++cx) {
        const c = volume.chunk(volume.key(cx, cy, cz));
        if (c === undefined) continue;
        const z0 = Math.max(lo[2], cz * C), z1 = Math.min(hi[2], cz * C + C);
        const y0 = Math.max(lo[1], cy * C), y1 = Math.min(hi[1], cy * C + C);
        const x0 = Math.max(lo[0], cx * C), x1 = Math.min(hi[0], cx * C + C);
        for (let z = z0; z < z1; ++z)
          for (let y = y0; y < y1; ++y) {
            const src = (z - cz * C) * C * C + (y - cy * C) * C - cx * C;
            const dst = (z - lo[2]) * n[0] * n[1] + (y - lo[1]) * n[0] - lo[0];
            for (let x = x0; x < x1; ++x) if (c[src + x] === value) out[dst + x] = 1;
          }
      }
  return out;
}

/** Squared distances along one line (in place; positions i · step): Felzenszwalb and Huttenlocher's lower envelope. */
function edt1(f: Float64Array, n: number, step: number, v: Int32Array, z: Float64Array, d: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; ++q) {
    const fq = f[q] + (q * step) ** 2;
    let s = (fq - (f[v[k]] + (v[k] * step) ** 2)) / (2 * step * (q - v[k]));
    while (s <= z[k]) {
      --k;
      s = (fq - (f[v[k]] + (v[k] * step) ** 2)) / (2 * step * (q - v[k]));
    }
    ++k;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; ++q) {
    while (z[k + 1] < q * step) ++k;
    d[q] = (q * step - v[k] * step) ** 2 + f[v[k]];
  }
  for (let q = 0; q < n; ++q) f[q] = d[q];
}

/**
 * Squared distances (mm²) from each voxel of a box (x fastest) to the nearest voxel where `target` is 1; `spacing`
 * the voxel's sides (mm). Far (1e20) where there is none.
 */
export function distance2(target: Uint8Array, n: Vec3, spacing: ArrayLike<number>): Float64Array {
  const f = new Float64Array(target.length);
  for (let i = 0; i < f.length; ++i) f[i] = target[i] ? 0 : FAR;
  const longest = Math.max(...n);
  const line = new Float64Array(longest);
  const v = new Int32Array(longest);
  const z = new Float64Array(longest + 1);
  const d = new Float64Array(longest);
  const strides = [1, n[0], n[0] * n[1]];
  for (let axis = 0; axis < 3; ++axis) {
    const len = n[axis];
    if (len < 2) continue;
    const [a, b] = [0, 1, 2].filter((k) => k !== axis);
    const s = strides[axis];
    for (let j = 0; j < n[b]; ++j)
      for (let i = 0; i < n[a]; ++i) {
        const base = i * strides[a] + j * strides[b];
        let any = false;
        for (let q = 0; q < len; ++q) {
          line[q] = f[base + q * s];
          if (line[q] < FAR) any = true;
        }
        if (!any) continue;
        edt1(line, len, spacing[axis], v, z, d);
        for (let q = 0; q < len; ++q) f[base + q * s] = Math.min(line[q], FAR);
      }
  }
  return f;
}

/** A mask (x fastest) blurred by a Gaussian of `sigma` voxels along each axis (0: not along it), edges extended. */
export function blur(mask: Uint8Array, n: Vec3, sigma: ArrayLike<number>): Float32Array {
  let f = Float32Array.from(mask);
  const strides = [1, n[0], n[0] * n[1]];
  for (let axis = 0; axis < 3; ++axis) {
    const sg = sigma[axis];
    const len = n[axis];
    if (!(sg > 0) || len < 2) continue;
    const r = Math.max(1, Math.ceil(3 * sg));
    const w = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let t = -r; t <= r; ++t) sum += w[t + r] = Math.exp(-(t * t) / (2 * sg * sg));
    for (let t = 0; t < w.length; ++t) w[t] /= sum;
    const out = new Float32Array(f.length);
    const [a, b] = [0, 1, 2].filter((k) => k !== axis);
    const s = strides[axis];
    const line = new Float32Array(len);
    for (let j = 0; j < n[b]; ++j)
      for (let i = 0; i < n[a]; ++i) {
        const base = i * strides[a] + j * strides[b];
        let any = false;
        for (let q = 0; q < len; ++q) {
          line[q] = f[base + q * s];
          if (line[q] !== 0) any = true;
        }
        if (!any) continue;
        for (let q = 0; q < len; ++q) {
          let acc = 0;
          for (let t = -r; t <= r; ++t) acc += w[t + r] * line[Math.min(len - 1, Math.max(0, q + t))];
          out[base + q * s] = acc;
        }
      }
    f = out;
  }
  return f;
}

/**
 * One tile: the segment's mask over the read box (`mask`, x fastest, `n` its size) → whether each core voxel is in
 * the segment after the operation (x fastest over the core). `amountMm`: r, or σ for smooth.
 */
export function morphTile(op: MorphOp, mask: Uint8Array, n: Vec3, readLo: Vec3, core: { lo: Vec3; hi: Vec3 }, amountMm: number, spacing: ArrayLike<number>, axis?: number): Uint8Array {
  const cn = core.hi.map((v, k) => v - core.lo[k]);
  const off = core.lo.map((v, k) => v - readLo[k]);
  const out = new Uint8Array(cn[0] * cn[1] * cn[2]);
  const sp = [0, 1, 2].map((k) => (k === axis ? 1 : spacing[k]));
  const r2 = amountMm * amountMm * (1 + 1e-9);
  let field: Float64Array | Float32Array;
  if (op === "grow") field = distance2(mask, n, sp);
  else if (op === "shrink") field = distance2(mask.map((m) => 1 - m), n, sp);
  else field = blur(mask, n, [0, 1, 2].map((k) => (k === axis ? 0 : amountMm / spacing[k])));
  let o = 0;
  for (let z = 0; z < cn[2]; ++z)
    for (let y = 0; y < cn[1]; ++y) {
      let i = off[0] + n[0] * (off[1] + y + n[1] * (off[2] + z));
      for (let x = 0; x < cn[0]; ++x, ++i, ++o) {
        if (op === "grow") out[o] = mask[i] || field[i] <= r2 ? 1 : 0;
        else if (op === "shrink") out[o] = mask[i] && field[i] > r2 ? 1 : 0;
        else out[o] = field[i] >= 0.5 ? 1 : 0;
      }
    }
  return out;
}
