/**
 * Tractogram files (.trk, .tck, .trx) as virtual zarr-vectors stores
 * (./streamlines.ts), read once when opened.  A large one is binned into a
 * spill file in the origin's private file system (./spill.ts), so memory
 * holds only an index; whole streamlines by id are read from the file.
 */
import { freeStorage, NeedsRunner, OpfsSpill, openSpill, type Spill } from "./spill.js";
import { CHECKPOINT, type StreamlineInput, StreamlineStore } from "./streamlines.js";
import { parseTckHeader, readTck, readTckStreamlines } from "./tck.js";
import { parseTrkHeader, readTrk, readTrkStreamlines, TRK_HEADER_SIZE } from "./trk.js";
import { openTrxInfo, readTrx, readTrxStreamlines, trxInPlace } from "./trx.js";

export { NeedsRunner, RUNNER_HINT } from "./spill.js";

/**
 * The spill a tractogram of `bytes` bytes needs (its points copied into
 * cells, about 1.5 times the points' bytes with the fragments, bridges and
 * manifests), on disk when large; a NeedsRunner error when the origin's
 * storage cannot hold it.
 */
async function spillFor(bytes: number, name: string): Promise<Spill> {
  const expected = Math.round(bytes * 1.5);
  const spill = await openSpill(expected);
  if (spill instanceof OpfsSpill) {
    const free = await freeStorage();
    if (free < expected) {
      spill.close();
      const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;
      throw new NeedsRunner(`${name} needs about ${gb(expected)} of this browser's storage to be read here, and ${gb(Math.max(0, free))} is free`);
    }
  }
  return spill;
}

async function build(input: StreamlineInput, size: number): Promise<StreamlineStore> {
  return StreamlineStore.build(input, { spill: await spillFor(size, input.name) });
}

/** Reports how much of the file has been read, 0 to 1. */
export type Progress = (fraction: number) => void;

export async function openTrk(file: Blob, name: string, progress?: Progress): Promise<StreamlineStore> {
  const header = parseTrkHeader(new Uint8Array(await file.slice(0, TRK_HEADER_SIZE).arrayBuffer()));
  const extent = Math.max(...header.dims.map((d, k) => d * header.voxelSize[k]));
  return build(
    {
      read: (onBatch) => readTrk(file, header, onBatch, { progress: (done, total) => progress?.(done / total) }),
      streamlines: (ids, checkpoints) => readTrkStreamlines(file, header, ids, checkpoints, CHECKPOINT),
      scalarNames: header.scalarNames,
      propertyNames: header.propertyNames,
      // When the header does not say, guess from the size: about 30 points of 12 bytes a streamline.
      expectedCount: header.count > 0 ? header.count : Math.round(file.size / 400),
      extent,
      bytes: file.size,
      name,
    },
    file.size,
  );
}

/**
 * An MRtrix .tck: no extent in the header, so the extent of its first
 * streamlines (at least 150 mm, as a brain's), for the cell size.
 */
export async function openTck(file: Blob, name: string, progress?: Progress): Promise<StreamlineStore> {
  const header = parseTckHeader(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()));
  let extent = 0;
  if (file.size > 64 * 1024 * 1024) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    await readTck(file.slice(0, header.offset + 16 * 1024 * 1024 - ((16 * 1024 * 1024) % 12)), header, (batch) => {
      for (let i = 0; i < batch.points.length; ++i) {
        const k = i % 3;
        if (batch.points[i] < lo[k]) lo[k] = batch.points[i];
        if (batch.points[i] > hi[k]) hi[k] = batch.points[i];
      }
    }).catch(() => 0);
    extent = Math.max(150, ...hi.map((h, k) => h - lo[k]).filter(Number.isFinite));
  }
  return build(
    {
      read: (onBatch) => readTck(file, header, onBatch, { progress: (done, total) => progress?.(done / total) }),
      streamlines: (ids, checkpoints) => readTckStreamlines(file, header, ids, checkpoints, CHECKPOINT),
      scalarNames: [],
      propertyNames: [],
      expectedCount: header.count > 0 ? header.count : Math.round(file.size / 400),
      extent,
      bytes: file.size,
      name,
    },
    file.size,
  );
}

/** A TRX: its extent from the reference volume (dimensions times voxel sizes). */
export async function openTrx(file: Blob, name: string, progress?: Progress): Promise<StreamlineStore> {
  const info = await openTrxInfo(file);
  const sizes = [0, 1, 2].map((c) => Math.hypot(...[0, 1, 2].map((r) => Number(info.voxelToRas[r]?.[c] ?? 0))));
  const extent = Math.max(0, ...info.dims.map((d, k) => Number(d) * (sizes[k] || 1)));
  // Points as float32 (what the cells hold), whatever the file's dtype or compression.
  const pointBytes = 12 * (info.vertices || 0) + 4 * (info.vertices || 0) * info.scalars.length || file.size;
  return build(
    {
      read: (onBatch) => readTrx(file, info, onBatch, { progress: (done, total) => progress?.(done / total) }),
      // Stored arrays are read in place; deflated ones from the cells.
      ...(trxInPlace(info) ? { streamlines: (ids: Uint32Array) => readTrxStreamlines(file, info, ids) } : {}),
      scalarNames: info.scalars.map((s) => s.name),
      propertyNames: info.properties.map((p) => p.name),
      expectedCount: info.count,
      extent,
      bytes: pointBytes,
      name,
    },
    pointBytes,
  );
}

/** A tractogram by its name: .trk, .tck or .trx. */
export function openTractogram(file: Blob, name: string, progress?: Progress): Promise<StreamlineStore> {
  if (/\.tck$/i.test(name)) return openTck(file, name.replace(/\.tck$/i, ""), progress);
  if (/\.trx$/i.test(name)) return openTrx(file, name.replace(/\.trx$/i, ""), progress);
  return openTrk(file, name.replace(/\.trk$/i, ""), progress);
}
