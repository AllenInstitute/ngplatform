/**
 * The dense chunks' caches (raw vertex cells, neighbours' attributes) and
 * the ranges coalesced reads keep are charged to the worker's one budget,
 * rather than each to its own cap; and a whole-cell read is aborted once
 * every chunk waiting for it has been cancelled.
 */

import { describe, expect, it } from "vitest";
import { LevelPipeline } from "./chunk_pipeline.js";
import { openZarrVectorsStore } from "./store.js";
import { fixtureListDirectories, fixtureRead } from "./test_fixtures.js";
import { AsyncLru, ByteBudget, DECODED_BUDGET, setDecodedCacheBytes } from "./util.js";
import { RangeCache, ShardIndexCache } from "./zarr_array.js";

describe("a load several callers share", () => {
  const slow = () => {
    const seen: AbortSignal[] = [];
    const load = (signal: AbortSignal) => {
      seen.push(signal);
      return new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => resolve("done"), 50);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(signal.reason);
        });
      });
    };
    return { seen, load };
  };

  it("goes on while anyone waits for it", async () => {
    const lru = new AsyncLru<string>(10);
    const { seen, load } = slow();
    const a = new AbortController();
    const b = new AbortController();
    const first = lru.getShared("k", a.signal, load);
    const second = lru.getShared("k", b.signal, load);
    first.catch(() => {});
    a.abort();
    await expect(first).rejects.toBeDefined();
    expect(await second).toBe("done");
    expect(seen.length).toBe(1);
    expect(seen[0].aborted).toBe(false);
  });

  it("is aborted, and forgotten, once everyone has given up", async () => {
    const lru = new AsyncLru<string>(10);
    const { seen, load } = slow();
    const a = new AbortController();
    const b = new AbortController();
    const waits = [lru.getShared("k", a.signal, load), lru.getShared("k", b.signal, load)];
    for (const w of waits) w.catch(() => {});
    a.abort();
    b.abort();
    expect(seen[0].aborted).toBe(true);
    expect(lru.peek("k")).toBeUndefined();
    // The next caller starts afresh.
    expect(await lru.getShared("k", undefined, load)).toBe("done");
    expect(seen.length).toBe(2);
  });

  it("is never aborted for a caller that gave no signal", async () => {
    const lru = new AsyncLru<string>(10);
    const { seen, load } = slow();
    const a = new AbortController();
    lru.getShared("k", undefined, load);
    lru.getShared("k", a.signal, load).catch(() => {});
    a.abort();
    expect(seen[0].aborted).toBe(false);
    expect(await lru.peek("k")).toBe("done");
  });
});

/** A chunk of poly_raw's level 0 that holds vertices. */
async function someChunk(): Promise<number[]> {
  const read = fixtureRead("poly_raw");
  const access = { read, listDirectories: fixtureListDirectories("poly_raw"), shardIndexes: new ShardIndexCache() };
  const store = await openZarrVectorsStore(access, undefined);
  const level = store.levels[0];
  const { shape, attributes } = level.arrays.vertices;
  const origin = attributes.chunk_grid_origin ?? [0, 0, 0];
  for (let i = 0; i < shape[0]; ++i) {
    for (let j = 0; j < shape[1]; ++j) {
      for (let k = 0; k < shape[2]; ++k) {
        const chunk = [i + origin[0], j + origin[1], k + origin[2]];
        const pipeline = new LevelPipeline(access, store.description, level);
        if ((await pipeline.download(chunk, new AbortController().signal, { bridges: false })) !== undefined) return chunk;
      }
    }
  }
  throw new Error("no chunk");
}

describe("a dense chunk cancelled while its vertex cell is read", () => {
  it("aborts that read", async () => {
    const read = fixtureRead("poly_raw");
    const aborted: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let armed = false;
    const access = {
      read: async (path: string, options: any) => {
        if (armed && path.startsWith("0/vertices/c/")) {
          await Promise.race([
            gate,
            new Promise((_, reject) =>
              options.signal?.addEventListener("abort", () => {
                aborted.push(path);
                reject(options.signal.reason);
              }),
            ),
          ]);
        }
        return read(path, options);
      },
      listDirectories: fixtureListDirectories("poly_raw"),
      shardIndexes: new ShardIndexCache(),
    };
    const store = await openZarrVectorsStore(access, undefined);
    const level = store.levels[0];
    const pipeline = new LevelPipeline(access, store.description, level);
    const controller = new AbortController();
    const chunk = await someChunk();
    armed = true;
    const download = pipeline.downloadForDrawing(chunk, controller.signal);
    download.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await expect(download).rejects.toBeDefined();
    expect(aborted.length).toBe(1);
    release();
  });
});

describe("the caches a worker keeps", () => {
  it("charge kept ranges to the shared budget, which lets the oldest go", () => {
    const budget = new ByteBudget(250);
    const cache = new RangeCache(Infinity, budget);
    for (let i = 0; i < 3; ++i) cache.put(`cell${i}`, 0, new Uint8Array(100));
    expect(budget.size).toBe(200);
    expect(cache.size).toBe(200);
    expect(cache.get("cell0", 0, 10)).toBeUndefined();
    expect(cache.get("cell2", 0, 10)).toBeDefined();
    // Another cache sharing it makes room for its own.
    const other = new AsyncLru<Uint8Array>(Infinity, Infinity, (b) => b.byteLength, budget);
    other.put("x", new Uint8Array(100));
    return Promise.resolve().then(() => {
      expect(budget.size).toBeLessThanOrEqual(250);
      expect(cache.size).toBe(100);
    });
  });

  it("charge the dense chunks' vertex cells to the worker's budget", async () => {
    const before = DECODED_BUDGET.limit;
    try {
      setDecodedCacheBytes(1 << 30);
      const read = fixtureRead("poly_raw");
      const access = { read, listDirectories: fixtureListDirectories("poly_raw"), shardIndexes: new ShardIndexCache() };
      const store = await openZarrVectorsStore(access, undefined);
      const level = store.levels[0];
      const chunk = await someChunk();
      const charged = DECODED_BUDGET.size;
      const data = await new LevelPipeline(access, store.description, level).downloadForDrawing(chunk, new AbortController().signal);
      expect(data).toBeDefined();
      expect(DECODED_BUDGET.size - charged).toBeGreaterThanOrEqual(data!.numOwnVertices * 12);
      // With no room, nothing is kept.
      setDecodedCacheBytes(0);
      expect(DECODED_BUDGET.size).toBe(0);
    } finally {
      setDecodedCacheBytes(before);
    }
  });
});
