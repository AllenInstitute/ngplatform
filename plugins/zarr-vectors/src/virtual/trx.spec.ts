/**
 * The .trx reader against trx-python: stored and deflated zips, float16
 * positions, per-point and per-streamline values, in small batches; and the
 * store made from one, read back by this package's reader.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSegmentProperties } from "../objects.js";
import { ObjectReader, openZarrVectorsStore, readObjectTable, ShardIndexCache } from "../reader.js";
import { openTrx } from "../../../../src/virtual/vectors/tractograms.js";
import type { TrkBatch } from "../../../../src/virtual/vectors/trk.js";
import { openTrxInfo, readTrx, zipEntries } from "../../../../src/virtual/vectors/trx.js";

const DIR = path.resolve(import.meta.dirname, "../../testdata/tractograms");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected_trx.json"), "utf8"));
const blob = (name: string) => new Blob([fs.readFileSync(path.join(DIR, name))]);

describe(".trx files", () => {
  it("lists a zip's entries", async () => {
    const entries = await zipEntries(blob("tracks_deflate.trx"));
    expect([...entries.keys()].sort()).toEqual(["dps/weight.float32", "dpv/fa.float32", "header.json", "offsets.uint32", "positions.3.float32"]);
    expect(entries.get("positions.3.float32")!.method).toBe(8);
  });

  for (const name of Object.keys(expected)) {
    it(`reads ${name} as trx-python does`, async () => {
      const info = await openTrxInfo(blob(name));
      expect(info.count).toBe(25);
      const batches: TrkBatch[] = [];
      const n = await readTrx(blob(name), info, (b) => void batches.push(b), { perBatch: 7 });
      expect(n).toBe(25);
      const lines: number[][][] = [];
      const fa: number[][] = [];
      const weight: number[] = [];
      for (const b of batches) {
        for (let s = 0; s + 1 < b.offsets.length; ++s) {
          const line: number[][] = [];
          const values: number[] = [];
          for (let p = b.offsets[s]; p < b.offsets[s + 1]; ++p) {
            line.push([b.points[3 * p], b.points[3 * p + 1], b.points[3 * p + 2]]);
            values.push(b.scalars[p]);
          }
          lines.push(line);
          fa.push(values);
          weight.push(b.properties[s]);
        }
      }
      const want = expected[name];
      expect(lines.map((l) => l.length)).toEqual(want.streamlines.map((l: unknown[]) => l.length));
      lines.forEach((l, s) => l.forEach((p, i) => p.forEach((v, k) => expect(v).toBeCloseTo(want.streamlines[s][i][k], 4))));
      if (want.fa) {
        expect(info.scalars.map((s) => s.name)).toEqual(["fa"]);
        fa.forEach((v, s) => v.forEach((x, i) => expect(x).toBeCloseTo(want.fa[s][i], 5)));
        weight.forEach((x, s) => expect(x).toBeCloseTo(want.weight[s], 5));
      }
    });
  }

  it("serves a .trx as a store whose streamlines and columns the reader gets back", async () => {
    const store = await openTrx(blob("tracks.trx"), "tracks");
    const access = {
      read: async (key: string) => store.get(key),
      listDirectories: async (key: string) => (store.list(`${key}/`) ?? []).filter((n) => n.endsWith("/")).map((n) => n.slice(0, -1)),
      shardIndexes: new ShardIndexCache(),
    };
    const zv = await openZarrVectorsStore(access as never, []);
    const ids = Array.from({ length: 25 }, (_, i) => BigInt(i));
    const curves = await new ObjectReader(access as never, zv.description, zv.levels[0]).readCurves(ids, new AbortController().signal);
    for (let i = 0; i < 25; ++i) {
      const got = Array.from(curves.positions.subarray(3 * curves.offsets[i], 3 * curves.offsets[i + 1]));
      expect(got.length).toBe(expected["tracks.trx"].streamlines[i].length * 3);
      got.forEach((v, k) => expect(v).toBeCloseTo(expected["tracks.trx"].streamlines[i].flat()[k], 4));
    }
    const table = (await readObjectTable(access as never, "0"))!;
    const props = await readSegmentProperties(access as never, "0", table, []);
    expect(props!.properties.map((p) => p.id).sort()).toEqual(["length", "n_points", "weight"]);
    expect(store.list("0/vertex_attributes/")).toEqual(["fa/", "zarr.json"]);
  });
});
