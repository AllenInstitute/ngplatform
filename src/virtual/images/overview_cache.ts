/**
 * The overview cache: the coarser levels of virtual images kept between
 * visits, within a budget.
 *
 * A level-k chunk is the mean of 8^k level-0 chunks' worth of the file
 * (for a level halving all three axes), so it is the most expensive to make
 * again and the cheapest to keep; level 1 is an eighth of the file.  So the
 * cache keeps whole levels, coarsest first, as far as the budget goes, and
 * the next finer level in part (its least recently used chunks go first);
 * finer levels are always made again from the file.  The budget per image
 * is a share of the file (2 %), at most 2 GB, and never more than half of
 * what the browser's storage has free; all images together are kept under
 * a total (10 GB), the images least recently used dropped first.  A 1 TB
 * TIFF keeps 2 GB; a 16 GB one, 330 MB.
 *
 * Chunks are files in the origin's private file system (OPFS), under
 * `ngplatform-overviews/<hash of the file's name, size and date>/`, with an
 * `index.json` naming the file and listing the chunks (level, bytes, last
 * use).  One worker writes a cache at a time (a Web Lock per cache); others
 * (another tab, the export worker) read it as it is.
 */

export interface OverviewSettings {
  /** The share of the file an image's overview may keep, in percent. */
  percent: number;
  /** At most this many GB an image. */
  maxGB: number;
  /** At most this many GB for all images together. */
  totalGB: number;
}

export const DEFAULT_SETTINGS: OverviewSettings = { percent: 2, maxGB: 2, totalGB: 10 };
const GB = 2 ** 30;

/**
 * The bytes an image's overview may keep: `percent` of the file, at most
 * `maxGB`, and at most half of `free` (what storage has left, when known).
 */
export function cacheBudget(fileBytes: number, settings: OverviewSettings = DEFAULT_SETTINGS, free?: number): number {
  let budget = Math.min(settings.maxGB * GB, (fileBytes * settings.percent) / 100, settings.totalGB * GB);
  if (free !== undefined && Number.isFinite(free)) budget = Math.min(budget, Math.max(0, free / 2));
  return Math.max(0, Math.floor(budget));
}

export interface KeptLevels {
  /** Levels kept whole, coarsest first. */
  whole: number[];
  /** The next finer computed level, kept in part (least recently used chunks dropped first). */
  partial?: number;
  /** Bytes of the whole levels. */
  bytes: number;
  /** The finest level kept at all (whole or in part); Infinity when none. */
  floor: number;
}

/**
 * Which levels a budget keeps: computed levels (`computed[k]`; level 0 and
 * a file's own levels are read from the file, not kept), coarsest first,
 * whole while they fit, then the next one in part.
 */
export function levelsKept(levelBytes: number[], computed: boolean[], budget: number): KeptLevels {
  const whole: number[] = [];
  let bytes = 0;
  let partial: number | undefined;
  for (let k = levelBytes.length - 1; k >= 1; --k) {
    if (!computed[k]) continue;
    if (bytes + levelBytes[k] <= budget) {
      whole.push(k);
      bytes += levelBytes[k];
      continue;
    }
    if (budget - bytes > 0) partial = k;
    break;
  }
  const floor = partial ?? (whole.length > 0 ? whole[whole.length - 1] : Infinity);
  return { whole, partial, bytes, floor };
}

export interface CacheEntry {
  level: number;
  bytes: number;
  used: number;
}

/**
 * Which chunks stay within the budget: coarser levels before finer ones,
 * and within a level the most recently used.  A chunk finer than `floor` is
 * never kept; one that only fits by dropping coarser chunks is not kept.
 */
export class CachePolicy {
  readonly entries = new Map<string, CacheEntry>();
  total = 0;

  constructor(
    public budget: number,
    public floor: number,
  ) {}

  /** Records a chunk already kept (read from the index). */
  restore(key: string, entry: CacheEntry): void {
    this.remove(key);
    this.entries.set(key, entry);
    this.total += entry.bytes;
  }

  /**
   * Whether a chunk of `level` and `bytes` is kept: the keys to drop to make
   * room for it (none when it fits), or undefined when it is not kept.
   */
  admit(key: string, level: number, bytes: number, now: number): string[] | undefined {
    if (level < this.floor || bytes > this.budget) return undefined;
    const known = this.entries.get(key);
    const need = this.total - (known?.bytes ?? 0) + bytes - this.budget;
    const drop: string[] = [];
    if (need > 0) {
      // Finest level first, least recently used first; never a coarser level than this chunk's.
      const candidates = [...this.entries].filter(([k, e]) => k !== key && e.level <= level).sort(([, a], [, b]) => a.level - b.level || a.used - b.used);
      let freed = 0;
      for (const [k, e] of candidates) {
        if (freed >= need) break;
        drop.push(k);
        freed += e.bytes;
      }
      if (freed < need) return undefined;
    }
    for (const k of drop) this.remove(k);
    this.remove(key);
    this.entries.set(key, { level, bytes, used: now });
    this.total += bytes;
    return drop;
  }

  touch(key: string, now: number): void {
    const e = this.entries.get(key);
    if (e !== undefined) e.used = now;
  }

  remove(key: string): void {
    const e = this.entries.get(key);
    if (e === undefined) return;
    this.entries.delete(key);
    this.total -= e.bytes;
  }

  /** Chunks over budget after the budget or floor changed: the keys dropped. */
  shrink(): string[] {
    const drop: string[] = [];
    for (const [k, e] of [...this.entries]) if (e.level < this.floor) drop.push(k);
    for (const k of drop) this.remove(k);
    if (this.total > this.budget) {
      const order = [...this.entries].sort(([, a], [, b]) => a.level - b.level || a.used - b.used);
      for (const [k] of order) {
        if (this.total <= this.budget) break;
        drop.push(k);
        this.remove(k);
      }
    }
    return drop;
  }

  byLevel(): Record<number, { chunks: number; bytes: number }> {
    const out: Record<number, { chunks: number; bytes: number }> = {};
    for (const e of this.entries.values()) {
      const l = (out[e.level] ??= { chunks: 0, bytes: 0 });
      l.chunks++;
      l.bytes += e.bytes;
    }
    return out;
  }
}

/** The in-memory caches' sizes, from the device's memory (`navigator.deviceMemory`, GB; Chrome reports at most 8). */
export function memoryBudgets(deviceMemory: number | undefined = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory): { chunks: number; bands: number } {
  const gb = deviceMemory !== undefined && deviceMemory > 0 ? deviceMemory : 4;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return { chunks: clamp(gb * 32 * 2 ** 20, 48 * 2 ** 20, 512 * 2 ** 20), bands: clamp(gb * 16 * 2 ** 20, 32 * 2 ** 20, 256 * 2 ** 20) };
}

// ------------------------------------------------------------- storage

export const ROOT = "ngplatform-overviews";
const SETTINGS = "settings.json";
const INDEX = "index.json";

/** What a cache's index.json holds. */
export interface CacheIndex {
  name: string;
  size: number;
  lastModified: number;
  /** When the cache was last used. */
  used: number;
  budget: number;
  /** Whether a build went through every level it keeps. */
  built: boolean;
  /** The chunks kept: key (`level/…`) → [level, bytes, last use]. */
  chunks: Record<string, [number, number, number]>;
}

/** The OPFS directory API, as far as the cache uses it (a fake one in tests). */
interface Dir {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Dir>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, FileSystemHandle]>;
}

async function root(): Promise<Dir | undefined> {
  const storage = (globalThis.navigator as { storage?: StorageManager } | undefined)?.storage;
  if (storage?.getDirectory === undefined) return undefined;
  try {
    return (await (await storage.getDirectory()).getDirectoryHandle(ROOT, { create: true })) as unknown as Dir;
  } catch {
    return undefined;
  }
}

async function readJson<T>(dir: Dir, name: string): Promise<T | undefined> {
  try {
    return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()) as T;
  } catch {
    return undefined;
  }
}

async function writeFile(dir: Dir, name: string, bytes: Uint8Array): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  // In a worker, a synchronous handle writes fastest; elsewhere, a writable stream.
  const sync = (handle as unknown as { createSyncAccessHandle?(): Promise<{ write(b: Uint8Array, o: { at: number }): number; truncate(n: number): void; flush(): void; close(): void }> }).createSyncAccessHandle;
  if (typeof sync === "function" && typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined") {
    const access = await sync.call(handle);
    try {
      access.truncate(0);
      access.write(bytes, { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
    return;
  }
  const writable = await handle.createWritable();
  await writable.write(bytes as unknown as BufferSource);
  await writable.close();
}

export async function readSettings(): Promise<OverviewSettings> {
  const dir = await root();
  const s = dir === undefined ? undefined : await readJson<Partial<OverviewSettings>>(dir, SETTINGS);
  const ok = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  return { percent: ok(s?.percent, DEFAULT_SETTINGS.percent), maxGB: ok(s?.maxGB, DEFAULT_SETTINGS.maxGB), totalGB: ok(s?.totalGB, DEFAULT_SETTINGS.totalGB) };
}

export async function writeSettings(settings: OverviewSettings): Promise<void> {
  const dir = await root();
  if (dir === undefined) throw new Error("this browser has no private file system to keep overviews in");
  await writeFile(dir, SETTINGS, new TextEncoder().encode(JSON.stringify(settings)));
}

/** A cache's directory name: a hash of the file's name, size and date. */
export function cacheName(key: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < key.length; ++i) {
    a = Math.imul(a ^ key.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ key.charCodeAt(i), 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

export interface OverviewListing {
  dir: string;
  name: string;
  size: number;
  lastModified: number;
  used: number;
  bytes: number;
  chunks: number;
  built: boolean;
  budget: number;
}

/** Every image's overview cache: what it is of, and what it holds. */
export async function listOverviews(): Promise<OverviewListing[]> {
  const dir = await root();
  if (dir === undefined) return [];
  const out: OverviewListing[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "directory") continue;
    const index = await readJson<CacheIndex>(await dir.getDirectoryHandle(name), INDEX);
    if (index === undefined) {
      out.push({ dir: name, name: "(unfinished)", size: 0, lastModified: 0, used: 0, bytes: 0, chunks: 0, built: false, budget: 0 });
      continue;
    }
    const chunks = Object.values(index.chunks ?? {});
    out.push({
      dir: name,
      name: index.name,
      size: index.size,
      lastModified: index.lastModified,
      used: index.used,
      bytes: chunks.reduce((n, c) => n + c[1], 0),
      chunks: chunks.length,
      built: index.built,
      budget: index.budget,
    });
  }
  return out.sort((a, b) => b.used - a.used);
}

/** Removes one image's overview cache (by directory name), or every one. */
export async function removeOverviews(dirName?: string): Promise<void> {
  const dir = await root();
  if (dir === undefined) return;
  const names: string[] = [];
  if (dirName !== undefined) names.push(dirName);
  else for await (const [name, handle] of dir.entries()) if (handle.kind === "directory") names.push(name);
  for (const name of names) await dir.removeEntry(name, { recursive: true }).catch(() => {});
}

const fileName = (key: string) => key.replace(/\//g, "-");

/**
 * One image's overview cache.  Writes go through the policy (and only from
 * the worker holding the cache's lock); reads of what the index lists.
 */
export class OverviewCache {
  private dirty: ReturnType<typeof setTimeout> | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  built: boolean;

  private constructor(
    private readonly parent: Dir,
    readonly dirName: string,
    private dir: Dir,
    private readonly info: { name: string; size: number; lastModified: number },
    readonly policy: CachePolicy,
    /** Whether this worker writes the cache (holds its lock). */
    readonly writer: boolean,
    built: boolean,
  ) {
    this.built = built;
  }

  /**
   * The cache of a file (`key` its name, size and date), opened for writing
   * when no other worker has it; undefined where there is no OPFS.  Others'
   * caches beyond the total are dropped, least recently used first.
   */
  static async open(key: string, info: { name: string; size: number; lastModified: number }, budget: (free: number | undefined) => Promise<{ budget: number; floor: number }>): Promise<OverviewCache | undefined> {
    const parent = await root();
    if (parent === undefined) return undefined;
    const dirName = cacheName(key);
    const writer = await takeLock(`${ROOT}/${dirName}`);
    const dir = await parent.getDirectoryHandle(dirName, { create: writer });
    const index = await readJson<CacheIndex>(dir, INDEX);
    const estimate = await (globalThis.navigator as { storage?: StorageManager }).storage?.estimate?.().catch(() => undefined);
    const own = Object.values(index?.chunks ?? {}).reduce((n, c) => n + c[1], 0);
    const free = estimate?.quota === undefined ? undefined : estimate.quota - (estimate.usage ?? 0) + own;
    const { budget: bytes, floor } = await budget(free);
    const policy = new CachePolicy(bytes, floor);
    for (const [k, [level, size, used]] of Object.entries(index?.chunks ?? {})) policy.restore(k, { level, bytes: size, used });
    const cache = new OverviewCache(parent, dirName, dir, info, policy, writer, index?.built === true);
    if (writer) {
      for (const k of policy.shrink()) await dir.removeEntry(fileName(k)).catch(() => {});
      cache.save();
      const settings = await readSettings();
      await dropOthers(parent, dirName, settings.totalGB * GB - bytes);
    }
    return cache;
  }

  has(key: string): boolean {
    return this.policy.entries.has(key);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    if (!this.policy.entries.has(key)) return undefined;
    try {
      const bytes = new Uint8Array(await (await (await this.dir.getFileHandle(fileName(key))).getFile()).arrayBuffer());
      if (bytes.byteLength !== this.policy.entries.get(key)?.bytes) throw new Error("a chunk of the wrong size");
      this.policy.touch(key, Date.now());
      if (this.writer) this.save();
      return bytes;
    } catch {
      // Gone (cleared elsewhere) or broken: made again.
      this.policy.remove(key);
      return undefined;
    }
  }

  /** Keeps a chunk if the policy has room for it. */
  put(key: string, level: number, bytes: Uint8Array): Promise<void> {
    if (!this.writer) return Promise.resolve();
    const drop = this.policy.admit(key, level, bytes.byteLength, Date.now());
    if (drop === undefined) return Promise.resolve();
    const job = this.writes.then(async () => {
      for (const k of drop) await this.dir.removeEntry(fileName(k)).catch(() => {});
      try {
        await writeFile(this.dir, fileName(key), bytes);
      } catch {
        this.policy.remove(key);
      }
      this.save();
    });
    this.writes = job.catch(() => {});
    return job;
  }

  /** Waits for the writes so far. */
  flush(): Promise<unknown> {
    return this.writes;
  }

  /** The budget and floor again (settings changed): chunks beyond them dropped. */
  async rebudget(budget: number, floor: number): Promise<void> {
    this.policy.budget = budget;
    this.policy.floor = floor;
    if (!this.writer) return;
    for (const k of this.policy.shrink()) await this.dir.removeEntry(fileName(k)).catch(() => {});
    this.save();
  }

  /** Drops every chunk kept. */
  async clear(): Promise<void> {
    await this.writes;
    for (const k of [...this.policy.entries.keys()]) this.policy.remove(k);
    this.built = false;
    if (!this.writer) return;
    await this.parent.removeEntry(this.dirName, { recursive: true }).catch(() => {});
    this.dir = await this.parent.getDirectoryHandle(this.dirName, { create: true });
    this.save();
  }

  markBuilt(built: boolean): void {
    this.built = built;
    if (this.writer) this.save();
  }

  /** Writes the index soon (once a second at most). */
  private save(): void {
    if (this.dirty !== undefined) return;
    this.dirty = setTimeout(() => {
      this.dirty = undefined;
      const index: CacheIndex = {
        ...this.info,
        used: Date.now(),
        budget: this.policy.budget,
        built: this.built,
        chunks: Object.fromEntries([...this.policy.entries].map(([k, e]) => [k, [e.level, e.bytes, e.used]])),
      };
      this.writes = this.writes.then(() => writeFile(this.dir, INDEX, new TextEncoder().encode(JSON.stringify(index)))).catch(() => {});
    }, 1000);
  }
}

/** Takes the Web Lock `name` for as long as this worker lives; false when another holds it. */
function takeLock(name: string): Promise<boolean> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (locks === undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Held until the worker ends.
        return lock === null ? undefined : new Promise<void>(() => {});
      })
      .catch(() => resolve(false));
  });
}

/** Other images' caches, least recently used first, dropped until they total at most `room` bytes. */
async function dropOthers(parent: Dir, keep: string, room: number): Promise<void> {
  const others: { name: string; used: number; bytes: number }[] = [];
  for await (const [name, handle] of parent.entries()) {
    if (handle.kind !== "directory" || name === keep) continue;
    const index = await readJson<CacheIndex>(await parent.getDirectoryHandle(name), INDEX);
    others.push({ name, used: index?.used ?? 0, bytes: Object.values(index?.chunks ?? {}).reduce((n, c) => n + c[1], 0) });
  }
  let total = others.reduce((n, o) => n + o.bytes, 0);
  for (const o of others.sort((a, b) => a.used - b.used)) {
    if (total <= Math.max(0, room)) break;
    await parent.removeEntry(o.name, { recursive: true }).catch(() => {});
    total -= o.bytes;
  }
}
