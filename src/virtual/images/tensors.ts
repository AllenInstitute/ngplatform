/**
 * Log-Euclidean means of diffusion tensors (Arsigny et al., 2006): the
 * mean of the matrix logarithms, exponentiated.  A plain mean of the six
 * components swells tensors that point different ways (two crossing
 * cigars average to a fat disc of twice their volume, its determinant
 * larger than either's); the log-Euclidean mean does not: its determinant
 * is the geometric mean of theirs.
 *
 * Each tensor is a symmetric 3 × 3 given by six stored values in one of
 * three orders.  The eigen-decomposition is closed form (the eigenvalues
 * by Smith's trigonometric formula; the eigenvector of the most distinct
 * one by cross products; the other two by one rotation in the plane
 * across it), so it has no iterations and allocates nothing: about 0.25 µs
 * a tensor.  A tensor that is not positive definite (the zeros around a
 * brain, or a fit with a negative eigenvalue) has no logarithm and is left
 * out of a mean; a mean of none is all zeros.
 */

/**
 * Orders of the six components, as for the Orientations plugin:
 *  - "fsl": Dxx Dxy Dxz Dyy Dyz Dzz (FSL dtifit, the upper triangle by rows);
 *  - "dipy": Dxx Dxy Dyy Dxz Dyz Dzz (DIPY's lower_triangular, and NIfTI's
 *    NIFTI_INTENT_SYMMATRIX: the lower triangle by rows);
 *  - "mrtrix": Dxx Dyy Dzz Dxy Dxz Dyz (MRtrix dwi2tensor).
 */
export type TensorOrder = "fsl" | "dipy" | "mrtrix";

export const TENSOR_ORDER_NAMES: readonly TensorOrder[] = ["fsl", "dipy", "mrtrix"];

/** For each order: where xx, xy, xz, yy, yz, zz are among the six stored values. */
export const TENSOR_SLOTS: Record<TensorOrder, readonly number[]> = {
  fsl: [0, 1, 2, 3, 4, 5],
  dipy: [0, 1, 3, 2, 4, 5],
  mrtrix: [0, 3, 4, 1, 5, 2],
};

/** NIfTI's intent code for a symmetric matrix at each voxel (stored as its lower triangle by rows). */
export const NIFTI_INTENT_SYMMATRIX = 1005;

/**
 * Eigenvalues (largest first) and unit eigenvectors (vectors[3k .. 3k + 2]
 * with values[k]) of the symmetric matrix (xx, xy, xz, yy, yz, zz) in `m`.
 */
export function eigenSym3(m: ArrayLike<number>, values: Float64Array, vectors: Float64Array): void {
  const scale = Math.max(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3]), Math.abs(m[4]), Math.abs(m[5]));
  if (!(scale > 0) || !Number.isFinite(scale)) {
    values[0] = values[1] = values[2] = scale === 0 ? 0 : NaN;
    vectors.fill(0);
    vectors[0] = vectors[4] = vectors[8] = 1;
    return;
  }
  // Scaled to entries within ±1, so nothing overflows or underflows.
  const xx = m[0] / scale;
  const xy = m[1] / scale;
  const xz = m[2] / scale;
  const yy = m[3] / scale;
  const yz = m[4] / scale;
  const zz = m[5] / scale;
  const q = (xx + yy + zz) / 3;
  const b11 = xx - q;
  const b22 = yy - q;
  const b33 = zz - q;
  const off = xy * xy + xz * xz + yz * yz;
  const p = Math.sqrt((b11 * b11 + b22 * b22 + b33 * b33 + 2 * off) / 6);
  if (p < 1e-12) {
    // A multiple of the identity (to rounding): any axes do.
    values[0] = values[1] = values[2] = q * scale;
    vectors.fill(0);
    vectors[0] = vectors[4] = vectors[8] = 1;
    return;
  }
  // det((A - qI) / p) / 2, within [-1, 1].
  const det = b11 * (b22 * b33 - yz * yz) - xy * (xy * b33 - yz * xz) + xz * (xy * yz - b22 * xz);
  const r = Math.max(-1, Math.min(1, det / (2 * p * p * p)));
  const phi = Math.acos(r) / 3;
  const l1 = q + 2 * p * Math.cos(phi);
  const l3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const l2 = 3 * q - l1 - l3;
  // The eigenvector of the eigenvalue farthest from the middle one: rows of
  // A - λI are perpendicular to it, so it is their longest cross product.
  const first = l1 - l2 >= l2 - l3;
  const l = first ? l1 : l3;
  const r0x = xx - l, r0y = xy, r0z = xz;
  const r1x = xy, r1y = yy - l, r1z = yz;
  const r2x = xz, r2y = yz, r2z = zz - l;
  const ax = r0y * r1z - r0z * r1y, ay = r0z * r1x - r0x * r1z, az = r0x * r1y - r0y * r1x;
  const bx = r0y * r2z - r0z * r2y, by = r0z * r2x - r0x * r2z, bz = r0x * r2y - r0y * r2x;
  const cx = r1y * r2z - r1z * r2y, cy = r1z * r2x - r1x * r2z, cz = r1x * r2y - r1y * r2x;
  const na = ax * ax + ay * ay + az * az;
  const nb = bx * bx + by * by + bz * bz;
  const nc = cx * cx + cy * cy + cz * cz;
  let vx = 1, vy = 0, vz = 0;
  if (na >= nb && na >= nc && na > 0) {
    const n = 1 / Math.sqrt(na);
    vx = ax * n;
    vy = ay * n;
    vz = az * n;
  } else if (nb >= nc && nb > 0) {
    const n = 1 / Math.sqrt(nb);
    vx = bx * n;
    vy = by * n;
    vz = bz * n;
  } else if (nc > 0) {
    const n = 1 / Math.sqrt(nc);
    vx = cx * n;
    vy = cy * n;
    vz = cz * n;
  }
  // Two unit vectors across it: u, and w = v × u.
  let ux = 0, uy = 0, uz = 0;
  if (Math.abs(vx) > Math.abs(vy)) {
    const n = 1 / Math.sqrt(vx * vx + vz * vz);
    ux = -vz * n;
    uz = vx * n;
  } else {
    const n = 1 / Math.sqrt(vy * vy + vz * vz);
    uy = vz * n;
    uz = -vy * n;
  }
  const wx = vy * uz - vz * uy, wy = vz * ux - vx * uz, wz = vx * uy - vy * ux;
  // A on u, w and v.
  const aux = xx * ux + xy * uy + xz * uz, auy = xy * ux + yy * uy + yz * uz, auz = xz * ux + yz * uy + zz * uz;
  const m00 = ux * aux + uy * auy + uz * auz;
  const m01 = wx * aux + wy * auy + wz * auz;
  const m11 = wx * (xx * wx + xy * wy + xz * wz) + wy * (xy * wx + yy * wy + yz * wz) + wz * (xz * wx + yz * wy + zz * wz);
  const lv = vx * (xx * vx + xy * vy + xz * vz) + vy * (xy * vx + yy * vy + yz * vz) + vz * (xz * vx + yz * vy + zz * vz);
  // The 2 × 2 on u, w diagonalised by one rotation.
  const half = (m00 - m11) / 2;
  const root = Math.sqrt(half * half + m01 * m01);
  const mid = (m00 + m11) / 2;
  const theta = 0.5 * Math.atan2(m01, half);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const hi = (mid + root) * scale;
  const lo = (mid - root) * scale;
  const ex = c * ux + s * wx, ey = c * uy + s * wy, ez = c * uz + s * wz;
  const fx = -s * ux + c * wx, fy = -s * uy + c * wy, fz = -s * uz + c * wz;
  // Largest first: v is the largest or the smallest.
  const v0 = first ? 0 : 6;
  const e0 = first ? 3 : 0;
  const f0 = first ? 6 : 3;
  values[v0 / 3] = lv * scale;
  values[e0 / 3] = hi;
  values[f0 / 3] = lo;
  vectors[v0] = vx;
  vectors[v0 + 1] = vy;
  vectors[v0 + 2] = vz;
  vectors[e0] = ex;
  vectors[e0 + 1] = ey;
  vectors[e0 + 2] = ez;
  vectors[f0] = fx;
  vectors[f0 + 1] = fy;
  vectors[f0 + 2] = fz;
}

/** Σ f(λk) vk vkᵀ as (xx, xy, xz, yy, yz, zz), from eigenSym3's values (already mapped by f) and vectors. */
function compose(f: ArrayLike<number>, v: Float64Array, out: Float64Array | Float32Array, at = 0): void {
  out[at] = out[at + 1] = out[at + 2] = out[at + 3] = out[at + 4] = out[at + 5] = 0;
  for (let k = 0; k < 3; ++k) {
    const x = v[3 * k], y = v[3 * k + 1], z = v[3 * k + 2];
    const l = f[k];
    out[at] += l * x * x;
    out[at + 1] += l * x * y;
    out[at + 2] += l * x * z;
    out[at + 3] += l * y * y;
    out[at + 4] += l * y * z;
    out[at + 5] += l * z * z;
  }
}

const values = new Float64Array(3);
const vectors = new Float64Array(9);
const mapped = new Float64Array(3);

/**
 * The matrix logarithm of a symmetric positive-definite tensor
 * (xx, xy, xz, yy, yz, zz) into `out`; false (and `out` untouched) when it
 * is not positive definite or not finite.
 */
export function logTensor(m: ArrayLike<number>, out: Float64Array): boolean {
  eigenSym3(m, values, vectors);
  if (!(values[2] > 0) || !(values[0] < Infinity)) return false;
  mapped[0] = Math.log(values[0]);
  mapped[1] = Math.log(values[1]);
  mapped[2] = Math.log(values[2]);
  compose(mapped, vectors, out);
  return true;
}

/** The matrix exponential of a symmetric (xx, xy, xz, yy, yz, zz) into out[at ..]. */
export function expTensor(m: ArrayLike<number>, out: Float64Array | Float32Array, at = 0): void {
  eigenSym3(m, values, vectors);
  mapped[0] = Math.exp(values[0]);
  mapped[1] = Math.exp(values[1]);
  mapped[2] = Math.exp(values[2]);
  compose(mapped, vectors, out, at);
}

/**
 * Sums of logarithms, one per mean being made: add tensors in their stored
 * order, then `mean` writes each mean back in that order.
 */
export class LogEuclideanSum {
  private readonly sums: Float64Array;
  private readonly counts: Uint32Array;
  private readonly slots: readonly number[];
  private readonly matrix = new Float64Array(6);
  private readonly log = new Float64Array(6);

  constructor(
    readonly size: number,
    order: TensorOrder,
  ) {
    this.sums = new Float64Array(6 * size);
    this.counts = new Uint32Array(size);
    this.slots = TENSOR_SLOTS[order];
  }

  /**
   * Adds the tensor whose six stored values are values[at + k * stride]
   * (k = 0 … 5) to mean `d`; false when it is left out (not positive definite).
   */
  add(d: number, values: ArrayLike<number>, at: number, stride: number): boolean {
    const s = this.slots;
    const m = this.matrix;
    for (let k = 0; k < 6; ++k) m[k] = values[at + s[k] * stride];
    if (!logTensor(m, this.log)) return false;
    const o = 6 * d;
    for (let k = 0; k < 6; ++k) this.sums[o + k] += this.log[k];
    this.counts[d]++;
    return true;
  }

  count(d: number): number {
    return this.counts[d];
  }

  /** Mean `d` written as out[at + k * stride] in the stored order (zeros when nothing was added). */
  mean(d: number, out: { [i: number]: number }, at: number, stride: number): void {
    const n = this.counts[d];
    const s = this.slots;
    if (n === 0) {
      for (let k = 0; k < 6; ++k) out[at + s[k] * stride] = 0;
      return;
    }
    const m = this.matrix;
    for (let k = 0; k < 6; ++k) m[k] = this.sums[6 * d + k] / n;
    expTensor(m, this.log);
    for (let k = 0; k < 6; ++k) out[at + s[k] * stride] = this.log[k];
  }
}

/** The log-Euclidean mean of some tensors (each six values in `order`); zeros when none is positive definite. */
export function logEuclideanMean(tensors: ArrayLike<number>[], order: TensorOrder = "fsl"): Float64Array {
  const sum = new LogEuclideanSum(1, order);
  for (const t of tensors) sum.add(0, t, 0, 1);
  const out = new Float64Array(6);
  sum.mean(0, out, 0, 1);
  return out;
}
