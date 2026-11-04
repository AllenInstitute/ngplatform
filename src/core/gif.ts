/**
 * An animated GIF encoder: each frame gets its own palette of up to 256
 * colours (median cut over a sample of its pixels), its pixels the nearest
 * of them (no dithering, so labels and edges stay clean), compressed with
 * GIF's LZW.  Enough for movies of the views; written here so the app needs
 * no library for it.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA bytes, row by row (as ImageData has them). */
  data: Uint8ClampedArray | Uint8Array;
}

export interface GifOptions {
  /** Time each frame shows, in hundredths of a second. */
  delay: number;
  /** Times to play: 0 for ever. */
  loop?: number;
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private buf = new Uint8Array(1 << 16);
  private n = 0;
  byte(b: number): void {
    if (this.n === this.buf.length) this.flush();
    this.buf[this.n++] = b;
  }
  word(w: number): void {
    this.byte(w & 0xff);
    this.byte((w >> 8) & 0xff);
  }
  bytes(bs: ArrayLike<number>): void {
    for (let i = 0; i < bs.length; ++i) this.byte(bs[i]);
  }
  text(s: string): void {
    for (let i = 0; i < s.length; ++i) this.byte(s.charCodeAt(i));
  }
  private flush(): void {
    this.chunks.push(this.buf.slice(0, this.n));
    this.n = 0;
  }
  result(): Uint8Array {
    this.flush();
    const total = this.chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** Up to `max` colours representing an image's pixels (median cut on a sample). */
export function quantise(image: RgbaImage, max = 256): Uint8Array {
  const { data } = image;
  const pixels = data.length / 4;
  // A sample of at most ~64k pixels, as 15-bit colours with counts.
  const stride = Math.max(1, Math.floor(pixels / 65536));
  const counts = new Map<number, number>();
  for (let p = 0; p < pixels; p += stride) {
    const i = p * 4;
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  type Box = { colours: [number, number, number, number][] };
  const all: [number, number, number, number][] = [...counts].map(([k, c]) => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4, c]);
  // Few colours: use them as they are (exactly, from the image).
  if (all.length <= max) {
    const exact = new Map<number, [number, number, number]>();
    for (let p = 0; p < pixels && exact.size <= max; ++p) {
      const i = p * 4;
      exact.set((data[i] << 16) | (data[i + 1] << 8) | data[i + 2], [data[i], data[i + 1], data[i + 2]]);
    }
    if (exact.size <= max) return Uint8Array.from([...exact.values()].flat());
  }
  let boxes: Box[] = [{ colours: all }];
  while (boxes.length < max) {
    // Split the box with the widest channel range weighted by its pixel count.
    let best = -1;
    let bestScore = 0;
    let bestChannel = 0;
    boxes.forEach((box, b) => {
      if (box.colours.length < 2) return;
      let weight = 0;
      for (const c of box.colours) weight += c[3];
      for (let ch = 0; ch < 3; ++ch) {
        let lo = 255;
        let hi = 0;
        for (const c of box.colours) {
          if (c[ch] < lo) lo = c[ch];
          if (c[ch] > hi) hi = c[ch];
        }
        const score = (hi - lo) * Math.sqrt(weight);
        if (score > bestScore) {
          bestScore = score;
          best = b;
          bestChannel = ch;
        }
      }
    });
    if (best < 0) break;
    const colours = boxes[best].colours.sort((a, b) => a[bestChannel] - b[bestChannel]);
    let total = 0;
    for (const c of colours) total += c[3];
    let acc = 0;
    let cut = 1;
    for (; cut < colours.length - 1; ++cut) {
      acc += colours[cut - 1][3];
      if (acc >= total / 2) break;
    }
    boxes = [...boxes.slice(0, best), { colours: colours.slice(0, cut) }, { colours: colours.slice(cut) }, ...boxes.slice(best + 1)];
  }
  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, b) => {
    let w = 0;
    const sum = [0, 0, 0];
    for (const c of box.colours) {
      w += c[3];
      for (let ch = 0; ch < 3; ++ch) sum[ch] += c[ch] * c[3];
    }
    for (let ch = 0; ch < 3; ++ch) palette[b * 3 + ch] = Math.round(sum[ch] / Math.max(1, w));
  });
  return palette;
}

/** Each pixel's palette index (nearest colour, cached by 18-bit colour). */
export function indexPixels(image: RgbaImage, palette: Uint8Array): Uint8Array {
  const { data } = image;
  const n = data.length / 4;
  const out = new Uint8Array(n);
  const cache = new Int16Array(1 << 18).fill(-1);
  const size = palette.length / 3;
  for (let p = 0; p < n; ++p) {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let index = cache[key];
    if (index < 0) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < size; ++c) {
        const dr = r - palette[c * 3];
        const dg = g - palette[c * 3 + 1];
        const db = b - palette[c * 3 + 2];
        const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
          if (d === 0) break;
        }
      }
      index = cache[key] = best;
    }
    out[p] = index;
  }
  return out;
}

/** GIF's variable-length-code LZW, in sub-blocks of at most 255 bytes. */
export function lzwEncode(indices: Uint8Array, minCodeSize: number, out: { byte(b: number): void }): void {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  // Dictionary: (prefix code << 8 | byte) -> code.
  let dict = new Map<number, number>();
  const block: number[] = [];
  let bits = 0;
  let nbits = 0;
  const emit = (code: number) => {
    bits |= code << nbits;
    nbits += codeSize;
    while (nbits >= 8) {
      block.push(bits & 0xff);
      bits >>>= 8;
      nbits -= 8;
      if (block.length === 255) flushBlock();
    }
  };
  const flushBlock = () => {
    if (block.length === 0) return;
    out.byte(block.length);
    for (const b of block) out.byte(b);
    block.length = 0;
  };
  out.byte(minCodeSize);
  emit(clear);
  if (indices.length > 0) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; ++i) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        dict.set(key, next++);
        // The decoder widens its codes once the next code no longer fits.
        if (next > 1 << codeSize && codeSize < 12) codeSize++;
      } else {
        emit(clear);
        dict = new Map();
        codeSize = minCodeSize + 1;
        next = end + 1;
      }
      prefix = k;
    }
    emit(prefix);
  }
  emit(end);
  if (nbits > 0) {
    block.push(bits & 0xff);
    if (block.length === 255) flushBlock();
  }
  flushBlock();
  out.byte(0);
}

/** Writes a GIF a frame at a time, so a long movie need not be held whole. */
export class GifEncoder {
  private readonly w = new ByteWriter();
  private width = 0;
  private height = 0;
  private frames = 0;
  /** Hundredths of a second written so far, and wanted so far: each delay is whole, the rounding carried on. */
  private written = 0;

  constructor(private readonly options: GifOptions) {}

  addFrame(frame: RgbaImage): void {
    const { w } = this;
    if (this.frames === 0) {
      this.width = frame.width;
      this.height = frame.height;
      w.text("GIF89a");
      w.word(frame.width);
      w.word(frame.height);
      w.byte(0x00); // no global colour table
      w.byte(0);
      w.byte(0);
      // Netscape looping extension.
      w.bytes([0x21, 0xff, 0x0b]);
      w.text("NETSCAPE2.0");
      w.bytes([0x03, 0x01]);
      w.word(this.options.loop ?? 0);
      w.byte(0);
    } else if (frame.width !== this.width || frame.height !== this.height) {
      throw new Error("Every frame of a GIF must be the same size.");
    }
    this.frames++;
    const palette = quantise(frame);
    const indices = indexPixels(frame, palette);
    // A power-of-two table of at least 2 entries.
    let bits = 1;
    while (1 << bits < palette.length / 3) bits++;
    // Graphic control: the delay, no transparency, frames replace each other.
    w.bytes([0x21, 0xf9, 0x04, 0x04]);
    // A GIF's delays are whole hundredths: 30 frames a second alternate 3, 3, 4 so the movie keeps its length.
    const delay = Math.max(0, Math.round(this.frames * this.options.delay) - this.written);
    this.written += delay;
    w.word(delay);
    w.bytes([0x00, 0x00]);
    // Image descriptor with a local colour table.
    w.byte(0x2c);
    w.word(0);
    w.word(0);
    w.word(frame.width);
    w.word(frame.height);
    w.byte(0x80 | (bits - 1));
    const table = new Uint8Array(3 << bits);
    table.set(palette);
    w.bytes(table);
    lzwEncode(indices, Math.max(2, bits), w);
  }

  finish(): Uint8Array {
    if (this.frames === 0) throw new Error("No frames to encode.");
    this.w.byte(0x3b);
    return this.w.result();
  }
}

/** An animated GIF of `frames` (all the size of the first). */
export function encodeGif(frames: RgbaImage[], options: GifOptions): Uint8Array {
  const encoder = new GifEncoder(options);
  for (const frame of frames) encoder.addFrame(frame);
  return encoder.finish();
}
