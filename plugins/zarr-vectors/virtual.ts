/**
 * Files the Zarr Vectors plugin reads in place, as zarr-vectors stores made
 * from them as they are read (src/virtual/): tractograms for now.  Local
 * data lists them and serves their keys from the worker.
 */
import type { VirtualFormat } from "@ngplatform/sdk";

export const ZARR_VECTORS_VIRTUAL: VirtualFormat[] = [
  {
    pattern: /\.trk$/i,
    extensions: [".trk"],
    format: "TrackVis tractogram",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker: () => new Worker(new URL("./virtual_worker.ts", import.meta.url), { type: "module", name: "virtual zarr-vectors" }),
  },
];
