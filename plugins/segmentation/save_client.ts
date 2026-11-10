/**
 * The main thread's side of the save worker (./save_worker.ts): gzipping
 * an OME-Zarr's chunks, and a NIfTI streamed into its file (or a Blob),
 * off the main thread.  Without workers (tests), the same is done here.
 */
import { WorkerRpc } from "@ngplatform/sdk/worker_rpc";
import { gzip } from "../registration/volume_io.js";
import { gzipWriter } from "./save.js";

/** A gzipped file being written: its parts in order, then `close` (a Blob when there was no file). */
export interface GzipStream {
  write(part: Uint8Array): Promise<void>;
  close(): Promise<Blob | undefined>;
  abort(): Promise<void>;
}

export class SaveWorker {
  private rpc: WorkerRpc | undefined;

  private worker(): WorkerRpc | undefined {
    if (typeof Worker === "undefined") return undefined;
    this.rpc ??= new WorkerRpc(() => new Worker(new URL("./save_worker.ts", import.meta.url), { type: "module", name: "segmentation save" }), {
      stopped: (why) => `The save stopped (${why}).`,
      restart: true,
    });
    return this.rpc;
  }

  /** Bytes gzipped (a copy is sent: the caller's stay as they are). */
  async gzip(bytes: Uint8Array): Promise<Uint8Array> {
    const rpc = this.worker();
    if (rpc === undefined) return gzip(bytes);
    const copy = bytes.slice();
    const r = await rpc.request<{ data: Uint8Array }>({ type: "gzip", data: copy.buffer }, { transfer: [copy.buffer] });
    return r.data;
  }

  /**
   * A gzipped file streamed into `handle` (or, with none, into a Blob), the
   * compressing and writing done in the worker.  A file handle the browser
   * cannot hand to a worker is written from here, still part by part.
   */
  async stream(handle?: FileSystemFileHandle): Promise<GzipStream> {
    const rpc = this.worker();
    if (rpc !== undefined) {
      try {
        const { id } = await rpc.request<{ id: number }>({ type: "begin", handle });
        return {
          write: async (part) => {
            const copy = part.slice();
            await rpc.request({ type: "part", stream: id, data: copy.buffer }, { transfer: [copy.buffer] });
          },
          close: async () => (await rpc.request<{ blob?: Blob }>({ type: "end", stream: id })).blob,
          abort: async () => void (await rpc.request({ type: "abort", stream: id }).catch(() => undefined)),
        };
      } catch (e) {
        if ((e as DOMException).name !== "DataCloneError") throw e;
      }
    }
    const target = handle ? ((await handle.createWritable()) as unknown as WritableStream<Uint8Array>) : undefined;
    return gzipWriter(target);
  }

  dispose(): void {
    this.rpc?.dispose();
  }
}
