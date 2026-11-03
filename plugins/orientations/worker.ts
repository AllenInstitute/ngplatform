/**
 * The orientations worker: an {@link OrientationReader} and the glyph
 * computation behind messages, so chunk decoding and evaluating spherical
 * harmonics stay off the main thread.
 *
 * In:  { type: "open", id, url }
 *      { type: "glyphs", id, level, request: VoxelRequest, options: GlyphOptions }
 *      { type: "values", id, level, request: VoxelRequest }
 *      { type: "cancel", id }
 * Out: { type: "opened", id, levels, name, componentAxis, metadata }
 *      { type: "glyphs", id, set: GlyphSet, voxels }
 *      { type: "values", id, indices, values, count }
 *      { type: "error", id, message }
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import { computeGlyphs } from "./glyphs.js";
import { OrientationReader } from "./reader.js";

// zstd, blosc and gzip decode in the platform's async-computation worker.
setAsyncComputationWorkerFactory(() => asyncComputationWorker(["org.ngplatform.zarr-vectors"]));

const reader = new OrientationReader();
const controllers = new Map<number, AbortController>();
let levels: { voxelToRas: Float64Array; components: number }[] = [];

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    controllers.get(msg.id)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(msg.id, controller);
  const { signal } = controller;
  let work: Promise<void>;
  if (msg.type === "open") {
    work = reader.open(msg.url, signal).then((opened) => {
      levels = opened.levels;
      postMessage({ type: "opened", id: msg.id, ...opened });
    });
  } else if (msg.type === "glyphs") {
    work = reader.voxels(msg.level, msg.request, signal).then((voxels) => {
      const level = levels[msg.level];
      const set = computeGlyphs(voxels.indices, voxels.values, level.components, level.voxelToRas, msg.options);
      const transfer = [set.centres.buffer, set.radii?.buffer, set.axes?.buffer, set.dirs?.buffer, set.colours?.buffer].filter((b): b is ArrayBuffer => b !== undefined);
      postMessage({ type: "glyphs", id: msg.id, set, voxels: voxels.count }, { transfer });
    });
  } else if (msg.type === "values") {
    work = reader.voxels(msg.level, msg.request, signal).then((voxels) => {
      postMessage({ type: "values", id: msg.id, ...voxels }, { transfer: [voxels.indices.buffer, voxels.values.buffer] });
    });
  } else {
    work = Promise.reject(new Error(`unknown request ${msg.type}`));
  }
  work
    .catch((e) => {
      if (!signal.aborted) postMessage({ type: "error", id: msg.id, message: (e as Error).message });
    })
    .finally(() => controllers.delete(msg.id));
};
