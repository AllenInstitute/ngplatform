/**
 * Reading time courses from an OME-Zarr image with a time axis (a 4-D NIfTI
 * read in place has `t` first; OME-Zarr stores name it with type "time"):
 * the values along t at some voxels, averaged over them, from the finest
 * level or (while the mouse moves over a long series) a cheaper read: a
 * coarser level, or one time chunk in several.
 *
 * Voxels are given in the array's axis order as the metadata names it (the
 * order Neuroglancer shows the source in); chunks stored transposed are read
 * in their stored order.  Each chunk is decoded to float32 once and kept in a
 * byte-bounded cache shared by every image, so moving within a chunk, or
 * pinning a voxel beside one already read, reads nothing again.  The worker
 * runs this; it is plain code, tested without one.
 */
import { httpJson } from "@ngplatform/sdk/precomputed";
import { httpAccess, openZarrArray, ShardIndexCache, ZarrArrayReader } from "neuroglancer-zarr-vectors/reader";
import { withZarr2 } from "../volume-view/zarr2.js";
import { storedOrder } from "../volume-view/volume_reader.js";

export interface SeriesInfo {
  url: string;
  /** The finest level's array path. */
  path: string;
  name: string;
  /** Axis names, in the metadata's order. */
  axes: string[];
  /** The array's shape, in the same order. */
  shape: number[];
  /** Which axis is time. */
  timeAxis: number;
  /** The time axis's unit as the store gives it ("second", "millisecond"…), if any. */
  timeUnit?: string;
  type: string;
  /** The finest level, then the coarser ones with every time point. */
  levels: SeriesLevel[];
}

export type Progress = (done: number, total: number) => void;

const NUMERIC = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
  uint64: BigUint64Array,
  int64: BigInt64Array,
} as const;

const CONCURRENCY = 8;

/** A chunk's bytes (little-endian unless said) as float32. */
export function toFloat(bytes: Uint8Array, type: keyof typeof NUMERIC, bigEndian: boolean): Float32Array {
  const Type = NUMERIC[type];
  const size = Type.BYTES_PER_ELEMENT;
  const copy = bytes.slice(0, bytes.byteLength - (bytes.byteLength % size));
  if (bigEndian && size > 1) {
    for (let i = 0; i < copy.length; i += size) copy.subarray(i, i + size).reverse();
  }
  const typed = new Type(copy.buffer);
  if (typed instanceof Float32Array) return typed;
  const out = new Float32Array(typed.length);
  for (let i = 0; i < typed.length; ++i) out[i] = Number(typed[i]);
  return out;
}

/** The axes the first dataset is placed by (OME-Zarr 0.6's coordinate system, else 0.4/0.5's `axes`). */
function baseAxes(multiscale: any): { name: string; type?: string; unit?: string }[] {
  const systems: { name: string; axes: { name: string; type?: string; unit?: string }[] }[] = multiscale.coordinateSystems ?? [];
  const firstOutput = multiscale.datasets?.[0]?.coordinateTransformations?.[0]?.output;
  const outName = typeof firstOutput === "string" ? firstOutput : firstOutput?.name;
  return (systems.find((s) => s.name === outName) ?? systems[0])?.axes ?? multiscale.axes ?? [];
}

/** The time axis among an image's axes: of type "time", else named t; -1 when none. */
export function timeAxisOf(axes: { name: string; type?: string }[]): number {
  const typed = axes.findIndex((a) => a.type === "time");
  return typed !== -1 ? typed : axes.findIndex((a) => a.name === "t");
}

/** Decoded chunks, by key, up to a number of bytes; the least recently used go first. */
export class ChunkCache {
  private entries = new Map<string, Promise<Float32Array | undefined>>();
  private sizes = new Map<string, number>();
  private bytes = 0;

  constructor(private readonly limit = 256 * 1024 * 1024) {}

  /** Whether a chunk is in the cache, read. */
  has(key: string): boolean {
    return this.sizes.has(key);
  }

  get(key: string, load: () => Promise<Float32Array | undefined>): Promise<Float32Array | undefined> {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    // Shared by every request that wants it, so no one request cancels it.
    const pending = load().then((data) => {
      if (this.entries.get(key) === pending) this.remember(key, data?.byteLength ?? 0);
      return data;
    });
    pending.catch(() => this.entries.delete(key));
    this.entries.set(key, pending);
    return pending;
  }

  private remember(key: string, bytes: number): void {
    this.sizes.set(key, bytes);
    this.bytes += bytes;
    for (const [old] of this.entries) {
      if (this.bytes <= this.limit) break;
      if (old === key) continue;
      this.bytes -= this.sizes.get(old) ?? 0;
      this.sizes.delete(old);
      this.entries.delete(old);
    }
  }
}

/** One level of the image, as read: its array's shape and chunks, and where its voxels are in the finest level's. */
export interface SeriesLevel {
  path: string;
  /** The array's shape and chunk shape, in the metadata's axis order. */
  shape: number[];
  chunk: number[];
  /**
   * Along each axis, the finest level's voxels per voxel of this level, and
   * where this level's voxel 0 centre is in the finest level's voxels
   * (1 and 0 for the finest level; 2 and 0.5 for a level halving it).
   */
  factor: number[];
  offset: number[];
}

/** How the image is read: a level, and one time chunk in every `stride` along time. */
export interface ReadPlan {
  level: number;
  stride: number;
}

/** The decoded bytes (float32) one voxel's read takes: every time chunk read at the chunk holding it. */
export function readBytes(info: SeriesInfo, plan: ReadPlan): number {
  const level = info.levels[plan.level];
  const t = info.timeAxis;
  const timeChunks = Math.ceil(level.shape[t] / level.chunk[t]);
  const perChunk = level.chunk.reduce((p, c) => p * c, 1);
  return perChunk * Math.ceil(timeChunks / plan.stride) * 4;
}

/** Decoded bytes a read while the mouse moves may take. */
export const MOVING_BYTES = 32 << 20;
/** Time points a read while the mouse moves keeps at least (all when there are fewer). */
const MOVING_SAMPLES = 16;

/**
 * The read while the mouse moves over an image whose full read is large:
 * the finest level, and densest sampling of time, whose read of one voxel
 * fits in `budget` bytes (keeping at least 16 time points); a coarser level
 * only where its chunks hold fewer voxels.  Undefined when the finest
 * level's whole series fits (it is read at once), or when nothing is
 * markedly cheaper.
 */
export function movingPlan(info: SeriesInfo, budget = MOVING_BYTES): ReadPlan | undefined {
  const fine = readBytes(info, { level: 0, stride: 1 });
  if (fine <= budget) return undefined;
  const t = info.timeAxis;
  let cheapest: { plan: ReadPlan; bytes: number } | undefined;
  for (let stride = 1; ; stride *= 2) {
    let any = false;
    for (let level = 0; level < info.levels.length; ++level) {
      const { shape, chunk } = info.levels[level];
      const samples = Math.min(shape[t], Math.ceil(Math.ceil(shape[t] / chunk[t]) / stride) * chunk[t]);
      if (stride > 1 && samples < Math.min(MOVING_SAMPLES, shape[t])) continue;
      any = true;
      const plan = { level, stride };
      const bytes = readBytes(info, plan);
      if (bytes <= budget) return plan;
      if (cheapest === undefined || bytes < cheapest.bytes) cheapest = { plan, bytes };
    }
    if (!any) break;
  }
  return cheapest !== undefined && cheapest.bytes * 4 <= fine ? cheapest.plan : undefined;
}

/** A plan in words: "level 2, 1 in 64 time points". */
export function describePlan(info: SeriesInfo, plan: ReadPlan): string {
  const parts: string[] = [];
  if (plan.level > 0) parts.push(`level ${plan.level}`);
  if (plan.stride > 1) {
    const c = info.levels[plan.level].chunk[info.timeAxis];
    parts.push(c === 1 ? `1 in ${plan.stride} time points` : `${c} in ${c * plan.stride} time points`);
  }
  return parts.join(", ");
}

/** The voxel of `level` whose centre is nearest a finest-level voxel's, along each axis. */
export function levelVoxel(level: SeriesLevel, voxel: ArrayLike<number>): number[] {
  return level.shape.map((n, a) => Math.max(0, Math.min(n - 1, Math.round((voxel[a] - level.offset[a]) / level.factor[a]))));
}

/** A dataset's scale and translation, composed in order (OME-Zarr 0.4/0.5 lists, 0.6 sequences); undefined for other kinds. */
function scaleTranslation(transforms: unknown, rank: number): { scale: number[]; translation: number[] } | undefined {
  let scale = new Array<number>(rank).fill(1);
  let translation = new Array<number>(rank).fill(0);
  let ok = true;
  const apply = (t: any) => {
    if (t?.type === "scale" && Array.isArray(t.scale) && t.scale.length === rank) {
      scale = scale.map((s, i) => s * t.scale[i]);
      translation = translation.map((v, i) => v * t.scale[i]);
    } else if (t?.type === "translation" && Array.isArray(t.translation) && t.translation.length === rank) {
      translation = translation.map((v, i) => v + t.translation[i]);
    } else if (t?.type === "sequence" && Array.isArray(t.transformations)) {
      t.transformations.forEach(apply);
    } else if (t?.type !== "identity") {
      ok = false;
    }
  };
  if (!Array.isArray(transforms)) return undefined;
  transforms.forEach(apply);
  return ok ? { scale, translation } : undefined;
}

/** A level's array, opened. */
interface LevelArray {
  reader: ZarrArrayReader;
  /** For each axis in the metadata's order, the array dimension (stored order) it is. */
  dimOf: number[];
  /** Chunk shape and chunks along each dimension, in stored order. */
  chunk: number[];
  grid: number[];
  fill: number;
}

/** A read's chunks: each chunk's index (stored order) and the voxels' offsets in it. */
interface Work {
  key: string;
  index: number[];
  offsets: number[];
}

export class SeriesReader {
  private arrays: LevelArray[] = [];
  info: SeriesInfo | undefined;

  constructor(private readonly cache = new ChunkCache()) {}

  async open(url: string, signal?: AbortSignal): Promise<SeriesInfo> {
    const base = url.endsWith("/") ? url : `${url}/`;
    const group = (await httpJson(`${base}zarr.json`, signal)) ?? (await httpJson(`${base}.zattrs`, signal));
    if (group === undefined) throw new Error(`${base}: no zarr.json`);
    const attributes = group.attributes ?? group;
    const multiscale = (attributes.ome ?? attributes)?.multiscales?.[0];
    if (multiscale === undefined) throw new Error(`${base}: not an OME-Zarr image (no multiscales)`);
    const axes = baseAxes(multiscale);
    const timeAxis = timeAxisOf(axes);
    if (timeAxis === -1) throw new Error(`the image has no time axis (its axes are ${axes.map((a) => a.name).join(", ")})`);
    const datasets: { path?: string; coordinateTransformations?: unknown }[] = multiscale.datasets ?? [];
    if (datasets[0]?.path === undefined) throw new Error(`${base}: the image has no datasets`);
    const names = axes.map((a) => a.name);
    // Zarr v2 arrays (OME-Zarr 0.4) read as v3; chunks stored transposed (a NIfTI read in place) in their stored order.
    const plain = withZarr2(httpAccess(base).read);
    const openLevel = async (path: string): Promise<LevelArray & { shape: number[]; type: string }> => {
      const stored = await storedOrder(plain, path, names, signal);
      const read = stored?.read ?? plain;
      const storedAxes = stored?.axes ?? names;
      const array = await openZarrArray(read, path, signal);
      if (array === undefined) throw new Error(`${base}${path}: no array`);
      if (!(array.elementType in NUMERIC)) throw new Error(`${base}${path}: ${array.elementType} values are not read`);
      if (array.shape.length !== names.length) throw new Error(`${base}${path}: a ${array.shape.length}-D array for ${names.length} axes`);
      const dimOf = names.map((n) => storedAxes.indexOf(n));
      const chunk = array.readChunkShape;
      const fill = Number(array.fillValue ?? 0);
      return {
        reader: new ZarrArrayReader(array, read, new ShardIndexCache()),
        dimOf,
        chunk,
        grid: array.shape.map((s, d) => Math.ceil(s / chunk[d])),
        fill: Number.isFinite(fill) ? fill : 0,
        shape: dimOf.map((d) => array.shape[d]),
        type: array.elementType,
      };
    };
    const finest = await openLevel(datasets[0].path);
    const rank = names.length;
    const own = scaleTranslation(datasets[0].coordinateTransformations, rank);
    const levels: SeriesLevel[] = [{ path: datasets[0].path, shape: finest.shape, chunk: finest.dimOf.map((d) => finest.chunk[d]), factor: new Array(rank).fill(1), offset: new Array(rank).fill(0) }];
    this.arrays = [finest];
    // Coarser levels with every time point (a level that coarsens time too is left out); one that fails to open is left out.
    const coarser = await Promise.all(datasets.slice(1).map((d) => (typeof d.path === "string" ? openLevel(d.path).catch(() => undefined) : undefined)));
    coarser.forEach((array, i) => {
      if (array === undefined || array.shape[timeAxis] !== finest.shape[timeAxis]) return;
      const placed = scaleTranslation(datasets[i + 1].coordinateTransformations, rank);
      const factor = names.map((_, a) => (own && placed ? placed.scale[a] / own.scale[a] : finest.shape[a] / array.shape[a]));
      const offset = names.map((_, a) => (own && placed ? (placed.translation[a] - own.translation[a]) / own.scale[a] : (factor[a] - 1) / 2));
      if (!(Math.abs(factor[timeAxis] - 1) < 1e-6 && Math.abs(offset[timeAxis]) < 1e-6) || !factor.every((f) => f > 0 && Number.isFinite(f))) return;
      levels.push({ path: datasets[i + 1].path!, shape: array.shape, chunk: array.dimOf.map((d) => array.chunk[d]), factor, offset });
      this.arrays.push(array);
    });
    this.info = {
      url: base,
      path: datasets[0].path,
      name: String(multiscale.name ?? base),
      axes: names,
      shape: finest.shape,
      timeAxis,
      timeUnit: axes[timeAxis].unit,
      type: finest.type,
      levels,
    };
    return this.info;
  }

  private key(level: number, index: number[]): string {
    return `${this.info!.url}${this.info!.levels[level].path}|${index.join(".")}`;
  }

  private read(level: number, index: number[]): Promise<Float32Array | undefined> {
    const { reader } = this.arrays[level];
    const { array } = reader;
    return this.cache.get(this.key(level, index), async () => {
      const bytes = await reader.readChunk(index);
      return bytes === undefined ? undefined : toFloat(bytes, array.elementType as keyof typeof NUMERIC, array.bigEndian);
    });
  }

  /** The chunks a read takes, and the voxels' offsets in each (voxels outside the image are left out). */
  private work(voxels: Int32Array, plan: ReadPlan): Work[] {
    const info = this.info!;
    const { shape, timeAxis, levels } = info;
    const rank = shape.length;
    const level = levels[plan.level];
    const { dimOf, chunk, grid } = this.arrays[plan.level];
    const td = dimOf[timeAxis];
    // Strides within a chunk, in stored order.
    const strides = new Array<number>(rank);
    strides[rank - 1] = 1;
    for (let d = rank - 2; d >= 0; --d) strides[d] = strides[d + 1] * chunk[d + 1];
    // The voxels inside the image, by the chunk they fall in (time chunk 0).
    const byChunk = new Map<string, { index: number[]; offsets: number[] }>();
    const n = Math.floor(voxels.length / rank);
    for (let v = 0; v < n; ++v) {
      const fine = voxels.subarray(v * rank, (v + 1) * rank);
      if (!fine.every((i, a) => a === timeAxis || (i >= 0 && i < shape[a]))) continue;
      const at = plan.level === 0 ? Array.from(fine) : levelVoxel(level, fine);
      const index = new Array<number>(rank).fill(0);
      let offset = 0;
      for (let a = 0; a < rank; ++a) {
        if (a === timeAxis) continue;
        const d = dimOf[a];
        index[d] = Math.floor(at[a] / chunk[d]);
        offset += (at[a] - index[d] * chunk[d]) * strides[d];
      }
      const key = index.join(".");
      let group = byChunk.get(key);
      if (group === undefined) byChunk.set(key, (group = { index, offsets: [] }));
      group.offsets.push(offset);
    }
    const work: Work[] = [];
    for (let tc = 0; tc < grid[td]; tc += plan.stride) {
      for (const group of byChunk.values()) {
        const index = [...group.index];
        index[td] = tc;
        work.push({ key: this.key(plan.level, index), index, offsets: group.offsets });
      }
    }
    return work;
  }

  /**
   * The mean over some voxels of their values at each time point (NaN
   * where none is inside the image, and at time points the plan does not
   * read).  `voxels` holds each voxel's index in the finest level along
   * every axis, in the metadata's order, one after another (the time
   * axis's entry is ignored).  `plan` reads a coarser level (the voxel
   * whose centre is nearest), or one time chunk in several; by default the
   * finest level, every time point.
   */
  async mean(voxels: Int32Array, signal: AbortSignal, progress?: Progress, plan: ReadPlan = { level: 0, stride: 1 }): Promise<Float32Array> {
    if (this.info === undefined) throw new Error("no image is open");
    const work = this.work(voxels, plan);
    const { sum, count } = this.sums();
    let next = 0;
    let done = 0;
    const run = async () => {
      while (next < work.length && !signal.aborted) {
        const item = work[next++];
        const data = await this.read(plan.level, item.index);
        if (signal.aborted) return;
        this.add(plan.level, item, data, sum, count);
        progress?.(++done, work.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, run));
    signal.throwIfAborted();
    return this.means(sum, count);
  }

  /** The finest level's mean, as `mean`, when every chunk it needs is in the cache already; else undefined, reading nothing. */
  async meanIfCached(voxels: Int32Array): Promise<Float32Array | undefined> {
    if (this.info === undefined) throw new Error("no image is open");
    const work = this.work(voxels, { level: 0, stride: 1 });
    if (!work.every((w) => this.cache.has(w.key))) return undefined;
    const { sum, count } = this.sums();
    for (const item of work) this.add(0, item, await this.read(0, item.index), sum, count);
    return this.means(sum, count);
  }

  private sums(): { sum: Float64Array; count: Uint32Array } {
    const nt = this.info!.shape[this.info!.timeAxis];
    return { sum: new Float64Array(nt), count: new Uint32Array(nt) };
  }

  private add(level: number, item: Work, data: Float32Array | undefined, sum: Float64Array, count: Uint32Array): void {
    const { dimOf, chunk, fill } = this.arrays[level];
    const td = dimOf[this.info!.timeAxis];
    const nt = sum.length;
    let stride = 1;
    for (let d = chunk.length - 1; d > td; --d) stride *= chunk[d];
    const t0 = item.index[td] * chunk[td];
    const t1 = Math.min(nt, t0 + chunk[td]);
    for (let t = t0; t < t1; ++t) {
      const at = (t - t0) * stride;
      for (const offset of item.offsets) {
        const x = data === undefined ? fill : data[at + offset];
        if (!Number.isFinite(x)) continue;
        sum[t] += x;
        count[t]++;
      }
    }
  }

  private means(sum: Float64Array, count: Uint32Array): Float32Array {
    const out = new Float32Array(sum.length);
    for (let t = 0; t < sum.length; ++t) out[t] = count[t] > 0 ? sum[t] / count[t] : NaN;
    return out;
  }
}
