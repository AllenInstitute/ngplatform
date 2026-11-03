/** Parquet tables of points (as 10x Xenium writes transcripts), against pyarrow. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePointParquet } from "../src/virtual/vectors/point_files.js";

const DIR = new URL("./testdata/parquet/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8"));

describe("Parquet points", () => {
  for (const codec of ["snappy", "zstd"]) {
    it(`reads a ${codec} table: x, y, z from *_location, numeric columns as values, text left out`, async () => {
      const table = await parsePointParquet(new Blob([readFileSync(new URL(`transcripts_${codec}.parquet`, DIR))]));
      expect(table.positions.length).toBe(expected.positions.length);
      Array.from(table.positions).forEach((v, i) => expect(v).toBeCloseTo(expected.positions[i], 3));
      expect(table.columns.map((c) => c.name)).toEqual(["transcript_id", "qv"]);
      Array.from(table.columns[1].values).forEach((v, i) => expect(v).toBeCloseTo(expected.qv[i], 3));
      expect(table.unit).toBe("micrometer");
    });
  }
});
