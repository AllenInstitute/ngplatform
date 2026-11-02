/*
 * Serves data on this computer to the viewer: a request for
 * <app>/local/<id>/<path> is answered with that file of the folder (or the
 * file) picked as <id>.  The page that picked it holds the files and reads
 * them; this worker asks it, so the files never leave the computer and
 * Neuroglancer (and its workers) read them like any other URL, with
 * ranges.  Links to local data work only while that page is open.  Under a
 * NIfTI file's own URL the page answers with a Zarr store made from the file
 * (virtual Zarr), which can take a while the first time for a large .gz.
 */
const PREFIX = new URL("./local/", self.registration.scope).pathname;
/** The page (client id) that holds each picked folder or file. */
const owners = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type === "local-register" && event.source) owners.set(data.id, event.source.id);
  if (data?.type === "local-claim") event.waitUntil(self.clients.claim());
});

/** How long a page may take over one read: a large .nii.gz is decompressed on its first. */
const READ_TIMEOUT = 10 * 60 * 1000;

async function ask(client, request, timeout) {
  const channel = new MessageChannel();
  const answer = new Promise((resolve) => {
    channel.port1.onmessage = (e) => resolve(e.data);
    setTimeout(() => resolve(undefined), timeout);
  });
  client.postMessage(request, [channel.port2]);
  return answer;
}

/** The page holding `id`: the one that registered it, or (after this worker restarted) the one that says so. */
async function owner(id) {
  const known = owners.get(id);
  if (known !== undefined) {
    const client = await self.clients.get(known);
    if (client) return client;
    owners.delete(id);
  }
  for (const client of await self.clients.matchAll({ type: "window" })) {
    if ((await ask(client, { type: "local-has", id }, 2000)) === true) {
      owners.set(id, client.id);
      return client;
    }
  }
  return undefined;
}

async function read(id, path, range, head) {
  const client = await owner(id);
  if (client === undefined) return { status: 410 };
  const answer = await ask(client, { type: "local-read", id, path, range, head }, READ_TIMEOUT);
  return answer ?? { status: 504, message: "The page holding this data did not answer in time." };
}

function parseRange(header) {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  if (m[1] === "") return { suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === "" ? undefined : Number(m[2]) + 1 };
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
  const method = event.request.method;
  if (method !== "GET" && method !== "HEAD") return;
  const rest = url.pathname.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  const id = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : decodeURIComponent(rest.slice(slash + 1));
  event.respondWith(
    (async () => {
      const range = parseRange(event.request.headers.get("range"));
      const answer = await read(id, path, range, method === "HEAD");
      const headers = { "access-control-allow-origin": "*", "cache-control": "no-store" };
      if (answer.status === 410) return new Response("This local data is not open in any tab. Open it again from Add → Local.", { status: 410, headers });
      if (answer.status !== 200) return new Response(answer.message ?? null, { status: answer.status, headers });
      const { body, size, start } = answer;
      headers["accept-ranges"] = "bytes";
      headers["content-type"] = answer.contentType ?? "application/octet-stream";
      if (range !== undefined && size !== undefined) {
        const end = start + (body ? body.byteLength : 0);
        if (start >= size && size > 0) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
        headers["content-range"] = `bytes ${start}-${Math.max(start, end - 1)}/${size}`;
        headers["content-length"] = String(end - start);
        return new Response(method === "HEAD" ? null : body, { status: 206, headers });
      }
      headers["content-length"] = String(size ?? (body ? body.byteLength : 0));
      return new Response(method === "HEAD" ? null : body, { status: 200, headers });
    })(),
  );
});
