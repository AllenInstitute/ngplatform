/**
 * A precomputed segmentation's meshes, for the segments a layer shows, read
 * as a virtual Zarr Vectors mesh store (../zarr-vectors/src/virtual/precomputed_meshes.ts)
 * that Luxar's reading worker opens as it opens any store: the layer's
 * meshes then take Luxar's mesh path (dense chunks, lit triangles in 3-D,
 * outlines in 2-D) with nothing converted or written.
 *
 * Its URL names the volume and the segments (`precomputed-meshes:<volume
 * url>#segments=<id>,<id>`); the worker reads the volume's `info` (the
 * `mesh` directory, the finest scale's resolution), the mesh directory's
 * `info`, and each segment's manifest:
 *
 * - `neuroglancer_multilod_draco`, sharded or not: `<id>.index` (or the
 *   shard entry for the id, its fragment data just before it in the same
 *   shard file), whose levels of detail become the store's levels.  The
 *   finest level kept is the finest whose fragments, estimated from their
 *   encoded sizes, come to at most `VERTEX_BUDGET` vertices over the
 *   segments; a segment with fewer levels gives its coarsest to the coarser
 *   ones.  A fragment is read (a range of the data file or shard) and
 *   decoded (Draco, by Neuroglancer's decoder) only when its cell is.
 * - legacy (`<id>:0` listing fragment files): one level, every fragment
 *   read at once, at most `LEGACY_BYTES` of them.
 * - graphene (a CAVE segmentation, `graphene+https://…`): each segment's
 *   manifest from the meshing server, its fragments read whole as legacy
 *   ones are, from the `initial/` shards or `dynamic/`.
 *
 * The volume is opened once (`MeshVolume`) and keeps each segment's
 * manifest (or fragments) by id: a store made again for one more segment
 * reads only that one.  Reads carry the layer's sign-in (`AuthHeader`, or
 * the app's own route for a Google sign-in); a server that refuses says so
 * (`SignInNeeded`), not "no meshes".
 *
 * Coordinates: a fragment's "stored model" positions through the mesh
 * `info`'s transform are nanometres; over the finest scale's resolution,
 * the volume's voxels, which is the space Neuroglancer gives the
 * segmentation layer's source.  So the layer's own transform places them.
 */
import { decodeMinishardIndex, gunzip, type RangeRead, type Sharding, shardOf } from "@ngplatform/sdk/precomputed";
import { ShardIndexCache, type ZarrVectorsStoreAccess } from "neuroglancer-zarr-vectors/reader";
import {
  applyAffine,
  composeAffine,
  decodeLegacyFragment,
  decodeMultilodManifest,
  dequantize,
  type FragmentMesh,
  type MeshStorePlan,
  type MultilodManifest,
  missingSegments,
  nodeBox,
  type PlannedFragment,
  type PlannedLevel,
  PrecomputedMeshStore,
  readEach,
} from "../zarr-vectors/src/virtual/precomputed_meshes.js";

import { MAX_SEGMENTS } from "./mesh_layers.js";

export { PrecomputedMeshStore };
export { parseMeshStoreUrl } from "./mesh_layers.js";

/**
 * At most about this many vertices at the finest level read, over all the
 * segments (Luxar's Detail, 2 M by default, then picks among the levels).
 */
export const VERTEX_BUDGET = 8_000_000;
/**
 * Vertices per encoded byte of a Draco fragment (16-bit positions), for
 * the estimate: MICrONS v1300 measures 0.3 to 0.5 at its levels of detail.
 */
export const VERTICES_PER_BYTE = 0.4;
/** A legacy mesh's fragments are read whole when its store opens: at most this many bytes. */
export const LEGACY_BYTES = 256 * 1024 * 1024;
/** Segments' manifests read at once. */
export const MANIFEST_CONCURRENCY = 8;

/** Decodes a Draco fragment without dequantizing: indices, and x y z per vertex as stored. */
export type DracoDecode = (bytes: Uint8Array, bits: number) => Promise<{ indices: Uint32Array | Uint16Array; vertexPositions: Uint32Array }>;

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function readJson(read: RangeRead, url: string): Promise<any | undefined> {
  const bytes = await read(url);
  return bytes === undefined ? undefined : JSON.parse(textOf(bytes));
}

/** A sharded mesh directory's entries by segment id, with where each starts in its shard file (the manifest's fragments end there). */
class ShardedManifests {
  private readonly minishards = new Map<string, Promise<ReturnType<typeof decodeMinishardIndex> | undefined>>();

  constructor(
    private readonly folder: string,
    private readonly sharding: Sharding,
    private readonly read: RangeRead,
  ) {}

  async manifest(id: bigint): Promise<{ bytes: Uint8Array; file: string; start: number } | undefined> {
    const { shard, minishard } = shardOf(this.sharding, id);
    const file = `${this.folder}${shard}`;
    const key = `${shard}#${minishard}`;
    let index = this.minishards.get(key);
    if (index === undefined) {
      index = this.minishard(file, minishard);
      index.catch(() => this.minishards.delete(key));
      this.minishards.set(key, index);
    }
    const entries = await index;
    const i = entries?.ids.indexOf(id) ?? -1;
    if (entries === undefined || i < 0) return undefined;
    const start = entries.starts[i];
    let bytes = await this.read(file, { offset: start, length: entries.ends[i] - start });
    if (bytes === undefined) return undefined;
    if (this.sharding.data_encoding === "gzip") bytes = await gunzip(bytes);
    return { bytes, file, start };
  }

  private async minishard(file: string, minishard: number) {
    const shardIndexSize = 16 * 2 ** this.sharding.minishard_bits;
    const at = await this.read(file, { offset: 16 * minishard, length: 16 });
    if (at === undefined) return undefined;
    const view = new DataView(at.buffer, at.byteOffset, 16);
    const start = Number(view.getBigUint64(0, true));
    const end = Number(view.getBigUint64(8, true));
    if (start === end) return undefined;
    let bytes = await this.read(file, { offset: shardIndexSize + start, length: end - start });
    if (bytes === undefined) return undefined;
    if (this.sharding.minishard_index_encoding === "gzip") bytes = await gunzip(bytes);
    return decodeMinishardIndex(bytes, shardIndexSize);
  }
}

/** A multi-resolution mesh of one segment: its manifest, and where its fragment data starts. */
interface SegmentMesh {
  object: number;
  manifest: MultilodManifest;
  file: string;
  start: number;
}

/** The power of two at or above v (at least 1). */
const ceilPow2 = (v: number) => 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(v, 1))));

/** A box's corners through an affine: the box around them. */
function boxThrough(affine: readonly number[], lower: number[], upper: number[]): { lower: number[]; upper: number[] } {
  const corners: number[] = [];
  for (let c = 0; c < 8; ++c) corners.push(c & 1 ? upper[0] : lower[0], c & 2 ? upper[1] : lower[1], c & 4 ? upper[2] : lower[2]);
  const p = applyAffine(affine, corners);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; ++i) {
    lo[i % 3] = Math.min(lo[i % 3], p[i]);
    hi[i % 3] = Math.max(hi[i % 3], p[i]);
  }
  return { lower: lo, upper: hi };
}

/**
 * Plans the store's levels from the segments' manifests (no geometry read):
 * store level i is level of detail `first + i`, each segment at its own
 * coarsest where it has fewer.  Exported for the tests.
 */
export function planMultilod(
  segments: SegmentMesh[],
  toStore: number[],
  bits: number,
  readRange: RangeRead,
  decode: DracoDecode,
  budget = VERTEX_BUDGET,
  keep: (key: string, read: (signal?: AbortSignal) => Promise<FragmentMesh>, signal?: AbortSignal) => Promise<FragmentMesh> = (_, read, signal) => read(signal),
): { levels: PlannedLevel[]; lo: number[]; hi: number[] } {
  let lods = 0;
  for (const s of segments) lods = Math.max(lods, s.manifest.lods.length);
  const lodOf = (s: SegmentMesh, level: number) => Math.min(level, s.manifest.lods.length - 1);
  const bytesAt = (level: number) => segments.reduce((n, s) => n + s.manifest.lods[lodOf(s, level)].sizes.reduce((a, b) => a + b, 0), 0);
  let first = 0;
  while (first < lods - 1 && bytesAt(first) * VERTICES_PER_BYTE > budget) ++first;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const levels: PlannedLevel[] = [];
  let chunk = 1;
  for (let level = first; level < lods; ++level) {
    const fragments: PlannedFragment[] = [];
    let edge = 0;
    for (const s of segments) {
      const lod = lodOf(s, level);
      const { positions, offsets, sizes } = s.manifest.lods[lod];
      for (let i = 0; i < positions.length; ++i) {
        if (sizes[i] === 0) continue;
        const node = nodeBox(s.manifest, lod, positions[i]);
        const box = boxThrough(toStore, node.lower, node.upper);
        for (let k = 0; k < 3; ++k) {
          lo[k] = Math.min(lo[k], box.lower[k]);
          hi[k] = Math.max(hi[k], box.upper[k]);
          edge = Math.max(edge, box.upper[k] - box.lower[k]);
        }
        const position = positions[i];
        const offset = s.start - s.manifest.dataBytes + offsets[i];
        const length = sizes[i];
        const manifest = s.manifest;
        fragments.push({
          object: s.object,
          centre: [0, 1, 2].map((k) => (box.lower[k] + box.upper[k]) / 2),
          // Kept by where it is in its file, so a store made again for more segments decodes it no more.
          read: (signal?: AbortSignal) =>
            keep(
              `${s.file}@${offset}+${length}`,
              async (shared?: AbortSignal): Promise<FragmentMesh> => {
              const bytes = await readRange(s.file, { offset, length }, shared);
              if (bytes === undefined) throw new Error(`${s.file}: a mesh fragment is missing`);
              const decoded = await decode(bytes, bits);
              return { positions: applyAffine(toStore, dequantize(decoded.vertexPositions, manifest, lod, position, bits)), triangles: decoded.indices instanceof Uint32Array ? decoded.indices : Uint32Array.from(decoded.indices) };
              },
              signal,
            ),
        });
      }
    }
    // Cells at least a node across at this level, and never smaller than a finer level's.
    chunk = Math.max(chunk, ceilPow2(edge));
    levels.push({ chunk, fragments, vertices: bytesAt(level) * VERTICES_PER_BYTE, label: `lod ${level}` });
  }
  return { levels, lo, hi };
}

/** Diagonal scaling as a 3 × 4 affine. */
const scaling = (s: number[]) => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0];

/** At most this many segments' manifests are kept, least recently used going first. */
export const MANIFEST_CACHE = 4 * MAX_SEGMENTS;
/** Decoded fragments kept, so a store made again for one more segment reads the others' fragments no more. */
export const FRAGMENT_CACHE_BYTES = 128 * 1024 * 1024;

/** A server refused to read without a sign-in (401, or 403 for a file that must be there). */
export class SignInNeeded extends Error {
  readonly signIn = true;
  constructor(url: string) {
    super(`${new URL(url).host} needs a sign-in to read meshes`);
  }
}

/** An Authorization header for the URLs under a prefix (a middleauth or ngauth token). */
export interface AuthHeader {
  prefix: string;
  value: string;
}

/**
 * Reads over http(s) with the sign-in's header where one applies: a 401
 * is a sign-in needed; a 403 is a missing file (buckets answer so) unless
 * `strict` says the file must be there.
 */
export function signedRead(headers: readonly AuthHeader[], fetchImpl: typeof fetch = fetch, strict: (url: string) => boolean = () => false): RangeRead {
  return async (url, range, signal) => {
    const h: Record<string, string> = {};
    if (range !== undefined) h.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const auth = headers.find((a) => url.startsWith(a.prefix));
    if (auth !== undefined) h.Authorization = auth.value;
    const response = await fetchImpl(url, { headers: h, signal });
    if (response.status === 401 || (response.status === 403 && strict(url))) throw new SignInNeeded(url);
    if (response.status === 404 || response.status === 403) return undefined;
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (range !== undefined && response.status === 200 && bytes.byteLength > range.length) return bytes.subarray(range.offset, range.offset + range.length);
    return bytes;
  };
}

/** Decodes a whole Draco mesh (a graphene fragment): positions as floats, and indices. */
export type DracoDecodeWhole = (bytes: Uint8Array) => Promise<{ indices: Uint32Array | Uint16Array; vertexPositions: Float32Array }>;

export interface MeshVolumeOptions {
  decode: DracoDecode;
  /** For graphene's fragments. */
  decodeWhole?: DracoDecodeWhole;
  /** Reads files; by default over http(s) with `headers`. */
  read?: RangeRead;
  headers?: readonly AuthHeader[];
  fetch?: typeof fetch;
  budget?: number;
  /** Manifests read at once (MANIFEST_CONCURRENCY). */
  concurrency?: number;
}

/** A segment's meshes read whole (legacy and graphene): in nanometres, and their bytes. */
interface WholeSegment {
  meshes: FragmentMesh[];
  bytes: number;
}

/** A graphene segmentation's URL (`https://host/segmentation/table/<name>/`): its meshing server's manifests. */
export function grapheneMeshingUrl(url: string): string | undefined {
  const m = url.match(/^(https?:\/\/[.\w:\-/]+)\/segmentation\/(?:1\.0|table)\/([^/]+)\/?$/);
  return m === null ? undefined : `${m[1]}/meshing/api/v1/table/${m[2]}`;
}

/** A data directory as http(s): `gs://` through the public endpoint, `middleauth+https://` as https. */
const httpOf = (url: string) => url.replace(/^gs:\/\/([^/]+)\/?/, "https://storage.googleapis.com/$1/").replace(/^middleauth\+/, "");

/** A small map kept to `limit` entries (or bytes), least recently used going first. */
class Lru<V> {
  private readonly map = new Map<string, { value: V; size: number }>();
  private total = 0;
  constructor(
    private readonly limit: number,
    private readonly sizeOf: (v: V) => number = () => 1,
  ) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (e === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key: string, value: V): void {
    this.delete(key);
    const size = this.sizeOf(value);
    this.map.set(key, { value, size });
    this.total += size;
    for (const [k, e] of this.map) {
      if (this.total <= this.limit || k === key) break;
      this.map.delete(k);
      this.total -= e.size;
    }
  }
  /** A value's size once known (a promise settled). */
  resize(key: string, size: number): void {
    const e = this.map.get(key);
    if (e === undefined) return;
    this.total += size - e.size;
    e.size = size;
  }
  delete(key: string): void {
    const e = this.map.get(key);
    if (e === undefined) return;
    this.map.delete(key);
    this.total -= e.size;
  }
  get size(): number {
    return this.map.size;
  }
}

/**
 * A segmentation's meshes, opened once: its infos, and each segment's
 * manifest (or, for legacy and graphene meshes, its fragments) read once
 * and kept by segment id, so the store for one more segment reads only
 * that segment's (`store`).  Decoded fragments are kept too, up to
 * FRAGMENT_CACHE_BYTES.
 */
export class MeshVolume {
  private readonly manifests = new Lru<Promise<{ bytes: Uint8Array; file: string; start: number } | undefined>>(MANIFEST_CACHE);
  private readonly wholes = new Lru<Promise<WholeSegment | undefined>>(LEGACY_BYTES, () => 0);
  private readonly fragments = new Lru<KeptFragment>(FRAGMENT_CACHE_BYTES, () => 0);
  private sharded: ShardedManifests | undefined;

  private constructor(
    readonly volume: string,
    private readonly info: any,
    private readonly meshUrl: string,
    private readonly meshInfo: any,
    private readonly read: RangeRead,
    private readonly options: MeshVolumeOptions,
    /** A graphene segmentation's manifests come from its meshing server. */
    private readonly graphene: { manifests: string; fetch: typeof fetch; headers: readonly AuthHeader[] } | undefined,
  ) {
    if (this.kind === "neuroglancer_multilod_draco" && meshInfo.sharding !== undefined) this.sharded = new ShardedManifests(meshUrl, meshInfo.sharding as Sharding, read);
  }

  /**
   * Opens a volume's meshes (`volume`: its http(s) URL, ending in "/";
   * `graphene+https://…/segmentation/table/<name>/` for a graphene one):
   * reads its `info` and its mesh directory's.
   */
  static async open(volume: string, options: MeshVolumeOptions): Promise<MeshVolume> {
    const graphene = volume.startsWith("graphene+");
    const url = graphene ? volume.slice("graphene+".length) : volume;
    const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const headers = options.headers ?? [];
    // The volume's info must be there: refused, it is a sign-in.
    const read = options.read ?? signedRead(headers, fetchImpl, (u) => u === `${url}info`);
    const info = await readJson(read, `${url}info`);
    if (info === undefined) throw new Error(`${url}: no info file`);
    if (typeof info.mesh !== "string" || info.mesh === "") throw new Error(`${url}: the segmentation has no meshes`);
    let meshUrl: string;
    let manifests: string | undefined;
    if (graphene) {
      manifests = grapheneMeshingUrl(url);
      if (manifests === undefined || typeof info.data_dir !== "string") throw new Error(`${url}: not a graphene segmentation`);
      meshUrl = new URL(`${info.mesh.replace(/\/$/, "")}/`, `${httpOf(info.data_dir).replace(/\/?$/, "/")}`).href;
    } else meshUrl = new URL(`${info.mesh.replace(/\/$/, "")}/`, url).href;
    const meshInfo = await readJson(read, `${meshUrl}info`).catch((e) => {
      if ((e as SignInNeeded).signIn) throw e;
      return undefined;
    });
    return new MeshVolume(url, info, meshUrl, meshInfo, read, options, manifests === undefined ? undefined : { manifests, fetch: fetchImpl, headers });
  }

  private get kind(): string {
    if (this.graphene !== undefined) return "graphene";
    return this.meshInfo?.["@type"] ?? "neuroglancer_legacy_mesh";
  }

  /** The finest scale's resolution, nm. */
  private get resolution(): number[] {
    return (this.info.scales?.[0]?.resolution as number[] | undefined)?.map(Number) ?? [1, 1, 1];
  }

  /** The mesh info's transform (stored to nanometres). */
  private get transform(): number[] {
    const t = this.meshInfo?.transform;
    return Array.isArray(t) && t.length === 12 ? t.map(Number) : scaling([1, 1, 1]);
  }

  /** A segment's multi-resolution manifest: read once, kept (a failed read is tried again next time). */
  private manifest(id: bigint) {
    const key = String(id);
    let found = this.manifests.get(key);
    if (found === undefined) {
      found = (async () => {
        if (this.sharded !== undefined) return this.sharded.manifest(id);
        const bytes = await this.read(`${this.meshUrl}${id}.index`);
        return bytes === undefined ? undefined : { bytes, file: `${this.meshUrl}${id}`, start: 0 };
      })();
      found.catch(() => this.manifests.delete(key));
      this.manifests.set(key, found);
    }
    return found;
  }

  /**
   * A multi-resolution fragment, read and decoded once (kept to
   * FRAGMENT_CACHE_BYTES).  Its read is shared by every cell that asks for
   * it: it is aborted only once every asker has given up (their `signal`s),
   * and then not kept.
   */
  private fragment(key: string, read: (signal?: AbortSignal) => Promise<FragmentMesh>, signal?: AbortSignal): Promise<FragmentMesh> {
    let kept = this.fragments.get(key);
    if (kept === undefined) {
      const control = new AbortController();
      const entry: KeptFragment = { mesh: read(control.signal), control, waiting: 0, settled: false, pinned: false };
      kept = entry;
      this.fragments.set(key, entry);
      entry.mesh.then(
        (m) => {
          entry.settled = true;
          this.fragments.resize(key, m.positions.byteLength + m.triangles.byteLength);
        },
        () => {
          entry.settled = true;
          if (this.fragments.get(key) === entry) this.fragments.delete(key);
        },
      );
    }
    const entry = kept;
    if (signal === undefined) {
      entry.pinned = true;
      return entry.mesh;
    }
    signal.throwIfAborted();
    ++entry.waiting;
    return new Promise<FragmentMesh>((resolve, reject) => {
      const onAbort = () => {
        if (--entry.waiting === 0 && !entry.settled && !entry.pinned) {
          entry.control.abort(signal.reason);
          if (this.fragments.get(key) === entry) this.fragments.delete(key);
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.mesh.then(
        (m) => {
          signal.removeEventListener("abort", onAbort);
          --entry.waiting;
          resolve(m);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          --entry.waiting;
          reject(e);
        },
      );
    });
  }

  /**
   * The store of `ids`' meshes: what is kept is used, and only the
   * segments not read yet are read.  Segments without a mesh are left out.
   */
  async store(ids: readonly bigint[]): Promise<PrecomputedMeshStore> {
    const wanted = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_SEGMENTS);
    const resolution = this.resolution;
    // Nanometres to the volume's voxels.
    const toVoxels = scaling(resolution.map((r) => 1 / r));
    const name = this.info.mesh;
    let plan: MeshStorePlan;
    if (this.kind === "neuroglancer_multilod_draco") {
      const bits = Number(this.meshInfo.vertex_quantization_bits ?? 10);
      // A few at a time, the kept ones not read again; a segment whose manifest cannot be read (or decoded) is left out and counted.
      const { results: found, failed, error } = await readEach(
        wanted,
        async (id) => {
          const f = await this.manifest(id);
          return f && { ...f, manifest: decodeMultilodManifest(f.bytes) };
        },
        this.options.concurrency ?? MANIFEST_CONCURRENCY,
      );
      // Refused for want of a sign-in: the layer is, not a few segments.
      if ((error as SignInNeeded | undefined)?.signIn) throw error;
      const kept = wanted.filter((_, i) => found[i] !== undefined);
      const segments: SegmentMesh[] = [];
      for (const f of found) {
        if (f === undefined) continue;
        // Unsharded, the data file starts at 0: fragment offsets count from there.
        segments.push({ object: segments.length, manifest: f.manifest, file: f.file, start: this.sharded !== undefined ? f.start : f.manifest.dataBytes });
      }
      const { levels, lo, hi } = planMultilod(segments, composeAffine(toVoxels, this.transform), bits, this.read, this.options.decode, this.options.budget, (key, read, signal) => this.fragment(key, read, signal));
      const missing = missingSegments(wanted.length, wanted.length - kept.length - failed, failed, error);
      plan = { name, ids: kept, lo, hi, levels, scales: resolution, unit: "nanometer", ...(missing ? { warnings: [missing] } : {}) };
    } else {
      const toModel = this.kind === "graphene" ? composeAffine(toVoxels, this.transform) : toVoxels;
      plan = await this.planWhole(wanted, toModel, name, resolution);
    }
    if (plan.ids.length === 0 || plan.levels.length === 0) throw new Error(`none of the ${wanted.length} segments has a mesh${plan.warnings?.[0]?.includes("could not be read") ? `: ${plan.warnings[0]}` : ""}`);
    if (!plan.lo.every(Number.isFinite)) plan = { ...plan, lo: [0, 0, 0], hi: [1, 1, 1] };
    return new PrecomputedMeshStore(plan);
  }

  /** A legacy or graphene segment's fragments, read whole once and kept (to LEGACY_BYTES over the segments). */
  private whole(id: bigint): Promise<WholeSegment | undefined> {
    const key = String(id);
    let found = this.wholes.get(key);
    if (found === undefined) {
      found = this.graphene !== undefined ? this.readGraphene(id) : this.readLegacy(id);
      this.wholes.set(key, found);
      found.then(
        (s) => this.wholes.resize(key, s?.bytes ?? 0),
        () => this.wholes.delete(key),
      );
    }
    return found;
  }

  private async readLegacy(id: bigint): Promise<WholeSegment | undefined> {
    const listing = await readJson(this.read, `${this.meshUrl}${id}:0`).catch((e) => {
      if ((e as SignInNeeded).signIn) throw e;
      return undefined;
    });
    const names = Array.isArray(listing?.fragments) ? (listing.fragments as unknown[]).filter((f): f is string => typeof f === "string") : [];
    const read = await readEach(
      names,
      async (f) => {
        // Names relative to the mesh directory (they often hold colons, which a URL would read as a scheme).
        const data = await this.read(`${this.meshUrl}${f}`);
        return data === undefined ? undefined : decodeLegacyFragment(data);
      },
      MANIFEST_CONCURRENCY,
    );
    // A fragment that cannot be read leaves the segment out, not part of it.
    if (read.failed > 0) throw read.error;
    return wholeOf(read.results.filter((m): m is FragmentMesh => m !== undefined && m.triangles.length > 0));
  }

  /**
   * A graphene segment: its manifest from the meshing server (as
   * Neuroglancer asks, `~<id>:` before each fragment), then each fragment,
   * a range of an `initial/` shard (`~<layer>/<shard>:<offset>:<size>`) or
   * a file under `dynamic/`, decoded whole (Draco).
   */
  private async readGraphene(id: bigint): Promise<WholeSegment | undefined> {
    const g = this.graphene!;
    const url = `${g.manifests}/manifest/${id}:0?verify=1&prepend_seg_ids=1`;
    const auth = g.headers.find((a) => url.startsWith(a.prefix));
    const response = await g.fetch(url, { headers: auth === undefined ? {} : { Authorization: auth.value } });
    if (response.status === 401 || response.status === 403) throw new SignInNeeded(url);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const fragments = ((await response.json())?.fragments ?? []) as unknown[];
    const decode = this.options.decodeWhole;
    if (decode === undefined) throw new Error("graphene meshes need a Draco decoder");
    const sharded = this.meshInfo?.sharding !== undefined;
    const read = await readEach(
      fragments.filter((f): f is string => typeof f === "string"),
      async (raw) => {
          const fragment = raw.startsWith("~") ? (raw.slice(1).split(/:(.+)/)[1] ?? raw) : raw;
          let data: Uint8Array | undefined;
          if (!sharded) data = await this.read(`${this.meshUrl}${fragment}`);
          else if (fragment.startsWith("~")) {
            const [file, offset, length] = fragment.slice(1).split(":");
            data = await this.read(`${this.meshUrl}initial/${file}`, { offset: Number(offset), length: Number(length) });
          } else data = await this.read(`${this.meshUrl}dynamic/${fragment}`);
          if (data === undefined) return undefined;
          const m = await decode(data);
          return { positions: m.vertexPositions, triangles: m.indices instanceof Uint32Array ? m.indices : Uint32Array.from(m.indices) } as FragmentMesh;
      },
      MANIFEST_CONCURRENCY,
    );
    // A fragment that cannot be read leaves the segment out, not part of it.
    if (read.failed > 0) throw read.error;
    return wholeOf(read.results.filter((m): m is FragmentMesh => m !== undefined && m.triangles.length > 0));
  }

  /** Legacy or graphene meshes: one level, each segment's fragments as kept. */
  private async planWhole(ids: bigint[], toModel: number[], name: string, scales: number[]): Promise<MeshStorePlan> {
    const kept: bigint[] = [];
    const fragments: PlannedFragment[] = [];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    let edge = 0;
    let bytes = 0;
    let vertices = 0;
    let failed = 0;
    let error: unknown;
    let tried = 0;
    for (const id of ids) {
      if (bytes > LEGACY_BYTES) break;
      ++tried;
      let segment: WholeSegment | undefined;
      try {
        segment = await this.whole(id);
      } catch (e) {
        // Refused for want of a sign-in: the layer is, not this segment.
        if ((e as SignInNeeded).signIn) throw e;
        // Left out and counted.
        ++failed;
        error ??= e;
        continue;
      }
      if (segment === undefined || segment.meshes.length === 0) continue;
      const object = kept.length;
      kept.push(id);
      bytes += segment.bytes;
      for (const m of segment.meshes) {
        vertices += m.positions.length / 3;
        const positions = applyAffine(toModel, m.positions);
        const flo = [Infinity, Infinity, Infinity];
        const fhi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < positions.length; ++i) {
          flo[i % 3] = Math.min(flo[i % 3], positions[i]);
          fhi[i % 3] = Math.max(fhi[i % 3], positions[i]);
        }
        for (let k = 0; k < 3; ++k) {
          lo[k] = Math.min(lo[k], flo[k]);
          hi[k] = Math.max(hi[k], fhi[k]);
          edge = Math.max(edge, fhi[k] - flo[k]);
        }
        const mesh = { positions, triangles: m.triangles };
        fragments.push({ object, centre: [0, 1, 2].map((k) => (flo[k] + fhi[k]) / 2), read: async () => mesh });
      }
    }
    const missing = missingSegments(tried, tried - kept.length - failed, failed, error);
    return { name, ids: kept, lo, hi, levels: [{ chunk: ceilPow2(edge), fragments, vertices, label: this.kind === "graphene" ? "graphene" : "legacy" }], scales, unit: "nanometer", ...(missing ? { warnings: [missing] } : {}) };
  }
}

/** A kept fragment's read, shared by the cells that ask for it. */
interface KeptFragment {
  mesh: Promise<FragmentMesh>;
  control: AbortController;
  /** Askers with a signal still waiting. */
  waiting: number;
  settled: boolean;
  /** Asked for without a signal: never aborted. */
  pinned: boolean;
}

const wholeOf = (meshes: FragmentMesh[]): WholeSegment | undefined =>
  meshes.length === 0 ? undefined : { meshes, bytes: meshes.reduce((n, m) => n + m.positions.byteLength + m.triangles.byteLength, 0) };

/**
 * Opens the store of a precomputed segmentation's meshes for `ids`
 * (`volume`: the volume's http(s) URL, ending in "/").  Reads the infos and
 * the manifests; segments without a mesh are left out.
 */
export async function openPrecomputedMeshes(volume: string, ids: readonly bigint[], options: MeshVolumeOptions): Promise<PrecomputedMeshStore> {
  return (await MeshVolume.open(volume, options)).store(ids);
}

/** The store as the Zarr Vectors reader reads one: keys, byte ranges of them, directory listings. */
export function storeAccess(store: PrecomputedMeshStore): ZarrVectorsStoreAccess {
  return {
    async read(key, options = {}) {
      const data = await store.get(key, options.signal);
      if (data === undefined) return undefined;
      const r = options.byteRange;
      if (r === undefined) return data;
      return "suffixLength" in r ? data.subarray(Math.max(0, data.length - r.suffixLength)) : data.subarray(r.offset, r.offset + r.length);
    },
    async listDirectories(key) {
      return (store.list(`${key.replace(/\/$/, "")}/`) ?? []).filter((n) => n.endsWith("/")).map((n) => n.slice(0, -1));
    },
    shardIndexes: new ShardIndexCache(),
  };
}
