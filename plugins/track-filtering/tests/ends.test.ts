/**
 * Regions that test a track's ends: the ends found chunk by chunk (a
 * fragment's first or last vertex, unless a link carries the line on), and
 * over a tractogram whose streamlines cross many chunks, exactly each
 * streamline's first and last point.
 */
import { describe, expect, it } from "vitest";
import { levelPipeline, openZarrVectorsStore, ShardIndexCache } from "../../zarr-vectors/src/reader.js";
import { StreamlineStore } from "../../zarr-vectors/src/virtual/streamlines.js";
import type { TrkBatch } from "../../zarr-vectors/src/virtual/trk.js";
import { chunkEnds, compactChunk, IdSet, type RoiGeometry, testEnds } from "../roi.js";

const signal = new AbortController().signal;

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

describe("line ends", () => {
  it("are the vertices with one segment, or none (listed twice), counting links", () => {
    // Vertices 0-1-2 one run, 3-4 another whose 4 a link carries on, 5 alone.
    // (A one-vertex fragment with a link in and one out is no end: see below.)
    const positions = Float32Array.from({ length: 18 }, (_, i) => i);
    const ids = Uint32Array.from([1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 3, 0]);
    const geometry = compactChunk(positions, ids, Uint32Array.from([0, 1, 1, 2, 3, 4]));
    const ends = chunkEnds(geometry, new Map([[4, 1]]));
    expect(Array.from(ends.idLow)).toEqual([1, 1, 2, 3, 3]);
    expect(Array.from(ends.positions.subarray(0, 6))).toEqual([0, 1, 2, 6, 7, 8]);
    const counts = new Map<number | bigint, number>();
    const everything: RoiGeometry = { shape: "box", center: [8, 9, 10], radius: 0, size: [20, 20, 20] };
    testEnds(ends, everything, counts);
    expect([...counts]).toEqual([
      [1, 2],
      [2, 1],
      [3, 2],
    ]);
    const hits = new IdSet();
    for (const [key, count] of counts) if (count >= 2) hits.addKey(key);
    expect(Array.from(hits.toArray(), Number)).toEqual([1, 3]);
    // Vertex 5 with a link in and one out: a line passing through, no end.
    expect(Array.from(chunkEnds(geometry, new Map([[4, 1], [5, 2]])).idLow)).toEqual([1, 1, 2]);
  });

  it("over a tractogram crossing many chunks, are each streamline's first and last points", async () => {
    // Random walks across a 100 mm space (10 mm cells), so most cross several chunks.
    const n = 60;
    const lines: number[][] = [];
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; ++i) {
      const p = [random() * 80 - 40, random() * 80 - 40, random() * 80 - 40];
      const d = [random() - 0.5, random() - 0.5, random() - 0.5];
      const line: number[] = [];
      for (let k = 0; k < 20 + Math.floor(random() * 40); ++k) {
        for (let a = 0; a < 3; ++a) d[a] += (random() - 0.5) * 0.3;
        // Steps of 2 mm, shorter than a cell, as a tractogram's are: a link
        // then joins neighbouring chunks, which the reader finds unlisted.
        const length = Math.hypot(d[0], d[1], d[2]) || 1;
        for (let a = 0; a < 3; ++a) p[a] = Math.max(-49, Math.min(49, p[a] + (2 * d[a]) / length));
        line.push(...p);
      }
      lines.push(line);
    }
    const store = await StreamlineStore.build({
      scalarNames: [],
      propertyNames: [],
      expectedCount: n,
      extent: 100,
      name: "walks",
      async read(onBatch: (b: TrkBatch) => void) {
        const points = Float32Array.from(lines.flat());
        const offsets = new Uint32Array(n + 1);
        lines.forEach((l, i) => (offsets[i + 1] = offsets[i] + l.length / 3));
        onBatch({ points, offsets, scalars: new Float32Array(0), properties: new Float32Array(0) });
        return n;
      },
    });
    const a = access(store);
    const zv = await openZarrVectorsStore(a as never, []);
    const level = zv.levels[0];
    const pipeline = levelPipeline(a as never, zv, level);
    const offset = zv.coordinateOffset ?? [0, 0, 0];
    const key = (x: number, y: number, z: number) => [x + offset[0], y + offset[1], z + offset[2]].map((v) => Math.fround(v).toFixed(3)).join(",");
    const found = new Map<number, string[]>();
    let chunks = 0;
    const from = level.chunkShape.map((c, k) => Math.floor(zv.lowerBounds[k] / c));
    const to = level.chunkShape.map((c, k) => Math.floor(zv.upperBounds[k] / c));
    for (let x = from[0]; x <= to[0]; ++x) {
      for (let y = from[1]; y <= to[1]; ++y) {
        for (let z = from[2]; z <= to[2]; ++z) {
          const data = await pipeline.download([x, y, z], signal, { bridges: false });
          if (data === undefined) continue;
          chunks++;
          const geometry = compactChunk(data.positions.subarray(0, data.numVertices * 3), data.segmentIds, data.edges);
          const ends = chunkEnds(geometry, await pipeline.linkedVertices([x, y, z]));
          for (let i = 0; i < ends.idLow.length; ++i) {
            const id = ends.idLow[i];
            if (!found.has(id)) found.set(id, []);
            found.get(id)!.push(key(ends.positions[3 * i], ends.positions[3 * i + 1], ends.positions[3 * i + 2]));
          }
        }
      }
    }
    expect(chunks).toBeGreaterThan(20);
    const want = lines.map((l) => [key(l[0] - offset[0], l[1] - offset[1], l[2] - offset[2]), key(l[l.length - 3] - offset[0], l[l.length - 2] - offset[1], l[l.length - 1] - offset[2])].sort().join(" "));
    const got = [...found.values()].map((e) => e.sort().join(" "));
    expect(got.sort()).toEqual(want.sort());
  });
});
