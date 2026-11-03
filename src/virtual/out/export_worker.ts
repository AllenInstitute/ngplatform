/**
 * Exports an image on this computer to another format, off the page's
 * thread: the file is opened as its virtual store, a level read back whole
 * and written out.
 *
 * In:  { type: "levels", id, file }
 *      { type: "export", id, file, format, level, region?: { centre (RAS mm), size (voxels) } }
 * Out: { type: "levels", id, levels: { size, type, bytes }[], label }
 *      { type: "progress", id, what, done, total }
 *      { type: "done", id, files: [path, bytes][] }
 *      { type: "error", id, message }
 */
import { openImage } from "../images/open.js";
import { parseMeshFile } from "../vectors/mesh_files.js";
import { parseLas, parsePointParquet, parsePointTable, parseSwc } from "../vectors/point_files.js";
import { parseTckHeader, readTck } from "../vectors/tck.js";
import type { TrkBatch } from "../vectors/trk.js";
import { parseTrkHeader, readTrk, TRK_HEADER_SIZE } from "../vectors/trk.js";
import { openTrxInfo, readTrx } from "../vectors/trx.js";
import { exportKind, type GeometryFormat, type ImageFormat } from "./kinds.js";
import { readLevel, regionAround, storeLevels } from "./read_level.js";
import { csvFile, type Curves, objFile, plyFile, stlFile, tckFile, trkFile } from "./vectors.js";
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
    const table = /\.las$/i.test(file.name) ? parseLas(new Uint8Array(await file.arrayBuffer())) : /\.parquet$/i.test(file.name) ? await parsePointParquet(file) : parsePointTable(await file.text());
    return csvFile(table.positions, table.columns);
  }
  throw new Error(`a ${kind ?? "file"} cannot be written as ${format}`);
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  const post = (m: object, transfer: Transferable[] = []) => postMessage({ id: msg.id, ...m }, { transfer });
  try {
    if (msg.type === "export" && exportKind(msg.file.name) !== "image") {
      post({ type: "progress", what: "Reading", done: 0, total: 1 });
      const bytes = await exportGeometry(msg.file, msg.format);
      post({ type: "done", files: [[`file.${msg.format}`, bytes]] }, [bytes.buffer as ArrayBuffer]);
      return;
    }
    const store = await openImage(msg.file);
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
