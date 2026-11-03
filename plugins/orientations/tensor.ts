/**
 * Diffusion tensors: the six stored components in the orders programs
 * write them, eigen-decomposition (closed form, exact to rounding and with
 * no failure cases), fractional anisotropy and mean diffusivity.
 */

/**
 * Orders of the six components, as indices into (xx, xy, xz, yy, yz, zz):
 *  - "fsl": Dxx Dxy Dxz Dyy Dyz Dzz (FSL dtifit's _tensor, upper triangle by rows);
 *  - "dipy": Dxx Dxy Dyy Dxz Dyz Dzz (DIPY's lower_triangular);
 *  - "mrtrix": Dxx Dyy Dzz Dxy Dxz Dyz (MRtrix dwi2tensor).
 */
export type TensorOrder = "fsl" | "dipy" | "mrtrix";

export const TENSOR_ORDERS: [TensorOrder, string][] = [
  ["fsl", "Dxx Dxy Dxz Dyy Dyz Dzz (FSL)"],
  ["dipy", "Dxx Dxy Dyy Dxz Dyz Dzz (DIPY)"],
  ["mrtrix", "Dxx Dyy Dzz Dxy Dxz Dyz (MRtrix)"],
];

/** For each order: where xx, xy, xz, yy, yz, zz are among the six stored values. */
export const TENSOR_POSITIONS: Record<TensorOrder, number[]> = {
  fsl: [0, 1, 2, 3, 4, 5],
  dipy: [0, 1, 3, 2, 4, 5],
  mrtrix: [0, 3, 4, 1, 5, 2],
};

/** The full symmetric matrix (row-major 3 × 3) from six stored values at `offset`. */
export function tensorMatrix(values: ArrayLike<number>, offset: number, order: TensorOrder, out = new Float64Array(9)): Float64Array {
  const [xx, xy, xz, yy, yz, zz] = TENSOR_POSITIONS[order].map((p) => values[offset + p]);
  out[0] = xx;
  out[1] = xy;
  out[2] = xz;
  out[3] = xy;
  out[4] = yy;
  out[5] = yz;
  out[6] = xz;
  out[7] = yz;
  out[8] = zz;
  return out;
}

export interface Eigen {
  /** Largest first. */
  values: [number, number, number];
  /** Unit eigenvectors, row-major: vectors[3k .. 3k + 2] goes with values[k]. */
  vectors: Float64Array;
}

/**
 * Eigenvalues and eigenvectors of a symmetric 3 × 3 (row-major), largest
 * first, in closed form (eigenSym3).
 */
export function eigenSymmetric(matrix: ArrayLike<number>): Eigen {
  const values = new Float64Array(3);
  const vectors = new Float64Array(9);
  eigenSym3([matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[8]], values, vectors);
  return { values: [values[0], values[1], values[2]], vectors };
}

/**
 * Eigenvalues (largest first) and unit eigenvectors (vectors[3k .. 3k + 2]
 * with values[k]) of the symmetric matrix (xx, xy, xz, yy, yz, zz) in `m`:
 * the eigenvalues by Smith's trigonometric formula, the eigenvector of the
 * most distinct one by cross products, the other two by one rotation in the
 * plane across it.  No iterations and no allocations: about 0.25 µs, a
 * tenth of Jacobi rotations' time.  The same as the app's
 * (src/virtual/images/tensors.ts, for the NIfTI reader's tensor levels;
 * plugins import the platform only through the SDK, so it is copied, and
 * a test keeps the two the same).
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

/** Fractional anisotropy from eigenvalues: 0 isotropic, 1 a line. */
export function fractionalAnisotropy(values: ArrayLike<number>): number {
  const [l1, l2, l3] = [values[0], values[1], values[2]];
  const sum = l1 * l1 + l2 * l2 + l3 * l3;
  if (!(sum > 0)) return 0;
  return Math.min(1, Math.sqrt((0.5 * ((l1 - l2) ** 2 + (l2 - l3) ** 2 + (l3 - l1) ** 2)) / sum));
}

export function meanDiffusivity(values: ArrayLike<number>): number {
  return (values[0] + values[1] + values[2]) / 3;
}
