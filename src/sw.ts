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
 *   longest rule prefix wins), ranges passed on.
 */
import { relay } from "chunkmirage-web/relay";
import { type GoogleTokenTable, tokenFromTable } from "./core/sign_in_rules.js";

declare const self: ServiceWorkerGlobalScope;

const PREFIX = new URL("./local/", self.registration.scope).pathname;
const GOOGLE_PREFIX = new URL("./gcs-google/", self.registration.scope).pathname;
/** The Google accounts' access tokens, from the page (none: signed out). */
let googleTokens: GoogleTokenTable = { default: null, rules: [] };
/** The page (client id) that holds each picked folder or file. */
const owners = new Map<string, string>();
/** The tab last in use, which computed images are asked of first: every tab can compute them, and one should. */
let active: string | undefined;

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const data = event.data as { type?: string; id?: string } | undefined;
  const source = event.source as Client | null;
  if (data?.type === "local-register" && source && data.id !== undefined) owners.set(data.id, source.id);
  if (data?.type === "local-claim") event.waitUntil(self.clients.claim());
  if (data?.type === "ngp-active" && source) active = source.id;
  if (data?.type === "google-tokens") googleTokens = (data as { tokens?: GoogleTokenTable }).tokens ?? { default: null, rules: [] };
});

/** How long a page may take over one read: a large .nii.gz is decompressed on its first. */
const READ_TIMEOUT = 10 * 60 * 1000;

interface Range {
  start?: number;
  end?: number;
  suffix?: number;
}

interface Answer {
  status: number;
  message?: string;
  body?: ArrayBuffer | Uint8Array;
  size?: number;
  start?: number;
  contentType?: string;
}

/**
 * Asks a page.  A local request names its file `file`, not `path`:
 * chunkmirage's page end (routes.ts) takes any message with a `path` for
 * one of its own and declines it.
 */
function ask<T>(client: Client, request: Record<string, unknown>, timeout: number): Promise<T | undefined> {
  const channel = new MessageChannel();
  const answer = new Promise<T | undefined>((resolve) => {
    channel.port1.onmessage = (e) => resolve(e.data as T);
    setTimeout(() => resolve(undefined), timeout);
  });
  client.postMessage(request, [channel.port2]);
  return answer;
}

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

function parseRange(header: string | null): Range | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  if (m[1] === "") return { suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === "" ? undefined : Number(m[2]) + 1 };
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
  if (answer.status === 410) return new Response("This local data is not open in any tab. Open it again from Add → Local.", { status: 410, headers });
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
  if (url.pathname.startsWith(GOOGLE_PREFIX)) {
    if (request.method === "GET" || request.method === "HEAD") event.respondWith(google(request, url));
    return;
  }
  if (url.pathname.startsWith(PREFIX)) {
    if (request.method === "GET" || request.method === "HEAD") event.respondWith(local(request, url));
    return;
  }
  if (url.pathname.includes("/virtual/")) event.respondWith(computed(request, url));
});

/** A Cloud Storage object read with its bucket's Google account (401 until the page has given that account's token). */
async function google(request: Request, url: URL): Promise<Response> {
  const rest = decodeURIComponent(url.pathname.slice(GOOGLE_PREFIX.length));
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const object = slash === -1 ? "" : rest.slice(slash + 1);
  const googleToken = tokenFromTable(googleTokens, bucket, object);
  if (googleToken === null) return new Response("Sign in with Google in the Auth tab to read this bucket (with the account its sign-in rule names).", { status: 401 });
  const headers: Record<string, string> = { authorization: `Bearer ${googleToken}` };
  const range = request.headers.get("range");
  if (range !== null) headers.range = range;
  return fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`, { method: request.method, headers });
}

/**
 * A computed image's request, relayed to a page: the tab in use first, so
 * one tab computes it, then any (a page of chunkmirage's own ids, or the
 * tab in use closed).
 */
async function computed(request: Request, url: URL): Promise<Response> {
  if (url.pathname.includes("/virtual/ngp/") && active !== undefined) {
    const first = await relay(request.clone(), { pick: (pages) => pages.filter((p) => p.id === active) });
    if (first.status !== 503) return first;
  }
  return relay(request);
}
