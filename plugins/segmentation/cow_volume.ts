/**
 * A segmentation edited in place, copy-on-write: a label volume on the grid
 * of its original's finest level whose chunks are read from the original
 * until edited.  The first change to a chunk copies it (the original's
 * labels there, as this volume's type) and the copy is changed from then
 * on; nothing else is copied.  The original is never written.
 *
 *  - Edited chunks are this volume's own (`own`, `keys`): in memory up to
 *    `memoryBudget`, then (once the browser keeps them, keep.ts) let go
 *    and read back from there when needed (`spill`).
 *  - Unedited chunks are the original's, read when asked for and cached
 *    (up to `baseBudget`); its store, served to Neuroglancer, answers them
 *    asynchronously.
 *  - Coarser levels are the original's own levels (as many as halve, or
 *    divide by a whole number, the level below), read as they are where
 *    nothing under a coarse chunk is edited, and made again over edits:
 *    each coarse voxel the commonest label of those under it.
 *
 * Tools read and write synchronously, so before one runs the editor has
 * the chunks it may reach read (`prepare`): those stay in memory (pinned)
 * until it is done.  Reading a chunk not prepared is an error, never a
 * silent 0.
 */
import type { LevelGrid } from "../registration/volume_io.js";
import { CHUNK, isEmpty, LABEL_ARRAYS, LABEL_MAX, type LabelArray, type LabelType, LabelVolume, type Vec3 } from "./label_volume.js";

const C3 = CHUNK * CHUNK * CHUNK;

/** Where the original of a volume edited in place is: recorded with its edits, kept and saved. */
export interface Original {
  /** The store the volume reader opens (an OME-Zarr URL, or `precomputed:<url>`). */
  store: string;
  /** The layer it was shown in when editing began. */
  layer: string;
  /** Its Neuroglancer source, as the layer had it. */
  source?: string;
}

/** Reads a block of a level of the original's labels (x fastest), exactly; NaN outside it. */
export type ReadOriginal = (level: number, lo: Vec3, size: Vec3, signal?: AbortSignal) => Promise<ArrayLike<number>>;

/** Where edited chunks let go from memory are read back from (the browser's storage). */
export interface SpillStore {
  read(key: number): Promise<LabelArray | undefined>;
}

/**
 * The original's levels a volume edited in place shows: its finest, then
 * each coarser one that divides the level before by whole numbers (2, or 1
 * along an axis not halved) and is placed accordingly; the first that does
 * not ends the pyramid.  `factors[l]`: level l's voxel in voxels of level
 * l − 1 along x, y, z (level 0's [1, 1, 1]).
 */
export function cowLevels(levels: readonly LevelGrid[]): { levels: LevelGrid[]; factors: Vec3[] } {
  const out: LevelGrid[] = [{ size: [...levels[0].size] as Vec3, voxelToRas: levels[0].voxelToRas }];
  const factors: Vec3[] = [[1, 1, 1]];
  const edge = (m: ArrayLike<number>, k: number) => Math.hypot(m[k], m[4 + k], m[8 + k]);
  for (let l = 1; l < levels.length; ++l) {
    const prev = out[out.length - 1];
    const next = levels[l];
    const f = [0, 1, 2].map((k) => Math.round(prev.size[k] / next.size[k])) as Vec3;
    const fits = f.every((n, k) => n >= 1 && Math.abs(Math.ceil(prev.size[k] / n) - next.size[k]) <= 1 && Math.abs(edge(next.voxelToRas, k) / edge(prev.voxelToRas, k) - n) < 0.05 * n);
    if (!fits || f.every((n) => n === 1)) break;
    out.push({ size: [...next.size] as Vec3, voxelToRas: next.voxelToRas });
    factors.push(f);
  }
  return { levels: out, factors };
}

/** The commonest of a few labels; a tie goes to the label that is not 0, then to the first. */
function mode(values: number[], n: number): number {
  let best = values[0];
  let bestCount = 0;
  for (let i = 0; i < n; ++i) {
    const v = values[i];
    let c = 0;
    for (let j = 0; j < n; ++j) if (values[j] === v) ++c;
    if (c > bestCount || (c === bestCount && best === 0 && v !== 0)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

interface Cached {
  promise: Promise<LabelArray | null>;
  /** Once read: the chunk, or null where the original has only 0. */
  value?: LabelArray | null;
}

export class CowVolume extends LabelVolume {
  /** Each level's voxel in voxels of the level below; and in level 0's. */
  readonly factors: Vec3[];
  private readonly total: Vec3[];
  /** Bytes of edited chunks held in memory before the oldest kept ones are let go. */
  memoryBudget = 512 * 2 ** 20;
  /** Bytes of the original's chunks cached. */
  baseBudget = 256 * 2 ** 20;
  /** Where edited chunks let go of are read back from; none, and every edit stays in memory. */
  spill: SpillStore | undefined;
  /** The largest label met so far, in the original's chunks read and in edits: new segments start above it. */
  largestSeen = 0;

  /** Edited chunks let go from memory (kept in the browser). */
  private readonly spilled = new Set<number>();
  /** Edited chunks changed since last written to the browser: never let go. */
  private readonly unkept = new Set<number>();
  private readonly versions = new Map<number, number>();
  private readonly used = new Map<number, number>();
  private tick = 0;
  /** Level-0 chunks a tool is using: never let go or evicted. */
  private readonly pins = new Map<number, number>();
  /** The original's level-0 chunks read, oldest first. */
  private readonly base0 = new Map<number, Cached>();
  /** The original's coarser chunks read (`level/x/y/z`), oldest first. */
  private readonly baseCoarse = new Map<string, Cached>();
  private baseBytes = 0;
  /** Per level: coarse chunks with edits under them, and how many edited level-0 chunks. */
  private readonly under: Map<string, number>[];
  /** Per level: coarse chunks made again over edits. */
  private readonly made: Map<string, Promise<LabelArray | undefined>>[];

  constructor(
    levels: readonly LevelGrid[],
    type: LabelType,
    readonly original: Original,
    private readonly read: ReadOriginal,
    name = "labels",
  ) {
    const own = cowLevels(levels);
    super(own.levels[0].size, type, own.levels[0].voxelToRas, name, own.levels);
    this.factors = own.factors;
    this.total = [];
    let t: Vec3 = [1, 1, 1];
    for (const f of this.factors) {
      t = t.map((v, k) => v * f[k]) as Vec3;
      this.total.push(t);
    }
    this.under = this.levels.map(() => new Map());
    this.made = this.levels.map(() => new Map());
  }

  private get chunkBytes(): number {
    return C3 * LABEL_ARRAYS[this.type].BYTES_PER_ELEMENT;
  }

  override get chunkCount(): number {
    return this.chunks.size + this.spilled.size;
  }

  /** Bytes of edited chunks in memory. */
  override get bytes(): number {
    return this.chunks.size * this.chunkBytes;
  }

  /** Edited chunks let go from memory, kept in this browser only. */
  get spilledCount(): number {
    return this.spilled.size;
  }

  override keys(): number[] {
    return [...this.chunks.keys(), ...this.spilled];
  }

  override edited(key: number): boolean {
    return this.chunks.has(key) || this.spilled.has(key);
  }

  // ------------------------------------------------------- reading

  /** A level-0 chunk as the tools see it: the edit, or the original's (which must have been read: `prepare`). */
  private now(key: number): LabelArray | undefined {
    const own = this.chunks.get(key);
    if (own !== undefined) return own;
    if (this.spilled.has(key)) throw new Error(`edited chunk ${this.coords(key).join(", ")} was not read back before use`);
    const b = this.base0.get(key)?.value;
    if (b === undefined) throw new Error(`chunk ${this.coords(key).join(", ")} of the original was not read before use`);
    return b ?? undefined;
  }

  override get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return 0;
    const c = this.now(this.key(x >> 6, y >> 6, z >> 6));
    return c === undefined ? 0 : c[LabelVolume.offset(x, y, z)];
  }

  /** A chunk to read (the edit or the original's); `create`: this volume's own, copied from the original on its first change. */
  override chunk(key: number, create = false): LabelArray | undefined {
    const c = this.now(key);
    if (!create || this.chunks.has(key)) return c;
    const copy = c === undefined ? new LABEL_ARRAYS[this.type](C3) : c.slice();
    this.chunks.set(key, copy);
    this.markEdited(key, true);
    this.used.set(key, ++this.tick);
    return copy;
  }

  // ------------------------------------------------------- changing

  override putChunk(key: number, data: LabelArray | undefined): void {
    const was = this.edited(key);
    this.spilled.delete(key);
    if (data === undefined) this.chunks.delete(key);
    else {
      this.chunks.set(key, data);
      this.used.set(key, ++this.tick);
    }
    if (was !== (data !== undefined)) this.markEdited(key, data !== undefined);
    this.changed(key);
  }

  /** Puts back a chunk as kept in the browser (after a reload): edited, and kept already. */
  restoreChunk(key: number, data: LabelArray): void {
    this.putChunk(key, data);
    this.unkept.delete(key);
    this.trim();
  }

  override changed(key: number): void {
    this.chunkCounts.delete(key);
    const [cx, cy, cz] = this.coords(key);
    for (let l = 1; l < this.levels.length; ++l) this.made[l].delete(this.coarseKey(l, cx, cy, cz));
    this.unkept.add(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    ++this.version;
    this.trim();
  }

  /** An edit that came back to the original's labels is dropped (the chunk is the original's again). */
  override settle(key: number): void {
    const own = this.chunks.get(key);
    const base = this.base0.get(key)?.value;
    if (own === undefined || base === undefined) return;
    if (base === null ? isEmpty(own) : equal(own, base)) this.putChunk(key, undefined);
  }

  private coarseKey(level: number, cx: number, cy: number, cz: number): string {
    const t = this.total[level];
    return `${Math.floor(cx / t[0])}/${Math.floor(cy / t[1])}/${Math.floor(cz / t[2])}`;
  }

  /** Counts a level-0 chunk in (or out of) the coarse chunks over it. */
  private markEdited(key: number, edited: boolean): void {
    const [cx, cy, cz] = this.coords(key);
    for (let l = 1; l < this.levels.length; ++l) {
      const ck = this.coarseKey(l, cx, cy, cz);
      const n = (this.under[l].get(ck) ?? 0) + (edited ? 1 : -1);
      if (n > 0) this.under[l].set(ck, n);
      else this.under[l].delete(ck);
      this.made[l].delete(ck);
    }
  }

  /** Whether anything under a chunk of a level is edited. */
  editedUnder(level: number, cx: number, cy: number, cz: number): boolean {
    return level === 0 ? this.edited(this.key(cx, cy, cz)) : this.under[level].has(`${cx}/${cy}/${cz}`);
  }

  /** The chunks of a level with edits under them, as [x, y, z]. */
  editedChunks(level: number): Vec3[] {
    if (level === 0) return this.keys().map((k) => this.coords(k));
    return [...this.under[level].keys()].map((k) => k.split("/").map(Number) as Vec3);
  }

  override versionOf(key: number): number {
    return this.versions.get(key) ?? 0;
  }

  override keptAt(keys: number[], versions: number[]): void {
    keys.forEach((k, i) => {
      if (this.versionOf(k) === versions[i]) this.unkept.delete(k);
    });
    this.trim();
  }

  /** Lets the least recently used edited chunks the browser keeps go from memory while over budget. */
  private trim(): void {
    if (this.spill === undefined || this.bytes <= this.memoryBudget) return;
    const candidates = [...this.chunks.keys()].filter((k) => !this.unkept.has(k) && !this.pins.has(k)).sort((a, b) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0));
    let bytes = this.bytes;
    for (const k of candidates) {
      if (bytes <= 0.9 * this.memoryBudget) break;
      this.countChunk(k);
      this.chunks.delete(k);
      this.spilled.add(k);
      bytes -= this.chunkBytes;
    }
  }

  private countChunk(key: number): Map<number, number> {
    let own = this.chunkCounts.get(key);
    if (own === undefined) {
      own = new Map();
      const c = this.chunks.get(key);
      if (c !== undefined) for (let i = 0; i < c.length; ++i) if (c[i] !== 0) own.set(c[i], (own.get(c[i]) ?? 0) + 1);
      this.chunkCounts.set(key, own);
    }
    return own;
  }

  /** The labels in the edited chunks, with their voxels there (the original elsewhere is not counted). */
  override counts(): Map<number, number> {
    const out = super.counts();
    for (const key of this.spilled) for (const [v, n] of this.chunkCounts.get(key) ?? []) out.set(v, (out.get(v) ?? 0) + n);
    for (const v of out.keys()) if (v > this.largestSeen) this.largestSeen = v;
    return out;
  }

  /** Edited chunks (by key) holding a label, as last counted. */
  keysWith(value: number): number[] {
    return this.keys().filter((k) => (this.chunks.has(k) ? this.countChunk(k) : this.chunkCounts.get(k))?.has(value) ?? true);
  }

  // ------------------------------------------------------- preparing

  override async prepare(lo: Vec3, hi: Vec3, signal?: AbortSignal): Promise<() => void> {
    const keys: number[] = [];
    const a = lo.map((v) => Math.max(0, Math.floor(v / CHUNK)));
    const b = hi.map((v, k) => Math.min(this.grid[k], Math.ceil(v / CHUNK)));
    for (let z = a[2]; z < b[2]; ++z) for (let y = a[1]; y < b[1]; ++y) for (let x = a[0]; x < b[0]; ++x) keys.push(this.key(x, y, z));
    return this.prepareKeys(keys, signal);
  }

  override async prepareKeys(keys: Iterable<number>, signal?: AbortSignal): Promise<() => void> {
    const list = [...keys];
    for (const k of list) this.pins.set(k, (this.pins.get(k) ?? 0) + 1);
    const release = () => {
      for (const k of list) {
        const n = (this.pins.get(k) ?? 1) - 1;
        if (n > 0) this.pins.set(k, n);
        else this.pins.delete(k);
      }
      this.trim();
      this.evict();
    };
    try {
      // A few at a time: the original's reader works through them in turn anyway.
      let next = 0;
      const worker = async () => {
        while (next < list.length) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          await this.ready(list[next++]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
    } catch (e) {
      release();
      throw e;
    }
    return release;
  }

  /** Has a level-0 chunk readable at once: an edit brought back into memory, or the original's read. */
  private async ready(key: number): Promise<void> {
    if (this.chunks.has(key)) {
      this.used.set(key, ++this.tick);
      return;
    }
    if (this.spilled.has(key)) {
      const c = await this.spill?.read(key);
      if (c === undefined) throw new Error(`edited chunk ${this.coords(key).join(", ")} is no longer kept in this browser`);
      if (this.spilled.has(key)) {
        this.spilled.delete(key);
        this.chunks.set(key, c);
        this.used.set(key, ++this.tick);
      }
      return;
    }
    await this.original0(key);
  }

  /** The original's level-0 chunk (null: all 0), read once and cached. */
  private original0(key: number): Promise<LabelArray | null> {
    const hit = this.base0.get(key);
    if (hit !== undefined) {
      this.base0.delete(key);
      this.base0.set(key, hit);
      return hit.promise;
    }
    const [cx, cy, cz] = this.coords(key);
    const entry: Cached = { promise: this.readChunk(0, cx, cy, cz) };
    entry.promise.then(
      (v) => {
        entry.value = v;
        if (v) this.baseBytes += v.byteLength;
        this.evict();
      },
      () => this.base0.delete(key),
    );
    this.base0.set(key, entry);
    return entry.promise;
  }

  private originalCoarse(level: number, cx: number, cy: number, cz: number): Promise<LabelArray | null> {
    const key = `${level}/${cx}/${cy}/${cz}`;
    const hit = this.baseCoarse.get(key);
    if (hit !== undefined) {
      this.baseCoarse.delete(key);
      this.baseCoarse.set(key, hit);
      return hit.promise;
    }
    const entry: Cached = { promise: this.readChunk(level, cx, cy, cz) };
    entry.promise.then(
      (v) => {
        entry.value = v;
        if (v) this.baseBytes += v.byteLength;
        this.evict();
      },
      () => this.baseCoarse.delete(key),
    );
    this.baseCoarse.set(key, entry);
    return entry.promise;
  }

  /** Forgets the original's chunks read longest ago while over budget (not those a tool is using). */
  private evict(): void {
    const drop = <K>(cache: Map<K, Cached>, pinned: (k: K) => boolean) => {
      for (const [k, e] of cache) {
        if (this.baseBytes <= this.baseBudget) return;
        if (e.value === undefined || pinned(k)) continue;
        cache.delete(k);
        if (e.value) this.baseBytes -= e.value.byteLength;
      }
    };
    drop(this.baseCoarse, () => false);
    drop(this.base0, (k) => this.pins.has(k));
  }

  /** A block of a level of the original's labels, as read (x fastest; NaN outside). */
  readOriginal(level: number, lo: Vec3, size: Vec3, signal?: AbortSignal): Promise<ArrayLike<number>> {
    return this.read(level, lo, size, signal);
  }

  /** Reads a chunk of a level of the original, as this volume's type; null where it is all 0. */
  private async readChunk(level: number, cx: number, cy: number, cz: number): Promise<LabelArray | null> {
    const size = this.levels[level].size;
    const lo: Vec3 = [cx * CHUNK, cy * CHUNK, cz * CHUNK];
    const extent = lo.map((v, k) => Math.max(0, Math.min(CHUNK, size[k] - v))) as Vec3;
    if (extent.some((n) => n === 0)) return null;
    const data = await this.read(level, lo, extent);
    return this.fromBlock(data, extent, [0, 0, 0], extent);
  }

  /**
   * A chunk from a block of the original's labels (`size`, x fastest):
   * the part from `from` of `extent` voxels; null if all 0.  A value the
   * type cannot hold is an error.
   */
  fromBlock(data: ArrayLike<number>, size: Vec3, from: Vec3, extent: Vec3): LabelArray | null {
    const max = LABEL_MAX[this.type];
    let out: LabelArray | null = null;
    for (let z = 0; z < extent[2]; ++z) {
      for (let y = 0; y < extent[1]; ++y) {
        const row = from[0] + size[0] * (from[1] + y + size[1] * (from[2] + z));
        for (let x = 0; x < extent[0]; ++x) {
          const v = data[row + x];
          if (!(v > 0)) {
            if (v < 0) throw new Error(`${v} in ${this.original.layer} is not a label`);
            continue;
          }
          if (v > max || v !== Math.floor(v)) throw new Error(`label ${v} in ${this.original.layer} does not fit a ${this.type} volume`);
          if (v > this.largestSeen) this.largestSeen = v;
          out ??= new LABEL_ARRAYS[this.type](C3);
          out[x + CHUNK * (y + CHUNK * z)] = v;
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------- the pyramid and the store

  /** A chunk of a level as shown: edits, the original's, or (over edits) made again from the level below. */
  async chunkAt(level: number, cx: number, cy: number, cz: number): Promise<LabelArray | undefined> {
    const g = this.levels[level].size;
    if (cx < 0 || cy < 0 || cz < 0 || cx * CHUNK >= g[0] || cy * CHUNK >= g[1] || cz * CHUNK >= g[2]) return undefined;
    if (level === 0) {
      const key = this.key(cx, cy, cz);
      const own = this.chunks.get(key);
      if (own !== undefined) return own;
      if (this.spilled.has(key)) {
        const back = await this.spill?.read(key);
        // Changed while it was read: what is in memory now.
        return this.chunks.get(key) ?? back;
      }
      return (await this.original0(key)) ?? undefined;
    }
    const ck = `${cx}/${cy}/${cz}`;
    if (!this.under[level].has(ck)) return (await this.originalCoarse(level, cx, cy, cz)) ?? undefined;
    let p = this.made[level].get(ck);
    if (p === undefined) {
      p = this.makeCoarse(level, cx, cy, cz);
      this.made[level].set(ck, p);
      p.catch(() => {
        if (this.made[level].get(ck) === p) this.made[level].delete(ck);
      });
      // A few hundred at most: the oldest go.
      while (this.made[level].size > 256) this.made[level].delete(this.made[level].keys().next().value!);
    }
    return p;
  }

  /** A coarse chunk over edits: each voxel the commonest label of those it covers in the level below. */
  private async makeCoarse(level: number, cx: number, cy: number, cz: number): Promise<LabelArray | undefined> {
    const f = this.factors[level];
    const below = this.levels[level - 1].size;
    const children = new Map<string, LabelArray | undefined>();
    const jobs: Promise<void>[] = [];
    for (let oz = 0; oz < f[2]; ++oz) {
      for (let oy = 0; oy < f[1]; ++oy) {
        for (let ox = 0; ox < f[0]; ++ox) {
          const c: Vec3 = [cx * f[0] + ox, cy * f[1] + oy, cz * f[2] + oz];
          jobs.push(this.chunkAt(level - 1, ...c).then((data) => void children.set(c.join("/"), data)));
        }
      }
    }
    await Promise.all(jobs);
    if ([...children.values()].every((c) => c === undefined)) return undefined;
    const out = new LABEL_ARRAYS[this.type](C3);
    const values = new Array<number>(f[0] * f[1] * f[2]);
    let any = false;
    const origin = [cx * CHUNK * f[0], cy * CHUNK * f[1], cz * CHUNK * f[2]];
    for (let z = 0; z < CHUNK; ++z) {
      for (let y = 0; y < CHUNK; ++y) {
        for (let x = 0; x < CHUNK; ++x) {
          let n = 0;
          for (let k = 0; k < f[2]; ++k) {
            const Z = origin[2] + z * f[2] + k;
            if (Z >= below[2]) continue;
            for (let j = 0; j < f[1]; ++j) {
              const Y = origin[1] + y * f[1] + j;
              if (Y >= below[1]) continue;
              for (let i = 0; i < f[0]; ++i) {
                const X = origin[0] + x * f[0] + i;
                if (X >= below[0]) continue;
                const child = children.get(`${X >> 6}/${Y >> 6}/${Z >> 6}`);
                values[n++] = child === undefined ? 0 : child[(X & 63) + CHUNK * ((Y & 63) + CHUNK * (Z & 63))];
              }
            }
          }
          if (n === 0) continue;
          const v = mode(values, n);
          if (v !== 0) {
            out[x + CHUNK * (y + CHUNK * z)] = v;
            any = true;
          }
        }
      }
    }
    return any ? out : undefined;
  }

  override levelChunk(): LabelArray | undefined {
    throw new Error("a volume edited in place reads its levels asynchronously (chunkAt)");
  }

  /** Metadata only: chunks are read asynchronously (`serve`). */
  override getKey(key: string): Uint8Array | undefined {
    const meta = this.getMetadata().get(key);
    if (meta !== undefined) return meta;
    if (/^\d+\/c\//.test(key)) throw new Error("a volume edited in place serves its chunks asynchronously");
    return undefined;
  }

  override serve(key: string): Uint8Array | undefined | Promise<Uint8Array | undefined> {
    const meta = this.getMetadata().get(key);
    if (meta !== undefined) return meta;
    const m = /^(\d+)\/c\/(\d+)\/(\d+)\/(\d+)$/.exec(key);
    if (m === null) return undefined;
    const level = Number(m[1]);
    if (level >= this.levels.length) return undefined;
    return this.chunkAt(level, Number(m[4]), Number(m[3]), Number(m[2])).then((c) => (c === undefined ? undefined : new Uint8Array(c.buffer, c.byteOffset, c.byteLength)));
  }

  /**
   * Reads the original's coarsest level (when it is a few chunks) for the
   * largest label it shows there: new segments start above it.  Labels too
   * small to show at that level are not seen until their chunks are read.
   */
  async survey(): Promise<number> {
    const last = this.levels.length - 1;
    const g = this.levels[last].size.map((n) => Math.ceil(n / CHUNK));
    if (g[0] * g[1] * g[2] <= 64) {
      const jobs: Promise<unknown>[] = [];
      for (let z = 0; z < g[2]; ++z) for (let y = 0; y < g[1]; ++y) for (let x = 0; x < g[0]; ++x) jobs.push(this.chunkAt(last, x, y, z));
      await Promise.all(jobs);
    }
    return this.largestSeen;
  }
}

function equal(a: LabelArray, b: LabelArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
  return true;
}
