/**
 * Reading orientation images: an OME-Zarr pyramid whose arrays have one
 * axis of components per voxel (a `channel` axis, as OME-Zarr writes it, or
 * a NIfTI's fourth axis, which the app reads as `t`) beside z, y and x.
 * Each level is read as it is; the plugin does not coarsen anything, so a
 * store's coarse levels give the coarse glyphs (and a NIfTI read in place,
 * whose coarse levels are means of the finer voxels, gives the mean of
 * each box's coefficients, which for spherical harmonics is the mean ODF).
 *
 * `voxels` reads the voxels of a box that lie in some slabs (the sections
 * the views show) with all their components, as float32.  Chunks are kept
 * in a byte-bounded cache, so panning a little reads nothing again.  The
 * worker runs this; it is plain code, tested without one.
 */
import { httpAccess, openZarrArray, ShardIndexCache, ZarrArrayReader } from "neuroglancer-zarr-vectors/reader";
import { mergeLevels, parseOmeLevels, type VolumeLevel } from "../volume-view/ome.js";
import { storedOrder } from "../volume-view/volume_reader.js";
import { spatialGroup } from "./ome4.js";

export interface OrientationLevel extends VolumeLevel {
  /** Voxels along x, y and z. */
  size: [number, number, number];
  /** Components per voxel. */
  components: number;
  /** The array's element type. */
  type: string;
  /** The read chunk's shape, in the array's axis order. */
  chunk: number[];
  /** Components in one chunk (all of them, or one for a 4-D NIfTI read in place). */
  componentChunk: number;
}

/** What a store says about its orientations (attributes.orientations), when it says it. */
export interface OrientationMetadata {
  type?: "sh" | "tensor" | "vector" | "peaks";
  basis?: string;
  legacy?: boolean;
  /** "voxel": directions along the array's axes (DIPY, FSL); "world": along x, y, z (MRtrix). */
  frame?: "voxel" | "world";
  /** Tensor component order: "fsl", "dipy" or "mrtrix". */
  order?: string;
}

export interface Opened {
  levels: OrientationLevel[];
  name: string;
  /** The component axis's name in the array ("c" or "t"). */
  componentAxis: string;
  metadata: OrientationMetadata | undefined;
}

/** Voxels of a box to read: lo up to (not including) hi, in a level's x, y, z indices, kept when inside any slab. */
export interface VoxelRequest {
  lo: [number, number, number];
  hi: [number, number, number];
  /** A voxel (index v) is in a slab when -h <= n·v - d < h; none: every voxel of the box. */
  slabs?: { n: [number, number, number]; d: number; h: number }[];
}

export interface Voxels {
  /** x, y, z index per voxel. */
  indices: Int32Array;
  /** Every component of each voxel, in turn. */
  values: Float32Array;
  count: number;
}

interface OpenLevel {
  info: OrientationLevel;
  reader: ZarrArrayReader;
  /** For x, y, z, and the components: the array dimension. */
  dimOf: [number, number, number];
  componentDim: number;
  grid: number[];
  fill: number;
}

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

const CONCURRENCY = 8;

async function readJson(url: string, signal?: AbortSignal): Promise<any | undefined> {
  const response = await fetch(url, { signal });
  if (response.status === 404 || response.status === 403) return undefined;
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

/** A chunk's bytes (little-endian unless said) as float32. */
function toFloat(bytes: Uint8Array, type: keyof typeof NUMERIC, bigEndian: boolean): Float32Array {
  const Type = NUMERIC[type];
  const size = Type.BYTES_PER_ELEMENT;
  const copy = bytes.slice(0, bytes.byteLength - (bytes.byteLength % size));
  if (bigEndian && size > 1) {
    for (let i = 0; i < copy.length; i += size) copy.subarray(i, i + size).reverse();
  }
  const typed = new Type(copy.buffer);
  return typed instanceof Float32Array ? typed : Float32Array.from(typed as ArrayLike<number>);
}

export class OrientationReader {
  private levels: OpenLevel[] = [];
  private cache = new Map<string, Promise<Float32Array | undefined>>();
  private sizes = new Map<string, number>();
  private cached = 0;

  constructor(private readonly cacheBytes = 384 * 1024 * 1024) {}

  async open(url: string, signal?: AbortSignal): Promise<Opened> {
    const base = url.endsWith("/") ? url : `${url}/`;
    const group = (await readJson(`${base}zarr.json`, signal)) ?? (await readJson(`${base}.zattrs`, signal));
    if (group === undefined) throw new Error(`${base}: no zarr.json`);
    const { group: spatial, component, name } = spatialGroup(group);
    const pyramid = parseOmeLevels(base, spatial);
    const levels = mergeLevels([pyramid]);
    const { read: plainRead } = httpAccess(base);
    const shardIndexes = new ShardIndexCache();
    const axesWithComponent = (axes: string[]) => {
      const out = [...axes];
      out.splice(component, 0, name);
      return out;
    };
    this.levels = await Promise.all(
      levels.map(async (level): Promise<OpenLevel> => {
        let axes = axesWithComponent(level.axes);
        // Chunks stored transposed (a NIfTI read in place) are read in their stored order.
        const stored = await storedOrder(plainRead, level.path, axes, signal);
        const read = stored?.read ?? plainRead;
        if (stored !== undefined) axes = stored.axes;
        const array = await openZarrArray(read, level.path, signal);
        if (array === undefined) throw new Error(`${base}${level.path}: no array`);
        if (!(array.elementType in NUMERIC)) throw new Error(`${base}${level.path}: ${array.elementType} values are not read`);
        if (array.shape.length !== 4) throw new Error(`${base}${level.path}: a ${array.shape.length}-D array; orientations need 4-D (components, z, y, x)`);
        const dimOf = [0, 1, 2].map((k) => axes.indexOf("xyz"[k])) as [number, number, number];
        const componentDim = axes.indexOf(name);
        if (dimOf.includes(-1) || componentDim === -1) throw new Error(`${base}${level.path}: axes ${axes.join(", ")} are not x, y, z and ${name}`);
        const chunk = array.readChunkShape;
        const fill = Number(array.fillValue ?? 0);
        return {
          info: {
            ...level,
            axes,
            size: [array.shape[dimOf[0]], array.shape[dimOf[1]], array.shape[dimOf[2]]],
            components: array.shape[componentDim],
            type: array.elementType,
            chunk,
            componentChunk: chunk[componentDim],
          },
          reader: new ZarrArrayReader(array, read, shardIndexes),
          dimOf,
          componentDim,
          grid: array.shape.map((s, d) => Math.ceil(s / chunk[d])),
          fill: Number.isFinite(fill) ? fill : 0,
        };
      }),
    );
    this.cache.clear();
    this.sizes.clear();
    this.cached = 0;
    const attributes = group.attributes ?? group;
    const metadata = attributes?.orientations as OrientationMetadata | undefined;
    return { levels: this.levels.map((l) => l.info), name: pyramid.name, componentAxis: name, metadata: typeof metadata === "object" && metadata !== null ? metadata : undefined };
  }

  private chunk(level: OpenLevel, index: number[]): Promise<Float32Array | undefined> {
    const key = `${level.info.url}${level.info.path}|${index.join(".")}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const array = level.reader.array;
    const pending = level.reader.readChunk(index).then((bytes) => {
      const data = bytes === undefined ? undefined : toFloat(bytes, array.elementType as keyof typeof NUMERIC, array.bigEndian);
      this.remember(key, data?.byteLength ?? 0);
      return data;
    });
    pending.catch(() => this.cache.delete(key));
    this.cache.set(key, pending);
    return pending;
  }

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

  /** The voxels of a box that lie in its slabs, with every component, in x, y, z order (x fastest). */
  async voxels(index: number, request: VoxelRequest, signal: AbortSignal): Promise<Voxels> {
    const level = this.levels[index];
    if (level === undefined) throw new Error(`no level ${index}`);
    const { dimOf, componentDim, grid } = level;
    const { chunk: cs, size, components } = level.info;
    const lo = [0, 1, 2].map((k) => Math.max(0, Math.floor(request.lo[k])));
    const hi = [0, 1, 2].map((k) => Math.min(size[k], Math.ceil(request.hi[k])));
    const slabs = request.slabs;
    const inSlabs = (x: number, y: number, z: number) => {
      if (slabs === undefined || slabs.length === 0) return true;
      for (const { n, d, h } of slabs) {
        const s = n[0] * x + n[1] * y + n[2] * z - d;
        if (s >= -h && s < h) return true;
      }
      return false;
    };
    // The voxels first (cheap), then only the chunks they fall in.
    const picked: number[] = [];
    for (let z = lo[2]; z < hi[2]; ++z) for (let y = lo[1]; y < hi[1]; ++y) for (let x = lo[0]; x < hi[0]; ++x) if (inSlabs(x, y, z)) picked.push(x, y, z);
    const count = picked.length / 3;
    const indices = Int32Array.from(picked);
    const values = new Float32Array(count * components).fill(level.fill);
    // Group the voxels by spatial chunk.
    const byChunk = new Map<string, number[]>();
    const spatialChunk = [0, 0, 0];
    for (let i = 0; i < count; ++i) {
      for (let k = 0; k < 3; ++k) spatialChunk[k] = Math.floor(indices[3 * i + k] / cs[dimOf[k]]);
      const key = spatialChunk.join(",");
      let list = byChunk.get(key);
      if (list === undefined) byChunk.set(key, (list = []));
      list.push(i);
    }
    const strides = [0, 0, 0, 0];
    strides[3] = 1;
    for (let d = 2; d >= 0; --d) strides[d] = strides[d + 1] * cs[d + 1];
    const work: (() => Promise<void>)[] = [];
    for (const [key, list] of byChunk) {
      const sc = key.split(",").map(Number);
      for (let cc = 0; cc < grid[componentDim]; ++cc) {
        const chunkIndex = [0, 0, 0, 0];
        for (let k = 0; k < 3; ++k) chunkIndex[dimOf[k]] = sc[k];
        chunkIndex[componentDim] = cc;
        work.push(async () => {
          const data = await this.chunk(level, chunkIndex);
          if (data === undefined || signal.aborted) return;
          const c0 = cc * cs[componentDim];
          const c1 = Math.min(components, c0 + cs[componentDim]);
          for (const i of list) {
            let base = 0;
            for (let k = 0; k < 3; ++k) base += (indices[3 * i + k] - sc[k] * cs[dimOf[k]]) * strides[dimOf[k]];
            const out = i * components;
            for (let c = c0; c < c1; ++c) values[out + c] = data[base + (c - c0) * strides[componentDim]];
          }
        });
      }
    }
    let next = 0;
    const run = async () => {
      while (next < work.length && !signal.aborted) await work[next++]();
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, run));
    signal.throwIfAborted();
    return { indices, values, count };
  }
}
