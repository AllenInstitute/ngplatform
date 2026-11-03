/** Feather (Arrow IPC v2) point tables, against pyarrow: LZ4, ZSTD and uncompressed, several record batches, nulls, skipped text. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFeather } from "../src/virtual/vectors/feather.js";
import { pointTableOf } from "../src/virtual/vectors/point_files.js";

const DIR = new URL("./testdata/feather/", import.meta.url);
const expected: Record<string, (number | null)[]> = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8"));
const read = (name: string) => readFeather(new Uint8Array(readFileSync(new URL(name, DIR))));

describe("Feather", () => {
  for (const name of ["points_lz4.feather", "points_zstd.feather", "points_plain.feather"]) {
    it(`reads every numeric column of ${name}`, () => {
      const t = read(name);
      expect(t.rows).toBe(25);
      expect(t.names[0]).toBe("cell_type");
      expect([...t.numeric].sort()).toEqual(Object.keys(expected).sort());
      for (const [column, want] of Object.entries(expected)) {
        const got = t.values.get(column)!;
        want.forEach((v, i) => (v === null ? expect(got[i]).toBeNaN() : expect(got[i]).toBeCloseTo(v, column === "half" ? 2 : 5)));
      }
      const points = pointTableOf(t.names, t.values, t.rows, t.numeric, "Feather");
      expect(points.positions[0]).toBeCloseTo(expected.x_location[0]!, 6);
      expect(points.unit).toBe("micrometer");
      // qv has a null: left out of the values per point.
      expect(points.columns.map((c) => c.name).sort()).toEqual(["count", "flag", "half", "small"]);
    });
  }

  for (const name of ["grid_lz4.feather", "grid_zstd.feather"]) {
    it(`decompresses ${name}'s buffers`, () => {
      const t = read(name);
      expect(t.rows).toBe(4000);
      const x = t.values.get("x")!;
      const y = t.values.get("y")!;
      const label = t.values.get("label")!;
      for (const i of [0, 7, 8, 1499, 1500, 3999]) {
        expect(x[i]).toBe(Math.floor(i / 8));
        expect(y[i]).toBe(i % 8);
        expect(label[i]).toBe(Math.floor(i / 100));
      }
    });
  }

  it("says what it cannot read", () => {
    expect(() => readFeather(new Uint8Array([0x46, 0x45, 0x41, 0x31, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/version 1/);
  });
});
