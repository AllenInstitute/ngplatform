/** NumPy .npy arrays as virtual OME-Zarr images: [z, y, x] arrays show x fastest, in either order and byte order. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openNpy, parseNpyHeader } from "../src/virtual/images/npy.js";
import { readLevel, storeLevels } from "../src/virtual/out/read_level.js";

const DIR = new URL("./testdata/npy/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8")) as Record<string, { shape: number[]; values: number[] }>;

describe("NumPy arrays", () => {
  for (const [name, want] of Object.entries(expected)) {
    it(`reads ${name}`, async () => {
      const store = await openNpy(new Blob([readFileSync(new URL(name, DIR))]), name);
      const { levels } = await storeLevels(store);
      expect(levels[0].size).toEqual(want.shape.slice(0, 3));
      // The first time point of a 4-D array.
      const volume = await readLevel(store, levels[0]);
      const n = want.shape[0] * want.shape[1] * want.shape[2];
      Array.from(volume.data).forEach((v, i) => expect(v).toBeCloseTo(want.values[i], 4));
      expect(volume.data.length).toBe(n);
    });
  }

  it("refuses what is not .npy", () => {
    expect(() => parseNpyHeader(new Uint8Array(16))).toThrow(/not a NumPy/);
  });
});
