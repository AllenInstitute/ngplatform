/**
 * vzip archives (refkv's ZIP binding, format version 0, spec revision
 * 11.3): a ZIP64 archive whose entries are either bytes or references, a
 * reference being the value made from byte ranges of other objects (the
 * original files a Zarr hierarchy was "zarrified" from, say).
 *
 * Read in place from a Blob: the end records and the comment (magic
 * "vzip/0", where the source table is), the central directory (names,
 * sizes, offsets; a reference's Range or Concat in an extra field 0x7A76
 * or 0x7A77), and each value when asked for.  Sources named by URL are
 * read through `resolve`, which the caller gives (local files by name,
 * http(s) by range requests); key and data sources from the archive.
 * Pins (size, etag, time) are checked where the resolver can.
 */

interface Entry {
  method: number;
  compressed: number;
  size: number;
  offset: number;
  /** For a reference: its payload, and whether it is a Concat (0x7A77) rather than one Range (0x7A76). */
  reference?: { payload: Uint8Array; concat: boolean };
}

export interface Range {
  source: number;
  offset: number;
  length: number;
  /** A literal range's bytes. */
  data?: Uint8Array;
}

export interface Source {
  url?: string;
  key?: string;
  data?: Uint8Array;
  size?: number;
  etag?: string;
}

/** Reads `length` bytes at `offset` of a source given by URL (resolved against nothing: the caller knows where the archive is). */
export type Resolve = (url: string, offset: number, length: number, pins: { size?: number; etag?: string }) => Promise<Uint8Array>;

// ------------------------------------------------------------ protobuf

/** The fields of a protobuf message: field number to its values (varints as numbers, length-delimited as bytes). */
function fields(bytes: Uint8Array): Map<number, (number | Uint8Array)[]> {
  const out = new Map<number, (number | Uint8Array)[]>();
  let at = 0;
  const varint = () => {
    let v = 0;
    let shift = 1;
    for (;;) {
      if (at >= bytes.length) throw new Error("a protobuf varint runs past the end");
      const b = bytes[at++];
      v += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return v;
      shift *= 128;
    }
  };
  while (at < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 0 || field > 2 ** 29 - 1) throw new Error(`protobuf field number ${field}`);
    let value: number | Uint8Array;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const n = varint();
      value = bytes.subarray(at, at + n);
      at += n;
    } else if (wire === 1) {
      at += 8;
      continue;
    } else if (wire === 5) {
      at += 4;
      continue;
    } else throw new Error(`protobuf wire type ${wire} is not allowed`);
    if (!out.has(field)) out.set(field, []);
    out.get(field)!.push(value);
  }
  return out;
}

const last = <T>(m: Map<number, T[]>, f: number): T | undefined => m.get(f)?.at(-1);

function decodeRange(bytes: Uint8Array): Range {
  const f = fields(bytes);
  const data = last(f, 5) as Uint8Array | undefined;
  return { source: (last(f, 1) as number) ?? 0, offset: (last(f, 3) as number) ?? 0, length: (last(f, 4) as number) ?? 0, ...(data !== undefined ? { data } : {}) };
}

function decodeSources(bytes: Uint8Array): Source[] {
  const text = new TextDecoder("utf-8", { fatal: true });
  return ((fields(bytes).get(1) ?? []) as Uint8Array[]).map((b) => {
    const f = fields(b);
    // Of url, key and data, the last on the wire is the one.
    const kinds = [1, 2, 3].flatMap((n) => (f.has(n) ? [n] : []));
    const s: Source = {};
    const kind = kinds.at(-1);
    if (kind === 1) s.url = text.decode(last(f, 1) as Uint8Array);
    else if (kind === 2) s.key = text.decode(last(f, 2) as Uint8Array);
    else if (kind === 3) s.data = last(f, 3) as Uint8Array;
    else throw new Error("a source with no url, key or data");
    if (f.has(4)) s.size = last(f, 4) as number;
    if (f.has(5)) s.etag = text.decode(last(f, 5) as Uint8Array);
    return s;
  });
}

// ------------------------------------------------------------ ZIP

async function bytesAt(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}

const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

export class Vzip {
  private constructor(
    private readonly blob: Blob,
    private readonly entries: Map<string, Entry>,
    readonly sources: Source[],
    private readonly resolve: Resolve,
  ) {}

  /** Opens an archive: its end records, comment, central directory and source table. */
  static async open(blob: Blob, resolve: Resolve): Promise<Vzip> {
    // The end of central directory record with its comment: 22 bytes, and a 38- or 22-byte comment.
    let comment: DataView | undefined;
    let eocd = 0;
    for (const size of [38, 22]) {
      const at = blob.size - 22 - size;
      if (at < 0) continue;
      const b = await bytesAt(blob, at, blob.size);
      const v = new DataView(b.buffer);
      if (v.getUint32(0, true) === 0x06054b50 && v.getUint16(20, true) === size) {
        if (new TextDecoder().decode(b.subarray(22, 27)) !== "vzip/") throw new Error("a ZIP file, not a vzip archive");
        const version = new TextDecoder().decode(b.subarray(27, 28));
        if (version !== "0") throw new Error(`vzip format version ${version} is not read (version 0 is)`);
        comment = new DataView(b.buffer, 22);
        eocd = at;
        break;
      }
    }
    if (comment === undefined) throw new Error("not a vzip archive (no vzip/ comment at its end)");
    // The zip64 locator sits just before the end record; it says where the zip64 end record is.
    const locator = new DataView((await bytesAt(blob, eocd - 20, eocd)).buffer);
    if (locator.getUint32(0, true) !== 0x07064b50) throw new Error("a vzip archive without its zip64 locator");
    const z64 = new DataView((await bytesAt(blob, u64(locator, 8), u64(locator, 8) + 56)).buffer);
    if (z64.getUint32(0, true) !== 0x06064b50) throw new Error("a vzip archive without its zip64 end record");
    const cdSize = u64(z64, 40);
    const cdOffset = u64(z64, 48);
    const cd = await bytesAt(blob, cdOffset, cdOffset + cdSize);
    const v = new DataView(cd.buffer);
    const entries = new Map<string, Entry>();
    const names = new TextDecoder("utf-8", { fatal: true });
    for (let at = 0; at + 46 <= cd.length; ) {
      if (v.getUint32(at, true) !== 0x02014b50) throw new Error("a broken central directory");
      const method = v.getUint16(at + 10, true);
      let compressed = v.getUint32(at + 20, true);
      let size = v.getUint32(at + 24, true);
      const nameLength = v.getUint16(at + 28, true);
      const extraLength = v.getUint16(at + 30, true);
      const commentLength = v.getUint16(at + 32, true);
      let offset = v.getUint32(at + 42, true);
      const name = names.decode(cd.subarray(at + 46, at + 46 + nameLength));
      const entry: Entry = { method, compressed, size, offset };
      // Extra fields: zip64 sizes and offset (0x0001), a reference (0x7A76 Range, 0x7A77 Concat).
      for (let e = at + 46 + nameLength, end = e + extraLength; e + 4 <= end; ) {
        const id = v.getUint16(e, true);
        const length = v.getUint16(e + 2, true);
        const body = e + 4;
        if (id === 0x0001) {
          let p = body;
          if (size === 0xffffffff) (size = u64(v, p)), (p += 8);
          if (compressed === 0xffffffff) (compressed = u64(v, p)), (p += 8);
          if (offset === 0xffffffff) offset = u64(v, p);
          Object.assign(entry, { size, compressed, offset });
        } else if (id === 0x7a76 || id === 0x7a77) {
          if (entry.reference !== undefined) throw new Error(`${name}: more than one reference`);
          entry.reference = { payload: cd.slice(body, body + length), concat: id === 0x7a77 };
        }
        e = body + length;
      }
      entries.set(name, entry);
      at += 46 + nameLength + extraLength + commentLength;
    }
    // The source table: where the comment says, deflated.
    const sourcesOffset = u64(comment, 6);
    const sourcesSize = u64(comment, 14);
    const table = await inflateRaw(await bytesAt(blob, sourcesOffset, sourcesOffset + sourcesSize));
    return new Vzip(blob, entries, decodeSources(table), resolve);
  }

  /** Every key there is (hidden __vz__/ entries left out). */
  keys(): string[] {
    return [...this.entries.keys()].filter((k) => !k.startsWith("__vz__/"));
  }

  has(key: string): boolean {
    return !key.startsWith("__vz__/") && this.entries.has(key);
  }

  /** A bytes entry's own value (no reference resolved), read from its local header on. */
  private async raw(key: string): Promise<Uint8Array | undefined> {
    const e = this.entries.get(key);
    if (e === undefined) return undefined;
    const header = new DataView((await bytesAt(this.blob, e.offset, e.offset + 30)).buffer);
    if (header.getUint32(0, true) !== 0x04034b50) throw new Error(`${key}: no local header`);
    const start = e.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const body = await bytesAt(this.blob, start, start + e.compressed);
    if (e.method === 0) return body;
    if (e.method === 8) return inflateRaw(body);
    throw new Error(`${key}: compression method ${e.method} is not allowed in a vzip`);
  }

  /** The value of `key`: its bytes, or its reference resolved; undefined when there is no such key. */
  async get(key: string): Promise<Uint8Array | undefined> {
    if (!this.has(key)) return undefined;
    const e = this.entries.get(key)!;
    if (e.reference === undefined) return this.raw(key);
    const ranges = e.reference.concat ? ((fields(e.reference.payload).get(1) ?? []) as Uint8Array[]).map(decodeRange) : [decodeRange(e.reference.payload)];
    const parts = await Promise.all(ranges.map((r) => this.range(r)));
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
    return out;
  }

  private async range(r: Range): Promise<Uint8Array> {
    if (r.data !== undefined) return r.data;
    const s = this.sources[r.source];
    if (s === undefined) throw new Error(`a reference to source ${r.source}, which the table does not have`);
    if (s.data !== undefined) return s.data.subarray(r.offset, r.offset + r.length);
    if (s.key !== undefined) {
      const whole = await this.raw(s.key);
      if (whole === undefined) throw new Error(`a reference to ${s.key}, which the archive does not have`);
      return whole.subarray(r.offset, r.offset + r.length);
    }
    const bytes = await this.resolve(s.url!, r.offset, r.length, { size: s.size, etag: s.etag });
    if (bytes.length !== r.length) throw new Error(`${s.url}: ${bytes.length} bytes where ${r.length} were referenced`);
    return bytes;
  }
}
