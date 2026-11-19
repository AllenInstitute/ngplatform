/**
 * A model whose files are served from an address (manifest.json beside them)
 * and which runs in a worker of its own: what the panel shows of it (kept in
 * this browser or not, the download's progress, what it runs on, its last
 * timings), and the calls to its worker. MedSAM2 (./medsam2_model.ts) and
 * SAM-Med3D (./sammed3d_model.ts) are such models; their workers answer
 * `load` (with progress) and their own operations.
 */
import { MODEL_CACHE, ORT_URL, type Provider } from "./sam_model.js";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type Reply = { id: number; op: "progress"; loaded: number; total: number } | ({ id: number; ok: true } & Record<string, unknown>) | { id: number; ok: false; error: string };

/**
 * Where the models' files are published (Hugging Face, Apache-2.0 like the models; tools/medsam2/ and
 * tools/sammed3d/ make them): a folder for each model, with its manifest.json.
 */
export const MODELS_HOME = "https://huggingface.co/akeenlyside/ngplatform-models/resolve/main/";

/**
 * The files' address: localStorage `key` when set (a copy elsewhere, or `/models/<name>/` for the copies
 * `npm run dev` serves from the repository's models/), else `fallback` (absolute, or beside the app).
 */
export function modelBase(key: string, fallback: string): string {
  try {
    const set = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    if (set) return new URL(set.endsWith("/") ? set : `${set}/`, location.href).href;
  } catch {
    // Storage refused: the default.
  }
  return new URL(fallback, typeof document !== "undefined" ? document.baseURI : location.href).href;
}

export abstract class HostedModel<Req extends { id: number; op: string }, Rep extends Reply> {
  state: "unknown" | "absent" | "kept" | "loading" | "ready" | "failed" = "unknown";
  kept = 0;
  progress: { loaded: number; total: number } | undefined;
  error = "";
  provider: Provider = "auto";
  running = "";
  threads = 1;
  encodeMs: number | undefined;
  decodeMs: number | undefined;
  private worker: Worker | undefined;
  private loaded: Promise<void> | undefined;
  private next = 0;
  private readonly waiting = new Map<number, { resolve(r: Rep): void; reject(e: Error): void; progress?(loaded: number, total: number): void }>();
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly name: string,
    readonly licence: string,
    /** The files' size, until the manifest says. */
    public bytes: number,
  ) {
    void this.refreshKept();
  }

  /** Where its files are. */
  abstract base(): string;
  /** A new worker for it. */
  protected abstract startWorker(): Worker;
  /** Forgets what it holds of its worker's (embeddings, a track): the worker was stopped. */
  protected onStopped(): void {}

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected changed(): void {
    this.listeners.forEach((l) => l());
  }

  /** Its files kept in this browser (those under its address). */
  async refreshKept(): Promise<void> {
    let n = 0;
    if (typeof caches !== "undefined") {
      const base = this.base();
      const cache = await caches.open(MODEL_CACHE).catch(() => undefined);
      for (const request of (await cache?.keys().catch(() => [])) ?? []) {
        if (!request.url.startsWith(base) || request.url.endsWith("manifest.json")) continue;
        const r = await cache!.match(request);
        if (r) n += Number(r.headers.get("content-length")) || 0;
      }
    }
    this.kept = n;
    if (this.state === "unknown" || this.state === "absent" || this.state === "kept") this.state = n > 0 ? "kept" : "absent";
    this.changed();
  }

  async forget(): Promise<void> {
    this.stop();
    if (typeof caches !== "undefined") {
      const base = this.base();
      const cache = await caches.open(MODEL_CACHE).catch(() => undefined);
      for (const request of (await cache?.keys().catch(() => [])) ?? []) if (request.url.startsWith(base)) await cache!.delete(request);
    }
    this.state = "unknown";
    await this.refreshKept();
  }

  setProvider(provider: Provider): void {
    if (provider === this.provider) return;
    this.provider = provider;
    this.stop();
    this.state = this.kept > 0 ? "kept" : "absent";
    this.changed();
  }

  get started(): boolean {
    return this.worker !== undefined;
  }

  release(): void {
    if (this.worker === undefined) return;
    this.stop();
    this.state = this.kept > 0 ? "kept" : "absent";
    this.changed();
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.loaded = undefined;
    this.running = "";
    this.onStopped();
    for (const w of this.waiting.values()) w.reject(new Error(`${this.name} was stopped.`));
    this.waiting.clear();
  }

  protected call(request: WithoutId<Req>, transfer: Transferable[] = [], progress?: (loaded: number, total: number) => void): Promise<Extract<Rep, { ok: true }>> {
    if (this.worker === undefined) {
      this.worker = this.startWorker();
      this.worker.onmessage = (e: MessageEvent<Rep>) => {
        const r = e.data;
        const w = this.waiting.get(r.id);
        if (w === undefined) return;
        if ("op" in r && r.op === "progress") {
          w.progress?.(r.loaded as number, r.total as number);
          return;
        }
        this.waiting.delete(r.id);
        if ("error" in r && r.ok === false) w.reject(new Error(r.error));
        else w.resolve(r);
      };
      this.worker.onerror = (e) => {
        for (const w of this.waiting.values()) w.reject(new Error(e.message || `${this.name}'s worker failed.`));
        this.waiting.clear();
      };
    }
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (r: Rep) => void, reject, progress });
      this.worker!.postMessage({ ...request, id }, transfer);
    });
  }

  /** The model loaded in its worker: its files downloaded (or read from the browser), its sessions built. */
  load(progress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.loaded === undefined) {
      this.state = "loading";
      this.error = "";
      this.changed();
      let told = 0;
      this.loaded = this.call({ op: "load", ort: ORT_URL, provider: this.provider, cache: MODEL_CACHE, base: this.base() } as unknown as WithoutId<Req>, [], (loaded, total) => {
        this.progress = { loaded, total };
        this.bytes = total;
        if (loaded - told >= total / 100 || loaded === total) {
          told = loaded;
          progress?.(loaded, total);
          this.changed();
        }
      }).then(
        (r) => {
          const reply = r as { provider?: string; threads?: number; bytes?: number };
          this.state = "ready";
          this.progress = undefined;
          this.running = reply.provider ?? "";
          this.threads = reply.threads ?? 1;
          if (reply.bytes) this.bytes = reply.bytes;
          void this.refreshKept();
          this.changed();
        },
        (e: Error) => {
          this.state = "failed";
          this.error = e.message;
          this.progress = undefined;
          this.loaded = undefined;
          this.worker?.terminate();
          this.worker = undefined;
          this.changed();
          throw e;
        },
      );
    }
    return this.loaded;
  }

  /** Loaded, saying what it does meanwhile (a download, the first time). */
  protected async ready(progress: ((text: string, fraction?: number) => void) | undefined, signal: AbortSignal): Promise<void> {
    if (this.state !== "ready") {
      const mb = (this.bytes / 1e6).toFixed(0);
      progress?.(this.kept > 0 ? `Loading ${this.name} (kept in this browser)…` : `Downloading ${this.name} (${mb} MB, ${this.licence}) once; it is kept in this browser…`, 0);
    }
    await this.load((loaded, total) => progress?.(`Downloading ${this.name}: ${(loaded / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB (${this.licence})…`, loaded / total));
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  }
}
