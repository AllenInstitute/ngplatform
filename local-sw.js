/*
 * Serves data on this computer to the viewer: a request for
 * <app>/local/<id>/<path> is answered with that file of the folder (or the
 * file) picked as <id>.  The page that picked it holds the files and reads
 * them; this worker asks it, so the files never leave the computer and
 * Neuroglancer (and its workers) read them like any other URL, with
 * ranges.  Links to local data work only while that page is open.
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

async function ask(client, request) {
  const channel = new MessageChannel();
  const answer = new Promise((resolve) => {
    channel.port1.onmessage = (e) => resolve(e.data);
    setTimeout(() => resolve(undefined), 30000);
  });
  client.postMessage(request, [channel.port2]);
  return answer;
}

/** Asks the page that picked `id` (or, after this worker restarted, every page) for a file. */
async function read(id, path, range, head) {
  const request = { type: "local-read", id, path, range, head };
  const known = owners.get(id);
  if (known !== undefined) {
    const client = await self.clients.get(known);
    if (client) {
      const answer = await ask(client, request);
      if (answer && answer.status !== 410) return answer;
    }
  }
  for (const client of await self.clients.matchAll({ type: "window" })) {
    const answer = await ask(client, request);
    if (answer && answer.status !== 410) {
      owners.set(id, client.id);
      return answer;
    }
  }
  return { status: 410 };
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
      if (answer.status !== 200) return new Response(null, { status: answer.status, headers });
      const { body, size, start } = answer;
      headers["accept-ranges"] = "bytes";
      headers["content-type"] = "application/octet-stream";
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
