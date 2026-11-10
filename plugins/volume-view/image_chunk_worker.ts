/**
 * The image chunk worker: one for the page, reading and decoding the image
 * chunks every tool's worker asks for, and keeping them in one cache of
 * {@link SHARED_CHUNK_BYTES} (./shared_chunks.ts).
 *
 * In:  { type: "connect", port }  (from the page: a port to a tool's worker)
 * On a port, in:  { type: "chunk", id, ref, index, keep }
 *                 { type: "forget", ref }
 *            out: { id, data }  (undefined where no chunk is stored)
 *                 { id, error }
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import { ChunkCache, levelKey } from "./shared_chunks.js";
import { type LevelRef, openOmeLevel, openPrecomputedScale, type RawLevel, type StoreAccess } from "./volume_reader.js";

// zstd and the other codecs decode in the platform's async-computation worker.
setAsyncComputationWorkerFactory(() => asyncComputationWorker(["org.ngplatform.zarr-vectors"]));

export const cache = new ChunkCache();

/** Levels opened, by key, and one read per store. */
const levels = new Map<string, Promise<RawLevel>>();
const accesses = new Map<string, StoreAccess>();

function level(ref: LevelRef): Promise<RawLevel> {
  const key = levelKey(ref);
  let opened = levels.get(key);
  if (opened === undefined) {
    opened = ref.kind === "ome" ? openOmeLevel(ref.level, accesses) : Promise.resolve(openPrecomputedScale(ref.url, ref.scale, ref.stored, ref.labels));
    const mine = opened;
    opened.catch(() => levels.get(key) === mine && levels.delete(key));
    levels.set(key, opened);
  }
  return opened;
}

/** Answers a tool's worker on its port. */
export function serve(port: MessagePort): void {
  port.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    if (msg?.type === "forget") {
      // Opened again by a tool: it may have been written again, so its metadata and chunks are read afresh.
      const key = levelKey(msg.ref);
      levels.delete(key);
      if (msg.ref.kind === "ome") accesses.delete(msg.ref.level.url);
      cache.forget(key);
      return;
    }
    if (msg?.type !== "chunk") return;
    const { id, ref, index, keep } = msg as { id: number; ref: LevelRef; index: number[]; keep: boolean };
    cache
      .get(levelKey(ref) + index.join("."), async () => (await level(ref)).raw(index), keep)
      .then(
        (data) => port.postMessage({ id, data }),
        (error: unknown) => port.postMessage({ id, error: (error as Error)?.message ?? String(error) }),
      );
  };
}

if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined") {
  self.onmessage = (event: MessageEvent) => {
    if (event.data?.type === "connect") serve(event.data.port as MessagePort);
  };
}
