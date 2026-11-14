/**
 * Reduce workers: the slabs of an image level read from the file are
 * reduced into the next coarser level in a few workers beside the one
 * serving the image (./nifti.ts, `reduceInWorkers`), so that reading the
 * file and reducing it go on at once on several cores.  A worker reads a
 * finer slab itself where the file holds it as it is served (uncompressed
 * NIfTI or TIFF strips: `ByteSource.stored`), or is handed it
 * (transferred, not copied); its part of the coarser slab comes back.
 *
 * Workers: half the device's cores (`navigator.hardwareConcurrency`), at
 * most `MAX_WORKERS`; started when first needed and stopped after
 * `IDLE_MS` without work.  The finer slabs being read or reduced at once
 * are bounded in bytes (`InFlight`), so memory stays at a few slabs.
 */
import type { ReduceJob, Slab } from "./slabs.js";

export interface ReducePool {
  /** Workers it may use. */
  readonly size: number;
  /** The job's part of the coarser slab (and the finer slab, when asked for); the job's slab is transferred (unusable after). */
  run(job: ReduceJob): Promise<{ part: Slab; finer?: Slab }>;
}

/** Workers at most, … */
const MAX_WORKERS = 6;
/** … stopped after this long without work, ms. */
const IDLE_MS = 30_000;
/** Levels smaller than this are reduced where they are read (starting workers would take longer). */
const SMALL_LEVEL = 64 * 2 ** 20;

interface Running {
  worker: Worker;
  busy: number;
}

type Done = { part: Slab; finer?: Slab };

class WorkerPool implements ReducePool {
  private readonly workers: Running[] = [];
  private readonly waiting = new Map<number, { resolve(done: Done): void; reject(e: Error): void; on: Running }>();
  private nextId = 1;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** Set when a worker could not start: the pool is not used again. */
  broken = false;

  constructor(readonly size: number) {}

  run(job: ReduceJob): Promise<Done> {
    if (this.idle !== undefined) clearTimeout(this.idle);
    this.idle = undefined;
    // The least busy worker, or a new one while there are fewer than `size` and each is busy.
    let on = this.workers.reduce<Running | undefined>((best, w) => (best === undefined || w.busy < best.busy ? w : best), undefined);
    if ((on === undefined || on.busy > 0) && this.workers.length < this.size) on = this.start();
    const to = on!;
    const id = this.nextId++;
    to.busy++;
    return new Promise<Done>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, on: to });
      to.worker.postMessage({ id, job }, { transfer: job.slab === undefined ? [] : [job.slab.data.buffer as ArrayBuffer] });
    });
  }

  private start(): Running {
    const worker = new Worker(new URL("./reduce_worker.ts", import.meta.url), { type: "module", name: "image levels" });
    const running: Running = { worker, busy: 0 };
    worker.onmessage = (event: MessageEvent<{ id: number; part?: Slab; finer?: Slab; error?: string }>) => {
      const { id, part, finer, error } = event.data;
      const job = this.waiting.get(id);
      if (job === undefined) return;
      this.waiting.delete(id);
      job.on.busy--;
      if (part !== undefined) job.resolve({ part, ...(finer !== undefined ? { finer } : {}) });
      else job.reject(new Error(error ?? "the reduce worker failed"));
      this.whenIdle();
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.broken = true;
      for (const [id, job] of this.waiting) {
        if (job.on !== running) continue;
        this.waiting.delete(id);
        job.reject(new Error(`the reduce worker failed: ${event.message ?? "it did not start"}`));
      }
      worker.terminate();
      this.workers.splice(this.workers.indexOf(running), 1);
    };
    this.workers.push(running);
    return running;
  }

  private whenIdle(): void {
    if (this.waiting.size > 0) return;
    this.idle = setTimeout(() => {
      if (this.waiting.size > 0) return;
      for (const w of this.workers) w.worker.terminate();
      this.workers.length = 0;
    }, IDLE_MS);
  }
}

let pool: WorkerPool | undefined;
let replaced: ReducePool | null | undefined;

/**
 * The reduce workers for a level of `levelBytes`, or none: for a small
 * level, where workers cannot be made here, or on a device with a core or
 * two.
 */
export function reducePool(levelBytes: number): ReducePool | undefined {
  if (replaced !== undefined) return replaced ?? undefined;
  if (levelBytes < SMALL_LEVEL || pool?.broken) return undefined;
  if (pool !== undefined) return pool;
  if (typeof Worker === "undefined") return undefined;
  const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 2;
  const size = Math.min(MAX_WORKERS, Math.floor(cores / 2));
  if (size < 1) return undefined;
  return (pool = new WorkerPool(size));
}

/** Uses `next` instead of the workers (null: none at all; undefined: the workers again). For tests. */
export function setReducePool(next: ReducePool | null | undefined): void {
  replaced = next;
}

/**
 * Bytes of finer slabs read or being reduced at once, for every image of
 * this worker together: a slab waits while others hold `limit`, unless
 * none does (a slab larger than the limit goes alone).
 */
export class InFlight {
  private held = 0;
  private readonly queue: { bytes: number; go(): void }[] = [];
  constructor(private readonly limit: number) {}

  async acquire(bytes: number): Promise<void> {
    if (this.queue.length === 0 && (this.held === 0 || this.held + bytes <= this.limit)) {
      this.held += bytes;
      return;
    }
    await new Promise<void>((go) => this.queue.push({ bytes, go }));
  }

  release(bytes: number): void {
    this.held -= bytes;
    while (this.queue.length > 0 && (this.held === 0 || this.held + this.queue[0].bytes <= this.limit)) {
      const next = this.queue.shift()!;
      this.held += next.bytes;
      next.go();
    }
  }
}
