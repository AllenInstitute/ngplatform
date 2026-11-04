/**
 * Diffusion tensors: the six stored components in the orders programs
 * write them, eigen-decomposition (closed form, exact to rounding and with
 * no failure cases), fractional anisotropy and mean diffusivity.
 */
import { eigenSym3 } from "@ngplatform/sdk/tensors";

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
 * first, in closed form (the SDK's eigenSym3, the NIfTI reader's own).
 */
export function eigenSymmetric(matrix: ArrayLike<number>): Eigen {
  const values = new Float64Array(3);
  const vectors = new Float64Array(9);
  eigenSym3([matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[8]], values, vectors);
  return { values: [values[0], values[1], values[2]], vectors };
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
