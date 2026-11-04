/** The main thread's side of the orientations worker: requests as promises, with cancel. */
import type { GlyphOptions, GlyphSet } from "./glyphs.js";
import type { Opened, VoxelRequest, Voxels } from "./reader.js";

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class OrientationClient {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "orientations" });
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      if (msg.type === "error") p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    // A worker that fails to load (or throws outside a request) answers nothing: say so to every request.
    this.worker.onerror = (event: ErrorEvent) => {
      this.broken = `the orientation reader stopped: ${event.message || "it could not start"}. Reload the page to try again`;
      for (const p of this.pending.values()) p.reject(new Error(this.broken));
      this.pending.clear();
    };
  }

  private broken: string | undefined;

  private request<T>(message: object, signal?: AbortSignal): Promise<T> {
    const id = this.nextId++;
    if (this.broken !== undefined) return Promise.reject(new Error(this.broken));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        this.worker.postMessage({ type: "cancel", id });
        reject(new DOMException("Aborted", "AbortError"));
      });
      this.worker.postMessage({ ...message, id });
    });
  }

  open(url: string): Promise<Opened> {
    return this.request({ type: "open", url });
  }

  glyphs(level: number, request: VoxelRequest, options: GlyphOptions, signal?: AbortSignal): Promise<{ set: GlyphSet; voxels: number }> {
    return this.request({ type: "glyphs", level, request, options }, signal);
  }

  /** The voxels of a box within its slabs, with every component. */
  values(level: number, request: VoxelRequest, signal?: AbortSignal): Promise<Voxels> {
    return this.request({ type: "values", level, request }, signal);
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }
}
