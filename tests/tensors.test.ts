/** Log-Euclidean means of diffusion tensors (src/virtual/images/tensors.ts). */
import { describe, expect, it } from "vitest";
import { TENSOR_POSITIONS } from "../plugins/orientations/tensor.js";
import { eigenJacobi } from "../plugins/orientations/tests/jacobi.js";
import { eigenSym3, expTensor, logEuclideanMean, logTensor, TENSOR_SLOTS, type TensorOrder } from "../src/virtual/images/tensors.js";

/** (xx, xy, xz, yy, yz, zz) of R diag(l) Rᵀ, R a rotation by `angle` about z. */
function rotated(l: [number, number, number], angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [l[0] * c * c + l[1] * s * s, (l[0] - l[1]) * c * s, 0, l[0] * s * s + l[1] * c * c, 0, l[2]];
}

const det = (m: ArrayLike<number>) => m[0] * (m[3] * m[5] - m[4] * m[4]) - m[1] * (m[1] * m[5] - m[4] * m[2]) + m[2] * (m[1] * m[4] - m[3] * m[2]);

/** Six values in the fsl order (xx, xy, xz, yy, yz, zz) put in another order. */
function inOrder(m: number[], order: TensorOrder): number[] {
  const out = new Array(6);
  TENSOR_SLOTS[order].forEach((slot, k) => (out[slot] = m[k]));
  return out;
}

describe("log-Euclidean tensor means", () => {
  it("decomposes as Jacobi rotations do, near-equal eigenvalues and all", () => {
    const values = new Float64Array(3);
    const vectors = new Float64Array(9);
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let t = 0; t < 2000; ++t) {
      const m = Array.from({ length: 6 }, () => random() * 10 ** (3 * random()));
      if (t % 3 === 0) [m[1], m[2], m[4]] = [m[1] * 1e-8, m[2] * 1e-8, m[4] * 1e-8];
      if (t % 5 === 0) m[3] = m[0];
      eigenSym3(m, values, vectors);
      const jacobi = eigenJacobi([m[0], m[1], m[2], m[1], m[3], m[4], m[2], m[4], m[5]]);
      const scale = Math.max(...m.map(Math.abs));
      for (let k = 0; k < 3; ++k) expect(Math.abs(values[k] - jacobi.values[k]) / scale).toBeLessThan(1e-12);
      // Σ λ v vᵀ gives the matrix back.
      const back = [0, 0, 0, 0, 0, 0];
      const pairs = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
      pairs.forEach(([a, b], q) => {
        for (let k = 0; k < 3; ++k) back[q] += values[k] * vectors[3 * k + a] * vectors[3 * k + b];
      });
      for (let q = 0; q < 6; ++q) expect(Math.abs(back[q] - m[q]) / scale).toBeLessThan(1e-12);
    }
  });

  it("logarithm and exponential undo each other", () => {
    const m = rotated([1.7e-3, 0.4e-3, 0.3e-3], 0.6);
    m[2] = 1e-4;
    m[4] = -5e-5;
    const log = new Float64Array(6);
    expect(logTensor(m, log)).toBe(true);
    const back = new Float64Array(6);
    expTensor(log, back);
    for (let k = 0; k < 6; ++k) expect(back[k]).toBeCloseTo(m[k], 15);
  });

  it("of two diagonal tensors is the geometric mean of their eigenvalues", () => {
    const mean = logEuclideanMean([
      [1e-3, 0, 0, 4e-4, 0, 1e-4],
      [4e-3, 0, 0, 1e-4, 0, 9e-4],
    ]);
    const expected = [2e-3, 0, 0, 2e-4, 0, 3e-4];
    for (let k = 0; k < 6; ++k) expect(mean[k]).toBeCloseTo(expected[k], 12);
  });

  it("keeps the determinant where the plain mean swells it", () => {
    // Two cigars crossing at right angles, both of determinant 1.7 × 0.3 × 0.3 (µm²/ms)³.
    const a = rotated([1.7, 0.3, 0.3], 0);
    const b = rotated([1.7, 0.3, 0.3], Math.PI / 2);
    const plain = a.map((v, k) => (v + b[k]) / 2);
    const log = logEuclideanMean([a, b]);
    expect(det(a)).toBeCloseTo(0.153, 12);
    expect(det(log)).toBeCloseTo(det(a), 12);
    // The plain mean swells: a disc 1.0 × 1.0 × 0.3, about twice the volume.
    expect(det(plain)).toBeCloseTo(0.3, 12);
    // Of different determinants, the geometric mean of them.
    const c = rotated([3.0, 1.0, 0.5], 0.3);
    const d = rotated([0.8, 0.2, 0.1], 1.2);
    expect(det(logEuclideanMean([c, d]))).toBeCloseTo(Math.sqrt(det(c) * det(d)), 12);
  });

  it("leaves out tensors that are not positive definite, giving zeros (not NaN) when none is", () => {
    const good = [1e-3, 0, 0, 5e-4, 0, 2e-4];
    for (const bad of [[0, 0, 0, 0, 0, 0], [1e-3, 0, 0, -1e-5, 0, 2e-4], [NaN, 0, 0, 1, 0, 1], [Infinity, 0, 0, 1, 0, 1], [1, 2, 0, 1, 0, 1]]) {
      expect(logTensor(bad, new Float64Array(6))).toBe(false);
      const mean = logEuclideanMean([good, bad, good]);
      for (let k = 0; k < 6; ++k) expect(mean[k]).toBeCloseTo(good[k], 15);
      expect(Array.from(logEuclideanMean([bad, bad]))).toEqual([0, 0, 0, 0, 0, 0]);
    }
    expect(Array.from(logEuclideanMean([]))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("reads and writes each order as the Orientations plugin reads it", () => {
    expect(TENSOR_SLOTS).toEqual(TENSOR_POSITIONS);
    const a = [1.2e-3, 2e-4, -1e-4, 6e-4, 5e-5, 3e-4];
    const b = rotated([1.5e-3, 3e-4, 2e-4], 0.9);
    const fsl = logEuclideanMean([a, b], "fsl");
    for (const order of ["dipy", "mrtrix"] as TensorOrder[]) {
      const mean = logEuclideanMean([inOrder(a, order), inOrder(b, order)], order);
      const expected = inOrder(Array.from(fsl), order);
      for (let k = 0; k < 6; ++k) expect(mean[k]).toBeCloseTo(expected[k], 15);
    }
  });
});
