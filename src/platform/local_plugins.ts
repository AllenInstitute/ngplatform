/**
 * Plugins from this computer, for writing and trying one without building
 * the app: a JavaScript tool plugin (a module exporting `manifest` and
 * `plugin`, or a folder with manifest.json and the module it names as
 * `main`) or a Python file (run in the Python tab's interpreter, where
 * `@ngp.command(...)` adds palette commands).  "Reload" reads the file again,
 * so a plugin can be edited and reloaded with the workspace open.
 *
 * Where the browser can (Chrome, Edge), the file is remembered between
 * visits; reading it again then needs one click to allow.
 */
import type { Manifest, PluginModule } from "../sdk/types.js";
import type { PluginHost } from "./plugin_host.js";

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;
type Permissioned = Handle & {
  queryPermission?(o: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "read" }): Promise<PermissionState>;
};

export interface LocalPlugin {
  key: string;
  /** The file or folder name. */
  name: string;
  kind: "js" | "python";
  /** The plugin's id once loaded (JavaScript plugins). */
  id?: string;
  status: "loaded" | "needs-permission" | "failed" | "loading";
  error?: string;
  loadedAt?: Date;
}

interface Stored {
  key: string;
  name: string;
  kind: "js" | "python";
  handle?: Handle;
}

const DB = "ngplatform";
const STORE = "localPlugins";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "key" });
      if (!request.result.objectStoreNames.contains("localData")) request.result.createObjectStore("localData", { keyPath: "id" });
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

export interface LocalPluginHooks {
  host: PluginHost;
  /** Runs a Python plugin (and removes what an earlier run of it added). */
  runPython(owner: string, source: string): Promise<void>;
  forgetPython(owner: string): void;
  log(message: string, level?: "info" | "ok" | "error"): void;
}

export class LocalPlugins {
  private readonly entries = new Map<string, { stored: Stored; state: LocalPlugin; files?: Map<string, File> }>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly hooks: LocalPluginHooks) {}

  static get canRemember(): boolean {
    return "showOpenFilePicker" in window;
  }

  list(): LocalPlugin[] {
    return [...this.entries.values()].map((e) => ({ ...e.state }));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** The plugins remembered from earlier visits: loaded where reading is still allowed. */
  async restore(): Promise<void> {
    let stored: Stored[] = [];
    try {
      stored = await idb<Stored[]>("readonly", (s) => s.getAll() as IDBRequest<Stored[]>);
    } catch {
      return;
    }
    for (const item of stored) {
      this.entries.set(item.key, { stored: item, state: { key: item.key, name: item.name, kind: item.kind, status: "needs-permission" } });
      const permission = await (item.handle as Permissioned | undefined)?.queryPermission?.({ mode: "read" });
      if (permission === "granted") void this.reload(item.key);
    }
    this.changed();
  }

  /** Asks for a plugin file (or folder) and loads it. */
  async add(folder = false): Promise<void> {
    let stored: Stored;
    let files: Map<string, File> | undefined;
    const picker = window as unknown as {
      showOpenFilePicker?(o: unknown): Promise<FileSystemFileHandle[]>;
      showDirectoryPicker?(o?: unknown): Promise<FileSystemDirectoryHandle>;
    };
    const key = crypto.randomUUID();
    try {
      if (folder && picker.showDirectoryPicker) {
        const handle = await picker.showDirectoryPicker({ id: "ngplatform-plugin", mode: "read" });
        stored = { key, name: handle.name, kind: "js", handle };
      } else if (!folder && picker.showOpenFilePicker) {
        const [handle] = await picker.showOpenFilePicker({
          id: "ngplatform-plugin",
          types: [{ description: "Plugin (JavaScript module or Python)", accept: { "text/javascript": [".js", ".mjs"], "text/x-python": [".py"] } }],
        });
        stored = { key, name: handle.name, kind: handle.name.endsWith(".py") ? "python" : "js", handle };
      } else {
        files = await pickWithInput(folder);
        if (files === undefined) return;
        const first = [...files.keys()][0];
        const name = folder ? first.split("/")[0] : first;
        stored = { key, name, kind: name.endsWith(".py") ? "python" : "js" };
      }
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return;
      throw e;
    }
    this.entries.set(key, { stored, files, state: { key, name: stored.name, kind: stored.kind, status: "loading" } });
    if (stored.handle !== undefined) await idb("readwrite", (s) => s.put(stored)).catch(() => {});
    await this.reload(key);
  }

  /** Reads the plugin's files again and runs the new code in place of the old. */
  async reload(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    const { stored, state } = entry;
    state.status = "loading";
    state.error = undefined;
    this.changed();
    try {
      const handle = stored.handle as Permissioned | undefined;
      if (handle !== undefined && (await handle.queryPermission?.({ mode: "read" })) !== "granted") {
        if ((await handle.requestPermission?.({ mode: "read" })) !== "granted") {
          state.status = "needs-permission";
          this.changed();
          return;
        }
      }
      const read = async (path: string): Promise<string | undefined> => {
        if (entry.files !== undefined) {
          const file = entry.files.get(path) ?? entry.files.get(`${stored.name}/${path}`);
          return file?.text();
        }
        if (handle === undefined) return undefined;
        if (handle.kind === "file") return path === stored.name ? (await handle.getFile()).text() : undefined;
        let dir = handle as FileSystemDirectoryHandle;
        const parts = path.split("/").filter(Boolean);
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        try {
          return await (await (await dir.getFileHandle(parts[parts.length - 1])).getFile()).text();
        } catch {
          return undefined;
        }
      };

      if (stored.kind === "python") {
        const source = await read(stored.name);
        if (source === undefined) throw new Error(`cannot read ${stored.name}`);
        await this.hooks.runPython(stored.name, source);
      } else {
        const isFolder = handle?.kind === "directory" || (entry.files !== undefined && [...entry.files.keys()][0].includes("/"));
        let manifest: Manifest | undefined;
        let source: string | undefined;
        if (isFolder) {
          const text = await read("manifest.json");
          if (text === undefined) throw new Error("the folder has no manifest.json");
          manifest = JSON.parse(text) as Manifest;
          source = await read(manifest.main ?? "plugin.js");
          if (source === undefined) throw new Error(`the folder has no ${manifest.main ?? "plugin.js"}`);
        } else {
          source = await read(stored.name);
          if (source === undefined) throw new Error(`cannot read ${stored.name}`);
        }
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        let module: { manifest?: Manifest; plugin?: PluginModule; default?: PluginModule };
        try {
          module = await import(/* @vite-ignore */ url);
        } finally {
          URL.revokeObjectURL(url);
        }
        manifest ??= module.manifest;
        const plugin = module.plugin ?? module.default;
        if (manifest === undefined) throw new Error("no manifest: export one as `manifest`, or put manifest.json beside it");
        if (plugin === undefined || typeof plugin.activate !== "function") throw new Error("no plugin: export one as `plugin` with activate(ctx)");
        if (manifest.kind !== "tool") throw new Error("only tool plugins load from this computer; a data type needs building into the app");
        if (state.id !== undefined) await this.hooks.host.unregister(state.id);
        if (this.hooks.host.list().some((r) => r.manifest.id === manifest.id)) throw new Error(`a plugin with the id ${manifest.id} is already loaded`);
        this.hooks.host.register(manifest, async () => plugin, { enabled: true });
        state.id = manifest.id;
        await this.hooks.host.activate(manifest.id);
      }
      state.status = "loaded";
      state.loadedAt = new Date();
      this.hooks.log(`Loaded the local plugin ${stored.name}.`, "ok");
    } catch (e) {
      state.status = "failed";
      state.error = (e as Error).message;
      this.hooks.log(`The local plugin ${stored.name} did not load: ${state.error}`, "error");
    }
    this.changed();
  }

  async remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    if (entry.state.id !== undefined) await this.hooks.host.unregister(entry.state.id);
    if (entry.stored.kind === "python") this.hooks.forgetPython(entry.stored.name);
    this.entries.delete(key);
    await idb("readwrite", (s) => s.delete(key)).catch(() => {});
    this.changed();
  }
}

/** The fallback where there is no file picker API: a file input (read once; Reload asks again). */
function pickWithInput(folder: boolean): Promise<Map<string, File> | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (folder) input.webkitdirectory = true;
    else input.accept = ".js,.mjs,.py";
    input.addEventListener("change", () => {
      const files = new Map<string, File>();
      for (const file of input.files ?? []) files.set(file.webkitRelativePath || file.name, file);
      resolve(files.size ? files : undefined);
    });
    input.addEventListener("cancel", () => resolve(undefined));
    input.click();
  });
}
