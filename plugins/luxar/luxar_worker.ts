/**
 * The reading worker: one Zarr Vectors store, read in place (over HTTP, or
 * the app's local and virtual stores, which are HTTP too), its chunks
 * decoded by the Zarr Vectors reader and built for drawing (./chunk_build.ts).
 *
 * A segmentation's precomputed meshes are read the same way, as a virtual
 * store made in this worker from them (./precomputed_meshes.ts: its URL
 * names the volume and the segments).
 *
 * The main thread says which chunks it wants, most wanted first, as the
 * views change; a new list replaces the queue, and a chunk being read that
 * it no longer names is cancelled (its fetches aborted).
 *
 * The worker may be handed on to the layer's next store (plugin.ts: a
 * segmentation showing one more segment): each "open" has an `epoch`, every
 * answer carries it, and what was being read for the store before is
 * cancelled.  A segmentation's meshes are opened once (`MeshVolume`) and
 * kept across its stores, so a new store reads only the new segments'
 * manifests.
 *
 * It also reads a layer's chosen objects whole, by id, through the
 * reader's object index (`ObjectReader`): a batch of ids at a time, built
 * as one chunk (its segments sorted into pieces of space, for culling).
 *
 * Messages in:  { type: "open", storeUrl, epoch, headers }   headers: the sign-in's (precomputed_meshes.AuthHeader)
 *               { type: "want", keys, scalar }    keys "<level>|x.y.z"; scalar as styles.scalarOf
 *               { type: "objects", key, level, mode, ids, scalar }   mode "curves" | "skeletons"
 *               { type: "cancelObjects" }         the objects being read are no longer wanted
 * Messages out (each with its `epoch`):
 *               { type: "opened", info } | { type: "error", key?, message, signIn? }
 *               { type: "warning", message }    a mesh store's, after it opened (a fragment that failed)
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
import { decodeDracoPartitioned } from "neuroglancer/unstable/mesh/draco/index.js";
import { decodeDraco } from "neuroglancer/unstable/mesh/draco/index.js";
import { type AuthHeader, MeshVolume, parseMeshStoreUrl, type PrecomputedMeshStore, storeAccess } from "./precomputed_meshes.js";
import { ReadQueue } from "./read_queue.js";
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
/** The store's open: answers carry it, and a read for an earlier one says nothing. */
let epoch = 0;
/** The object reads in flight. */
const readingObjects = new Set<AbortController>();
/** A segmentation's meshes, kept across its stores (by volume and sign-in). */
let meshVolume: { key: string; volume: Promise<MeshVolume> } | undefined;

const post = (message: Record<string, unknown>, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ ...message, epoch }, transfer);

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
async function objectShares(s: ZarrVectorsStore): Promise<{ shares: (number | undefined)[]; counts: (number | undefined)[] }> {
  // How many objects each level's object index lists.
  const counts = Promise.all(
    s.levels.map(async (level) => {
      if (!s.description.hasObjects) return undefined;
      try {
        const n = Number((await readJson(`${level.path}/object_index/zarr.json`))?.attributes?.num_objects);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const metas = await Promise.all(
    s.levels.map(async (level) => {
      try {
        const json = await readJson(`${level.path}/zarr.json`);
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

/** A Draco mesh fragment, its positions left as stored (integers, not dequantized: Neuroglancer's decoder, unpartitioned). */
async function dracoFragment(bytes: Uint8Array, bits: number): Promise<{ indices: Uint32Array | Uint16Array; vertexPositions: Uint32Array }> {
  const mesh = await decodeDracoPartitioned(bytes, bits, false);
  return { indices: mesh.indices, vertexPositions: mesh.vertexPositions as Uint32Array };
}

/** A JSON key of the store, through its access (over HTTP, or the virtual store here); undefined when it has none. */
async function readJson(path: string): Promise<any | undefined> {
  const bytes = await access!.read(path, {});
  return bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes));
}

/** A graphene fragment decoded whole. */
async function dracoWhole(bytes: Uint8Array): Promise<{ indices: Uint32Array | Uint16Array; vertexPositions: Float32Array }> {
  const mesh = await decodeDraco(bytes);
  return { indices: mesh.indices, vertexPositions: mesh.vertexPositions as Float32Array };
}

/** Drops what the store before had: its reads cancelled, its queue and readers gone. */
/** Stops passing on the store's later warnings. */
let offWarnings: (() => void) | undefined;

function reset(): void {
  offWarnings?.();
  offWarnings = undefined;
  chunkReads.cancelAll();
  for (const c of readingObjects) c.abort();
  readingObjects.clear();
  store = undefined;
  access = undefined;
  pipelines.clear();
  objectReaders.clear();
}

async function open(storeUrl: string, headers: AuthHeader[]): Promise<StoreInfo> {
  const at = epoch;
  const meshes = parseMeshStoreUrl(storeUrl);
  let opening: ZarrVectorsStoreAccess;
  let meshStore: PrecomputedMeshStore | undefined;
  // A segmentation's precomputed meshes: the store is made here, its fragments read and decoded (Draco) as its cells are asked for.
  if (meshes !== undefined) {
    const key = JSON.stringify([meshes.volume, headers]);
    if (meshVolume?.key !== key) {
      const volume = MeshVolume.open(meshes.volume, { decode: dracoFragment, decodeWhole: dracoWhole, headers });
      meshVolume = { key, volume };
      volume.catch(() => {
        if (meshVolume?.volume === volume) meshVolume = undefined;
      });
    }
    meshStore = await (await meshVolume.volume).store(meshes.ids);
    opening = storeAccess(meshStore);
  }
  // Listing where the server allows it: a mesh's faces that span chunks are found only so.
  else opening = httpAccess(storeUrl, { listing: true });
  const opened = await openZarrVectorsStore(opening, []);
  // Another store was opened meanwhile: this one is not used.
  if (at !== epoch) throw new Superseded();
  access = opening;
  store = opened;
  // Said later (a fragment that still fails after its retries): passed on as it comes.
  offWarnings = meshStore?.onWarning((message) => post({ type: "warning", message }));
  pipelines.clear();
  const { shares, counts } = await objectShares(store);
  if (at !== epoch) throw new Superseded();
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
    // The mesh store's own (segments with no mesh) with the reader's.
    warnings: [...store.warnings, ...(meshStore?.warnings ?? [])],
  };
}

/** An open answered after another store was opened: nothing is said of it. */
class Superseded extends Error {}

async function read(key: string, forScalar: string, signal: AbortSignal): Promise<void> {
  const [levelText, coordsText] = key.split("|");
  const level = Number(levelText);
  const coords = coordsText.split(".").map(Number);
  try {
    // Bridges: the segments that cross into a neighbouring chunk, so lines run on unbroken.
    const data = await pipelineOf(level).download(coords, signal, { bridges: true });
    if (signal.aborted) return;
    if (data === undefined || data.numVertices === 0) {
      post({ type: "empty", key, scalar: forScalar });
      return;
    }
    const chunk = buildChunk(data, scalarSource(forScalar));
    post({ type: "chunk", key, scalar: forScalar, chunk }, [chunk.vertices.buffer, chunk.segments.buffer, chunk.slots.buffer, chunk.objectIds.buffer, chunk.objectWeight.buffer, chunk.triangles.buffer, chunk.normals.buffer]);
  } catch (e) {
    // Cancelled: no longer wanted, so nothing to say (it is not a failure to try again later).
    if (signal.aborted) return;
    post({ type: "error", key, scalar: forScalar, message: (e as Error).message ?? String(e), signIn: (e as { signIn?: boolean }).signIn === true });
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
  const control = new AbortController();
  const signal = control.signal;
  readingObjects.add(control);
  try {
    const reader = objectReaderOf(level);
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
    if (signal.aborted) return;
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
    if (!signal.aborted) post({ type: "objectsError", key, scalar: forScalar, message: (e as Error).message ?? String(e) });
  } finally {
    readingObjects.delete(control);
  }
}

/** The chunk reads: at most CONCURRENCY at once, those no longer wanted cancelled (./read_queue.ts). */
const chunkReads = new ReadQueue(read, CONCURRENCY);

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "open") {
    reset();
    epoch = msg.epoch ?? epoch + 1;
    open(msg.storeUrl, msg.headers ?? []).then(
      (info) => post({ type: "opened", info }),
      (e) => {
        if (!(e instanceof Superseded)) post({ type: "error", message: (e as Error).message ?? String(e), signIn: (e as { signIn?: boolean }).signIn === true });
      },
    );
  } else if (msg.type === "want") {
    if (store === undefined) return;
    // Reads no longer wanted (another scalar, or out of view) are cancelled.
    chunkReads.want(msg.keys as string[], msg.scalar);
  } else if (msg.type === "cancelObjects") {
    for (const c of readingObjects) c.abort();
    readingObjects.clear();
  } else if (msg.type === "objects") {
    if (store === undefined) return;
    void readObjects(msg.key, msg.level, msg.mode, msg.ids, msg.scalar);
  }
};
