/** Tensors: component orders, eigen-decomposition, FA and MD. */
import { describe, expect, it } from "vitest";
import { eigenSymmetric, fractionalAnisotropy, meanDiffusivity, tensorMatrix, TENSOR_POSITIONS } from "../tensor.js";

/** R diag(l) Rᵀ for a rotation about the axis by an angle. */
function rotated(l: [number, number, number], axis: [number, number, number], angle: number): { m: Float64Array; r: number[][] } {
  const n = Math.hypot(...axis);
  const [x, y, z] = axis.map((v) => v / n);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const r = [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
  const m = new Float64Array(9);
  for (let i = 0; i < 3; ++i) for (let j = 0; j < 3; ++j) for (let k = 0; k < 3; ++k) m[3 * i + j] += r[i][k] * l[k] * r[j][k];
  return { m, r };
}

describe("tensors", () => {
  it("reads the six components in FSL's, DIPY's and MRtrix's orders", () => {
    // xx=1 xy=2 xz=3 yy=4 yz=5 zz=6, stored each way.
    const stored = { fsl: [1, 2, 3, 4, 5, 6], dipy: [1, 2, 4, 3, 5, 6], mrtrix: [1, 4, 6, 2, 3, 5] };
    for (const [order, values] of Object.entries(stored)) {
      const m = tensorMatrix([0, ...values], 1, order as keyof typeof TENSOR_POSITIONS);
      expect(Array.from(m), order).toEqual([1, 2, 3, 2, 4, 5, 3, 5, 6]);
    }
  });

  it("finds eigenvalues and eigenvectors of a rotated tensor, largest first", () => {
    const l: [number, number, number] = [0.3e-3, 1.7e-3, 0.5e-3];
    const { m, r } = rotated(l, [1, 2, 3], 0.7);
    const { values, vectors } = eigenSymmetric(m);
    expect(values[0]).toBeCloseTo(1.7e-3, 12);
    expect(values[1]).toBeCloseTo(0.5e-3, 12);
    expect(values[2]).toBeCloseTo(0.3e-3, 12);
    // The principal eigenvector is the rotated y axis (either sign).
    const e1 = [vectors[0], vectors[1], vectors[2]];
    const expected = [r[0][1], r[1][1], r[2][1]];
    expect(Math.abs(e1[0] * expected[0] + e1[1] * expected[1] + e1[2] * expected[2])).toBeCloseTo(1, 10);
    // A v = λ v for each.
    for (let k = 0; k < 3; ++k) {
      const v = [vectors[3 * k], vectors[3 * k + 1], vectors[3 * k + 2]];
      for (let i = 0; i < 3; ++i) expect(m[3 * i] * v[0] + m[3 * i + 1] * v[1] + m[3 * i + 2] * v[2]).toBeCloseTo(values[k] * v[i], 12);
    }
  });

  it("handles diagonal, repeated and zero tensors", () => {
    expect(eigenSymmetric([2, 0, 0, 0, 3, 0, 0, 0, 1]).values).toEqual([3, 2, 1]);
    const iso = eigenSymmetric([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(iso.values).toEqual([1, 1, 1]);
    expect(fractionalAnisotropy(iso.values)).toBe(0);
    expect(fractionalAnisotropy(eigenSymmetric(new Float64Array(9)).values)).toBe(0);
  });

  it("gives the usual FA and MD", () => {
    // A white-matter-like tensor: λ = 1.7, 0.3, 0.3 (µm²/ms) has FA 0.8.
    expect(fractionalAnisotropy([1.7, 0.3, 0.3])).toBeCloseTo(0.8, 2);
    expect(fractionalAnisotropy([1, 0, 0])).toBeCloseTo(1, 12);
    expect(meanDiffusivity([1.7, 0.3, 0.3])).toBeCloseTo(0.7667, 4);
  });
});
