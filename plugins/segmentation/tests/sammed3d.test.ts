import { describe, expect, it } from "vitest";
import { cubeAt, maskOnLabels, modelVolume, pointInCube, SAMMED3D_SIZE, spacingFor, upsampleMask } from "../sammed3d.js";
import type { Vec3 } from "../kernels.js";
import { cubePrompts } from "../sammed3d_model.js";

const S = SAMMED3D_SIZE;
// A label grid of 0.5 × 0.5 × 2 mm voxels, its first axis flipped (towards L), placed at (10, 20, 30) mm.
const LABEL_TO_RAS = [-0.5, 0, 0, 10, 0, 0.5, 0, 20, 0, 0, 2, 30, 0, 0, 0, 1];
const apply = (m: ArrayLike<number>, p: number[]) => [0, 1, 2].map((r) => m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3]);

describe("SAM-Med3D's cube", () => {
  it("lies along the world's axes at the spacing, centred on the prompt, and maps both ways", () => {
    const centre: Vec3 = [100, 80, 12];
    const cube = cubeAt(centre, LABEL_TO_RAS, 1.5, [0.5, 1, 2, 4]);
    // The centre is half way between voxels 63 and 64.
    const g = pointInCube(cube, centre);
    for (const v of g) expect(v).toBeCloseTo((S - 1) / 2, 6);
    // One voxel along the cube's x is 1.5 mm towards R: 3 label voxels back along the flipped axis.
    const a = apply(cube.gridToLabel, [0, 0, 0]);
    const b = apply(cube.gridToLabel, [1, 0, 0]);
    expect(b[0] - a[0]).toBeCloseTo(-3, 6);
    const c = apply(cube.gridToLabel, [0, 0, 1]);
    expect(c[2] - a[2]).toBeCloseTo(0.75, 6);
    const back = apply(cube.labelToGrid, apply(cube.gridToLabel, [5, 6, 7]));
    back.forEach((v, k) => expect(v).toBeCloseTo([5, 6, 7][k], 6));
    // Read from the coarsest level no coarser than 1.5 mm: 1 mm.
    expect(cube.level).toBe(1);
    expect(cubeAt(centre, LABEL_TO_RAS, 1.5, [2, 4]).level).toBe(0);
  });

  it("is coarser for a box that would not fit at 1.5 mm", () => {
    expect(spacingFor(50)).toBe(1.5);
    expect(spacingFor(256)).toBeCloseTo(2.5, 6);
  });
});

describe("SAM-Med3D's image", () => {
  it("is x slowest, NaN as 0, normalised by the values above 0", () => {
    const grid = new Float32Array(S * S * S);
    // Above 0: half the voxels 10, half 30 (mean 20); the rest 0.
    for (let i = 0; i < grid.length; ++i) grid[i] = i % 4 === 0 ? 10 : i % 4 === 1 ? 30 : 0;
    grid[5] = NaN;
    const out = modelVolume(grid);
    const n = grid.length / 2;
    const std = Math.sqrt((n * 100) / (n - 1));
    expect(out[0]).toBeCloseTo((10 - 20) / std, 4);
    // Voxel (x = 1, y = 0, z = 0) is at index 1 read, at 128² in the model's order.
    expect(out[S * S]).toBeCloseTo((30 - 20) / std, 4);
    expect(out[5 * S * S]).toBeCloseTo((0 - 20) / std, 4);
  });
});

describe("SAM-Med3D's mask", () => {
  it("is taken to 128³ trilinearly, selected above 0", () => {
    const low = new Float32Array(32 ** 3).fill(-1);
    expect(upsampleMask(low).some((v) => v)).toBe(false);
    // A step along the first axis: below 16 negative, from 16 positive; it crosses 0 at 63.5 (voxel 63 last below).
    for (let a = 16; a < 32; ++a) low.fill(1, a * 32 * 32, (a + 1) * 32 * 32);
    const up = upsampleMask(low);
    expect(up[63 * S * S]).toBe(0);
    expect(up[64 * S * S]).toBe(1);
  });

  it("lands on the label voxels it covers, within the box round it", () => {
    const cube = cubeAt([100, 80, 12], LABEL_TO_RAS, 1.5, [0.5]);
    // A 4 × 4 × 4 block of cube voxels at 60 … 63.
    const sel = new Uint8Array(S ** 3);
    for (let a = 60; a < 64; ++a) for (let b = 60; b < 64; ++b) for (let c = 60; c < 64; ++c) sel[(a * S + b) * S + c] = 1;
    const m = maskOnLabels(sel, cube, [400, 400, 100]);
    // 6 mm a side: 12 label voxels along x and y, 3 along z (and a voxel of rounding at the edges).
    expect(m.size[0]).toBeGreaterThanOrEqual(12);
    expect(m.size[0]).toBeLessThanOrEqual(14);
    expect(m.size[2]).toBeGreaterThanOrEqual(3);
    let n = 0;
    for (const v of m.data) n += v;
    expect(n).toBeGreaterThan(12 * 12 * 3 * 0.8);
    expect(n).toBeLessThan(12 * 12 * 3 * 1.4);
    // Every selected label voxel's centre lies in the block (half a cube voxel of slack).
    for (let z = 0; z < m.size[2]; ++z)
      for (let y = 0; y < m.size[1]; ++y)
        for (let x = 0; x < m.size[0]; ++x) {
          if (!m.data[x + m.size[0] * (y + m.size[1] * z)]) continue;
          const g = pointInCube(cube, [m.lo[0] + x, m.lo[1] + y, m.lo[2] + z]);
          g.forEach((v) => expect(v > 59.4 && v < 63.6).toBe(true));
        }
  });

  it("asks for a coarser label volume when the mask would be too large", () => {
    const fine = [0.05, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 1];
    const cube = cubeAt([1000, 1000, 1000], fine, 1.5, [0.05]);
    const sel = new Uint8Array(S ** 3).fill(1);
    expect(() => maskOnLabels(sel, cube, [4000, 4000, 4000])).toThrow(/coarser/);
  });
});

describe("SAM-Med3D's prompts", () => {
  it("centre the cube on a box's middle, with the clicks as its points when there are any", () => {
    const box = { lo: [10, 20, 5] as Vec3, hi: [51, 61, 6] as Vec3 };
    const only = cubePrompts({ box, points: [] }, [1, 1, 3])!;
    expect(only.centre).toEqual([30, 40, 5]);
    expect(only.spacing).toBe(1.5);
    expect(only.points).toEqual([{ at: [30, 40, 5], positive: true }]);
    const clicked = cubePrompts({ box, points: [{ at: [25, 41, 5], positive: true }] }, [1, 1, 3])!;
    expect(clicked.centre).toEqual([30, 40, 5]);
    expect(clicked.points).toEqual([{ at: [25, 41, 5], positive: true }]);
    // A large box: coarser.
    expect(cubePrompts({ box: { lo: [0, 0, 0], hi: [256, 10, 1] }, points: [] }, [1, 1, 1])!.spacing).toBeCloseTo(2.5, 6);
  });

  it("else on the first click wanted, and need one", () => {
    const p = cubePrompts({ points: [{ at: [1, 2, 3], positive: false }, { at: [4, 5, 6], positive: true }, { at: [7, 8, 9], positive: true }] }, [1, 1, 1])!;
    expect(p.centre).toEqual([4, 5, 6]);
    expect(p.points).toHaveLength(3);
    expect(cubePrompts({ points: [{ at: [1, 2, 3], positive: false }] }, [1, 1, 1])).toBeUndefined();
  });
});
