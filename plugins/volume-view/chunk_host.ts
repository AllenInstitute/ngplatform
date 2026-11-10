/**
 * The page's side of the image chunk worker (./image_chunk_worker.ts): started
 * with the first tool's worker that reads images, and given a port to
 * each, so all of them share its one cache of decoded chunks.
 *
 *     new WorkerRpc(() => withSharedChunks(new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })), …)
 */
import { CHUNK_PORT } from "./shared_chunks.js";

let host: Worker | undefined;
/** The tools' workers given a port, told when the chunk worker stops. */
const tools = new Set<WeakRef<Worker>>();

/** Starts the chunk worker (`start`, for tests) when it is not running. */
function started(start: () => Worker): Worker {
  if (host !== undefined) return host;
  const worker = start();
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    stopped(worker);
  };
  worker.onmessageerror = () => stopped(worker);
  host = worker;
  return worker;
}

/** The chunk worker failed: each tool's worker reads its own chunks again (until a new one starts). */
function stopped(worker: Worker): void {
  if (host !== worker) return;
  host = undefined;
  for (const ref of tools) ref.deref()?.postMessage({ type: CHUNK_PORT, port: undefined });
  tools.clear();
}

/**
 * Gives `worker` (a tool's worker that reads images with the volume view's
 * reader) a port to the image chunk worker, starting that if needed; the
 * port is its first message.  Returns `worker`.
 */
export function withSharedChunks(worker: Worker, start = () => new Worker(new URL("./image_chunk_worker.ts", import.meta.url), { type: "module", name: "image chunks" })): Worker {
  try {
    const { port1, port2 } = new MessageChannel();
    started(start).postMessage({ type: "connect", port: port1 }, [port1]);
    worker.postMessage({ type: CHUNK_PORT, port: port2 }, [port2]);
    for (const ref of tools) if (ref.deref() === undefined) tools.delete(ref);
    tools.add(new WeakRef(worker));
  } catch {
    // No chunk worker (it could not start): this worker keeps its own cache.
  }
  return worker;
}

/** Stops the chunk worker (for tests). */
export function stopSharedChunks(): void {
  host?.terminate();
  host = undefined;
  tools.clear();
}
