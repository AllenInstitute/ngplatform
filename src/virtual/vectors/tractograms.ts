/**
 * Tractogram files (.trk, .tck, .trx) as virtual zarr-vectors stores
 * (./streamlines.ts), read once when opened.  A large one is binned into a
 * spill file in the origin's private file system (./spill.ts), so memory
 * holds only an index; whole streamlines by id are read from the file.
 */
import { currentSpillPlan, NeedsRunner, OpfsSpill, type SpillPlan } from "./spill.js";
import { CHECKPOINT, type StreamlineInput, StreamlineStore } from "./streamlines.js";
import { parseTckHeader, readTck, readTckStreamlines } from "./tck.js";
import { parseTrkHeader, readTrk, readTrkStreamlines, TRK_HEADER_SIZE } from "./trk.js";
import { openTrxInfo, readTrx, readTrxStreamlines, trxInPlace } from "./trx.js";

export { NeedsRunner, RUNNER_HINT } from "./spill.js";

const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;

/**
 * Reads a tractogram whose points take about `bytes` into a store, copying
 * into its spill what the plan allows (`spillPlan`): every streamline, or
 * past the disk budget a sample of them; a NeedsRunner error when not even
 * the sparsest sample fits.
 */
async function build(input: StreamlineInput, bytes: number): Promise<StreamlineStore> {
  const plan: SpillPlan = await currentSpillPlan(bytes);
  if (plan.mode === "none") {
    throw new NeedsRunner(`${input.name} would need about ${gb(plan.wholeBytes)} of this browser's storage to be read here, and even one streamline in 10,000 is past the ${gb(plan.budget)} allowed (View settings)`);
  }
  const spill = plan.place === "disk" ? await OpfsSpill.create() : undefined;
  return StreamlineStore.build(input, { spill, sampleEvery: plan.every, plan });
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
