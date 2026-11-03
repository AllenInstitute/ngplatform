/** Images warped by landmarks (the thin-plate spline) and by displacement fields, and a chunk resampled through them. */
import { describe, expect, it } from "vitest";
import { fieldAxes } from "../src/virtual/computed.js";
import { ChainWarp, type Affine, applyTps, FieldWarp, fitTps, type Vec3, warpChunk } from "../src/virtual/warp.js";

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

describe("a displacement field", () => {
  // The moving image: a 1 mm grid, z, y, x, 8 voxels a side, the value at a voxel its x index.
  const n = 8;
  const grid = { shape: [n, n, n], voxel: [1, 1, 1], origin: [0, 0, 0], xyz: [2, 1, 0], mm: [1, 1, 1] };
  const image = new Float32Array(n * n * n).map((_, i) => i % n);
  const read = async (lo: number[], hi: number[]) => {
    const out: number[] = [];
    for (let z = lo[0]; z < hi[0]; ++z) for (let y = lo[1]; y < hi[1]; ++y) for (let x = lo[2]; x < hi[2]; ++x) out.push(image[(z * n + y) * n + x]);
    return out;
  };
  const at = (out: Float32Array, z: number, y: number, x: number) => out[(z * n + y) * n + x];

  /**
   * A field on a grid of 2 mm voxels (z, y, x, 6 a side, its first voxel at
   * -1 mm), its components stored z, y, x: `d` gives the displacement (mm;
   * x, y, z) at a place (mm; x, y, z).  Reads are counted.
   */
  const field = (d: (p: number[]) => number[], invert = false, before: Affine[] = [], after: Affine[] = []) => {
    const m = 6;
    const fieldGrid = { shape: [m, m, m], voxel: [2, 2, 2], origin: [-1, -1, -1], xyz: [2, 1, 0], mm: [1, 1, 1] };
    const reads: number[][][] = [];
    const reader = async (lo: number[], hi: number[]) => {
      reads.push([lo, hi]);
      const comps: number[][] = [[], [], []];
      for (let z = lo[0]; z < hi[0]; ++z)
        for (let y = lo[1]; y < hi[1]; ++y)
          for (let x = lo[2]; x < hi[2]; ++x) {
            const v = d([-1 + 2 * x, -1 + 2 * y, -1 + 2 * z]);
            comps[0].push(v[2]);
            comps[1].push(v[1]);
            comps[2].push(v[0]);
          }
      return comps;
    };
    return { warp: new FieldWarp({ before, after, invert, grid: fieldGrid, components: [2, 1, 0], mm: 1 }, reader), reads };
  };

  it("chained, applies each in turn (two shifts add up)", async () => {
    const { warp: one } = field(() => [1, 0, 0]);
    const { warp: two } = field(() => [0.5, 0, 0]);
    const out = await warpChunk(grid, [n, n, n], [0, 0, 0], new ChainWarp([one, two]), read);
    expect(at(out, 3, 2, 1)).toBeCloseTo(2.5, 5);
    expect(at(out, 0, 0, 5)).toBeCloseTo(6.5, 5);
  });

  it("as a constant shift is the affine shift", async () => {
    const { warp } = field(() => [1.5, 0, 0]);
    const out = await warpChunk(grid, [n, n, n], [0, 0, 0], warp, read);
    const shifted = [1, 0, 0, 1.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const { warp: affine } = field(() => [0, 0, 0], false, [shifted]);
    const expected = await warpChunk(grid, [n, n, n], [0, 0, 0], affine, read);
    expect(at(out, 3, 2, 1)).toBeCloseTo(2.5, 5);
    expect(at(out, 0, 0, 5)).toBeCloseTo(6.5, 5);
    expect(at(out, 0, 0, 7)).toBe(0);
    expect(close(out, expected, 1e-5)).toBe(true);
  });

  it("varies as the field does, trilinear between its voxels", async () => {
    // x displaced by 0.25 y + 0.1 z (linear, so trilinear lookups give it exactly).
    const { warp } = field(([, y, z]) => [0.25 * y + 0.1 * z, 0, 0]);
    const out = await warpChunk(grid, [n, n, n], [0, 0, 0], warp, read);
    for (const [z, y, x] of [[0, 0, 1], [3, 2, 1], [5, 4, 2], [7, 3, 0]]) expect(at(out, z, y, x)).toBeCloseTo(x + 0.25 * y + 0.1 * z, 4);
  });

  it("composes with affines before and after it", async () => {
    // Before: x scaled by 0.5; the field: +1 mm in x; after: +0.5 mm in x.
    const half = [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const on = [1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const { warp } = field(() => [1, 0, 0], false, [half], [on]);
    const out = await warpChunk(grid, [n, n, n], [0, 0, 0], warp, read);
    for (const x of [0, 2, 5, 7]) expect(at(out, 1, 1, x)).toBeCloseTo(0.5 * x + 1.5, 5);
  });

  it("is inverted by iteration when asked", async () => {
    // q = x + 0.2 x: the inverse takes q to q / 1.2.
    const { warp } = field(([x]) => [0.2 * x, 0, 0], true);
    const out = await warpChunk(grid, [n, n, n], [0, 0, 0], warp, read);
    for (const x of [0, 3, 6]) expect(at(out, 2, 2, x)).toBeCloseTo(x / 1.2, 4);
    // A constant shift inverted is the shift back.
    const { warp: back } = field(() => [-1.5, 0, 0], true);
    const shifted = await warpChunk(grid, [n, n, n], [0, 0, 0], back, read);
    expect(at(shifted, 3, 2, 1)).toBeCloseTo(2.5, 5);
  });

  it("reads only the box of the field a chunk looks up", async () => {
    const { warp, reads } = field(() => [0, 0, 0]);
    await warpChunk(grid, [4, 4, 4], [0, 0, 0], warp, read);
    // Voxels 0..3 (mm) are field voxels 0.5..2: the box from 0 to 4, short of the field's 6.
    expect(reads).toEqual([[[0, 0, 0], [4, 4, 4]]]);
  });
});

describe("a displacement field's metadata", () => {
  it("names its displacement axis, before z, y, x", () => {
    const v06 = {
      attributes: {
        ome: {
          multiscales: [
            {
              coordinateSystems: [{ name: "physical", axes: [{ name: "c", type: "displacement", discrete: true }, { name: "z" }, { name: "y" }, { name: "x" }] }],
              datasets: [{ path: "s0", coordinateTransformations: [{ type: "scale", scale: [1, 2, 2, 2], input: { path: "s0" }, output: { name: "physical" } }] }],
            },
          ],
        },
      },
    };
    expect(fieldAxes(v06)).toEqual({ names: ["c", "z", "y", "x"], displacement: "c" });
    expect(fieldAxes({ multiscales: [{ axes: ["d", "z", "y", "x"] }] }).displacement).toBe("d");
    expect(() => fieldAxes({ multiscales: [{ axes: [{ name: "z" }, { name: "y" }, { name: "x" }, { name: "c", type: "displacement" }] }] })).toThrow(/before z, y, x/);
    expect(() => fieldAxes({})).toThrow(/multiscale/);
  });
});
