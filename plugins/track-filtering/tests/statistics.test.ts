/** Group statistics: each attribute over the passing objects, and the CSV of every group's. */
import { describe, expect, it } from "vitest";
import { groupStatistics, statisticsCsv } from "../filter.js";

const props = {
  ids: BigUint64Array.from([1n, 2n, 3n, 4n, 5n]),
  numeric: [
    { id: "length", description: undefined, values: [10, 20, 30, 40, 1000], min: 10, max: 1000 },
    { id: "fa", description: undefined, values: [0.5, NaN, 0.7, 0.2, 0.9], min: 0.2, max: 0.9 },
  ],
  tags: undefined,
};

describe("group statistics", () => {
  it("summarises each attribute over the passing objects, skipping missing values", () => {
    const [length, fa] = groupStatistics(props, Uint8Array.from([1, 1, 1, 1, 0]));
    expect(length).toMatchObject({ id: "length", n: 4, mean: 25, median: 25, min: 10, max: 40 });
    expect(length.sd).toBeCloseTo(Math.sqrt(500 / 3), 10);
    expect(fa).toMatchObject({ n: 3, median: 0.5, min: 0.2, max: 0.7 });
    expect(fa.mean).toBeCloseTo(1.4 / 3, 10);
    const none = groupStatistics(props, new Uint8Array(5));
    expect(none[0].n).toBe(0);
    expect(Number.isNaN(none[0].mean)).toBe(true);
  });

  it("writes a row per group and attribute", () => {
    const csv = statisticsCsv([
      { name: "a, b", count: 2, columns: groupStatistics(props, Uint8Array.from([1, 1, 0, 0, 0])) },
      { name: "none", count: 0, columns: [] },
    ]);
    expect(csv.split("\n")).toEqual([
      "group,objects,attribute,n,mean,sd,median,min,max",
      '"a, b",2,length,2,15,7.071068,15,10,20',
      '"a, b",2,fa,1,0.5,0,0.5,0.5,0.5',
      "none,0,,,,,,,",
      "",
    ]);
  });
});
