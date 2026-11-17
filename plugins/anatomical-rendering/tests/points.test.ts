import { describe, expect, it } from "vitest";
import { allocateLevels, GEOMETRY_BUDGET, groupColours, mmPerUnit, pointsLevelIndex } from "../points.js";

describe("a store read for the path tracer", () => {
  it("reads the finest level within the budget, and millimetres from the store's units", () => {
    const levels = [{ vertexCount: 9e6 }, { vertexCount: 3e6 }, { vertexCount: 5e5 }].map((l, index) => ({ ...l, index, chunkShape: [1, 1, 1], objectShare: undefined, objects: undefined }));
    expect(pointsLevelIndex({ levels }, 4e6)).toBe(1);
    expect(pointsLevelIndex({ levels }, 1e5)).toBe(2);
    expect(pointsLevelIndex({ levels })).toBe(2);
    expect(GEOMETRY_BUDGET).toBe(2e6);
    expect(mmPerUnit({ axisScales: [1e-3, 1e-3, 2e-3], axisUnits: ["m", "m", "m"] })).toEqual([1, 1, 2]);
    expect(mmPerUnit({ axisScales: [10, 10, 10], axisUnits: ["um", "µm", "nm"] }).map((x) => +x.toFixed(9))).toEqual([0.01, 0.01, 0.00001]);
  });

  it("colours groups as the layer does, leaving out the groups not shown", () => {
    const colours = groupColours({ by: "group", group: { tier: "class", attribute: "class_index", colours: "stored", shown: [9, 13] } });
    expect(colours.shows(9)).toBe(true);
    expect(colours.shows(4)).toBe(false);
    expect(colours.colour(9, 0xff0000)).toEqual([1, 0, 0]);
    const none = groupColours(undefined);
    expect(none.shows(4)).toBe(true);
  });
});

describe("levels shared between segments", () => {
  it("takes the cheapest finer level that fits, in turn, from each one's coarsest", () => {
    const store = (...n: number[]) => ({ levels: n.map((vertexCount) => ({ vertexCount })) });
    // The MICrONS cells (vertices a level, finest first) within a million vertices.
    const cells = [store(7237240, 2181402, 435223, 125427), store(1351086, 411639, 85110, 23749), store(2898556, 869076, 171196, 42112), store(7228709, 2177488, 438953, 132788)];
    expect(allocateLevels(cells, 1e6)).toEqual([3, 2, 2, 2]);
    expect(allocateLevels(cells, 1e5)).toEqual([3, 3, 3, 3]);
    // A level of unknown size is not taken.
    expect(allocateLevels([{ levels: [{ vertexCount: undefined }, { vertexCount: 10 }] }], 1e9)).toEqual([1]);
  });
});
