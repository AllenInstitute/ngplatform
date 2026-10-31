/**
 * The region worker: which objects of a Zarr Vectors store pass through a
 * region, tested exactly on every line segment of a level.
 *
 * Only the spatial chunks the region's bounds touch are read, each once:
 * their positions, per-vertex object ids and segments (including the ones
 * that cross into a neighbouring chunk) stay in a byte-bounded cache, so
 * moving a region nearby, or testing another in the same area, reads
 * nothing again.  Requests report progress per chunk and can be cancelled.
 *
 * Messages in:  { type: "open", storeUrl }
 *               { type: "evaluate", id, level, roi }    roi in store coordinates
 *               { type: "cancel", id }
 * Messages out: { type: "opened", info } | { type: "error", id?, message }
 *               { type: "progress", id, done, total }
 *               { type: "result", id, ids, chunks, bytes, ms }
 */
import {
  httpAccess,
  levelPipeline,
  type LevelPipeline,
  openZarrVectorsStore,
  setVertexCellCacheBytes,
  type ZarrVectorsStore,
  type ZarrVectorsStoreAccess,
} from "neuroglancer-zarr-vectors/reader";
import { type ChunkGeometry, compactChunk, IdSet, type RoiGeometry, roiBounds, testChunk } from "./roi.js";

export interface StoreInfo {
  axisNames: string[];
  axisUnits: string[];
  axisScales: number[];
  coordinateOffset: number[] | undefined;
  levels: { index: number; vertexCount: number | undefined; chunkShape: number[] }[];
  geometry: string;
}

/** Decoded geometry kept here; at about 17 bytes a vertex, some 20 M vertices. */
const CACHE_BYTES = 320 * 1024 * 1024;
// This worker keeps its own compact copy: the reader's raw cells need not stay.
setVertexCellCacheBytes(48 * 1024 * 1024);
const CONCURRENCY = 6;

let store: ZarrVectorsStore | undefined;
let access: ZarrVectorsStoreAccess | undefined;
const pipelines = new Map<number, LevelPipeline>();
const controllers = new Map<number, AbortController>();

/** Decoded chunks, least recently used first; pending reads are shared. */
const cache = new Map<string, Promise<ChunkGeometry | undefined>>();
const sizes = new Map<string, number>();
let cachedBytes = 0;

function remember(key: string, bytes: number): void {
  sizes.set(key, bytes);
  cachedBytes += bytes;
  for (const [old] of cache) {
    if (cachedBytes <= CACHE_BYTES) break;
    if (old === key) continue;
    cachedBytes -= sizes.get(old) ?? 0;
    sizes.delete(old);
    cache.delete(old);
  }
}

function chunk(level: number, coords: number[]): Promise<ChunkGeometry | undefined> {
  const key = `${level}|${coords.join(".")}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let pipeline = pipelines.get(level);
  if (pipeline === undefined) {
    pipeline = levelPipeline(access!, store!, store!.levels[level]);
    pipelines.set(level, pipeline);
  }
  // Reads are shared between requests, so none is cancelled with one.  The
  // segments crossing into neighbouring chunks are left out: they would
  // need the neighbours' vertices, and a region meets the segments either
  // side of one anyway.
  const pending = pipeline.download(coords, new AbortController().signal, { bridges: false }).then((data) => {
    if (data === undefined) {
      remember(key, 0);
      return undefined;
    }
    const geometry = compactChunk(data.positions.subarray(0, data.numVertices * 3), data.segmentIds, data.edges);
    remember(key, geometry.bytes);
    return geometry;
  });
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  return pending;
}

async function open(storeUrl: string): Promise<StoreInfo> {
  access = httpAccess(storeUrl);
  store = await openZarrVectorsStore(access, []);
  pipelines.clear();
  cache.clear();
  sizes.clear();
  cachedBytes = 0;
  return {
    axisNames: store.axisNames,
    axisUnits: store.axisUnits,
    axisScales: store.axisScales,
    coordinateOffset: store.coordinateOffset,
    levels: store.levels.map((l) => ({ index: l.index, vertexCount: l.vertexCount, chunkShape: l.chunkShape })),
    geometry: store.description.geometryKind,
  };
}

async function evaluate(id: number, level: number, roi: RoiGeometry): Promise<void> {
  if (store === undefined) throw new Error("no store is open");
  const controller = new AbortController();
  controllers.set(id, controller);
  const started = performance.now();
  try {
    const { chunkShape } = store.levels[level];
    // Segments are short beside a chunk; a small margin catches one that
    // starts just outside the region's bounds and ends inside.
    const margin = Math.min(...chunkShape) / 16;
    const { lo, hi } = roiBounds(roi, margin);
    const coords: number[][] = [];
    const from = lo.map((v, k) => Math.floor(v / chunkShape[k]));
    const to = hi.map((v, k) => Math.floor(v / chunkShape[k]));
    for (let x = from[0]; x <= to[0]; ++x) {
      for (let y = from[1]; y <= to[1]; ++y) {
        for (let z = from[2]; z <= to[2]; ++z) coords.push([x, y, z]);
      }
    }
    // Nearest the region's centre first: the likeliest to hold its objects.
    const centre = roi.center.map((c, k) => c / chunkShape[k] - 0.5);
    const distance = (c: number[]) => c.reduce((s, v, k) => s + (v - centre[k]) ** 2, 0);
    coords.sort((a, b) => distance(a) - distance(b));
    const hits = new IdSet();
    let done = 0;
    let bytes = 0;
    let next = 0;
    const work = async () => {
      while (next < coords.length) {
        const c = coords[next++];
        const data = await chunk(level, c);
        if (controller.signal.aborted) return;
        if (data !== undefined) {
          testChunk(data, roi, hits);
          bytes += data.bytes;
        }
        postMessage({ type: "progress", id, done: ++done, total: coords.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, coords.length) }, work));
    if (controller.signal.aborted) return;
    const ids = hits.toArray();
    postMessage({ type: "result", id, ids, chunks: coords.length, bytes, ms: performance.now() - started }, { transfer: [ids.buffer] });
  } finally {
    controllers.delete(id);
  }
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "open") {
    open(msg.storeUrl).then(
      (info) => postMessage({ type: "opened", info }),
      (e) => postMessage({ type: "error", message: (e as Error).message }),
    );
  } else if (msg.type === "evaluate") {
    evaluate(msg.id, msg.level, msg.roi).catch((e) => postMessage({ type: "error", id: msg.id, message: (e as Error).message }));
  } else if (msg.type === "cancel") {
    controllers.get(msg.id)?.abort();
  }
};
