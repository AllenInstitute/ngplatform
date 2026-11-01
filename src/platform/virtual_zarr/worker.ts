/**
 * Serves files that are not Zarr (NIfTI images) as Zarr stores, off the
 * page's thread: the page passes each request on with the service worker's
 * reply port, so the answer goes straight back to the service worker.  A
 * store lasts while its file is unchanged (same size and time).
 */
import { openNifti } from "./nifti.js";
import { answer, type Range, type VirtualStore } from "./store.js";

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

const stores = new Map<string, Promise<VirtualStore>>();

function open(request: VirtualRequest): Promise<VirtualStore> {
  const key = `${request.store}\n${request.file.size}\n${request.file.lastModified}`;
  let store = stores.get(key);
  if (store === undefined) {
    // The file changed: forget what was made from it before.
    for (const old of stores.keys()) if (old.startsWith(`${request.store}\n`)) stores.delete(old);
    store = openNifti(request.file, request.file.name.replace(/\.nii(\.gz)?$/i, ""));
    stores.set(key, store);
    store.catch(() => stores.delete(key));
  }
  return store;
}

self.addEventListener("message", (event: MessageEvent<VirtualRequest>) => {
  const request = event.data;
  const port = event.ports[0];
  if (request?.type !== "get" || port === undefined) return;
  void (async () => {
    try {
      const reply = await answer(await open(request), request.key, request.range, request.head ?? false);
      port.postMessage(reply, reply.body ? [reply.body] : []);
    } catch (e) {
      port.postMessage({ status: 500, message: `${request.file.name}: ${e instanceof Error ? e.message : String(e)}` });
    }
  })();
});
