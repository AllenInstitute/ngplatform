/**
 * Virtual Zarr: a file that is not Zarr, read as a Zarr v3 store without
 * converting it.  A store answers a key (`zarr.json`, `0/zarr.json`,
 * `0/c/1/2/3`, …) with bytes it makes when asked: metadata from the file's
 * header, chunks cut from (or, for coarser levels, computed from) its data.
 * The local-data worker serves these under the file's own URL, so
 * Neuroglancer and the plugins read the file as an OME-Zarr image.
 */

/** Files read as virtual Zarr, by name: NIfTI images. */
/** NIfTI and Analyze files; not CIFTI (`.dscalar.nii` and the like: values on surfaces, read with them). */
export const VIRTUAL_FILE = /^(?!.*\.(d|p)(scalar|label|tseries|conn|fiber)\.nii$).*\.(nii(\.gz)?|hdr)$/i;
export const TIFF_FILE = /\.tiff?$/i;

/**
 * Names of label images (segmentations, parcellations, atlases): FreeSurfer's
 * aseg, aparc+aseg and wmparc, BIDS's dseg, and the usual words.
 */
export const LABEL_NAME = /(^|[._+-])(aseg|aparc|wmparc|dseg|seg|segmentation|labels?|parcellation|parc)([._+-]|$)/i;

export interface VirtualStore {
  /** The bytes of `key`, or undefined when the store has no such key. */
  get(key: string): Promise<Uint8Array | undefined>;
  /**
   * The names in a directory ("" or a key ending in "/"), sub-directories
   * ending in "/"; undefined when there is no such directory.  For readers
   * that list (zarr-vectors' object attributes).
   */
  list?(prefix: string): string[] | undefined;
  /**
   * Answers a message from the page (`WorkspaceApi.local.send`): for a
   * store whose values the page chooses, such as the time point a CIFTI
   * series on a surface serves.
   */
  message?(body: unknown): unknown;
}

/** Random access to a file's bytes. */
export interface ByteSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

export function isGzip(head: Uint8Array): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** The first `n` bytes of a gzipped file, decompressing no more of it than that. */
export async function gunzipHead(blob: Blob, n: number): Promise<Uint8Array> {
  const reader = blob.stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < n) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return concat(parts).subarray(0, n);
}

/**
 * A gzipped file's contents, decompressed once (when first read).  A gzip
 * stream cannot be read from the middle, so this is the price of a `.gz`.
 * With a `cacheKey` (the file's name, size and date) the decompressed copy
 * is kept in the origin's private file system (OPFS) for later visits;
 * otherwise, or where that is not allowed, it goes into a blob, which the
 * browser keeps on disk when it is large.
 */
export function gunzipSource(blob: Blob, cacheKey?: string, cache: Promise<CacheDirectory | undefined> = opfsDirectory()): () => Promise<ByteSource> {
  let whole: Promise<ByteSource> | undefined;
  const decompress = () => blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return () =>
    (whole ??= (async () => {
      const dir = cacheKey === undefined ? undefined : await cache.catch(() => undefined);
      if (dir !== undefined) {
        const kept = await cachedFile(dir, cacheKey!, decompress).catch(() => undefined);
        if (kept !== undefined) return blobSource(kept);
      }
      return blobSource(await new Response(decompress()).blob());
    })());
}

/** The parts of an OPFS directory handle the cache uses (a fake one in tests). */
export interface CacheDirectory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{ getFile(): Promise<File>; createWritable(): Promise<WritableStream<Uint8Array> & { close(): Promise<void> }> }>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
}

/** Decompressed files kept, at most; the least recently used go first. */
const KEEP = 6;

function opfsDirectory(): Promise<CacheDirectory | undefined> {
  const storage = (globalThis.navigator as { storage?: { getDirectory?(): Promise<FileSystemDirectoryHandle> } } | undefined)?.storage;
  if (storage?.getDirectory === undefined) return Promise.resolve(undefined);
  return storage
    .getDirectory()
    .then((root) => root.getDirectoryHandle("ngplatform-gunzipped", { create: true }) as unknown as CacheDirectory)
    .catch(() => undefined);
}

/** A file name for a cache key: its hash, hex. */
function cacheName(key: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < key.length; ++i) {
    a = Math.imul(a ^ key.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ key.charCodeAt(i), 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/**
 * The decompressed file kept under `key`, made (streamed to disk) when it
 * is not there; a ".done" mark says it was written whole.  The oldest
 * copies beyond KEEP are removed.
 */
export async function cachedFile(dir: CacheDirectory, key: string, decompress: () => ReadableStream<Uint8Array>): Promise<File> {
  const name = cacheName(key);
  const mark = `${name}.done`;
  try {
    const done = await dir.getFileHandle(mark);
    const file = await (await dir.getFileHandle(name)).getFile();
    // Touch the mark: it dates the copy's last use.
    const w = await done.createWritable();
    await w.close();
    return file;
  } catch {
    // Not kept (or not whole): made below.
  }
  const handle = await dir.getFileHandle(name, { create: true });
  await decompress().pipeTo(await handle.createWritable());
  const done = await dir.getFileHandle(mark, { create: true });
  await (await done.createWritable()).close();
  // Beyond KEEP copies, the least recently used go.
  const marks: { name: string; used: number }[] = [];
  for await (const entry of dir.keys()) {
    if (!entry.endsWith(".done")) continue;
    marks.push({ name: entry.slice(0, -5), used: (await (await dir.getFileHandle(entry)).getFile()).lastModified });
  }
  marks.sort((x, y) => y.used - x.used);
  for (const old of marks.slice(KEEP)) {
    if (old.name === name) continue;
    await dir.removeEntry(`${old.name}.done`).catch(() => {});
    await dir.removeEntry(old.name).catch(() => {});
  }
  return (await dir.getFileHandle(name)).getFile();
}

/** A cache of values with sizes, dropping the least recently used beyond a budget of bytes. */
export class Lru<V> {
  private readonly entries = new Map<string, { value: Promise<V>; bytes: number; settled?: boolean }>();
  private total = 0;

  constructor(readonly budget: number) {}

  /** Bytes held. */
  get bytes(): number {
    return this.total;
  }

  /** The value for `key`, made (once, shared by every caller) when absent. */
  get(key: string, make: () => Promise<V>, sizeOf: (v: V) => number): Promise<V> {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const entry: { value: Promise<V>; bytes: number; settled?: boolean } = { value: make(), bytes: 0 };
    this.entries.set(key, entry);
    entry.value.then(
      (v) => {
        if (this.entries.get(key) !== entry) return;
        entry.bytes = sizeOf(v);
        entry.settled = true;
        this.total += entry.bytes;
        this.trim();
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.value;
  }

  /** The value kept for `key`, if it is made (not still being made), without counting it as a use. */
  peek(key: string): Promise<V> | undefined {
    const entry = this.entries.get(key);
    return entry?.settled ? entry.value : undefined;
  }

  /** Keeps a value made elsewhere (replacing any kept for `key`). */
  put(key: string, value: V, bytes: number): void {
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.entries.delete(key);
      this.total -= old.bytes;
    }
    this.entries.set(key, { value: Promise.resolve(value), bytes, settled: true });
    this.total += bytes;
    this.trim();
  }

  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.total <= this.budget) break;
      this.entries.delete(key);
      this.total -= entry.bytes;
    }
  }
}

export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 1));
}

/** What the local-data service worker sends back: a whole key, or the part of it a range asks for. */
export interface Answer {
  status: number;
  size?: number;
  start?: number;
  body?: ArrayBuffer;
  message?: string;
  /** "text/html" for a directory listing; otherwise bytes. */
  contentType?: string;
}

/** A directory listing as an HTML page of links, which Neuroglancer's http store reads as Python's http.server's. */
export function listingHtml(names: string[]): Uint8Array {
  const escape = (n: string) => n.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return new TextEncoder().encode(`<!DOCTYPE html><html><body><ul>${names.map((n) => `<li><a href="${escape(encodeURI(n))}">${escape(n)}</a></li>`).join("")}</ul></body></html>`);
}

export type Range = { start?: number; end?: number; suffix?: number };

export async function answer(store: VirtualStore, key: string, range: Range | undefined, head: boolean): Promise<Answer> {
  if (key === "" || key.endsWith("/")) {
    const names = store.list?.(key);
    if (names === undefined) return { status: 404 };
    const html = listingHtml(names);
    return { status: 200, size: html.byteLength, start: 0, body: head ? undefined : html.slice().buffer, contentType: "text/html" };
  }
  const data = await store.get(key);
  if (data === undefined) return { status: 404 };
  const size = data.byteLength;
  let start = 0;
  let end = size;
  if (range?.suffix !== undefined) start = Math.max(0, size - range.suffix);
  else if (range !== undefined) {
    start = Math.min(range.start ?? 0, size);
    end = Math.min(range.end ?? size, size);
  }
  // A copy: the store may keep `data` in its cache, and the body is transferred.
  return { status: 200, size, start, body: head ? undefined : data.slice(start, end).buffer };
}

/**
 * A NIfTI (or Analyze 7.5) .hdr/.img pair as one single-file NIfTI, the
 * image not copied: the header marked "n+1" (or "n+2") with the image after
 * it.  An Analyze header's orientation fields, which NIfTI reads as qform
 * and sform, are cleared, so its voxel sizes alone place it.
 */
export async function pairAsSingleFile(hdr: Blob, img: Blob, name: string): Promise<File> {
  const bytes = new Uint8Array(await hdr.slice(0, 540).arrayBuffer());
  const view = new DataView(bytes.buffer);
  const le = [348, 540].includes(view.getInt32(0, true));
  const size = view.getInt32(0, le);
  if (size === 540) {
    const header = bytes.slice(0, 540);
    header.set([110, 43, 50, 0, 13, 10, 26, 10], 4); // "n+2\0\r\n\032\n"
    new DataView(header.buffer).setBigInt64(168, 544n, le);
    return new File([header, new Uint8Array(4), img], name);
  }
  if (size !== 348) throw new Error("not a NIfTI or Analyze header");
  const header = bytes.slice(0, 348);
  const magic = new TextDecoder().decode(header.subarray(344, 347));
  if (magic !== "ni1") header.fill(0, 252, 344);
  header.set([110, 43, 49, 0], 344); // "n+1"
  new DataView(header.buffer).setFloat32(108, 352, le);
  return new File([header, new Uint8Array(4), img], name);
}
