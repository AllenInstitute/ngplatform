/**
 * Reading an OME-Zarr pyramid, a precomputed image or segmentation, or a
 * NIfTI read as virtual Zarr, for the tools that measure, save or render
 * it: a level or a box of it, windowed to 0..255 (x fastest, as a 3-D
 * texture wants it) or as its own values; values at points; and a pass
 * over every stored chunk.  A whole-level read larger than a cap is
 * refused, naming its size, rather than crashing the tab.
 *
 * Chunks are kept in one byte-bounded cache shared by every tool's reader
 * (./shared_chunks.ts), so reading the same box again reads nothing, and
 * two tools reading one image hold it once.  Chunks are read many at a
 * time when they are small and a few at a time when they are big (by their
 * bytes), and ranges inside a shard skip the browser's HTTP cache (see
 * {@link storeRead}).  The volume worker runs this; it is plain code, so it
 * is tested without one.
 *
 * OME-Zarr is read in Zarr v3 or v2 (0.4, through ./zarr2.ts), and as one
 * 3-D image: size-1 t and c axes (bioformats2raw's tczyx) are read at index
 * 0, and a real time series or several channels are refused.
 */
import { joinBaseUrlAndPath } from "neuroglancer/unstable/kvstore/url.js";
import { openZarrArray, ShardIndexCache, type ZarrArrayRead, ZarrArrayReader } from "neuroglancer-zarr-vectors/reader";
import { coalesceRangeReads } from "../zarr-vectors/src/zarr_array.js";
import { httpJson, PrecomputedScale, readInfo, type Scale } from "@ngplatform/sdk/precomputed";
import { mergeLevels, parseOmeLevels, scaleLevel, type VolumeLevel } from "./ome.js";
import { chunkSource, levelKey } from "./shared_chunks.js";
import { PRECOMPUTED } from "./sources.js";
import { withZarr2 } from "./zarr2.js";

export interface LevelInfo extends VolumeLevel {
  /** The array's shape and read-chunk shape, in its axis order. */
  shape: number[];
  chunk: number[];
  /** Voxels along x, y and z. */
  size: [number, number, number];
  /** The element type the values are read as (64-bit integers narrowed to 32 bits). */
  type?: string;
}

/**
 * What a level is opened from: enough for the image chunk worker to open
 * it again and read its chunks (./shared_chunks.ts).  `stamp` is its
 * metadata, so a store written again with other metadata is not answered
 * with the chunks kept of it before.
 */
export type LevelRef = ({ kind: "ome"; level: VolumeLevel } | { kind: "precomputed"; url: string; scale: Scale; stored: string; labels: boolean }) & { stamp: string };

/** A level as opened: what it is, and its chunks' own values read from the store (kept by no one). */
export interface RawLevel {
  info: LevelInfo;
  ref: LevelRef;
  /** A stored chunk's own values, decoded, in the array's order and of the full chunk shape. */
  raw(index: number[]): Promise<Uint8Array | undefined>;
  type: keyof typeof NUMERIC;
  /** The value where there is no chunk. */
  fill: number;
  /** For x, y, z: the array dimension it is. */
  dimOf: [number, number, number];
  grid: number[];
  /** A stored chunk's bytes, decoded: what reading it holds in memory. */
  chunkBytes: number;
}

interface OpenLevel {
  info: LevelInfo;
  /** A read chunk, decoded, in the array's order and of the full chunk shape. */
  readChunk(index: number[]): Promise<Uint8Array | undefined>;
  /**
   * The chunk's own values (before the window), for other types than uint8;
   * `keep` false for a pass over every chunk, which keeps none of them.
   */
  rawChunk?(index: number[], keep?: boolean): Promise<Uint8Array | undefined>;
  type: keyof typeof NUMERIC;
  /** The value where there is no chunk. */
  fill: number;
  /** For x, y, z: the array dimension it is. */
  dimOf: [number, number, number];
  grid: number[];
  /** A stored chunk's bytes, decoded: what reading it holds in memory. */
  chunkBytes: number;
}

/** A voxel box of a level, x, y, z, from `lo` up to (not including) `hi`. */
export interface Region {
  lo: [number, number, number];
  hi: [number, number, number];
}

export type Progress = (done: number, total: number) => void;

/** The most chunks read at once: small ones, such as 64³ chunks inside shards. */
export const MAX_CONCURRENT = 32;

/** The most bytes of chunks (decoded) read at once, by default, so big chunks are read a few at a time. */
export const IN_FLIGHT_BYTES = 128 * 2 ** 20;

/**
 * How many chunks of `chunkBytes` are read at once: as many as fit in
 * `inFlight` bytes, from one up to {@link MAX_CONCURRENT}.  Requests for
 * small chunks cost more in waiting than in bytes (32 at once read a box of
 * 64³ chunks about three times as fast as 8); big ones all downloading
 * together share the link and land together.
 */
export function concurrencyFor(chunkBytes: number, inFlight = IN_FLIGHT_BYTES): number {
  return Math.max(1, Math.min(MAX_CONCURRENT, Math.floor(inFlight / Math.max(1, chunkBytes))));
}

/** The most bytes one read of a whole level or a box may make, by default: 1 GiB. */
export const MAX_READ_BYTES = 2 ** 30;

/** Bytes as people read them: "640 MB", "4.0 GB". */
function sizeText(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GB`;
  if (bytes >= 2 ** 20) return `${Math.round(bytes / 2 ** 20)} MB`;
  if (bytes >= 2 ** 10) return `${Math.round(bytes / 2 ** 10)} KB`;
  return `${bytes} bytes`;
}

/**
 * Runs `work` on items, `limit` at a time, until done or `signal` aborts.  The
 * first failure stops it: no item is started after it, the ones under way
 * are let finish, and then it is thrown, so nothing is still working on the
 * caller's output once it has the error.
 */
async function each<T>(items: T[], limit: number, signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const run = async () => {
    while (next < items.length && !signal.aborted && failure === undefined) {
      try {
        await work(items[next++]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  signal.throwIfAborted();
  if (failure !== undefined) throw failure.error;
}

/**
 * A level's chunk reads, their errors naming the chunk: a chunk that cannot
 * be read fails the read it is part of (measuring or saving a volume with a
 * hole filled in would be silently wrong).
 */
function namingChunks(level: OpenLevel): OpenLevel {
  const { url, path } = level.info;
  const where = url.endsWith("/") ? `${url}${path}` : `${url}/${path}`;
  const named =
    (read: (index: number[], keep?: boolean) => Promise<Uint8Array | undefined>) =>
    (index: number[], keep?: boolean): Promise<Uint8Array | undefined> =>
      read(index, keep).catch((error: unknown) => {
        if ((error as Error)?.name === "AbortError") throw error;
        throw new Error(`${where}: chunk ${index.join(".")} could not be read: ${(error as Error)?.message ?? error}`, { cause: error });
      });
  return { ...level, readChunk: named(level.readChunk), ...(level.rawChunk ? { rawChunk: named(level.rawChunk) } : {}) };
}

/** Element types drawn, and their typed arrays. */
const NUMERIC = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
} as const;

/** 64-bit integer labels are read as 32-bit ones (labels past 2^32 are refused, not wrapped). */
const NARROWED = { uint64: "uint32", int64: "int32" } as const;

/** A chunk of 64-bit integers (little-endian) as 32-bit ones; an error if one does not fit. */
export function narrow(bytes: Uint8Array, type: "uint64" | "int64"): Uint8Array {
  const n = Math.floor(bytes.byteLength / 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = type === "uint64" ? new Uint32Array(n) : new Int32Array(n);
  for (let i = 0; i < n; ++i) {
    const low = view.getUint32(8 * i, true);
    const high = view.getInt32(8 * i + 4, true);
    // Fits when the high word is all copies of the low word's sign (int64), or zero (uint64).
    const fits = type === "uint64" ? high === 0 : high === (low & 0x80000000 ? -1 : 0);
    if (!fits) throw new Error(`a label of ${type === "uint64" ? view.getBigUint64(8 * i, true) : view.getBigInt64(8 * i, true)} is past what 32 bits hold`);
    out[i] = type === "uint64" ? low : low | 0;
  }
  return new Uint8Array(out.buffer);
}

/**
 * An array's fill value as its element type holds it (a value out of the
 * type's range wraps as it would when stored); a float fill spelt as its
 * raw bits ("0x7fc00000") is read as those bits.
 */
export function fillOf(value: unknown, type: keyof typeof NUMERIC): number {
  const Type = NUMERIC[type];
  if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(value)), true);
    return new Type(bytes.buffer, 0, 1)[0];
  }
  const number = value === "NaN" ? NaN : value === "Infinity" ? Infinity : value === "-Infinity" ? -Infinity : Number(value ?? 0);
  return new Type([number])[0];
}

/** Each `width`-byte element's bytes reversed (big-endian to little), in a copy. */
function swapped(bytes: Uint8Array, width: number): Uint8Array {
  const out = bytes.slice();
  for (let i = 0; i + width <= out.length; i += width) out.subarray(i, i + width).reverse();
  return out;
}

/**
 * The x, y, z block of a chunk of `shape` (C order, `width` bytes an
 * element) at index 0 along its other axes; `kept` are the three spatial
 * dimensions, in order.
 */
function spatialBlock(bytes: Uint8Array, shape: number[], kept: number[], width: number): Uint8Array {
  const strides = new Array<number>(shape.length);
  for (let d = shape.length - 1, s = width; d >= 0; s *= shape[d--]) strides[d] = s;
  const [a, b, c] = kept.map((d) => shape[d]);
  const [sa, sb, sc] = kept.map((d) => strides[d]);
  const out = new Uint8Array(a * b * c * width);
  let o = 0;
  for (let i = 0; i < a; ++i) {
    for (let j = 0; j < b; ++j) {
      const base = i * sa + j * sb;
      if (sc === width) {
        out.set(bytes.subarray(base, base + c * width), o);
        o += c * width;
      } else {
        for (let k = 0; k < c; ++k, o += width) out.set(bytes.subarray(base + k * sc, base + k * sc + width), o);
      }
    }
  }
  return out;
}

/** What steps along a non-spatial axis are, in an error. */
export function stepsOf(axis: string, n: number): string {
  return axis === "t" ? `${n} time points` : axis === "c" ? `${n} channels` : `${n} steps along ${axis}`;
}

/** A chunk's bytes (little-endian) as numbers. */
function values(bytes: Uint8Array, type: keyof typeof NUMERIC): ArrayLike<number> {
  const Type = NUMERIC[type];
  const copy = bytes.slice(0, bytes.byteLength - (bytes.byteLength % Type.BYTES_PER_ELEMENT));
  return new Type(copy.buffer);
}

function toUint8(v: ArrayLike<number>, [lo, hi]: [number, number]): Uint8Array {
  const out = new Uint8Array(v.length);
  const scale = 255 / (hi - lo);
  for (let i = 0; i < v.length; ++i) {
    const x = (v[i] - lo) * scale;
    out[i] = x <= 0 || !(x === x) ? 0 : x >= 255 ? 255 : x;
  }
  return out;
}

/**
 * For an array stored with Zarr v3's transpose codec: a read that presents
 * it in its stored order (shape, chunk shape and chunk keys permuted, the
 * codec dropped), and its axes in that order; undefined for other arrays.
 */
export async function storedOrder(read: ZarrArrayRead, path: string, axes: string[], signal?: AbortSignal): Promise<{ read: ZarrArrayRead; axes: string[] } | undefined> {
  const bytes = await read(`${path}/zarr.json`, { signal });
  if (bytes === undefined) return undefined;
  const meta = JSON.parse(new TextDecoder().decode(bytes));
  const transpose = (meta?.codecs as { name: string; configuration?: { order?: unknown } }[] | undefined)?.find((c) => c?.name === "transpose");
  if (transpose === undefined) return undefined;
  const rank = meta.shape.length;
  const given = transpose.configuration?.order;
  const order: number[] = Array.isArray(given) ? given.map(Number) : given === "F" ? [...Array(rank).keys()].reverse() : [...Array(rank).keys()];
  const chunkShape: number[] = meta.chunk_grid.configuration.chunk_shape;
  const stored = {
    ...meta,
    shape: order.map((o) => meta.shape[o]),
    chunk_grid: { ...meta.chunk_grid, configuration: { ...meta.chunk_grid.configuration, chunk_shape: order.map((o) => chunkShape[o]) } },
    codecs: meta.codecs.filter((c: unknown) => c !== transpose),
    ...(Array.isArray(meta.dimension_names) ? { dimension_names: order.map((o) => meta.dimension_names[o]) } : {}),
  };
  // Chunk keys: v3's "c/0/1/2", or v2's "0.1.2" (a Fortran-order v2 array read as v3).
  const v2 = meta.chunk_key_encoding?.name === "v2";
  const separator = meta.chunk_key_encoding?.configuration?.separator ?? (v2 ? "." : "/");
  const prefix = v2 ? `${path}/` : `${path}/c${separator}`;
  const storedJson = new TextEncoder().encode(JSON.stringify(stored));
  return {
    axes: order.map((o) => axes[o]),
    read: async (key, options) => {
      if (key === `${path}/zarr.json`) return storedJson;
      if (key.startsWith(prefix)) {
        const v = key.slice(prefix.length).split(separator);
        if (v.length === rank && v.every((s) => /^\d+$/.test(s))) {
          const logical = new Array<string>(v.length);
          order.forEach((o, d) => (logical[o] = v[d]));
          return read(prefix + logical.join(separator), options);
        }
      }
      return read(key, options);
    },
  };
}

/**
 * A store's keys, read over http(s) or from this app's local and virtual
 * URLs (which its service worker answers).  Range reads, of a shard's index
 * and the chunks inside it, skip the browser's HTTP cache: Chromium answers
 * cached range reads of one URL one at a time, so 32 ranges of one shard
 * took 5–7 s, against 0.7–1.2 s uncached.  Whole keys (metadata, unsharded
 * chunks) go through the cache as usual; decoded chunks are kept by the
 * reader.  Ranges of one key asked for together are merged, as the Zarr
 * Vectors reader merges them.
 */
export function storeRead(storeUrl: string): ZarrArrayRead {
  return coalesceRangeReads(async (path, { signal, byteRange }) => {
    const url = joinBaseUrlAndPath(storeUrl, path);
    let init: RequestInit = { signal };
    if (byteRange !== undefined) {
      const range = "suffixLength" in byteRange ? `bytes=-${byteRange.suffixLength}` : `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
      init = { headers: { Range: range }, signal, cache: "no-store" };
    }
    let response = await fetch(url, init);
    // A store still being made from a file on this computer answers 503 for a while: ask again.
    for (let attempt = 0; response.status === 503 && attempt < 120; ++attempt) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)));
      signal?.throwIfAborted();
      response = await fetch(url, init);
    }
    if (response.status === 404 || response.status === 403) return undefined;
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (byteRange === undefined) return bytes;
    // A server may ignore the range and send the whole key (200): keep only what was asked for.
    let from: number;
    let length: number;
    if ("suffixLength" in byteRange) {
      length = byteRange.suffixLength;
      from = bytes.length - length;
    } else {
      length = byteRange.length;
      const start = response.status === 206 ? Number(response.headers.get("Content-Range")?.match(/bytes (\d+)-/)?.[1] ?? byteRange.offset) : 0;
      from = byteRange.offset - start;
    }
    if (from < 0) throw new Error(`${url}: the answer does not hold the bytes asked for`);
    return from === 0 && bytes.length <= length ? bytes : bytes.slice(from, from + length);
  });
}

/** Whether a store is on a server (http or https, not this page's own local and virtual stores). */
function onServer(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const here = (globalThis as { location?: { origin?: string } }).location?.origin;
  return here === undefined || new URL(url).origin !== here;
}

/** A store's reads and shard indexes, shared by its levels (the shard-index cache is keyed by path in the store). */
export type StoreAccess = { read: ZarrArrayRead; shardIndexes: ShardIndexCache };

/**
 * Opens an OME-Zarr level (of a pyramid read by {@link parseOmeLevels} and
 * {@link mergeLevels}): its array's metadata, and how its chunks are read.
 * `accesses` holds one read per store, opened as needed.
 */
export async function openOmeLevel(level: VolumeLevel, accesses: Map<string, StoreAccess>, signal?: AbortSignal): Promise<RawLevel> {
  let store = accesses.get(level.url);
  if (store === undefined) accesses.set(level.url, (store = { read: storeRead(level.url), shardIndexes: new ShardIndexCache() }));
  const { shardIndexes } = store;
  const where = `${level.url}${level.path}`;
  // Zarr v2 arrays (OME-Zarr 0.4) read as v3.
  const plain = withZarr2(store.read);
  // Chunks stored transposed (a NIfTI read as virtual Zarr, a Fortran-order v2 array) are read in their stored order.
  const stored = await storedOrder(plain, level.path, level.axes, signal);
  const read = stored?.read ?? plain;
  const axesOfArray = stored?.axes ?? level.axes;
  const array = await openZarrArray(read, level.path, signal);
  if (array === undefined) throw new Error(`${where}: no array`);
  const wide = array.elementType in NARROWED ? (array.elementType as keyof typeof NARROWED) : undefined;
  if (!(array.elementType in NUMERIC) && wide === undefined) throw new Error(`${where}: ${array.elementType} values cannot be read`);
  const rank = array.shape.length;
  if (rank !== axesOfArray.length) throw new Error(`${where}: a ${rank}-D array, but the image names ${axesOfArray.length} axes (${axesOfArray.join(", ")})`);
  // x, y and z, in the array's order.  Other axes (t, c) are read at
  // index 0: only when they are size 1, as bioformats2raw's tczyx is.
  const kept = axesOfArray.flatMap((a, d) => (["x", "y", "z"].includes(a) ? [d] : []));
  const series = axesOfArray.findIndex((a, d) => !kept.includes(d) && array.shape[d] !== 1);
  if (series !== -1) throw new Error(`${where} has ${stepsOf(axesOfArray[series], array.shape[series])}; a single 3-D image (one time point, one channel) is needed`);
  const axes = kept.map((d) => axesOfArray[d]);
  const shape = kept.map((d) => array.shape[d]);
  const chunkShape = kept.map((d) => array.readChunkShape[d]);
  const dimOf = [0, 1, 2].map((k) => axes.indexOf("xyz"[k])) as [number, number, number];
  const type = (wide === undefined ? array.elementType : NARROWED[wide]) as keyof typeof NUMERIC;
  const info: LevelInfo = { ...level, axes, shape, chunk: chunkShape, size: [shape[dimOf[0]], shape[dimOf[1]], shape[dimOf[2]]], type };
  const reader = new ZarrArrayReader(array, read, shardIndexes);
  const fill = fillOf(array.fillValue, type);
  if (wide !== undefined && fill !== Number(array.fillValue ?? 0)) throw new Error(`${where}: a fill value of ${array.fillValue} is past what 32 bits hold`);
  // A chunk's index and bytes with the size-1 axes put back and taken out again.
  const whole = (index: number[]) => {
    const full = new Array<number>(rank).fill(0);
    kept.forEach((d, i) => (full[d] = index[i]));
    return full;
  };
  // A chunk thicker than 1 along a size-1 axis (chunks may pass the array's edge) holds padding there.
  const thick = array.readChunkShape.some((s, d) => !kept.includes(d) && s !== 1);
  const raw = async (index: number[]) => {
    let bytes = await reader.readChunk(whole(index));
    if (bytes === undefined) return undefined;
    if (thick) bytes = spatialBlock(bytes, array.readChunkShape, kept, array.elementBytes);
    if (array.bigEndian && array.elementBytes > 1) bytes = swapped(bytes, array.elementBytes);
    return wide === undefined ? bytes : narrow(bytes, wide);
  };
  return {
    info,
    ref: {
      kind: "ome",
      level,
      stamp: JSON.stringify([array.shape, array.storedChunkShape, array.readChunkShape, array.elementType, array.bigEndian, array.fillValue, array.codecs, stored === undefined]),
    },
    raw,
    type,
    fill,
    dimOf,
    grid: shape.map((s, d) => Math.ceil(s / chunkShape[d])),
    chunkBytes: array.readChunkShape.reduce((a, b) => a * b, 1) * array.elementBytes,
  };
}

/**
 * A scale of a Neuroglancer precomputed image or segmentation, as an array
 * in z, y, x order.  An image's values are read as its data type (64-bit
 * ones narrowed to 32 bits, as in OME-Zarr); a segmentation's labels are
 * read as 32-bit ones, as 64-bit labels in OME-Zarr are.
 */
export function openPrecomputedScale(url: string, scale: Scale, stored: string, labels: boolean): RawLevel {
  const wide = stored in NARROWED ? (stored as keyof typeof NARROWED) : undefined;
  const type: keyof typeof NUMERIC = labels ? "uint32" : wide !== undefined ? NARROWED[wide] : (stored as keyof typeof NUMERIC);
  const reader = new PrecomputedScale(url, scale, stored);
  const [cx, cy, cz] = reader.chunk;
  const [sx, sy, sz] = scale.size;
  const info: LevelInfo = { ...scaleLevel(url, scale), shape: [sz, sy, sx], chunk: [cz, cy, cx], size: [sx, sy, sz], type };
  // Labels are stored as 64-bit integers; images as their type (one of NUMERIC, or a 64-bit one).
  const width = labels || wide !== undefined ? 8 : NUMERIC[stored as keyof typeof NUMERIC].BYTES_PER_ELEMENT;
  const raw = labels
    ? async ([z, y, x]: number[]) => {
        const ids = await reader.readLabels([x, y, z]);
        return ids && narrow(new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength), "uint64");
      }
    : async ([z, y, x]: number[]) => {
        const bytes = await reader.readValues([x, y, z]);
        return bytes && wide !== undefined ? narrow(bytes, wide) : bytes;
      };
  return {
    info,
    ref: { kind: "precomputed", url, scale, stored, labels, stamp: JSON.stringify([scale, stored, labels]) },
    raw,
    type,
    fill: 0,
    dimOf: [2, 1, 0],
    grid: [reader.grid[2], reader.grid[1], reader.grid[0]],
    chunkBytes: cx * cy * cz * width,
  };
}

export class VolumeReader {
  private levels: OpenLevel[] = [];

  /**
   * `maxReadBytes`: the most one read of a level or a box may allocate;
   * a larger one is refused with a message naming its size and the
   * coarser levels that fit, rather than crashing the tab.
   * `inFlightBytes`: the most bytes of chunks read at once
   * ({@link concurrencyFor}).  Decoded chunks are kept in the cache all the
   * tools share (./shared_chunks.ts), not by each reader.
   */
  constructor(
    readonly maxReadBytes = MAX_READ_BYTES,
    readonly inFlightBytes = IN_FLIGHT_BYTES,
  ) {}

  /** How many of a level's chunks are read at once. */
  private concurrency(level: OpenLevel): number {
    return concurrencyFor(level.chunkBytes, this.inFlightBytes);
  }

  /** Refuses a read of `size` voxels of `width` bytes each from level `index`, when it is past the cap. */
  private checkSize(index: number, size: readonly number[], width: number, region: boolean): void {
    const bytes = size[0] * size[1] * size[2] * width;
    if (bytes <= this.maxReadBytes) return;
    const scale = (i: number) => this.levels[i].info.size.map((v, k) => v / this.levels[index].info.size[k]);
    const fits = this.levels.flatMap((_, i) => {
      if (i <= index) return [];
      const f = scale(i);
      return size[0] * f[0] * size[1] * f[1] * size[2] * f[2] * width <= this.maxReadBytes ? [i] : [];
    });
    const what = region ? `A box of ${size.join(" × ")} voxels of level ${index}` : `Level ${index} (${size.join(" × ")} voxels)`;
    const advice = fits.length > 0 ? `read a coarser level (${fits.length > 1 ? `levels ${fits.join(", ")}` : `level ${fits[0]}`} fit)${region ? " or a smaller box" : ""}` : region ? "read a smaller box" : "read a box of it";
    throw new Error(`${what} is ${sizeText(bytes)}, past the ${sizeText(this.maxReadBytes)} one read may take: ${advice}`);
  }

  /** The levels this reader has opened (their keys in the shared cache). */
  private readonly opened = new Set<string>();

  /**
   * An opened level as this reader reads it: its chunks through the shared
   * cache, drawn through this reader's window.  Another reader of the same
   * image on a server shares what is kept of it.  What is kept is forgotten
   * when the same reader opens it again, and whenever a store on this
   * computer is opened (files and virtual stores, which tools here write
   * in place: a label image saved, then measured).
   */
  private adopt(level: RawLevel): OpenLevel {
    const source = chunkSource();
    const key = levelKey(level.ref);
    if (this.opened.has(key) || !onServer(level.ref.kind === "ome" ? level.ref.level.url : level.ref.url)) source.forget(level.ref);
    this.opened.add(key);
    const { ref, raw, type } = level;
    const rawChunk = (index: number[], keep = true) => source.chunk(ref, index, keep, raw);
    return namingChunks({
      info: level.info,
      readChunk: async (index) => {
        const bytes = await rawChunk(index);
        // Other types than uint8: through the image's window, to 0..255.
        return bytes === undefined || type === "uint8" ? bytes : toUint8(values(bytes, type), this.window);
      },
      rawChunk,
      type,
      fill: level.fill,
      dimOf: level.dimOf,
      grid: level.grid,
      chunkBytes: level.chunkBytes,
    });
  }

  /** Opens the stores' levels (finest first), placed in `space` where they name it. */
  async open(stores: string[], space: string | undefined, signal?: AbortSignal): Promise<{ levels: LevelInfo[]; name: string; description?: string }> {
    if (stores.length === 1 && stores[0].startsWith(PRECOMPUTED)) return this.openPrecomputed(stores[0].slice(PRECOMPUTED.length), signal);
    const pyramids = await Promise.all(
      stores.map(async (store) => {
        const url = store.endsWith("/") ? store : `${store}/`;
        // Zarr v3's zarr.json, or a v2 group's .zattrs (OME-Zarr 0.4).
        const group = (await httpJson(`${url}zarr.json`, signal)) ?? (await httpJson(`${url}.zattrs`, signal));
        if (group === undefined) throw new Error(`${url}: no zarr.json or .zattrs`);
        // Colour voxels packed in a uint32 (this app's RGB TIFF and NIfTI): not intensities to window.
        if ((group.attributes ?? group)?.ngplatform?.rendering === "rgb") throw new Error(`${url}: a colour (RGB) image; the image reader reads one value per voxel`);
        return parseOmeLevels(url, group, space);
      }),
    );
    const merged = mergeLevels(pyramids);
    // One read (and shard-index cache) per store.
    const accesses = new Map<string, StoreAccess>();
    const opened = await Promise.all(merged.map((level) => openOmeLevel(level, accesses, signal)));
    this.levels = opened.map((level) => this.adopt(level));
    this.window = [0, 255];
    const coarsest = this.levels[this.levels.length - 1];
    if (coarsest !== undefined && coarsest.type !== "uint8") this.window = await this.windowOf(coarsest, signal);
    return { levels: this.levels.map((l) => l.info), name: pyramids[0]?.name ?? "", description: pyramids.find((p) => p.description)?.description };
  }

  /** The intensities shown 0..255: the 0.5th to 99.5th percentile of a level's values. */
  private window: [number, number] = [0, 255];

  private async windowOf(level: OpenLevel, signal?: AbortSignal): Promise<[number, number]> {
    const sample: number[] = [];
    const chunks: number[][] = [];
    for (let a = 0; a < level.grid[0]; ++a) for (let b = 0; b < level.grid[1]; ++b) for (let c = 0; c < level.grid[2]; ++c) chunks.push([a, b, c]);
    const step = Math.max(1, Math.floor(chunks.length / 64));
    for (let i = 0; i < chunks.length; i += step) {
      signal?.throwIfAborted();
      // A chunk that cannot be read as numbers (a label past 32 bits) is left out of the sample.
      const raw = await level.rawChunk?.(chunks[i], false).catch(() => undefined);
      if (raw === undefined) continue;
      const v = values(raw, level.type);
      const stride = Math.max(1, Math.floor(v.length / 20000));
      for (let k = 0; k < v.length; k += stride) if (Number.isFinite(v[k])) sample.push(v[k]);
    }
    if (sample.length === 0) return [0, 1];
    sample.sort((x, y) => x - y);
    const lo = sample[Math.floor(0.005 * (sample.length - 1))];
    const hi = sample[Math.ceil(0.995 * (sample.length - 1))];
    return hi > lo ? [lo, hi] : [lo, lo + 1];
  }

  /**
   * A Neuroglancer precomputed image or segmentation: its scales, finest
   * first ({@link openPrecomputedScale}), an image drawn through the window
   * of its coarsest scale.
   */
  private async openPrecomputed(url: string, signal?: AbortSignal): Promise<{ levels: LevelInfo[]; name: string }> {
    const info = await readInfo(url, undefined, signal);
    if (info.type !== "image" && info.type !== "segmentation") throw new Error(`${url}: a precomputed ${info.type ?? "source"}, not an image or segmentation`);
    const labels = info.type === "segmentation";
    const stored = info.data_type;
    if (!labels && !(stored in NUMERIC) && !(stored in NARROWED)) throw new Error(`${url}: ${stored} values cannot be read`);
    this.levels = info.scales.map((scale) => this.adopt(openPrecomputedScale(url, scale, stored, labels))).sort((a, b) => a.info.voxelSize - b.info.voxelSize);
    this.window = [0, 255];
    const coarsest = this.levels[this.levels.length - 1];
    if (!labels && coarsest !== undefined && coarsest.type !== "uint8") this.window = await this.windowOf(coarsest, signal);
    return { levels: this.levels.map((l) => l.info), name: url.replace(/\/$/, "").split("/").pop() ?? "" };
  }

  /** The fill value as drawn: through the image's window to 0..255, as chunks are. */
  private shownFill(level: OpenLevel): number {
    return level.type === "uint8" ? level.fill : toUint8([level.fill], this.window)[0];
  }

  /** A level, or the `region` of it, x fastest. */
  async volume(index: number, signal: AbortSignal, progress?: Progress, region?: Region): Promise<{ data: Uint8Array; size: [number, number, number] }> {
    const level = this.levels[index];
    const { chunk: cs, shape } = level.info;
    const { dimOf } = level;
    const lo = region?.lo ?? [0, 0, 0];
    const hi = region?.hi ?? level.info.size;
    const size = [0, 1, 2].map((k) => Math.max(0, hi[k] - lo[k])) as [number, number, number];
    this.checkSize(index, size, 1, region !== undefined);
    const out = new Uint8Array(size[0] * size[1] * size[2]).fill(this.shownFill(level));
    // The box and the output's strides, per array dimension.
    const aLo = [0, 0, 0];
    const aHi = [0, 0, 0];
    const stride = [0, 0, 0];
    const outStride = [1, size[0], size[0] * size[1]];
    for (let k = 0; k < 3; ++k) {
      aLo[dimOf[k]] = Math.max(0, lo[k]);
      aHi[dimOf[k]] = Math.min(shape[dimOf[k]], hi[k]);
      stride[dimOf[k]] = outStride[k];
    }
    const outLo = [0, 0, 0];
    for (let k = 0; k < 3; ++k) outLo[dimOf[k]] = lo[k];
    const first = [0, 1, 2].map((d) => Math.floor(aLo[d] / cs[d]));
    const last = [0, 1, 2].map((d) => Math.ceil(aHi[d] / cs[d]) - 1);
    const indices: number[][] = [];
    for (let a = first[0]; a <= last[0]; ++a) for (let b = first[1]; b <= last[1]; ++b) for (let c = first[2]; c <= last[2]; ++c) indices.push([a, b, c]);
    let done = 0;
    await each(indices, this.concurrency(level), signal, async (ci) => {
      const data = await level.readChunk(ci);
      if (data !== undefined) {
        const origin = [0, 1, 2].map((d) => ci[d] * cs[d]);
        const from = [0, 1, 2].map((d) => Math.max(origin[d], aLo[d]));
        const to = [0, 1, 2].map((d) => Math.min(origin[d] + cs[d], aHi[d]));
        const run = to[2] - from[2];
        for (let i = from[0]; i < to[0]; ++i) {
          for (let j = from[1]; j < to[1]; ++j) {
            let src = ((i - origin[0]) * cs[1] + (j - origin[1])) * cs[2] + (from[2] - origin[2]);
            let dst = (i - outLo[0]) * stride[0] + (j - outLo[1]) * stride[1] + (from[2] - outLo[2]) * stride[2];
            if (stride[2] === 1) {
              out.set(data.subarray(src, src + run), dst);
            } else {
              for (let k = 0; k < run; ++k, ++src, dst += stride[2]) out[dst] = data[src];
            }
          }
        }
      }
      progress?.(++done, indices.length);
    });
    return { data: out, size };
  }

  /**
   * A whole level's own values (not windowed to 0..255), x fastest, as
   * little-endian bytes of its element type: for writing it out.
   */
  async rawVolume(index: number, signal: AbortSignal, progress?: Progress): Promise<{ data: Uint8Array; size: [number, number, number]; type: keyof typeof NUMERIC; fill: number }> {
    const level = this.levels[index];
    const { chunk: cs, shape, size } = level.info;
    const { dimOf, type } = level;
    const bytes = NUMERIC[type].BYTES_PER_ELEMENT;
    this.checkSize(index, size, bytes, false);
    const out = new Uint8Array(size[0] * size[1] * size[2] * bytes);
    if (level.fill !== 0) new NUMERIC[type](out.buffer).fill(level.fill);
    const stride = [0, 0, 0];
    const outStride = [1, size[0], size[0] * size[1]];
    for (let k = 0; k < 3; ++k) stride[dimOf[k]] = outStride[k];
    const read = level.rawChunk ?? level.readChunk;
    const indices: number[][] = [];
    for (let a = 0; a < level.grid[0]; ++a) for (let b = 0; b < level.grid[1]; ++b) for (let c = 0; c < level.grid[2]; ++c) indices.push([a, b, c]);
    let done = 0;
    await each(indices, this.concurrency(level), signal, async (ci) => {
      const data = await read(ci, false);
      if (data !== undefined) {
        const origin = [0, 1, 2].map((d) => ci[d] * cs[d]);
        const to = [0, 1, 2].map((d) => Math.min(origin[d] + cs[d], shape[d]));
        const run = to[2] - origin[2];
        for (let i = origin[0]; i < to[0]; ++i) {
          for (let j = origin[1]; j < to[1]; ++j) {
            const src = ((i - origin[0]) * cs[1] + (j - origin[1])) * cs[2];
            const dst = i * stride[0] + j * stride[1] + origin[2] * stride[2];
            if (stride[2] === 1) {
              out.set(data.subarray(src * bytes, (src + run) * bytes), dst * bytes);
            } else {
              for (let k = 0; k < run; ++k) out.set(data.subarray((src + k) * bytes, (src + k + 1) * bytes), (dst + k * stride[2]) * bytes);
            }
          }
        }
      }
      progress?.(++done, indices.length);
    });
    return { data: out, size, type, fill: level.fill };
  }

  /**
   * A level's own values, chunk by chunk, for a pass over every voxel
   * (counting labels): `visit` gets each stored chunk's values (in the
   * array's order and full chunk shape), the box of voxels (x, y, z) it
   * covers inside the level, `lo` up to `hi`, and the steps through
   * `values` of one voxel along x, y and z, from `values[start]` at `lo`.
   * Only chunks meeting `region`, when it is given; chunks not stored (all
   * the fill value) are left out.
   */
  async eachRawChunk(
    index: number,
    signal: AbortSignal,
    visit: (values: ArrayLike<number>, box: { lo: [number, number, number]; hi: [number, number, number]; start: number; stride: [number, number, number] }) => void,
    progress?: Progress,
    region?: Region,
  ): Promise<void> {
    const level = this.levels[index];
    const { chunk: cs, shape, size } = level.info;
    const { dimOf, type } = level;
    const lo = region?.lo ?? [0, 0, 0];
    const hi = region?.hi ?? size;
    const aLo = [0, 0, 0];
    const aHi = [0, 0, 0];
    for (let k = 0; k < 3; ++k) {
      aLo[dimOf[k]] = Math.max(0, lo[k]);
      aHi[dimOf[k]] = Math.min(shape[dimOf[k]], hi[k]);
    }
    if (aLo.some((v, d) => v >= aHi[d])) return;
    const steps = [cs[1] * cs[2], cs[2], 1];
    const stride = [0, 1, 2].map((k) => steps[dimOf[k]]) as [number, number, number];
    const read = level.rawChunk ?? level.readChunk;
    const first = [0, 1, 2].map((d) => Math.floor(aLo[d] / cs[d]));
    const last = [0, 1, 2].map((d) => Math.ceil(aHi[d] / cs[d]) - 1);
    const indices: number[][] = [];
    for (let a = first[0]; a <= last[0]; ++a) for (let b = first[1]; b <= last[1]; ++b) for (let c = first[2]; c <= last[2]; ++c) indices.push([a, b, c]);
    let done = 0;
    await each(indices, this.concurrency(level), signal, async (ci) => {
      const bytes = await read(ci, false);
      if (bytes !== undefined && !signal.aborted) {
        const data = values(bytes, level.rawChunk ? type : "uint8");
        const from = [0, 1, 2].map((d) => Math.max(ci[d] * cs[d], aLo[d]));
        const to = [0, 1, 2].map((d) => Math.min((ci[d] + 1) * cs[d], aHi[d]));
        const start = (from[0] - ci[0] * cs[0]) * steps[0] + (from[1] - ci[1] * cs[1]) * steps[1] + (from[2] - ci[2] * cs[2]);
        visit(data, {
          lo: [0, 1, 2].map((k) => from[dimOf[k]]) as [number, number, number],
          hi: [0, 1, 2].map((k) => to[dimOf[k]]) as [number, number, number],
          start,
          stride,
        });
      }
      progress?.(++done, indices.length);
    });
  }

  /**
   * A box of a level's own values (not windowed), x fastest, as numbers;
   * voxels outside the level are NaN.  For measuring: line profiles, label
   * statistics, a brush limited to an intensity range.
   */
  rawRegion(index: number, region: Region, signal: AbortSignal, progress?: Progress): Promise<{ data: Float32Array; size: [number, number, number] }> {
    return this.region(index, region, signal, progress, 4, (n) => new Float32Array(n));
  }

  /**
   * A box of a level's own values as 64-bit floats, which hold every 32-bit
   * integer exactly (64-bit labels come narrowed to 32 bits, an error past
   * them): labels read for copying, where 32-bit floats would round those
   * above 2^24.  Voxels outside the level are NaN.
   */
  exactRegion(index: number, region: Region, signal: AbortSignal, progress?: Progress): Promise<{ data: Float64Array; size: [number, number, number] }> {
    return this.region(index, region, signal, progress, 8, (n) => new Float64Array(n));
  }

  private async region<T extends Float32Array | Float64Array>(index: number, region: Region, signal: AbortSignal, progress: Progress | undefined, width: number, make: (n: number) => T): Promise<{ data: T; size: [number, number, number] }> {
    const level = this.levels[index];
    const { chunk: cs, shape } = level.info;
    const { dimOf, type } = level;
    const size = [0, 1, 2].map((k) => Math.max(0, region.hi[k] - region.lo[k])) as [number, number, number];
    this.checkSize(index, size, width, true);
    const out = make(size[0] * size[1] * size[2]);
    out.fill(NaN);
    const aLo = [0, 0, 0];
    const aHi = [0, 0, 0];
    const stride = [0, 0, 0];
    const outStride = [1, size[0], size[0] * size[1]];
    const outLo = [0, 0, 0];
    for (let k = 0; k < 3; ++k) {
      aLo[dimOf[k]] = Math.max(0, region.lo[k]);
      aHi[dimOf[k]] = Math.min(shape[dimOf[k]], region.hi[k]);
      stride[dimOf[k]] = outStride[k];
      outLo[dimOf[k]] = region.lo[k];
    }
    if (aLo.some((v, d) => v >= aHi[d])) return { data: out, size };
    // Inside the level, where no chunk is stored, the fill value.
    for (let i = aLo[0]; i < aHi[0]; ++i) {
      for (let j = aLo[1]; j < aHi[1]; ++j) {
        for (let k = aLo[2]; k < aHi[2]; ++k) out[(i - outLo[0]) * stride[0] + (j - outLo[1]) * stride[1] + (k - outLo[2]) * stride[2]] = level.fill;
      }
    }
    const read = level.rawChunk ?? level.readChunk;
    const first = [0, 1, 2].map((d) => Math.floor(aLo[d] / cs[d]));
    const last = [0, 1, 2].map((d) => Math.ceil(aHi[d] / cs[d]) - 1);
    const indices: number[][] = [];
    for (let a = first[0]; a <= last[0]; ++a) for (let b = first[1]; b <= last[1]; ++b) for (let c = first[2]; c <= last[2]; ++c) indices.push([a, b, c]);
    let done = 0;
    await each(indices, this.concurrency(level), signal, async (ci) => {
      const bytes = await read(ci);
      if (bytes !== undefined) {
        const data = values(bytes, level.rawChunk ? type : "uint8");
        const origin = [0, 1, 2].map((d) => ci[d] * cs[d]);
        const from = [0, 1, 2].map((d) => Math.max(origin[d], aLo[d]));
        const to = [0, 1, 2].map((d) => Math.min(origin[d] + cs[d], aHi[d]));
        for (let i = from[0]; i < to[0]; ++i) {
          for (let j = from[1]; j < to[1]; ++j) {
            let src = ((i - origin[0]) * cs[1] + (j - origin[1])) * cs[2] + (from[2] - origin[2]);
            let dst = (i - outLo[0]) * stride[0] + (j - outLo[1]) * stride[1] + (from[2] - outLo[2]) * stride[2];
            for (let k = from[2]; k < to[2]; ++k, ++src, dst += stride[2]) out[dst] = data[src];
          }
        }
      }
      progress?.(++done, indices.length);
    });
    return { data: out, size };
  }

  /**
   * A level's own values at points (voxel coordinates x, y, z, three a
   * point; integers at voxel centres), nearest or trilinear; NaN outside.
   * Each chunk the points need is read once, so a long line across a large
   * image reads only the chunks it passes through.
   */
  async rawPoints(index: number, points: Float64Array, method: "nearest" | "linear", signal: AbortSignal): Promise<Float64Array> {
    const level = this.levels[index];
    const { chunk: cs, shape, size } = level.info;
    const { dimOf, type } = level;
    const n = points.length / 3;
    const out = new Float64Array(n).fill(NaN);
    // The voxels needed (x, y, z packed as one number), each with its value once read.
    const pack = (x: number, y: number, z: number) => x + size[0] * (y + size[1] * z);
    const inside = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < size[0] && y < size[1] && z < size[2];
    const wanted = new Map<number, number>();
    const corners = method === "nearest" ? 1 : 8;
    for (let i = 0; i < n; ++i) {
      const p = [points[3 * i], points[3 * i + 1], points[3 * i + 2]];
      const base = method === "nearest" ? p.map(Math.round) : p.map(Math.floor);
      for (let c = 0; c < corners; ++c) {
        const x = base[0] + (c & 1);
        const y = base[1] + ((c >> 1) & 1);
        const z = base[2] + ((c >> 2) & 1);
        if (inside(x, y, z)) wanted.set(pack(x, y, z), level.fill);
      }
    }
    // Grouped by chunk, in the array's order.
    const byChunk = new Map<string, { index: number[]; voxels: number[][] }>();
    for (const key of wanted.keys()) {
      const v = [key % size[0], Math.floor(key / size[0]) % size[1], Math.floor(key / (size[0] * size[1]))];
      const e = [0, 0, 0];
      for (let k = 0; k < 3; ++k) e[dimOf[k]] = v[k];
      const ci = e.map((x, d) => Math.floor(x / cs[d]));
      const id = ci.join(".");
      let group = byChunk.get(id);
      if (group === undefined) byChunk.set(id, (group = { index: ci, voxels: [] }));
      group.voxels.push(v);
    }
    const read = level.rawChunk ?? level.readChunk;
    await each([...byChunk.values()], this.concurrency(level), signal, async ({ index: ci, voxels }) => {
      const bytes = await read(ci);
      if (bytes === undefined) return;
      const data = values(bytes, level.rawChunk ? type : "uint8");
      for (const v of voxels) {
        const e = [0, 0, 0];
        for (let k = 0; k < 3; ++k) e[dimOf[k]] = v[k];
        if (e.some((x, d) => x >= shape[d])) continue;
        wanted.set(pack(v[0], v[1], v[2]), data[((e[0] - ci[0] * cs[0]) * cs[1] + (e[1] - ci[1] * cs[1])) * cs[2] + (e[2] - ci[2] * cs[2])]);
      }
    });
    const at = (x: number, y: number, z: number) => (inside(x, y, z) ? (wanted.get(pack(x, y, z)) ?? NaN) : NaN);
    for (let i = 0; i < n; ++i) {
      const x = points[3 * i];
      const y = points[3 * i + 1];
      const z = points[3 * i + 2];
      if (method === "nearest") {
        out[i] = at(Math.round(x), Math.round(y), Math.round(z));
        continue;
      }
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const z0 = Math.floor(z);
      const f = [x - x0, y - y0, z - z0];
      let v = 0;
      let w = 0;
      for (let c = 0; c < 8; ++c) {
        const d = [c & 1, (c >> 1) & 1, (c >> 2) & 1];
        const weight = (d[0] ? f[0] : 1 - f[0]) * (d[1] ? f[1] : 1 - f[1]) * (d[2] ? f[2] : 1 - f[2]);
        if (weight === 0) continue;
        const s = at(x0 + d[0], y0 + d[1], z0 + d[2]);
        if (s !== s) continue;
        v += weight * s;
        w += weight;
      }
      out[i] = w > 0 ? v / w : NaN;
    }
    return out;
  }
}

/**
 * Readers by store, opened once, for a worker that reads several stores in
 * turn: the `keep` used last are kept open (their chunks are in the shared
 * cache, not in the readers).
 */
export function readerCache(keep: number): (store: string) => Promise<{ reader: VolumeReader; levels: Awaited<ReturnType<VolumeReader["open"]>>["levels"] }> {
  const readers = new Map<string, Promise<{ reader: VolumeReader; levels: Awaited<ReturnType<VolumeReader["open"]>>["levels"] }>>();
  return (store) => {
    let r = readers.get(store);
    if (r === undefined) {
      const reader = new VolumeReader();
      r = reader.open([store], undefined).then(({ levels }) => ({ reader, levels }));
      readers.set(store, r);
      const opened = r;
      r.catch(() => readers.get(store) === opened && readers.delete(store));
      while (readers.size > keep) readers.delete(readers.keys().next().value!);
    } else {
      // Used again: the newest.
      readers.delete(store);
      readers.set(store, r);
    }
    return r;
  };
}
