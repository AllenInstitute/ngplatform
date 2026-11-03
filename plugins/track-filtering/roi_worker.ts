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
 *               { type: "evaluate", id, level, roi }    roi in store coordinates;
 *                 roi.ends: test the lines' ends (either, or both) instead;
 *                 roi.maskSource: a volume's voxels, read here once
 *               { type: "curves", id, level, ids }   whole streamlines of objects
 *               { type: "cancel", id }
 * Messages out: { type: "opened", info } | { type: "error", id?, message }
 *               { type: "progress", id, done, total }
 *               { type: "result", id, ids, chunks, bytes, ms }
 *               { type: "curves", id, ids, offsets, positions, ms }
 */
import {
  httpAccess,
  levelPipeline,
  type LevelPipeline,
  ObjectReader,
  openZarrVectorsStore,
  setVertexCellCacheBytes,
  type ZarrVectorsStore,
  type ZarrVectorsStoreAccess,
  openZarrArray,
  readObjectTable,
  ZarrArrayReader,
} from "neuroglancer-zarr-vectors/reader";
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import { ARRAYS, type VoxelType } from "@ngplatform/sdk/volume_out";
import { VolumeReader } from "../volume-view/volume_reader.js";
import { type ChunkEnds, chunkEnds, type ChunkGeometry, compactChunk, IdSet, type MaskSource, type MaskVolume, maskBits, maskBounds, maskKey, type RoiGeometry, roiBounds, testChunk, testChunkMask, testEnds } from "./roi.js";

// Compressed arrays (the object manifests, zstd) decode in the platform's
// async-computation worker, with Zarr Vectors' decoders loaded, as the
// viewer's own workers do.
setAsyncComputationWorkerFactory(
  () => asyncComputationWorker(["org.ngplatform.zarr-vectors"]),
);

export interface StoreInfo {
  axisNames: string[];
  axisUnits: string[];
  axisScales: number[];
  coordinateOffset: number[] | undefined;
  /** The store's bounds, in its own coordinates. */
  bounds: { lower: number[]; upper: number[] };
  levels: { index: number; vertexCount: number | undefined; chunkShape: number[] }[];
  geometry: string;
  /** Whether the store has objects (an object index): what groups are made of. */
  objects: boolean;
}

/** Decoded geometry kept here; at about 17 bytes a vertex, some 20 M vertices. */
const CACHE_BYTES = 320 * 1024 * 1024;
// This worker keeps its own compact copy: the reader's raw cells need not stay.
setVertexCellCacheBytes(48 * 1024 * 1024);
const CONCURRENCY = 6;

let store: ZarrVectorsStore | undefined;
let access: ZarrVectorsStoreAccess | undefined;
const pipelines = new Map<number, LevelPipeline>();
const objectReaders = new Map<number, ObjectReader>();
const controllers = new Map<number, AbortController>();

/** Decoded chunks (and their line ends), least recently used first; pending reads are shared. */
const cache = new Map<string, Promise<ChunkGeometry | ChunkEnds | undefined>>();
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

function pipelineOf(level: number): LevelPipeline {
  let pipeline = pipelines.get(level);
  if (pipeline === undefined) {
    pipeline = levelPipeline(access!, store!, store!.levels[level]);
    pipelines.set(level, pipeline);
  }
  return pipeline;
}

function cached<T extends ChunkGeometry | ChunkEnds>(key: string): Promise<T | undefined> | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit as Promise<T | undefined>;
}

/**
 * The ends of a chunk's lines.  A fragment's first or last vertex is a
 * line's end unless a link carries the line on (into a neighbouring chunk,
 * or another fragment), so the links touching the chunk are read too.
 */
function ends(level: number, coords: number[]): Promise<ChunkEnds | undefined> {
  const key = `ends|${level}|${coords.join(".")}`;
  const hit = cached<ChunkEnds>(key);
  if (hit !== undefined) return hit;
  const pending = Promise.all([chunk(level, coords), pipelineOf(level).linkedVertices(coords)]).then(([geometry, linked]) => {
    if (geometry === undefined) {
      remember(key, 0);
      return undefined;
    }
    const out = chunkEnds(geometry, linked);
    remember(key, out.bytes);
    return out;
  });
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  return pending;
}

function chunk(level: number, coords: number[], bridges = false): Promise<ChunkGeometry | undefined> {
  const key = `${level}|${coords.join(".")}${bridges ? "|bridged" : ""}`;
  const hit = cached<ChunkGeometry>(key);
  if (hit !== undefined) return hit;
  const pipeline = pipelineOf(level);
  // Reads are shared between requests, so none is cancelled with one.  The
  // segments crossing into neighbouring chunks are left out unless asked
  // for: they need the neighbours' vertices, and a solid region meets the
  // segments either side of one anyway.  A disk is a plane, which may lie
  // on a chunk boundary, where only those segments cross it.
  const pending = pipeline.download(coords, new AbortController().signal, { bridges }).then((data) => {
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
  objectReaders.clear();
  cache.clear();
  sizes.clear();
  cachedBytes = 0;
  return {
    axisNames: store.axisNames,
    axisUnits: store.axisUnits,
    axisScales: store.axisScales,
    coordinateOffset: store.coordinateOffset,
    bounds: { lower: Array.from(store.lowerBounds), upper: Array.from(store.upperBounds) },
    levels: store.levels.map((l) => ({ index: l.index, vertexCount: l.vertexCount, chunkShape: l.chunkShape })),
    geometry: store.description.geometryKind,
    objects: store.description.hasObjects,
  };
}

/** Masks read, by source: the last few. */
const masks = new Map<string, Promise<MaskVolume>>();

/** A mask's level, read whole, as one byte a voxel. */
function maskVolume(source: MaskSource): Promise<MaskVolume> {
  const key = maskKey(source);
  let mask = masks.get(key);
  if (mask === undefined) {
    mask = (async () => {
      const reader = new VolumeReader();
      await reader.open([source.store], undefined);
      const raw = await reader.rawVolume(source.level, new AbortController().signal);
      const Type = ARRAYS[raw.type as VoxelType];
      const values = new Type(raw.data.buffer as ArrayBuffer, raw.data.byteOffset, raw.data.byteLength / Type.BYTES_PER_ELEMENT);
      return maskBits(values, raw.size, source, Float64Array.from(source.storeToVoxel));
    })();
    mask.catch(() => masks.delete(key));
    masks.set(key, mask);
    while (masks.size > 4) masks.delete(masks.keys().next().value!);
  }
  return mask;
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
    const mask = roi.maskSource === undefined ? undefined : await maskVolume(roi.maskSource);
    const { lo, hi } = mask === undefined ? roiBounds(roi, margin) : (({ lo, hi }) => ({ lo: lo.map((v) => v - margin), hi: hi.map((v) => v + margin) }))(maskBounds(mask));
    if (mask !== undefined && mask.hi.every((v) => v === 0)) {
      // An empty mask: nothing passes through it.
      const none = new BigUint64Array(0);
      postMessage({ type: "result", id, ids: none, chunks: 0, bytes: 0, ms: performance.now() - started }, { transfer: [none.buffer] });
      return;
    }
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
    // Ends: each object's line ends inside the region, counted.
    const endCounts = new Map<number | bigint, number>();
    let done = 0;
    let bytes = 0;
    let next = 0;
    const work = async () => {
      while (next < coords.length) {
        const c = coords[next++];
        // Thin regions (a disk, a mask's voxels) can lie on a chunk boundary, crossed only by the segments joining chunks.
        const data = roi.ends === undefined ? await chunk(level, c, roi.shape === "disk" || mask !== undefined) : await ends(level, c);
        if (controller.signal.aborted) return;
        if (data !== undefined) {
          if (mask !== undefined) testChunkMask(data as ChunkGeometry, mask, hits);
          else if (roi.ends === undefined) testChunk(data as ChunkGeometry, roi, hits);
          else testEnds(data as ChunkEnds, roi, endCounts);
          bytes += data.bytes;
        }
        postMessage({ type: "progress", id, done: ++done, total: coords.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, coords.length) }, work));
    if (controller.signal.aborted) return;
    for (const [key, count] of endCounts) if (roi.ends === "either" || count >= 2) hits.addKey(key);
    const ids = hits.toArray();
    postMessage({ type: "result", id, ids, chunks: coords.length, bytes, ms: performance.now() - started }, { transfer: [ids.buffer] });
  } finally {
    controllers.delete(id);
  }
}

/** Objects' whole streamlines at a level, each chunk read once for all of them. */
async function curves(id: number, level: number, ids: BigUint64Array): Promise<void> {
  if (store === undefined || access === undefined) throw new Error("no store is open");
  const controller = new AbortController();
  controllers.set(id, controller);
  const started = performance.now();
  try {
    let reader = objectReaders.get(level);
    if (reader === undefined) {
      reader = new ObjectReader(access, store.description, store.levels[level]);
      objectReaders.set(level, reader);
    }
    const out = await reader.readCurves(Array.from(ids), controller.signal, (done, total) => postMessage({ type: "progress", id, done, total }));
    const found = BigUint64Array.from(out.ids);
    postMessage(
      { type: "curves", id, ids: found, offsets: out.offsets, positions: out.positions, ms: performance.now() - started },
      { transfer: [found.buffer, out.offsets.buffer, out.positions.buffer] },
    );
  } finally {
    controllers.delete(id);
  }
}

/** Small questions about the store, answered with `{type: "answer", id, value}`. */
const calls: Record<string, (msg: any) => Promise<{ value: unknown; transfer?: Transferable[] }>> = {
  /** An image's levels, for a mask on it: each one's voxels along x, y, z and their placement (voxel indices to RAS mm). */
  async maskLevels({ store: url }: { store: string }) {
    const { levels } = await new VolumeReader().open([url], undefined);
    return { value: levels.map((l) => ({ size: l.size, voxelToRas: Array.from(l.voxelToRas) })) };
  },
  async objectIds({ level, segmentIds }: { level: number; segmentIds: BigUint64Array }) {
    const levelPath = store!.levels[level].path;
    const table = await readObjectTable(access!, levelPath);
    if (table === undefined) throw new Error(`${levelPath} has no object table`);
    const rowOf = new Map<bigint, number>();
    for (let r = 0; r < table.numObjects; ++r) rowOf.set(table.segmentIds[r], r);
    const objectIds = new BigUint64Array(segmentIds.length);
    let missing = 0;
    segmentIds.forEach((id, i) => {
      const row = rowOf.get(id);
      if (row === undefined) missing++;
      else objectIds[i] = table.objectIds?.[row] ?? BigInt(row);
    });
    return { value: { objectIds, missing }, transfer: [objectIds.buffer] };
  },
  async groups({ level }: { level: number }) {
    const levelPath = store!.levels[level].path;
    const array = await openZarrArray(access!.read, `${levelPath}/groups`);
    if (array === undefined) return { value: { names: [], members: [], levelPath } };
    const attrs = array.attributes as { num_groups?: number; group_names?: string[]; group_ranges?: Record<string, [number, number]> };
    const n = Number(attrs.num_groups ?? array.shape[0]);
    const rows = await new ZarrArrayReader(array, access!.read, access!.shardIndexes).readVlenRows(0, n);
    let names = Array.isArray(attrs.group_names) ? attrs.group_names.map(String) : [];
    if (names.length < n) {
      const column = await openZarrArray(access!.read, `${levelPath}/group_attributes/name`);
      if (column !== undefined) {
        const text = await new ZarrArrayReader(column, access!.read, access!.shardIndexes).readVlenRows(0, n);
        names = text.map((b) => (b === undefined ? "" : new TextDecoder().decode(b)));
      }
    }
    const members = rows.map((b, g) => {
      const range = attrs.group_ranges?.[String(g)];
      if (range !== undefined) {
        const out = new BigUint64Array(Math.max(0, range[1] - range[0]));
        for (let i = 0; i < out.length; ++i) out[i] = BigInt(range[0] + i);
        return out;
      }
      if (b === undefined) return new BigUint64Array(0);
      return new BigUint64Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~7)));
    });
    return { value: { names: Array.from({ length: n }, (_, g) => names[g] || `group ${g}`), members, levelPath } };
  },
};

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "call") {
    const op = calls[msg.op];
    if (op === undefined || store === undefined) {
      postMessage({ type: "error", id: msg.id, message: store === undefined ? "no store is open" : `no ${msg.op}` });
      return;
    }
    op(msg).then(
      ({ value, transfer }) => postMessage({ type: "answer", id: msg.id, value }, { transfer: transfer ?? [] }),
      (e) => postMessage({ type: "error", id: msg.id, message: (e as Error).message }),
    );
    return;
  }
  if (msg.type === "open") {
    open(msg.storeUrl).then(
      (info) => postMessage({ type: "opened", info }),
      (e) => postMessage({ type: "error", message: (e as Error).message }),
    );
  } else if (msg.type === "evaluate") {
    evaluate(msg.id, msg.level, msg.roi).catch((e) => postMessage({ type: "error", id: msg.id, message: (e as Error).message }));
  } else if (msg.type === "curves") {
    curves(msg.id, msg.level, msg.ids).catch((e) => postMessage({ type: "error", id: msg.id, message: (e as Error).message }));
  } else if (msg.type === "cancel") {
    controllers.get(msg.id)?.abort();
  }
};
