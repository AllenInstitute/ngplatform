/** A .trk file as a virtual zarr-vectors store (./streamlines.ts), read once when opened. */
import { StreamlineStore } from "./streamlines.js";
import { parseTrkHeader, readTrk, TRK_HEADER_SIZE } from "./trk.js";

export async function openTrk(file: Blob, name: string): Promise<StreamlineStore> {
  const header = parseTrkHeader(new Uint8Array(await file.slice(0, TRK_HEADER_SIZE).arrayBuffer()));
  const extent = Math.max(...header.dims.map((d, k) => d * header.voxelSize[k]));
  return StreamlineStore.build({
    read: (onBatch) => readTrk(file, header, onBatch),
    scalarNames: header.scalarNames,
    propertyNames: header.propertyNames,
    // When the header does not say, guess from the size: about 30 points of 12 bytes a streamline.
    expectedCount: header.count > 0 ? header.count : Math.round(file.size / 400),
    extent,
    name,
  });
}
