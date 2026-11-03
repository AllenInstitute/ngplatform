/** Images warped by landmarks: the thin-plate spline, and a chunk resampled through it. */
import { describe, expect, it } from "vitest";
import { applyTps, fitTps, type Vec3, warpChunk } from "../src/virtual/warp.js";

const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-6) => Array.from(a).every((v, i) => Math.abs(v - b[i]) < tol);

describe("a thin-plate spline", () => {
  const fixed: Vec3[] = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10], [10, 10, 10], [5, 5, 5]];

  it("is the affine map when the landmarks are moved by one", () => {
    const moving = fixed.map(([x, y, z]) => [2 * x + 1, y - 3, 0.5 * z + 2] as Vec3);
    const t = fitTps(fixed, moving);
    expect(close(applyTps(t, [3, 4, 7]), [7, 1, 5.5])).toBe(true);
    expect(t.weights.every((w) => w.every((v) => Math.abs(v) < 1e-9))).toBe(true);
  });

  it("takes each fixed landmark to its moving one, smooth between", () => {
    const moving = fixed.map(([x, y, z], i) => [x + (i === 5 ? 2 : 0), y, z] as Vec3);
    const t = fitTps(fixed, moving);
    fixed.forEach((f, i) => expect(close(applyTps(t, f), moving[i], 1e-6)).toBe(true));
    const mid = applyTps(t, [4, 4, 4]);
    expect(mid[0]).toBeGreaterThan(4);
    expect(mid[0]).toBeLessThan(6);
  });

  it("says when the landmarks cannot fix a warp", () => {
    expect(() => fitTps(fixed.slice(0, 3), fixed.slice(0, 3))).toThrow(/four/);
    const flat: Vec3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]];
    expect(() => fitTps(flat, flat)).toThrow(/plane/);
  });
});

describe("a warped chunk", () => {
  it("is the moving image sampled where the spline takes each voxel", async () => {
    // A 1 mm grid, z, y, x, 8 voxels a side; the value at a voxel is its x index.
    const n = 8;
    const grid = { shape: [n, n, n], voxel: [1, 1, 1], origin: [0, 0, 0], xyz: [2, 1, 0], mm: [1, 1, 1] };
    const image = new Float32Array(n * n * n).map((_, i) => i % n);
    const read = async (lo: number[], hi: number[]) => {
      const out: number[] = [];
      for (let z = lo[0]; z < hi[0]; ++z) for (let y = lo[1]; y < hi[1]; ++y) for (let x = lo[2]; x < hi[2]; ++x) out.push(image[(z * n + y) * n + x]);
      return out;
    };
    // Fixed to moving: x + 1.5 mm.
    const fixed: Vec3[] = [[0, 0, 0], [7, 0, 0], [0, 7, 0], [0, 0, 7], [7, 7, 7]];
    const t = fitTps(fixed, fixed.map(([x, y, z]) => [x + 1.5, y, z] as Vec3));
    const out = await warpChunk(grid, [n, n, n], [0, 0, 0], t, read);
    const at = (z: number, y: number, x: number) => out[(z * n + y) * n + x];
    expect(at(3, 2, 1)).toBeCloseTo(2.5, 5);
    expect(at(0, 0, 5)).toBeCloseTo(6.5, 5);
    // Past the moving image's edge: 0.
    expect(at(0, 0, 7)).toBe(0);
  });
});
