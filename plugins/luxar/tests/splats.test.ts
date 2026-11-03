/** Splats made from voxels: each cell's centre, covariance and weight match its intensity's moments. */
import { describe, expect, it } from "vitest";
import { splatsOfBlock, splatsToWorld } from "../splats.js";

/** A block (x fastest) of a sampled Gaussian blob: centre c, standard deviations s along x, y, z, peak 1. */
function blob(size: [number, number, number], c: number[], s: number[]): Float32Array {
  const out = new Float32Array(size[0] * size[1] * size[2]);
  for (let z = 0, i = 0; z < size[2]; ++z) for (let y = 0; y < size[1]; ++y) for (let x = 0; x < size[0]; ++x, ++i) out[i] = Math.exp(-0.5 * (((x - c[0]) / s[0]) ** 2 + ((y - c[1]) / s[1]) ** 2 + ((z - c[2]) / s[2]) ** 2));
  return out;
}

describe("splats from voxels", () => {
  it("recovers a Gaussian blob's centre and spread when one cell holds it", () => {
    const s = splatsOfBlock(blob([32, 32, 32], [15.3, 16.1, 14.6], [2, 3, 1.5]), [32, 32, 32], 32);
    expect(s.count).toBe(1);
    expect(Array.from(s.centres)).toEqual([expect.closeTo(15.3, 3), expect.closeTo(16.1, 3), expect.closeTo(14.6, 3)]);
    // Variance: the blob's σ² plus a voxel's own 1/12.
    expect(s.covariances[0]).toBeCloseTo(4 + 1 / 12, 2);
    expect(s.covariances[3]).toBeCloseTo(9 + 1 / 12, 2);
    expect(s.covariances[5]).toBeCloseTo(2.25 + 1 / 12, 2);
    expect(Math.abs(s.covariances[1])).toBeLessThan(1e-3);
    // Its mass: the blob's integral, (2π)^1.5 σx σy σz.
    expect(s.masses[0]).toBeCloseTo((2 * Math.PI) ** 1.5 * 2 * 3 * 1.5, 1);
  });

  it("makes one splat per cell with something in it, none for empty space, and keeps the mass", () => {
    const values = new Float32Array(16 * 16 * 16);
    // A bright line along x at y = 3, z = 5, from x = 2 to 13.
    for (let x = 2; x < 14; ++x) values[x + 16 * (3 + 16 * 5)] = 1;
    const s = splatsOfBlock(values, [16, 16, 16], 4);
    expect(s.count).toBe(4);
    expect(Array.from(s.masses).reduce((a, b) => a + b, 0)).toBeCloseTo(12, 5);
    // Each splat lies along the line: long in x, a voxel thick in y and z.
    for (let i = 0; i < s.count; ++i) {
      expect(s.centres[3 * i + 1]).toBeCloseTo(3, 5);
      expect(s.covariances[6 * i + 3]).toBeCloseTo(1 / 12, 5);
      expect(s.covariances[6 * i]).toBeGreaterThan(0.3);
    }
  });

  it("places splats in the world: centres through the affine, covariances as A Σ Aᵀ", () => {
    const s = splatsOfBlock(blob([8, 8, 8], [3, 4, 5], [1, 1, 1]), [8, 8, 8], 8);
    // 0.5 mm voxels, x and y swapped, an offset.
    const a = [0, 0.5, 0, 10, 0.5, 0, 0, -20, 0, 0, 0.5, 3, 0, 0, 0, 1];
    const w = splatsToWorld(s, a);
    expect(w.centres[0]).toBeCloseTo(0.5 * s.centres[1] + 10, 4);
    expect(w.centres[1]).toBeCloseTo(0.5 * s.centres[0] - 20, 4);
    expect(w.covariances[0]).toBeCloseTo(0.25 * s.covariances[3], 4);
    expect(w.covariances[3]).toBeCloseTo(0.25 * s.covariances[0], 4);
    expect(w.covariances[5]).toBeCloseTo(0.25 * s.covariances[5], 4);
  });
});
