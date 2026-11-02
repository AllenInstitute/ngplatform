/**
 * The worker that tests regions on segmentation volumes (./labels.ts) and
 * on precomputed annotations, so reading and decoding chunks stays off the
 * main thread.
 *
 * In:  { type: "evaluate", id, url, region }   (a segmentation)
 *      { type: "annotations", id, url, region }  (precomputed annotations)
 *      { type: "cancel", id }
 * Out: { type: "result", id, ids, level, chunks, voxels, ms }
 *      { type: "progress", id, done, total }   { type: "error", id, message }
 */
import { type Info, PrecomputedScale, readInfo } from "@ngplatform/sdk/precomputed";
import { PrecomputedAnnotations, readAnnotationInfo } from "@ngplatform/sdk/precomputed_annotations";
import { annotationMeets } from "./annotation_regions.js";
import { chooseScale, labelsInRegion, type NmRegion } from "./labels.js";

const annotationSources = new Map<string, Promise<PrecomputedAnnotations>>();

function openAnnotations(url: string) {
  let source = annotationSources.get(url);
  if (source === undefined) {
    source = readAnnotationInfo(url).then((info) => new PrecomputedAnnotations(url, info));
    source.catch(() => annotationSources.delete(url));
    annotationSources.set(url, source);
  }
  return source;
}

/** Precomputed annotations meeting a region: read by the chunks around it, tested exactly, in nm. */
async function annotationsInRegion(url: string, region: NmRegion, signal: AbortSignal) {
  const source = await openAnnotations(url);
  const nm = Object.values(source.info.dimensions).map(([scale]) => scale * 1e9);
  const half = region.shape === "sphere" ? [region.radius, region.radius, region.radius] : region.size.map((v) => Math.abs(v) / 2);
  const lo = [0, 1, 2].map((k) => (region.center[k] - half[k]) / nm[k]);
  const hi = [0, 1, 2].map((k) => (region.center[k] + half[k]) / nm[k]);
  const { annotations, chunks } = await source.inBox(lo, hi, signal);
  const type = { POINT: "point", LINE: "line", AXIS_ALIGNED_BOUNDING_BOX: "axis_aligned_bounding_box", ELLIPSOID: "ellipsoid" }[source.info.annotation_type];
  const passing = annotations.filter((a) => annotationMeets(region, { id: "", type, points: a.points.map((p) => p.map((v, k) => v * nm[k])) }));
  return { ids: passing.map((a) => String(a.id)), points: passing.map((a) => a.points), annotationType: type, nm, chunks, read: annotations.length };
}

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
    if (msg.type === "annotations") {
      const r = await annotationsInRegion(msg.url, msg.region, controller.signal);
      postMessage({ type: "result", id: msg.id, ...r, level: `${r.read.toLocaleString()} read`, voxels: 0, ms: performance.now() - started });
      return;
    }
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
