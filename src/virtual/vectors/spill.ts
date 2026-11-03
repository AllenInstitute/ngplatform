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
 * `spillBudget()` says how much memory decoded cells may take, from the
 * device's memory unless the page set a budget (Settings).
 */

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

export class OpfsSpill implements Spill {
  size = 0;

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
    let done = 0;
    while (done < bytes.byteLength) done += this.handle.write(bytes.subarray(done), { at: at + done });
    this.size += bytes.byteLength;
    return at;
  }

  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const n = this.handle.read(out.subarray(done), { at: offset + done });
      if (n <= 0) throw new Error(`the spill file ends at ${offset + done} (wanted ${offset + length})`);
      done += n;
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

/** A spill for `expected` bytes: on disk when it can be and the file is large, else in memory. */
export async function openSpill(expected: number, inMemoryUpTo = 256 * 1024 * 1024): Promise<Spill> {
  if (expected <= inMemoryUpTo || !canSpillToDisk()) return new MemorySpill();
  return OpfsSpill.create();
}

/** Free space the origin may still use, bytes (Infinity when the browser does not say). */
export async function freeStorage(): Promise<number> {
  const storage = (globalThis.navigator as { storage?: { estimate?(): Promise<{ quota?: number; usage?: number }> } } | undefined)?.storage;
  if (storage?.estimate === undefined) return Infinity;
  const { quota, usage } = await storage.estimate().catch(() => ({ quota: undefined, usage: undefined }));
  return quota === undefined ? Infinity : quota - (usage ?? 0);
}
