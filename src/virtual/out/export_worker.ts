/**
 * Exports an image on this computer to another format, off the page's
 * thread: the file is opened as its virtual store, a level read back whole
 * and written out.
 *
 * In:  { type: "levels", id, file }
 *      { type: "export", id, file, format, level }
 * Out: { type: "levels", id, levels: { size, type, bytes }[], label }
 *      { type: "progress", id, what, done, total }
 *      { type: "done", id, files: [path, bytes][] }
 *      { type: "error", id, message }
 */
import { openImage } from "../images/open.js";
import { readLevel, storeLevels } from "./read_level.js";
import { displayWindow, gzip, mghFile, niftiFile, omeZarrFiles } from "./volume.js";

export type ExportFormat = "nii.gz" | "nii" | "mgz" | "mgh" | "zarr";

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  const post = (m: object, transfer: Transferable[] = []) => postMessage({ id: msg.id, ...m }, { transfer });
  try {
    const store = await openImage(msg.file);
    const { levels, label } = await storeLevels(store);
    if (msg.type === "levels") {
      post({ type: "levels", levels: levels.map(({ size, type, bytes }) => ({ size, type, bytes })), label });
      return;
    }
    const level = levels[msg.level];
    if (level === undefined) throw new Error(`no level ${msg.level}`);
    const volume = await readLevel(store, level, (done, total) => post({ type: "progress", what: "Reading", done, total }));
    post({ type: "progress", what: "Writing", done: 0, total: 1 });
    const description = `${store.name}, exported by ngplatform`;
    const format = msg.format as ExportFormat;
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
