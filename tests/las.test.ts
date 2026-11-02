/** LAS point clouds, against laspy. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLas } from "../src/virtual/vectors/point_files.js";

const DIR = new URL("./testdata/las/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8"));

describe("LAS", () => {
  for (const name of ["points_v12.las", "points_v14.las"]) {
    it(`reads ${name} as laspy does`, () => {
      const table = parseLas(new Uint8Array(readFileSync(new URL(name, DIR))));
      const want = expected[name];
      Array.from(table.positions).forEach((v, i) => expect(v).toBeCloseTo(want.positions[i], 5));
      expect(Array.from(table.columns[0].values)).toEqual(want.intensity);
      expect(Array.from(table.columns[1].values)).toEqual(want.classification);
    });
  }
});
