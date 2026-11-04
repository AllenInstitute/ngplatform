/**
 * Plugins added here rather than built into the app: from this computer,
 * for writing and trying one without building the app, or from a URL.
 *
 * From this computer: a JavaScript tool plugin (a module exporting
 * `manifest` and `plugin`, or a folder with manifest.json and the module it
 * names as `main`) or a Python file (run in the Python tab's interpreter,
 * where `@ngp.command(...)` adds palette commands).  "Reload" reads the file
 * again, so a plugin can be edited and reloaded with the workspace open.
 * Where the browser can (Chrome, Edge), the file is remembered between
 * visits; reading it again then needs one click to allow.
 *
 * From a URL: a manifest.json (its `main` beside it) or a JavaScript module,
 * served with CORS.  Nothing runs until the person agrees, after seeing the
 * manifest where there is one; the URL and that consent are remembered, and
 * the plugin loads again on the next visit.
 */
import { idbRequest } from "../core/idb.js";
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
  /** Where it was added from, for plugins from a URL. */
  url?: string;
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
  /** A plugin from a URL: its manifest.json or module. */
  url?: string;
}

/** What the person is asked about before a plugin from a URL first runs. */
export interface UrlPluginOffer {
  url: string;
  /** From its manifest.json; none for a bare module (its manifest is in its code). */
  manifest?: Manifest;
}

/** A plugin URL as given, made absolute; only https (or http on this computer). */
export function pluginUrl(text: string, base = globalThis.location?.href): URL {
  const url = new URL(text.trim(), base);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("a plugin URL must be https:// (or http:// on this computer)");
  return url;
}

/** A plugin's manifest.json, checked for what the host needs before anything runs. */
export function readManifestJson(text: string): Manifest {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(text) as Manifest;
  } catch {
    throw new Error("the manifest is not JSON");
  }
  for (const key of ["id", "name", "version", "kind"] as const) {
    if (typeof manifest[key] !== "string" || manifest[key] === "") throw new Error(`the manifest has no ${key}`);
  }
  return manifest;
}

const isManifestUrl = (url: URL) => /\.json$/i.test(url.pathname);

const idb = <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) => idbRequest<T>("localPlugins", mode, work);

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
      this.entries.set(item.key, { stored: item, state: { key: item.key, name: item.name, kind: item.kind, url: item.url, status: "needs-permission" } });
      // Agreed to when it was added.
      if (item.url !== undefined) {
        void this.reload(item.key);
        continue;
      }
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

  /**
   * Adds a plugin from a URL: reads its manifest (running nothing), asks
   * `agree` with what it found, and loads it only if the answer is yes.
   */
  async addUrl(text: string, agree: (offer: UrlPluginOffer) => Promise<boolean>): Promise<void> {
    const url = pluginUrl(text);
    let manifest: Manifest | undefined;
    if (isManifestUrl(url)) {
      const response = await fetch(url, { cache: "no-cache" });
      if (!response.ok) throw new Error(`${url.href}: ${response.status} ${response.statusText}`);
      manifest = readManifestJson(await response.text());
      if (manifest.kind !== "tool") throw new Error("only tool plugins load from a URL; a data type needs building into the app");
    }
    if ([...this.entries.values()].some((e) => e.stored.url === url.href)) throw new Error("that plugin is already added");
    if (!(await agree({ url: url.href, manifest }))) return;
    const key = crypto.randomUUID();
    const name = manifest?.name ?? (url.pathname.split("/").pop() || url.host);
    const stored: Stored = { key, name, kind: "js", url: url.href };
    this.entries.set(key, { stored, state: { key, name, kind: "js", url: url.href, status: "loading" } });
    await idb("readwrite", (s) => s.put(stored)).catch(() => {});
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

      if (stored.url !== undefined) {
        // Fetched afresh: a module URL is otherwise cached for the page's life.
        const fresh = (u: URL) => {
          const copy = new URL(u.href);
          copy.searchParams.set("ngp-load", String(Date.now()));
          return copy.href;
        };
        const url = new URL(stored.url);
        let manifest: Manifest | undefined;
        let main = url;
        if (isManifestUrl(url)) {
          const response = await fetch(url, { cache: "no-cache" });
          if (!response.ok) throw new Error(`${url.href}: ${response.status} ${response.statusText}`);
          manifest = readManifestJson(await response.text());
          main = new URL(manifest.main ?? "plugin.js", url);
        }
        const module = (await import(/* @vite-ignore */ fresh(main))) as { manifest?: Manifest; plugin?: PluginModule; default?: PluginModule };
        await this.registerModule(state, manifest ?? module.manifest, module.plugin ?? module.default, "a URL");
      } else if (stored.kind === "python") {
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
        await this.registerModule(state, manifest ?? module.manifest, module.plugin ?? module.default, "this computer");
      }
      state.status = "loaded";
      state.loadedAt = new Date();
      this.hooks.log(`Loaded the ${stored.url ? "" : "local "}plugin ${stored.name}.`, "ok");
    } catch (e) {
      state.status = "failed";
      state.error = (e as Error).message;
      this.hooks.log(`The ${stored.url ? "" : "local "}plugin ${stored.name} did not load: ${state.error}`, "error");
    }
    this.changed();
  }

  /** Registers and activates a loaded tool plugin in place of its earlier load. */
  private async registerModule(state: LocalPlugin, manifest: Manifest | undefined, plugin: PluginModule | undefined, from: string): Promise<void> {
    if (manifest === undefined) throw new Error("no manifest: export one as `manifest`, or put manifest.json beside it");
    if (plugin === undefined || typeof plugin.activate !== "function") throw new Error("no plugin: export one as `plugin` with activate(ctx)");
    if (manifest.kind !== "tool") throw new Error(`only tool plugins load from ${from}; a data type needs building into the app`);
    if (state.id !== undefined) await this.hooks.host.unregister(state.id);
    if (this.hooks.host.list().some((r) => r.manifest.id === manifest.id)) throw new Error(`a plugin with the id ${manifest.id} is already loaded`);
    this.hooks.host.register(manifest, async () => plugin, { enabled: true });
    state.id = manifest.id;
    await this.hooks.host.activate(manifest.id);
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
