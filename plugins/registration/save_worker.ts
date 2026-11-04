/**
 * Registration's worker: reads an image layer's store (OME-Zarr, a NIfTI
 * read as virtual Zarr, or a precomputed image) and writes it moved, off
 * the main thread.
 *
 * In:  { type: "geometry", id, store }
 *      { type: "save", id, store, grid?, move, header, method, format, name, label, maxBytes }
 *      { type: "cancel", id }
 * Out: { type: "geometry", id, size, voxelToRas, voxelSize, levels }
 *      { type: "saved", id, files: [path, bytes][], level, voxelSize, size, written }
 *      { type: "progress", id, what, done, total }
 *      { type: "error", id, message }
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import { VolumeReader } from "../volume-view/volume_reader.js";
import { saveInBlocks, saveInSlabs } from "./blocks.js";
import { identity4, multiply4 } from "./fit.js";
import { ARRAYS, displayWindow, ENLARGE, enlargedGrid, gzip, type Method, mghFile, niftiFile, omeZarrFiles, resample, typed, type Volume, type VoxelType } from "./volume_io.js";

// zstd and the other codecs decode in the platform's async-computation worker.
setAsyncComputationWorkerFactory(() => asyncComputationWorker(["org.ngplatform.zarr-vectors"]));

export interface SaveRequest {
  store: string;
  /**
   * Resample onto this image's grid (its finest level that fits) rather than
   * the layer's own; "enlarge": the layer's own voxels, the grid grown to
   * hold the whole moved image (Freeview's Save Volume As without "crop to
   * original volume size").
   */
  grid?: string;
  /** The layer's own RAS to where it is shown (RAS mm), row-major. */
  move: number[];
  /** Keep the voxels and write the new placement in the header, rather than resample. */
  header: boolean;
  method: Method;
  format: "nii" | "nii.gz" | "mgz" | "mgh" | "zarr";
  name: string;
  label: boolean;
  /** The finest level of at most this many bytes is read (and, resampled, written as many again). */
  maxBytes: number;
  /**
   * OME-Zarr: the folder to write it into (as `name`), here, as it is
   * made; then the full resolution is saved in blocks however large it is.
   */
  folder?: FileSystemDirectoryHandle;
  folderName?: string;
  /** NIfTI and MGH: the file to write, here, slab by slab; then the full resolution is saved however large. */
  file?: FileSystemFileHandle;
}

const controllers = new Map<number, AbortController>();



const levelBytes = (l: { size: number[]; type?: string }) => l.size[0] * l.size[1] * l.size[2] * (ARRAYS[(l.type ?? "uint8") as VoxelType]?.BYTES_PER_ELEMENT ?? 8);

/** The finest level (they are finest first) of at most `max` bytes, or the coarsest. */
function levelFor(levels: { size: number[]; type?: string }[], max: number): number {
  const i = levels.findIndex((l) => levelBytes(l) <= max);
  return i === -1 ? levels.length - 1 : i;
}

/** Writes files into `root`, making the folders on their paths. */
function folderWriter(root: FileSystemDirectoryHandle): (files: [string, Uint8Array][]) => Promise<void> {
  const dirs = new Map<string, Promise<FileSystemDirectoryHandle>>([["", Promise.resolve(root)]]);
  const dir = (path: string): Promise<FileSystemDirectoryHandle> => {
    let d = dirs.get(path);
    if (d === undefined) {
      const at = path.lastIndexOf("/");
      d = dir(path.slice(0, Math.max(0, at))).then((parent) => parent.getDirectoryHandle(path.slice(at + 1), { create: true }));
      dirs.set(path, d);
    }
    return d;
  };
  return async (files) => {
    await Promise.all(
      files.map(async ([path, bytes]) => {
        const at = path.lastIndexOf("/");
        const writable = await (await (await dir(path.slice(0, Math.max(0, at)))).getFileHandle(path.slice(at + 1), { create: true })).createWritable();
        await writable.write(bytes as unknown as BufferSource);
        await writable.close();
      }),
    );
  };
}

/**
 * The full resolution, however large, into the folder, block by block (see
 * blocks.ts): for OME-Zarr when the full resolution is more than fits.
 */
async function saveLarge(msg: SaveRequest & { id: number }, reader: VolumeReader, levels: Awaited<ReturnType<VolumeReader["open"]>>["levels"], signal: AbortSignal): Promise<void> {
  const level = levels[0];
  const type = (level.type ?? "uint8") as VoxelType;
  if (ARRAYS[type] === undefined) throw new Error(`${type} images cannot be saved in blocks`);
  const own = { size: level.size, voxelToRas: level.voxelToRas };
  const move = Float64Array.from(msg.move);
  let grid = own;
  if (!msg.header && msg.grid === ENLARGE) grid = enlargedGrid(own, move);
  else if (!msg.header && msg.grid !== undefined) {
    const g = (await new VolumeReader().open([msg.grid], undefined, signal)).levels[0];
    grid = { size: g.size, voxelToRas: g.voxelToRas };
  }
  const root = await msg.folder!.getDirectoryHandle(msg.folderName!, { create: true });
  await saveInBlocks(
    { size: level.size, voxelToRas: level.voxelToRas, type, read: (lo, hi) => readExact(reader, type, lo, hi, signal) },
    grid,
    // Voxels kept: the image onto its own grid unmoved, the new placement written.
    msg.header ? identity4() : move,
    { method: msg.method, label: msg.label, name: msg.name, description: `${msg.name}, moved by ngplatform registration`, placement: msg.header ? multiply4(move, level.voxelToRas) : undefined },
    folderWriter(root),
    (done, total) => postMessage({ type: "progress", id: msg.id, what: "Saving in blocks", done, total }),
    signal,
  );
  postMessage({ type: "saved", id: msg.id, files: [], level: 0, voxelSize: level.voxelSize, size: grid.size, written: true });
}

/**
 * The full resolution, however large, into the chosen NIfTI or MGH file,
 * slab by slab (see blocks.ts), gzipped on the way for .nii.gz and .mgz.
 */
async function saveLargeFile(msg: SaveRequest & { id: number }, reader: VolumeReader, levels: Awaited<ReturnType<VolumeReader["open"]>>["levels"], signal: AbortSignal): Promise<void> {
  const level = levels[0];
  const type = (level.type ?? "uint8") as VoxelType;
  if (ARRAYS[type] === undefined) throw new Error(`${type} images cannot be saved in slabs`);
  const own = { size: level.size, voxelToRas: level.voxelToRas };
  const move = Float64Array.from(msg.move);
  let grid = own;
  if (!msg.header && msg.grid === ENLARGE) grid = enlargedGrid(own, move);
  else if (!msg.header && msg.grid !== undefined) {
    const g = (await new VolumeReader().open([msg.grid], undefined, signal)).levels[0];
    grid = { size: g.size, voxelToRas: g.voxelToRas };
  }
  // The header's display window, from the coarsest level (the header is written before the voxels are seen).
  let window: [number, number] | undefined;
  if (!msg.label) {
    const coarse = await reader.rawVolume(levels.length - 1, signal);
    window = displayWindow(typed(coarse.type as VoxelType, coarse.data));
  }
  const writable = await msg.file!.createWritable();
  const gz = msg.format === "nii.gz" || msg.format === "mgz";
  const compress = gz ? new CompressionStream("gzip") : undefined;
  const piped = compress?.readable.pipeTo(writable);
  const writer = compress?.writable.getWriter();
  try {
    await saveInSlabs(
      { size: level.size, voxelToRas: level.voxelToRas, type, read: (lo, hi) => readExact(reader, type, lo, hi, signal) },
      grid,
      msg.header ? identity4() : move,
      { method: msg.method, label: msg.label, format: /^nii/.test(msg.format) ? "nii" : "mgh", description: `${msg.name}, moved by ngplatform registration`, window, placement: msg.header ? multiply4(move, level.voxelToRas) : undefined },
      async (bytes) => (writer ? writer.write(bytes as unknown as BufferSource) : writable.write(bytes as unknown as BufferSource)),
      (done, total) => postMessage({ type: "progress", id: msg.id, what: "Saving in slabs", done, total }),
      signal,
    );
    if (writer) {
      await writer.close();
      await piped;
    } else await writable.close();
  } catch (e) {
    await (writer ? writer.abort(e) : writable.abort(e)).catch(() => {});
    throw e;
  }
  postMessage({ type: "saved", id: msg.id, files: [], level: 0, voxelSize: level.voxelSize, size: grid.size, written: true });
}

async function save(msg: SaveRequest & { id: number }, signal: AbortSignal): Promise<void> {
  const progress = (what: string) => (done: number, total: number) => postMessage({ type: "progress", id: msg.id, what, done, total });
  const reader = new VolumeReader();
  const { levels } = await reader.open([msg.store], undefined, signal);
  const index = levelFor(levels, msg.maxBytes);
  if (levelBytes(levels[0]) > msg.maxBytes && msg.format === "zarr" && msg.folder !== undefined) return saveLarge(msg, reader, levels, signal);
  if (levelBytes(levels[0]) > msg.maxBytes && msg.format !== "zarr" && msg.file !== undefined) return saveLargeFile(msg, reader, levels, signal);
  const level = levels[index];
  const raw = await reader.rawVolume(index, signal, progress("Reading"));
  const source: Volume = { data: typed(raw.type as VoxelType, raw.data), size: raw.size, type: raw.type as VoxelType, voxelToRas: level.voxelToRas };
  const move = Float64Array.from(msg.move);
  let out: Volume;
  if (msg.header) {
    out = { ...source, voxelToRas: multiply4(move, source.voxelToRas) };
  } else {
    let grid = { size: source.size, voxelToRas: source.voxelToRas };
    if (msg.grid === ENLARGE) {
      grid = enlargedGrid(source, move);
    } else if (msg.grid !== undefined) {
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
  } else if (msg.format === "mgz" || msg.format === "mgh") {
    const mgh = mghFile(out);
    files = [[`image.${msg.format}`, msg.format === "mgz" ? await gzip(mgh) : mgh]];
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

/**
 * A box of the finest level's values: 64-bit floats for types a 32-bit float
 * would round (labels above 2^24, 64-bit floats), 32-bit floats otherwise.
 */
async function readExact(reader: VolumeReader, type: VoxelType, lo: [number, number, number], hi: [number, number, number], signal: AbortSignal): Promise<Float32Array | Float64Array> {
  const wide = type === "uint32" || type === "int32" || type === "float64";
  return wide ? (await reader.exactRegion(0, { lo, hi }, signal)).data : (await reader.rawRegion(0, { lo, hi }, signal)).data;
}
