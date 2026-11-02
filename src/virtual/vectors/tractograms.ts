/** Tractogram files (.trk, .tck, .trx) as virtual zarr-vectors stores (./streamlines.ts), read once when opened. */
import { StreamlineStore } from "./streamlines.js";
import { parseTckHeader, readTck } from "./tck.js";
import { parseTrkHeader, readTrk, TRK_HEADER_SIZE } from "./trk.js";
import { openTrxInfo, readTrx } from "./trx.js";

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

/** A TRX: its extent from the reference volume (dimensions times voxel sizes). */
export async function openTrx(file: Blob, name: string): Promise<StreamlineStore> {
  const info = await openTrxInfo(file);
  const sizes = [0, 1, 2].map((c) => Math.hypot(...[0, 1, 2].map((r) => Number(info.voxelToRas[r]?.[c] ?? 0))));
  const extent = Math.max(0, ...info.dims.map((d, k) => Number(d) * (sizes[k] || 1)));
  return StreamlineStore.build({
    read: (onBatch) => readTrx(file, info, onBatch),
    scalarNames: info.scalars.map((s) => s.name),
    propertyNames: info.properties.map((p) => p.name),
    expectedCount: info.count,
    extent,
    name,
  });
}

/** A tractogram by its name: .trk, .tck or .trx. */
export function openTractogram(file: Blob, name: string): Promise<StreamlineStore> {
  if (/\.tck$/i.test(name)) return openTck(file, name.replace(/\.tck$/i, ""));
  if (/\.trx$/i.test(name)) return openTrx(file, name.replace(/\.trx$/i, ""));
  return openTrk(file, name.replace(/\.trk$/i, ""));
}
