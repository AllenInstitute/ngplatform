/**
 * Virtual Zarr: a file that is not Zarr, read as a Zarr v3 store without
 * converting it.  A store answers a key (`zarr.json`, `0/zarr.json`,
 * `0/c/1/2/3`, …) with bytes it makes when asked: metadata from the file's
 * header, chunks cut from (or, for coarser levels, computed from) its data.
 * The local-data worker serves these under the file's own URL, so
 * Neuroglancer and the plugins read the file as an OME-Zarr image.
 */

/** Files read as virtual Zarr, by name: NIfTI images. */
export const VIRTUAL_FILE = /\.nii(\.gz)?$/i;

export interface VirtualStore {
  /** The bytes of `key`, or undefined when the store has no such key. */
  get(key: string): Promise<Uint8Array | undefined>;
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
 * A gzipped file's contents, decompressed once (when first read) into a
 * blob, which the browser keeps on disk when it is large.  A gzip stream
 * cannot be read from the middle, so this is the price of a `.gz`.
 */
export function gunzipSource(blob: Blob): () => Promise<ByteSource> {
  let whole: Promise<ByteSource> | undefined;
  return () => (whole ??= new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).blob().then(blobSource));
}

/** A cache of values with sizes, dropping the least recently used beyond a budget of bytes. */
export class Lru<V> {
  private readonly entries = new Map<string, { value: Promise<V>; bytes: number }>();
  private total = 0;

  constructor(private readonly budget: number) {}

  /** The value for `key`, made (once, shared by every caller) when absent. */
  get(key: string, make: () => Promise<V>, sizeOf: (v: V) => number): Promise<V> {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const entry = { value: make(), bytes: 0 };
    this.entries.set(key, entry);
    entry.value.then(
      (v) => {
        if (this.entries.get(key) !== entry) return;
        entry.bytes = sizeOf(v);
        this.total += entry.bytes;
        this.trim();
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.value;
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
}

export type Range = { start?: number; end?: number; suffix?: number };

export async function answer(store: VirtualStore, key: string, range: Range | undefined, head: boolean): Promise<Answer> {
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
