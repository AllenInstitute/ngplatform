/**
 * The service worker's parts that need no worker (src/sw.ts), kept apart so
 * they are tested in Node: which of its jobs a request is for, a Range
 * header read, the caches of other versions, and a question put to a page
 * that is given up after a while, its timer cleared once answered.
 */

/** The paths under the app (its scope) that the worker answers. */
export interface Prefixes {
  local: string;
  google: string;
  virtual: string;
}

/** The worker's paths under the app at `scope` (the page's folder). */
export function prefixesOf(scope: string): Prefixes {
  const path = (sub: string) => new URL(sub, scope).pathname;
  return { local: path("./local/"), google: path("./gcs-google/"), virtual: path("./virtual/") };
}

/** Which of the worker's jobs a path is for, if any: each only under the app's own folder. */
export function routeOf(pathname: string, prefixes: Prefixes): keyof Prefixes | undefined {
  if (pathname.startsWith(prefixes.google)) return "google";
  if (pathname.startsWith(prefixes.local)) return "local";
  if (pathname.startsWith(prefixes.virtual)) return "virtual";
  return undefined;
}

export interface Range {
  start?: number;
  end?: number;
  suffix?: number;
}

/** A Range header of one range (`bytes=a-b`, `bytes=a-`, `bytes=-n`); undefined for none or any other. */
export function parseRange(header: string | null): Range | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  if (m[1] === "") return { suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === "" ? undefined : Number(m[2]) + 1 };
}

/** What the worker's caches are named by: this, then its version. */
export const CACHE_PREFIX = "ngplatform-sw-";

/** The cache this version of the worker keeps. */
export const cacheName = (version: string): string => `${CACHE_PREFIX}${version}`;

/** The caches of other versions of the worker, to drop once this one is active (others' caches are left alone). */
export function staleCaches(names: string[], version: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== cacheName(version));
}

/**
 * Asks a page over a channel of its own; undefined when it does not answer
 * in `timeout` ms.  The timer is cleared and the channel closed once it
 * answers or the time is up, so nothing is left running.
 */
export function ask<T>(client: { postMessage(message: unknown, transfer: Transferable[]): void }, request: Record<string, unknown>, timeout: number): Promise<T | undefined> {
  const channel = new MessageChannel();
  const answer = new Promise<T | undefined>((resolve) => {
    const done = (value: T | undefined) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeout);
    channel.port1.onmessage = (e) => done(e.data as T);
  });
  client.postMessage(request, [channel.port2]);
  return answer;
}

// ---------------------------------------------------------------- the app shell

/** What a request under the app is, for the worker's cache of the app itself. */
export type ShellRequest = "page" | "asset";

/**
 * Whether a request is for the app itself, kept so it opens offline: its
 * page (`./`, `./index.html`, `./neuroglancer.html`; fetched from the
 * network first, the copy kept used when that fails) or a file the build
 * named by its contents (`./assets/…`, the fonts, the icon; never changed
 * under a name, so a kept copy is used first).  Anything else (data, the
 * worker's own jobs, the dev server's modules) is left to the network.
 */
export function shellRequest(url: URL, scope: string, mode: string): ShellRequest | undefined {
  const base = new URL(scope);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return undefined;
  const rest = url.pathname.slice(base.pathname.length);
  if (mode === "navigate") return rest === "" || rest === "index.html" || rest === "neuroglancer.html" ? "page" : undefined;
  if (/^assets\/[^/]+$/.test(rest) && !rest.endsWith(".map")) return "asset";
  if (/^fonts\/[^/]+$/.test(rest) || rest === "favicon.svg") return "asset";
  return undefined;
}

/** The address a page is kept under: `./` and `./index.html` are the same page, whatever their query. */
export function shellPageKey(url: URL, scope: string): string {
  const rest = url.pathname.slice(new URL(scope).pathname.length);
  return new URL(rest === "" ? "index.html" : rest, scope).href;
}

/** A file of the build, as Rollup describes it (the parts read here). */
export interface BuiltFile {
  fileName: string;
  type: "chunk" | "asset";
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  facadeModuleId?: string | null;
  imports?: string[];
  css?: string[];
}

/** Neuroglancer's workers, which every viewer starts. */
const VIEWER_WORKERS = /^assets\/(chunk_worker|async_worker|chunk_worker\.bundle|async_computation\.bundle)-[^/]+\.js$/;

/**
 * The files the worker keeps when it is installed, so the app opens offline
 * after one visit: the page, the code it starts with (the main entry, the
 * plugin it waits for, everything they import, their styles) and
 * Neuroglancer's workers.  The rest (plugins' code, decoders) is kept as it
 * is first used.  Paths relative to the app's folder.
 */
export function shellFiles(files: BuiltFile[], extra: string[] = []): string[] {
  const byName = new Map(files.map((f) => [f.fileName, f]));
  const keep = new Set<string>(["./", "index.html", ...extra]);
  const visit = (name: string) => {
    if (keep.has(name)) return;
    const file = byName.get(name);
    if (file === undefined) return;
    keep.add(name);
    for (const css of file.css ?? []) keep.add(css);
    for (const next of file.imports ?? []) visit(next);
  };
  for (const f of files) {
    if (f.type !== "chunk") continue;
    if (f.isEntry && /(^|\/)index\.html$/.test(f.facadeModuleId ?? "")) visit(f.fileName);
    // The data type plugin main.ts waits for (vite.config.ts preloads it too).
    if (f.isDynamicEntry && /zarr-vectors\/src\/register_default\.ts$/.test(f.facadeModuleId ?? "")) visit(f.fileName);
  }
  for (const f of files) if (VIEWER_WORKERS.test(f.fileName)) keep.add(f.fileName);
  return [...keep].sort();
}
