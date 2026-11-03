/**
 * The time series worker: a {@link SeriesReader} per image behind
 * messages, so chunk decoding stays off the main thread.  The images share
 * one chunk cache.
 *
 * In:  { type: "open", id, url }
 *      { type: "mean", id, url, voxels: Int32Array, plan?: ReadPlan }
 *      { type: "cached", id, url, voxels: Int32Array }  (the finest level's mean if no chunk need be read)
 *      { type: "cancel", id }
 * Out: { type: "opened", id, info }
 *      { type: "mean", id, values: Float32Array | null }
 *      { type: "progress", id, done, total }
 *      { type: "error", id, message }
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import { ChunkCache, SeriesReader } from "./reader.js";

// zstd, blosc and gzip decode in the platform's async-computation worker.
setAsyncComputationWorkerFactory(() => asyncComputationWorker(["org.ngplatform.zarr-vectors"]));

const cache = new ChunkCache();
const readers = new Map<string, Promise<SeriesReader>>();
const controllers = new Map<number, AbortController>();

function readerOf(url: string): Promise<SeriesReader> {
  let reader = readers.get(url);
  if (reader === undefined) {
    const r = new SeriesReader(cache);
    readers.set(url, (reader = r.open(url).then(() => r)));
    reader.catch(() => readers.delete(url));
  }
  return reader;
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    controllers.get(msg.id)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(msg.id, controller);
  const { signal } = controller;
  const progress = (done: number, total: number) => postMessage({ type: "progress", id: msg.id, done, total });
  let work: Promise<void>;
  if (msg.type === "open") {
    work = readerOf(msg.url).then((r) => postMessage({ type: "opened", id: msg.id, info: r.info }));
  } else if (msg.type === "mean") {
    work = readerOf(msg.url)
      .then((r) => r.mean(msg.voxels, signal, progress, msg.plan))
      .then((values) => postMessage({ type: "mean", id: msg.id, values }, { transfer: [values.buffer] }));
  } else if (msg.type === "cached") {
    work = readerOf(msg.url)
      .then((r) => r.meanIfCached(msg.voxels))
      .then((values) => postMessage({ type: "mean", id: msg.id, values: values ?? null }, { transfer: values ? [values.buffer] : [] }));
  } else {
    work = Promise.reject(new Error(`unknown request ${msg.type}`));
  }
  work
    .catch((e) => {
      if (!signal.aborted) postMessage({ type: "error", id: msg.id, message: (e as Error).message });
    })
    .finally(() => controllers.delete(msg.id));
};
