import { describe, expect, it } from "vitest";
import { TF_SIZE } from "../local/local.js";
import { groupColours, mmPerUnit, type Point, pointsLevelIndex, pointsTable, splatPoints } from "../points.js";

describe("a point cloud as a volume", () => {
  it("reads the finest level within the points, and millimetres from the store's units", () => {
    const levels = [{ vertexCount: 9e6 }, { vertexCount: 3e6 }, { vertexCount: 5e5 }].map((l, index) => ({ ...l, index, chunkShape: [1, 1, 1], objectShare: undefined, objects: undefined }));
    expect(pointsLevelIndex({ levels }, 4e6)).toBe(1);
    expect(pointsLevelIndex({ levels }, 1e5)).toBe(2);
    expect(mmPerUnit({ axisScales: [1e-3, 1e-3, 2e-3], axisUnits: ["m", "m", "m"] })).toEqual([1, 1, 2]);
    expect(mmPerUnit({ axisScales: [10, 10, 10], axisUnits: ["um", "µm", "nm"] }).map((x) => +x.toFixed(9))).toEqual([0.01, 0.01, 0.00001]);
  });

  it("makes each point a soft sphere labelled by its group, leaving out the groups not shown", () => {
    const points: Point[] = [
      { x: 1, y: 1, z: 1, group: 9, stored: 0xff0000 },
      { x: 3, y: 1, z: 1, group: 13, stored: 0x00ff00 },
      { x: 2, y: 3, z: 1, group: 4, stored: 0x0000ff },
    ];
    const colours = groupColours({ by: "group", group: { tier: "class", attribute: "class_index", colours: "stored", shown: [9, 13] } });
    const level = splatPoints(points, [0, 0, 0], [4, 4, 2], [1, 1, 1], 4096, colours);
    expect(level.points).toBe(2);
    expect(level.colours.slice(1)).toEqual([[1, 0, 0], [0, 1, 0]]);
    // The voxel at each point: occupied, and its group's label.
    const at = (x: number, y: number, z: number) => {
      const m = level.voxelToRas;
      const v = [(x - m[3]) / m[0], (y - m[7]) / m[5], (z - m[11]) / m[10]].map(Math.round);
      return v[0] + level.size[0] * (v[1] + level.size[1] * v[2]);
    };
    // Opaque at the point wherever it falls between voxel centres (the table's edge is 45..95).
    expect(level.data[at(1, 1, 1)]).toBeGreaterThan(140);
    expect(level.labels[at(1, 1, 1)]).toBe(1);
    expect(level.labels[at(3, 1, 1)]).toBe(2);
    // The group not shown is not there.
    expect(level.data[at(2, 3, 1)]).toBe(0);
    // Within the voxels asked for, but for the margin about the points (large beside a grid this small).
    expect(level.size.reduce((a, b) => a * b)).toBeLessThanOrEqual(4096 * 3);
  });

  it("colours each label at its place in the table, opaque only within a sphere", () => {
    const t = pointsTable([[0.5, 0.5, 0.5], [1, 0, 0], [0, 0, 1]]);
    expect(t.length).toBe(TF_SIZE * 4);
    const entry = (label: number) => Math.round((label / 255) * (TF_SIZE - 1));
    expect(Array.from(t.slice(4 * entry(1), 4 * entry(1) + 3))).toEqual([1, 0, 0]);
    expect(Array.from(t.slice(4 * entry(2), 4 * entry(2) + 3))).toEqual([0, 0, 1]);
    expect(t[3]).toBe(0);
    expect(t[4 * (TF_SIZE - 1) + 3]).toBe(1);
  });
});
