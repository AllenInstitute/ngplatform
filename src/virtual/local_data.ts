/**
 * Data on this computer, opened in the viewer without uploading it: a
 * picked folder (an OME-Zarr image, a zarr-vectors store, a precomputed
 * volume) or file (NIfTI) gets a URL under <app>/local/<id>/, which the
 * service worker (src/sw.ts) answers by asking this page for the
 * file.  Neuroglancer reads it like any other source, ranges and all.
 *
 * Files that are not Zarr are read as virtual stores: the URLs under a
 * file's own (<file>/zarr.json, <file>/0/c/…) are a store made from it as
 * they are asked for, in a worker.  NIfTI opens as a chunked, multiscale
 * OME-Zarr image (./images/), and tractograms, meshes, neurons and point
 * tables as Zarr Vectors stores (./vectors/); data type plugins can add
 * their own formats (`addFormats`).
 *
 * The folders are remembered in this browser (where the browser can), so a
 * workspace link to local data opens again here after one click to allow
 * reading; the link means nothing on another computer.  A folder opened for
 * writing can be changed too: track groups saved into a zarr-vectors store.
 */

import type { VirtualFormat } from "../sdk/types.js";
import { MGH_FILE } from "./images/mgh.js";
import { NPY_FILE } from "./images/npy.js";
import { LABEL_NAME, listingHtml, pairAsSingleFile, TIFF_FILE, VIRTUAL_FILE } from "./images/store.js";
import type { VirtualRequest } from "../sdk/virtual.js";
import { ZARR_VECTORS_VIRTUAL } from "./vectors/formats.js";

/** NIfTI, read as OME-Zarr by the platform's own worker. */
export const NIFTI_FORMAT: VirtualFormat = {
  pattern: VIRTUAL_FILE,
  extensions: [".nii", ".nii.gz", ".hdr"],
  format: "NIfTI image",
  kind: "image",
  source: (url) => `zarr3://${url}/`,
  worker: () => new Worker(new URL("./images/worker.ts", import.meta.url), { type: "module", name: "virtual-zarr" }),
};

/** FreeSurfer's .mgz and .mgh, read by the same worker as NIfTI (images/mgh.ts). */
export const MGH_FORMAT: VirtualFormat = {
  ...NIFTI_FORMAT,
  pattern: MGH_FILE,
  extensions: [".mgz", ".mgh"],
  format: "FreeSurfer volume",
};

/** A filtered view of an image (images/filters.ts), read by the same worker. */
export const FILTER_FORMAT: VirtualFormat = {
  ...NIFTI_FORMAT,
  pattern: /\.vfilter$/i,
  extensions: [],
  format: "Filtered image",
};

/** NumPy .npy arrays (2-D to 4-D), read by the same worker (images/npy.ts). */
export const NPY_FORMAT: VirtualFormat = {
  ...NIFTI_FORMAT,
  pattern: NPY_FILE,
  extensions: [".npy"],
  format: "NumPy array",
};

export const TIFF_FORMAT: VirtualFormat = {
  ...NIFTI_FORMAT,
  pattern: TIFF_FILE,
  extensions: [".tif", ".tiff"],
  format: "TIFF stack",
};

/**
 * A refkv vzip archive: a Zarr hierarchy whose chunks reference byte ranges
 * of other files (TIFF, CZI, ND2, HDF5 … zarrified by refkv), served by the
 * same worker; the files beside it are handed over for its references.
 */
export const VZIP_FORMAT: VirtualFormat = {
  ...NIFTI_FORMAT,
  pattern: /\.vzip$/i,
  extensions: [".vzip"],
  format: "Zarr archive (refkv vzip)",
  source: (url) => `zarr://${url}/`,
  related: async (path, list) => {
    const name = path.split("/").pop()!;
    const dir = path.slice(0, path.length - name.length).replace(/\/$/, "");
    return (await list(dir)).filter((f) => f !== name);
  },
};

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;
type Permissioned = Handle & {
  queryPermission?(o: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};

export interface LocalEntry {
  id: string;
  name: string;
  kind: "folder" | "file";
  /** Reading needs a click to allow again (after a reload). */
  needsPermission: boolean;
}

/** A dataset found in a local folder or file. */
export interface FoundDataset {
  /** The layer source: a Neuroglancer data source URL. */
  source: string;
  name: string;
  kind: string;
  /** What it is, for the list: "OME-Zarr image", "zarr-vectors store", … */
  format: string;
  /** Its path inside the picked folder ("" for the folder itself). */
  path: string;
  /** Settings for its layer (a surface's colour, say). */
  layer?: Record<string, unknown>;
}

interface Stored {
  id: string;
  name: string;
  kind: "folder" | "file";
  handle?: Handle;
  /** Several things dropped at once: each one's handle, read as one folder of them. */
  handles?: Handle[];
}

interface Open extends Stored {
  /** Files from a file input, where there is no handle (read-only, for this visit). */
  files?: Map<string, File>;
  needsPermission: boolean;
}

const DB = "ngplatform";
const STORE = "localData";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      for (const name of ["localPlugins", STORE]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: name === STORE ? "id" : "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = work(database.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The colours Freeview gives FreeSurfer's surfaces, so their outlines on the
 * sections read the same: white yellow, pial red; others undefined.
 */
function surfaceColour(name: string): string | undefined {
  if (/(^|\.)(white|smoothwm)(\.|$)/i.test(name)) return "#ffff00";
  if (/(^|\.)pial(\.|$)/i.test(name)) return "#ff0000";
  if (/(^|\.)(orig|midthickness|graymid)(\.|$)/i.test(name)) return "#00c0ff";
  return undefined;
}

/** Ids of derived files start so; `DERIVED_LOCAL` finds them in a URL. */
const DERIVED_PREFIX = "derived-";

/** A short id for URLs. */
function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export class LocalData {
  private readonly entries = new Map<string, Open>();
  private readonly listeners = new Set<() => void>();
  /** The app's base URL; local URLs are under base/local/. */
  readonly base: string;
  private worker: Promise<ServiceWorker | undefined> | undefined;
  /** Files read as virtual stores, and the workers that serve them. */
  private formats: VirtualFormat[] = [NIFTI_FORMAT, MGH_FORMAT, NPY_FORMAT, TIFF_FORMAT, VZIP_FORMAT, FILTER_FORMAT, ...ZARR_VECTORS_VIRTUAL];
  private readonly virtualWorkers = new Map<VirtualFormat, Worker>();
  /** Each file's related files (`VirtualFormat.related`), found once: by entry id and path. */
  private readonly relatedFiles = new Map<string, Promise<Record<string, File>>>();

  constructor(base = new URL(".", location.href).href) {
    this.base = base;
  }

  /** Adds kinds of file read as virtual stores (a data type plugin's). */
  addFormats(formats: VirtualFormat[]): void {
    this.formats = [...this.formats, ...formats];
  }

  /** The virtual format a file name is read as, if any. */
  formatOf(name: string): VirtualFormat | undefined {
    return this.formats.find((f) => f.pattern.test(name));
  }

  /** Extensions of the files read as virtual stores, for file pickers. */
  get extensions(): string[] {
    return this.formats.flatMap((f) => f.extensions);
  }

  static get supported(): boolean {
    return "serviceWorker" in navigator && window.isSecureContext;
  }

  /** Whether files can be remembered and written (the File System Access API). */
  static get canWrite(): boolean {
    return "showDirectoryPicker" in window;
  }

  /** Whether remembered data is known yet (`restore` done). */
  restored = false;

  /** Whether `id` is open in this tab: remembered, dropped or picked. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): LocalEntry[] {
    return [...this.entries.values()].filter((e) => !e.id.startsWith(DERIVED_PREFIX)).map(({ id, name, kind, needsPermission }) => ({ id, name, kind, needsPermission }));
  }

  /** Files read as virtual stores whose metadata has been read, by place. */
  private readonly opened = new Set<string>();
  private readonly openListeners = new Set<(opened: { url: string; file: File; format: VirtualFormat }) => void>();

  /** Calls `listener` when the viewer first reads a file's virtual store (its metadata), with the store's URL. */
  onVirtualOpen(listener: (opened: { url: string; file: File; format: VirtualFormat }) => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  urlOf(id: string, path = ""): string {
    return `${this.base}local/${id}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** The local entry a URL is under, and the path in it. */
  parse(url: string): { id: string; path: string } | undefined {
    const at = url.indexOf(`${this.base}local/`);
    if (at === -1) return undefined;
    const rest = url.slice(at + this.base.length + "local/".length).replace(/\|.*$/, "");
    const slash = rest.indexOf("/");
    return slash === -1 ? { id: rest, path: "" } : { id: rest.slice(0, slash), path: decodeURIComponent(rest.slice(slash + 1)) };
  }

  /** Starts the service worker (once) and answers its reads; resolves once it controls this page. */
  start(): Promise<ServiceWorker | undefined> {
    if (!LocalData.supported) return Promise.resolve(undefined);
    this.worker ??= (async () => {
      navigator.serviceWorker.addEventListener("message", (event) => {
        const data = event.data;
        // A read that fails (a file changed on disk since it was opened, say) says so at once, rather than leaving the worker to time out.
        if (data?.type === "local-read")
          void this.restoring
            .then(() => this.answer({ ...data, path: data.file }, event.ports[0]))
            .catch((e: unknown) => event.ports[0]?.postMessage({ status: 500, message: `Could not read ${data.file}: ${(e as Error)?.message ?? e}. If it changed on disk, open it again.` }));
        if (data?.type === "local-has") void this.restoring.then(() => event.ports[0]?.postMessage(this.entries.has(data.id)));
      });
      // Control can come after start() stops waiting (a busy page): tell the
      // worker then which data this page holds, so it need not ask around.
      navigator.serviceWorker.addEventListener("controllerchange", () => this.register());
      const registration = await navigator.serviceWorker.register(new URL("sw.js", this.base), { scope: this.base });
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller === null) {
        const controlled = new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
        (registration.active ?? registration.waiting ?? registration.installing)?.postMessage({ type: "local-claim" });
        await Promise.race([controlled, new Promise((r) => setTimeout(r, 3000))]);
      }
      return navigator.serviceWorker.controller ?? undefined;
    })().catch(() => undefined);
    return this.worker;
  }

  /** Folders and files remembered from earlier visits. */
  restore(): Promise<void> {
    this.restoring = this.restoreNow().finally(() => {
      this.restored = true;
      this.changed();
    });
    return this.restoring;
  }

  /**
   * Done once remembered data is known: the worker's reads wait for it, so
   * a workspace reopened after a reload is not told its local data has gone.
   */
  private restoring: Promise<void> = Promise.resolve();

  private async restoreNow(): Promise<void> {
    if (!LocalData.supported) return;
    let stored: Stored[] = [];
    try {
      stored = await idb<Stored[]>("readonly", (s) => s.getAll() as IDBRequest<Stored[]>);
    } catch {
      return;
    }
    for (const item of stored) {
      const handles = (item.handles ?? (item.handle ? [item.handle] : [])) as Permissioned[];
      let granted = handles.length > 0;
      for (const h of handles) if ((await h.queryPermission?.({ mode: "read" }).catch(() => undefined)) !== "granted") granted = false;
      const entry: Open = { ...item, needsPermission: !granted };
      if (granted && item.handles !== undefined) entry.files = await groupFiles(item.handles).catch(() => undefined);
      this.entries.set(item.id, entry);
    }
    if (stored.length) {
      await this.start();
      this.register();
    }
    this.changed();
  }

  private register(): void {
    for (const id of this.entries.keys()) navigator.serviceWorker.controller?.postMessage({ type: "local-register", id });
  }

  /** Asks again (from a click) to read the remembered folders. */
  async reconnect(): Promise<number> {
    let granted = 0;
    for (const entry of this.entries.values()) {
      if (!entry.needsPermission) continue;
      const handles = (entry.handles ?? (entry.handle ? [entry.handle] : [])) as Permissioned[];
      let ok = handles.length > 0;
      for (const h of handles) if ((await h.requestPermission?.({ mode: "read" }).catch(() => undefined)) !== "granted") ok = false;
      if (ok && entry.handles !== undefined) entry.files = await groupFiles(entry.handles).catch(() => undefined);
      if (ok) {
        entry.needsPermission = false;
        granted++;
      }
    }
    this.changed();
    return granted;
  }

  /** Asks for a folder (or a file) and opens it; undefined when cancelled. */
  async pick(folder: boolean): Promise<LocalEntry | undefined> {
    await this.start();
    const picker = window as unknown as {
      showOpenFilePicker?(o: unknown): Promise<FileSystemFileHandle[]>;
      showDirectoryPicker?(o?: unknown): Promise<FileSystemDirectoryHandle>;
    };
    const id = newId();
    let entry: Open;
    try {
      if (folder && picker.showDirectoryPicker) {
        const handle = await picker.showDirectoryPicker({ id: "ngplatform-data", mode: "read" });
        entry = { id, name: handle.name, kind: "folder", handle, needsPermission: false };
      } else if (!folder && picker.showOpenFilePicker) {
        const [handle] = await picker.showOpenFilePicker({
          id: "ngplatform-data",
          types: [{ description: this.formats.map((f) => f.format).join(", "), accept: { "application/octet-stream": [...new Set(this.extensions.map((e) => e.replace(/^.*(\.[^.]+)$/, "$1")))] } }],
        });
        entry = { id, name: handle.name, kind: "file", handle, needsPermission: false };
      } else {
        const files = await pickWithInput(folder, this.extensions);
        if (files === undefined) return undefined;
        const first = [...files.keys()][0];
        entry = folder ? { id, name: first.split("/")[0], kind: "folder", files: stripFolder(files), needsPermission: false } : { id, name: first, kind: "file", files, needsPermission: false };
      }
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return undefined;
      throw e;
    }
    this.entries.set(id, entry);
    if (entry.handle !== undefined) await idb("readwrite", (s) => s.put({ id, name: entry.name, kind: entry.kind, handle: entry.handle })).catch(() => {});
    this.register();
    this.changed();
    return { id, name: entry.name, kind: entry.kind, needsPermission: false };
  }

  /**
   * Opens what was dropped on the window: one folder or one file as it is
   * (remembered, as if picked, where the browser hands over a handle); more
   * than one as a single group of files, so a .hdr and its .img stay paired.
   * Call `collectDropped` inside the drop event and pass its result here.
   */
  async openDropped(dropped: Promise<DroppedItem[]>): Promise<LocalEntry | undefined> {
    const items = (await dropped).filter((d): d is DroppedItem => d !== undefined);
    if (items.length === 0) return undefined;
    await this.start();
    const id = newId();
    let entry: Open;
    const [only] = items;
    if (items.length === 1 && only.handle !== undefined) {
      entry = { id, name: only.handle.name, kind: only.handle.kind === "directory" ? "folder" : "file", handle: only.handle, needsPermission: false };
      await idb("readwrite", (s) => s.put({ id, name: entry.name, kind: entry.kind, handle: only.handle })).catch(() => {});
    } else {
      let files = new Map<string, File>();
      for (const item of items) for (const [path, file] of await item.files()) files.set(path, file);
      // One folder: its files, not the folder, are the entry's top level (as when picked).
      if (items.length === 1 && only.folder) files = stripFolder(files);
      if (files.size === 0) return undefined;
      const single = files.size === 1 && items.length === 1 && !items[0].folder;
      const name = single ? [...files.keys()][0] : items.length === 1 ? items[0].name : `${items.length} dropped items`;
      entry = { id, name, kind: single ? "file" : "folder", files, needsPermission: false };
      // Several things dropped at once are remembered too, where each came with a handle.
      const handles = items.map((i) => i.handle);
      if (items.length > 1 && handles.every((h) => h !== undefined)) {
        entry.handles = handles as Handle[];
        await idb("readwrite", (s) => s.put({ id, name, kind: "folder", handles })).catch(() => {});
      }
    }
    this.entries.set(id, entry);
    this.register();
    this.changed();
    return { id, name: entry.name, kind: entry.kind, needsPermission: false };
  }

  /**
   * Opens a file made in the page (a density map, say) as data on this
   * computer, for this visit only; returns the datasets found in it.  A
   * derived file (a track group's own streamlines, say) is a view of a
   * dataset that exists elsewhere: it is not listed, and a layer showing it
   * beside that dataset still counts as that dataset (`DERIVED_LOCAL`).
   */
  async openFile(file: File, derived = false): Promise<FoundDataset[]> {
    await this.start();
    const id = (derived ? DERIVED_PREFIX : "") + newId();
    this.entries.set(id, { id, name: file.name, kind: "file", files: new Map([[file.name, file]]), needsPermission: false });
    this.register();
    this.changed();
    return this.detect(id);
  }

  /** The file a virtual store is made from (an Analyze pair as one file), given its place. */
  private async virtualFile(id: string, virtual: { file: string; format: VirtualFormat }): Promise<File | undefined> {
    let file = (await this.file(id, virtual.file)) ?? (await this.collection(id, virtual.file, virtual.format));
    // A .hdr's image is in the .img beside it.
    if (file !== undefined && /\.hdr$/i.test(virtual.file)) {
      const img = await this.file(id, virtual.file.replace(/\.hdr$/i, ".img"));
      file = img === undefined ? undefined : await pairAsSingleFile(file, img, file.name.replace(/\.hdr$/i, ".nii"));
    }
    // A file another beside it completes (an edge list's node table): the two as one text.
    const companion = file === undefined ? undefined : await this.companion(id, virtual.file, virtual.format);
    if (file !== undefined && companion !== undefined) file = new File([file, `\n# @file ${companion.name}\n`, companion], file.name);
    return file;
  }

  /** The first of a format's companion files for `path` that is beside it. */
  private async companion(id: string, path: string, format: VirtualFormat): Promise<File | undefined> {
    const at = path.lastIndexOf("/");
    const dir = path.slice(0, at + 1);
    for (const name of format.companion?.(path.slice(at + 1)) ?? []) {
      const file = await this.file(id, dir + name);
      if (file !== undefined) return file;
    }
    return undefined;
  }

  /**
   * The file on this computer a dataset's source reads, when it is one read
   * as a virtual store (for exporting it), with its format.
   */
  async sourceFile(source: string): Promise<{ file: File; format: VirtualFormat } | undefined> {
    const at = this.parse(source.replace(/^[a-z0-9+]+:\/\/(?=https?:)/, ""));
    if (at === undefined) return undefined;
    const virtual = splitVirtual(`${at.path.replace(/\/$/, "")}/`, this.formats);
    if (virtual === undefined) return undefined;
    const file = await this.virtualFile(at.id, virtual);
    return file === undefined ? undefined : { file, format: virtual.format };
  }

  /** Drops a file opened with openFile, given a URL under it. */
  close(url: string): void {
    const at = this.parse(url);
    if (at === undefined || this.entries.get(at.id)?.files === undefined) return;
    this.entries.delete(at.id);
    this.release(at.id);
    this.changed();
  }

  /** Has the format workers let go of the stores made from an entry's files (a large tractogram's spill, say). */
  private release(id: string): void {
    for (const worker of this.virtualWorkers.values()) worker.postMessage({ type: "close", store: `${id}/` });
  }

  async forget(id: string): Promise<void> {
    this.entries.delete(id);
    this.release(id);
    await idb("readwrite", (s) => s.delete(id)).catch(() => {});
    this.changed();
  }

  /** Whether entry `id` holds `path`: a file, or a folder with something in it. */
  async holds(id: string, path: string): Promise<boolean> {
    const p = path.replace(/\/+$/, "");
    if (p === "" || this.entries.get(id)?.needsPermission !== false) return false;
    if ((await this.file(id, p).catch(() => undefined)) !== undefined) return true;
    return (await this.files(id, p).catch(() => [])).length > 0;
  }

  /**
   * Local data opened again under a new id (a reload drops dropped files):
   * for each layer source still reading an id this tab does not have, the
   * open entry holding the same path, or undefined.
   */
  async reopened(sources: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const source of sources) {
      const at = this.parse(source.replace(/^[a-z0-9+]+:\/\/(?=https?:)/, ""));
      if (at === undefined || this.entries.has(at.id) || out.has(at.id)) continue;
      for (const entry of this.list()) {
        if (await this.holds(entry.id, at.path)) {
          out.set(at.id, entry.id);
          break;
        }
      }
    }
    return out;
  }

  /** A file of an entry ("" or the file's name for a picked file). */
  async file(id: string, path: string): Promise<File | undefined> {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.files !== undefined) return entry.files.get(entry.kind === "file" ? entry.name : path);
    const handle = entry.handle;
    if (handle === undefined || entry.needsPermission) return undefined;
    try {
      if (handle.kind === "file") return path === "" || path === entry.name ? await handle.getFile() : undefined;
      const parts = path.split("/").filter(Boolean);
      if (parts.length === 0) return undefined;
      let dir = handle;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    } catch {
      return undefined;
    }
  }

  /**
   * Sends a message to the virtual store serving `url` (a file on this
   * computer read by a format's worker), opening it if need be; its answer.
   */
  async send(url: string, body: unknown): Promise<unknown> {
    const at = this.parse(url.replace(/^[a-z0-9+]+:\/\/(?=https?:)/, ""));
    if (at === undefined) throw new Error(`${url} is not on this computer`);
    const virtual = splitVirtual(`${at.path.replace(/\/$/, "")}/`, this.formats);
    if (virtual === undefined) throw new Error(`${url} is not a store read from a file`);
    const file = await this.virtualFile(at.id, virtual);
    if (file === undefined) throw new Error(`${url}: the file is not open`);
    let worker = this.virtualWorkers.get(virtual.format);
    if (worker === undefined) this.virtualWorkers.set(virtual.format, (worker = virtual.format.worker()));
    const related = virtual.format.related === undefined ? undefined : await this.related(at.id, virtual.file, virtual.format);
    const channel = new MessageChannel();
    const reply = new Promise<{ status: number; value?: unknown; message?: string }>((resolve) => (channel.port1.onmessage = (e) => resolve(e.data)));
    const message: VirtualRequest = { type: "message", store: `${at.id}/${virtual.file}`, file, related, key: "", body };
    worker.postMessage(message, [channel.port2]);
    const answer = await reply;
    channel.port1.close();
    if (answer.status !== 200) throw new Error(answer.message ?? `status ${answer.status}`);
    return answer.value;
  }

  private async answer(request: { id: string; path: string; range?: { start?: number; end?: number; suffix?: number }; head?: boolean }, port: MessagePort): Promise<void> {
    const entry = this.entries.get(request.id);
    if (entry === undefined) {
      port.postMessage({ status: 410 });
      return;
    }
    if (entry.needsPermission) {
      port.postMessage({ status: 403, message: "Reading this local data needs your permission again: click Allow access in the Datasets tab." });
      return;
    }
    const virtual = splitVirtual(request.path, this.formats);
    if (virtual !== undefined) {
      const file = await this.virtualFile(request.id, virtual);
      if (file === undefined) {
        port.postMessage({ status: 404 });
        return;
      }
      // A store's first read of its metadata: it has just been opened.
      const place = `${request.id}/${virtual.file}`;
      if (virtual.key === "zarr.json" && !this.opened.has(place)) {
        this.opened.add(place);
        for (const listener of this.openListeners) listener({ url: this.urlOf(request.id, virtual.file), file, format: virtual.format });
      }
      let worker = this.virtualWorkers.get(virtual.format);
      if (worker === undefined) this.virtualWorkers.set(virtual.format, (worker = virtual.format.worker()));
      const related = virtual.format.related === undefined ? undefined : await this.related(request.id, virtual.file, virtual.format);
      const message: VirtualRequest = { type: "get", store: `${request.id}/${virtual.file}`, file, related, key: virtual.key, range: request.range, head: request.head };
      worker.postMessage(message, [port]);
      return;
    }
    if (request.path === "" || request.path.endsWith("/")) {
      // A folder: its listing, as a web server's index page.
      const dir = request.path.replace(/\/$/, "");
      const names = [...(await this.subfolders(request.id, dir)).map((d) => `${d}/`), ...(await this.files(request.id, dir))];
      if (names.length === 0) {
        port.postMessage({ status: 404 });
        return;
      }
      const body = listingHtml(names).slice().buffer;
      port.postMessage({ status: 200, size: body.byteLength, start: 0, body: request.head ? undefined : body, contentType: "text/html" }, request.head ? [] : [body]);
      return;
    }
    const file = await this.file(request.id, request.path);
    if (file === undefined) {
      port.postMessage({ status: 404 });
      return;
    }
    const size = file.size;
    let start = 0;
    let end = size;
    const range = request.range;
    if (range?.suffix !== undefined) start = Math.max(0, size - range.suffix);
    else if (range !== undefined) {
      start = Math.min(range.start ?? 0, size);
      end = Math.min(range.end ?? size, size);
    }
    const body = request.head ? undefined : await file.slice(start, end).arrayBuffer();
    port.postMessage({ status: 200, size, start, body }, body ? [body] : []);
  }

  /**
   * The files a format reads beside a file, by path from the file's folder
   * (handles to them, nothing read); found on the first request for its
   * store and kept for the visit.
   */
  private related(id: string, path: string, format: VirtualFormat): Promise<Record<string, File>> {
    const key = `${id}/${path}`;
    let found = this.relatedFiles.get(key);
    if (found === undefined) {
      found = (async () => {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const paths = await format.related!(path, (folder) => this.files(id, folder));
        const out: Record<string, File> = {};
        await Promise.all(
          paths.map(async (relative) => {
            const resolved: string[] = [];
            for (const part of (dir === "" ? relative : `${dir}/${relative}`).split("/")) {
              if (part === "..") resolved.pop();
              else if (part !== "." && part !== "") resolved.push(part);
            }
            const file = await this.file(id, resolved.join("/"));
            if (file !== undefined) out[relative] = file;
          }),
        );
        return out;
      })();
      this.relatedFiles.set(key, found);
      found.catch(() => this.relatedFiles.delete(key));
    }
    return found;
  }

  /** The text of a JSON file in an entry, parsed; undefined when absent or not JSON. */
  private async json(id: string, path: string): Promise<any> {
    const file = await this.file(id, path);
    if (file === undefined) return undefined;
    try {
      return JSON.parse(await file.text());
    } catch {
      return undefined;
    }
  }

  /** The datasets in an entry: itself, or (for a folder of them) its sub-folders, a level down. */
  async detect(id: string): Promise<FoundDataset[]> {
    const entry = this.entries.get(id);
    if (entry === undefined) return [];
    if (entry.kind === "file") {
      const format = this.formatOf(entry.name);
      return format === undefined ? [] : [this.virtual(id, entry.name, format)];
    }
    const here = await this.detectAt(id, "", entry.name);
    if (here !== undefined) return [here];
    const subject = await this.freeSurferSubject(id, "");
    if (subject !== undefined) return subject;
    const inFolder = async (dir: string) => {
      const files = await this.files(id, dir);
      const out: FoundDataset[] = [];
      // Several files a format can collect: one dataset for them all first, and
      // each on its own only while there are few.
      const collected = new Set<VirtualFormat>();
      for (const format of this.formats) {
        const collect = format.collect;
        if (collect === undefined) continue;
        const count = files.filter((f) => format.pattern.test(f) && !f.startsWith("@all")).length;
        if (count < 2) continue;
        const path = `${dir === "" ? "" : `${dir}/`}@all${collect.extension}`;
        const folder = dir === "" ? entry.name : dir.split("/").pop()!;
        out.push({ ...this.virtual(id, path, format), name: `${folder} (${count} ${collect.label})` });
        if (count > 10) collected.add(format);
      }
      // Files another file's format reads with it (an edge list's node table) are not datasets of their own.
      const companions = new Set(files.flatMap((f) => this.formatOf(f)?.companion?.(f) ?? []));
      for (const f of files) {
        const format = this.formatOf(f);
        if (format !== undefined && !collected.has(format) && !companions.has(f)) out.push(this.virtual(id, dir === "" ? f : `${dir}/${f}`, format));
      }
      return out;
    };
    const found: FoundDataset[] = await inFolder("");
    for (const child of await this.children(id)) {
      const one = await this.detectAt(id, child, child);
      if (one !== undefined) found.push(one);
      else found.push(...((await this.freeSurferSubject(id, child)) ?? (await inFolder(child))));
    }
    return found;
  }

  /** A file read as a virtual store, as a dataset: the store under the file's own URL. */
  /**
   * A folder's files of a collecting format as one text file (`@all<ext>`
   * in the folder): each file's text after a `# @file <name>` line, in name
   * order.
   */
  private async collection(id: string, path: string, format: VirtualFormat): Promise<File | undefined> {
    const collect = format.collect;
    const name = path.split("/").pop()!;
    if (collect === undefined || name !== `@all${collect.extension}`) return undefined;
    const dir = path.slice(0, path.length - name.length).replace(/\/$/, "");
    const names = (await this.files(id, dir)).filter((f) => format.pattern.test(f) && !f.startsWith("@all")).sort();
    const parts: (string | Blob)[] = [];
    for (const n of names) {
      const file = await this.file(id, dir === "" ? n : `${dir}/${n}`);
      if (file !== undefined) parts.push(`# @file ${n}\n`, file, "\n");
    }
    return parts.length === 0 ? undefined : new File(parts, name);
  }

  private virtual(id: string, path: string, format: VirtualFormat): FoundDataset {
    const name = path.split("/").pop()!;
    // A label image (aseg, a BIDS dseg…) opens as a segmentation (images/open.ts reads it as labels).
    const kind = format.kind === "image" && LABEL_NAME.test(name) ? "segmentation" : format.kind;
    // A FreeSurfer surface's whole name is its pattern (lh.pial): keep it.
    // Surfaces in Freeview's colours; a Zarr Vectors layer is a segmentation from the start, so the colour is kept.
    // Their outlines on the sections opaque, as Freeview draws them (2-D opacity 1, not 0.5).
    const colour = /surface/i.test(format.format) ? surfaceColour(name) : undefined;
    const base = { source: format.source(this.urlOf(id, path)), name: name.replace(format.pattern, "") || name, format: format.format, path };
    return colour === undefined ? { ...base, kind } : { ...base, kind: "segmentation", layer: { segmentDefaultColor: colour, selectedAlpha: 1 } };
  }

  /**
   * A FreeSurfer subject (a folder with mri/ and surf/): its T1 (or orig,
   * brain), aparc+aseg (or aseg) as a segmentation, and the white and pial
   * surfaces, rather than every one of the dozens of files it holds.
   */
  private async freeSurferSubject(id: string, dir: string): Promise<FoundDataset[] | undefined> {
    const at = (sub: string) => (dir === "" ? sub : `${dir}/${sub}`);
    const children = await this.subfolders(id, dir);
    if (!children.includes("mri") || !children.includes("surf")) return undefined;
    const mri = await this.files(id, at("mri"));
    const surf = await this.files(id, at("surf"));
    const subject = dir === "" ? this.entries.get(id)?.name ?? "subject" : dir.split("/").pop()!;
    const out: FoundDataset[] = [];
    const add = (folder: string, file: string | undefined, kind?: string) => {
      if (file === undefined) return;
      const format = this.formatOf(file);
      if (format === undefined) return;
      const found = this.virtual(id, at(`${folder}/${file}`), format);
      out.push({ ...found, name: `${subject} ${found.name}`, kind: kind ?? found.kind });
    };
    add("mri", ["T1.mgz", "orig.mgz", "brain.mgz", "norm.mgz"].find((f) => mri.includes(f)));
    add("mri", ["aparc+aseg.mgz", "aseg.mgz"].find((f) => mri.includes(f)), "segmentation");
    for (const surface of ["lh.white", "rh.white", "lh.pial", "rh.pial"]) add("surf", surf.includes(surface) ? surface : undefined);
    return out.length > 0 ? out : undefined;
  }

  /** The names of the files in a folder of an entry ("" for the folder itself). */
  private async files(id: string, dir: string): Promise<string[]> {
    const entry = this.entries.get(id);
    if (entry === undefined) return [];
    if (entry.files !== undefined) {
      const prefix = dir === "" ? "" : `${dir}/`;
      return [...entry.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).map((p) => p.slice(prefix.length)).sort();
    }
    let handle = entry.handle;
    if (handle?.kind !== "directory" || entry.needsPermission) return [];
    try {
      for (const part of dir.split("/").filter(Boolean)) handle = await (handle as FileSystemDirectoryHandle).getDirectoryHandle(part);
      const out: string[] = [];
      for await (const [name, child] of (handle as unknown as { entries(): AsyncIterable<[string, Handle]> }).entries()) {
        if (child.kind === "file" && !name.startsWith(".")) out.push(name);
      }
      return out.sort();
    } catch {
      return [];
    }
  }

  private async detectAt(id: string, path: string, name: string): Promise<FoundDataset | undefined> {
    const at = (file: string) => (path === "" ? file : `${path}/${file}`);
    const url = this.urlOf(id, path === "" ? "" : `${path}/`);
    const stem = name.replace(/\.(ome\.zarr|zarr|zarrvectors|zv)$/i, "");
    const v3 = await this.json(id, at("zarr.json"));
    const v2 = v3 === undefined ? await this.json(id, at(".zattrs")) : undefined;
    const attributes = v3?.attributes ?? v2;
    if (attributes?.zarr_vectors !== undefined || /\.zarrvectors$/i.test(name)) {
      return { source: `${url}|zarr-vectors:`, name: stem, kind: "auto", format: "zarr-vectors store", path };
    }
    if ((attributes?.ome ?? attributes)?.multiscales !== undefined) {
      return { source: `zarr://${url}`, name: stem, kind: "image", format: "OME-Zarr image", path };
    }
    if (v3?.node_type === "array" || (await this.file(id, at(".zarray"))) !== undefined) {
      return { source: `zarr://${url}`, name: stem, kind: "image", format: "Zarr array", path };
    }
    const info = await this.json(id, at("info"));
    if (info?.["@type"] !== undefined || info?.scales !== undefined || info?.type !== undefined) {
      const kind = info.type === "segmentation" ? "segmentation" : info["@type"] === "neuroglancer_annotations_v1" ? "annotation" : info.type === "image" ? "image" : "auto";
      return { source: `precomputed://${url}`, name: stem, kind, format: "Neuroglancer precomputed", path };
    }
    return undefined;
  }

  /** The names of the folders in a folder of an entry ("" for the entry itself). */
  private async subfolders(id: string, dir: string): Promise<string[]> {
    if (dir === "") return this.children(id);
    const entry = this.entries.get(id);
    if (entry === undefined) return [];
    if (entry.files !== undefined) {
      const prefix = `${dir}/`;
      return [...new Set([...entry.files.keys()].filter((p) => p.startsWith(prefix) && p.slice(prefix.length).includes("/")).map((p) => p.slice(prefix.length).split("/")[0]))].sort();
    }
    let handle = entry.handle;
    if (handle?.kind !== "directory" || entry.needsPermission) return [];
    try {
      for (const part of dir.split("/").filter(Boolean)) handle = await (handle as FileSystemDirectoryHandle).getDirectoryHandle(part);
      const out: string[] = [];
      for await (const [name, child] of (handle as unknown as { entries(): AsyncIterable<[string, Handle]> }).entries()) {
        if (child.kind === "directory" && !name.startsWith(".")) out.push(name);
      }
      return out.sort();
    } catch {
      return [];
    }
  }

  private async children(id: string): Promise<string[]> {
    const entry = this.entries.get(id);
    if (entry === undefined) return [];
    if (entry.files !== undefined) {
      return [...new Set([...entry.files.keys()].filter((p) => p.includes("/")).map((p) => p.split("/")[0]))].sort();
    }
    const handle = entry.handle;
    if (handle?.kind !== "directory") return [];
    const out: string[] = [];
    for await (const [name, child] of (handle as unknown as { entries(): AsyncIterable<[string, Handle]> }).entries()) {
      if (child.kind === "directory" && !name.startsWith(".")) out.push(name);
    }
    return out.sort();
  }

  /**
   * Writes a file into an entry (asking, from a click, to edit the folder
   * the first time).  Throws when the folder cannot be written.
   */
  async write(id: string, path: string, data: BufferSource | Blob | string): Promise<void> {
    const entry = this.entries.get(id);
    const handle = entry?.handle as (Permissioned & FileSystemDirectoryHandle) | undefined;
    if (entry === undefined || handle === undefined || handle.kind !== "directory") throw new Error("only a folder opened from this computer (in Chrome or Edge) can be written");
    if ((await handle.queryPermission?.({ mode: "readwrite" })) !== "granted" && (await handle.requestPermission?.({ mode: "readwrite" })) !== "granted") {
      throw new Error(`not allowed to change ${entry.name}`);
    }
    const parts = path.split("/").filter(Boolean);
    let dir: FileSystemDirectoryHandle = handle;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await (file as unknown as { createWritable(): Promise<{ write(d: unknown): Promise<void>; close(): Promise<void> }> }).createWritable();
    await writable.write(data);
    await writable.close();
  }

  /** Whether an entry is a folder this browser can write into. */
  writable(id: string): boolean {
    const entry = this.entries.get(id);
    return entry?.handle?.kind === "directory";
  }
}

/** A path under a file read as a virtual store: the file, the key in its store, and its format. */
export function splitVirtual(path: string, formats: VirtualFormat[] = [NIFTI_FORMAT]): { file: string; key: string; format: VirtualFormat } | undefined {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; ++i) {
    const format = formats.find((f) => f.pattern.test(parts[i - 1]));
    if (format !== undefined) return { file: parts.slice(0, i).join("/"), key: parts.slice(i).join("/"), format };
  }
  return undefined;
}

/** Something dropped on the window: a handle where the browser gives one, and its files either way. */
export interface DroppedItem {
  name: string;
  folder: boolean;
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
  /** Its files by path (inside a folder: "folder/sub/file"). */
  files(): Promise<Map<string, File>>;
}

/**
 * What a drop event carries, read while the event lasts (the browser drops
 * access to the items once it returns): handles in Chrome and Edge, else
 * the older entry API, else plain files.
 */
export function collectDropped(transfer: DataTransfer): Promise<DroppedItem[]> {
  const pending: Promise<DroppedItem | undefined>[] = [];
  for (const item of [...transfer.items]) {
    if (item.kind !== "file") continue;
    const asHandle = (item as unknown as { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.();
    const entry = item.webkitGetAsEntry?.() ?? null;
    const file = item.getAsFile();
    pending.push(
      (async () => {
        const handle = ((await asHandle?.catch(() => null)) ?? undefined) as FileSystemFileHandle | FileSystemDirectoryHandle | undefined;
        const folder = handle?.kind === "directory" || entry?.isDirectory === true;
        const name = handle?.name ?? entry?.name ?? file?.name ?? "dropped";
        const files = async () => {
          if (handle !== undefined) return handleFiles(handle, handle.kind === "directory" ? `${handle.name}/` : "");
          if (entry?.isDirectory) return entryFiles(entry as FileSystemDirectoryEntry, `${entry.name}/`);
          return new Map(file === null ? [] : [[file.name, file]]);
        };
        return { name, folder, handle, files };
      })(),
    );
  }
  return Promise.all(pending).then((all) => all.filter((d): d is DroppedItem => d !== undefined));
}

async function handleFiles(handle: FileSystemFileHandle | FileSystemDirectoryHandle, prefix: string): Promise<Map<string, File>> {
  const out = new Map<string, File>();
  if (handle.kind === "file") {
    out.set(prefix + handle.name, await handle.getFile());
    return out;
  }
  for await (const child of (handle as unknown as { values(): AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle> }).values()) {
    for (const [path, file] of await handleFiles(child, child.kind === "directory" ? `${prefix}${child.name}/` : prefix)) out.set(path, file);
  }
  return out;
}

/** Several dropped handles' files, as one folder of them (as when they were dropped). */
async function groupFiles(handles: Handle[]): Promise<Map<string, File>> {
  const files = new Map<string, File>();
  for (const h of handles as (FileSystemFileHandle | FileSystemDirectoryHandle)[]) {
    for (const [path, file] of await handleFiles(h, h.kind === "directory" ? `${h.name}/` : "")) files.set(path, file);
  }
  return files;
}

async function entryFiles(dir: FileSystemDirectoryEntry, prefix: string): Promise<Map<string, File>> {
  const out = new Map<string, File>();
  const reader = dir.createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) {
      if (child.isDirectory) for (const [p, f] of await entryFiles(child as FileSystemDirectoryEntry, `${prefix}${child.name}/`)) out.set(p, f);
      else out.set(prefix + child.name, await new Promise<File>((resolve, reject) => (child as FileSystemFileEntry).file(resolve, reject)));
    }
  }
  return out;
}

/** A folder's files from a file input, keyed by their path inside it. */
function stripFolder(files: Map<string, File>): Map<string, File> {
  const out = new Map<string, File>();
  for (const [path, file] of files) out.set(path.slice(path.indexOf("/") + 1), file);
  return out;
}

function pickWithInput(folder: boolean, extensions: string[]): Promise<Map<string, File> | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (folder) input.webkitdirectory = true;
    else input.accept = [...new Set(extensions.map((e) => e.replace(/^.*(\.[^.]+)$/, "$1")))].join(",");
    input.addEventListener("change", () => {
      const files = new Map<string, File>();
      for (const file of input.files ?? []) files.set(file.webkitRelativePath || file.name, file);
      resolve(files.size ? files : undefined);
    });
    input.addEventListener("cancel", () => resolve(undefined));
    input.click();
  });
}
