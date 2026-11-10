/**
 * The main thread's side of the reading worker, for one layer: which chunks
 * its views want, merged and sent on; the chunks that came back, kept (up
 * to a byte budget) until each view has put them on its GPU.  The layer's
 * chosen objects read whole, by id, are kept apart (`objects`).
 *
 * A client may take over the worker of the layer's client before it
 * (`adopt`: a segmentation's next mesh store), which keeps what it has read
 * of the volume; the one before keeps its chunks to draw, and asks for
 * no more.
 */
import type { BuiltChunk } from "./chunk_build.js";
import type { StoreInfo } from "./luxar_worker.js";
import { ObjectSets } from "./objects.js";
import type { AuthHeader } from "./precomputed_meshes.js";

/** Each open of a store, in any worker: answers for another are ignored. */
let epochs = 0;

export type { StoreInfo };

/** Built chunks kept on this side, for the views to upload (a view keeps its own GPU copy). */
const CPU_BYTES = 384 * 1024 * 1024;

const bytesOf = (c: BuiltChunk) => c.vertices.byteLength + c.segments.byteLength + c.slots.byteLength + c.objectIds.byteLength + c.objectWeight.byteLength + c.triangles.byteLength + c.normals.byteLength;

export class StoreClient {
  private worker: Worker;
  private readonly epoch = ++epochs;
  /** The worker went on to the layer's next store: nothing more is asked for or comes. */
  private detached = false;
  /** The store's server wants a sign-in. */
  signIn = false;
  /** What the store says of itself, once each: the reader's notes, segments with no mesh, fragments that failed. */
  readonly warnings: string[] = [];
  readonly ready: Promise<StoreInfo>;
  info: StoreInfo | undefined;
  error: string | undefined;
  /** By key: a built chunk, or null for an empty one. */
  private chunks = new Map<string, BuiltChunk | null>();
  private bytes = 0;
  private requested = new Set<string>();
  /** The worker failed: nothing more will come. */
  private stopped = false;
  /** Chunks whose read failed, with when they may be asked for again (a network blip need not leave a hole for good). */
  private failed = new Map<string, number>();
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

  constructor(
    readonly storeUrl: string,
    options: { adopt?: StoreClient; headers?: readonly AuthHeader[] } = {},
  ) {
    this.worker = options.adopt?.handOff() ?? new Worker(new URL("./luxar_worker.ts", import.meta.url), { type: "module", name: "luxar" });
    let opened!: (info: StoreInfo) => void;
    let failed!: (e: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      opened = resolve;
      failed = reject;
    });
    this.ready.catch(() => {});
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      // An answer for the store this worker read before.
      if (msg.epoch !== this.epoch) return;
      if (msg.type === "opened") {
        this.info = msg.info;
        for (const w of (msg.info as StoreInfo).warnings ?? []) this.warn(w);
        opened(msg.info);
        this.send();
        return;
      }
      if (msg.type === "warning") {
        this.warn(msg.message);
        this.onChunk?.();
        return;
      }
      if (msg.type === "error" && msg.key === undefined) {
        this.error = msg.message;
        this.signIn = msg.signIn === true;
        failed(new Error(msg.message));
        this.onChunk?.();
        return;
      }
      if (msg.scalar !== this.scalar) return;
      if (msg.type === "objects" || msg.type === "objectsError") {
        // Chosen objects read whole.
        if (msg.type === "objects") {
          const chunk = msg.chunk as BuiltChunk | null;
          if (chunk?.valueRange !== undefined) this.widenRange(chunk.valueRange);
          this.objects.arrived(msg.key, chunk, msg.found as BigUint64Array);
        } else this.objects.failed(msg.key, msg.message);
        this.onChunk?.();
        return;
      }
      this.requested.delete(msg.key);
      if (msg.type === "chunk") {
        const chunk = msg.chunk as BuiltChunk;
        if (this.failed.size === 0) this.error = undefined;
        this.store(msg.key, chunk);
        if (chunk.valueRange !== undefined) this.widenRange(chunk.valueRange);
      } else if (msg.type === "empty") {
        this.store(msg.key, null);
      } else if (msg.type === "error") {
        this.failed.set(msg.key, performance.now() + 15_000);
        this.error = msg.message;
        this.signIn = msg.signIn === true;
      }
      ++this.arrivals;
      this.onChunk?.();
    };
    // A worker that fails to start or dies (out of memory, say) answers nothing: say so, and wait for nothing more from it.
    this.worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      this.stopped = true;
      this.worker.terminate();
      this.error = `the Luxar reader stopped: ${event.message || "it could not start"}`;
      failed(new Error(this.error));
      this.requested.clear();
      this.onChunk?.();
    };
    this.worker.postMessage({ type: "open", storeUrl, epoch: this.epoch, headers: options.headers ?? [] });
    this.objects = new ObjectSets((key, plan, ids) => {
      if (!this.detached) this.worker.postMessage({ type: "objects", key, level: plan.level, mode: plan.mode, ids, scalar: this.scalar }, [ids.buffer]);
    });
  }

  private warn(warning: string): void {
    if (typeof warning === "string" && warning !== "" && !this.warnings.includes(warning)) this.warnings.push(warning);
  }

  /** The layer's chosen objects read whole, by id (./objects.ts). */
  readonly objects: ObjectSets;

  private widenRange([lo, hi]: [number, number]): void {
    this.valueRange = this.valueRange === undefined ? [lo, hi] : [Math.min(this.valueRange[0], lo), Math.max(this.valueRange[1], hi)];
  }

  /** What each vertex's value holds now (styles.scalarOf). */
  get scalarName(): string {
    return this.scalar;
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

  /**
   * Gives the worker to the layer's next client: this one keeps what it has
   * (its view still draws it during the hand-over) and asks for no more.
   */
  private handOff(): Worker | undefined {
    if (this.detached || this.stopped) return undefined;
    this.detached = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.requested.clear();
    return this.worker;
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
    this.objects.clear();
    // The objects being read for the scalar before are not wanted.
    if (!this.detached) this.worker.postMessage({ type: "cancelObjects" });
    this.send();
  }

  /** A chunk: built, null when it has nothing, undefined while it is not here. */
  get(key: string): BuiltChunk | null | undefined {
    return this.chunks.get(key);
  }

  /** Whether a chunk has been read (empty or not), so a view need not wait for it. */
  has(key: string): boolean {
    return this.chunks.has(key) || this.failedRecently(key) || this.stopped;
  }

  /** Whether a chunk's read failed lately: counted as read until it may be asked for again. */
  private failedRecently(key: string): boolean {
    const retry = this.failed.get(key);
    if (retry === undefined) return false;
    if (performance.now() < retry) return true;
    this.failed.delete(key);
    return false;
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
    if (this.info === undefined || this.stopped || this.detached) return;
    const lists = [...this.wants.values()];
    const merged: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; lists.some((l) => i < l.length); ++i) {
      for (const l of lists) {
        const k = l[i];
        if (k === undefined || seen.has(k)) continue;
        seen.add(k);
        if (this.chunks.has(k) || this.failedRecently(k)) continue;
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
    // A worker handed on is the next client's.
    if (!this.detached) this.worker.terminate();
    this.chunks.clear();
    this.objects.clear();
    this.onChunk = undefined;
  }
}
