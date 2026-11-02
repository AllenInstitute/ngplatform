/**
 * The virtual streamline store, read by this package's own reader as the
 * viewer and Track filtering read it: every streamline of a .trk or .tck
 * comes back from the chunks (with and without bridges) and whole (`readCurves`), as
 * nibabel reads the file; the coarse level keeps level 0's ids; the object
 * columns list and read; byte ranges and listings answer like a server's.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSegmentProperties } from "../objects.js";
import { LevelPipeline, ObjectReader, openZarrVectorsStore, readObjectTable, ShardIndexCache } from "../reader.js";
import { cellSize, fragmentIndex, StreamlineStore } from "./streamlines.js";
import { openTractogram, openTrk } from "./store_trk.js";
import type { TrkBatch } from "./trk.js";

const DIR = path.resolve(import.meta.dirname, "../../testdata/trk");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));
const trk = (name: string) => new Blob([fs.readFileSync(path.join(DIR, name))]);

/** The reader's store access over a virtual store: reads (with ranges) and listings. */
function access(store: StreamlineStore) {
  return {
    async read(key: string, options: { byteRange?: { offset: number; length: number } | { suffixLength: number } } = {}) {
      const data = await store.get(key);
      if (data === undefined) return undefined;
      const r = options.byteRange;
      if (r === undefined) return data;
      return "suffixLength" in r ? data.subarray(data.length - r.suffixLength) : data.subarray(r.offset, r.offset + r.length);
    },
    async listDirectories(key: string) {
      return (store.list(`${key}/`) ?? []).filter((n) => n.endsWith("/")).map((n) => n.slice(0, -1));
    },
    shardIndexes: new ShardIndexCache(),
  };
}

const signal = new AbortController().signal;

describe("virtual streamline store", () => {
  it("makes fragment indexes as zarr-vectors-py does", () => {
    // One fragment of 5 rows: 16 + 8 + 16 + 4 bytes, the bitmap's first bit set.
    const one = fragmentIndex([5]);
    expect(one.byteLength).toBe(44);
    expect(Array.from(one.subarray(0, 4))).toEqual([0x47, 0x46, 0x56, 0x5a]);
    expect(one[16]).toBe(1);
    expect(fragmentIndex([1, 2, 3, 4, 5, 6, 7]).byteLength).toBe(140);
    expect(fragmentIndex([]).byteLength).toBe(16);
    expect(cellSize(182)).toBe(20);
    expect(cellSize(0)).toBe(16);
  });

  for (const name of Object.keys(expected)) {
    it(`serves ${name} so the reader gets nibabel's streamlines back`, async () => {
      const store = await openTractogram(trk(name), name);
      const a = access(store);
      const zv = await openZarrVectorsStore(a as never, []);
      expect(zv.description.geometryKind).toBe("streamline");
      expect(zv.description.hasObjects).toBe(true);
      expect(zv.axisUnits).toEqual(["m", "m", "m"]);
      const lines: number[][][] = expected[name].streamlines;
      const n = lines.length;
      const totalVertices = lines.reduce((s, l) => s + l.length, 0);

      // Chunk by chunk, as the viewer (bridges) and the region worker (none) read them.
      const root = JSON.parse(new TextDecoder().decode((await store.get("0/vertices/zarr.json"))!));
      const cells: number[][] = root.attributes.nonempty_chunks.map((k: string) => k.split(".").map(Number));
      for (const bridges of [true, false]) {
        const pipeline = new LevelPipeline(a as never, zv.description, zv.levels[0]);
        let vertices = 0;
        let edges = 0;
        for (const cell of cells) {
          const d = (await pipeline.download(cell, signal, { bridges }))!;
          vertices += d.numOwnVertices;
          edges += d.edges.length / 2;
          for (let v = 0; v < d.numOwnVertices; ++v) {
            const id = d.segmentIds[2 * v];
            const p = Array.from(d.positions.subarray(3 * v, 3 * v + 3));
            expect(lines[id].some((q) => q.every((c, k) => Math.abs(Math.fround(c) - p[k]) < 1e-3))).toBe(true);
          }
        }
        expect(vertices).toBe(totalVertices);
        // With bridges every streamline is whole: n - 1 segments each.
        if (bridges) expect(edges).toBe(totalVertices - n);
        else expect(edges).toBeLessThanOrEqual(totalVertices - n);
      }

      // Whole streamlines, in walk order (Track filtering's curves, .trk saving).
      const ids = Array.from({ length: n }, (_, i) => BigInt(i));
      const curves = await new ObjectReader(a as never, zv.description, zv.levels[0]).readCurves(ids, signal);
      expect(curves.ids).toEqual(ids);
      for (let i = 0; i < n; ++i) {
        const got = Array.from(curves.positions.subarray(3 * curves.offsets[i], 3 * curves.offsets[i + 1]));
        const want = lines[i].flat();
        expect(got.length).toBe(want.length);
        got.forEach((v, k) => expect(v).toBeCloseTo(want[k], 3));
      }

      // Object columns: listed and read (Track filtering waits for them).
      const table = (await readObjectTable(a as never, "0"))!;
      expect(table.numObjects).toBe(n);
      const props = await readSegmentProperties(a as never, "0", table, []);
      const names = props!.properties.map((p) => p.id).sort();
      expect(names).toEqual(expected[name].weight ? ["length", "n_points", "weight"] : ["length", "n_points"]);
    });
  }

  it("answers listings and missing keys as a server does", async () => {
    const store = await openTrk(trk("las.trk"), "las");
    expect(store.list("")).toEqual(["0/", "zarr.json"]);
    expect(store.list("0/object_attributes/")).toEqual(["length/", "n_points/", "weight/", "zarr.json"]);
    expect(store.list("0/vertex_attributes/")).toEqual(["fa/", "zarr.json"]);
    expect(store.list("0/nothing/")).toBeUndefined();
    expect(await store.get("0/vertices/c/99/99/99")).toBeUndefined();
    expect(await store.get("2/zarr.json")).toBeUndefined();
  });

  it("adds a coarse level that keeps level 0's ids, for large tractograms", async () => {
    // 25,000 two-point streamlines in batches, ids 0..24999.
    const n = 25_000;
    const store = await StreamlineStore.build({
      scalarNames: [],
      propertyNames: [],
      expectedCount: n,
      extent: 100,
      name: "many",
      async read(onBatch: (b: TrkBatch) => void) {
        for (let start = 0; start < n; start += 5000) {
          const points = new Float32Array(5000 * 6);
          const offsets = new Uint32Array(5001);
          for (let i = 0; i < 5000; ++i) {
            const x = ((start + i) % 100) - 50;
            points.set([x, 0, 0, x + 0.5, 30, 0], 6 * i);
            offsets[i + 1] = 2 * (i + 1);
          }
          onBatch({ points, offsets, scalars: new Float32Array(0), properties: new Float32Array(0) });
        }
        return n;
      },
    });
    const a = access(store);
    const zv = await openZarrVectorsStore(a as never, []);
    expect(zv.levels.length).toBe(2);
    expect(zv.levels[1].vertexCount).toBe(2 * (n / 10));
    const curves = await new ObjectReader(a as never, zv.description, zv.levels[1]).readCurves([0n, 1n, 10n, 24990n], signal);
    expect(curves.ids).toEqual([0n, 10n, 24990n]);
  });
});
