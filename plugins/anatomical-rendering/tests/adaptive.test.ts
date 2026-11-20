import { describe, expect, it } from "vitest";
import { BRICK_SIDE, brickCount, chooseLevels, finerLevels, levelShares, REGION, regionBricks, regionGrid } from "../adaptive.js";

/** A level's voxel to RAS (row-major): `s` mm voxels, voxel 0's centre at s / 2 (as Neuroglancer places a level). */
const affine = (s: number) => [s, 0, 0, s / 2, 0, s, 0, s / 2, 0, 0, s, s / 2, 0, 0, 0, 1];

describe("finer levels over the base", () => {
  const levels = [
    { index: 0, path: "s0", size: [400, 400, 400] as [number, number, number], voxelMm: 0.25, voxelToRas: affine(0.25) },
    { index: 1, path: "s1", size: [200, 200, 200] as [number, number, number], voxelMm: 0.5, voxelToRas: affine(0.5) },
    { index: 2, path: "s2", size: [100, 100, 100] as [number, number, number], voxelMm: 1, voxelToRas: affine(1) },
  ];

  it("map a base voxel point into each, coarsest first", () => {
    const f = finerLevels({ voxelToRas: affine(1), voxelMm: 1 }, levels);
    expect(f.map((l) => l.path)).toEqual(["s1", "s0"]);
    // Base voxel 0's centre (0.5 mm) is s1's voxel 0.5 (centres 0.25 and 0.75 mm round it).
    expect(f[0].scale).toEqual([2, 2, 2]);
    expect(f[0].offset.map((x) => +x.toFixed(9))).toEqual([0.5, 0.5, 0.5]);
    expect(f[1].scale).toEqual([4, 4, 4]);
    expect(f[1].offset.map((x) => +x.toFixed(9))).toEqual([1.5, 1.5, 1.5]);
  });

  it("leave out a level turned against the base", () => {
    const turned = [0, -0.5, 0, 0, 0.5, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1];
    expect(finerLevels({ voxelToRas: affine(1), voxelMm: 1 }, [{ ...levels[1], voxelToRas: turned }])).toEqual([]);
  });

  it("cover a region with the bricks it needs", () => {
    const [s1, s0] = finerLevels({ voxelToRas: affine(1), voxelMm: 1 }, levels);
    // A region of 8 base voxels is 16 voxels of s1 (one brick, give or take its edge) and 32 of s0 (one or two).
    const r1 = regionBricks([0, 0, 0], s1, [100, 100, 100]);
    expect(r1.b0).toEqual([0, 0, 0]);
    expect(r1.n[0]).toBeGreaterThanOrEqual(1);
    expect(r1.n[0]).toBeLessThanOrEqual(2);
    const r0 = regionBricks([1, 1, 1], s0, [100, 100, 100]);
    expect(r0.b0[0]).toBe(Math.floor((REGION * 4 - 0.5 * 4 + 1.5 + 0.5) / BRICK_SIDE));
    expect(brickCount([1, 1, 1], s0, [100, 100, 100])).toBeGreaterThanOrEqual(1);
    // The last region (only 4 base voxels) stays within the level.
    const last = regionBricks([12, 12, 12], s0, [100, 100, 100]);
    expect(last.b0[0] + last.n[0] - 1).toBeLessThan(Math.ceil(400 / BRICK_SIDE));
    expect(regionGrid([100, 100, 100])).toEqual([13, 13, 13]);
  });
});

describe("choosing each region's level", () => {
  it("refines the regions with the largest error first, within the bricks", () => {
    // Four regions: pixels 1, 2, 4 and off screen; base voxel 8, levels of 4, 2, 1; each level costs 1, 8, 64 bricks.
    const pixel = Float32Array.from([1, 2, 4, Infinity]);
    const cost = (_: number, level: number) => [0, 1, 8, 64][level];
    const all = chooseLevels({ regions: 4, levels: 3, voxelWorld: [8, 4, 2, 1], pixel, slots: 1000, cost });
    expect(Array.from(all)).toEqual([3, 2, 1, 0]);
    // With 10 bricks: region 0 to level 2 (8), region 1 to level 1 (1), region 2 to level 1 (1).
    const some = chooseLevels({ regions: 4, levels: 3, voxelWorld: [8, 4, 2, 1], pixel, slots: 10, cost });
    expect(Array.from(some)).toEqual([2, 1, 1, 0]);
    const used = Array.from(some).reduce((n, l) => n + cost(0, l), 0);
    expect(used).toBeLessThanOrEqual(10);
  });

  it("leaves empty regions and those fine enough at the base", () => {
    const pixel = Float32Array.from([1, 100]);
    const chosen = chooseLevels({ regions: 2, levels: 2, voxelWorld: [8, 4, 2], pixel, slots: 100, cost: () => 1, skip: (r) => r === 0 });
    expect(Array.from(chosen)).toEqual([0, 0]);
  });

  it("keeps a level drawn now until its error is well under the threshold (hysteresis)", () => {
    // Error 2 at the base, 0.8 at level 1: new, level 1 is enough; drawn at level 2 now, it stays (0.8 > KEEP).
    const options = { regions: 1, levels: 2, voxelWorld: [2, 0.8, 0.4], pixel: Float32Array.from([1]), slots: 100, cost: () => 1 };
    expect(Array.from(chooseLevels(options))).toEqual([1]);
    expect(Array.from(chooseLevels({ ...options, current: Uint8Array.from([2]) }))).toEqual([2]);
    // Error well under (0.4 at level 1, KEEP 0.5): drawn coarser.
    expect(Array.from(chooseLevels({ ...options, voxelWorld: [2, 0.4, 0.2], current: Uint8Array.from([2]) }))).toEqual([1]);
  });

  it("keeps neighbours in view within a level of each other", () => {
    // A row of three: the first very near, the others far. Bricks plenty: the others raised to one level apart.
    const pixel = Float32Array.from([0.01, 100, 100]);
    const base = { regions: 3, levels: 3, voxelWorld: [8, 4, 2, 1], pixel, cost: (_: number, l: number) => l, grid: [3, 1, 1] as [number, number, number] };
    expect(Array.from(chooseLevels({ ...base, slots: 100 }))).toEqual([3, 2, 1]);
    // Bricks short: the fine one lowered instead.
    const tight = Array.from(chooseLevels({ ...base, slots: 3 }));
    for (let i = 0; i < 2; ++i) expect(Math.abs(tight[i] - tight[i + 1])).toBeLessThanOrEqual(1);
    expect(tight.reduce((n, l) => n + l, 0)).toBeLessThanOrEqual(3);
    // Off screen or empty: no seam seen there, no rule.
    expect(Array.from(chooseLevels({ ...base, pixel: Float32Array.from([0.01, Infinity, 100]), slots: 100 }))).toEqual([3, 0, 0]);
    expect(Array.from(chooseLevels({ ...base, slots: 100, skip: (r) => r === 1 }))).toEqual([3, 0, 0]);
  });

  it("says each level's share of the image", () => {
    const shares = levelShares(Uint8Array.from([0, 1, 1, 2]), [4, 1, 1], [64, 16, 16], 2);
    expect(shares).toEqual([0.25, 0.5, 0.25]);
  });
});
