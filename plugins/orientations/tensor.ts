/**
 * Diffusion tensors: the six stored components in the orders programs
 * write them, eigen-decomposition (Jacobi rotations, exact enough for a
 * 3 × 3 and with no failure cases), fractional anisotropy and mean
 * diffusivity.
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

/** Eigenvalues and eigenvectors of a symmetric 3 × 3 (row-major), largest first. */
export function eigenSymmetric(matrix: ArrayLike<number>): Eigen {
  const a = Float64Array.from(matrix);
  // v's columns become the eigenvectors.
  const v = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < 50; ++sweep) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-30 || off < 1e-15 * (Math.abs(a[0]) + Math.abs(a[4]) + Math.abs(a[8]))) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const apq = a[3 * p + q];
      if (apq === 0) continue;
      const theta = (a[3 * q + q] - a[3 * p + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      // A ← Jᵀ A J for the rotation J in the (p, q) plane.
      for (let k = 0; k < 3; ++k) {
        const akp = a[3 * k + p];
        const akq = a[3 * k + q];
        a[3 * k + p] = c * akp - s * akq;
        a[3 * k + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; ++k) {
        const apk = a[3 * p + k];
        const aqk = a[3 * q + k];
        a[3 * p + k] = c * apk - s * aqk;
        a[3 * q + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; ++k) {
        const vkp = v[3 * k + p];
        const vkq = v[3 * k + q];
        v[3 * k + p] = c * vkp - s * vkq;
        v[3 * k + q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[4 * j] - a[4 * i]);
  const values = order.map((i) => a[4 * i]) as [number, number, number];
  const vectors = new Float64Array(9);
  order.forEach((i, k) => {
    for (let r = 0; r < 3; ++r) vectors[3 * k + r] = v[3 * r + i];
  });
  return { values, vectors };
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
