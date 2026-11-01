/**
 * The panel's side of the region worker: one worker per store, requests as
 * promises with progress, results cached by region geometry and level, and
 * conversion between the viewer's global coordinates and the store's.
 */
import { type Roi, type RoiGeometry, roiKey } from "./roi.js";
import type { StoreInfo } from "./roi_worker.js";

export type { StoreInfo };

export interface RoiResult {
  ids: BigUint64Array;
  level: number;
  chunks: number;
  bytes: number;
  ms: number;
}

interface Pending {
  resolve: (result: RoiResult) => void;
  reject: (error: Error) => void;
  progress?: (done: number, total: number) => void;
  level: number;
  key: string;
}

/** Objects' whole streamlines: object k's vertices are `positions[3 * offsets[k] ..< 3 * offsets[k + 1]]`, in store coordinates. */
export interface Curves {
  ids: BigUint64Array;
  offsets: Uint32Array;
  positions: Float32Array;
  level: number;
  ms: number;
}

interface PendingCurves {
  resolve: (curves: Curves) => void;
  reject: (error: Error) => void;
  progress?: (done: number, total: number) => void;
  level: number;
}

/** Global dimensions as a Neuroglancer state writes them: name → [scale, unit]. */
export type Dimensions = Record<string, [number, string]>;

export class RoiEngine {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private results = new Map<string, Promise<RoiResult>>();
  private pendingCurves = new Map<number, PendingCurves>();
  readonly ready: Promise<StoreInfo>;

  constructor(readonly storeUrl: string) {
    this.worker = new Worker(new URL("./roi_worker.ts", import.meta.url), { type: "module", name: "track-filtering regions" });
    let opened!: (info: StoreInfo) => void;
    let failed!: (e: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      opened = resolve;
      failed = reject;
    });
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "opened") opened(msg.info);
      else if (msg.type === "error" && msg.id === undefined) failed(new Error(msg.message));
      else if (msg.type === "progress") (this.pending.get(msg.id) ?? this.pendingCurves.get(msg.id))?.progress?.(msg.done, msg.total);
      else if (msg.type === "answer" || (msg.type === "error" && this.pendingCalls.has(msg.id))) {
        const p = this.pendingCalls.get(msg.id);
        this.pendingCalls.delete(msg.id);
        if (msg.type === "error") p?.reject(new Error(msg.message));
        else p?.resolve(msg.value);
      } else if (msg.type === "curves" || (msg.type === "error" && this.pendingCurves.has(msg.id))) {
        const p = this.pendingCurves.get(msg.id);
        this.pendingCurves.delete(msg.id);
        if (p === undefined) return;
        if (msg.type === "error") p.reject(new Error(msg.message));
        else p.resolve({ ids: msg.ids, offsets: msg.offsets, positions: msg.positions, level: p.level, ms: msg.ms });
      } else if (msg.type === "result" || msg.type === "error") {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (p === undefined) return;
        if (msg.type === "error") {
          this.results.delete(p.key);
          p.reject(new Error(msg.message));
        } else {
          p.resolve({ ids: msg.ids, level: p.level, chunks: msg.chunks, bytes: msg.bytes, ms: msg.ms });
        }
      }
    };
    this.worker.postMessage({ type: "open", storeUrl });
  }

  /**
   * The objects passing through a region at a level.  The same region (to a
   * micrometre) at the same level is answered from the cache.
   */
  evaluate(roi: RoiGeometry, level: number, progress?: (done: number, total: number) => void): Promise<RoiResult> {
    const key = roiKey(roi, level);
    const cached = this.results.get(key);
    if (cached !== undefined) return cached;
    const id = this.nextId++;
    const promise = new Promise<RoiResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress, level, key });
    });
    this.results.set(key, promise);
    // Keep the cache to a few hundred regions.
    if (this.results.size > 400) this.results.delete(this.results.keys().next().value!);
    this.worker.postMessage({ type: "evaluate", id, level, roi });
    return promise;
  }

  /**
   * The whole streamlines of `ids` at a level, read in the worker with each
   * chunk read once.  Aborting `signal` stops the reads.
   */
  curves(ids: BigUint64Array, level: number, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Curves> {
    const id = this.nextId++;
    return new Promise<Curves>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      this.pendingCurves.set(id, { resolve, reject, progress, level });
      signal?.addEventListener("abort", () => {
        if (!this.pendingCurves.delete(id)) return;
        this.worker.postMessage({ type: "cancel", id });
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      });
      this.worker.postMessage({ type: "curves", id, level, ids });
    });
  }

  private readonly pendingCalls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  private call<T>(op: string, args: object): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      this.worker.postMessage({ type: "call", id, op, ...args });
    });
  }

  /** The store's object ids of these Neuroglancer segment ids, at a level (undefined where unknown). */
  objectIds(segmentIds: BigUint64Array, level = 0): Promise<{ objectIds: BigUint64Array; missing: number }> {
    return this.call("objectIds", { level, segmentIds });
  }

  /** A level's groups as stored: their names and members (object ids). */
  groups(level = 0): Promise<{ names: string[]; members: BigUint64Array[]; levelPath: string }> {
    return this.call("groups", { level });
  }

  dispose(): void {
    this.worker.terminate();
    // Work given up, not failed: callers ignore aborts.
    const closed = () => new DOMException("The region worker was closed", "AbortError");
    for (const p of this.pending.values()) p.reject(closed());
    for (const p of this.pendingCurves.values()) p.reject(closed());
    for (const p of this.pendingCalls.values()) p.reject(closed());
    this.pendingCalls.clear();
    this.pending.clear();
    this.pendingCurves.clear();
  }
}

/**
 * Global (viewer) coordinates to store coordinates, per axis: the ratio of
 * the global dimension's scale to the store's, then the store's offset.
 */
export function toStore(roi: Roi, dims: Dimensions, info: StoreInfo): RoiGeometry {
  const factor = info.axisNames.map((name, k) => {
    const global = dims[name]?.[0];
    const stored = info.axisScales[k];
    return global !== undefined && stored > 0 ? global / stored : 1;
  });
  const offset = info.coordinateOffset ?? [0, 0, 0];
  return {
    shape: roi.shape,
    center: [0, 1, 2].map((k) => roi.center[k] * factor[k] - (offset[k] ?? 0)) as [number, number, number],
    radius: roi.radius * factor[0],
    size: [0, 1, 2].map((k) => roi.size[k] * factor[k]) as [number, number, number],
  };
}

/** The finest level other than 0 small enough to preview a region quickly on, if any. */
export function previewLevel(info: StoreInfo, maxVertices = 20_000_000): number | undefined {
  const candidates = info.levels.filter((l) => l.index > 0 && (l.vertexCount ?? Infinity) <= maxVertices);
  return candidates.length === 0 ? undefined : candidates.reduce((a, b) => (a.index < b.index ? a : b)).index;
}
