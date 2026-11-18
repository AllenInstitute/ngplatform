/**
 * Model files for the page's models (./sam_worker.ts, ./medsam2_worker.ts):
 * downloaded the first time with their progress, and kept in the browser's
 * Cache Storage so later runs read them from there.
 */

export interface ModelFile {
  url: string;
  bytes: number;
}

/** A model file, from the browser's Cache Storage or downloaded (and kept there), with its progress. */
export async function fetchKept(cacheName: string, file: ModelFile, progress: (loaded: number) => void): Promise<Uint8Array> {
  const cache = typeof caches !== "undefined" ? await caches.open(cacheName).catch(() => undefined) : undefined;
  const kept = await cache?.match(file.url);
  if (kept) {
    const bytes = new Uint8Array(await kept.arrayBuffer());
    progress(bytes.length);
    return bytes;
  }
  const response = await fetch(file.url);
  if (!response.ok || response.body === null) throw new Error(`${file.url}: ${response.status} ${response.statusText}`);
  const total = Number(response.headers.get("content-length")) || file.bytes;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  let told = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (loaded - told > 256 * 1024) {
      told = loaded;
      progress(loaded);
    }
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  progress(loaded);
  if (loaded !== total) throw new Error(`${file.url}: ${loaded} bytes of ${total}`);
  await cache?.put(file.url, new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(loaded) } })).catch(() => {});
  return bytes;
}
