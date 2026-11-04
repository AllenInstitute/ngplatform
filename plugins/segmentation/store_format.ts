/**
 * Label volumes held in the page, served to Neuroglancer as OME-Zarr stores
 * the way the platform serves files on this computer: an empty file named
 * `<something>.ngplabels` is opened as local data, and every key under its
 * URL (`…/x.ngplabels/zarr.json`, `…/0/c/1/2/3`) comes here.  Its "worker"
 * answers in the page, from the volume itself, so a stroke shows as soon
 * as Neuroglancer reads the chunk again.
 *
 * This module is small and loaded with the catalogue (the platform asks
 * for the format when it starts); the volumes register themselves when the
 * plugin makes them.
 */
import type { VirtualFormat } from "@ngplatform/sdk";
import { answer, type VirtualRequest } from "@ngplatform/sdk/virtual";

export const LABEL_STORE_EXTENSION = ".ngplabels";

/** A store's keys: metadata and chunks, or undefined for none; at once, or (a volume edited in place, which may read its original first) later. */
export interface InPageStore {
  serve(key: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
}

const stores = new Map<string, InPageStore>();

/** Serves a store under a file name (`<name>.ngplabels`) until the returned function is called. */
export function serveInPage(fileName: string, store: InPageStore): () => void {
  stores.set(fileName, store);
  return () => {
    if (stores.get(fileName) === store) stores.delete(fileName);
  };
}

/** Answers local data's requests for the stores' keys, in the page. */
const inPageWorker = {
  postMessage(request: VirtualRequest, transfer: Transferable[]) {
    const port = transfer[0] as MessagePort | undefined;
    if (request?.type !== "get" || port === undefined) return;
    const store = stores.get(request.file.name);
    if (store === undefined) {
      port.postMessage({ status: 410, message: "This label volume is no longer open." });
      return;
    }
    void answer({ get: async (key) => store.serve(key) }, request.key, request.range, request.head ?? false).then(
      (reply) => port.postMessage(reply, reply.body ? [reply.body] : []),
      (e) => port.postMessage({ status: 500, message: String(e) }),
    );
  },
};

export const LABEL_STORE_FORMAT: VirtualFormat = {
  pattern: /\.ngplabels$/i,
  // Never offered in file pickers: these files are made in the page.
  extensions: [],
  format: "label volume drawn here",
  kind: "segmentation",
  source: (url) => `zarr3://${url}/`,
  worker: () => inPageWorker as unknown as Worker,
};
