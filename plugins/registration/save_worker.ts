/**
 * Registration's worker: reads an image layer's store (OME-Zarr, a NIfTI
 * read as virtual Zarr, or a precomputed image) and writes it moved, off
 * the main thread.
 *
 * In:  { type: "geometry", id, store }
 *      { type: "save", id, store, grid?, move, header, method, format, name, label, maxBytes }
 *      { type: "cancel", id }
 * Out: { type: "geometry", id, size, voxelToRas, voxelSize, levels }
 *      { type: "saved", id, files: [path, bytes][], level, voxelSize, size }
 *      { type: "progress", id, what, done, total }
 *      { type: "error", id, message }
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import { VolumeReader } from "../volume-view/volume_reader.js";
import { multiply4 } from "./fit.js";
import { ARRAYS, displayWindow, gzip, type Method, niftiFile, omeZarrFiles, resample, typed, type Volume, type VoxelType } from "./volume_io.js";

// zstd and the other codecs decode in the platform's async-computation worker.
setAsyncComputationWorkerFactory(() => asyncComputationWorker(["org.ngplatform.zarr-vectors"]));

export interface SaveRequest {
  store: string;
  /** Resample onto this image's grid (its finest level that fits) rather than the layer's own. */
  grid?: string;
  /** The layer's own RAS to where it is shown (RAS mm), row-major. */
  move: number[];
  /** Keep the voxels and write the new placement in the header, rather than resample. */
  header: boolean;
  method: Method;
  format: "nii" | "nii.gz" | "zarr";
  name: string;
  label: boolean;
  /** The finest level of at most this many bytes is read (and, resampled, written as many again). */
  maxBytes: number;
}

const controllers = new Map<number, AbortController>();

/** The finest level (they are finest first) of at most `max` bytes, or the coarsest. */
function levelFor(levels: { size: number[]; type?: string }[], max: number): number {
  const bytes = (l: { type?: string }) => ARRAYS[(l.type ?? "uint8") as VoxelType]?.BYTES_PER_ELEMENT ?? 8;
  const i = levels.findIndex((l) => l.size[0] * l.size[1] * l.size[2] * bytes(l) <= max);
  return i === -1 ? levels.length - 1 : i;
}

async function save(msg: SaveRequest & { id: number }, signal: AbortSignal): Promise<void> {
  const progress = (what: string) => (done: number, total: number) => postMessage({ type: "progress", id: msg.id, what, done, total });
  const reader = new VolumeReader();
  const { levels } = await reader.open([msg.store], undefined, signal);
  const index = levelFor(levels, msg.maxBytes);
  const level = levels[index];
  const raw = await reader.rawVolume(index, signal, progress("Reading"));
  const source: Volume = { data: typed(raw.type as VoxelType, raw.data), size: raw.size, type: raw.type as VoxelType, voxelToRas: level.voxelToRas };
  const move = Float64Array.from(msg.move);
  let out: Volume;
  if (msg.header) {
    out = { ...source, voxelToRas: multiply4(move, source.voxelToRas) };
  } else {
    let grid = { size: source.size, voxelToRas: source.voxelToRas };
    if (msg.grid !== undefined) {
      const other = await new VolumeReader().open([msg.grid], undefined, signal);
      const g = other.levels[levelFor(other.levels, msg.maxBytes)];
      grid = { size: g.size, voxelToRas: g.voxelToRas };
    }
    signal.throwIfAborted();
    const data = resample(source, grid, move, msg.label ? "nearest" : msg.method, progress("Resampling"));
    out = { data, size: grid.size, type: source.type, voxelToRas: grid.voxelToRas };
  }
  signal.throwIfAborted();
  const window = msg.label ? undefined : displayWindow(out.data);
  const description = `${msg.name}, moved by ngplatform registration`;
  postMessage({ type: "progress", id: msg.id, what: "Writing", done: 0, total: 1 });
  let files: [string, Uint8Array][];
  if (msg.format === "zarr") {
    files = [...(await omeZarrFiles(out, msg.name, { label: msg.label, window, description }))];
  } else {
    const nii = niftiFile(out, { label: msg.label, window, description: description.slice(0, 79) });
    files = [[msg.format === "nii.gz" ? "image.nii.gz" : "image.nii", msg.format === "nii.gz" ? await gzip(nii) : nii]];
  }
  postMessage(
    { type: "saved", id: msg.id, files, level: index, voxelSize: level.voxelSize, size: out.size },
    { transfer: [...new Set(files.map(([, b]) => b.buffer))] as ArrayBuffer[] },
  );
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    controllers.get(msg.id)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(msg.id, controller);
  const { signal } = controller;
  let work: Promise<void>;
  if (msg.type === "geometry") {
    work = new VolumeReader().open([msg.store], undefined, signal).then(({ levels }) => {
      const l = levels[0];
      postMessage({ type: "geometry", id: msg.id, size: l.size, voxelToRas: Array.from(l.voxelToRas), voxelSize: l.voxelSize, levels: levels.map((x) => ({ size: x.size, voxelSize: x.voxelSize })) });
    });
  } else if (msg.type === "save") {
    work = save(msg, signal);
  } else {
    work = Promise.reject(new Error(`unknown request ${msg.type}`));
  }
  work
    .catch((e) => {
      if (!signal.aborted) postMessage({ type: "error", id: msg.id, message: (e as Error).message });
    })
    .finally(() => controllers.delete(msg.id));
};
