/**
 * The worker that tests regions on segmentation volumes (./labels.ts), so
 * reading and decoding chunks stays off the main thread.
 *
 * In:  { type: "evaluate", id, url, region }   { type: "cancel", id }
 * Out: { type: "result", id, ids, level, chunks, voxels, ms }
 *      { type: "progress", id, done, total }   { type: "error", id, message }
 */
import { type Info, PrecomputedScale, readInfo } from "@ngplatform/sdk/precomputed";
import { chooseScale, labelsInRegion } from "./labels.js";

const volumes = new Map<string, Promise<{ info: Info; scales: PrecomputedScale[] }>>();
const controllers = new Map<number, AbortController>();

function open(url: string) {
  let volume = volumes.get(url);
  if (volume === undefined) {
    volume = readInfo(url, undefined, undefined, "segmentation").then((info) => ({
      info,
      scales: info.scales.map((s) => new PrecomputedScale(url, s, info.data_type)),
    }));
    volume.catch(() => volumes.delete(url));
    volumes.set(url, volume);
  }
  return volume;
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    controllers.get(msg.id)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(msg.id, controller);
  const started = performance.now();
  try {
    const { info, scales } = await open(msg.url);
    const index = chooseScale(info.scales, msg.region);
    const { ids, chunks, voxels } = await labelsInRegion(scales[index], msg.region, controller.signal, (done, total) =>
      postMessage({ type: "progress", id: msg.id, done, total }),
    );
    postMessage({ type: "result", id: msg.id, ids, level: info.scales[index].key, chunks, voxels, ms: performance.now() - started }, { transfer: [ids.buffer] });
  } catch (e) {
    if (!controller.signal.aborted) postMessage({ type: "error", id: msg.id, message: (e as Error).message });
  } finally {
    controllers.delete(msg.id);
  }
};
