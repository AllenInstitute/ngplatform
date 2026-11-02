/**
 * A minimal MP4 (ISO base media file) writer for one H.264 video track: the
 * frames WebCodecs' VideoEncoder makes (in "avc" form, with its avcC
 * description), at a constant frame rate, in one file the usual players
 * open.  ftyp, mdat, then moov, so it can be written after the frames.
 */

export interface Mp4Sample {
  data: Uint8Array;
  /** A key frame (an IDR picture), where playback can start. */
  key: boolean;
}

export interface Mp4Options {
  width: number;
  height: number;
  /** Frames a second. */
  fps: number;
  /** The encoder's AVCDecoderConfigurationRecord (decoderConfig.description). */
  avcC: Uint8Array;
}

function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function u16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff];
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** A box: its size, its type, then its contents. */
function box(type: string, ...contents: (number[] | Uint8Array)[]): Uint8Array {
  const size = 8 + contents.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(size);
  out.set([...u32(size), ...ascii(type)]);
  let at = 8;
  for (const c of contents) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A full box: a box with a version and flags. */
function fullBox(type: string, version: number, flags: number, ...contents: (number[] | Uint8Array)[]): Uint8Array {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...contents);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].flatMap(u32);

export function muxMp4(samples: Mp4Sample[], options: Mp4Options): Uint8Array {
  const { width, height, avcC } = options;
  // A timescale in which each frame lasts a whole number of ticks.
  const timescale = Math.round(options.fps * 1000);
  const frameTicks = 1000;
  const duration = samples.length * frameTicks;
  const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso2avc1mp41"));
  const payload = samples.reduce((s, x) => s + x.data.length, 0);
  // mdat with a 64-bit size if it needs one.
  const large = payload + 8 > 0xffffffff;
  const mdatHeader = large ? new Uint8Array([...u32(1), ...ascii("mdat"), ...u32(Math.floor((payload + 16) / 2 ** 32)), ...u32((payload + 16) >>> 0)]) : new Uint8Array([...u32(payload + 8), ...ascii("mdat")]);
  const dataStart = ftyp.length + mdatHeader.length;

  const tkhd = fullBox("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16));
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
  const hdlr = fullBox("hdlr", 0, 0, u32(0), ascii("vide"), u32(0), u32(0), u32(0), ascii("VideoHandler"), [0]);
  const vmhd = fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const avc1 = box(
    "avc1",
    [0, 0, 0, 0, 0, 0],
    u16(1), // data reference index
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    new Array(32).fill(0),
    u16(0x18),
    u16(0xffff),
    box("avcC", avcC),
  );
  const stsd = fullBox("stsd", 0, 0, u32(1), avc1);
  const stts = fullBox("stts", 0, 0, u32(1), u32(samples.length), u32(frameTicks));
  const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter((i) => i > 0);
  const stss = fullBox("stss", 0, 0, u32(keys.length), keys.flatMap(u32));
  // All samples in one chunk.
  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(samples.length), u32(1));
  const stsz = fullBox("stsz", 0, 0, u32(0), u32(samples.length), samples.flatMap((s) => u32(s.data.length)));
  const stco = dataStart + payload > 0xffffffff ? fullBox("co64", 0, 0, u32(1), u32(Math.floor(dataStart / 2 ** 32)), u32(dataStart >>> 0)) : fullBox("stco", 0, 0, u32(1), u32(dataStart));
  const stbl = box("stbl", stsd, stts, stss, stsc, stsz, stco);
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", tkhd, mdia);
  const mvhd = fullBox("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(2));
  const moov = box("moov", mvhd, trak);

  const out = new Uint8Array(dataStart + payload + moov.length);
  out.set(ftyp, 0);
  out.set(mdatHeader, ftyp.length);
  let at = dataStart;
  for (const s of samples) {
    out.set(s.data, at);
    at += s.data.length;
  }
  out.set(moov, at);
  return out;
}

/** The boxes of an MP4, as (type, offset, size), for tests and checks. */
export function listBoxes(data: Uint8Array, start = 0, end = data.length): { type: string; offset: number; size: number }[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: { type: string; offset: number; size: number }[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    if (size === 1) size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
    if (size < 8) break;
    out.push({ type, offset: at, size });
    at += size;
  }
  return out;
}
