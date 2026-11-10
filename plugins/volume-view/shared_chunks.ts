/**
 * Decoded image chunks shared by every tool that reads images with the
 * volume view's reader (Measure, Segmentation, Registration, the atlas,
 * splats and rendering on this computer), within one byte budget.
 *
 * Each tool reads in a worker of its own.  The page starts one more, the
 * image chunk worker (./image_chunk_worker.ts), and gives each tool's worker a
 * port to it ({@link withSharedChunks}): the tools' workers then ask it for
 * chunks, it reads and decodes each once and keeps them in one
 * {@link ChunkCache}, and the tools keep none of their own.  Where there is
 * no such worker (tests, a worker started without the port, or after the
 * chunk worker stopped), the readers of one worker share one cache of the
 * same budget there.
 */
import type { LevelRef } from "./volume_reader.js";

/** The bytes of decoded chunks kept for all the tools together. */
export const SHARED_CHUNK_BYTES = 384 * 2 ** 20;

/** What an entry costs besides its bytes (a missing chunk is kept too, as "none"). */
const ENTRY_BYTES = 64;

/**
 * Chunks by key, least recently used out first once past `maxBytes`.  A
 * chunk being read is read once for everyone who asks for it while it is.
 */
export class ChunkCache {
  private readonly kept = new Map<string, Uint8Array | undefined>();
  private readonly sizes = new Map<string, number>();
  private readonly pending = new Map<string, { promise: Promise<Uint8Array | undefined>; keep: boolean }>();
  private held = 0;

  constructor(readonly maxBytes = SHARED_CHUNK_BYTES) {}

  /** The bytes kept now. */
  get bytes(): number {
    return this.held;
  }

  /** How many chunks are kept now. */
  get size(): number {
    return this.kept.size;
  }

  /**
   * The chunk at `key`: kept, being read, or read now by `load`.  With
   * `keep` false it is not kept afterwards unless someone else asked for
   * it to be: a pass over every chunk of a level would otherwise push out
   * everything the other tools use.  A failed read is not kept.
   */
  get(key: string, load: () => Promise<Uint8Array | undefined>, keep = true): Promise<Uint8Array | undefined> {
    if (this.kept.has(key)) {
      const data = this.kept.get(key);
      // Used again: the newest.
      this.kept.delete(key);
      this.kept.set(key, data);
      return Promise.resolve(data);
    }
    const under = this.pending.get(key);
    if (under !== undefined) {
      under.keep ||= keep;
      return under.promise;
    }
    const entry = { promise: load(), keep };
    this.pending.set(key, entry);
    entry.promise.then(
      (data) => {
        if (this.pending.get(key) !== entry) return; // forgotten while it was read
        this.pending.delete(key);
        if (entry.keep) this.put(key, data);
      },
      () => this.pending.get(key) === entry && this.pending.delete(key),
    );
    return entry.promise;
  }

  private put(key: string, data: Uint8Array | undefined): void {
    const bytes = (data?.byteLength ?? 0) + ENTRY_BYTES;
    if (bytes > this.maxBytes) return;
    this.kept.set(key, data);
    this.sizes.set(key, bytes);
    this.held += bytes;
    for (const old of this.kept.keys()) {
      if (this.held <= this.maxBytes) break;
      this.held -= this.sizes.get(old) ?? 0;
      this.sizes.delete(old);
      this.kept.delete(old);
    }
  }

  /** Drops the chunks whose keys start with `prefix` (a level opened again may have been written again). */
  forget(prefix: string): void {
    for (const key of [...this.kept.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.held -= this.sizes.get(key) ?? 0;
      this.sizes.delete(key);
      this.kept.delete(key);
    }
    for (const key of [...this.pending.keys()]) if (key.startsWith(prefix)) this.pending.delete(key);
  }
}

/** A level's key: its store and array (or scale). */
export function levelKey(ref: LevelRef): string {
  return ref.kind === "ome" ? `${ref.level.url}${ref.level.path}|` : `${ref.url}${ref.scale.key}|`;
}

/** Where the readers of a worker get chunks from. */
export interface ChunkSource {
  /** A stored chunk of a level, decoded (`raw` reads it here when this worker reads its own). */
  chunk(ref: LevelRef, index: number[], keep: boolean, raw: (index: number[]) => Promise<Uint8Array | undefined>): Promise<Uint8Array | undefined>;
  /** Forgets a level's chunks: it is being opened again. */
  forget(ref: LevelRef): void;
}

/** Chunks read here and kept in this worker's one cache. */
export class LocalChunks implements ChunkSource {
  constructor(readonly cache = new ChunkCache()) {}

  chunk(ref: LevelRef, index: number[], keep: boolean, raw: (index: number[]) => Promise<Uint8Array | undefined>) {
    return this.cache.get(levelKey(ref) + index.join("."), () => raw(index), keep);
  }

  forget(ref: LevelRef): void {
    this.cache.forget(levelKey(ref));
  }
}

/** The message a tool's worker is given its port to the chunk worker by (`port` undefined: it stopped). */
export const CHUNK_PORT = "ngp-image-chunks";

/** Chunks asked of the image chunk worker over a port. */
export class RemoteChunks implements ChunkSource {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (data: Uint8Array | undefined) => void; reject: (error: Error) => void }>();

  constructor(private readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      const w = this.waiting.get(msg?.id);
      if (w === undefined) return;
      this.waiting.delete(msg.id);
      if (msg.error !== undefined) w.reject(new Error(msg.error));
      else w.resolve(msg.data ?? undefined);
    };
  }

  chunk(ref: LevelRef, index: number[], keep: boolean): Promise<Uint8Array | undefined> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.port.postMessage({ type: "chunk", id, ref, index, keep });
    });
  }

  forget(ref: LevelRef): void {
    this.port.postMessage({ type: "forget", ref });
  }

  /** The chunk worker stopped: every read waiting on it fails (and is read here next time). */
  stop(): void {
    for (const w of this.waiting.values()) w.reject(new Error("the image chunk reader stopped"));
    this.waiting.clear();
    this.port.close();
  }
}

let local: LocalChunks | undefined;
let remote: RemoteChunks | undefined;

/** Where this worker's readers get chunks: the chunk worker when this worker was given a port to it, else here. */
export function chunkSource(): ChunkSource {
  return remote ?? (local ??= new LocalChunks());
}

/** Uses `port` to the chunk worker from now on (undefined: back to reading here). */
export function useChunkPort(port: MessagePort | undefined): void {
  remote?.stop();
  remote = port === undefined ? undefined : new RemoteChunks(port);
}

// In a tool's worker: the port comes as the first message, before the tool's own (which never see it).
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined" && typeof addEventListener === "function") {
  addEventListener("message", (event: Event) => {
    const msg = (event as MessageEvent).data;
    if (msg?.type !== CHUNK_PORT) return;
    event.stopImmediatePropagation();
    useChunkPort(msg.port ?? undefined);
  });
}
