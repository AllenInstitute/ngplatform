/**
 * Spill files: where a virtual store keeps what it made from a file too
 * large to hold in memory (a tractogram's points binned into cells), so
 * that memory holds only an index of it.
 *
 * A spill is append-only and read by byte range.  Two kinds:
 *
 * - `OpfsSpill`: a file in the origin's private file system (OPFS), written
 *   and read through a synchronous access handle (dedicated workers only).
 *   It lives while the store does; a lock names it as in use, and a spill
 *   left behind by a closed tab is deleted the next time one is made.
 * - `MemorySpill`: the same in memory, for small files and for tests.
 *
 * `cacheBudget()` says how much memory decoded cells may take, from the
 * device's memory unless the page set a budget (Settings); `spillPlan()`
 * how much of a tractogram is copied into a spill at all, within the disk
 * budget (Settings): every streamline, or a sample of them.
 */

/** What to say when a file is past what the browser can do here: the local runner can. */
export const RUNNER_HINT = "Open it through the runner on this computer (Settings › Compute → This computer)";

/**
 * A file past what this browser can do (`reason`): its message names the
 * local runner.  `kind: "runner"` is the hook for the page to offer the
 * hand-off (a later merge wires it to the runner's `POST /serve`).
 */
export class NeedsRunner extends Error {
  readonly kind = "runner";
  constructor(readonly reason: string) {
    super(`${reason}. ${RUNNER_HINT}.`);
  }
}

export interface Spill {
  /** Appends bytes; resolves to nothing, returns their offset. */
  append(bytes: Uint8Array): number;
  /** A copy of bytes [offset, offset + length). */
  read(offset: number, length: number): Uint8Array;
  /** Bytes written. */
  readonly size: number;
  /** Lets the bytes go (deleting the file). */
  close(): void;
}

const BLOCK = 32 * 1024 * 1024;

export class MemorySpill implements Spill {
  private blocks: Uint8Array[] = [];
  size = 0;

  append(bytes: Uint8Array): number {
    const at = this.size;
    let from = 0;
    while (from < bytes.byteLength) {
      const block = Math.floor(this.size / BLOCK);
      const inBlock = this.size % BLOCK;
      if (block === this.blocks.length) this.blocks.push(new Uint8Array(Math.min(BLOCK, Math.max(64 * 1024, bytes.byteLength - from))));
      let target = this.blocks[block];
      const n = Math.min(BLOCK - inBlock, bytes.byteLength - from);
      if (target.byteLength < inBlock + n) {
        // The last block grows (doubling) until it is a whole block.
        let capacity = target.byteLength;
        while (capacity < inBlock + n) capacity = Math.min(BLOCK, capacity * 2);
        const grown = new Uint8Array(capacity);
        grown.set(target.subarray(0, inBlock));
        this.blocks[block] = target = grown;
      }
      target.set(bytes.subarray(from, from + n), inBlock);
      from += n;
      this.size += n;
    }
    return at;
  }

  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const at = offset + done;
      const block = this.blocks[Math.floor(at / BLOCK)];
      const inBlock = at % BLOCK;
      const n = Math.min(BLOCK - inBlock, length - done);
      out.set(block.subarray(inBlock, inBlock + n), done);
      done += n;
    }
    return out;
  }

  close(): void {
    this.blocks = [];
  }
}

/** The parts of OPFS a spill uses (absent outside a dedicated worker). */
interface SyncHandle {
  write(data: Uint8Array, options: { at: number }): number;
  read(data: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

const DIRECTORY = "ngplatform-spill";
const LOCK = "ngplatform-spill:";

interface Locks {
  request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
  request(name: string, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

const locks = () => (globalThis.navigator as { locks?: Locks } | undefined)?.locks;

/** Whether this context can make OPFS spills (a dedicated worker with OPFS). */
export function canSpillToDisk(): boolean {
  const storage = (globalThis.navigator as { storage?: { getDirectory?: unknown } } | undefined)?.storage;
  const handle = (globalThis as { FileSystemFileHandle?: { prototype: { createSyncAccessHandle?: unknown } } }).FileSystemFileHandle;
  return typeof storage?.getDirectory === "function" && typeof handle?.prototype.createSyncAccessHandle === "function" && locks() !== undefined;
}

let cleaned: Promise<void> | undefined;

/** Deletes spills no open tab holds (left by tabs closed while a store was open). */
function cleanStale(dir: FileSystemDirectoryHandle): Promise<void> {
  return (cleaned ??= (async () => {
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) {
      await locks()!
        .request(LOCK + name, { ifAvailable: true }, async (lock) => {
          if (lock !== null) await dir.removeEntry(name).catch(() => {});
        })
        .catch(() => {});
    }
  })());
}

/** Appends are gathered into writes of this size … */
const STAGE = 8 * 1024 * 1024;
/** … into a file grown this much at a time (each growth asks for quota). */
const GROW = 512 * 1024 * 1024;

export class OpfsSpill implements Spill {
  size = 0;
  /** Bytes appended but not yet written: [written, size). */
  private stage = new Uint8Array(STAGE);
  private staged = 0;
  private written = 0;
  private allocated = 0;

  private constructor(
    private readonly dir: FileSystemDirectoryHandle,
    readonly name: string,
    private readonly handle: SyncHandle,
    private readonly release: () => void,
  ) {}

  /** A new spill file, held (by a lock) until closed. */
  static async create(): Promise<OpfsSpill> {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIRECTORY, { create: true });
    await cleanStale(dir);
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let release!: () => void;
    await new Promise<void>((held) => {
      void locks()!.request(LOCK + name, () => {
        held();
        return new Promise<void>((resolve) => (release = resolve));
      });
    });
    const file = await dir.getFileHandle(name, { create: true });
    const handle = (await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle()) as SyncHandle;
    return new OpfsSpill(dir, name, handle, release);
  }

  append(bytes: Uint8Array): number {
    const at = this.size;
    if (this.staged + bytes.byteLength > STAGE) this.writeStage();
    if (bytes.byteLength > STAGE) this.write(bytes);
    else {
      this.stage.set(bytes, this.staged);
      this.staged += bytes.byteLength;
    }
    this.size += bytes.byteLength;
    return at;
  }

  /** Writes what is staged. */
  private writeStage(): void {
    if (this.staged === 0) return;
    this.write(this.stage.subarray(0, this.staged));
    this.staged = 0;
  }

  private write(bytes: Uint8Array): void {
    const end = this.written + bytes.byteLength;
    if (end > this.allocated) {
      // Small writes past the end each ask for quota: grow the file in large steps instead.
      const want = Math.ceil(end / GROW) * GROW;
      this.handle.truncate(want);
      // Where the file cannot grow so far (a private window), it grows write by write.
      this.allocated = (this.handle as { getSize?(): number }).getSize?.() === want ? want : end;
    }
    let done = 0;
    while (done < bytes.byteLength) {
      const n = this.handle.write(bytes.subarray(done), { at: this.written + done });
      // A failed write returns 0, or (in some versions) a negative count read as unsigned.
      if (!(n > 0 && n <= bytes.byteLength - done)) {
        const gb = ((this.written + done) / 2 ** 30).toFixed(1);
        throw new NeedsRunner(`this browser's private storage would not take more than ${gb} GB (a private or guest window keeps it in memory, with less room)`);
      }
      done += n;
    }
    this.written = end;
  }

  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    // Bytes still staged come from the stage.
    const fromFile = Math.max(0, Math.min(length, this.written - offset));
    let done = 0;
    while (done < fromFile) {
      const n = this.handle.read(out.subarray(done, fromFile), { at: offset + done });
      if (n <= 0) throw new Error(`the spill file ends at ${offset + done} (wanted ${offset + length})`);
      done += n;
    }
    if (fromFile < length) {
      const start = offset + fromFile - this.written;
      out.set(this.stage.subarray(start, start + length - fromFile), fromFile);
    }
    return out;
  }

  close(): void {
    try {
      this.handle.close();
    } catch {
      // Closed already.
    }
    void this.dir.removeEntry(this.name).catch(() => {});
    this.release();
  }
}

/** Memory and disk limits, as the page set them (Settings) or from the device. */
export interface SpillSettings {
  /** Decoded cells kept in memory, bytes. */
  cacheBytes?: number;
  /** At most this many bytes of a tractogram's spill in the browser's storage (0: none; absent: `DEFAULT_DISK_BYTES`). */
  diskBytes?: number;
}

let settings: SpillSettings = {};

export function setSpillSettings(next: SpillSettings): void {
  settings = { ...next };
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

/** Calls `listener` when the settings change; returns a function that stops it. */
export function onSpillSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Memory for decoded cells: the setting, or 1/32 of the device's memory
 * (navigator.deviceMemory, which browsers round and cap at 8 GB) between
 * 64 MB and 512 MB.
 */
export function cacheBudget(): number {
  if (settings.cacheBytes !== undefined && settings.cacheBytes > 0) return settings.cacheBytes;
  const gb = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory ?? 4;
  return Math.min(512, Math.max(64, (gb * 1024) / 32)) * 1024 * 1024;
}

/** A spill this small or smaller is kept in memory. */
export const IN_MEMORY_BYTES = 256 * 1024 * 1024;

/** A spill for `expected` bytes: on disk when it can be and the file is large, else in memory. */
export async function openSpill(expected: number, inMemoryUpTo = IN_MEMORY_BYTES): Promise<Spill> {
  if (expected <= inMemoryUpTo || !canSpillToDisk()) return new MemorySpill();
  return OpfsSpill.create();
}

/** The origin's storage: what it may use in all (quota) and what is still free, bytes (Infinity when the browser does not say). */
export async function storageEstimate(): Promise<{ quota: number; free: number }> {
  const storage = (globalThis.navigator as { storage?: { estimate?(): Promise<{ quota?: number; usage?: number }> } } | undefined)?.storage;
  if (storage?.estimate === undefined) return { quota: Infinity, free: Infinity };
  const { quota, usage } = await storage.estimate().catch(() => ({ quota: undefined, usage: undefined }));
  return quota === undefined ? { quota: Infinity, free: Infinity } : { quota, free: quota - (usage ?? 0) };
}

/** Free space the origin may still use, bytes (Infinity when the browser does not say). */
export async function freeStorage(): Promise<number> {
  return (await storageEstimate()).free;
}

// ---------------------------------------------------------------- the disk budget

/** The disk budget when the page set none: 4 GB, … */
export const DEFAULT_DISK_BYTES = 4 * 2 ** 30;
/** … and never more than this share of the origin's quota, … */
export const QUOTA_SHARE = 0.1;
/** … nor more than this share of what is free. */
export const FREE_SHARE = 0.8;
/** Sample levels kept at most: one streamline in 10 000. */
const MAX_SAMPLE = 4;

/**
 * How much of a tractogram is copied into a spill, decided before it is read:
 *
 * - `whole`: every streamline (about 1.5 times the points' bytes), in memory
 *   when that is at most `IN_MEMORY_BYTES`, else on disk within the budget;
 * - `sample`: past the budget, only about one streamline in `every` (10,
 *   100, … 10 000) is copied, whole, with coarser samples of it: the
 *   coarsest choice that fits (in memory, or on disk within the budget).
 *   The rest of the file is not copied; streamlines by id are still read
 *   from the file itself;
 * - `none`: not even one in 10 000 fits.
 *
 * Besides the points, a spill keeps a few bytes per streamline of every one
 * (length, point count, the file's properties, manifests): about 3% of the
 * file, counted in `bytes`.
 */
export interface SpillPlan {
  mode: "whole" | "sample" | "none";
  /** One streamline kept in this many (1 for whole). */
  every: number;
  /** The spill's size, about. */
  bytes: number;
  /** The spill for every streamline, about. */
  wholeBytes: number;
  /** Where: memory or the browser's storage. */
  place: "memory" | "disk";
  /** The disk budget it was decided by (the setting, within the quota and free space). */
  budget: number;
}

/** The disk budget: the setting (or 4 GB), at most 10% of the quota and 80% of what is free. */
export function diskBudget(setting: number | undefined, storage: { quota: number; free: number }): number {
  const wanted = setting === undefined || !(setting >= 0) ? DEFAULT_DISK_BYTES : setting;
  return Math.max(0, Math.min(wanted, QUOTA_SHARE * storage.quota, FREE_SHARE * storage.free));
}

/** The plan for a tractogram whose points take `pointBytes` (as float32 with their values), given the disk budget. */
export function spillPlan(pointBytes: number, budget: number, canUseDisk = true): SpillPlan {
  const wholeBytes = Math.round(pointBytes * 1.5);
  const fixed = Math.round(pointBytes * 0.03);
  for (let k = 0; k <= MAX_SAMPLE; ++k) {
    const bytes = k === 0 ? wholeBytes : Math.round(wholeBytes / 10 ** k) + fixed;
    const place = bytes <= IN_MEMORY_BYTES ? "memory" : canUseDisk && bytes <= budget ? "disk" : undefined;
    if (place !== undefined) return { mode: k === 0 ? "whole" : "sample", every: 10 ** k, bytes, wholeBytes, place, budget };
  }
  return { mode: "none", every: 0, bytes: 0, wholeBytes, place: "memory", budget };
}

/** The plan in this context, with the page's settings and the origin's storage. */
export async function currentSpillPlan(pointBytes: number): Promise<SpillPlan> {
  const disk = canSpillToDisk();
  const storage = disk ? await storageEstimate() : { quota: 0, free: 0 };
  return spillPlan(pointBytes, diskBudget(settings.diskBytes, storage), disk);
}
