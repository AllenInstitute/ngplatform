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
 * and the resolution tags.  Reduced-resolution pages (thumbnails, pyramid
 * levels) are skipped.
 */
import { NiftiStore, type NiftiHeader } from "./nifti.js";
import { type ByteSource, Lru } from "./store.js";

export { TIFF_FILE } from "./store.js";

interface Page {
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
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

async function bytesAt(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Every full-resolution page's layout, following the IFD chain. */
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
  let description = "";
  let resolution: [number, number, number] | undefined;
  const seen = new Set<number>();
  while (next !== 0 && !seen.has(next)) {
    seen.add(next);
    const countBytes = await bytesAt(file, next, next + (big ? 8 : 2));
    const cv = new DataView(countBytes.buffer);
    const n = big ? Number(cv.getBigUint64(0, little)) : cv.getUint16(0, little);
    const entrySize = big ? 20 : 12;
    const start = next + (big ? 8 : 2);
    const ifd = await bytesAt(file, start, start + n * entrySize + (big ? 8 : 4));
    const v = new DataView(ifd.buffer);
    const tags = new Map<number, { type: number; count: number; at: number; inline: boolean }>();
    for (let e = 0; e < n; ++e) {
      const at = e * entrySize;
      const tag = v.getUint16(at, little);
      const type = v.getUint16(at + 2, little);
      const count = big ? Number(v.getBigUint64(at + 4, little)) : v.getUint32(at + 4, little);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      const valueAt = at + (big ? 12 : 8);
      const inline = size <= (big ? 8 : 4);
      tags.set(tag, { type, count, inline, at: inline ? valueAt : big ? Number(v.getBigUint64(valueAt, little)) : v.getUint32(valueAt, little) });
    }
    next = big ? Number(v.getBigUint64(n * entrySize, little)) : v.getUint32(n * entrySize, little);
    const values = async (tag: number): Promise<number[]> => {
      const t = tags.get(tag);
      if (t === undefined) return [];
      const size = TYPE_SIZE[t.type] ?? 1;
      const bytes = t.inline ? ifd.subarray(t.at, t.at + size * t.count) : await bytesAt(file, t.at, t.at + size * t.count);
      const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const out: number[] = [];
      for (let i = 0; i < t.count; ++i) {
        const o = i * size;
        switch (t.type) {
          case 1: case 7: out.push(d.getUint8(o)); break;
          case 6: out.push(d.getInt8(o)); break;
          case 3: out.push(d.getUint16(o, little)); break;
          case 8: out.push(d.getInt16(o, little)); break;
          case 4: out.push(d.getUint32(o, little)); break;
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
    const one = async (tag: number, fallback: number) => (await values(tag))[0] ?? fallback;
    // A reduced-resolution page (thumbnail, pyramid level): not part of the stack.
    if ((await one(254, 0)) & 1) continue;
    const samples = await one(277, 1);
    if (samples !== 1) {
      const bits = await one(258, 8);
      if (!((samples === 3 || samples === 4) && (bits === 8 || bits === 16))) throw new Error(`a TIFF with ${samples} samples of ${bits} bits a pixel (one sample, or 8- or 16-bit RGB or RGBA, only)`);
      if ((await one(284, 1)) !== 1) throw new Error("an RGB TIFF with its colours in separate planes (interleaved only)");
    }
    const width = await one(256, 0);
    const height = await one(257, 0);
    const tiled = tags.has(322);
    const page: Page = {
      width,
      height,
      bits: await one(258, 1),
      samples,
      format: await one(339, 1),
      compression: await one(259, 1),
      predictor: await one(317, 1),
      offsets: await values(tiled ? 324 : 273),
      counts: await values(tiled ? 325 : 279),
      blockWidth: tiled ? await one(322, width) : width,
      blockHeight: tiled ? await one(323, height) : Math.min(height, await one(278, height)),
      tiled,
    };
    if (pages.length === 0) {
      const t = tags.get(270);
      if (t !== undefined) {
        const bytes = t.inline ? ifd.subarray(t.at, t.at + t.count) : await bytesAt(file, t.at, t.at + t.count);
        description = new TextDecoder().decode(bytes).replace(/\0+$/, "");
      }
      if (tags.has(282)) resolution = [await one(282, 1), await one(283, 1), await one(296, 2)];
    } else if (page.width !== pages[0].width || page.height !== pages[0].height || page.bits !== pages[0].bits || page.format !== pages[0].format) {
      continue;
    }
    pages.push(page);
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
    }
  }
  return { littleEndian: little, pages, description, resolution };
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
async function decodeBlock(stack: Stack, page: Page, raw: Uint8Array, width: number, rows: number): Promise<Uint8Array> {
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
  } else if (data.byteLength > expected || data.byteOffset !== 0) data = data.slice(0, expected);
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

/**
 * The stack as one array, planes, y, x, little-endian (plane p being page
 * `pageOf(p)`): rows are decoded from their strips or tiles as they are
 * read, the decoded blocks kept for a while.
 */
export function tiffSource(file: Blob, stack: Stack, pageOf: (plane: number) => number = (p) => p, planes = stack.pages.length): ByteSource {
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
  const blocks = new Lru<Uint8Array>(128 << 20);
  /** Rows [b·blockHeight, …) of a page, the whole width: one strip, or one row of tiles. */
  const band = (z: number, b: number) =>
    blocks.get(
      `${z}:${b}`,
      async () => {
        const page = stack.pages[z];
        const rows = Math.min(page.blockHeight, page.height - b * page.blockHeight);
        if (!page.tiled) {
          const raw = await bytesAt(file, page.offsets[b], page.offsets[b] + page.counts[b]);
          return rgba(await decodeBlock(stack, page, raw, page.width, rows), page.samples);
        }
        const across = Math.ceil(page.width / page.blockWidth);
        const out = new Uint8Array(rows * rowBytes);
        await Promise.all(
          Array.from({ length: across }, async (_, t) => {
            const index = b * across + t;
            const raw = await bytesAt(file, page.offsets[index], page.offsets[index] + page.counts[index]);
            const tile = rgba(await decodeBlock(stack, page, raw, page.blockWidth, page.blockHeight), page.samples);
            const x0 = t * page.blockWidth;
            const w = Math.min(page.blockWidth, page.width - x0);
            for (let r = 0; r < rows; ++r) out.set(tile.subarray(r * page.blockWidth * size, (r * page.blockWidth + w) * size), (r * page.width + x0) * size);
          }),
        );
        return out;
      },
      (d) => d.byteLength,
    );
  return {
    size: planeBytes * planes,
    async read(start, end) {
      const out = new Uint8Array(Math.max(0, end - start));
      let at = start;
      while (at < end) {
        const plane = Math.floor(at / planeBytes);
        if (plane >= planes) break;
        const z = pageOf(plane);
        const inPlane = at - plane * planeBytes;
        const y = Math.floor(inPlane / rowBytes);
        const page = stack.pages[z];
        const b = Math.floor(y / page.blockHeight);
        const data = await band(z, b);
        const from = inPlane - b * page.blockHeight * rowBytes;
        const take = Math.min(end - at, data.byteLength - from);
        out.set(data.subarray(from, from + take), at - start);
        at += take;
      }
      return out;
    },
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
  const source = tiffSource(file, stack, pageOf, layout.z * layout.c * layout.t);
  return new NiftiStore(header, () => Promise.resolve(source), name, { rgb });
}
