/**
 * The Atlas panel's worker: reads a label volume (OME-Zarr, a NIfTI or MGH
 * read as virtual Zarr, or a precomputed segmentation, through the volume
 * view's reader) off the main thread, and counts its labels or finds a
 * region's voxel nearest a point (see ./labels.ts).
 *
 * In:  { type: "count", id, store, level? }  (level: by default the finest of at most 64 M voxels)
 *      { type: "nearest", id, store, level, labels, point, lo, hi }
 *      { type: "cancel", id }
 * Out: { type: "counted", id, level, size, sizes, voxelToRas, labels, counts, sums, bounds }  (sizes: every level's, finest first)
 *      { type: "nearest", id, voxel }
 *      { type: "progress", id, done, total }
 *      { type: "error", id, message }
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import { readerCache } from "../volume-view/volume_reader.js";
import { countingLevel, LabelCounter, NearestVoxel } from "./labels.js";

// zstd and the other codecs decode in the platform's async-computation worker.
setAsyncComputationWorkerFactory(() => asyncComputationWorker(["org.ngplatform.zarr-vectors"]));

const controllers = new Map<number, AbortController>();

// The last two stores kept open (their chunks are in the cache all the tools share).
const open = readerCache(2);

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
  const work = (async () => {
    const { reader, levels } = await open(msg.store);
    if (msg.type === "count") {
      const level = typeof msg.level === "number" && msg.level >= 0 && msg.level < levels.length ? msg.level : countingLevel(levels.map((l) => l.size));
      const counter = new LabelCounter();
      await reader.eachRawChunk(level, signal, (values, box) => counter.add(values, box), progress);
      const r = counter.result();
      const { size, voxelToRas } = levels[level];
      postMessage({ type: "counted", id: msg.id, level, size, sizes: levels.map((l) => l.size), voxelToRas: Array.from(voxelToRas), ...r }, { transfer: [r.labels.buffer, r.counts.buffer, r.sums.buffer, r.bounds.buffer] });
    } else if (msg.type === "nearest") {
      const nearest = new NearestVoxel(new Set(msg.labels as number[]), msg.point);
      await reader.eachRawChunk(msg.level, signal, (values, box) => nearest.add(values, box), progress, { lo: msg.lo, hi: msg.hi });
      postMessage({ type: "nearest", id: msg.id, voxel: nearest.best ?? null });
    } else {
      throw new Error(`unknown request ${msg.type}`);
    }
  })();
  work
    .catch((e) => {
      if (!signal.aborted) postMessage({ type: "error", id: msg.id, message: (e as Error).message });
    })
    .finally(() => controllers.delete(msg.id));
};
