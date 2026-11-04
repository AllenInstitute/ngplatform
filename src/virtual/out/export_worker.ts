/**
 * Exports an image on this computer to another format, off the page's
 * thread: the file is opened as its virtual store, a level read back whole
 * and written out.
 *
 * In:  { type: "levels", id, file }
 *      { type: "export", id, file, format, level, region?: { centre (RAS mm), size (voxels) } }
 *      { type: "write-pyramid", id, file, dir (a folder handle), name }: every level
 *        as an OME-Zarr folder `name` in `dir`, written here chunk by chunk in one
 *        pass over the file (the store's `eachChunk`); { type: "cancel", id } stops it
 * Out: { type: "levels", id, levels: { size, type, bytes }[], label }
 *      { type: "progress", id, what, done, total }
 *      { type: "done", id, files: [path, bytes][] }
 *      { type: "error", id, message }
 */
import { openImage } from "../images/open.js";
import { parseMeshFile } from "../vectors/mesh_files.js";
import { featherPoints } from "../vectors/feather.js";
import { parseEdgeList, parseGraphml, splitEdgeList } from "../vectors/graphs.js";
import { lazToLas } from "../vectors/laz.js";
import { lazPerf } from "../vectors/laz_module.js";
import { parseLas, parsePointParquet, parsePointTable, parseSwc } from "../vectors/point_files.js";
import { parseTckHeader, readTck } from "../vectors/tck.js";
import type { TrkBatch } from "../vectors/trk.js";
import { parseTrkHeader, readTrk, TRK_HEADER_SIZE } from "../vectors/trk.js";
import { openTrxInfo, readTrx } from "../vectors/trx.js";
import { exportKind, type GeometryFormat, type ImageFormat } from "./kinds.js";
import { readLevel, regionAround, storeLevels } from "./read_level.js";
import { csvFile, type Curves, graphmlFile, objFile, plyFile, stlFile, tckFile, trkFile } from "./vectors.js";
import { displayWindow, gzip, mghFile, niftiFile, omeZarrFiles } from "./volume.js";

/** Every streamline of a tractogram file, RAS mm. */
async function readCurves(file: Blob & { name: string }): Promise<Curves> {
  const points: Float32Array[] = [];
  const counts: number[] = [];
  const take = (batch: TrkBatch) => {
    points.push(batch.points.slice());
    for (let i = 0; i + 1 < batch.offsets.length; ++i) counts.push(batch.offsets[i + 1] - batch.offsets[i]);
  };
  if (/\.tck$/i.test(file.name)) await readTck(file, parseTckHeader(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())), take);
  else if (/\.trx$/i.test(file.name)) await readTrx(file, await openTrxInfo(file), take);
  else await readTrk(file, parseTrkHeader(new Uint8Array(await file.slice(0, TRK_HEADER_SIZE).arrayBuffer())), take);
  const positions = new Float32Array(points.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of points) {
    positions.set(p, at);
    at += p.length;
  }
  const offsets = new Uint32Array(counts.length + 1);
  counts.forEach((c, i) => (offsets[i + 1] = offsets[i] + c));
  return { positions, offsets };
}

/** A geometry file written in another format. */
async function exportGeometry(file: Blob & { name: string }, format: GeometryFormat): Promise<Uint8Array> {
  const kind = exportKind(file.name);
  if (kind === "streamlines") {
    const curves = await readCurves(file);
    if (format === "trk") return trkFile(curves);
    if (format === "tck") return tckFile(curves);
  }
  if (kind === "mesh") {
    const mesh = await parseMeshFile(new Uint8Array(await file.arrayBuffer()), file.name);
    if (format === "obj") return objFile(mesh);
    if (format === "stl") return stlFile(mesh);
    if (format === "ply") return plyFile(mesh);
    if (format === "csv") return csvFile(mesh.positions);
  }
  if (kind === "graph") {
    const text = await file.text();
    const graph = /\.graphml$/i.test(file.name) ? parseGraphml(text) : (({ edges, nodes }) => parseEdgeList(edges, nodes))(splitEdgeList(text));
    if (format === "graphml") return graphmlFile(graph.positions, graph.edges, graph.columns);
    if (format === "csv") return csvFile(graph.positions, graph.columns);
  }
  if (kind === "points" && format === "csv") {
    if (/\.swc$/i.test(file.name)) {
      const nodes = parseSwc(await file.text());
      const positions = new Float64Array(nodes.length * 3);
      nodes.forEach((n, i) => positions.set(n.position, 3 * i));
      return csvFile(positions, [
        { name: "id", values: nodes.map((n) => n.id) },
        { name: "type", values: nodes.map((n) => n.type) },
        { name: "radius", values: nodes.map((n) => n.radius) },
        { name: "parent", values: nodes.map((n) => n.parent) },
      ]);
    }
    const table = /\.(feather|arrow)$/i.test(file.name)
      ? featherPoints(new Uint8Array(await file.arrayBuffer()))
      : /\.laz$/i.test(file.name)
      ? parseLas(lazToLas(new Uint8Array(await file.arrayBuffer()), await lazPerf()))
      : /\.las$/i.test(file.name)
        ? parseLas(new Uint8Array(await file.arrayBuffer())) : /\.parquet$/i.test(file.name) ? await parsePointParquet(file) : parsePointTable(await file.text());
    return csvFile(table.positions, table.columns);
  }
  throw new Error(`a ${kind ?? "file"} cannot be written as ${format}`);
}

/** The image last opened, kept for the requests that follow (a pyramid is written chunk by chunk). */
let opened: { key: string; store: ReturnType<typeof openImage> } | undefined;
function storeOf(file: File): ReturnType<typeof openImage> {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  if (opened?.key !== key) opened = { key, store: openImage(file) };
  return opened.store;
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2));

/**
 * Every level of the image as an OME-Zarr folder: the store's metadata as
 * it serves it (each array gzip-compressed), and each array's chunk grid.
 */
async function pyramid(store: Awaited<ReturnType<typeof openImage>>) {
  const group = JSON.parse(new TextDecoder().decode((await store.get("zarr.json"))!));
  const ome = group.attributes?.ome;
  if (ome !== undefined) ome.description ??= `${store.name}, exported by ngplatform`;
  const files: [string, Uint8Array][] = [["zarr.json", encode(group)]];
  const arrays: { path: string; grid: number[]; separator: string }[] = [];
  for (const dataset of ome?.multiscales?.[0]?.datasets ?? []) {
    const path = String(dataset.path);
    const meta = await store.get(`${path}/zarr.json`);
    if (meta === undefined) continue;
    const array = JSON.parse(new TextDecoder().decode(meta));
    array.codecs = [...(array.codecs ?? []), { name: "gzip", configuration: { level: 5 } }];
    const chunk: number[] = array.chunk_grid.configuration.chunk_shape;
    files.push([`${path}/zarr.json`, encode(array)]);
    arrays.push({ path, grid: array.shape.map((n: number, a: number) => Math.ceil(n / chunk[a])), separator: array.chunk_key_encoding?.configuration?.separator ?? "/" });
  }
  return { files, arrays };
}

/** Writes of a pyramid asked to stop, by request id. */
const cancelled = new Set<number>();

/** A folder's files written by path ("0/c/1/2/3"), its sub-folders made once. */
function folderWriter(root: FileSystemDirectoryHandle) {
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
  return async (path: string, bytes: Uint8Array) => {
    const at = path.lastIndexOf("/");
    const handle = await (await dir(path.slice(0, Math.max(0, at)))).getFileHandle(path.slice(at + 1), { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes as unknown as BufferSource);
    await writable.close();
  };
}

/**
 * Every level of the image into a folder: its metadata, then each chunk
 * gzipped as the store makes it.  NIfTI-like stores make every level in one
 * pass over the file (`eachChunk`); others are asked chunk by chunk.  A few
 * writes are in flight at once.
 */
async function writePyramid(store: Awaited<ReturnType<typeof openImage>>, parent: FileSystemDirectoryHandle, name: string, id: number, post: (m: object) => void): Promise<void> {
  const write = folderWriter(await parent.getDirectoryHandle(name, { create: true }));
  const { files, arrays } = await pyramid(store);
  for (const [path, bytes] of files) await write(path, bytes);
  const pending = new Set<Promise<void>>();
  let failure: Error | undefined;
  const writeChunk = async (key: string, bytes: Uint8Array) => {
    if (failure !== undefined) throw failure;
    const job = gzip(bytes).then((gz) => write(key, gz));
    pending.add(job);
    job.then(
      () => pending.delete(job),
      (e) => {
        pending.delete(job);
        failure = e as Error;
      },
    );
    if (pending.size >= 8) await Promise.race(pending).catch(() => {});
  };
  let last = 0;
  const control = {
    progress(done: number, total: number) {
      const now = Date.now();
      if (now - last < 250 && done < total) return;
      last = now;
      post({ type: "progress", what: "Writing every level", done, total });
    },
    get cancelled() {
      return cancelled.has(id);
    },
  };
  const each = (store as { eachChunk?: (w: typeof writeChunk, c: typeof control) => Promise<void> }).eachChunk;
  if (each !== undefined) await each.call(store, writeChunk, control);
  else {
    const total = arrays.reduce((sum, a) => sum + a.grid.reduce((n, g) => n * g, 1), 0);
    let done = 0;
    for (const a of arrays) {
      const index = a.grid.map(() => 0);
      for (let n = a.grid.reduce((m, g) => m * g, 1); n > 0; --n) {
        if (control.cancelled) throw new Error("Cancelled");
        const key = `${a.path}/c/${index.join(a.separator)}`;
        const bytes = await store.get(key);
        if (bytes !== undefined) await writeChunk(key, bytes);
        control.progress(++done, total);
        for (let d = index.length - 1; d >= 0 && ++index[d] === a.grid[d]; --d) index[d] = 0;
      }
    }
  }
  await Promise.all(pending);
  if (failure !== undefined) throw failure;
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  const post = (m: object, transfer: Transferable[] = []) => postMessage({ id: msg.id, ...m }, { transfer });
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }
  try {
    if (msg.type === "export" && exportKind(msg.file.name) !== "image") {
      post({ type: "progress", what: "Reading", done: 0, total: 1 });
      const bytes = await exportGeometry(msg.file, msg.format);
      post({ type: "done", files: [[`file.${msg.format}`, bytes]] }, [bytes.buffer as ArrayBuffer]);
      return;
    }
    const store = await storeOf(msg.file);
    if (msg.type === "write-pyramid") {
      await writePyramid(store, msg.dir, msg.name, msg.id, post);
      post({ type: "done", files: [], cancelled: cancelled.has(msg.id) });
      cancelled.delete(msg.id);
      return;
    }
    const { levels, label } = await storeLevels(store);
    if (msg.type === "levels") {
      post({ type: "levels", levels: levels.map(({ size, type, bytes }) => ({ size, type, bytes })), label });
      return;
    }
    const level = levels[msg.level];
    if (level === undefined) throw new Error(`no level ${msg.level}`);
    // A box around a point (RAS mm), or the whole level.
    const region = msg.region === undefined ? undefined : regionAround(level, msg.region.centre, msg.region.size);
    const volume = await readLevel(store, level, (done, total) => post({ type: "progress", what: "Reading", done, total }), region);
    post({ type: "progress", what: "Writing", done: 0, total: 1 });
    const description = `${store.name}, exported by ngplatform`;
    const format = msg.format as ImageFormat;
    let files: [string, Uint8Array][];
    if (format === "zarr") {
      files = [...(await omeZarrFiles(volume, store.name, { label, window: label ? undefined : displayWindow(volume.data), description }))];
    } else if (format === "mgh" || format === "mgz") {
      const bytes = mghFile(volume);
      files = [[`image.${format}`, format === "mgz" ? await gzip(bytes) : bytes]];
    } else {
      const bytes = niftiFile(volume, { label, window: label ? undefined : displayWindow(volume.data), description: description.slice(0, 79) });
      files = [[`image.${format}`, format === "nii.gz" ? await gzip(bytes) : bytes]];
    }
    post({ type: "done", files }, [...new Set(files.map(([, b]) => b.buffer as ArrayBuffer))]);
  } catch (e) {
    post({ type: "error", message: (e as Error).message });
  }
};
