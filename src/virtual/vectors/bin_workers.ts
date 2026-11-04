/**
 * Bin workers: a large tractogram's batches binned in a few workers at once
 * (./bin_worker.ts), each into a spill file of its own in the origin's
 * private file system; the store (./streamlines.ts) merges what they made
 * by cell and reads their spills.  The vectors worker reads and parses the
 * file and keeps the per-streamline columns; the workers do the binning,
 * which is most of the time a pass takes.
 */
import { canSpillToDisk, OpfsSpill } from "./spill.js";
import type { BinConfig, BinIndex, BinTarget } from "./streamlines.js";
import type { TrkBatch } from "./trk.js";

/** Bin workers at most, … */
const MAX_WORKERS = 6;
/** … sharing this much memory for pending records, … */
const PENDING_BYTES = 128 * 2 ** 20;
/** … and growing their files this much at a time. */
const GROW_BYTES = 128 * 2 ** 20;

/** How many bin workers to use here: half the cores, at most MAX_WORKERS; none when there are fewer than two, or no workers or OPFS. */
export function binWorkerCount(): number {
  if (typeof Worker === "undefined" || !canSpillToDisk()) return 0;
  const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 2;
  const n = Math.min(MAX_WORKERS, Math.floor(cores / 2));
  return n >= 2 ? n : 0;
}

/** `n` bin workers, each with a spill file of its own, started with `config`. */
export async function binWorkers(n: number, config: BinConfig): Promise<BinTarget[]> {
  const targets: BinTarget[] = [];
  try {
    for (let i = 0; i < n; ++i) targets.push(await binWorker({ ...config, pendingBytes: Math.max(16 * 2 ** 20, PENDING_BYTES / n) }));
  } catch (e) {
    for (const t of targets) t.abort();
    throw e;
  }
  return targets;
}

async function binWorker(config: BinConfig): Promise<BinTarget> {
  const file = await OpfsSpill.reserve();
  const worker = new Worker(new URL("./bin_worker.ts", import.meta.url), { type: "module", name: "tractogram binning" });
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let failed: Error | undefined;
  let nextId = 1;
  const fail = (e: Error) => {
    failed ??= e;
    for (const w of waiting.values()) w.reject(failed);
    waiting.clear();
  };
  worker.onmessage = (event: MessageEvent<{ id: number; error?: string; runner?: boolean }>) => {
    const { id, error, runner } = event.data;
    const w = waiting.get(id);
    if (w === undefined) return;
    waiting.delete(id);
    if (error !== undefined) w.reject(Object.assign(new Error(error), runner ? { kind: "runner" } : {}));
    else w.resolve(event.data);
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    fail(new Error(`a bin worker failed: ${event.message ?? "it did not start"}`));
  };
  const call = <T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> => {
    if (failed !== undefined) return Promise.reject(failed);
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, ...message }, { transfer });
    });
  };
  const own = (a: Float32Array) => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice());
  try {
    await call({ start: { name: file.name, config, grow: GROW_BYTES } });
  } catch (e) {
    worker.terminate();
    file.discard();
    throw e;
  }
  return {
    async bin(batch: TrkBatch, first: number) {
      // Points and values handed over (a view of a larger buffer copied first, so only its own bytes go).
      const points = own(batch.points);
      const scalars = own(batch.scalars);
      const offsets = batch.offsets.slice();
      const { lengths } = await call<{ lengths: Float32Array }>({ batch: { points, scalars, offsets, properties: new Float32Array(0) }, first }, [points.buffer, scalars.buffer, offsets.buffer]);
      return lengths;
    },
    async finish() {
      const { index, size } = await call<{ index: BinIndex; size: number }>({ finish: true });
      worker.terminate();
      return { index, spill: await file.adopt(size) };
    },
    abort() {
      fail(new Error("stopped"));
      worker.terminate();
      file.discard();
    },
  };
}
