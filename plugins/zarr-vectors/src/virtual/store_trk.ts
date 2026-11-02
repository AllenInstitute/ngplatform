/** Tractogram files as virtual zarr-vectors stores (./streamlines.ts), read once when opened. */
import { StreamlineStore } from "./streamlines.js";
import { parseTckHeader, readTck } from "./tck.js";
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

/** An MRtrix .tck: no extent in the header, so the default cell size. */
export async function openTck(file: Blob, name: string): Promise<StreamlineStore> {
  const header = parseTckHeader(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()));
  return StreamlineStore.build({
    read: (onBatch) => readTck(file, header, onBatch),
    scalarNames: [],
    propertyNames: [],
    expectedCount: header.count > 0 ? header.count : Math.round(file.size / 400),
    extent: 0,
    name,
  });
}

/** A tractogram by its name: .trk or .tck. */
export function openTractogram(file: Blob, name: string): Promise<StreamlineStore> {
  if (/\.tck$/i.test(name)) return openTck(file, name.replace(/\.tck$/i, ""));
  return openTrk(file, name.replace(/\.trk$/i, ""));
}
