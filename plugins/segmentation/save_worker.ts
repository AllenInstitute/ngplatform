/**
 * Segmentation's save worker: compresses off the main thread, so a large
 * save does not freeze the page.  A chunk of an OME-Zarr is gzipped and
 * sent back; a NIfTI is streamed, its parts (header, then slabs of
 * sections) compressed as they come straight into the file being written,
 * or into a Blob for a download.
 *
 * In:  { type: "gzip", id, data }
 *      { type: "begin", id, handle? }            (a FileSystemFileHandle to write into)
 *      { type: "part", id, stream, data }
 *      { type: "end", id, stream }
 *      { type: "abort", id, stream }
 * Out: { type: "gzipped", id, data }
 *      { type: "begun", id }
 *      { type: "written", id }
 *      { type: "ended", id, blob? }
 *      { type: "error", id, message }
 */
import { gzip } from "../registration/volume_io.js";
import { gzipWriter } from "./save.js";

const streams = new Map<number, ReturnType<typeof gzipWriter>>();

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  const work = async () => {
    if (msg.type === "gzip") {
      const data = await gzip(new Uint8Array(msg.data as ArrayBuffer));
      postMessage({ type: "gzipped", id: msg.id, data }, { transfer: [data.buffer] });
    } else if (msg.type === "begin") {
      const handle = msg.handle as FileSystemFileHandle | undefined;
      const target = handle ? ((await handle.createWritable()) as unknown as WritableStream<Uint8Array>) : undefined;
      streams.set(msg.id, gzipWriter(target));
      postMessage({ type: "begun", id: msg.id });
    } else if (msg.type === "part") {
      await streams.get(msg.stream)!.write(new Uint8Array(msg.data as ArrayBuffer));
      postMessage({ type: "written", id: msg.id });
    } else if (msg.type === "end") {
      const blob = await streams.get(msg.stream)!.close();
      streams.delete(msg.stream);
      postMessage({ type: "ended", id: msg.id, blob });
    } else if (msg.type === "abort") {
      await streams.get(msg.stream)?.abort();
      streams.delete(msg.stream);
      postMessage({ type: "ended", id: msg.id });
    } else if (msg.type !== "cancel") {
      throw new Error(`unknown request ${msg.type}`);
    }
  };
  work().catch((e) => postMessage({ type: "error", id: msg.id, message: (e as Error).message }));
};
