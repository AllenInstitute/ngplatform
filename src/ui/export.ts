/**
 * Export as…: a dataset read from a file on this computer, saved in another
 * format.  Images: NIfTI (.nii.gz, .nii), FreeSurfer (.mgz, .mgh) or an
 * OME-Zarr folder, at full resolution or a coarser level.  The file is read
 * and written in a worker (src/virtual/out/export_worker.ts); the result is
 * saved where the system's save dialog says, or downloaded.
 */
import type { DatasetRecord } from "../core/workspace.js";
import type { ExportFormat } from "../virtual/out/export_worker.js";
import { zipFiles } from "../virtual/out/volume.js";
import { formDialog, toast } from "./overlays.js";
import type { Workbench } from "./workbench.js";

const FORMATS: { label: string; format: ExportFormat; suffix: string }[] = [
  { label: "NIfTI, compressed (.nii.gz)", format: "nii.gz", suffix: ".nii.gz" },
  { label: "NIfTI (.nii)", format: "nii", suffix: ".nii" },
  { label: "FreeSurfer, compressed (.mgz)", format: "mgz", suffix: ".mgz" },
  { label: "FreeSurfer (.mgh)", format: "mgh", suffix: ".mgh" },
  { label: "OME-Zarr (a folder)", format: "zarr", suffix: ".ome.zarr" },
];

/** At most this much is read and written at once: a level finer than it is not offered. */
const MAX_BYTES = 2 ** 31;

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

const sizeText = (bytes: number) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.max(0.1, bytes / 2 ** 20).toFixed(1)} MB`);

/** Whether a dataset can be exported: an image read from a file on this computer. */
export function canExport(wb: Workbench, dataset: DatasetRecord): boolean {
  const source = typeof dataset.source === "string" ? dataset.source : String((dataset.source as { url?: string } | undefined)?.url ?? "");
  return wb.localData.parse(source) !== undefined && /\.(nii(\.gz)?|hdr|mg[hz]|tiff?)\/?$/i.test(source.replace(/\/$/, ""));
}

export async function exportDataset(wb: Workbench, dataset: DatasetRecord): Promise<void> {
  const source = typeof dataset.source === "string" ? dataset.source : String((dataset.source as { url?: string } | undefined)?.url ?? "");
  const found = await wb.localData.sourceFile(source);
  if (found === undefined) {
    toast(`${dataset.name} is not a file on this computer that can be exported.`, "error");
    return;
  }
  const worker = new Worker(new URL("../virtual/out/export_worker.ts", import.meta.url), { type: "module", name: "export" });
  try {
    const info = await request(worker, { type: "levels", file: found.file });
    const levels = (info.levels as { size: number[]; bytes: number }[]).map((l, i) => ({ ...l, index: i })).filter((l) => l.bytes <= MAX_BYTES);
    if (levels.length === 0) throw new Error("every level is larger than 2 GB");
    const levelLabel = (l: { index: number; size: number[]; bytes: number }) => `${l.index === 0 ? "Full resolution" : `Level ${l.index}`}: ${l.size.join(" × ")} (${sizeText(l.bytes)})`;
    const answer = await formDialog<{ format: string; level: string }>(
      `Export ${dataset.name}`,
      {
        type: "object",
        properties: {
          format: { type: "string", title: "Format", enum: FORMATS.map((f) => f.label), default: FORMATS[0].label },
          level: { type: "string", title: "Resolution", enum: levels.map(levelLabel), default: levelLabel(levels[0]) },
        },
        required: ["format", "level"],
      },
      {},
      "Export",
    );
    if (answer === undefined) return;
    const chosen = FORMATS.find((f) => f.label === answer.format)!;
    const level = levels.find((l) => levelLabel(l) === answer.level)!;
    const base = `${dataset.name}${level.index > 0 ? `_level${level.index}` : ""}`;
    const target = await chooseTarget(chosen.format === "zarr", base + chosen.suffix);
    if (target === null) return;
    await wb.jobs.run(`Export ${dataset.name}`, async (control) => {
      const done = await request(worker, { type: "export", file: found.file, format: chosen.format, level: level.index }, (what, n, total) => control.progress(n / Math.max(1, total), what));
      await save(new Map<string, Uint8Array>(done.files), base + chosen.suffix, chosen.format === "zarr", target);
    });
    toast(`Exported ${dataset.name} as ${base}${chosen.suffix}.`);
  } catch (e) {
    toast(`Could not export ${dataset.name}: ${(e as Error).message}`, "error");
  } finally {
    worker.terminate();
  }
}

type Target = FileSystemFileHandle | FileSystemDirectoryHandle | undefined;
type Pickers = {
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
  // Nowhere to write: download (an OME-Zarr folder as a zip).
  const blob = folder ? zipFiles(new Map([...files].map(([p, b]) => [`${name}/${p}`, b]))) : new Blob([[...files.values()][0] as BlobPart]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = folder ? `${name}.zip` : name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
