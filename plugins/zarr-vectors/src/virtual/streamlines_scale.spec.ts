/**
 * The streamline store at scale: what it keeps (a spill of cells, an index
 * in memory), how it chooses sample levels while the file streams past
 * (by a hash of the id), and how it reads streamlines by id from the file
 * itself (.trk, .tck, .trx) rather than from its cells.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ObjectReader, openZarrVectorsStore, ShardIndexCache, LevelPipeline } from "../reader.js";
import { cacheBudget, MemorySpill, setSpillSettings, type Spill } from "../../../../src/virtual/vectors/spill.js";
import { CHECKPOINT, cellSize, sampleDepth, sampleLevels, StreamlineStore } from "../../../../src/virtual/vectors/streamlines.js";
import { parseTckHeader, readTck, readTckStreamlines } from "../../../../src/virtual/vectors/tck.js";
import { openTractogram } from "../../../../src/virtual/vectors/tractograms.js";
import { parseTrkHeader, readTrk, readTrkStreamlines, TRK_HEADER_SIZE, type TrkBatch } from "../../../../src/virtual/vectors/trk.js";
import { writeStore } from "./write_store.js";

const DIR = path.resolve(import.meta.dirname, "../../testdata/tractograms");
const expected = { ...JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8")), ...JSON.parse(fs.readFileSync(path.join(DIR, "expected_trx.json"), "utf8")) };
const fileBlob = (name: string) => new Blob([fs.readFileSync(path.join(DIR, name))]);
const signal = new AbortController().signal;

function access(store: StreamlineStore) {
  return {
    async read(key: string, options: { byteRange?: { offset: number; length: number } | { suffixLength: number } } = {}) {
      const data = await store.get(key);
      const r = options.byteRange;
      if (data === undefined || r === undefined) return data;
      return "suffixLength" in r ? data.subarray(data.length - r.suffixLength) : data.subarray(r.offset, r.offset + r.length);
    },
    listDirectories: async (key: string) => (store.list(`${key}/`) ?? []).filter((n) => n.endsWith("/")).map((n) => n.slice(0, -1)),
    shardIndexes: new ShardIndexCache(),
  };
}

/** A small random generator, so the synthetic tractograms are the same each run. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** `n` random-walk streamlines of 5 to 30 points in a 120 mm box, RAS mm. */
function synthetic(n: number, seed = 1): number[][][] {
  const r = random(seed);
  return Array.from({ length: n }, () => {
    const points = 5 + Math.floor(r() * 26);
    let p = [r() * 120 - 60, r() * 120 - 60, r() * 120 - 60];
    let d = [r() - 0.5, r() - 0.5, r() - 0.5];
    const line: number[][] = [];
    for (let i = 0; i < points; ++i) {
      line.push(p.map((v) => Math.fround(v)));
      d = d.map((v) => v + (r() - 0.5) * 0.6);
      const l = Math.hypot(...d) || 1;
      p = p.map((v, k) => v + (3 * d[k]) / l);
    }
    return line;
  });
}

/** A TrackVis v2 file of `lines` (1 mm voxels, identity vox_to_ras, RAS): voxmm = mm + 0.5. */
function trkFile(lines: number[][][]): Blob {
  const header = new ArrayBuffer(1000);
  const view = new DataView(header);
  new Uint8Array(header).set(new TextEncoder().encode("TRACK"), 0);
  [200, 200, 200].forEach((d, k) => view.setInt16(6 + 2 * k, d, true));
  [1, 1, 1].forEach((s, k) => view.setFloat32(12 + 4 * k, s, true));
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((v, i) => view.setFloat32(440 + 4 * i, v, true));
  new Uint8Array(header).set(new TextEncoder().encode("RAS"), 948);
  view.setInt32(988, lines.length, true);
  view.setInt32(992, 2, true);
  view.setInt32(996, 1000, true);
  const parts: ArrayBuffer[] = [header];
  for (const line of lines) {
    const record = new ArrayBuffer(4 + 12 * line.length);
    const r = new DataView(record);
    r.setInt32(0, line.length, true);
    line.forEach((p, i) => p.forEach((v, k) => r.setFloat32(4 + 12 * i + 4 * k, v + 0.5, true)));
    parts.push(record);
  }
  return new Blob(parts);
}

/** An MRtrix .tck of `lines`. */
function tckFile(lines: number[][][]): Blob {
  let text = `mrtrix tracks\ndatatype: Float32LE\ncount: ${lines.length}\nfile: . OFFSET\nEND\n`;
  const offset = text.length + 8;
  text = text.replace("OFFSET", String(offset)).padEnd(offset, "\0");
  const floats: number[] = [];
  for (const line of lines) floats.push(...line.flat(), NaN, NaN, NaN);
  floats.push(Infinity, Infinity, Infinity);
  return new Blob([new TextEncoder().encode(text), new Float32Array(floats)]);
}

/** A spill that counts what is read from it. */
class CountingSpill extends MemorySpill {
  reads = 0;
  bytesRead = 0;
  override read(offset: number, length: number): Uint8Array {
    this.reads++;
    this.bytesRead += length;
    return super.read(offset, length);
  }
}

describe("sample levels chosen while streaming", () => {
  it("keeps about one id in 10, 100, 1000 …, each level a subset of the one before", () => {
    const n = 1_000_000;
    const per = [0, 0, 0, 0, 0];
    for (let id = 0; id < n; ++id) {
      const d = sampleDepth(id, 4);
      for (let k = 0; k <= d; ++k) per[k]++;
      // Nested: an id kept at a level is kept at every finer one, whatever the level count.
      expect(sampleDepth(id, 2)).toBe(Math.min(2, d));
    }
    per.forEach((c, k) => expect(Math.abs(c - n / 10 ** k)).toBeLessThan(5 * Math.sqrt(n / 10 ** k) + 1));
    expect(sampleLevels(20_000)).toBe(0);
    expect(sampleLevels(25_000)).toBe(1);
    expect(sampleLevels(20_000_000)).toBe(4);
  });

  it("gives the same levels whatever the batches", async () => {
    const lines = synthetic(30_000);
    const build = (per: number) =>
      StreamlineStore.build({
        scalarNames: [],
        propertyNames: [],
        expectedCount: lines.length,
        extent: 120,
        name: "s",
        async read(onBatch) {
          for (let first = 0; first < lines.length; first += per) {
            const part = lines.slice(first, first + per);
            const offsets = new Uint32Array(part.length + 1);
            part.forEach((l, i) => (offsets[i + 1] = offsets[i] + l.length));
            await onBatch({ points: Float32Array.from(part.flat(2)), offsets, scalars: new Float32Array(0), properties: new Float32Array(0) });
          }
          return lines.length;
        },
      });
    const [a, b] = await Promise.all([build(997), build(30_000)]);
    expect(a.stats().levels).toEqual(b.stats().levels);
    expect(await a.get("1/object_index/manifests/c/1")).toEqual(await b.get("1/object_index/manifests/c/1"));
    // Level 1 keeps exactly the ids whose hash says so.
    expect(a.stats().levels[1].streamlines).toBe(lines.filter((_, i) => sampleDepth(i, 1) >= 1).length);
  });
});

describe("the spill and the index", () => {
  it("serves a cell by reading only that cell's records, and keeps an index far smaller than the spill", async () => {
    const lines = synthetic(60_000, 7);
    const spill = new CountingSpill();
    const store = await StreamlineStore.build(
      {
        scalarNames: [],
        propertyNames: [],
        expectedCount: lines.length,
        extent: 120,
        name: "s",
        async read(onBatch) {
          const offsets = new Uint32Array(lines.length + 1);
          lines.forEach((l, i) => (offsets[i + 1] = offsets[i] + l.length));
          await onBatch({ points: Float32Array.from(lines.flat(2)), offsets, scalars: new Float32Array(0), properties: new Float32Array(0) });
          return lines.length;
        },
      },
      { spill, cacheBytes: 1 },
    );
    const stats = store.stats();
    const points = lines.reduce((s, l) => s + l.length, 0);
    expect(stats.levels[0].vertices).toBe(points);
    // Points (12 bytes each) are most of the spill; the index is a small part of it.
    expect(stats.spillBytes).toBeGreaterThan(12 * points);
    expect(stats.spillBytes).toBeLessThan(2 * 12 * points);
    expect(stats.indexBytes).toBeLessThan(stats.spillBytes / 20);
    // One cell: the bytes read are that cell's, a small share of the spill.
    const root = JSON.parse(new TextDecoder().decode((await store.get("0/vertices/zarr.json"))!));
    const origin: number[] = root.attributes.chunk_grid_origin;
    const cells: number[][] = root.attributes.nonempty_chunks.map((k: string) => k.split(".").map(Number));
    spill.bytesRead = 0;
    const cell = cells[Math.floor(cells.length / 2)];
    const bytes = (await store.get(`0/vertices/c/${cell.map((c, k) => c - origin[k]).join("/")}`))!;
    expect(spill.bytesRead).toBeLessThan(stats.spillBytes / 10);
    expect(spill.bytesRead).toBeGreaterThanOrEqual(bytes.byteLength - 8);
    // A budget of one byte keeps nothing: asking again reads again, and gives the same.
    const again = (await store.get(`0/vertices/c/${cell.map((c, k) => c - origin[k]).join("/")}`))!;
    expect(again).toEqual(bytes);

    // Every streamline comes back whole from the chunks, with bridges, as the viewer reads them.
    const a = access(store);
    const zv = await openZarrVectorsStore(a as never, []);
    const pipeline = new LevelPipeline(a as never, zv.description, zv.levels[0]);
    let vertices = 0;
    let edges = 0;
    for (const c of cells) {
      const d = (await pipeline.download(c, signal, { bridges: true }))!;
      vertices += d.numOwnVertices;
      edges += d.edges.length / 2;
    }
    expect(vertices).toBe(points);
    expect(edges).toBe(points - lines.length);
    const ids = [0, 1, 17, 59_999].map(BigInt);
    const curves = await new ObjectReader(a as never, zv.description, zv.levels[0]).readCurves(ids, signal);
    ids.forEach((id, i) => {
      const got = Array.from(curves.positions.subarray(3 * curves.offsets[i], 3 * curves.offsets[i + 1]));
      expect(got).toEqual(lines[Number(id)].flat());
    });
    store.close();
  });

  it("chooses smaller cells for a large file, and the decoded-cell budget from the device or the setting", () => {
    expect(cellSize(200)).toBe(20);
    // 6 GB of points in a 200 mm space: cells of about 4 MB.
    expect(cellSize(200, 6e9)).toBe(10);
    expect(cellSize(200, 6e7)).toBe(20);
    expect(cacheBudget()).toBeGreaterThanOrEqual(64 * 2 ** 20);
    expect(cacheBudget()).toBeLessThanOrEqual(512 * 2 ** 20);
    setSpillSettings({ cacheBytes: 3 * 2 ** 20 });
    expect(cacheBudget()).toBe(3 * 2 ** 20);
    setSpillSettings({});
  });

  it("a memory spill reads back what was appended, across its blocks", () => {
    const spill: Spill = new MemorySpill();
    const big = new Uint8Array(33 * 2 ** 20).map((_, i) => i * 7);
    const at = spill.append(new Uint8Array([1, 2, 3]));
    const at2 = spill.append(big);
    expect(at).toBe(0);
    expect(at2).toBe(3);
    expect(spill.size).toBe(3 + big.byteLength);
    expect(spill.read(1, 2)).toEqual(new Uint8Array([2, 3]));
    expect(spill.read(at2 + 32 * 2 ** 20 - 5, 10)).toEqual(big.subarray(32 * 2 ** 20 - 5, 32 * 2 ** 20 + 5));
  });
});

const PYTHON = path.join(os.homedir(), ".conda/envs/zarr-vectors/bin/python");
const hasValidator = fs.existsSync(PYTHON) && spawnSync(PYTHON, ["-c", "import zarr_vectors.validate"]).status === 0;

describe("zarr-vectors-py", () => {
  it.skipIf(!hasValidator)("validates a written copy of a streamline store with sample levels (conformance level 5), and reads its streamlines", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zv-streamlines-"));
    try {
      const lines = synthetic(25_000, 5);
      const store = await openTractogram(trkFile(lines), "s.trk");
      expect(store.stats().levels.length).toBe(2);
      expect(await writeStore(store, dir)).toBeGreaterThan(20);
      const script = [
        "import sys, numpy as np",
        "from zarr_vectors.validate import validate",
        "r = validate(sys.argv[1], level=5)",
        "print(r.summary())",
        "import json",
        "from zarr_vectors.types.polylines import read_polylines",
        "got = read_polylines(sys.argv[1], object_ids=[0, 1, 24999])",
        "print('LINES ' + json.dumps([[int(i), np.concatenate(p).reshape(-1).tolist()] for i, p in zip(got['object_ids'], got['polylines'])]))",
        "sys.exit(0 if r.ok else 1)",
      ].join("\n");
      const run = spawnSync(PYTHON, ["-c", script, dir], { encoding: "utf8" });
      expect(run.stdout + run.stderr).toContain("PASS");
      expect(run.status).toBe(0);
      // zarr-vectors-py reads the streamlines back whole.
      const read: [number, number[]][] = JSON.parse(/^LINES (.*)$/m.exec(run.stdout)![1]);
      expect(read.map(([id]) => id)).toEqual([0, 1, 24999]);
      for (const [id, points] of read) points.forEach((v, k) => expect(v).toBeCloseTo(lines[id].flat()[k], 4));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("streamlines by id, from the file", () => {
  for (const name of Object.keys(expected)) {
    it(`reads ${name}'s streamlines by id as nibabel does, without its cells`, async () => {
      const store = await openTractogram(fileBlob(name), name);
      const lines: number[][][] = expected[name].streamlines;
      const ids = [lines.length - 1, 0, 3, 3, 7];
      const got = (await store.message({ curves: { level: 0, ids } })) as { ids: BigUint64Array; offsets: Uint32Array; positions: Float32Array };
      expect(Array.from(got.ids)).toEqual([0n, 3n, 7n, BigInt(lines.length - 1)]);
      Array.from(got.ids).forEach((id, i) => {
        const want = lines[Number(id)].flat();
        const line = Array.from(got.positions.subarray(3 * got.offsets[i], 3 * got.offsets[i + 1]));
        expect(line.length).toBe(want.length);
        line.forEach((v, k) => expect(v).toBeCloseTo(want[k], 3));
      });
      expect(await store.message({ capabilities: true })).toEqual({ curves: true, stats: true });
    });
  }

  it("finds a .trk's streamlines from checkpoints, and a sample level's points as the level has them", async () => {
    const lines = synthetic(40_000, 3);
    const file = trkFile(lines);
    const header = parseTrkHeader(new Uint8Array(await file.slice(0, TRK_HEADER_SIZE).arrayBuffer()));
    // Every streamline's start, from a read in small slices.
    const starts: number[] = [];
    let end = 0;
    await readTrk(file, header, (b: TrkBatch) => {
      for (let s = 0; s + 1 < b.offsets.length; ++s) starts.push(b.starts![s]);
      end = b.starts![b.offsets.length - 1];
    }, { slice: 4096 });
    expect(starts.length).toBe(lines.length);
    expect(end).toBe(file.size);
    for (const every of [1, CHECKPOINT]) {
      const checkpoints = Float64Array.from([...starts.filter((_, i) => i % every === 0), end]);
      const ids = Uint32Array.from([0, 5, 15, 16, 17, 1000, 39_999]);
      const got = await readTrkStreamlines(file, header, ids, checkpoints, every);
      ids.forEach((id, i) => {
        const line = Array.from(got.points.subarray(3 * got.offsets[i], 3 * got.offsets[i + 1]));
        line.forEach((v, k) => expect(v).toBeCloseTo(lines[id].flat()[k], 4));
      });
    }
    // The store answers a sample level as its cells hold it: only its streamlines, every 4th point and the last.
    const store = await openTractogram(file, "s.trk");
    const a = access(store);
    const zv = await openZarrVectorsStore(a as never, []);
    const members = Array.from({ length: 200 }, (_, i) => i).filter((i) => sampleDepth(i, 1) >= 1);
    const fromFile = (await store.message({ curves: { level: 1, ids: Array.from({ length: 200 }, (_, i) => i) } })) as { ids: BigUint64Array; offsets: Uint32Array; positions: Float32Array };
    expect(Array.from(fromFile.ids)).toEqual(members.map(BigInt));
    const fromCells = await new ObjectReader(a as never, zv.description, zv.levels[1]).readCurves(members.map(BigInt), signal);
    expect(Array.from(fromFile.offsets)).toEqual(Array.from(fromCells.offsets));
    fromFile.positions.forEach((v, k) => expect(v).toBeCloseTo(fromCells.positions[k], 4));
  });

  it("reads a .tck in any slices, with each streamline's start, and finds streamlines from them", async () => {
    const lines = synthetic(3_000, 11);
    const file = tckFile(lines);
    const header = parseTckHeader(new Uint8Array(await file.slice(0, 4096).arrayBuffer()));
    for (const slice of [12, 36, 1200, 1 << 20]) {
      const got: number[][][] = [];
      const starts: number[] = [];
      let end = 0;
      await readTck(file, header, (b) => {
        for (let s = 0; s + 1 < b.offsets.length; ++s) {
          got.push(Array.from({ length: b.offsets[s + 1] - b.offsets[s] }, (_, i) => Array.from(b.points.subarray(3 * (b.offsets[s] + i), 3 * (b.offsets[s] + i + 1)))));
          starts.push(b.starts![s]);
        }
        end = b.starts![b.offsets.length - 1];
      }, { slice });
      expect(got).toEqual(lines);
      // A start is where the streamline's first point is.
      const first = new Float32Array(await file.slice(starts[1234], starts[1234] + 12).arrayBuffer());
      expect(Array.from(first)).toEqual(lines[1234][0]);
      expect(end).toBe(file.size - 12);
      if (slice === 1200) {
        const checkpoints = Float64Array.from([...starts.filter((_, i) => i % CHECKPOINT === 0), end]);
        const ids = Uint32Array.from([0, 31, 32, 2_999]);
        const found = await readTckStreamlines(file, header, ids, checkpoints, CHECKPOINT);
        ids.forEach((id, i) => expect(Array.from(found.points.subarray(3 * found.offsets[i], 3 * found.offsets[i + 1]))).toEqual(lines[id].flat()));
      }
    }
  });
});
