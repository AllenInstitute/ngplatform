/**
 * The volume view's worker: a {@link VolumeReader} behind messages, so
 * chunk decoding and resampling stay off the main thread.
 *
 * In:  { type: "open", id, stores, space }
 *      { type: "volume", id, level }
 *      { type: "plane", id, level, axis, value, rect: [u0, u1, v0, v1], texel }
 *      { type: "cancel", id }
 * Out: { type: "opened", id, levels, name, description }
 *      { type: "volume", id, data, size: [x, y, z] }
 *      { type: "plane", id, data, width, height, final }
 *      { type: "progress", id, done, total }
 *      { type: "error", id, message }
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import { VolumeReader } from "./volume_reader.js";

export type { LevelInfo } from "./volume_reader.js";

// zstd and the other codecs decode in the platform's async-computation worker.
setAsyncComputationWorkerFactory(
  () => asyncComputationWorker(["org.ngplatform.zarr-vectors"]),
);

const reader = new VolumeReader();
const controllers = new Map<number, AbortController>();

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
    work = reader.open(msg.stores, msg.space, signal).then((r) => postMessage({ type: "opened", id: msg.id, ...r }));
  } else if (msg.type === "volume") {
    work = reader.volume(msg.level, signal, progress).then(({ data, size }) => postMessage({ type: "volume", id: msg.id, data, size }, { transfer: [data.buffer] }));
  } else if (msg.type === "plane") {
    work = reader
      .plane(msg.level, msg, signal, progress, (image) => postMessage({ type: "plane", id: msg.id, ...image, final: false }, { transfer: [image.data.buffer] }))
      .then((image) => postMessage({ type: "plane", id: msg.id, ...image, final: true }, { transfer: [image.data.buffer] }));
  } else {
    work = Promise.reject(new Error(`unknown request ${msg.type}`));
  }
  work
    .catch((e) => {
      if (!signal.aborted) postMessage({ type: "error", id: msg.id, message: (e as Error).message });
    })
    .finally(() => controllers.delete(msg.id));
};
