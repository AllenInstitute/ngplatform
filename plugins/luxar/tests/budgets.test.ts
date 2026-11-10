/**
 * Luxar's bounds at scale: the reading worker's queue cancels reads no
 * longer wanted (./read_queue.ts), and the layers' GPU copies share one
 * budget per context (./gpu_pool.ts): a layer not drawn for a while gives
 * its copies up, and past the budget an upload is refused and said.
 */
import { describe, expect, it } from "vitest";
import type { BuiltChunk } from "../chunk_build.js";
import { type ChunkSource, GpuChunks } from "../chunks.js";
import { GpuPool, STALE_MS } from "../gpu_pool.js";
import { ReadQueue } from "../read_queue.js";
import type { GpuChunk, Renderer } from "../render_gl.js";

describe("the reading worker's queue", () => {
  /** Reads that wait until the test ends them, or until they are cancelled. */
  function reads() {
    const started: string[] = [];
    const aborted: string[] = [];
    const finish = new Map<string, () => void>();
    const read = (key: string, _scalar: string, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        started.push(key);
        finish.set(key, resolve);
        signal.addEventListener("abort", () => {
          aborted.push(key);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    return { read, started, aborted, finish };
  }

  it("cancels a read in flight that the new list no longer names, freeing its slot at once", async () => {
    const r = reads();
    const queue = new ReadQueue(r.read, 2);
    queue.want(["0|0.0.0", "0|1.0.0", "0|2.0.0"], "none");
    expect(r.started).toEqual(["0|0.0.0", "0|1.0.0"]);
    // The view moved: the first two are out of view.
    queue.want(["0|2.0.0", "0|3.0.0"], "none");
    expect(r.aborted).toEqual(["0|0.0.0", "0|1.0.0"]);
    expect(r.started).toEqual(["0|0.0.0", "0|1.0.0", "0|2.0.0", "0|3.0.0"]);
    expect(queue.inFlight).toBe(2);
    // One still wanted is not read twice, nor cancelled.
    queue.want(["0|3.0.0"], "none");
    expect(r.aborted).toEqual(["0|0.0.0", "0|1.0.0", "0|2.0.0"]);
    expect(r.started.filter((k) => k === "0|3.0.0").length).toBe(1);
    r.finish.get("0|3.0.0")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.inFlight).toBe(0);
  });

  it("cancels reads for another scalar, and everything when another store opens", () => {
    const r = reads();
    const queue = new ReadQueue(r.read, 6);
    queue.want(["0|0.0.0"], "none");
    queue.want(["0|0.0.0"], "attribute:fa");
    expect(r.aborted).toEqual(["0|0.0.0"]);
    expect(r.started).toEqual(["0|0.0.0", "0|0.0.0"]);
    queue.cancelAll();
    expect(r.aborted.length).toBe(2);
    expect(queue.inFlight).toBe(0);
    expect(queue.queued).toBe(0);
  });
});

describe("one GPU budget shared by the layers", () => {
  const MB = 1024 * 1024;
  /** A built chunk of about `mb` MB on the GPU. */
  const chunk = (mb: number) =>
    ({ vertices: new Float32Array((mb * MB) / 4), slots: new Uint8Array(0), segmentCount: 0, normals: new Float32Array(0), triangles: new Uint32Array(0) }) as unknown as BuiltChunk;
  /** A layer's chunks, all here; and a renderer that counts what is on the GPU. */
  function layer(keys: string[], mb: number): ChunkSource {
    const built = new Map(keys.map((k) => [k, chunk(mb)]));
    return { get: (k) => built.get(k), has: (k) => built.has(k), generation: 0 };
  }
  function gpu() {
    const live = new Set<GpuChunk>();
    const r = {
      upload: (c: BuiltChunk) => {
        const gpu = { bytes: c.vertices.byteLength } as GpuChunk;
        live.add(gpu);
        return gpu;
      },
      release: (gpu: GpuChunk) => void live.delete(gpu),
      shade: () => {},
    };
    return { renderer: r as unknown as Renderer, live };
  }

  it("takes the copies of a layer not drawn lately for one that needs room", () => {
    const { renderer, live } = gpu();
    const pool = new GpuPool("test", 100 * MB);
    const keys = ["a", "b", "c", "d"];
    const hidden = new GpuChunks(renderer, layer(keys, 20), 1024 * MB, pool);
    hidden.take(keys);
    expect(pool.total).toBe(80 * MB);
    // Hidden since: not drawn for longer than STALE_MS.
    hidden.lastDrawn -= 2 * STALE_MS;
    const shown = new GpuChunks(renderer, layer(keys, 20), 1024 * MB, pool);
    const { chunks } = shown.take(keys);
    expect(chunks.length).toBe(4);
    expect(shown.refused).toBe(false);
    expect(hidden.gpuBytes).toBe(0);
    expect(pool.total).toBe(80 * MB);
    expect(live.size).toBe(4);
  });

  it("refuses past the budget while every layer is drawn, and says so", () => {
    const { renderer } = gpu();
    const pool = new GpuPool("test", 100 * MB);
    const keys = ["a", "b", "c", "d"];
    const first = new GpuChunks(renderer, layer(keys, 20), 1024 * MB, pool);
    const second = new GpuChunks(renderer, layer([...keys, "e"], 20), 1024 * MB, pool);
    first.take(keys);
    const { chunks } = second.take(keys);
    // 80 MB in use and drawn: one more 20 MB copy fits, the rest is refused.
    expect(chunks.length).toBe(1);
    expect(second.refused).toBe(true);
    expect(pool.total).toBeLessThanOrEqual(100 * MB);
    expect(first.gpuBytes).toBe(80 * MB);
    // Its own copies not drawn now make room first: its view moved on to another chunk.
    const own = second.take(["e"]);
    expect(own.chunks.length).toBe(1);
    expect(second.refused).toBe(false);
    expect(second.gpuBytes).toBe(20 * MB);
    expect(pool.total).toBe(100 * MB);
  });

  it("frees every copy and leaves the pool when disposed", () => {
    const { renderer, live } = gpu();
    const pool = new GpuPool("test", 100 * MB);
    const a = new GpuChunks(renderer, layer(["a"], 10), 1024 * MB, pool);
    a.take(["a"]);
    expect(pool.size).toBe(1);
    a.dispose();
    expect(live.size).toBe(0);
    expect(pool.size).toBe(0);
    expect(pool.total).toBe(0);
  });

  it("bounds every layer together: before, about 2.1 GB each; now 1.75 GB in all, however many", async () => {
    const { POOL_3D } = await import("../gpu_pool.js");
    const { POOL_2D_BYTES } = await import("../shared2d.js");
    // Before: per layer 768 + 512 MB in the 3-D view and 512 + 384 MB in its own 2-D context.
    const before = (layers: number) => layers * (768 + 512 + 512 + 384) * MB;
    const after = POOL_3D.limit + POOL_2D_BYTES;
    expect(after).toBe(1792 * MB);
    expect(before(8)).toBe(17408 * MB);
    expect(after).toBeLessThan(before(1));
  });
});
