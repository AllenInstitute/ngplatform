/**
 * The shared image reader on precomputed images served through fetch: each
 * data type it reads (raw, JPEG and compressed_segmentation), the window
 * other types than uint8 are drawn through, boxes of a level, the cap on
 * one read's size, and cancelling a read, in the reader and through its
 * worker's messages.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeChannels } from "neuroglancer/unstable/sliceview/compressed_segmentation/encode_uint32.js";
import { TypedArrayBuilder } from "neuroglancer/unstable/util/array.js";
import { PRECOMPUTED } from "../sources.js";
import { VolumeReader } from "../volume_reader.js";

afterEach(() => vi.unstubAllGlobals());

const BASE = "http://pc.test/";
const STORE = PRECOMPUTED + BASE;
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const signal = () => new AbortController().signal;

/** Serves `files` at BASE, counting the chunk reads; `delay` ms before each answer. */
function serve(files: Map<string, Uint8Array>, delay = 0) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const key = String(url).slice(BASE.length);
    asked.push(key);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    init?.signal?.throwIfAborted();
    const bytes = files.get(key);
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice() as BlobPart);
  });
  return asked;
}

type Encoding = "raw" | "jpeg" | "compressed_segmentation";

/** A voxel's value in the test images, by (x, y, z): 0 to 237. */
const valueAt = (x: number, y: number, z: number) => 100 * z + 10 * y + x;

const WRITE: Record<string, [number, (view: DataView, at: number, v: number) => void]> = {
  uint8: [1, (d, a, v) => d.setUint8(a, v)],
  int8: [1, (d, a, v) => d.setInt8(a, Math.floor(v / 2) - 100)],
  uint16: [2, (d, a, v) => d.setUint16(a, v * 200, true)],
  int16: [2, (d, a, v) => d.setInt16(a, v * 100 - 5000, true)],
  uint32: [4, (d, a, v) => d.setUint32(a, v * 100000, true)],
  int32: [4, (d, a, v) => d.setInt32(a, 1000 - v * 100000, true)],
  float32: [4, (d, a, v) => d.setFloat32(a, v / 4, true)],
  float64: [8, (d, a, v) => d.setFloat64(a, v / 8, true)],
  uint64: [8, (d, a, v) => d.setBigUint64(a, BigInt(v * 3), true)],
};
/** The value the reader should give back for `v`, by type. */
const READ: Record<string, (v: number) => number> = {
  uint8: (v) => v,
  int8: (v) => Math.floor(v / 2) - 100,
  uint16: (v) => v * 200,
  int16: (v) => v * 100 - 5000,
  uint32: (v) => v * 100000,
  int32: (v) => 1000 - v * 100000,
  float32: (v) => v / 4,
  float64: (v) => v / 8,
  uint64: (v) => v * 3,
};

/**
 * A precomputed image of `size` (x, y, z) in chunks of `chunk`, with a
 * second scale at half the size; each chunk stored with `encoding`.
 */
function precomputed(dataType: string, encoding: Encoding, size = [6, 5, 3], chunk = [4, 4, 2]): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const block = encoding === "compressed_segmentation" ? { compressed_segmentation_block_size: [2, 2, 2] } : {};
  const scales = [
    { key: "s0", size, resolution: [8, 8, 40], chunk_sizes: [chunk], encoding, ...block },
    { key: "s1", size: size.map((s) => Math.ceil(s / 2)), resolution: [16, 16, 80], chunk_sizes: [chunk], encoding, ...block },
  ];
  files.set("info", json({ type: "image", data_type: dataType, num_channels: 1, scales }));
  for (const [s, scale] of scales.entries()) {
    const grid = [0, 1, 2].map((k) => Math.ceil(scale.size[k] / chunk[k]));
    for (let cz = 0; cz < grid[2]; ++cz) {
      for (let cy = 0; cy < grid[1]; ++cy) {
        for (let cx = 0; cx < grid[0]; ++cx) {
          const lo = [cx * chunk[0], cy * chunk[1], cz * chunk[2]];
          const ext = [0, 1, 2].map((k) => Math.min(chunk[k], scale.size[k] - lo[k]));
          const n = ext[0] * ext[1] * ext[2];
          const value = (i: number) => {
            const x = lo[0] + (i % ext[0]);
            const y = lo[1] + (Math.floor(i / ext[0]) % ext[1]);
            const z = lo[2] + Math.floor(i / (ext[0] * ext[1]));
            // The coarser scale: the finer one's voxel at twice the position.
            return s === 0 ? valueAt(x, y, z) : valueAt(2 * x, 2 * y, 2 * z);
          };
          let bytes: Uint8Array;
          if (encoding === "jpeg") {
            bytes = JPEG_4x8_120;
          } else if (encoding === "compressed_segmentation") {
            const out = new TypedArrayBuilder(Uint32Array);
            const input = dataType === "uint64" ? BigUint64Array.from({ length: n }, (_, i) => BigInt(value(i) * 3)) : Uint32Array.from({ length: n }, (_, i) => value(i) * 100000);
            encodeChannels(out, [2, 2, 2], input as Uint32Array, [...ext, 1]);
            bytes = new Uint8Array(out.view.slice().buffer);
          } else {
            const [width, write] = WRITE[dataType];
            bytes = new Uint8Array(n * width);
            const view = new DataView(bytes.buffer);
            for (let i = 0; i < n; ++i) write(view, i * width, value(i));
          }
          files.set(`${scale.key}/${[0, 1, 2].map((k) => `${lo[k]}-${lo[k] + ext[k]}`).join("_")}`, bytes);
        }
      }
    }
  }
  return files;
}

/** A 4 × 8 grey JPEG, every pixel 120 (a 4 × 4 × 2 chunk). */
const JPEG_4x8_120 = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAAIAAQBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APP6/9k=",
  ),
  (c) => c.charCodeAt(0),
);

/** The finest scale's values, x fastest, as `READ[type]` gives them. */
function expected(type: string, size = [6, 5, 3]): number[] {
  const out: number[] = [];
  for (let z = 0; z < size[2]; ++z) for (let y = 0; y < size[1]; ++y) for (let x = 0; x < size[0]; ++x) out.push(READ[type](valueAt(x, y, z)));
  return out;
}

const TYPED = { uint8: Uint8Array, int8: Int8Array, uint16: Uint16Array, int16: Int16Array, uint32: Uint32Array, int32: Int32Array, float32: Float32Array, float64: Float64Array } as const;

describe("precomputed images of every type, through the reader", () => {
  it.each([
    ["uint8", "uint8"],
    ["int8", "int8"],
    ["uint16", "uint16"],
    ["int16", "int16"],
    ["uint32", "uint32"],
    ["int32", "int32"],
    ["float32", "float32"],
    ["float64", "float64"],
    ["uint64", "uint32"],
  ] as const)("reads %s values raw (as %s), whole, in a box and at points", async (stored, readAs) => {
    serve(precomputed(stored, "raw"));
    const reader = new VolumeReader();
    const { levels } = await reader.open([STORE], undefined);
    expect(levels.map((l) => l.size)).toEqual([
      [6, 5, 3],
      [3, 3, 2],
    ]);
    expect(levels[0].type).toBe(readAs);
    const { data, type } = await reader.rawVolume(0, signal());
    expect(type).toBe(readAs);
    expect(Array.from(new TYPED[readAs](data.buffer as ArrayBuffer))).toEqual(expected(stored));
    // A box across chunks: x 3..5, y 2..4, z 1.
    const { data: box, size } = await reader.rawRegion(0, { lo: [3, 2, 1], hi: [6, 5, 2] }, signal());
    expect(size).toEqual([3, 3, 1]);
    const want: number[] = [];
    for (let y = 2; y < 5; ++y) for (let x = 3; x < 6; ++x) want.push(Math.fround(READ[stored](valueAt(x, y, 1))));
    expect(Array.from(box)).toEqual(want);
    const at = await reader.rawPoints(0, Float64Array.from([5, 4, 2]), "nearest", signal());
    expect(at[0]).toBe(READ[stored](valueAt(5, 4, 2)));
  });

  it("draws other types than uint8 through the coarsest scale's window, to 0..255", async () => {
    serve(precomputed("float32", "raw"));
    const reader = new VolumeReader();
    await reader.open([STORE], undefined);
    const { data } = await reader.volume(0, signal());
    const raw = expected("float32");
    // The window is the coarsest scale's 0.5th to 99.5th percentile: it rises with the values, and spans 0..255.
    for (let i = 1; i < raw.length; ++i) if (raw[i] > raw[i - 1]) expect(data[i]).toBeGreaterThanOrEqual(data[i - 1]);
    expect(data[0]).toBe(0);
    expect(Math.max(...data)).toBe(255);
    // A box of the level, drawn the same.
    const { data: box } = await reader.volume(0, signal(), undefined, { lo: [1, 1, 1], hi: [3, 2, 2] });
    expect(Array.from(box)).toEqual([data[1 + 6 + 30], data[2 + 6 + 30]]);
  });

  it.each(["uint32", "uint64"] as const)("reads %s values stored as compressed_segmentation", async (stored) => {
    serve(precomputed(stored, "compressed_segmentation"));
    const reader = new VolumeReader();
    await reader.open([STORE], undefined);
    const { data } = await reader.rawVolume(0, signal());
    expect(Array.from(new Uint32Array(data.buffer))).toEqual(expected(stored));
  });

  it("reads uint8 JPEG chunks", async () => {
    serve(precomputed("uint8", "jpeg", [4, 4, 2]));
    const reader = new VolumeReader();
    await reader.open([STORE], undefined);
    const { data } = await reader.rawVolume(0, signal());
    expect(data.length).toBe(32);
    for (const v of data) expect(Math.abs(v - 120)).toBeLessThanOrEqual(1);
  });

  it("refuses what it cannot read, naming it", async () => {
    serve(precomputed("uint16", "jpeg"));
    const reader = new VolumeReader();
    await expect(reader.open([STORE], undefined)).resolves.toBeDefined();
    await expect(reader.rawVolume(0, signal())).rejects.toThrow("a JPEG chunk of uint16 values (JPEG holds uint8 only)");
    serve(precomputed("float32", "compressed_segmentation"));
    const other = new VolumeReader();
    await other.open([STORE], undefined);
    await expect(other.rawVolume(0, signal())).rejects.toThrow(/chunk 0\.0\.0 could not be read: compressed_segmentation of float32 values \(uint32 and uint64 only\)/);
  });
});

describe("the cap on one read", () => {
  it("refuses a level past it, naming the size and the coarser levels that fit", async () => {
    serve(precomputed("uint16", "raw"));
    // Level 0: 6 × 5 × 3 uint16 = 180 bytes; level 1: 3 × 3 × 2 = 36 bytes.
    const reader = new VolumeReader(100);
    expect(reader.maxReadBytes).toBe(100);
    await reader.open([STORE], undefined);
    await expect(reader.rawVolume(0, signal())).rejects.toThrow("Level 0 (6 × 5 × 3 voxels) is 180 bytes, past the 100 bytes one read may take: read a coarser level (level 1 fit)");
    await expect(reader.rawVolume(1, signal())).resolves.toMatchObject({ size: [3, 3, 2] });
    // Drawn 0..255, one byte a voxel: 90 bytes fits.
    await expect(reader.volume(0, signal())).resolves.toMatchObject({ size: [6, 5, 3] });
    // A box of float32s: 4 bytes a voxel.
    await expect(reader.rawRegion(0, { lo: [0, 0, 0], hi: [6, 5, 1] }, signal())).rejects.toThrow("A box of 6 × 5 × 1 voxels of level 0 is 120 bytes, past the 100 bytes one read may take: read a coarser level (level 1 fit) or a smaller box");
    await expect(reader.rawRegion(0, { lo: [0, 0, 0], hi: [5, 5, 1] }, signal())).resolves.toMatchObject({ size: [5, 5, 1] });
  });

  it("allows a gigabyte by default, and says so in gigabytes past it", async () => {
    serve(precomputed("uint8", "raw"));
    const reader = new VolumeReader();
    expect(reader.maxReadBytes).toBe(2 ** 30);
    await reader.open([STORE], undefined);
    await expect(reader.rawRegion(0, { lo: [0, 0, 0], hi: [2048, 2048, 128] }, signal())).rejects.toThrow("A box of 2048 × 2048 × 128 voxels of level 0 is 2.0 GB, past the 1.0 GB one read may take");
  });
});

describe("cancelling a read", () => {
  it("starts no more chunk reads once aborted, and rejects as aborted", async () => {
    // 40 × 40 × 8 in 4 × 4 × 2 chunks: 400 chunks, each answered after 5 ms.
    const asked = serve(precomputed("uint8", "raw", [40, 40, 8]), 5);
    const reader = new VolumeReader();
    await reader.open([STORE], undefined);
    const chunks = () => asked.filter((k) => k.startsWith("s0/")).length;
    const controller = new AbortController();
    const read = reader.rawVolume(0, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 12));
    controller.abort();
    await expect(read).rejects.toThrow(/abort/i);
    const at = chunks();
    expect(at).toBeLessThan(400);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chunks()).toBe(at);
  });

  it("through the worker: a cancel message stops the read, and nothing is answered for it", async () => {
    const asked = serve(precomputed("uint8", "raw", [40, 40, 8]), 5);
    const posted: any[] = [];
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.resetModules();
    await import("../volume_worker.js");
    const send = (data: object) => (globalThis as unknown as { onmessage: (e: { data: object }) => void }).onmessage({ data });
    send({ type: "open", id: 1, stores: [STORE] });
    await vi.waitFor(() => expect(posted.some((m) => m.type === "opened")).toBe(true));
    send({ type: "volume", id: 2, level: 0 });
    await vi.waitFor(() => expect(posted.some((m) => m.type === "progress" && m.id === 2)).toBe(true));
    send({ type: "cancel", id: 2 });
    const at = asked.filter((k) => k.startsWith("s0/")).length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(asked.filter((k) => k.startsWith("s0/")).length).toBeLessThanOrEqual(at + 8);
    expect(at).toBeLessThan(400);
    expect(posted.filter((m) => m.id === 2 && (m.type === "volume" || m.type === "error"))).toEqual([]);
    (globalThis as { onmessage?: unknown }).onmessage = null;
  });
});
