/**
 * Export as…: a dataset read from a file on this computer, or an image
 * computed as it is viewed (a filtered view, `workspace.computed`), saved
 * in another format.  Images: NIfTI (.nii.gz, .nii), FreeSurfer (.mgz,
 * .mgh) or an OME-Zarr folder, at full resolution or a coarser level (a
 * computed one is computed as it is read, through the service worker as
 * the viewer reads it); tractograms as
 * .trk or .tck; meshes as OBJ, PLY or STL; points as CSV; graphs as GraphML.  The file is read
 * and written in a worker (src/virtual/out/export_worker.ts); the result is
 * saved where the system's save dialog says, or downloaded.
 */
import { JobCancelled } from "../platform/jobs.js";
import type { DatasetRecord } from "../core/workspace.js";
import { pipelineCode } from "../virtual/computed.js";
import { type ExportFormat, exportKind } from "../virtual/out/kinds.js";
import { zipFiles } from "../virtual/out/volume.js";
import { safeFileName } from "../sdk/dom.js";
import { formDialog, toast } from "./overlays.js";
import type { Workbench } from "./workbench.js";

type Format = { label: string; format: ExportFormat; suffix: string };

/** What each kind of file can be saved as. */
const FORMATS: Record<NonNullable<ReturnType<typeof exportKind>>, Format[]> = {
  image: [
    { label: "NIfTI, compressed (.nii.gz)", format: "nii.gz", suffix: ".nii.gz" },
    { label: "NIfTI (.nii)", format: "nii", suffix: ".nii" },
    { label: "FreeSurfer, compressed (.mgz)", format: "mgz", suffix: ".mgz" },
    { label: "FreeSurfer (.mgh)", format: "mgh", suffix: ".mgh" },
    { label: "OME-Zarr (a folder)", format: "zarr", suffix: ".ome.zarr" },
  ],
  streamlines: [
    { label: "TrackVis (.trk)", format: "trk", suffix: ".trk" },
    { label: "MRtrix (.tck)", format: "tck", suffix: ".tck" },
  ],
  mesh: [
    { label: "Wavefront (.obj)", format: "obj", suffix: ".obj" },
    { label: "Stanford PLY (.ply)", format: "ply", suffix: ".ply" },
    { label: "STL (.stl)", format: "stl", suffix: ".stl" },
    { label: "Vertices as CSV (.csv)", format: "csv", suffix: ".csv" },
  ],
  points: [{ label: "CSV (.csv)", format: "csv", suffix: ".csv" }],
  graph: [
    { label: "GraphML (.graphml)", format: "graphml", suffix: ".graphml" },
    { label: "Nodes as CSV (.csv)", format: "csv", suffix: ".csv" },
  ],
};

/** At most this much is read and written at once: a level finer than it is not offered. */
const MAX_BYTES = 2 ** 31;

/**
 * Without Chrome's or Edge's save dialogs (Firefox, Safari) a file is
 * downloaded, built whole in memory first (a folder as a zip): at most this
 * much, so a large export does not take the tab's memory.
 */
export const DOWNLOAD_BYTES = 2 ** 30;

/** Said where levels are left out because this browser can only download. */
export const DOWNLOAD_NOTE = `Levels over ${sizeTextOf(DOWNLOAD_BYTES)} are not offered: this browser saves by downloading, which builds the file whole in memory. Chrome or Edge save straight to disk.`;

/** How large a level may be saved whole, as this browser saves: through its save dialogs to disk, or by download. */
export function levelLimit(pickers: Pickers): number {
  return pickers.showSaveFilePicker !== undefined && pickers.showDirectoryPicker !== undefined ? MAX_BYTES : DOWNLOAD_BYTES;
}

/** Why files cannot be downloaded (more than DOWNLOAD_BYTES in all), or undefined when they can. */
export function tooLargeToDownload(files: Iterable<Uint8Array>, name: string): string | undefined {
  let bytes = 0;
  for (const f of files) bytes += f.byteLength;
  if (bytes <= DOWNLOAD_BYTES) return undefined;
  return `${name} is ${sizeTextOf(bytes)}, more than this browser can download (${sizeTextOf(DOWNLOAD_BYTES)}): it builds a download whole in memory. Use Chrome or Edge to save it straight to disk, or export a coarser level or a box.`;
}

type Reply = { type: string; [key: string]: any };

function request(worker: Worker, message: object, onProgress?: (what: string, done: number, total: number) => void): Promise<Reply> {
  const id = Math.random();
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      if (reply.id !== id) return;
      if (reply.type === "progress") {
        onProgress?.(reply.what, reply.done, reply.total);
        return;
      }
      worker.removeEventListener("message", listener);
      if (reply.type === "error") reject(new Error(reply.message));
      else resolve(reply);
    };
    worker.addEventListener("message", listener);
    worker.postMessage({ ...message, id });
  });
}

/** `work`, unless the job is cancelled first: then the worker is stopped and JobCancelled thrown (nothing is saved). */
function unlessCancelled<T>(worker: Worker, control: { readonly cancelled: boolean }, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setInterval> | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (!control.cancelled) return;
      worker.terminate();
      reject(new JobCancelled());
    }, 200);
  });
  return Promise.race([work, cancelled]).finally(() => clearInterval(timer));
}

function sizeTextOf(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.max(0.1, bytes / 2 ** 20).toFixed(1)} MB`;
}
const sizeText = sizeTextOf;

const sourceOf = (dataset: DatasetRecord) => (typeof dataset.source === "string" ? dataset.source : String((dataset.source as { url?: string } | undefined)?.url ?? ""));

/** The file name a local dataset's source reads ("brain.nii.gz", "tracts.trk"). */
function fileNameOf(wb: Workbench, dataset: DatasetRecord): string | undefined {
  const at = wb.localData.parse(sourceOf(dataset).replace(/^[a-z0-9+]+:\/\/(?=https?:)/, ""));
  return at?.path.replace(/\/$/, "").split("/").pop();
}

/** The http(s) URL of a computed view (a filtered image), if the dataset is one. */
function computedUrl(dataset: DatasetRecord): string | undefined {
  const source = sourceOf(dataset);
  if (pipelineCode(source) === undefined) return undefined;
  return source.replace(/\|.*$/, "").replace(/^(zarr3?|zarr2|ome-zarr):\/\//, "");
}

/** Whether a dataset can be exported: an image, tractogram, mesh or point table read from a file on this computer, or a computed image. */
export function canExport(wb: Workbench, dataset: DatasetRecord): boolean {
  if (computedUrl(dataset) !== undefined) return true;
  const name = fileNameOf(wb, dataset);
  return name !== undefined && exportKind(name) !== undefined;
}

export async function exportDataset(wb: Workbench, dataset: DatasetRecord): Promise<void> {
  const url = computedUrl(dataset);
  const found = url !== undefined ? undefined : await wb.localData.sourceFile(sourceOf(dataset));
  if (url === undefined && found === undefined) {
    toast(`${dataset.name} is not a file on this computer that can be exported.`, "error");
    return;
  }
  // What the worker reads: the file, or the computed view's URL (its layers a mask or labels when it is a segmentation).
  const input = found !== undefined ? { file: found.file } : { url, title: dataset.name, label: dataset.kind === "segmentation" };
  const kind = found !== undefined ? exportKind(found.file.name) : "image";
  if (kind === undefined) return;
  const formats = FORMATS[kind];
  const worker = new Worker(new URL("../virtual/out/export_worker.ts", import.meta.url), { type: "module", name: "export" });
  try {
    if (kind !== "image") {
      const answer = await formDialog<{ format: string }>(
        `Export ${dataset.name}`,
        { type: "object", properties: { format: { type: "string", title: "Format", enum: formats.map((f) => f.label), default: formats[0].label } }, required: ["format"] },
        {},
        "Export",
      );
      if (answer === undefined) return;
      const chosen = formats.find((f) => f.label === answer.format)!;
      const target = await chooseTarget(false, dataset.name + chosen.suffix);
      if (target === null) return;
      await wb.jobs.run(`Export ${dataset.name}`, async (control) => {
        const done = await unlessCancelled(worker, control, request(worker, { type: "export", ...input, format: chosen.format }, (what, n, total) => control.progress(n / Math.max(1, total), what)));
        await save(new Map<string, Uint8Array>(done.files), dataset.name + chosen.suffix, false, target);
      });
      toast(`Exported ${dataset.name} as ${dataset.name}${chosen.suffix}.`);
      return;
    }
    const info = await request(worker, { type: "levels", ...input });
    const all = (info.levels as { size: number[]; bytes: number; type: string }[]).map((l, i) => ({ ...l, index: i }));
    const levelLabel = (l: { index: number; size: number[]; bytes: number }) => `${l.index === 0 ? "Full resolution" : `Level ${l.index}`}: ${l.size.join(" × ")} (${sizeText(l.bytes)})`;
    // A box around the position, for images too large to save whole: any level, the box within the limit.
    const BOX = 256;
    const boxLabel = (l: { index: number; size: number[]; bytes: number }) => {
      const n = l.size.map((s) => Math.min(s, BOX));
      return `${l.index === 0 ? "Full resolution" : `Level ${l.index}`}: a box of ${n.join(" × ")} around the position (${sizeText((l.bytes / (l.size[0] * l.size[1] * l.size[2])) * n[0] * n[1] * n[2])})`;
    };
    const total = all.reduce((sum, l) => sum + l.bytes, 0);
    // Outside Chrome and Edge a level is downloaded, built whole in memory: only the smaller ones.
    const limit = levelLimit(window as unknown as Pickers);
    const leftOut = all.some((l) => l.bytes > limit && l.bytes <= MAX_BYTES);
    const PYRAMID = `Every level, written into a folder chunk by chunk (OME-Zarr only; ${sizeText(total)} before compression)`;
    const choices = [
      ...all.filter((l) => l.bytes <= limit).map((l) => ({ label: levelLabel(l), level: l.index, box: false })),
      ...all.filter((l) => l.size.some((s) => s > BOX)).map((l) => ({ label: boxLabel(l), level: l.index, box: true })),
      // Any size: nothing is held whole.  Needs a browser that writes folders.
      ...((window as unknown as Pickers).showDirectoryPicker ? [{ label: PYRAMID, level: 0, box: false }] : []),
    ];
    if (choices.length === 0) throw new Error(`every level is larger than ${sizeText(limit)}. Use Chrome or Edge to write it into a folder level by level`);
    const answer = await formDialog<{ format: string; what: string }>(
      `Export ${dataset.name}`,
      {
        type: "object",
        properties: {
          format: { type: "string", title: "Format", enum: formats.map((f) => f.label), default: formats[0].label },
          what: { type: "string", title: "What", enum: choices.map((c) => c.label), default: choices[0].label, ...(leftOut ? { description: DOWNLOAD_NOTE } : {}) },
        },
        required: ["format", "what"],
      },
      {},
      "Export",
    );
    if (answer === undefined) return;
    const chosen = formats.find((f) => f.label === answer.format)!;
    const choice = choices.find((c) => c.label === answer.what)!;
    if (choice.label === PYRAMID) {
      const target = await chooseTarget(true, dataset.name);
      if (target === null) return;
      if (target?.kind !== "directory") throw new Error("writing every level needs a folder to write into");
      const name = `${dataset.name}.ome.zarr`;
      const done = await wb.jobs.run(`Export ${dataset.name}`, (control) => writePyramid(worker, input, target, name, control));
      if (done) toast(`Exported every level of ${dataset.name} into ${name}.`);
      return;
    }
    const level = all[choice.level];
    // The position, as RAS millimetres, for a box around it.
    const nav = wb.engine.navigation();
    const centre = ["x", "y", "z"].map((n) => {
      const i = nav.names.indexOf(n);
      return i === -1 ? 0 : nav.position[i] * nav.scales[i] * (nav.units[i] === "m" ? 1000 : 1);
    });
    const region = choice.box ? { centre, size: BOX } : undefined;
    const base = `${dataset.name}${level.index > 0 ? `_level${level.index}` : ""}${choice.box ? "_box" : ""}`;
    const target = await chooseTarget(chosen.format === "zarr", base + chosen.suffix);
    if (target === null) return;
    await wb.jobs.run(`Export ${dataset.name}`, async (control) => {
      const done = await unlessCancelled(worker, control, request(worker, { type: "export", ...input, format: chosen.format, level: level.index, region }, (what, n, total) => control.progress(n / Math.max(1, total), what)));
      await save(new Map<string, Uint8Array>(done.files), base + chosen.suffix, chosen.format === "zarr", target);
    });
    toast(`Exported ${dataset.name} as ${base}${chosen.suffix}.`);
  } catch (e) {
    if (e instanceof JobCancelled) toast(`Export of ${dataset.name} cancelled.`);
    else toast(`Could not export ${dataset.name}: ${(e as Error).message}`, "error");
  } finally {
    worker.terminate();
  }
}

/**
 * The image's whole pyramid into a folder `name` in `parent`, written by
 * the worker: the metadata, then every level's chunks (gzipped) as one pass
 * over the file makes them, so nothing is held whole and no level is made
 * twice.  False when cancelled.
 */
async function writePyramid(worker: Worker, input: object, parent: FileSystemDirectoryHandle, name: string, control: { progress(fraction: number, what?: string): void; readonly cancelled: boolean }): Promise<boolean> {
  const id = Math.random();
  const watch = setInterval(() => {
    if (control.cancelled) worker.postMessage({ type: "cancel", id });
  }, 300);
  try {
    const done = await new Promise<Reply>((resolve, reject) => {
      const listener = (event: MessageEvent<Reply>) => {
        const reply = event.data;
        if (reply.id !== id) return;
        if (reply.type === "progress") {
          control.progress(reply.done / Math.max(1, reply.total), reply.what);
          return;
        }
        worker.removeEventListener("message", listener);
        if (reply.type === "error" && !control.cancelled) reject(new Error(reply.message));
        else resolve(reply);
      };
      worker.addEventListener("message", listener);
      worker.postMessage({ type: "write-pyramid", id, ...input, dir: parent, name });
    });
    return !control.cancelled && done.type === "done";
  } finally {
    clearInterval(watch);
  }
}

type Target = FileSystemFileHandle | FileSystemDirectoryHandle | undefined;
export type Pickers = {
  showSaveFilePicker?(o: unknown): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(o?: unknown): Promise<FileSystemDirectoryHandle>;
};

/** Where to save, asked first (the dialog needs the click that asked for it); undefined: download; null: cancelled. */
async function chooseTarget(folder: boolean, name: string): Promise<Target | null> {
  const pickers = window as unknown as Pickers;
  try {
    if (folder && pickers.showDirectoryPicker) return await pickers.showDirectoryPicker({ id: "ngplatform-export", mode: "readwrite" });
    if (!folder && pickers.showSaveFilePicker) return await pickers.showSaveFilePicker({ id: "ngplatform-export", suggestedName: name });
  } catch (e) {
    if ((e as DOMException).name === "AbortError") return null;
    throw e;
  }
  return undefined;
}

async function save(files: Map<string, Uint8Array>, name: string, folder: boolean, target: Target): Promise<void> {
  const write = async (handle: FileSystemFileHandle, bytes: Uint8Array) => {
    const writable = await handle.createWritable();
    await writable.write(bytes as unknown as BufferSource);
    await writable.close();
  };
  if (folder && target?.kind === "directory") {
    const root = await target.getDirectoryHandle(name, { create: true });
    for (const [path, bytes] of files) {
      const parts = path.split("/");
      let dir = root;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      await write(await dir.getFileHandle(parts[parts.length - 1], { create: true }), bytes);
    }
    return;
  }
  if (!folder && target?.kind === "file") {
    await write(target, [...files.values()][0]);
    return;
  }
  // Nowhere to write: download (an OME-Zarr folder as a zip), built whole in memory, so not too large.
  const tooLarge = tooLargeToDownload(files.values(), folder ? `${name}.zip` : name);
  if (tooLarge !== undefined) throw new Error(tooLarge);
  const blob = folder ? zipFiles(new Map([...files].map(([p, b]) => [`${name}/${p}`, b]))) : new Blob([[...files.values()][0] as BlobPart]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = folder ? `${name}.zip` : name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/**
 * The longest workspace link offered as a link (characters).  Browsers take
 * far longer ones, but chat tools and mail clients cut or refuse links
 * beyond a few thousand characters, and a link cut short opens nothing.
 */
export const SHARE_LINK_LIMIT = 8000;

/** Whether a link is too long to share as one (SHARE_LINK_LIMIT). */
export const linkTooLong = (link: string): boolean => link.length > SHARE_LINK_LIMIT;

/** The workspace as a file to share: its JSON, named after the scene shown ("Scene 1.workspace.json"). */
export function workspaceFile(json: string, sceneName: string): { blob: Blob; name: string } {
  const name = `${safeFileName(sceneName, "workspace")}.workspace.json`;
  return { blob: new Blob([json], { type: "application/json" }), name };
}
