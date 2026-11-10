/**
 * The shared image reader on stores made here and served through fetch:
 * OME-Zarr 0.4 in Zarr v2 (raw, zlib and gzip chunks, both key separators,
 * C and Fortran order, big-endian values, a fill value), images with size-1
 * t and c axes, fill values in the array's own type, a chunk that cannot be
 * read, and the units a store may give its axes; how many chunks are read at
 * once, and range reads inside a shard kept out of the browser's cache.
 */
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply, parseOmeLevels } from "../ome.js";
import { concurrencyFor, fillOf, MAX_CONCURRENT, VolumeReader } from "../volume_reader.js";

afterEach(() => vi.unstubAllGlobals());

const BASE = "http://v2.test/";
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Serves a store's keys at BASE; `fail` answers a key with a server error. */
function serve(files: Map<string, Uint8Array>, fail: (key: string) => boolean = () => false) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const key = String(url).slice(BASE.length);
    asked.push(key);
    if (fail(key)) return new Response(null, { status: 500, statusText: "Server Error" });
    const bytes = files.get(key);
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice() as BlobPart);
  });
  return asked;
}

interface ArrayOptions {
  dtype?: string;
  compressor?: { id: string; level?: number } | null;
  separator?: "." | "/";
  order?: "C" | "F";
  fill?: unknown;
  /** Chunk keys (dot-separated) left out of the store. */
  missing?: string[];
}

/**
 * An OME-Zarr 0.4 group in Zarr v2 with one array, "0", of `shape` (C order
 * of `axes`), chunked as `chunks`, each element `value` of its index.
 */
function v2Store(axes: { name: string; type: string }[], shape: number[], chunks: number[], value: (at: number[]) => number, options: ArrayOptions = {}): Map<string, Uint8Array> {
  const { dtype = "<u2", compressor = null, separator = ".", order = "C", fill = 0, missing = [] } = options;
  const files = new Map<string, Uint8Array>();
  files.set(".zgroup", json({ zarr_format: 2 }));
  files.set(
    ".zattrs",
    json({
      multiscales: [{ version: "0.4", axes, datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: axes.map((a) => (a.type === "space" ? 0.5 : 1)) }] }] }],
    }),
  );
  files.set("0/.zarray", json({ zarr_format: 2, shape, chunks, dtype, compressor, fill_value: fill, order, filters: null, dimension_separator: separator }));
  const width = Number(dtype.slice(2));
  const bigEndian = dtype[0] === ">";
  const grid = shape.map((s, d) => Math.ceil(s / chunks[d]));
  const count = chunks.reduce((a, b) => a * b, 1);
  for (let c = 0; c < grid.reduce((a, b) => a * b, 1); ++c) {
    const index = grid.map((_, d) => Math.floor(c / grid.slice(d + 1).reduce((a, b) => a * b, 1)) % grid[d]);
    if (missing.includes(index.join("."))) continue;
    const bytes = new Uint8Array(count * width);
    const view = new DataView(bytes.buffer);
    for (let e = 0; e < count; ++e) {
      // The element's place in the chunk (C order), and where its bytes go (C or Fortran order).
      const at = chunks.map((_, d) => Math.floor(e / chunks.slice(d + 1).reduce((a, b) => a * b, 1)) % chunks[d]);
      const global = at.map((v, d) => index[d] * chunks[d] + v);
      // Past the array's edge a chunk holds padding.
      const v = global.every((g, d) => g < shape[d]) ? value(global) : 0;
      const place = order === "C" ? e : at.reduceRight((acc, x, d) => acc * chunks[d] + x, 0);
      if (width === 1) view.setUint8(place, v);
      else if (dtype.endsWith("f4")) view.setFloat32(place * 4, v, !bigEndian);
      else view.setUint16(place * 2, v, !bigEndian);
    }
    const stored = compressor?.id === "zlib" ? zlib.deflateSync(bytes) : compressor?.id === "gzip" ? zlib.gzipSync(bytes) : bytes;
    files.set(`0/${index.join(separator)}`, new Uint8Array(stored));
  }
  return files;
}

const ZYX = [
  { name: "z", type: "space" },
  { name: "y", type: "space" },
  { name: "x", type: "space" },
];
/** A voxel's value in the test images, by (x, y, z). */
const valueAt = (x: number, y: number, z: number) => 100 * z + 10 * y + x;
const signal = () => new AbortController().signal;

describe("OME-Zarr 0.4 in Zarr v2", () => {
  // z, y, x = 3, 5, 6 in 2 × 2 × 4 chunks: a 2 × 3 × 2 grid, so a chunk key read in the wrong order is another chunk.
  const shape = [3, 5, 6];
  const chunks = [2, 2, 4];
  const expected = (fill: number) => {
    const out: number[] = [];
    for (let z = 0; z < 3; ++z) for (let y = 0; y < 5; ++y) for (let x = 0; x < 6; ++x) out.push(z >= 2 && y >= 4 && x >= 4 ? fill : valueAt(x, y, z));
    return out;
  };

  it.each<[string, ArrayOptions]>([
    ["raw, keys 0.1.2", {}],
    ["zlib, keys 0/1/2", { compressor: { id: "zlib", level: 1 }, separator: "/" }],
    ["gzip", { compressor: { id: "gzip", level: 5 } }],
    ["Fortran order", { order: "F" }],
    ["Fortran order, keys 0/1/2", { order: "F", separator: "/" }],
    ["big-endian", { dtype: ">u2" }],
  ])("reads %s, a missing chunk as the fill value", async (_, options) => {
    serve(v2Store(ZYX, shape, chunks, ([z, y, x]) => valueAt(x, y, z), { ...options, fill: 7, missing: ["1.2.1"] }));
    const reader = new VolumeReader();
    const { levels } = await reader.open([BASE], undefined);
    expect(levels[0]).toMatchObject({ size: [6, 5, 3], type: "uint16" });
    apply(levels[0].voxelToRas, [2, 1, 1]).forEach((v, k) => expect(v).toBeCloseTo([1, 0.5, 0.5][k], 12));
    const { data, type, fill } = await reader.rawVolume(0, signal());
    expect({ type, fill }).toEqual({ type: "uint16", fill: 7 });
    expect(Array.from(new Uint16Array(data.buffer))).toEqual(expected(7));
    const { data: box } = await reader.rawRegion(0, { lo: [3, 1, 0], hi: [6, 5, 3] }, signal());
    expect(Array.from(box)).toEqual(expected(7).filter((_, i) => i % 6 >= 3 && Math.floor(i / 6) % 5 >= 1));
  });

  it("reads a v2 store's float32 values", async () => {
    serve(v2Store(ZYX, [2, 2, 2], [2, 2, 2], ([z, y, x]) => valueAt(x, y, z) / 4, { dtype: "<f4", compressor: { id: "zlib", level: 1 } }));
    const reader = new VolumeReader();
    await reader.open([BASE], undefined);
    const points = Float64Array.from([1, 1, 1, 0, 1, 0]);
    expect(Array.from(await reader.rawPoints(0, points, "nearest", signal()))).toEqual([111 / 4, 10 / 4]);
  });
});

describe("images with size-1 t and c axes", () => {
  const TCZYX = [{ name: "t", type: "time" }, { name: "c", type: "channel" }, ...ZYX];

  it("reads tczyx with t = c = 1 as the 3-D image, chunked 1 or thicker along t", async () => {
    for (const chunks of [
      [1, 1, 2, 2, 4],
      [2, 1, 2, 2, 4],
    ]) {
      serve(v2Store(TCZYX, [1, 1, 3, 5, 6], chunks, ([, , z, y, x]) => valueAt(x, y, z)));
      const reader = new VolumeReader();
      const { levels } = await reader.open([BASE], undefined);
      expect(levels[0]).toMatchObject({ axes: ["z", "y", "x"], shape: [3, 5, 6], chunk: [2, 2, 4], size: [6, 5, 3] });
      apply(levels[0].voxelToRas, [2, 1, 1]).forEach((v, k) => expect(v).toBeCloseTo([1, 0.5, 0.5][k], 12));
      const { data } = await reader.rawVolume(0, signal());
      const want: number[] = [];
      for (let z = 0; z < 3; ++z) for (let y = 0; y < 5; ++y) for (let x = 0; x < 6; ++x) want.push(valueAt(x, y, z));
      expect(Array.from(new Uint16Array(data.buffer))).toEqual(want);
    }
  });

  it("refuses several channels or time points where one 3-D image is needed", async () => {
    serve(v2Store(TCZYX, [1, 3, 2, 2, 2], [1, 1, 2, 2, 2], () => 1));
    await expect(new VolumeReader().open([BASE], undefined)).rejects.toThrow("has 3 channels; a single 3-D image (one time point, one channel) is needed");
    serve(v2Store(TCZYX, [4, 1, 2, 2, 2], [1, 1, 2, 2, 2], () => 1));
    await expect(new VolumeReader().open([BASE], undefined)).rejects.toThrow("has 4 time points");
  });

  it("refuses images that are not 3-D in space", () => {
    const group = (axes: { name: string; type: string }[]) => ({ multiscales: [{ axes, datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: axes.map(() => 1) }] }] }] });
    expect(() => parseOmeLevels(BASE, group(ZYX.slice(1)))).toThrow("the image's axes are y, x; a 3-D image (x, y and z) is needed");
    expect(() => parseOmeLevels(BASE, group([{ name: "w", type: "space" }, ...ZYX]))).toThrow("a 3-D image");
    expect(parseOmeLevels(BASE, group([{ name: "c", type: "channel" }, ...ZYX])).levels[0].axes).toEqual(["c", "z", "y", "x"]);
  });
});

describe("fill values", () => {
  it("holds a fill value as the array's type does", () => {
    expect(fillOf(-1, "uint8")).toBe(255);
    expect(fillOf(1.7, "int16")).toBe(1);
    expect(fillOf(70000, "uint16")).toBe(70000 - 65536);
    expect(fillOf("0x3f800000", "float32")).toBe(1);
    expect(fillOf("NaN", "float32")).toBeNaN();
    expect(fillOf(null, "float64")).toBe(0);
  });

  it("draws a missing chunk's fill through the image's window, not wrapped into a byte", async () => {
    // Values 0..1700 in 2 × 2 × 2 chunks, one missing; the fill, 3000, is above the window.
    serve(v2Store(ZYX, [2, 4, 4], [2, 2, 2], ([z, y, x]) => 100 * (z * 8 + y * 2 + x), { fill: 3000, missing: ["0.1.1"] }));
    const reader = new VolumeReader();
    await reader.open([BASE], undefined);
    const { data } = await reader.volume(0, signal());
    // Voxel (3, 3, 0) is in the missing chunk: drawn as the top of the window (3000 % 256 would be 184).
    expect(data[3 + 4 * 3]).toBe(255);
    const { data: raw } = await reader.rawRegion(0, { lo: [3, 3, 0], hi: [4, 4, 1] }, signal());
    expect(Array.from(raw)).toEqual([3000]);
  });
});

describe("a chunk that cannot be read", () => {
  it("fails the read, naming the chunk, starts no more reads, and is read again next time", async () => {
    const files = v2Store(ZYX, [4, 8, 8], [1, 2, 2], ([z, y, x]) => valueAt(x, y, z));
    let broken = true;
    const asked = serve(files, (key) => broken && key === "0/0.1.0");
    // Chunks of 8 bytes, read 8 at a time.
    const reader = new VolumeReader(undefined, 64);
    await reader.open([BASE], undefined);
    const chunkReads = () => asked.filter((k) => /^0\/\d/.test(k)).length;
    const opened = chunkReads();
    await expect(reader.rawVolume(0, signal())).rejects.toThrow(`${BASE}0: chunk 0.1.0 could not be read: ${BASE}0/0.1.0: 500 Server Error`);
    // The chunks already under way (8 at a time) finish; none of the 64 is started after the error.
    const after = chunkReads();
    expect(after - opened).toBeLessThan(16);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunkReads()).toBe(after);
    // Not kept as failed: once the store answers, the chunk reads.
    broken = false;
    const { data } = await reader.volume(0, signal(), undefined, { lo: [0, 2, 0], hi: [2, 4, 1] });
    expect(data.length).toBe(4);
  });
});

describe("chunks read at once", () => {
  it("reads up to 32 small chunks at once, and big ones as many as fit in the bytes allowed", () => {
    expect(concurrencyFor(64 ** 3)).toBe(MAX_CONCURRENT);
    expect(concurrencyFor(192 ** 3)).toBe(18);
    expect(concurrencyFor(256 ** 3 * 4)).toBe(2);
    expect(concurrencyFor(512 ** 3)).toBe(1);
    expect(concurrencyFor(2 * 512 ** 3)).toBe(1);
  });

  /** Serves `files` slowly, counting the chunk reads under way at once. */
  function serveSlowly(files: Map<string, Uint8Array>) {
    const seen = { now: 0, peak: 0, reads: 0 };
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const key = String(url).slice(BASE.length);
      const chunk = /^0\/\d/.test(key);
      if (chunk) {
        seen.peak = Math.max(seen.peak, ++seen.now);
        ++seen.reads;
        await new Promise((resolve) => setTimeout(resolve, 2));
        --seen.now;
      }
      const bytes = files.get(key);
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice() as BlobPart);
    });
    return seen;
  }

  it("keeps small chunks to 32 at once", async () => {
    // 2 × 2 × 2 chunks of uint16 (16 bytes): 256 of them.
    const seen = serveSlowly(v2Store(ZYX, [8, 16, 16], [2, 2, 2], ([z, y, x]) => valueAt(x, y, z)));
    const reader = new VolumeReader();
    await reader.open([BASE], undefined);
    seen.peak = 0;
    seen.reads = 0;
    const { data } = await reader.rawVolume(0, signal());
    expect(new Uint16Array(data.buffer)[16 * 16 * 3 + 16 * 5 + 7]).toBe(valueAt(7, 5, 3));
    expect(seen.reads).toBe(256);
    expect(seen.peak).toBe(MAX_CONCURRENT);
  });

  it("keeps big chunks within the bytes allowed at once, in every kind of read", async () => {
    // 4 × 4 × 4 chunks of uint16 (128 bytes), 512 bytes allowed: 4 at once.
    const seen = serveSlowly(v2Store(ZYX, [8, 16, 16], [4, 4, 4], ([z, y, x]) => valueAt(x, y, z)));
    const reader = new VolumeReader(undefined, 512);
    await reader.open([BASE], undefined);
    const reads: [string, () => Promise<unknown>][] = [
      ["volume", () => reader.volume(0, signal())],
      ["rawVolume", () => reader.rawVolume(0, signal())],
      ["rawRegion", () => reader.rawRegion(0, { lo: [0, 0, 0], hi: [16, 16, 8] }, signal())],
      ["eachRawChunk", () => reader.eachRawChunk(0, signal(), () => {})],
      ["rawPoints", () => reader.rawPoints(0, Float64Array.from({ length: 96 }, (_, i) => [i % 16, (i * 7) % 16, i % 8][i % 3]), "nearest", signal())],
    ];
    for (const [name, read] of reads) {
      // Read afresh: rawVolume and the others do not keep chunks, volume does (cleared by opening again).
      await reader.open([BASE], undefined);
      seen.peak = 0;
      await read();
      expect([name, seen.peak]).toEqual([name, 4]);
    }
  });
});

/**
 * An OME-Zarr 0.5 store (Zarr v3) of one 4 × 4 × 4 uint8 array in a single
 * shard of 2 × 2 × 2 chunks, its index at the end; each voxel `value` of its
 * x, y, z.
 */
function shardedStore(value: (x: number, y: number, z: number) => number): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set(
    "zarr.json",
    json({
      zarr_format: 3,
      node_type: "group",
      attributes: { ome: { version: "0.5", multiscales: [{ axes: ZYX, datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1] }] }] }] } },
    }),
  );
  files.set(
    "0/zarr.json",
    json({
      zarr_format: 3,
      node_type: "array",
      shape: [4, 4, 4],
      data_type: "uint8",
      chunk_grid: { name: "regular", configuration: { chunk_shape: [4, 4, 4] } },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: 0,
      codecs: [{ name: "sharding_indexed", configuration: { chunk_shape: [2, 2, 2], codecs: [{ name: "bytes" }], index_codecs: [{ name: "bytes", configuration: { endian: "little" } }], index_location: "end" } }],
      dimension_names: ["z", "y", "x"],
    }),
  );
  const shard = new Uint8Array(8 * 8 + 8 * 16);
  const index = new DataView(shard.buffer, 64);
  for (let c = 0; c < 8; ++c) {
    const [cz, cy, cx] = [c >> 2, (c >> 1) & 1, c & 1];
    for (let e = 0; e < 8; ++e) shard[8 * c + e] = value(2 * cx + (e & 1), 2 * cy + ((e >> 1) & 1), 2 * cz + (e >> 2));
    index.setBigUint64(16 * c, BigInt(8 * c), true);
    index.setBigUint64(16 * c + 8, 8n, true);
  }
  files.set("0/c/0/0/0", shard);
  return files;
}

describe("range reads", () => {
  it("reads ranges inside a shard past the browser's cache, and whole keys through it", async () => {
    const files = shardedStore((x, y, z) => 16 * z + 4 * y + x);
    const asked: { key: string; range?: string; cache?: RequestCache }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const key = String(url).slice(BASE.length);
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      asked.push({ key, range, cache: init?.cache });
      const bytes = files.get(key);
      if (bytes === undefined) return new Response(null, { status: 404 });
      if (range === undefined) return new Response(bytes.slice() as BlobPart);
      const [, a, b] = /^bytes=(\d*)-(\d*)$/.exec(range)!;
      const start = a === "" ? bytes.length - Number(b) : Number(a);
      const end = a === "" ? bytes.length : Math.min(bytes.length, Number(b) + 1);
      return new Response(bytes.slice(start, end) as BlobPart, { status: 206, headers: { "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}` } });
    });
    const reader = new VolumeReader();
    await reader.open([BASE], undefined);
    const { data } = await reader.rawVolume(0, signal());
    expect(Array.from(data)).toEqual(Array.from({ length: 64 }, (_, i) => i));
    const ranged = asked.filter((r) => r.range !== undefined);
    // The shard's index and its chunks.
    expect(ranged.length).toBeGreaterThanOrEqual(2);
    expect(ranged.every((r) => r.key === "0/c/0/0/0" && r.cache === "no-store")).toBe(true);
    const whole = asked.filter((r) => r.range === undefined);
    expect(whole.map((r) => r.key)).toContain("0/zarr.json");
    expect(whole.every((r) => r.cache === undefined)).toBe(true);
  });
});

describe("units", () => {
  // Å twice: the letter, and the Ångström sign, which looks the same.
  it.each([
    ["centimeter", 0.1],
    ["cm", 0.1],
    ["angstrom", 1e7],
    ["\u00c5", 1e7],
    ["\u212b", 1e7],
    ["micrometer", 1000],
  ])("reads %s", (unit, scale) => {
    const axes = ZYX.map((a) => ({ ...a, unit }));
    const level = parseOmeLevels(BASE, { multiscales: [{ axes, datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [scale, scale, scale] }] }] }] }).levels[0];
    expect(level.voxelSize).toBeCloseTo(1, 9);
  });
});

describe("errors", () => {
  it("names the reader's limits, not a removed tool", async () => {
    const files = v2Store(ZYX, [2, 2, 2], [2, 2, 2], () => 1);
    files.set(".zattrs", json({ ...JSON.parse(new TextDecoder().decode(files.get(".zattrs"))), ngplatform: { rendering: "rgb" } }));
    serve(files);
    await expect(new VolumeReader().open([BASE], undefined)).rejects.toThrow(`${BASE}: a colour (RGB) image; the image reader reads one value per voxel`);
    serve(new Map());
    await expect(new VolumeReader().open([BASE], undefined)).rejects.toThrow("no zarr.json or .zattrs");
  });
});
