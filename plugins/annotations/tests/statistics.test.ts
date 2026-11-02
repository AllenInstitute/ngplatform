import { describe, expect, it } from "vitest";
import { corners, levelWithin, regionTest, summarise, valuesInside, voxelBox } from "../statistics.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("label statistics", () => {
  it("summarises values: count, mean, SD (n − 1), min, max, median", () => {
    const s = summarise(Float32Array.from([4, 1, 3, 2, NaN]));
    expect(s).toMatchObject({ count: 4, min: 1, max: 4, median: 2.5 });
    expect(s.mean).toBeCloseTo(2.5);
    expect(s.sd).toBeCloseTo(Math.sqrt(5 / 3));
    expect(summarise(Float32Array.from([7])).sd).toBe(0);
    expect(summarise(new Float32Array(0)).count).toBe(0);
  });

  it("takes the values inside a box, an ellipsoid or a label", () => {
    // A 10³ block whose value is its x.
    const block = new Float32Array(1000).map((_, i) => i % 10);
    const box = regionTest({ kind: "box", affine: IDENTITY, lo: [2, 0, 0], hi: [4, 9, 0] });
    const inBox = valuesInside(block, [0, 0, 0], [10, 10, 10], box);
    expect(inBox.length).toBe(3 * 10);
    expect(summarise(inBox).mean).toBeCloseTo(3);

    // A sphere of radius 2 voxels in a space of half-size voxels (radius 4 there).
    const half = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const ball = regionTest({ kind: "ellipsoid", affine: half, centre: [10, 10, 10], radii: [4, 4, 4] });
    expect(valuesInside(block, [0, 0, 0], [10, 10, 10], ball).length).toBe(33);

    // Label 2 of a label block placed one voxel along x from the image.
    const labels = new Uint8Array(27);
    labels[1 + 3 * (1 + 3 * 1)] = 2;
    const shifted = [1, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const label = regionTest({ kind: "label", affine: shifted, labels, origin: [0, 0, 0], size: [3, 3, 3], value: 2 });
    const values = valuesInside(block, [0, 0, 0], [10, 10, 10], label);
    expect(Array.from(values)).toEqual([2]);
  });

  it("finds the voxels a region can reach, inside the image", () => {
    const toVoxel = Float64Array.from([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    expect(voxelBox(corners([1, 1, 1], [3, 2, 2]), toVoxel, [100, 100, 100])).toEqual({ lo: [1, 1, 1], hi: [8, 6, 6] });
    expect(voxelBox(corners([-10, -10, -10], [-5, -5, -5]), toVoxel, [100, 100, 100])).toBeUndefined();
  });

  it("chooses the finest level whose box fits the budget", () => {
    const boxAt = (level: number) => 1000 / 8 ** level;
    expect(levelWithin(4, boxAt, 1000)).toBe(0);
    expect(levelWithin(4, boxAt, 200)).toBe(1);
    expect(levelWithin(4, boxAt, 1)).toBe(3);
  });
});
