/**
 * Reading an OME-Zarr pyramid for the volume view:
 *
 * - a whole coarse level, for the solid brain (x fastest, as a 3-D texture
 *   wants it);
 * - sections: a level resampled onto a plane along one RAS axis, filled
 *   chunk by chunk as chunks arrive (each texel nearest its voxel), so
 *   memory stays at a few chunks however large the level, and partial
 *   images can be shown while the rest loads.
 *
 * Chunks are kept in a byte-bounded cache, so moving a section a little, or
 * drawing another through the same chunks, reads nothing again.  The volume
 * worker runs this; it is plain code, so it is tested without one.
 */
import { httpAccess, openZarrArray, ShardIndexCache, type ZarrArrayRead, ZarrArrayReader } from "neuroglancer-zarr-vectors/reader";
import { PrecomputedScale, readInfo } from "@ngplatform/sdk/precomputed";
import { invert, mergeLevels, parseOmeLevels, scaleLevel, type VolumeLevel } from "./ome.js";
import { PRECOMPUTED } from "./sources.js";

export interface LevelInfo extends VolumeLevel {
  /** The array's shape and read-chunk shape, in its axis order. */
  shape: number[];
  chunk: number[];
  /** Voxels along x, y and z. */
  size: [number, number, number];
  /** The element type (precomputed images are read as uint8). */
  type?: string;
}

interface OpenLevel {
  info: LevelInfo;
  /** A read chunk, decoded, in the array's order and of the full chunk shape. */
  readChunk(index: number[]): Promise<Uint8Array | undefined>;
  /** The chunk's own values (before the window), for other types than uint8. */
  rawChunk?(index: number[]): Promise<Uint8Array | undefined>;
  type: keyof typeof NUMERIC;
  /** The value where there is no chunk. */
  fill: number;
  /** For x, y, z: the array dimension it is. */
  dimOf: [number, number, number];
  grid: number[];
}

/** A voxel box of a level, x, y, z, from `lo` up to (not including) `hi`. */
export interface Region {
  lo: [number, number, number];
  hi: [number, number, number];
}

export type Progress = (done: number, total: number) => void;

const CONCURRENCY = 8;

/** Runs `work` on items, a few at a time, until done or `signal` aborts. */
async function each<T>(items: T[], signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length && !signal.aborted) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  signal.throwIfAborted();
}

async function readJson(url: string, signal?: AbortSignal): Promise<any | undefined> {
  const response = await fetch(url, { signal });
  if (response.status === 404 || response.status === 403) return undefined;
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
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
  const separator = meta.chunk_key_encoding?.configuration?.separator ?? "/";
  const prefix = `${path}/c${separator}`;
  const storedJson = new TextEncoder().encode(JSON.stringify(stored));
  return {
    axes: order.map((o) => axes[o]),
    read: async (key, options) => {
      if (key === `${path}/zarr.json`) return storedJson;
      if (key.startsWith(prefix)) {
        const v = key.slice(prefix.length).split(separator);
        const logical = new Array<string>(v.length);
        order.forEach((o, d) => (logical[o] = v[d]));
        return read(prefix + logical.join(separator), options);
      }
      return read(key, options);
    },
  };
}

export class VolumeReader {
  private levels: OpenLevel[] = [];
  private cache = new Map<string, Promise<Uint8Array | undefined>>();
  private sizes = new Map<string, number>();
  private cached = 0;

  /** `cacheBytes`: decoded chunks kept, a few hundred megabytes at most. */
  constructor(private readonly cacheBytes = 256 * 1024 * 1024) {}

  private remember(key: string, bytes: number): void {
    this.sizes.set(key, bytes);
    this.cached += bytes;
    for (const [old] of this.cache) {
      if (this.cached <= this.cacheBytes) break;
      if (old === key) continue;
      this.cached -= this.sizes.get(old) ?? 0;
      this.sizes.delete(old);
      this.cache.delete(old);
    }
  }

  /** A read chunk of a level (in the array's order), decoded; shared and cached. */
  private chunk(level: OpenLevel, index: number[]): Promise<Uint8Array | undefined> {
    const key = `${level.info.url}${level.info.path}|${index.join(".")}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    // Shared by every request that wants it, so no one request cancels it.
    const pending = level.readChunk(index).then((data) => {
      this.remember(key, data?.byteLength ?? 0);
      return data;
    });
    pending.catch(() => this.cache.delete(key));
    this.cache.set(key, pending);
    return pending;
  }

  /** Opens the stores' levels (finest first), placed in `space` where they name it. */
  async open(stores: string[], space: string | undefined, signal?: AbortSignal): Promise<{ levels: LevelInfo[]; name: string; description?: string }> {
    if (stores.length === 1 && stores[0].startsWith(PRECOMPUTED)) return this.openPrecomputed(stores[0].slice(PRECOMPUTED.length), signal);
    const pyramids = await Promise.all(
      stores.map(async (store) => {
        const url = store.endsWith("/") ? store : `${store}/`;
        const group = (await readJson(`${url}zarr.json`, signal)) ?? (await readJson(`${url}.zattrs`, signal));
        if (group === undefined) throw new Error(`${url}: no zarr.json`);
        // Colour voxels packed in a uint32 (this app's RGB TIFF and NIfTI): not intensities to window.
        if (group.attributes?.ngplatform?.rendering === "rgb") throw new Error("colour (RGB) images are not drawn as volumes yet");
        return parseOmeLevels(url, group, space);
      }),
    );
    const merged = mergeLevels(pyramids);
    // One access (and shard-index cache, keyed by path in the store) per store.
    const accesses = new Map<string, { access: ReturnType<typeof httpAccess>; shardIndexes: ShardIndexCache }>();
    this.levels = await Promise.all(
      merged.map(async (level): Promise<OpenLevel> => {
        let store = accesses.get(level.url);
        if (store === undefined) accesses.set(level.url, (store = { access: httpAccess(level.url), shardIndexes: new ShardIndexCache() }));
        const { access, shardIndexes } = store;
        // Chunks stored transposed (a NIfTI read as virtual Zarr) are read in their stored order.
        const stored = await storedOrder(access.read, level.path, level.axes, signal);
        const read = stored?.read ?? access.read;
        if (stored !== undefined) level = { ...level, axes: stored.axes };
        const array = await openZarrArray(read, level.path, signal);
        if (array === undefined) throw new Error(`${level.url}${level.path}: no array`);
        const wide = array.elementType in NARROWED ? (array.elementType as keyof typeof NARROWED) : undefined;
        if (!(array.elementType in NUMERIC) && wide === undefined) throw new Error(`${level.url}${level.path}: ${array.elementType} images are not drawn`);
        if (array.shape.length !== 3) throw new Error(`${level.url}${level.path}: ${array.shape.length}-D images are not drawn (3-D only)`);
        const dimOf = [0, 1, 2].map((k) => level.axes.indexOf("xyz"[k])) as [number, number, number];
        const chunkShape = array.readChunkShape;
        const info: LevelInfo = {
          ...level,
          shape: array.shape,
          chunk: chunkShape,
          size: [array.shape[dimOf[0]], array.shape[dimOf[1]], array.shape[dimOf[2]]],
          type: wide === undefined ? array.elementType : NARROWED[wide],
        };
        const reader = new ZarrArrayReader(array, read, shardIndexes);
        const fill = Number(array.fillValue ?? 0);
        const type = (wide === undefined ? array.elementType : NARROWED[wide]) as keyof typeof NUMERIC;
        const raw = async (index: number[]) => {
          const bytes = await reader.readChunk(index);
          return bytes === undefined || wide === undefined ? bytes : narrow(bytes, wide);
        };
        return {
          info,
          readChunk: async (index) => {
            const bytes = await raw(index);
            // Other types than uint8: through the image's window, to 0..255.
            return bytes === undefined || type === "uint8" ? bytes : toUint8(values(bytes, type), this.window);
          },
          rawChunk: raw,
          type,
          fill: Number.isFinite(fill) ? fill : 0,
          dimOf,
          grid: array.shape.map((s, d) => Math.ceil(s / chunkShape[d])),
        };
      }),
    );
    this.reset();
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
      const raw = await level.rawChunk?.(chunks[i]).catch(() => undefined);
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
   * first, as arrays in z, y, x order.  A segmentation's labels are read as
   * 32-bit ones, as 64-bit labels in OME-Zarr are.
   */
  private async openPrecomputed(url: string, signal?: AbortSignal): Promise<{ levels: LevelInfo[]; name: string }> {
    const info = await readInfo(url, undefined, signal);
    if (info.type !== "image" && info.type !== "segmentation") throw new Error(`${url}: a precomputed ${info.type ?? "source"}, not an image or segmentation`);
    const labels = info.type === "segmentation";
    this.levels = info.scales
      .map((scale): OpenLevel => {
        const reader = new PrecomputedScale(url, scale, info.data_type);
        const [cx, cy, cz] = reader.chunk;
        const [sx, sy, sz] = scale.size;
        const level: LevelInfo = { ...scaleLevel(url, scale), shape: [sz, sy, sx], chunk: [cz, cy, cx], size: [sx, sy, sz] };
        const common = { fill: 0, dimOf: [2, 1, 0] as [number, number, number], grid: [reader.grid[2], reader.grid[1], reader.grid[0]] };
        if (!labels) return { info: level, readChunk: ([z, y, x]) => reader.readChunk([x, y, z]), type: "uint8", ...common };
        const raw = async ([z, y, x]: number[]) => {
          const ids = await reader.readLabels([x, y, z]);
          return ids && narrow(new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength), "uint64");
        };
        return {
          info: { ...level, type: "uint32" },
          readChunk: async (index) => {
            const bytes = await raw(index);
            return bytes && toUint8(values(bytes, "uint32"), this.window);
          },
          rawChunk: raw,
          type: "uint32",
          ...common,
        };
      })
      .sort((a, b) => a.info.voxelSize - b.info.voxelSize);
    this.reset();
    this.window = [0, 255];
    return { levels: this.levels.map((l) => l.info), name: url.replace(/\/$/, "").split("/").pop() ?? "" };
  }

  private reset(): void {
    this.cache.clear();
    this.sizes.clear();
    this.cached = 0;
  }

  /** A level, or the `region` of it, x fastest. */
  async volume(index: number, signal: AbortSignal, progress?: Progress, region?: Region): Promise<{ data: Uint8Array; size: [number, number, number] }> {
    const level = this.levels[index];
    const { chunk: cs, shape } = level.info;
    const { dimOf } = level;
    const lo = region?.lo ?? [0, 0, 0];
    const hi = region?.hi ?? level.info.size;
    const size = [0, 1, 2].map((k) => Math.max(0, hi[k] - lo[k])) as [number, number, number];
    const out = new Uint8Array(size[0] * size[1] * size[2]).fill(level.fill);
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
    await each(indices, signal, async (ci) => {
      const data = await this.chunk(level, ci);
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
    const out = new Uint8Array(size[0] * size[1] * size[2] * bytes);
    if (level.fill !== 0) new NUMERIC[type](out.buffer).fill(level.fill);
    const stride = [0, 0, 0];
    const outStride = [1, size[0], size[0] * size[1]];
    for (let k = 0; k < 3; ++k) stride[dimOf[k]] = outStride[k];
    const read = level.rawChunk ?? level.readChunk;
    const indices: number[][] = [];
    for (let a = 0; a < level.grid[0]; ++a) for (let b = 0; b < level.grid[1]; ++b) for (let c = 0; c < level.grid[2]; ++c) indices.push([a, b, c]);
    let done = 0;
    await each(indices, signal, async (ci) => {
      const data = await read(ci);
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
    await each(indices, signal, async (ci) => {
      const bytes = await read(ci);
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
    return this.region(index, region, signal, progress, (n) => new Float32Array(n));
  }

  /**
   * A box of a level's own values as 64-bit floats, which hold every 32-bit
   * integer exactly (64-bit labels come narrowed to 32 bits, an error past
   * them): labels read for copying, where 32-bit floats would round those
   * above 2^24.  Voxels outside the level are NaN.
   */
  exactRegion(index: number, region: Region, signal: AbortSignal, progress?: Progress): Promise<{ data: Float64Array; size: [number, number, number] }> {
    return this.region(index, region, signal, progress, (n) => new Float64Array(n));
  }

  private async region<T extends Float32Array | Float64Array>(index: number, region: Region, signal: AbortSignal, progress: Progress | undefined, make: (n: number) => T): Promise<{ data: T; size: [number, number, number] }> {
    const level = this.levels[index];
    const { chunk: cs, shape } = level.info;
    const { dimOf, type } = level;
    const size = [0, 1, 2].map((k) => Math.max(0, region.hi[k] - region.lo[k])) as [number, number, number];
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
    await each(indices, signal, async (ci) => {
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
    await each([...byChunk.values()], signal, async ({ index: ci, voxels }) => {
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

  /**
   * A section: the plane `axis` (0 = R, 1 = A, 2 = S) = `value` mm, over
   * `rect` = [u0, u1, v0, v1] mm along the other two axes in order, with
   * texels of about `texel` mm (at most 4096 a side), from a level.
   * `partial` gets copies of the image while it fills.
   */
  async plane(
    index: number,
    request: { axis: number; value: number; rect: number[]; texel: number },
    signal: AbortSignal,
    progress?: Progress,
    partial?: (image: { data: Uint8Array; width: number; height: number }) => void,
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    const level = this.levels[index];
    const { dimOf, grid } = level;
    const { chunk: cs, shape } = level.info;
    const { axis, value, rect, texel } = request;
    const [uAxis, vAxis] = [0, 1, 2].filter((k) => k !== axis);
    const width = Math.max(1, Math.min(4096, Math.round((rect[1] - rect[0]) / texel)));
    const height = Math.max(1, Math.min(4096, Math.round((rect[3] - rect[2]) / texel)));
    const du = (rect[1] - rect[0]) / width;
    const dv = (rect[3] - rect[2]) / height;
    const toVoxel = invert(level.info.voxelToRas);
    const voxelAt = (u: number, v: number) => {
      const p = [0, 0, 0];
      p[axis] = value;
      p[uAxis] = u;
      p[vAxis] = v;
      return [0, 1, 2].map((r) => toVoxel[4 * r] * p[0] + toVoxel[4 * r + 1] * p[1] + toVoxel[4 * r + 2] * p[2] + toVoxel[4 * r + 3]);
    };
    // Texel (a, b)'s voxel: origin + a * stepU + b * stepV.
    const origin = voxelAt(rect[0] + du / 2, rect[2] + dv / 2);
    const atU = voxelAt(rect[0] + du / 2 + du, rect[2] + dv / 2);
    const atV = voxelAt(rect[0] + du / 2, rect[2] + dv / 2 + dv);
    const stepU = [0, 1, 2].map((k) => atU[k] - origin[k]);
    const stepV = [0, 1, 2].map((k) => atV[k] - origin[k]);
    const out = new Uint8Array(width * height).fill(level.fill);

    // Each texel's chunk (flat index in the grid, -1 outside) and its offset there.
    const chunkOf = new Int32Array(width * height).fill(-1);
    const offsetOf = new Uint32Array(width * height);
    const counts = new Map<number, number>();
    const stride = [cs[1] * cs[2], cs[2], 1];
    const e = [0, 0, 0];
    for (let b = 0; b < height; ++b) {
      for (let a = 0; a < width; ++a) {
        let inside = true;
        for (let k = 0; k < 3; ++k) {
          const x = Math.round(origin[k] + a * stepU[k] + b * stepV[k]);
          const d = dimOf[k];
          if (x < 0 || x >= shape[d]) {
            inside = false;
            break;
          }
          e[d] = x;
        }
        if (!inside) continue;
        const c0 = Math.floor(e[0] / cs[0]);
        const c1 = Math.floor(e[1] / cs[1]);
        const c2 = Math.floor(e[2] / cs[2]);
        const flat = (c0 * grid[1] + c1) * grid[2] + c2;
        const t = b * width + a;
        chunkOf[t] = flat;
        offsetOf[t] = (e[0] - c0 * cs[0]) * stride[0] + (e[1] - c1 * cs[1]) * stride[1] + (e[2] - c2 * cs[2]) * stride[2];
        counts.set(flat, (counts.get(flat) ?? 0) + 1);
      }
    }
    // Each chunk's texels, grouped.
    const lists = new Map<number, Uint32Array>();
    const filled = new Map<number, number>();
    for (const [flat, n] of counts) lists.set(flat, new Uint32Array(n));
    for (let t = 0; t < chunkOf.length; ++t) {
      const flat = chunkOf[t];
      if (flat < 0) continue;
      const at = filled.get(flat) ?? 0;
      lists.get(flat)![at] = t;
      filled.set(flat, at + 1);
    }
    // Nearest the plane's middle first.
    const coords = (flat: number) => [Math.floor(flat / (grid[1] * grid[2])), Math.floor(flat / grid[2]) % grid[1], flat % grid[2]];
    const order = [...lists.keys()];
    const middle = chunkOf[(height >> 1) * width + (width >> 1)];
    if (middle >= 0) {
      const m = coords(middle);
      const distance = (flat: number) => coords(flat).reduce((s, v, k) => s + (v - m[k]) ** 2, 0);
      order.sort((x, y) => distance(x) - distance(y));
    }
    let done = 0;
    let lastPartial = performance.now();
    await each(order, signal, async (flat) => {
      const data = await this.chunk(level, coords(flat));
      if (signal.aborted) return;
      if (data !== undefined) for (const t of lists.get(flat)!) out[t] = data[offsetOf[t]];
      progress?.(++done, order.length);
      if (partial !== undefined && done < order.length && performance.now() - lastPartial > 400) {
        lastPartial = performance.now();
        partial({ data: out.slice(), width, height });
      }
    });
    return { data: out, width, height };
  }
}
