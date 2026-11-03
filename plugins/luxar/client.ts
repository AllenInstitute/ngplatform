/**
 * The main thread's side of the reading worker, for one layer: which chunks
 * its views want, merged and sent on; the chunks that came back, kept (up
 * to a byte budget) until each view has put them on its GPU.
 */
import type { BuiltChunk } from "./chunk_build.js";
import type { StoreInfo } from "./luxar_worker.js";

export type { StoreInfo };

/** Built chunks kept on this side, for the views to upload (a view keeps its own GPU copy). */
const CPU_BYTES = 384 * 1024 * 1024;

const bytesOf = (c: BuiltChunk) => c.vertices.byteLength + c.segments.byteLength + c.slots.byteLength + c.objectIds.byteLength + c.objectWeight.byteLength;

export class StoreClient {
  private worker: Worker;
  readonly ready: Promise<StoreInfo>;
  info: StoreInfo | undefined;
  error: string | undefined;
  /** By key: a built chunk, or null for an empty one. */
  private chunks = new Map<string, BuiltChunk | null>();
  private bytes = 0;
  private requested = new Set<string>();
  private failed = new Set<string>();
  private wants = new Map<string, string[]>();
  private sendQueued = false;
  private scalar = "none";
  /** Called when a chunk arrives (or fails). */
  onChunk: (() => void) | undefined;
  /** The value range over the chunks loaded, for a colormap. */
  valueRange: [number, number] | undefined;
  /** Generation: changes when the chunks' values are redone (a new scalar), so views drop their copies. */
  generation = 0;
  /** Counts the chunks that have come back, so a view can tell when it has something new to draw. */
  arrivals = 0;

  constructor(readonly storeUrl: string) {
    this.worker = new Worker(new URL("./luxar_worker.ts", import.meta.url), { type: "module", name: "luxar" });
    let opened!: (info: StoreInfo) => void;
    let failed!: (e: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      opened = resolve;
      failed = reject;
    });
    this.ready.catch(() => {});
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "opened") {
        this.info = msg.info;
        opened(msg.info);
        this.send();
        return;
      }
      if (msg.type === "error" && msg.key === undefined) {
        this.error = msg.message;
        failed(new Error(msg.message));
        this.onChunk?.();
        return;
      }
      if (msg.scalar !== this.scalar) return;
      this.requested.delete(msg.key);
      if (msg.type === "chunk") {
        const chunk = msg.chunk as BuiltChunk;
        this.store(msg.key, chunk);
        if (chunk.valueRange !== undefined) {
          const [lo, hi] = chunk.valueRange;
          this.valueRange = this.valueRange === undefined ? [lo, hi] : [Math.min(this.valueRange[0], lo), Math.max(this.valueRange[1], hi)];
        }
      } else if (msg.type === "empty") {
        this.store(msg.key, null);
      } else if (msg.type === "error") {
        this.failed.add(msg.key);
        this.error = msg.message;
      }
      ++this.arrivals;
      this.onChunk?.();
    };
    this.worker.postMessage({ type: "open", storeUrl });
  }

  private store(key: string, chunk: BuiltChunk | null): void {
    const old = this.chunks.get(key);
    if (old) this.bytes -= bytesOf(old);
    this.chunks.delete(key);
    this.chunks.set(key, chunk);
    if (chunk) this.bytes += bytesOf(chunk);
    for (const [k, c] of this.chunks) {
      if (this.bytes <= CPU_BYTES) break;
      if (k === key || c === null) continue;
      this.bytes -= bytesOf(c);
      this.chunks.delete(k);
    }
  }

  /** What each vertex's value holds (styles.scalarOf); a change drops every chunk. */
  setScalar(scalar: string): void {
    if (scalar === this.scalar) return;
    this.scalar = scalar;
    this.chunks.clear();
    this.bytes = 0;
    this.requested.clear();
    this.failed.clear();
    this.valueRange = undefined;
    ++this.generation;
    this.send();
  }

  /** A chunk: built, null when it has nothing, undefined while it is not here. */
  get(key: string): BuiltChunk | null | undefined {
    return this.chunks.get(key);
  }

  /** Whether a chunk has been read (empty or not), so a view need not wait for it. */
  has(key: string): boolean {
    return this.chunks.has(key) || this.failed.has(key);
  }

  /** A view's wanted chunks, most wanted first; replaces its last list. */
  want(view: string, keys: string[]): void {
    const old = this.wants.get(view);
    if (old !== undefined && old.length === keys.length && old.every((k, i) => k === keys[i])) return;
    this.wants.set(view, keys);
    if (this.sendQueued) return;
    this.sendQueued = true;
    queueMicrotask(() => {
      this.sendQueued = false;
      this.send();
    });
  }

  /** Every view's wants, taken in turn, so each gets its first chunks soon. */
  private send(): void {
    if (this.info === undefined) return;
    const lists = [...this.wants.values()];
    const merged: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; lists.some((l) => i < l.length); ++i) {
      for (const l of lists) {
        const k = l[i];
        if (k === undefined || seen.has(k)) continue;
        seen.add(k);
        if (this.chunks.has(k) || this.failed.has(k)) continue;
        merged.push(k);
      }
    }
    // The worker's queue is replaced, so what is pending is this list.
    this.requested = new Set(merged);
    this.worker.postMessage({ type: "want", keys: merged, scalar: this.scalar });
  }

  /** Chunks asked for and not yet back. */
  get pending(): number {
    return this.requested.size;
  }

  dispose(): void {
    this.worker.terminate();
    this.chunks.clear();
    this.onChunk = undefined;
  }
}
