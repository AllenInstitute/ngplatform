/**
 * Requests to a worker as promises, for plugins:
 *
 *     import { WorkerRpc } from "@ngplatform/sdk/worker_rpc";
 *     const rpc = new WorkerRpc(() => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }), {
 *       stopped: (why) => `the reader stopped: ${why}`,
 *     });
 *     const { values } = await rpc.request<{ values: Float32Array }>({ type: "read", url }, { signal });
 *
 * The protocol: each request is posted with an `id`; the worker answers
 * with that `id`, `{ type: "error", message }` for a failure, and may send
 * `{ type: "progress", … }` (or other interim messages, see `interim`)
 * before the answer.  Aborting a request posts `{ type: "cancel", id }`.
 * A worker that fails to start, or dies (out of memory, say), answers
 * nothing: every request waiting fails with `stopped`'s text.
 */

export interface RequestOptions {
  /** Interim messages for this request (`{ type: "progress", done, total }` and the like). */
  progress?: (msg: any) => void;
  signal?: AbortSignal;
  transfer?: Transferable[];
}

export interface WorkerRpcOptions {
  /** The error a failed worker gives, from the browser's reason ("it could not start" when it gives none). */
  stopped: (why: string) => string;
  /**
   * Start a new worker for the next request after one fails (for workers
   * that keep no state between requests); otherwise later requests fail too.
   */
  restart?: boolean;
  /** Messages that come before the answer, besides `type: "progress"`. */
  interim?: (msg: any) => boolean;
  /** Called after the worker failed (to drop what was learnt from it). */
  onStopped?: () => void;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  progress?: (msg: any) => void;
}

export class WorkerRpc {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private broken: string | undefined;

  constructor(
    private readonly start: () => Worker,
    private readonly options: WorkerRpcOptions,
  ) {}

  private started(): Worker {
    if (this.worker !== undefined) return this.worker;
    const worker = this.start();
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      const p = this.pending.get(msg?.id);
      if (p === undefined) return;
      if (msg.type === "progress" || this.options.interim?.(msg) === true) {
        p.progress?.(msg);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === "error") p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      this.fail(worker, event.message || "it could not start");
    };
    worker.onmessageerror = () => this.fail(worker, "its answer could not be read");
    this.worker = worker;
    return worker;
  }

  private fail(worker: Worker, why: string): void {
    if (this.worker !== worker) return;
    const message = this.options.stopped(why);
    worker.terminate();
    this.worker = undefined;
    if (this.options.restart !== true) this.broken = message;
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
    this.options.onStopped?.();
  }

  /** Posts `message` (with an `id`); the worker's answer. */
  request<T>(message: object, options: RequestOptions = {}): Promise<T> {
    if (this.broken !== undefined) return Promise.reject(new Error(this.broken));
    if (options.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    const worker = this.started();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress: options.progress });
      options.signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.delete(id)) return;
          worker.postMessage({ type: "cancel", id });
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
      worker.postMessage({ ...message, id }, options.transfer ?? []);
    });
  }

  /** Ends the worker; requests still waiting fail ("closed"), and later ones too unless `restart` is set. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    if (this.options.restart !== true) this.broken = "closed";
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }
}
