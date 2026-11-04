/** The main thread's side of the orientations worker: requests as promises, with cancel. */
import { WorkerRpc } from "@ngplatform/sdk/worker_rpc";
import type { GlyphOptions, GlyphSet } from "./glyphs.js";
import type { Opened, VoxelRequest, Voxels } from "./reader.js";

export class OrientationClient {
  private readonly rpc = new WorkerRpc(() => new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "orientations" }), {
    stopped: (why) => `the orientation reader stopped: ${why}. Reload the page to try again`,
  });

  private request<T>(message: object, signal?: AbortSignal): Promise<T> {
    return this.rpc.request<T>(message, { signal });
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
    this.rpc.dispose();
  }
}
