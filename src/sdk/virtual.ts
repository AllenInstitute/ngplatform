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
 * How long a key waits for its store to open before it is answered 503
 * ("still reading", which Neuroglancer's reads retry), so a first pass over
 * a large file outlasts the browser's limit on a service worker's answer
 * (five minutes).
 */
export const OPENING_WAIT_MS = 45_000;

/**
 * Answers local data's requests in this worker, opening a store per file
 * (once; again when the file changes, by size or time) with `open`, which
 * may report how much of the file it has read (`progress`, 0 to 1).  Replies
 * go straight back to the service worker, on the port each request brings.
 */
export function serveVirtualStores(open: (file: File, related: Record<string, File>, progress: (fraction: number) => void) => Promise<VirtualStore>): void {
  const stores = new Map<string, Promise<VirtualStore>>();
  const opened = new Set<Promise<VirtualStore>>();
  const progressOf = new Map<Promise<VirtualStore>, () => number>();
  const storeFor = (request: VirtualRequest) => {
    const related = Object.entries(request.related ?? {}).map(([path, f]) => `${path}:${f.size}:${f.lastModified}`).sort().join("|");
    const key = `${request.store}\n${request.file.size}\n${request.file.lastModified}\n${related}`;
    let store = stores.get(key);
    if (store === undefined) {
      // The file changed: forget what was made from it before.
      for (const [old, made] of stores) {
        if (!old.startsWith(`${request.store}\n`)) continue;
        stores.delete(old);
        made.then((s) => s.close?.(), () => {});
      }
      // How much of the file it has read, until it opens.
      let fraction = 0;
      const made = (store = open(request.file, request.related ?? {}, (f) => (fraction = f)));
      progressOf.set(made, () => fraction);
      stores.set(key, store);
      made
        .then(
          () => void opened.add(made),
          () => void stores.delete(key),
        )
        .finally(() => progressOf.delete(made));
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
        const pending = storeFor(request);
        if (!opened.has(pending)) {
          // Still reading the file: answer 503 after a while, to be asked again.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), OPENING_WAIT_MS)));
          const first = await Promise.race([pending, late]);
          clearTimeout(timer);
          if (first === "late") {
            const percent = Math.round(100 * (progressOf.get(pending)?.() ?? 0));
            port.postMessage({ status: 503, message: `${request.file.name}: still reading the file (${percent}% read)` });
            return;
          }
        }
        const reply = await answer(await pending, request.key, request.range, request.head ?? false);
        port.postMessage(reply, reply.body ? [reply.body] : []);
      } catch (e) {
        port.postMessage({ status: 500, message: `${request.file.name}: ${e instanceof Error ? e.message : String(e)}` });
      }
    })();
  });
}
