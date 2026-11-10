/**
 * The one cache of decoded image chunks all the tools share: within its
 * bytes, read once however many ask, a pass over a level kept out of it;
 * readers in one worker sharing it; and the image chunk worker serving the
 * tools' workers over ports, each tool keeping no chunks of its own.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cache as workerCache, serve as serveChunks } from "../image_chunk_worker.js";
import { ChunkCache, chunkSource, LocalChunks, useChunkPort } from "../shared_chunks.js";
import { VolumeReader } from "../volume_reader.js";

afterEach(() => {
  useChunkPort(undefined);
  vi.unstubAllGlobals();
});

const BASE = "http://shared.test/";
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const signal = () => new AbortController().signal;
/** Two arrays' bytes the same (a deep comparison of millions of elements is too slow to run). */
const same = (a: ArrayBufferView, b: ArrayBufferView) => Buffer.compare(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) === 0;

/** An OME-Zarr 0.4 store of one uint8 array of n³ voxels in c³ chunks, each voxel (x + y + z) mod 256. */
function store(n: number, c: number): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const axes = ["z", "y", "x"].map((name) => ({ name, type: "space", unit: "micrometer" }));
  files.set(".zgroup", json({ zarr_format: 2 }));
  files.set(".zattrs", json({ multiscales: [{ version: "0.4", axes, datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1] }] }] }] }));
  files.set("0/.zarray", json({ zarr_format: 2, shape: [n, n, n], chunks: [c, c, c], dtype: "|u1", compressor: null, fill_value: 0, order: "C", filters: null }));
  const g = n / c;
  for (let a = 0; a < g; ++a)
    for (let b = 0; b < g; ++b)
      for (let d = 0; d < g; ++d) {
        const bytes = new Uint8Array(c * c * c);
        for (let i = 0, z = 0; z < c; ++z) for (let y = 0; y < c; ++y) for (let x = 0; x < c; ++x) bytes[i++] = (a * c + z + b * c + y + d * c + x) & 255;
        files.set(`0/${a}.${b}.${d}`, bytes);
      }
  return files;
}

/** Serves `files` at BASE, counting chunk reads. */
function serve(files: Map<string, Uint8Array>) {
  const seen = { chunks: 0 };
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const key = String(url).slice(BASE.length);
    if (/^0\/\d/.test(key)) ++seen.chunks;
    const bytes = files.get(key);
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice() as BlobPart);
  });
  return seen;
}

describe("the chunk cache", () => {
  it("stays within its bytes, the least recently used out first", async () => {
    const cache = new ChunkCache(1 << 20);
    const chunk = () => Promise.resolve(new Uint8Array(64 << 10));
    for (let i = 0; i < 10_000; ++i) {
      await cache.get(`k${i}`, chunk);
      if (i % 10 === 0) await cache.get("k0", () => Promise.reject(new Error("k0 is kept: not read again")));
      expect(cache.bytes).toBeLessThanOrEqual(1 << 20);
    }
    expect(cache.size).toBe(15);
    // k0, used every 10 reads (fewer than the 15 that fit), is still there; k1 went long ago.
    await expect(cache.get("k0", () => Promise.reject(new Error("read again")))).resolves.toBeDefined();
    let read = false;
    await cache.get("k1", async () => ((read = true), undefined));
    expect(read).toBe(true);
  });

  it("reads a chunk once for everyone who asks while it is read, and a pass over a level keeps none", async () => {
    const cache = new ChunkCache();
    let loads = 0;
    const load = () => new Promise<Uint8Array>((resolve) => setTimeout(() => resolve(new Uint8Array(++loads)), 5));
    const [a, b] = await Promise.all([cache.get("x", load, false), cache.get("x", load, false)]);
    expect(loads).toBe(1);
    expect(a).toBe(b);
    expect(cache.size).toBe(0);
    // Asked to be kept by one of two at once: kept.
    await Promise.all([cache.get("y", load, false), cache.get("y", load, true)]);
    expect(cache.size).toBe(1);
  });

  it("keeps no failed read, and forgets a level opened again", async () => {
    const cache = new ChunkCache();
    await expect(cache.get("s/0|1", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(cache.size).toBe(0);
    await cache.get("s/0|1", async () => new Uint8Array(4));
    await cache.get("s/1|1", async () => new Uint8Array(4));
    cache.forget("s/0|");
    expect(cache.size).toBe(1);
  });
});

describe("tools reading one image", () => {
  // 256³ voxels in 64³ chunks: 64 chunks, 16 MB.
  const files = store(256, 64);

  it("in one worker: three readers read each chunk once, and hold it once", async () => {
    const seen = serve(files);
    const shared = chunkSource() as LocalChunks;
    const readers = [new VolumeReader(), new VolumeReader(), new VolumeReader()];
    for (const r of readers) await r.open([BASE], undefined);
    const out = [];
    for (const r of readers) out.push((await r.volume(0, signal())).data);
    // Before: each reader its own cache (256 MB each), so 192 chunk reads and 48 MB held.
    expect(seen.chunks).toBe(64);
    expect(shared.cache.bytes).toBeLessThan(16.1 * 2 ** 20);
    expect(same(out[1], out[0]) && same(out[2], out[0])).toBe(true);
    expect(out[0][1 + 256 * (2 + 256 * 3)]).toBe(6);
  });

  it("through the chunk worker: tools keep no chunks, and a chunk is read once for all of them", async () => {
    const seen = serve(files);
    // The page's part: a port to the chunk worker (here, in this thread).
    const { port1, port2 } = new MessageChannel();
    serveChunks(port1);
    useChunkPort(port2);
    const local = new LocalChunks();
    const readers = [new VolumeReader(), new VolumeReader()];
    for (const r of readers) await r.open([BASE], undefined);
    const box = { lo: [10, 20, 30] as [number, number, number], hi: [140, 150, 160] as [number, number, number] };
    const a = await readers[0].rawRegion(0, box, signal());
    const b = await readers[1].rawRegion(0, box, signal());
    expect(same(b.data, a.data)).toBe(true);
    expect(a.data[0]).toBe(60);
    // The box touches 27 chunks: read once, kept by the chunk worker only.
    expect(seen.chunks).toBe(27);
    expect(workerCache.size).toBe(27);
    expect(local.cache.size).toBe(0);
    // A pass over the whole level reads what is not kept and keeps nothing more.
    await readers[0].rawVolume(0, signal());
    expect(seen.chunks).toBe(64);
    expect(workerCache.size).toBe(27);
    port1.close();
  });

  it("when the chunk worker stops, reads waiting on it fail and later ones are read here", async () => {
    serve(files);
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {}; // a chunk worker that never answers
    useChunkPort(port2);
    const reader = new VolumeReader();
    await expect(
      (async () => {
        const opened = reader.open([BASE], undefined);
        await opened;
        const read = reader.volume(0, signal(), undefined, { lo: [0, 0, 0], hi: [4, 4, 4] });
        await new Promise((resolve) => setTimeout(resolve, 5));
        useChunkPort(undefined);
        return read;
      })(),
    ).rejects.toThrow("the image chunk reader stopped");
    const again = new VolumeReader();
    await again.open([BASE], undefined);
    const { data } = await again.volume(0, signal(), undefined, { lo: [0, 0, 0], hi: [2, 1, 1] });
    expect(Array.from(data)).toEqual([0, 1]);
    port1.close();
  });
});

describe("the page's side", () => {
  it("starts one chunk worker, gives each tool's worker a port to it first, and tells them when it stops", async () => {
    const { withSharedChunks, stopSharedChunks } = await import("../chunk_host.js");
    const { CHUNK_PORT } = await import("../shared_chunks.js");
    const fake = () => {
      const posted: any[] = [];
      return { posted, postMessage: (m: any) => posted.push(m), terminate() {} } as unknown as Worker & { posted: any[]; onerror: (e: unknown) => void };
    };
    const host = fake();
    let started = 0;
    const start = () => (++started, host);
    const tools = [fake(), fake()];
    for (const t of tools) expect(withSharedChunks(t, start)).toBe(t);
    expect(started).toBe(1);
    expect(host.posted.map((m) => m.type)).toEqual(["connect", "connect"]);
    for (const t of tools) expect(t.posted[0]).toMatchObject({ type: CHUNK_PORT });
    host.onerror({ preventDefault() {} });
    for (const t of tools) expect(t.posted[1]).toEqual({ type: CHUNK_PORT, port: undefined });
    for (const m of [...host.posted, ...tools.flatMap((t) => t.posted)]) m.port?.close();
    stopSharedChunks();
  });
});
