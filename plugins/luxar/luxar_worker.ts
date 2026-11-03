/**
 * The reading worker: one Zarr Vectors store, read in place (over HTTP, or
 * the app's local and virtual stores, which are HTTP too), its chunks
 * decoded by the Zarr Vectors reader and built for drawing (./chunk_build.ts).
 *
 * The main thread says which chunks it wants, most wanted first, as the
 * views change; a new list replaces the queue, and chunks already being
 * read finish (the reader caches what they fetched).
 *
 * It also reads a layer's chosen objects whole, by id, through the
 * reader's object index (`ObjectReader`): a batch of ids at a time, built
 * as one chunk (its segments sorted into pieces of space, for culling).
 *
 * Messages in:  { type: "open", storeUrl }
 *               { type: "want", keys, scalar }    keys "<level>|x.y.z"; scalar as styles.scalarOf
 *               { type: "objects", key, level, mode, ids, scalar }   mode "curves" | "skeletons"
 * Messages out: { type: "opened", info } | { type: "error", key?, message }
 *               { type: "chunk", key, scalar, chunk } | { type: "empty", key, scalar }
 *               { type: "objects", key, scalar, chunk, found } | { type: "objectsError", key, scalar, message }
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import {
  httpAccess,
  levelPipeline,
  type LevelPipeline,
  ObjectReader,
  openZarrVectorsStore,
  setVertexCellCacheBytes,
  type ZarrVectorsStore,
  type ZarrVectorsStoreAccess,
} from "neuroglancer-zarr-vectors/reader";
import { type BuiltChunk, buildChunk, type ChunkInput, curvesInput, type ScalarSource, skeletonsInput, sortIntoPieces } from "./chunk_build.js";

// Compressed cells decode in the platform's async-computation worker, with
// Zarr Vectors' decoders loaded, as the viewer's own workers do.
setAsyncComputationWorkerFactory(() => asyncComputationWorker(["org.ngplatform.zarr-vectors"]));
// The main thread keeps what it draws; raw cells need only last while neighbours are read.
setVertexCellCacheBytes(96 * 1024 * 1024);

const CONCURRENCY = 6;

export interface LevelInfo {
  index: number;
  vertexCount: number | undefined;
  chunkShape: number[];
  /** The share of level 0's objects this level holds, when the store says (1 for level 0). */
  objectShare: number | undefined;
  /** How many objects the level's object index lists, when it says. */
  objects: number | undefined;
}

/**
 * How a store's objects can be read whole, by id: as curves, many at once
 * (`readCurves`: streamlines, positions only), as skeletons one at a time
 * (`readSkeleton`: other lines and points, with their attributes), or not
 * (no object index; a mesh).
 */
export type ObjectRead = "curves" | "skeletons" | undefined;

export interface StoreInfo {
  axisNames: string[];
  axisUnits: string[];
  axisScales: number[];
  bounds: { lower: number[]; upper: number[] };
  levels: LevelInfo[];
  geometry: string;
  primitive: "points" | "lines" | "triangles";
  attributes: { id: string; name: string; components: number }[];
  warnings: string[];
  objectRead: ObjectRead;
}

let store: ZarrVectorsStore | undefined;
let access: ZarrVectorsStoreAccess | undefined;
const pipelines = new Map<number, LevelPipeline>();
let queue: string[] = [];
let scalar = "none";
const inFlight = new Set<string>();
let running = 0;

const post = (message: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

function pipelineOf(level: number): LevelPipeline {
  let pipeline = pipelines.get(level);
  if (pipeline === undefined) {
    pipeline = levelPipeline(access!, store!, store!.levels[level]);
    pipelines.set(level, pipeline);
  }
  return pipeline;
}

function scalarSource(name: string): ScalarSource {
  if (name === "object") return { kind: "object" };
  if (name.startsWith("attribute:") && store !== undefined) {
    const id = name.slice("attribute:".length);
    const index = store.description.attributes.findIndex((a) => a.id === id);
    if (index >= 0) return { kind: "attribute", index, components: store.description.attributes[index].components };
  }
  return { kind: "none" };
}

/**
 * Each level's share of level 0's objects, from its `object_sparsity` (a
 * fraction of its parent's): coarse levels of a tractogram keep a sample of
 * the streamlines, which the panel says (a view at a coarse level is a sample).
 */
async function objectShares(storeUrl: string, s: ZarrVectorsStore): Promise<{ shares: (number | undefined)[]; counts: (number | undefined)[] }> {
  // How many objects each level's object index lists.
  const counts = Promise.all(
    s.levels.map(async (level) => {
      if (!s.description.hasObjects) return undefined;
      try {
        const response = await fetch(new URL(`${level.path}/object_index/zarr.json`, storeUrl));
        if (!response.ok) return undefined;
        const n = Number((await response.json())?.attributes?.num_objects);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const metas = await Promise.all(
    s.levels.map(async (level) => {
      try {
        const response = await fetch(new URL(`${level.path}/zarr.json`, storeUrl));
        if (!response.ok) return undefined;
        const json = await response.json();
        return json?.attributes?.zarr_vectors_level as { object_sparsity?: number; parent_level?: number | null } | undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const share = (i: number, depth = 0): number | undefined => {
    if (depth > 32) return undefined;
    const meta = metas[i];
    if (i === 0) return 1;
    if (meta === undefined || typeof meta.object_sparsity !== "number") return undefined;
    const parent = typeof meta.parent_level === "number" ? s.levels.findIndex((l) => l.index === meta.parent_level) : i - 1;
    if (parent < 0 || parent >= i) return meta.object_sparsity;
    const above = share(parent, depth + 1);
    return above === undefined ? undefined : above * meta.object_sparsity;
  };
  return { shares: s.levels.map((_, i) => share(i)), counts: await counts };
}

async function open(storeUrl: string): Promise<StoreInfo> {
  // Listing where the server allows it: a mesh's faces that span chunks are found only so.
  access = httpAccess(storeUrl, { listing: true });
  store = await openZarrVectorsStore(access, []);
  pipelines.clear();
  const { shares, counts } = await objectShares(storeUrl, store);
  const kind = store.description.geometryKind;
  const primitive = kind === "point_cloud" ? "points" : kind === "mesh" ? "triangles" : "lines";
  const objectRead: ObjectRead = !store.description.hasObjects || primitive === "triangles" ? undefined : primitive === "lines" && store.description.linksConvention === "implicit_sequential" ? "curves" : "skeletons";
  objectReaders.clear();
  return {
    objectRead,
    axisNames: store.axisNames,
    axisUnits: store.axisUnits,
    axisScales: store.axisScales,
    bounds: { lower: Array.from(store.lowerBounds), upper: Array.from(store.upperBounds) },
    levels: store.levels.map((l, i) => ({ index: l.index, vertexCount: l.vertexCount, chunkShape: l.chunkShape, objectShare: shares[i], objects: counts[i] })),
    geometry: kind,
    primitive,
    attributes: store.description.attributes.filter((a) => a.objectValue === undefined).map((a) => ({ id: a.id, name: a.name, components: a.components })),
    warnings: store.warnings,
  };
}

async function read(key: string, forScalar: string): Promise<void> {
  const [levelText, coordsText] = key.split("|");
  const level = Number(levelText);
  const coords = coordsText.split(".").map(Number);
  try {
    // Bridges: the segments that cross into a neighbouring chunk, so lines run on unbroken.
    const data = await pipelineOf(level).download(coords, new AbortController().signal, { bridges: true });
    if (data === undefined || data.numVertices === 0) {
      post({ type: "empty", key, scalar: forScalar });
      return;
    }
    const chunk = buildChunk(data, scalarSource(forScalar));
    post({ type: "chunk", key, scalar: forScalar, chunk }, [chunk.vertices.buffer, chunk.segments.buffer, chunk.slots.buffer, chunk.objectIds.buffer, chunk.objectWeight.buffer, chunk.triangles.buffer, chunk.normals.buffer]);
  } catch (e) {
    post({ type: "error", key, scalar: forScalar, message: (e as Error).message ?? String(e) });
  }
}

const objectReaders = new Map<number, ObjectReader>();

function objectReaderOf(level: number): ObjectReader {
  let reader = objectReaders.get(level);
  if (reader === undefined) {
    reader = new ObjectReader(access!, store!.description, store!.levels[level]);
    objectReaders.set(level, reader);
  }
  return reader;
}

/** Objects whole: a batch of ids at a level, as one chunk cut into pieces of space. */
async function readObjects(key: string, level: number, mode: "curves" | "skeletons", ids: BigUint64Array, forScalar: string): Promise<void> {
  try {
    const reader = objectReaderOf(level);
    const signal = new AbortController().signal;
    const source = scalarSource(forScalar);
    let input: ChunkInput;
    let found: bigint[];
    if (mode === "curves") {
      const curves = await reader.readCurves(Array.from(ids), signal);
      found = curves.ids;
      input = curvesInput(curves.ids, curves.offsets, curves.positions);
    } else {
      const parts: { id: bigint; positions: Float32Array; edges: Uint32Array; attributes: Float32Array[] }[] = [];
      let next = 0;
      const work = async () => {
        while (next < ids.length) {
          const id = ids[next++];
          const s = await reader.readSkeleton(id, signal);
          if (s.positions.length > 0) parts.push({ id, ...s });
        }
      };
      await Promise.all(Array.from({ length: Math.min(16, ids.length) }, work));
      found = parts.map((p) => p.id);
      input = skeletonsInput(parts, store!.description.attributes.map((a) => a.components));
    }
    const foundIds = BigUint64Array.from(found);
    if (input.numVertices === 0) {
      post({ type: "objects", key, scalar: forScalar, chunk: null, found: foundIds }, [foundIds.buffer]);
      return;
    }
    const chunk: BuiltChunk = buildChunk(input, source);
    // Pieces about half a level-0 chunk across: a 2-D view's slab draws a few of them.
    const shape = store!.levels[0].chunkShape;
    sortIntoPieces(chunk, Math.min(...shape) / 2);
    post({ type: "objects", key, scalar: forScalar, chunk, found: foundIds }, [
      foundIds.buffer,
      chunk.vertices.buffer,
      chunk.segments.buffer,
      chunk.slots.buffer,
      chunk.objectIds.buffer,
      chunk.objectWeight.buffer,
      chunk.triangles.buffer,
      chunk.normals.buffer,
      ...(chunk.pieces ? [chunk.pieces.buffer] : []),
    ]);
  } catch (e) {
    post({ type: "objectsError", key, scalar: forScalar, message: (e as Error).message ?? String(e) });
  }
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const key = queue.shift()!;
    if (inFlight.has(`${scalar}#${key}`)) continue;
    const tag = `${scalar}#${key}`;
    inFlight.add(tag);
    ++running;
    void read(key, scalar).finally(() => {
      inFlight.delete(tag);
      --running;
      pump();
    });
  }
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "open") {
    open(msg.storeUrl).then(
      (info) => post({ type: "opened", info }),
      (e) => post({ type: "error", message: (e as Error).message ?? String(e) }),
    );
  } else if (msg.type === "want") {
    if (store === undefined) return;
    scalar = msg.scalar;
    queue = (msg.keys as string[]).filter((k) => !inFlight.has(`${scalar}#${k}`));
    pump();
  } else if (msg.type === "objects") {
    if (store === undefined) return;
    void readObjects(msg.key, msg.level, msg.mode, msg.ids, msg.scalar);
  }
};
