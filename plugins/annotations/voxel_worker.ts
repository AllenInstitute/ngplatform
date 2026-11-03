/**
 * The Annotations tab's worker: reads an image's voxels (OME-Zarr, a NIfTI
 * read as virtual Zarr, or a precomputed image, through the volume view's
 * reader) off the main thread, for line profiles, statistics in a region,
 * and the image values a drawing tool tests.
 *
 * In:  { type: "open", id, store }
 *      { type: "points", id, store, level, points, method }
 *      { type: "block", id, store, level, lo, size, affine?, exact? }
 *      { type: "stats", id, store, level, lo, hi, region }
 *      { type: "cancel", id }
 * Out: { type: "opened", id, levels: [{ size, voxelToRas, voxelSize, type }] }
 *      { type: "points", id, values }
 *      { type: "block", id, data }  (Float32Array; Float64Array when exact)
 *      { type: "stats", id, summary }
 *      { type: "progress", id, done, total }
 *      { type: "error", id, message }
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import { VolumeReader } from "../volume-view/volume_reader.js";
import { type Region, regionTest, summarise, valuesInside } from "./statistics.js";

// zstd and the other codecs decode in the platform's async-computation worker.
setAsyncComputationWorkerFactory(() => asyncComputationWorker(["org.ngplatform.zarr-vectors"]));

const readers = new Map<string, Promise<{ reader: VolumeReader; levels: Awaited<ReturnType<VolumeReader["open"]>>["levels"] }>>();
const controllers = new Map<number, AbortController>();

function open(store: string) {
  let r = readers.get(store);
  if (r === undefined) {
    const reader = new VolumeReader(128 * 2 ** 20);
    r = reader.open([store], undefined).then(({ levels }) => ({ reader, levels }));
    readers.set(store, r);
    r.catch(() => readers.delete(store));
  }
  return r;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isIdentity = (a: number[]) => a.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);

/**
 * The image's values on another grid's block (`size` voxels from `lo`, x
 * fastest): each voxel's nearest image voxel, through `affine` (that grid's
 * voxels to the image's).  `exact` reads 64-bit floats, which hold labels
 * above 2^24 exactly, where 32-bit ones would round them.
 */
async function block(reader: VolumeReader, level: number, lo: number[], size: number[], affine: number[], signal: AbortSignal, exact = false): Promise<Float32Array | Float64Array> {
  const hi = lo.map((v, k) => v + size[k]);
  const read = (box: { lo: [number, number, number]; hi: [number, number, number] }) => (exact ? reader.exactRegion(level, box, signal) : reader.rawRegion(level, box, signal));
  if (isIdentity(affine)) {
    const { data } = await read({ lo: lo as [number, number, number], hi: hi as [number, number, number] });
    return data;
  }
  const at = (p: number[], r: number) => affine[4 * r] * p[0] + affine[4 * r + 1] * p[1] + affine[4 * r + 2] * p[2] + affine[4 * r + 3];
  const a = [Infinity, Infinity, Infinity];
  const b = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; ++c) {
    const p = [c & 1 ? hi[0] : lo[0] - 1, c & 2 ? hi[1] : lo[1] - 1, c & 4 ? hi[2] : lo[2] - 1];
    for (let r = 0; r < 3; ++r) {
      const v = at(p, r);
      a[r] = Math.min(a[r], Math.floor(v));
      b[r] = Math.max(b[r], Math.ceil(v) + 1);
    }
  }
  const region = await read({ lo: a as [number, number, number], hi: b as [number, number, number] });
  const n = size[0] * size[1] * size[2];
  const out = exact ? new Float64Array(n) : new Float32Array(n);
  out.fill(NaN);
  const rs = region.size;
  let i = 0;
  for (let z = lo[2]; z < hi[2]; ++z) {
    for (let y = lo[1]; y < hi[1]; ++y) {
      for (let x = lo[0]; x < hi[0]; ++x, ++i) {
        const X = Math.round(at([x, y, z], 0)) - a[0];
        const Y = Math.round(at([x, y, z], 1)) - a[1];
        const Z = Math.round(at([x, y, z], 2)) - a[2];
        if (X >= 0 && Y >= 0 && Z >= 0 && X < rs[0] && Y < rs[1] && Z < rs[2]) out[i] = region.data[X + rs[0] * (Y + rs[1] * Z)];
      }
    }
  }
  return out;
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
  const work = (async () => {
    const { reader, levels } = await open(msg.store);
    if (msg.type === "open") {
      postMessage({ type: "opened", id: msg.id, levels: levels.map((l) => ({ size: l.size, voxelToRas: Array.from(l.voxelToRas), voxelSize: l.voxelSize, type: l.type ?? "uint8" })) });
    } else if (msg.type === "points") {
      const values = await reader.rawPoints(msg.level, msg.points, msg.method, signal);
      postMessage({ type: "points", id: msg.id, values }, { transfer: [values.buffer] });
    } else if (msg.type === "block") {
      const data = await block(reader, msg.level, msg.lo, msg.size, msg.affine ?? IDENTITY, signal, msg.exact === true);
      postMessage({ type: "block", id: msg.id, data }, { transfer: [data.buffer] });
    } else if (msg.type === "stats") {
      const { data, size } = await reader.rawRegion(msg.level, { lo: msg.lo, hi: msg.hi }, signal, progress);
      let region = msg.region as Region;
      if (region.kind === "segmentation") {
        // The segmentation's labels on the image's block, nearest.
        const seg = await open(region.store);
        // Exactly: a label above 2^24 would round as a 32-bit float, and match its neighbour's.
        const labels = await block(seg.reader, region.level, msg.lo, size, region.affine, signal, true);
        region = { kind: "label", affine: IDENTITY, labels, origin: msg.lo, size, value: region.value };
      }
      const inside = valuesInside(data, msg.lo, size, regionTest(region));
      postMessage({ type: "stats", id: msg.id, summary: summarise(inside) });
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
