/*
 * The app's service worker, built to sw.js beside the page (vite.config.ts).
 * Two jobs:
 *
 * - <app>/local/<id>/<path>: data on this computer.  The page that picked
 *   the folder or file holds it and reads it; this worker asks it, so the
 *   files never leave the computer and Neuroglancer (and its workers) read
 *   them like any other URL, with ranges.  Links to local data work only
 *   while that page is open.  Under a NIfTI (TIFF, MGH, ...) file's own URL
 *   the page answers with a Zarr store made from the file (virtual Zarr).
 *
 * - <app>/virtual/<page>/<view>/...: images computed by chunkmirage's
 *   browser engine (src/virtual/computed.ts), relayed to the page that
 *   serves them by chunkmirage's own relay, a chunk's body streamed once
 *   computed and the work dropped when the viewer stops waiting for it.
 *
 * - <app>/gcs-google/<bucket>/<object>: Cloud Storage read with the Google
 *   sign-in, for the engine's reader (a `gs+google://` source in a
 *   pipeline): fetched through the JSON API with the token of the bucket's
 *   account, from the tokens the page gives this worker (`google-tokens`:
 *   the default account's, and one per sign-in rule naming an account; the
 *   longest rule prefix wins), ranges passed on.  The tokens are kept in
 *   this worker's memory only: when the browser has stopped it and started
 *   it again (it does so with an idle worker), or Google answers 401, it
 *   asks the open tabs for them again (`google-tokens-ask`).
 *
 * - The app itself, so it opens offline once it has been opened online:
 *   its page and startup code are kept when the worker is installed (the
 *   list the build writes in, `__SW_PRECACHE__`), the other files of the
 *   build as they are first used.  The page comes from the network when it
 *   can, so a new build is seen at once; the files the build named by their
 *   contents come from the cache first.  Data is never kept here.
 *
 * Each of these is answered only under the app's own folder (the worker's
 * scope).  The worker carries its build's version: a new one takes over at
 * once (skipWaiting), drops the caches of older versions when active, and
 * tells the pages its version (`sw-version`).
 */
import { relay } from "chunkmirage-web/relay";
import { type GoogleTokenTable, tokenFromTable } from "./core/sign_in_rules.js";
import { ask, cacheName, prefixesOf, parseRange, type Range, routeOf, shellPageKey, shellRequest, staleCaches } from "./sw_parts.js";

declare const self: ServiceWorkerGlobalScope;
/** This build's version (vite.config.ts): the package's version and when it was built. */
declare const __SW_VERSION__: string;
const VERSION = typeof __SW_VERSION__ === "string" ? __SW_VERSION__ : "dev";
/** The app's page and startup files, relative to the scope (none from the dev server). */
declare const __SW_PRECACHE__: string[];
const PRECACHE = typeof __SW_PRECACHE__ === "object" ? __SW_PRECACHE__ : [];
const SHELL = cacheName(VERSION);

const PREFIXES = prefixesOf(self.registration.scope);
const PREFIX = PREFIXES.local;
const GOOGLE_PREFIX = PREFIXES.google;
/** The Google accounts' access tokens, from the page (none: signed out). */
let googleTokens: GoogleTokenTable = { default: null, rules: [] };
/** Whether a page has given this worker its tokens since it started. */
let tokensGiven = false;
/** A request to the pages for their tokens, under way. */
let askingForTokens: Promise<void> | undefined;
/** The page (client id) that holds each picked folder or file. */
const owners = new Map<string, string>();
/** The tab last in use, which computed images are asked of first: every tab can compute them, and one should. */
let active: string | undefined;

self.addEventListener("install", (event) => {
  void self.skipWaiting();
  // Each file on its own: one that fails (a flaky network) leaves the rest kept and the worker installed.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await Promise.allSettled(PRECACHE.map((path) => cache.add(new URL(path, self.registration.scope).href)));
    })(),
  );
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      // The caches of older versions of this worker go; others' are left alone.
      for (const name of staleCaches(await caches.keys(), VERSION)) await caches.delete(name);
      await self.clients.claim();
      for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "sw-version", version: VERSION });
    })(),
  ),
);

self.addEventListener("message", (event) => {
  const data = event.data as { type?: string; id?: string } | undefined;
  const source = event.source as Client | null;
  if (data?.type === "local-register" && source && data.id !== undefined) owners.set(data.id, source.id);
  if (data?.type === "local-claim") event.waitUntil(self.clients.claim());
  if (data?.type === "ngp-active" && source) active = source.id;
  if (data?.type === "sw-version") (event.ports[0] ?? source)?.postMessage({ type: "sw-version", version: VERSION });
  if (data?.type === "google-tokens") {
    googleTokens = (data as { tokens?: GoogleTokenTable }).tokens ?? { default: null, rules: [] };
    tokensGiven = true;
  }
});

/** How long a page may take over one read: a large .nii.gz is decompressed on its first. */
const READ_TIMEOUT = 10 * 60 * 1000;

interface Answer {
  status: number;
  message?: string;
  body?: ArrayBuffer | Uint8Array;
  size?: number;
  start?: number;
  contentType?: string;
}

/*
 * Pages are asked with `ask` (./sw_parts.ts).  A local request names its
 * file `file`, not `path`: chunkmirage's page end (routes.ts) takes any
 * message with a `path` for one of its own and declines it.
 */

/** The page holding `id`: the one that registered it, or (after this worker restarted) the one that says so. */
async function owner(id: string): Promise<Client | undefined> {
  const known = owners.get(id);
  if (known !== undefined) {
    const client = await self.clients.get(known);
    if (client) return client;
    owners.delete(id);
  }
  for (const client of await self.clients.matchAll({ type: "window" })) {
    // A page busy drawing can take a while to answer.
    if ((await ask<boolean>(client, { type: "local-has", id }, 10_000)) === true) {
      owners.set(id, client.id);
      return client;
    }
  }
  return undefined;
}

async function read(id: string, file: string, range: Range | undefined, head: boolean): Promise<Answer> {
  const client = await owner(id);
  if (client === undefined) return { status: 410 };
  const answer = await ask<Answer>(client, { type: "local-read", id, file, range, head }, READ_TIMEOUT);
  return answer ?? { status: 504, message: "The page holding this data did not answer in time." };
}

async function local(request: Request, url: URL): Promise<Response> {
  const method = request.method;
  const rest = url.pathname.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  const id = slash === -1 ? rest : rest.slice(0, slash);
  const file = slash === -1 ? "" : decodeURIComponent(rest.slice(slash + 1));
  // Neuroglancer lists a folder two ways at once: its index page, and S3's
  // ListObjects on what looks like the bucket (<app>/local/?list-type=2).
  // Local data answers the first; the second is not a dataset that has gone.
  if (id === "" && url.searchParams.has("list-type")) {
    return new Response("Local folders are listed by their index pages.", { status: 404, headers: { "access-control-allow-origin": "*" } });
  }
  const range = parseRange(request.headers.get("range"));
  const answer = await read(id, file, range, method === "HEAD");
  const headers: Record<string, string> = { "access-control-allow-origin": "*", "cache-control": "no-store" };
  if (answer.status === 410) return new Response("This local data is not open in any tab. Open it again (Layers › Add data › Local file or folder…).", { status: 410, headers });
  if (answer.status !== 200) return new Response(answer.message ?? null, { status: answer.status, headers });
  const { body, size, start = 0 } = answer;
  headers["accept-ranges"] = "bytes";
  headers["content-type"] = answer.contentType ?? "application/octet-stream";
  if (range !== undefined && size !== undefined) {
    const end = start + (body ? body.byteLength : 0);
    if (start >= size && size > 0) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    headers["content-range"] = `bytes ${start}-${Math.max(start, end - 1)}/${size}`;
    headers["content-length"] = String(end - start);
    return new Response(method === "HEAD" ? null : (body as BodyInit | undefined), { status: 206, headers });
  }
  headers["content-length"] = String(size ?? (body ? body.byteLength : 0));
  return new Response(method === "HEAD" ? null : (body as BodyInit | undefined), { status: 200, headers });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const route = routeOf(url.pathname, PREFIXES);
  const reads = request.method === "GET" || request.method === "HEAD";
  if (route === "google" && reads) event.respondWith(google(request, url));
  else if (route === "local" && reads) event.respondWith(local(request, url));
  else if (route === "virtual") event.respondWith(computed(request, url));
  else if (request.method === "GET" && !request.headers.has("range")) {
    const shell = shellRequest(url, self.registration.scope, request.mode);
    if (shell === "page") event.respondWith(page(request, url));
    else if (shell === "asset") event.respondWith(asset(request));
  }
});

/** The app's page: from the network, kept; the kept copy when the network fails. */
async function page(request: Request, url: URL): Promise<Response> {
  const key = shellPageKey(url, self.registration.scope);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      void caches.open(SHELL).then((cache) => cache.put(key, copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const kept = await caches.match(key);
    if (kept !== undefined) return kept;
    throw error;
  }
}

/** A file of the build: the kept copy, else from the network and kept. */
async function asset(request: Request): Promise<Response> {
  const kept = await caches.match(request, { ignoreSearch: true });
  if (kept !== undefined) return kept;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const copy = response.clone();
    void caches.open(SHELL).then((cache) => cache.put(request, copy)).catch(() => {});
  }
  return response;
}

/**
 * The tokens of the open tabs (the one in use first; the first that has
 * any), asked once at a time; nothing is kept but in this worker's memory.
 */
function askForTokens(): Promise<void> {
  askingForTokens ??= (async () => {
    const windows = await self.clients.matchAll({ type: "window" });
    const ordered = [...windows.filter((c) => c.id === active), ...windows.filter((c) => c.id !== active)];
    for (const client of ordered) {
      const tokens = await ask<GoogleTokenTable>(client, { type: "google-tokens-ask" }, 5_000);
      if (tokens === undefined || tokens === null) continue;
      if (tokens.default !== null || (tokens.rules ?? []).length > 0) {
        googleTokens = tokens;
        tokensGiven = true;
        return;
      }
    }
  })().finally(() => (askingForTokens = undefined));
  return askingForTokens;
}

/** A Cloud Storage object read with its bucket's Google account (401 until a page has that account's token). */
async function google(request: Request, url: URL): Promise<Response> {
  const rest = decodeURIComponent(url.pathname.slice(GOOGLE_PREFIX.length));
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const object = slash === -1 ? "" : rest.slice(slash + 1);
  // Started again by the browser since the page gave its tokens: ask for them.
  if (!tokensGiven) await askForTokens();
  const fetchWith = (token: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const range = request.headers.get("range");
    if (range !== null) headers.range = range;
    return fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`, { method: request.method, headers });
  };
  const googleToken = tokenFromTable(googleTokens, bucket, object);
  if (googleToken === null) return new Response("Sign in with Google (Settings → Sign-in) to read this bucket (with the account its sign-in rule names).", { status: 401 });
  const response = await fetchWith(googleToken);
  if (response.status !== 401) return response;
  // An expired token: the page may have a newer one.
  await askForTokens();
  const again = tokenFromTable(googleTokens, bucket, object);
  return again !== null && again !== googleToken ? fetchWith(again) : response;
}

/**
 * A computed image's request, relayed to a page: the tab in use first, so
 * one tab computes it, then any (a page of chunkmirage's own ids, or the
 * tab in use closed).
 */
async function computed(request: Request, url: URL): Promise<Response> {
  if (url.pathname.startsWith(`${PREFIXES.virtual}ngp/`) && active !== undefined) {
    const first = await relay(request.clone(), { pick: (pages) => pages.filter((p) => p.id === active) });
    if (first.status !== 503) return first;
  }
  return relay(request);
}
