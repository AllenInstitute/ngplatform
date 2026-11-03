/** The plugin's eigen-decomposition as it was (Jacobi rotations), kept as a reference for the tests. */
import type { Eigen } from "../tensor.js";

/** Eigenvalues and eigenvectors of a symmetric 3 × 3 (row-major), largest first, by Jacobi rotations: the reference the closed form is checked against. */
export function eigenJacobi(matrix: ArrayLike<number>): Eigen {
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
