/**
 * Virtual stores, for data type plugins that read a kind of file in place
 * (see `VirtualFormat`): the worker that serves a format's stores calls
 * `serveVirtualStores` with a function that opens one from a file; local
 * data then routes every key under such a file to it.
 *
 *     // my_format/worker.ts
 *     import { serveVirtualStores } from "@ngplatform/sdk/virtual";
 *     serveVirtualStores((file) => openMyFormat(file));
 *
 * A store answers a key ("zarr.json", "0/c/0/1/2") with its bytes, or
 * undefined when it has no such key.
 */
import { answer, type Range, type VirtualStore } from "../virtual/images/store.js";

export { answer, blobSource, type ByteSource, jsonBytes, Lru, type Range, type VirtualStore } from "../virtual/images/store.js";

/** What local data sends a format's worker for each key, with the reply port. */
export interface VirtualRequest {
  type: "get";
  /** The file's place: its local entry and path. */
  store: string;
  file: File;
  /** The key in the store: "zarr.json", "0/c/0/1/2", … */
  key: string;
  range?: Range;
  head?: boolean;
}

/**
 * Answers local data's requests in this worker, opening a store per file
 * (once; again when the file changes, by size or time) with `open`.  Replies
 * go straight back to the service worker, on the port each request brings.
 */
export function serveVirtualStores(open: (file: File) => Promise<VirtualStore>): void {
  const stores = new Map<string, Promise<VirtualStore>>();
  const storeFor = (request: VirtualRequest) => {
    const key = `${request.store}\n${request.file.size}\n${request.file.lastModified}`;
    let store = stores.get(key);
    if (store === undefined) {
      // The file changed: forget what was made from it before.
      for (const old of stores.keys()) if (old.startsWith(`${request.store}\n`)) stores.delete(old);
      store = open(request.file);
      stores.set(key, store);
      store.catch(() => stores.delete(key));
    }
    return store;
  };
  self.addEventListener("message", (event: MessageEvent<VirtualRequest>) => {
    const request = event.data;
    const port = event.ports[0];
    if (request?.type !== "get" || port === undefined) return;
    void (async () => {
      try {
        const reply = await answer(await storeFor(request), request.key, request.range, request.head ?? false);
        port.postMessage(reply, reply.body ? [reply.body] : []);
      } catch (e) {
        port.postMessage({ status: 500, message: `${request.file.name}: ${e instanceof Error ? e.message : String(e)}` });
      }
    })();
  });
}
