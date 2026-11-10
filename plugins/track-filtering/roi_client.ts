/**
 * The panel's side of the region worker: one worker per store, requests as
 * promises with progress and cancel, results cached by region geometry and
 * level within a bound in bytes, a worker that dies started again, and
 * conversion between the viewer's global coordinates and the store's.
 */
import { type MaskSource, type MaskVolume, type Roi, type RoiGeometry, roiKey } from "./roi.js";
import type { StoreInfo } from "./roi_worker.js";
import type { TrkSpace } from "./trk.js";

export type { StoreInfo };

export interface RoiResult {
  ids: BigUint64Array;
  level: number;
  chunks: number;
  bytes: number;
  ms: number;
}

/** Objects' whole streamlines: object k's vertices are `positions[3 * offsets[k] ..< 3 * offsets[k + 1]]`, in store coordinates. */
export interface Curves {
  ids: BigUint64Array;
  offsets: Uint32Array;
  positions: Float32Array;
  level: number;
  ms: number;
}

/** Global dimensions as a Neuroglancer state writes them: name → [scale, unit]. */
export type Dimensions = Record<string, [number, string]>;

/** Regions' answers kept for asking again: a brain-sized box on millions of streamlines is tens of MB. */
export const RESULT_CACHE_BYTES = 192 * 2 ** 20;

export interface RoiEngineOptions {
  /** Starts a worker (a test gives a stand-in). */
  start?: () => Worker;
  /** The bound on the answers kept, in bytes. */
  cacheBytes?: number;
}

/** A request to the worker: posted once its store is open, and posted again once if the worker dies. */
interface Request {
  message: Record<string, unknown>;
  transfer: Transferable[];
  resolve: (msg: any) => void;
  reject: (error: Error) => void;
  progress?: (msg: any) => void;
  /** The worker it was posted to, once posted. */
  worker?: Worker;
  /** Whether it may run again on a new worker after one dies (not when its buffers went with it). */
  rerun: boolean;
}

/** A region test being worked out, shared by everyone asking for it until the last gives up. */
interface Flight {
  id: number;
  promise: Promise<RoiResult>;
  waiting: number;
  progress: Set<(done: number, total: number) => void>;
}

const aborted = () => new DOMException("Aborted", "AbortError");

export class RoiEngine {
  private worker: Worker | undefined;
  /** The current worker's store opened (or not). */
  private opening: Promise<Worker> | undefined;
  private nextId = 1;
  private readonly requests = new Map<number, Request>();
  private readonly flights = new Map<string, Flight>();
  /** Answers by region and level, least recently used first, within `cacheBytes`. */
  private readonly results = new Map<string, RoiResult>();
  private resultBytes = 0;
  private disposed = false;
  private readonly start: () => Worker;
  private readonly cacheBytes: number;
  readonly ready: Promise<StoreInfo>;
  private opened!: (info: StoreInfo) => void;
  private failed!: (e: Error) => void;

  constructor(
    readonly storeUrl: string,
    options: RoiEngineOptions = {},
  ) {
    this.start = options.start ?? (() => new Worker(new URL("./roi_worker.ts", import.meta.url), { type: "module", name: "track-filtering regions" }));
    this.cacheBytes = options.cacheBytes ?? RESULT_CACHE_BYTES;
    this.ready = new Promise((resolve, reject) => {
      this.opened = resolve;
      this.failed = reject;
    });
    void this.started().catch(() => {});
  }

  /** The bytes of answers kept. */
  get cachedBytes(): number {
    return this.resultBytes;
  }

  /** The worker, its store open: started again after one died. */
  private started(): Promise<Worker> {
    if (this.opening !== undefined) return this.opening;
    const worker = this.start();
    this.worker = worker;
    this.opening = new Promise<Worker>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg.id === undefined) {
          if (msg.type === "opened") {
            this.opened(msg.info);
            resolve(worker);
          } else if (msg.type === "error") {
            const error = new Error(msg.message);
            this.failed(error);
            reject(error);
          }
          return;
        }
        const request = this.requests.get(msg.id);
        if (request === undefined || request.worker !== worker) return;
        if (msg.type === "progress") {
          request.progress?.(msg);
          return;
        }
        this.requests.delete(msg.id);
        if (msg.type === "error") request.reject(new Error(msg.message));
        else request.resolve(msg);
      };
      // A worker that fails to start or dies (out of memory, say) answers nothing.
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        this.stopped(worker, event.message || "it could not start", reject);
      };
      worker.onmessageerror = () => this.stopped(worker, "its answer could not be read", reject);
    });
    this.opening.catch(() => {});
    worker.postMessage({ type: "open", storeUrl: this.storeUrl });
    return this.opening;
  }

  /**
   * A worker died: a new one is started, and what it was working on runs
   * again on it, once.  What fails a second time fails, with why.
   */
  private stopped(worker: Worker, why: string, reject: (e: Error) => void): void {
    if (this.worker !== worker) return;
    worker.terminate();
    this.worker = undefined;
    this.opening = undefined;
    const error = new Error(`the region reader stopped: ${why}`);
    this.failed(error);
    reject(error);
    const again: [number, Request][] = [];
    for (const [id, request] of this.requests) {
      if (request.worker !== worker) continue;
      if (request.rerun) {
        request.rerun = false;
        request.worker = undefined;
        again.push([id, request]);
      } else {
        this.requests.delete(id);
        request.reject(error);
      }
    }
    for (const [id, request] of again) this.post(id, request);
  }

  private post(id: number, request: Request): void {
    this.started().then(
      (worker) => {
        // Given up meanwhile, or posted already.
        if (this.requests.get(id) !== request || request.worker !== undefined) return;
        request.worker = worker;
        worker.postMessage({ ...request.message, id }, request.transfer);
      },
      (e) => {
        if (this.requests.get(id) !== request || request.worker !== undefined) return;
        this.requests.delete(id);
        request.reject(e as Error);
      },
    );
  }

  /** Sends a request; its answer.  Aborting `signal` tells the worker to stop it. */
  private request(message: Record<string, unknown>, options: { progress?: (msg: any) => void; signal?: AbortSignal; transfer?: Transferable[]; id?: number } = {}): Promise<any> {
    if (this.disposed) return Promise.reject(new DOMException("The region worker was closed", "AbortError"));
    if (options.signal?.aborted) return Promise.reject(aborted());
    const id = options.id ?? this.nextId++;
    return new Promise((resolve, reject) => {
      const request: Request = { message, transfer: options.transfer ?? [], resolve, reject, progress: options.progress, rerun: (options.transfer ?? []).length === 0 };
      this.requests.set(id, request);
      options.signal?.addEventListener(
        "abort",
        () => {
          if (this.requests.get(id) !== request) return;
          this.requests.delete(id);
          request.worker?.postMessage({ type: "cancel", id });
          reject(aborted());
        },
        { once: true },
      );
      this.post(id, request);
    });
  }

  /**
   * The objects passing through a region at a level.  The same region (to a
   * micrometre) at the same level is answered from the cache, or shares the
   * test already running; aborting `signal` gives up waiting, and the test
   * stops once nobody is waiting for it.
   */
  evaluate(roi: RoiGeometry, level: number, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<RoiResult> {
    if (signal?.aborted) return Promise.reject(aborted());
    const key = roiKey(roi, level);
    const kept = this.results.get(key);
    if (kept !== undefined) {
      this.results.delete(key);
      this.results.set(key, kept);
      return Promise.resolve(kept);
    }
    let flight = this.flights.get(key);
    if (flight === undefined) {
      const id = this.nextId++;
      const listeners = new Set<(done: number, total: number) => void>();
      const controller = new AbortController();
      const promise = this.request({ type: "evaluate", level, roi }, { id, signal: controller.signal, progress: (msg) => listeners.forEach((l) => l(msg.done, msg.total)) }).then(
        (msg): RoiResult => {
          const result = { ids: msg.ids as BigUint64Array, level, chunks: msg.chunks, bytes: msg.bytes, ms: msg.ms };
          this.keep(key, result);
          return result;
        },
      );
      const created: Flight & { controller: AbortController } = { id, promise, waiting: 0, progress: listeners, controller };
      const done = () => {
        if (this.flights.get(key) === created) this.flights.delete(key);
      };
      promise.then(done, done);
      this.flights.set(key, created);
      flight = created;
    }
    const shared = flight as Flight & { controller: AbortController };
    shared.waiting++;
    if (progress) shared.progress.add(progress);
    return new Promise<RoiResult>((resolve, reject) => {
      let settled = false;
      const leave = () => {
        if (settled) return false;
        settled = true;
        shared.waiting--;
        if (progress) shared.progress.delete(progress);
        return true;
      };
      signal?.addEventListener(
        "abort",
        () => {
          if (!leave()) return;
          reject(aborted());
          // Nobody else wants it: the worker stops testing.
          if (shared.waiting === 0) {
            if (this.flights.get(key) === shared) this.flights.delete(key);
            shared.controller.abort();
          }
        },
        { once: true },
      );
      shared.promise.then(
        (r) => leave() && resolve(r),
        (e) => leave() && reject(e),
      );
    });
  }

  /** Keeps an answer, the least recently used let go past the bound (one larger than the bound is not kept). */
  private keep(key: string, result: RoiResult): void {
    const bytes = result.ids.byteLength + 64;
    if (bytes > this.cacheBytes) return;
    const old = this.results.get(key);
    if (old !== undefined) {
      this.results.delete(key);
      this.resultBytes -= old.ids.byteLength + 64;
    }
    this.results.set(key, result);
    this.resultBytes += bytes;
    for (const [k, r] of this.results) {
      if (this.resultBytes <= this.cacheBytes) break;
      this.results.delete(k);
      this.resultBytes -= r.ids.byteLength + 64;
    }
  }

  /**
   * The whole streamlines of `ids` at a level, read in the worker with each
   * chunk read once.  Aborting `signal` stops the reads.
   */
  curves(ids: BigUint64Array, level: number, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Curves> {
    if (this.direct !== undefined) {
      // Read from the file itself (a tractogram on this computer): no chunks.
      const started = performance.now();
      return this.direct(ids, level).then((c) => {
        signal?.throwIfAborted();
        progress?.(1, 1);
        return { ...c, level, ms: performance.now() - started };
      });
    }
    return this.request({ type: "curves", level, ids }, { signal, progress: progress && ((msg) => progress(msg.done, msg.total)) }).then((msg) => ({
      ids: msg.ids,
      offsets: msg.offsets,
      positions: msg.positions,
      level,
      ms: msg.ms,
    }));
  }

  /**
   * The .trk file of `ids`' whole streamlines at a level, read and written
   * in the worker: the page gets the file's bytes, ready to open.
   */
  trk(ids: BigUint64Array, level: number, space: TrkSpace, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (this.direct !== undefined) {
      // Read from the file on this computer, then written in the worker (its buffers go with it).
      return this.direct(ids, level).then((c) => {
        signal?.throwIfAborted();
        return this.request({ type: "call", op: "trk", offsets: c.offsets, positions: c.positions, space }, { signal, transfer: [c.offsets.buffer, c.positions.buffer] }).then(
          (msg) => msg.value as ArrayBuffer,
        );
      });
    }
    return this.request({ type: "trk", level, ids, space }, { signal }).then((msg) => msg.bytes as ArrayBuffer);
  }

  /**
   * Whole streamlines read another way than from the chunks: a virtual
   * store of a tractogram on this computer reads them from the file by id
   * (its `curves` message), which reads only those streamlines' bytes.
   */
  direct: ((ids: BigUint64Array, level: number) => Promise<{ ids: BigUint64Array; offsets: Uint32Array; positions: Float32Array }>) | undefined;

  private call<T>(op: string, args: object): Promise<T> {
    return this.request({ type: "call", op, ...args }).then((msg) => msg.value as T);
  }

  /** The store's object ids of these Neuroglancer segment ids, at a level (undefined where unknown). */
  objectIds(segmentIds: BigUint64Array, level = 0): Promise<{ objectIds: BigUint64Array; missing: number }> {
    return this.call("objectIds", { level, segmentIds });
  }

  /** An image's levels (for a mask): voxels along x, y, z, and voxel indices to RAS mm. */
  maskLevels(store: string): Promise<{ size: [number, number, number]; voxelToRas: number[] }[]> {
    return this.call("maskLevels", { store });
  }

  /** A mask's voxels as the region tests read them. */
  maskVolume(source: MaskSource): Promise<MaskVolume> {
    return this.call("maskVolume", { source });
  }

  /** A level's groups as stored: their names and members (object ids). */
  groups(level = 0): Promise<{ names: string[]; members: BigUint64Array[]; levelPath: string }> {
    return this.call("groups", { level });
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = undefined;
    this.opening = undefined;
    // Work given up, not failed: callers ignore aborts.
    for (const request of this.requests.values()) request.reject(new DOMException("The region worker was closed", "AbortError"));
    this.requests.clear();
    this.flights.clear();
    this.results.clear();
    this.resultBytes = 0;
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
    ...(roi.ends === undefined ? {} : { ends: roi.ends }),
    ...(roi.shape === "disk" ? { axis: roi.axis ?? 2, ...(roi.angle === undefined ? {} : { angle: roi.angle }) } : {}),
  };
}

/** The finest level other than 0 small enough to preview a region quickly on, if any. */
export function previewLevel(info: StoreInfo, maxVertices = 20_000_000): number | undefined {
  const candidates = info.levels.filter((l) => l.index > 0 && (l.vertexCount ?? Infinity) <= maxVertices);
  return candidates.length === 0 ? undefined : candidates.reduce((a, b) => (a.index < b.index ? a : b)).index;
}
