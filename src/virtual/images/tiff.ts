/**
 * TIFF stacks read as virtual Zarr: the pages of a (multi-page) TIFF as the
 * z planes of a volume, served by the NIfTI store (./nifti.ts) through a
 * byte source that decodes the pages' strips or tiles as rows are asked for.
 *
 * Read: classic TIFF and BigTIFF, either byte order; one sample per pixel,
 * 8 to 64 bits (unsigned, signed or float), or 8- or 16-bit RGB and RGBA (served
 * packed in one uint32 a pixel, which the app shows in colour); strips or
 * tiles; no compression, LZW, deflate or PackBits, with the horizontal or
 * floating-point predictor.  Pixel sizes come
 * from OME-XML (PhysicalSizeX/Y/Z) or ImageJ's description (spacing, unit)
 * and the resolution tags.
 *
 * A pyramid the file holds itself is used as the image's coarser levels,
 * read like the full-resolution pages and not computed: each page's
 * SubIFDs (pyramidal OME-TIFF as bioformats2raw → raw2ometiff, tifffile
 * and QuPath write it), or the reduced-resolution pages following each
 * page in the chain (NewSubfileType 1), as tifffile reads them for a
 * series' levels.  They halve x and y (not z); coarser levels past the
 * file's own are computed from the coarsest of them.  A lone thumbnail, or
 * reduced pages that do not line up with every plane, are skipped.
 */
import { cacheKeyOf, type FileLevel, NiftiStore, type NiftiHeader } from "./nifti.js";
import { type ByteSource, Lru } from "./store.js";

export { TIFF_FILE } from "./store.js";

export interface Page {
  width: number;
  height: number;
  bits: number;
  /** Samples per pixel: 1, or 3 or 4 (RGB, RGBA; interleaved). */
  samples: number;
  /** 1 unsigned, 2 signed, 3 float. */
  format: number;
  compression: number;
  predictor: number;
  /** Strips or tiles: each block's offset and byte count, and its size in pixels. */
  offsets: number[];
  counts: number[];
  blockWidth: number;
  blockHeight: number;
  tiled: boolean;
}

interface Stack {
  littleEndian: boolean;
  pages: Page[];
  description: string;
  /** Pixels per unit (x, y) and the unit (2 inch, 3 cm), from the first page. */
  resolution?: [number, number, number];
  /**
   * The file's own coarser levels, finest first: each level's pages, one
   * for each full-resolution page (its SubIFDs, or the reduced-resolution
   * pages that follow it), all the same size.
   */
  levels: Page[][];
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

async function bytesAt(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Compressions decoded here. */
const READ_COMPRESSION = new Set([1, 5, 8, 32946, 32773]);

interface Ifd {
  /** The values of a tag (numbers; rationals as their quotient). */
  values(tag: number): Promise<number[]>;
  one(tag: number, fallback: number): Promise<number>;
  has(tag: number): boolean;
  text(tag: number): Promise<string | undefined>;
  /** The next IFD's offset (0 for none). */
  next: number;
}

/** The IFD at `at`. */
async function readIfd(file: Blob, at: number, little: boolean, big: boolean): Promise<Ifd> {
  const countBytes = await bytesAt(file, at, at + (big ? 8 : 2));
  const cv = new DataView(countBytes.buffer);
  const n = big ? Number(cv.getBigUint64(0, little)) : cv.getUint16(0, little);
  const entrySize = big ? 20 : 12;
  const start = at + (big ? 8 : 2);
  const ifd = await bytesAt(file, start, start + n * entrySize + (big ? 8 : 4));
  const v = new DataView(ifd.buffer);
  const tags = new Map<number, { type: number; count: number; at: number; inline: boolean }>();
  for (let e = 0; e < n; ++e) {
    const o = e * entrySize;
    const tag = v.getUint16(o, little);
    const type = v.getUint16(o + 2, little);
    const count = big ? Number(v.getBigUint64(o + 4, little)) : v.getUint32(o + 4, little);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const valueAt = o + (big ? 12 : 8);
    const inline = size <= (big ? 8 : 4);
    tags.set(tag, { type, count, inline, at: inline ? valueAt : big ? Number(v.getBigUint64(valueAt, little)) : v.getUint32(valueAt, little) });
  }
  const whole = ifd.byteLength >= n * entrySize + (big ? 8 : 4);
  const next = !whole ? 0 : big ? Number(v.getBigUint64(n * entrySize, little)) : v.getUint32(n * entrySize, little);
  const raw = async (t: { type: number; count: number; at: number; inline: boolean }, size: number) =>
    t.inline ? ifd.subarray(t.at, t.at + size * t.count) : await bytesAt(file, t.at, t.at + size * t.count);
  const values = async (tag: number): Promise<number[]> => {
    const t = tags.get(tag);
    if (t === undefined) return [];
    const size = TYPE_SIZE[t.type] ?? 1;
    const bytes = await raw(t, size);
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: number[] = [];
    for (let i = 0; i < t.count; ++i) {
      const o = i * size;
      switch (t.type) {
        case 1: case 7: out.push(d.getUint8(o)); break;
        case 6: out.push(d.getInt8(o)); break;
        case 3: out.push(d.getUint16(o, little)); break;
        case 8: out.push(d.getInt16(o, little)); break;
        case 4: case 13: out.push(d.getUint32(o, little)); break;
        case 9: out.push(d.getInt32(o, little)); break;
        case 5: out.push(d.getUint32(o, little) / (d.getUint32(o + 4, little) || 1)); break;
        case 10: out.push(d.getInt32(o, little) / (d.getInt32(o + 4, little) || 1)); break;
        case 11: out.push(d.getFloat32(o, little)); break;
        case 12: out.push(d.getFloat64(o, little)); break;
        case 16: case 17: case 18: out.push(Number(d.getBigUint64(o, little))); break;
        default: out.push(0);
      }
    }
    return out;
  };
  return {
    values,
    one: async (tag, fallback) => (await values(tag))[0] ?? fallback,
    has: (tag) => tags.has(tag),
    text: async (tag) => {
      const t = tags.get(tag);
      return t === undefined ? undefined : new TextDecoder().decode(await raw(t, 1)).replace(/\0+$/, "");
    },
    next,
  };
}

/** A page's layout from its IFD; undefined for samples this reader does not take (unless `strict`, which throws). */
async function pageOf(ifd: Ifd, strict: boolean): Promise<Page | undefined> {
  const samples = await ifd.one(277, 1);
  if (samples !== 1) {
    const bits = await ifd.one(258, 8);
    const fail = (why: string) => {
      if (strict) throw new Error(why);
      return undefined;
    };
    if (!((samples === 3 || samples === 4) && (bits === 8 || bits === 16))) return fail(`a TIFF with ${samples} samples of ${bits} bits a pixel (one sample, or 8- or 16-bit RGB or RGBA, only)`);
    if ((await ifd.one(284, 1)) !== 1) return fail("an RGB TIFF with its colours in separate planes (interleaved only)");
  }
  const width = await ifd.one(256, 0);
  const height = await ifd.one(257, 0);
  const tiled = ifd.has(322);
  return {
    width,
    height,
    bits: await ifd.one(258, 1),
    samples,
    format: await ifd.one(339, 1),
    compression: await ifd.one(259, 1),
    predictor: await ifd.one(317, 1),
    offsets: await ifd.values(tiled ? 324 : 273),
    counts: await ifd.values(tiled ? 325 : 279),
    blockWidth: tiled ? await ifd.one(322, width) : width,
    blockHeight: tiled ? await ifd.one(323, height) : Math.min(height, await ifd.one(278, height)),
    tiled,
  };
}

const sameKind = (a: Page, b: Page) => a.bits === b.bits && a.format === b.format && a.samples === b.samples;

/**
 * The file's own levels from each full page's reduced versions (its
 * SubIFDs, or the reduced pages after it): level k is every page's k-th,
 * kept while every page has one, all the same size, smaller than the level
 * before by the same factor along x and y (at least 1.5), of the same
 * type, and in a compression read here.
 */
export function ownLevels(pages: Page[], reduced: Page[][]): Page[][] {
  const levels: Page[][] = [];
  if (pages.length === 0 || reduced.length !== pages.length) return levels;
  for (let k = 0; ; ++k) {
    const level = reduced.map((r) => r[k]);
    if (level.some((p) => p === undefined)) break;
    const first = level[0];
    const before = k === 0 ? pages[0] : levels[k - 1][0];
    if (!level.every((p) => p.width === first.width && p.height === first.height && sameKind(p, pages[0]) && READ_COMPRESSION.has(p.compression))) break;
    const fx = before.width / first.width;
    const fy = before.height / first.height;
    if (!(fx >= 1.5 && fy >= 1.5 && Math.abs(fx - fy) / fx < 0.1)) break;
    levels.push(level);
  }
  return levels;
}

/** Every full-resolution page's layout, following the IFD chain; and the file's own coarser levels. */
export async function readTiffStack(file: Blob): Promise<Stack> {
  const head = await bytesAt(file, 0, 16);
  const order = String.fromCharCode(head[0], head[1]);
  if (order !== "II" && order !== "MM") throw new Error("not a TIFF file");
  const little = order === "II";
  const hv = new DataView(head.buffer);
  const version = hv.getUint16(2, little);
  if (version !== 42 && version !== 43) throw new Error("not a TIFF file");
  const big = version === 43;
  let next = big ? Number(hv.getBigUint64(8, little)) : hv.getUint32(4, little);
  const pages: Page[] = [];
  /** Each full page's reduced versions: its SubIFDs, else the reduced pages after it in the chain. */
  const reduced: Page[][] = [];
  let description = "";
  let resolution: [number, number, number] | undefined;
  const seen = new Set<number>();
  while (next !== 0 && !seen.has(next) && next < file.size) {
    seen.add(next);
    const ifd = await readIfd(file, next, little, big);
    next = ifd.next;
    // A reduced-resolution page (thumbnail, pyramid level): a level of the full page before it, perhaps.
    if ((await ifd.one(254, 0)) & 1) {
      const last = reduced[pages.length - 1];
      if (last !== undefined && !(last as { subifds?: boolean }).subifds) {
        const page = await pageOf(ifd, false);
        if (page !== undefined) last.push(page);
      }
      continue;
    }
    const page = (await pageOf(ifd, true))!;
    if (pages.length === 0) {
      description = (await ifd.text(270)) ?? "";
      if (ifd.has(282)) resolution = [await ifd.one(282, 1), await ifd.one(283, 1), await ifd.one(296, 2)];
    } else if (page.width !== pages[0].width || page.height !== pages[0].height || page.bits !== pages[0].bits || page.format !== pages[0].format) {
      continue;
    }
    pages.push(page);
    // SubIFDs (OME-TIFF's and tifffile's pyramids): the page's reduced versions, finest first.
    const subs: Page[] = [];
    for (const at of await ifd.values(330)) {
      if (at <= 0 || at >= file.size) break;
      const sub = await pageOf(await readIfd(file, at, little, big), false);
      if (sub === undefined) break;
      subs.push(sub);
    }
    reduced.push(Object.assign(subs, { subifds: subs.length > 0 }));
  }
  if (pages.length === 0) throw new Error("a TIFF without a full-resolution page");
  // ImageJ writes stacks over 4 GB with one page, the images one after another, uncompressed.
  const images = Number(/^images=(\d+)$/m.exec(description)?.[1]);
  const only = pages[0];
  if (/ImageJ=/.test(description) && pages.length === 1 && images > 1 && only.compression === 1 && !only.tiled) {
    const plane = only.width * only.height * (only.bits / 8);
    const start = only.offsets[0];
    const contiguous = only.offsets.every((o, i) => i === 0 || o === only.offsets[i - 1] + only.counts[i - 1]);
    if (contiguous && start + images * plane <= file.size) {
      for (let i = 1; i < images; ++i) pages.push({ ...only, offsets: only.offsets.map((o) => o + i * plane) });
      reduced.length = 0;
    }
  }
  return { littleEndian: little, pages, description, resolution, levels: ownLevels(pages, reduced) };
}

/** TIFF's LZW (MSB-first codes, 9 to 12 bits, early change). */
export function lzwDecode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let outAt = 0;
  const table: Uint8Array[] = [];
  const reset = () => {
    table.length = 258;
    for (let i = 0; i < 256; ++i) table[i] = Uint8Array.of(i);
  };
  reset();
  let bits = 9;
  let bitPos = 0;
  let previous: Uint8Array | undefined;
  const read = () => {
    let code = 0;
    for (let i = 0; i < bits; ++i) {
      const byte = input[(bitPos + i) >> 3] ?? 0;
      code = (code << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1);
    }
    bitPos += bits;
    return code;
  };
  while (bitPos + bits <= input.length * 8 && outAt < expected) {
    const code = read();
    if (code === 257) break;
    if (code === 256) {
      reset();
      bits = 9;
      previous = undefined;
      continue;
    }
    let entry: Uint8Array;
    if (code < table.length) entry = table[code];
    else if (previous !== undefined) {
      entry = new Uint8Array(previous.length + 1);
      entry.set(previous);
      entry[previous.length] = previous[0];
    } else throw new Error("broken LZW data");
    out.set(entry.subarray(0, Math.min(entry.length, expected - outAt)), outAt);
    outAt += entry.length;
    if (previous !== undefined) {
      const added = new Uint8Array(previous.length + 1);
      added.set(previous);
      added[previous.length] = entry[0];
      table.push(added);
    }
    previous = entry;
    if (table.length + 1 >= 1 << bits && bits < 12) ++bits;
  }
  return out;
}

export function packBitsDecode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (i < input.length && o < expected) {
    const n = (input[i++] << 24) >> 24;
    if (n >= 0) {
      out.set(input.subarray(i, i + n + 1), o);
      i += n + 1;
      o += n + 1;
    } else if (n !== -128) {
      out.fill(input[i++], o, o - n + 1);
      o += -n + 1;
    }
  }
  return out;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A strip or tile's pixels: decompressed, predictor undone, little-endian. */
async function decodeBlock(stack: Pick<Stack, "littleEndian">, page: Page, raw: Uint8Array, width: number, rows: number): Promise<Uint8Array> {
  const size = page.bits / 8;
  const pixel = size * page.samples;
  const expected = width * rows * pixel;
  let data: Uint8Array;
  switch (page.compression) {
    case 1: data = raw; break;
    case 5: data = lzwDecode(raw, expected); break;
    case 8: case 32946: data = await inflate(raw); break;
    case 32773: data = packBitsDecode(raw, expected); break;
    default: throw new Error(`TIFF compression ${page.compression} is not read (none, LZW, deflate and PackBits only)`);
  }
  if (data.byteLength < expected) {
    const padded = new Uint8Array(expected);
    padded.set(data);
    data = padded;
  } else if (data.byteLength > expected) data = data.subarray(0, expected);
  // Uncompressed blocks are views of what was read (several blocks at once), changed in place below: each its own bytes.
  if (page.predictor === 3) return undoFloatPredictor(data, width * page.samples, rows, size, page.samples);
  if (!stack.littleEndian && size > 1) {
    for (let i = 0; i < data.length; i += size) data.subarray(i, i + size).reverse();
  }
  if (page.predictor === 2) {
    // Horizontal differencing: each sample is the change from the same sample of its left neighbour.
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let r = 0; r < rows; ++r) {
      for (let x = 1; x < width; ++x) {
        for (let k = 0; k < page.samples; ++k) {
          const at = (r * width + x) * pixel + k * size;
          const prev = at - pixel;
          if (size === 1) data[at] = (data[at] + data[prev]) & 0xff;
          else if (size === 2) view.setUint16(at, (view.getUint16(at, true) + view.getUint16(prev, true)) & 0xffff, true);
          else if (size === 4) view.setUint32(at, (view.getUint32(at, true) + view.getUint32(prev, true)) >>> 0, true);
        }
      }
    }
  }
  return data;
}

/**
 * Undoes the floating-point predictor (Adobe's, as libtiff writes it): in
 * each row the bytes were split into planes, most significant first (the
 * same whatever the file's byte order), then differenced byte by byte a
 * pixel's samples apart.  Returns the samples little-endian.
 */
function undoFloatPredictor(data: Uint8Array, samples: number, rows: number, size: number, stride: number): Uint8Array {
  const rowBytes = samples * size;
  const out = new Uint8Array(data.length);
  for (let r = 0; r < rows; ++r) {
    const row = data.subarray(r * rowBytes, (r + 1) * rowBytes);
    for (let i = stride; i < rowBytes; ++i) row[i] = (row[i] + row[i - stride]) & 0xff;
    for (let s = 0, at = r * rowBytes; s < samples; ++s, at += size) {
      for (let b = 0; b < size; ++b) out[at + b] = row[(size - 1 - b) * samples + s];
    }
  }
  return out;
}

/** Decoded strips and tiles kept by a TIFF source. */
const BLOCK_CACHE = 256 << 20;
/** Small strips are read several at once, about this many bytes (one read costs about as much as 0.5 MB more). */
const READ_AHEAD = 1 << 20;
/** One read is at most this long. */
const MAX_READ = 32 << 20;

/**
 * Blocks `indices` of a page (strips or tiles, ascending), as stored: runs
 * of blocks that follow one another in the file are read at once (each
 * block then a view of that read).
 */
async function readBlocks(file: Blob, page: Page, indices: number[]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = new Array(indices.length);
  const reads: Promise<void>[] = [];
  for (let i = 0; i < indices.length; ) {
    const start = page.offsets[indices[i]];
    let end = start + page.counts[indices[i]];
    let j = i + 1;
    while (j < indices.length && page.offsets[indices[j]] === end && end + page.counts[indices[j]] - start <= MAX_READ) end += page.counts[indices[j++]];
    const [from, to] = [i, j];
    reads.push(
      bytesAt(file, start, end).then((bytes) => {
        for (let k = from; k < to; ++k) out[k] = bytes.subarray(page.offsets[indices[k]] - start, page.offsets[indices[k]] - start + page.counts[indices[k]]);
      }),
    );
    i = j;
  }
  await Promise.all(reads);
  return out;
}

/**
 * The stack as one array, planes, y, x, little-endian (plane p being page
 * `pageOf(p)`): rows are decoded from their strips or tiles as they are
 * read, the decoded blocks kept for a while.
 */
export function tiffSource(file: Blob, stack: Pick<Stack, "pages" | "littleEndian">, pageOf: (plane: number) => number = (p) => p, planes = stack.pages.length): ByteSource {
  const first = stack.pages[0];
  // RGB(A) is served packed, 4 bytes a pixel (alpha 255 for RGB); 16-bit samples by their top 8 bits.
  const size = first.samples > 1 ? 4 : first.bits / 8;
  const sampleBytes = first.bits / 8;
  const rowBytes = first.width * size;
  const planeBytes = rowBytes * first.height;
  const rgba = (pixels: Uint8Array, samples: number) => {
    if (samples === 1 || (samples === 4 && sampleBytes === 1)) return pixels;
    const n = pixels.length / (samples * sampleBytes);
    const out = new Uint8Array(4 * n);
    // The most significant byte of each (little-endian) sample.
    const top = sampleBytes - 1;
    for (let i = 0; i < n; ++i) {
      for (let k = 0; k < samples; ++k) out[4 * i + k] = pixels[(samples * i + k) * sampleBytes + top];
      if (samples === 3) out[4 * i + 3] = 255;
    }
    return out;
  };
  const blocks = new Lru<Uint8Array>(BLOCK_CACHE);
  const decodedSize = (d: Uint8Array) => d.byteLength;
  const stripRows = (page: Page, b: number) => Math.min(page.blockHeight, page.height - b * page.blockHeight);
  const decodeStrip = async (page: Page, b: number, raw: Uint8Array) => rgba(await decodeBlock(stack, page, raw, page.width, stripRows(page, b)), page.samples);
  /** Strips read at once: as many as make about READ_AHEAD bytes (small strips cost a read each), in aligned groups. */
  const perRead = (page: Page) => (page.tiled ? 1 : Math.max(1, Math.min(64, Math.floor(READ_AHEAD / Math.max(1, rowBytes * page.blockHeight)))));
  /** Rows [b·blockHeight, …) of a page, the whole width: one strip, or one row of tiles. */
  const band = (z: number, b: number) => {
    const page = stack.pages[z];
    const per = perRead(page);
    if (per > 1 && !blocks.has(`${z}:${b}`)) {
      // The strip's group, those not kept yet: read in as few reads as the file allows, then each decoded.
      const first = b - (b % per);
      const wanted: number[] = [];
      for (let i = first; i < Math.min(page.offsets.length, first + per); ++i) if (i === b || !blocks.has(`${z}:${i}`)) wanted.push(i);
      const raws = readBlocks(file, page, wanted);
      raws.catch(() => {});
      wanted.forEach((i, k) => void blocks.get(`${z}:${i}`, async () => decodeStrip(page, i, (await raws)[k]), decodedSize).catch(() => {}));
    }
    return blocks.get(
      `${z}:${b}`,
      async () => {
        const rows = stripRows(page, b);
        if (!page.tiled) return decodeStrip(page, b, await bytesAt(file, page.offsets[b], page.offsets[b] + page.counts[b]));
        const across = Math.ceil(page.width / page.blockWidth);
        const out = new Uint8Array(rows * rowBytes);
        // A row of tiles, read in as few reads as the file allows (tiles usually follow one another).
        const raws = await readBlocks(file, page, Array.from({ length: across }, (_, t) => b * across + t));
        await Promise.all(
          raws.map(async (raw, t) => {
            const tile = rgba(await decodeBlock(stack, page, raw, page.blockWidth, page.blockHeight), page.samples);
            const x0 = t * page.blockWidth;
            const w = Math.min(page.blockWidth, page.width - x0);
            for (let r = 0; r < rows; ++r) out.set(tile.subarray(r * page.blockWidth * size, (r * page.blockWidth + w) * size), (r * page.width + x0) * size);
          }),
        );
        return out;
      },
      decodedSize,
    );
  };
  /** Decodes rows [start, end) into `out`; the blocks wanted are decoded at once. */
  const readInto = async (start: number, end: number, out: Uint8Array): Promise<number> => {
    end = Math.min(end, planeBytes * planes, start + out.byteLength);
    const parts: { at: number; z: number; b: number; from: number; take: number }[] = [];
    for (let at = start; at < end; ) {
      const plane = Math.floor(at / planeBytes);
      const z = pageOf(plane);
      const inPlane = at - plane * planeBytes;
      const page = stack.pages[z];
      const b = Math.floor(Math.floor(inPlane / rowBytes) / page.blockHeight);
      const from = inPlane - b * page.blockHeight * rowBytes;
      const take = Math.min(end - at, Math.min(page.blockHeight, page.height - b * page.blockHeight) * rowBytes - from);
      parts.push({ at, z, b, from, take });
      at += take;
    }
    await Promise.all(
      parts.map(async ({ at, z, b, from, take }) => {
        const data = await band(z, b);
        out.set(data.subarray(from, from + take), at - start);
      }),
    );
    return Math.max(0, end - start);
  };
  return {
    size: planeBytes * planes,
    async read(start, end) {
      const out = new Uint8Array(Math.max(0, Math.min(end, planeBytes * planes) - start));
      await readInto(start, end, out);
      return out;
    },
    readInto,
  };
}

/** Pixel sizes (x, y, z) and their unit, from OME-XML, ImageJ's description, or the resolution tags. */
export function tiffSpacing(stack: Stack): { size: [number, number, number]; unit: "um" | "mm" | "nm" } {
  const d = stack.description;
  const ome = /<Pixels\b[^>]*>/.exec(d)?.[0];
  if (ome !== undefined) {
    const get = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(ome)?.[1];
    const factor = (unit: string | undefined) => (unit === "nm" ? 1e-3 : unit === "mm" ? 1e3 : unit === "m" ? 1e6 : 1);
    const size = (["X", "Y", "Z"] as const).map((a) => {
      const v = Number(get(`PhysicalSize${a}`));
      return Number.isFinite(v) && v > 0 ? v * factor(get(`PhysicalSize${a}Unit`)) : 1;
    }) as [number, number, number];
    return { size, unit: "um" };
  }
  const imagej = /ImageJ=/.test(d);
  const spacing = Number(/spacing=([\d.eE+-]+)/.exec(d)?.[1]);
  const unit = /unit=(\S+)/.exec(d)?.[1]?.replace(/\\u00B5/i, "µ");
  const res = stack.resolution;
  const xy = res !== undefined && res[0] > 0 && res[1] > 0 ? [1 / res[0], 1 / res[1]] : [1, 1];
  if (imagej) {
    const scale = unit === "nm" ? 1e-3 : unit === "mm" ? 1e3 : 1;
    return { size: [xy[0] * scale, xy[1] * scale, (Number.isFinite(spacing) ? spacing : 1) * scale], unit: "um" };
  }
  // Plain resolution tags: pixels per cm (3) or inch (2), as micrometres.
  if (res !== undefined && res[2] === 3) return { size: [xy[0] * 1e4, xy[1] * 1e4, xy[0] * 1e4], unit: "um" };
  return { size: [1, 1, 1], unit: "um" };
}

/**
 * How the pages divide into z planes, channels and time points: OME-XML's
 * SizeZ/C/T and DimensionOrder, ImageJ's slices/channels/frames (always
 * channels fastest), or every page a z plane.
 */
export function tiffLayout(stack: Stack): { z: number; c: number; t: number; order: string } {
  const d = stack.description;
  const n = stack.pages.length;
  const ome = /<Pixels\b[^>]*>/.exec(d)?.[0];
  if (ome !== undefined) {
    const get = (name: string) => Number(new RegExp(`\\s${name}="([^"]*)"`).exec(ome)?.[1] ?? 1);
    const z = get("SizeZ");
    const c = get("SizeC");
    const t = get("SizeT");
    const order = new RegExp(`\\sDimensionOrder="(XY[ZCT]{3})"`).exec(ome)?.[1] ?? "XYZCT";
    if (z * c * t === n) return { z, c, t, order };
  }
  if (/ImageJ=/.test(d)) {
    const get = (name: string) => Number(new RegExp(`${name}=(\\d+)`).exec(d)?.[1] ?? 1);
    const z = get("slices");
    const c = get("channels");
    const t = get("frames");
    if (z * c * t === n) return { z, c, t, order: "XYCZT" };
  }
  return { z: n, c: 1, t: 1, order: "XYZCT" };
}

const NIFTI_TYPE: Record<string, number> = { "1/8": 2, "2/8": 256, "1/16": 512, "2/16": 4, "1/32": 768, "2/32": 8, "3/32": 16, "3/64": 64, "1/64": 1280, "2/64": 1024 };

/**
 * A TIFF stack as an OME-Zarr store (the NIfTI store's), through a header
 * made from its tags: x, y, z, then channels or time points.
 */
export async function openTiff(file: Blob, name: string): Promise<NiftiStore> {
  const stack = await readTiffStack(file);
  const first = stack.pages[0];
  const rgb = first.samples > 1;
  // RGB(A): packed uint32 (768), its pyramid by the nearest pixel, as for labels (intent 1002).
  const datatype = rgb ? 768 : NIFTI_TYPE[`${first.format}/${first.bits}`];
  if (datatype === undefined) throw new Error(`a TIFF of ${first.bits}-bit ${first.format === 3 ? "floats" : "integers"} is not read`);
  const { size } = tiffSpacing(stack);
  const layout = tiffLayout(stack);
  if (layout.c > 1 && layout.t > 1) throw new Error("TIFF stacks with both channels and time points are not read yet");
  // Page index of (z, c, t): the letters after XY run fastest to slowest.
  const stride: Record<string, number> = {};
  let s = 1;
  for (const axis of layout.order.slice(2)) {
    stride[axis] = s;
    s *= axis === "Z" ? layout.z : axis === "C" ? layout.c : layout.t;
  }
  const extra = layout.c > 1 ? "C" : "T";
  const pageOf = (plane: number) => (plane % layout.z) * stride.Z + Math.floor(plane / layout.z) * stride[extra];
  const header: NiftiHeader = {
    version: 1,
    littleEndian: true,
    magic: "n+1",
    dim: layout.c > 1 ? [5, first.width, first.height, layout.z, 1, layout.c, 1, 1] : [layout.t > 1 ? 4 : 3, first.width, first.height, layout.z, layout.t, 1, 1, 1],
    datatype,
    bitpix: rgb ? 32 : first.bits,
    pixdim: [1, size[0], size[1], size[2], 0, 0, 0, 0],
    voxOffset: 0,
    sclSlope: 0,
    sclInter: 0,
    // Micrometres (NIfTI unit code 3).
    xyztUnits: 3,
    toffset: 0,
    intentCode: rgb ? 1002 : 0,
    qformCode: 0,
    sformCode: 0,
    quatern: [0, 0, 0],
    qoffset: [0, 0, 0],
    srow: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    description: `TIFF stack, ${stack.pages.length} pages`,
  };
  const planes = layout.z * layout.c * layout.t;
  const source = tiffSource(file, stack, pageOf, planes);
  // The file's own levels: the same planes, each from its page's reduced version.
  const levels: FileLevel[] = stack.levels.map((pages) => {
    const level = tiffSource(file, { littleEndian: stack.littleEndian, pages }, pageOf, planes);
    const factor = [first.width / pages[0].width, first.height / pages[0].height, 1].map(nominal);
    return { size: [pages[0].width, pages[0].height, layout.z], factor, read: () => Promise.resolve(level) };
  });
  return new NiftiStore(header, () => Promise.resolve(source), name, { rgb, levels, cacheKey: cacheKeyOf(file) });
}

/** A level's scale: the power of two it is within 5 % of (1023 → 512 pixels is 2), else the ratio itself. */
function nominal(ratio: number): number {
  const power = 2 ** Math.round(Math.log2(ratio));
  return Math.abs(ratio - power) / power < 0.05 ? power : ratio;
}
