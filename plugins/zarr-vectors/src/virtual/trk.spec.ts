/**
 * The .trk reader against nibabel: every streamline, in RAS+ mm, of files
 * whose header voxel order matches the affine, disagrees with it, or is
 * oblique, with per-point and per-streamline values; read whole and in tiny
 * slices (records split across them); and big-endian.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTrkHeader, readTrk, type TrkBatch } from "./trk.js";

const DIR = path.resolve(import.meta.dirname, "../../testdata/trk");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));

async function readAll(bytes: Uint8Array, slice?: number) {
  const header = parseTrkHeader(bytes);
  const batches: TrkBatch[] = [];
  const n = await readTrk(new Blob([bytes as BlobPart]), header, (b) => void batches.push(b), { slice });
  const lines: number[][][] = [];
  const scalars: number[][] = [];
  const properties: number[] = [];
  for (const b of batches) {
    for (let s = 0; s + 1 < b.offsets.length; ++s) {
      const line: number[][] = [];
      const values: number[] = [];
      for (let p = b.offsets[s]; p < b.offsets[s + 1]; ++p) {
        line.push([b.points[3 * p], b.points[3 * p + 1], b.points[3 * p + 2]]);
        if (header.scalarNames.length) values.push(b.scalars[p]);
      }
      lines.push(line);
      scalars.push(values);
      if (header.propertyNames.length) properties.push(b.properties[s]);
    }
  }
  return { header, n, lines, scalars, properties };
}

const close = (a: number[][][], b: number[][][]) => {
  expect(a.length).toBe(b.length);
  for (let s = 0; s < a.length; ++s) {
    expect(a[s].length).toBe(b[s].length);
    for (let p = 0; p < a[s].length; ++p) for (let k = 0; k < 3; ++k) expect(a[s][p][k]).toBeCloseTo(b[s][p][k], 3);
  }
};

describe(".trk files", () => {
  for (const name of Object.keys(expected)) {
    it(`reads ${name} as nibabel does`, async () => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, name)));
      const whole = await readAll(bytes);
      expect(whole.n).toBe(expected[name].streamlines.length);
      close(whole.lines, expected[name].streamlines);
      if (expected[name].fa) {
        expect(whole.header.scalarNames).toEqual(["fa"]);
        expect(whole.header.propertyNames).toEqual(["weight"]);
        whole.scalars.forEach((v, s) => v.forEach((x, i) => expect(x).toBeCloseTo(expected[name].fa[s][i], 5)));
        whole.properties.forEach((x, s) => expect(x).toBeCloseTo(expected[name].weight[s], 5));
      }
      // Slices far smaller than a streamline: records cross them.
      const sliced = await readAll(bytes, 37);
      close(sliced.lines, expected[name].streamlines);
    });
  }

  it("reads a big-endian file", async () => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, "ras.trk")));
    const little = parseTrkHeader(bytes);
    // Swap every 2- and 4-byte field of the header, then every 4-byte word after it.
    const big = bytes.slice();
    const swap = (at: number, size: number) => big.subarray(at, at + size).reverse();
    for (const at of [6, 8, 10, 36, 238]) swap(at, 2);
    for (let at = 12; at < 36; at += 4) swap(at, 4);
    for (let at = 440; at < 504; at += 4) swap(at, 4);
    for (let at = 956; at < 980; at += 4) swap(at, 4);
    for (const at of [988, 992, 996]) swap(at, 4);
    for (let at = 1000; at < big.length; at += 4) swap(at, 4);
    const read = await readAll(big);
    expect(read.header.littleEndian).toBe(false);
    expect(read.header.dims).toEqual(little.dims);
    close(read.lines, expected["ras.trk"].streamlines);
  });

  it("refuses what is not a .trk", () => {
    expect(() => parseTrkHeader(new Uint8Array(1000))).toThrow(/not a TrackVis/);
  });
});
