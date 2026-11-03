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

/**
 * What local data sends a format's worker for each key, with the reply
 * port; or, with type "message", a message from the page for the store
 * (`VirtualStore.message`), in `body`.
 */
export interface VirtualRequest {
  type: "get" | "message";
  /** The file's place: its local entry and path. */
  store: string;
  file: File;
  /** Files its format reads besides it (`VirtualFormat.related`), by path from its folder, unread. */
  related?: Record<string, File>;
  /** The key in the store: "zarr.json", "0/c/0/1/2", … */
  key: string;
  /** A message's content. */
  body?: unknown;
  range?: Range;
  head?: boolean;
}

/**
 * Answers local data's requests in this worker, opening a store per file
 * (once; again when the file changes, by size or time) with `open`.  Replies
 * go straight back to the service worker, on the port each request brings.
 */
export function serveVirtualStores(open: (file: File, related: Record<string, File>) => Promise<VirtualStore>): void {
  const stores = new Map<string, Promise<VirtualStore>>();
  const storeFor = (request: VirtualRequest) => {
    const related = Object.entries(request.related ?? {}).map(([path, f]) => `${path}:${f.size}:${f.lastModified}`).sort().join("|");
    const key = `${request.store}\n${request.file.size}\n${request.file.lastModified}\n${related}`;
    let store = stores.get(key);
    if (store === undefined) {
      // The file changed: forget what was made from it before.
      for (const old of stores.keys()) if (old.startsWith(`${request.store}\n`)) stores.delete(old);
      store = open(request.file, request.related ?? {});
      stores.set(key, store);
      store.catch(() => stores.delete(key));
    }
    return store;
  };
  self.addEventListener("message", (event: MessageEvent<VirtualRequest>) => {
    const request = event.data;
    const port = event.ports[0];
    if (port === undefined) return;
    if (request?.type === "message") {
      void (async () => {
        try {
          const store = await storeFor(request);
          if (store.message === undefined) throw new Error("the store takes no messages");
          port.postMessage({ status: 200, value: await store.message(request.body) });
        } catch (e) {
          port.postMessage({ status: 500, message: `${request.file.name}: ${e instanceof Error ? e.message : String(e)}` });
        }
      })();
      return;
    }
    if (request?.type !== "get") return;
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
