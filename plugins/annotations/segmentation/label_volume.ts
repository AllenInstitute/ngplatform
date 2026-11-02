/**
 * A label volume held in the page: voxels in chunks of 64³, made only where
 * something is painted, so a mask on a whole-brain grid costs what is drawn
 * on it.  It answers as an OME-Zarr store (Zarr v3, raw little-endian
 * chunks), with a pyramid whose coarser levels are made from the level
 * below when asked for (a coarse voxel takes the first label among the
 * eight it covers, so thin strokes still show zoomed out) and kept until a
 * stroke changes them.
 *
 * Voxels are x fastest, in a chunk and in a block; chunk (cx, cy, cz) is
 * key cx + gx·(cy + gy·cz) at level 0.
 */
import { type LevelGrid, omeZarrMetadata, pyramidGrids } from "../../registration/volume_io.js";
import type { Mat4 } from "../geometry.js";

export type LabelType = "uint8" | "uint16" | "uint32";
export type LabelArray = Uint8Array | Uint16Array | Uint32Array;

export const LABEL_ARRAYS = { uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array } as const;
export const LABEL_MAX: Record<LabelType, number> = { uint8: 255, uint16: 65535, uint32: 4294967295 };

export const CHUNK = 64;
const C3 = CHUNK * CHUNK * CHUNK;

export interface Box {
  lo: [number, number, number];
  /** Exclusive. */
  hi: [number, number, number];
}

export class LabelVolume {
  readonly grid: [number, number, number];
  private readonly chunks = new Map<number, LabelArray>();
  /** Coarser levels' chunks, made when asked for (null: nothing there). */
  private readonly coarse: Map<string, LabelArray | null>[];
  readonly levels: LevelGrid[];
  private metadata: Map<string, Uint8Array> | undefined;
  /** Counts each change, for whoever caches what it read. */
  version = 0;

  constructor(
    readonly size: [number, number, number],
    readonly type: LabelType,
    readonly voxelToRas: Mat4,
    readonly name = "labels",
  ) {
    this.grid = size.map((n) => Math.ceil(n / CHUNK)) as [number, number, number];
    // A coarse voxel sums up the 2 × 2 × 2 below it, so it is placed at
    // their centre (as a mean would be): placed at its first voxel instead,
    // a stroke one section thick would show half a coarse voxel off, often
    // in the next section, when zoomed out.
    this.levels = pyramidGrids({ size, voxelToRas }, false, CHUNK);
    this.coarse = this.levels.map(() => new Map());
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  /** Bytes held in chunks at level 0. */
  get bytes(): number {
    return this.chunks.size * C3 * LABEL_ARRAYS[this.type].BYTES_PER_ELEMENT;
  }

  key(cx: number, cy: number, cz: number): number {
    return cx + this.grid[0] * (cy + this.grid[1] * cz);
  }

  coords(key: number): [number, number, number] {
    const [gx, gy] = this.grid;
    return [key % gx, Math.floor(key / gx) % gy, Math.floor(key / (gx * gy))];
  }

  inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.size[0] && y < this.size[1] && z < this.size[2];
  }

  get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return 0;
    const c = this.chunks.get(this.key(x >> 6, y >> 6, z >> 6));
    return c === undefined ? 0 : c[(x & 63) + CHUNK * ((y & 63) + CHUNK * (z & 63))];
  }

  /** A chunk by key, made (zeros) when `create`. */
  chunk(key: number, create = false): LabelArray | undefined {
    let c = this.chunks.get(key);
    if (c === undefined && create) {
      c = new LABEL_ARRAYS[this.type](C3);
      this.chunks.set(key, c);
    }
    return c;
  }

  /** The keys of the chunks there are. */
  keys(): number[] {
    return [...this.chunks.keys()];
  }

  /** Puts a chunk in (or, undefined, takes it out): undo and redo do. */
  putChunk(key: number, data: LabelArray | undefined): void {
    if (data === undefined) this.chunks.delete(key);
    else this.chunks.set(key, data);
    this.changed(key);
  }

  /** Marks a chunk changed: the coarser chunks over it are made again when next asked for. */
  changed(key: number): void {
    const [cx, cy, cz] = this.coords(key);
    for (let level = 1; level < this.levels.length; ++level) this.coarse[level].delete(`${cx >> level}/${cy >> level}/${cz >> level}`);
    ++this.version;
  }

  /** Index of a voxel inside its chunk. */
  static offset(x: number, y: number, z: number): number {
    return (x & 63) + CHUNK * ((y & 63) + CHUNK * (z & 63));
  }

  // ---------------------------------------------------------- reading out

  /** The box of the voxels that are not 0; undefined when there are none. */
  paintedBox(value?: number): Box | undefined {
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const [key, c] of this.chunks) {
      const [cx, cy, cz] = this.coords(key);
      let i = 0;
      for (let z = 0; z < CHUNK; ++z) {
        for (let y = 0; y < CHUNK; ++y) {
          for (let x = 0; x < CHUNK; ++x, ++i) {
            const v = c[i];
            if (v === 0 || (value !== undefined && v !== value)) continue;
            const X = cx * CHUNK + x;
            const Y = cy * CHUNK + y;
            const Z = cz * CHUNK + z;
            if (X < lo[0]) lo[0] = X;
            if (Y < lo[1]) lo[1] = Y;
            if (Z < lo[2]) lo[2] = Z;
            if (X >= hi[0]) hi[0] = X + 1;
            if (Y >= hi[1]) hi[1] = Y + 1;
            if (Z >= hi[2]) hi[2] = Z + 1;
          }
        }
      }
    }
    return lo[0] === Infinity ? undefined : { lo, hi };
  }

  /** The labels used, with their voxel counts. */
  counts(): Map<number, number> {
    const out = new Map<number, number>();
    for (const c of this.chunks.values()) {
      for (let i = 0; i < c.length; ++i) {
        const v = c[i];
        if (v !== 0) out.set(v, (out.get(v) ?? 0) + 1);
      }
    }
    return out;
  }

  /** A block of voxels (x fastest), the whole volume unless a box is given. */
  dense(box: Box = { lo: [0, 0, 0], hi: this.size }): LabelArray {
    const [sx, sy, sz] = [0, 1, 2].map((k) => box.hi[k] - box.lo[k]);
    const out = new LABEL_ARRAYS[this.type](sx * sy * sz);
    for (const [key, c] of this.chunks) {
      const origin = this.coords(key).map((v) => v * CHUNK);
      const from = [0, 1, 2].map((k) => Math.max(origin[k], box.lo[k]));
      const to = [0, 1, 2].map((k) => Math.min(origin[k] + CHUNK, box.hi[k]));
      if (from.some((v, k) => v >= to[k])) continue;
      const run = to[0] - from[0];
      for (let z = from[2]; z < to[2]; ++z) {
        for (let y = from[1]; y < to[1]; ++y) {
          const src = from[0] - origin[0] + CHUNK * (y - origin[1] + CHUNK * (z - origin[2]));
          const dst = from[0] - box.lo[0] + sx * (y - box.lo[1] + sy * (z - box.lo[2]));
          out.set(c.subarray(src, src + run), dst);
        }
      }
    }
    return out;
  }

  /** Fills from a block (x fastest) of the whole volume; chunks all 0 are not kept. */
  load(data: ArrayLike<number>): void {
    this.chunks.clear();
    const [nx, ny, nz] = this.size;
    for (let cz = 0; cz < this.grid[2]; ++cz) {
      for (let cy = 0; cy < this.grid[1]; ++cy) {
        for (let cx = 0; cx < this.grid[0]; ++cx) {
          let chunk: LabelArray | undefined;
          for (let z = 0; z < CHUNK && cz * CHUNK + z < nz; ++z) {
            for (let y = 0; y < CHUNK && cy * CHUNK + y < ny; ++y) {
              const row = cx * CHUNK + nx * (cy * CHUNK + y + ny * (cz * CHUNK + z));
              const run = Math.min(CHUNK, nx - cx * CHUNK);
              for (let x = 0; x < run; ++x) {
                const v = data[row + x];
                if (v === 0) continue;
                chunk ??= new LABEL_ARRAYS[this.type](C3);
                chunk[x + CHUNK * (y + CHUNK * z)] = v;
              }
            }
          }
          if (chunk !== undefined) this.chunks.set(this.key(cx, cy, cz), chunk);
        }
      }
    }
    for (const c of this.coarse) c.clear();
    ++this.version;
  }

  // ---------------------------------------------------------- pyramid

  /** A chunk of a level (level 0's own; coarser ones made from the level below), or undefined where nothing is painted. */
  levelChunk(level: number, cx: number, cy: number, cz: number): LabelArray | undefined {
    if (level === 0) {
      if (cx < 0 || cy < 0 || cz < 0 || cx >= this.grid[0] || cy >= this.grid[1] || cz >= this.grid[2]) return undefined;
      return this.chunks.get(this.key(cx, cy, cz));
    }
    const key = `${cx}/${cy}/${cz}`;
    const cache = this.coarse[level];
    const known = cache.get(key);
    if (known !== undefined) return known ?? undefined;
    // Each coarse voxel takes the first label among the 2 × 2 × 2 below it; a
    // coarse chunk covers 2 × 2 × 2 chunks of the level below.
    let out: LabelArray | undefined;
    for (let child = 0; child < 8; ++child) {
      const ox = child & 1;
      const oy = (child >> 1) & 1;
      const oz = (child >> 2) & 1;
      const below = this.levelChunk(level - 1, 2 * cx + ox, 2 * cy + oy, 2 * cz + oz);
      if (below === undefined) continue;
      out ??= new LABEL_ARRAYS[this.type](C3);
      const half = CHUNK / 2;
      for (let z = 0; z < half; ++z) {
        for (let y = 0; y < half; ++y) {
          for (let x = 0; x < half; ++x) {
            const at = 2 * x + CHUNK * (2 * y + CHUNK * 2 * z);
            let v = below[at];
            if (v === 0) v = below[at + 1] || below[at + CHUNK] || below[at + CHUNK + 1];
            if (v === 0) {
              const up = at + CHUNK * CHUNK;
              v = below[up] || below[up + 1] || below[up + CHUNK] || below[up + CHUNK + 1];
            }
            out[ox * half + x + CHUNK * (oy * half + y + CHUNK * (oz * half + z))] = v;
          }
        }
      }
    }
    cache.set(key, out ?? null);
    return out;
  }

  // ---------------------------------------------------------- as a store

  /** The store's key: metadata or a chunk's raw bytes; undefined for chunks not painted (the fill value, 0). */
  getKey(key: string): Uint8Array | undefined {
    this.metadata ??= omeZarrMetadata(this.levels, this.type, this.name, { label: true, chunk: CHUNK, codecs: [{ name: "bytes", configuration: { endian: "little" } }] });
    const meta = this.metadata.get(key);
    if (meta !== undefined) return meta;
    const m = /^(\d+)\/c\/(\d+)\/(\d+)\/(\d+)$/.exec(key);
    if (m === null) return undefined;
    const level = Number(m[1]);
    if (level >= this.levels.length) return undefined;
    const c = this.levelChunk(level, Number(m[4]), Number(m[3]), Number(m[2]));
    return c === undefined ? undefined : new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
  }
}
