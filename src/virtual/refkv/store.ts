/**
 * A vzip archive (refkv) as a virtual store: its Zarr hierarchy served key
 * by key, references resolved against the files beside it (by name: an
 * archive names its sources by where it was made) or over http(s) with
 * range requests.
 *
 * Arrays whose codecs Neuroglancer does not read (refkv's zarrified TIFFs
 * use numcodecs.zlib, refkv.tiff_lzw and imagecodecs_delta) are served with
 * their chunks decoded here and the metadata saying plain bytes; arrays
 * Neuroglancer reads as they are pass through untouched.
 */
import { decompress as zstd } from "fzstd";
import type { VirtualStore } from "../images/store.js";
import { lzwDecode } from "../images/tiff.js";
import { type Resolve, Vzip } from "./vzip.js";

/** Codecs Neuroglancer's Zarr v3 reader decodes itself. */
const NEUROGLANCER = new Set(["bytes", "transpose", "gzip", "zstd", "blosc", "crc32c", "sharding_indexed"]);
/** Bytes-to-bytes codecs decoded here. */
const BYTES_CODECS = new Set(["numcodecs.zlib", "zlib", "gzip", "zstd", "refkv.tiff_lzw"]);

const SIZES: Record<string, number> = { bool: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, int64: 8, uint64: 8, float64: 8 };

interface Codec {
  name: string;
  configuration?: Record<string, unknown>;
}

/** How an array's chunks are decoded here: the codecs after `bytes`, the delta before it, and the chunk's size. */
interface Decoding {
  after: Codec[];
  delta?: { axis: number; dist: number };
  shape: number[];
  dtype: string;
  littleEndian: boolean;
}

async function inflate(bytes: Uint8Array, format: "deflate" | "gzip"): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format))).arrayBuffer());
}

/** Undoes horizontal differencing along `axis` (each value the change from the one `dist` before it), in place. */
function undoDelta(bytes: Uint8Array, d: Decoding): void {
  const size = SIZES[d.dtype];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = d.littleEndian;
  const get = (i: number) => (size === 1 ? view.getUint8(i) : size === 2 ? view.getUint16(i * 2, le) : size === 4 ? view.getUint32(i * 4, le) : 0);
  const set = (i: number, v: number) => (size === 1 ? view.setUint8(i, v & 0xff) : size === 2 ? view.setUint16(i * 2, v & 0xffff, le) : view.setUint32(i * 4, v >>> 0, le));
  if (size === 8 || d.dtype.startsWith("float")) throw new Error(`the delta codec on ${d.dtype} is not decoded here`);
  const shape = d.shape;
  const { axis, dist } = d.delta!;
  const stride = shape.slice(axis + 1).reduce((n, s) => n * s, 1);
  const along = shape[axis];
  const total = shape.reduce((n, s) => n * s, 1);
  for (let i = 0; i < total; ++i) {
    const k = Math.floor(i / stride) % along;
    if (k >= dist) set(i, get(i) + get(i - dist * stride));
  }
}

/** Opens a vzip as a store; `related` are the files beside it (by path from its folder), for its references. */
export async function openVzip(file: Blob & { name: string }, related: Record<string, File>): Promise<VirtualStore & { name: string }> {
  const byName = new Map(Object.entries(related).map(([path, f]) => [path.split("/").pop()!, f]));
  const resolve: Resolve = async (url, offset, length, pins) => {
    if (/^https?:/i.test(url)) {
      const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      const etag = response.headers.get("ETag");
      if (pins.etag !== undefined && etag !== null && etag !== pins.etag) throw new Error(`${url} has changed since the archive was made (its ETag)`);
      return new Uint8Array(await response.arrayBuffer());
    }
    // A local file, named by where it was when the archive was made: found beside the archive by its name.
    const name = decodeURIComponent(url.replace(/[?#].*$/, "").split("/").pop() ?? "");
    const source = byName.get(name);
    if (source === undefined) throw new Error(`${name} (which ${file.name} reads) is not beside it: open the folder that holds both`);
    if (pins.size !== undefined && source.size !== pins.size) throw new Error(`${name} is not the size the archive expects: it may have changed`);
    return new Uint8Array(await source.slice(offset, offset + length).arrayBuffer());
  };
  const zip = await Vzip.open(file, resolve);
  const decodings = new Map<string, Decoding | null>();

  /** An array's metadata as served, and how its chunks are decoded (null: passed through). */
  const metadata = async (path: string): Promise<{ bytes: Uint8Array; decoding: Decoding | null } | undefined> => {
    const raw = await zip.get(path === "" ? "zarr.json" : `${path}/zarr.json`);
    if (raw === undefined) return undefined;
    const meta = JSON.parse(new TextDecoder().decode(raw));
    if (meta.node_type !== "array" || !Array.isArray(meta.codecs) || (meta.codecs as Codec[]).every((c) => NEUROGLANCER.has(c.name))) {
      decodings.set(path, null);
      return { bytes: raw, decoding: null };
    }
    const codecs = meta.codecs as Codec[];
    const at = codecs.findIndex((c) => c.name === "bytes");
    const before = codecs.slice(0, at);
    const after = codecs.slice(at + 1);
    const unknown = [...before.filter((c) => c.name !== "transpose" && c.name !== "imagecodecs_delta"), ...after.filter((c) => !BYTES_CODECS.has(c.name))];
    if (at === -1 || unknown.length > 0) throw new Error(`${path}: its codec ${unknown[0]?.name ?? "chain"} is not read here or by Neuroglancer`);
    const delta = before.find((c) => c.name === "imagecodecs_delta")?.configuration as { axis?: number; dist?: number } | undefined;
    const bytesCodec = codecs[at];
    const decoding: Decoding = {
      after,
      ...(delta ? { delta: { axis: delta.axis ?? meta.shape.length - 1, dist: delta.dist ?? 1 } } : {}),
      shape: meta.chunk_grid.configuration.chunk_shape,
      dtype: meta.data_type,
      littleEndian: (bytesCodec.configuration?.endian ?? "little") === "little",
    };
    decodings.set(path, decoding);
    // Served as the plain bytes it is decoded to (a transpose before them stays: Neuroglancer applies it).
    meta.codecs = [...before.filter((c) => c.name === "transpose"), bytesCodec];
    return { bytes: new TextEncoder().encode(JSON.stringify(meta)), decoding };
  };

  const decode = async (bytes: Uint8Array, d: Decoding): Promise<Uint8Array> => {
    let out = bytes;
    const expected = d.shape.reduce((n, s) => n * s, 1) * (SIZES[d.dtype] ?? 1);
    for (const c of [...d.after].reverse()) {
      if (c.name === "numcodecs.zlib" || c.name === "zlib") out = await inflate(out, "deflate");
      else if (c.name === "gzip") out = await inflate(out, "gzip");
      else if (c.name === "zstd") out = zstd(out);
      else if (c.name === "refkv.tiff_lzw") out = lzwDecode(out, expected);
    }
    if (out.byteLength !== expected) {
      // TIFF strips and tiles decode to whole blocks; pad or cut to the chunk's size.
      const sized = new Uint8Array(expected);
      sized.set(out.subarray(0, expected));
      out = sized;
    } else if (out.byteOffset !== 0 || out.byteLength !== out.buffer.byteLength) out = out.slice();
    if (d.delta) undoDelta(out, d);
    return out;
  };

  return {
    name: file.name.replace(/\.vzip$/i, ""),
    async get(key: string): Promise<Uint8Array | undefined> {
      if (key === "zarr.json" || key.endsWith("/zarr.json")) {
        const path = key === "zarr.json" ? "" : key.slice(0, -"/zarr.json".length);
        return (await metadata(path))?.bytes;
      }
      const chunk = /^(.*?)\/?c\/[0-9/.]+$/.exec(key);
      const raw = await zip.get(key);
      if (raw === undefined || chunk === null) return raw;
      const path = chunk[1];
      if (!decodings.has(path)) await metadata(path);
      const decoding = decodings.get(path);
      return decoding ? decode(raw, decoding) : raw;
    },
    list(prefix: string): string[] | undefined {
      const dir = prefix.replace(/\/$/, "");
      const base = dir === "" ? "" : `${dir}/`;
      const names = new Set<string>();
      for (const k of zip.keys()) {
        if (!k.startsWith(base)) continue;
        const rest = k.slice(base.length).split("/");
        names.add(rest.length > 1 ? `${rest[0]}/` : rest[0]);
      }
      return names.size === 0 ? undefined : [...names].sort();
    },
  };
}
