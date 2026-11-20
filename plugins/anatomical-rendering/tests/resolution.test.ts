import { describe, expect, it } from "vitest";
import { lengthText, resolutionUse } from "../resolution.js";

const levels = [
  { path: "s2", size: [100, 100, 100], voxelMm: 0.026 },
  { path: "s0", size: [400, 400, 400], voxelMm: 0.0065 },
  { path: "s1", size: [200, 200, 200], voxelMm: 0.013 },
];

describe("the levels drawn", () => {
  it("one level over all of the image, the levels finest first", () => {
    const u = resolutionUse(levels, levels[0]);
    expect(u.levels.map((l) => l.path)).toEqual(["s0", "s1", "s2"]);
    expect(u.shares).toEqual([0, 0, 1]);
    expect(u.text).toBe("s2 (26 µm, 100 × 100 × 100) over all of the image; the finest, s0, is 6.5 µm");
  });

  it("a finer region where the view looks takes its share from the base level", () => {
    // A quarter of s0 along each axis: 1/64 of the image.
    const u = resolutionUse(levels, levels[0], { level: levels[1], lo: [0, 0, 0], hi: [100, 100, 100] });
    expect(u.shares[0]).toBeCloseTo(1 / 64, 9);
    expect(u.shares[2]).toBeCloseTo(63 / 64, 9);
    expect(u.text).toContain("s0 (6.5 µm) over 1.6 % where the view looks");
  });

  it("a level not listed is still shown", () => {
    const u = resolutionUse([], { path: "4", size: [10, 10, 10], voxelMm: 1.5 });
    expect(u.levels).toHaveLength(1);
    expect(u.shares).toEqual([1]);
  });

  it("says lengths in the units people use", () => {
    expect(lengthText(0.0065)).toBe("6.5 µm");
    expect(lengthText(1.5)).toBe("1.5 mm");
    expect(lengthText(4e-6)).toBe("4 nm");
    expect(lengthText(0.1)).toBe("100 µm");
  });
});
