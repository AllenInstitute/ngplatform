import { describe, expect, it } from "vitest";
import { evenBox, frameName, multiply, sweepFrames, trimBox, turntableFrames, unionBox, type Quaternion } from "../src/core/capture.js";
import { encodeGif, indexPixels, lzwEncode, quantise, type RgbaImage } from "../src/core/gif.js";
import { listBoxes, muxMp4 } from "../src/core/mp4.js";
import { crc32, zipStore } from "../src/core/zip.js";

/** A GIF decoder, as the format describes it, to read back what the encoder wrote. */
function decodeGif(bytes: Uint8Array): { width: number; height: number; loop: number | undefined; frames: { delay: number; pixels: [number, number, number][] }[] } {
  let at = 0;
  const byte = () => bytes[at++];
  const word = () => bytes[at++] | (bytes[at++] << 8);
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header !== "GIF89a") throw new Error(`not a GIF: ${header}`);
  at = 6;
  const width = word();
  const height = word();
  const flags = byte();
  at += 2;
  if (flags & 0x80) at += 3 << ((flags & 7) + 1);
  let loop: number | undefined;
  let delay = 0;
  const frames: { delay: number; pixels: [number, number, number][] }[] = [];
  for (;;) {
    const block = byte();
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = byte();
      if (label === 0xf9) {
        at += 1;
        at += 1;
        delay = word();
        at += 2;
      } else if (label === 0xff) {
        const size = byte();
        const app = String.fromCharCode(...bytes.subarray(at, at + size));
        at += size;
        if (app === "NETSCAPE2.0") {
          at += 2;
          loop = word();
          at += 1;
        } else while (byte() !== 0) at += bytes[at - 1];
      }
      continue;
    }
    if (block !== 0x2c) throw new Error(`unexpected block ${block}`);
    at += 4;
    const w = word();
    const h = word();
    const f = byte();
    const tableSize = 1 << ((f & 7) + 1);
    const table = bytes.subarray(at, at + 3 * tableSize);
    at += 3 * tableSize;
    const minCode = byte();
    const data: number[] = [];
    for (let size = byte(); size !== 0; size = byte()) {
      data.push(...bytes.subarray(at, at + size));
      at += size;
    }
    // LZW decode.
    const clear = 1 << minCode;
    const end = clear + 1;
    let codeSize = minCode + 1;
    let dict: number[][] = [];
    const reset = () => {
      dict = Array.from({ length: clear + 2 }, (_, i) => (i < clear ? [i] : []));
      codeSize = minCode + 1;
    };
    reset();
    const out: number[] = [];
    let bitPos = 0;
    let prev: number[] | undefined;
    const read = () => {
      let code = 0;
      for (let i = 0; i < codeSize; ++i, ++bitPos) code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
      return code;
    };
    for (;;) {
      const code = read();
      if (code === clear) {
        reset();
        prev = undefined;
        continue;
      }
      if (code === end) break;
      let entry: number[];
      if (code < dict.length) entry = dict[code];
      else if (code === dict.length && prev) entry = [...prev, prev[0]];
      else throw new Error(`bad code ${code}`);
      out.push(...entry);
      if (prev) {
        dict.push([...prev, entry[0]]);
        if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
      }
      prev = entry;
    }
    expect(out.length).toBe(w * h);
    frames.push({ delay, pixels: out.map((i) => [table[3 * i], table[3 * i + 1], table[3 * i + 2]]) });
  }
  return { width, height, loop, frames };
}

function image(width: number, height: number, colour: (x: number, y: number) => [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; ++y)
    for (let x = 0; x < width; ++x) {
      const c = colour(x, y);
      data.set([...c, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}

describe("GIF encoding", () => {
  it("writes a tiny two-frame image that decodes to the same pixels", () => {
    const a = image(5, 3, (x, y) => (x === y ? [255, 0, 0] : [0, 0, 255]));
    const b = image(5, 3, (x) => (x < 2 ? [0, 255, 0] : [255, 255, 255]));
    const gif = encodeGif([a, b], { delay: 10 });
    const decoded = decodeGif(gif);
    expect(decoded.width).toBe(5);
    expect(decoded.height).toBe(3);
    expect(decoded.loop).toBe(0);
    expect(decoded.frames.map((f) => f.delay)).toEqual([10, 10]);
    const expected = (img: RgbaImage) => Array.from({ length: img.width * img.height }, (_, p) => [img.data[4 * p], img.data[4 * p + 1], img.data[4 * p + 2]]);
    expect(decoded.frames[0].pixels).toEqual(expected(a));
    expect(decoded.frames[1].pixels).toEqual(expected(b));
  });

  it("keeps a frame rate that is not whole hundredths: 30 a second alternates 3, 3, 4", () => {
    const a = image(2, 2, () => [0, 0, 0]);
    const decoded = decodeGif(encodeGif([a, a, a, a, a, a], { delay: 100 / 30 }));
    const delays = decoded.frames.map((f) => f.delay);
    expect(delays).toEqual([3, 4, 3, 3, 4, 3]);
    expect(delays.reduce((s, d) => s + d, 0)).toBe(20);
  });

  it("compresses long runs past the 12-bit dictionary, and still decodes", () => {
    // Noise in 200 grey levels, enough codes to fill the table and clear it.
    let seed = 1;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 200);
    const noisy = image(120, 90, () => {
      const v = random();
      return [v, v, v];
    });
    const decoded = decodeGif(encodeGif([noisy], { delay: 5, loop: 3 }));
    expect(decoded.loop).toBe(3);
    const pixels = decoded.frames[0].pixels;
    // 200 greys fit a 256-colour palette exactly.
    for (let p = 0; p < pixels.length; p += 97) expect(pixels[p]).toEqual([noisy.data[4 * p], noisy.data[4 * p + 1], noisy.data[4 * p + 2]]);
  });

  it("reduces many colours to 256 close ones", () => {
    const rainbow = image(64, 64, (x, y) => [x * 4, y * 4, (x * y) % 256]);
    const palette = quantise(rainbow);
    expect(palette.length).toBe(256 * 3);
    const indices = indexPixels(rainbow, palette);
    let worst = 0;
    for (let p = 0; p < indices.length; ++p) {
      for (let c = 0; c < 3; ++c) worst = Math.max(worst, Math.abs(palette[3 * indices[p] + c] - rainbow.data[4 * p + c]));
    }
    expect(worst).toBeLessThan(64);
  });

  it("ends the LZW stream with a zero-length block", () => {
    const bytes: number[] = [];
    lzwEncode(new Uint8Array([0, 1, 0, 1, 0, 1]), 2, { byte: (b) => bytes.push(b) });
    expect(bytes[0]).toBe(2);
    expect(bytes[bytes.length - 1]).toBe(0);
  });
});

describe("zip of frames", () => {
  it("stores files with their CRCs and a central directory", async () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const files = [
      { name: "frame_0001.png", data: new Uint8Array([1, 2, 3]) },
      { name: "frame_0002.png", data: new Uint8Array([4, 5]) },
    ];
    const zip = new Uint8Array(await new Blob(zipStore(files)).arrayBuffer());
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    const directory = view.getUint32(end + 16, true);
    expect(view.getUint32(directory, true)).toBe(0x02014b50);
    // The second file's data, at its local header's offset.
    const second = view.getUint32(directory + 46 + files[0].name.length + 42, true);
    expect(Array.from(zip.subarray(second + 30 + 14, second + 30 + 14 + 2))).toEqual([4, 5]);
  });
});

describe("MP4", () => {
  it("puts H.264 samples in one track with their sizes, key frames and offset", () => {
    const samples = [
      { data: new Uint8Array([0, 0, 0, 2, 0x65, 0x88]), key: true },
      { data: new Uint8Array([0, 0, 0, 1, 0x41]), key: false },
      { data: new Uint8Array([0, 0, 0, 1, 0x41]), key: false },
    ];
    const mp4 = muxMp4(samples, { width: 64, height: 48, fps: 12, avcC: new Uint8Array([1, 0x42, 0, 0x1f, 0xff, 0xe1]) });
    const top = listBoxes(mp4);
    expect(top.map((b) => b.type)).toEqual(["ftyp", "mdat", "moov"]);
    expect(top[1].size).toBe(8 + 16);
    // The samples sit at the start of mdat's data, as stco says.
    const text = String.fromCharCode(...mp4);
    const stco = text.indexOf("stco");
    const offset = new DataView(mp4.buffer).getUint32(stco + 12);
    expect(offset).toBe(top[1].offset + 8);
    expect(Array.from(mp4.subarray(offset, offset + 6))).toEqual([0, 0, 0, 2, 0x65, 0x88]);
    for (const type of ["mvhd", "tkhd", "mdhd", "hdlr", "avc1", "avcC", "stts", "stss", "stsz", "stsc"]) expect(text.includes(type), type).toBe(true);
    // Twelve frames a second: 3 frames last 250 ms (timescale 12000, 1000 ticks each).
    const mvhd = text.indexOf("mvhd");
    const view = new DataView(mp4.buffer);
    expect(view.getUint32(mvhd + 16)).toBe(12000);
    expect(view.getUint32(mvhd + 20)).toBe(3000);
    const stss = text.indexOf("stss");
    expect(view.getUint32(stss + 8)).toBe(1);
    expect(view.getUint32(stss + 12)).toBe(1);
  });
});

describe("capture planning", () => {
  it("sweeps a dimension in steps, either way, ends included", () => {
    expect(sweepFrames(2, 0.5, 3.5, 1).map((f) => f.value)).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(sweepFrames(2, 3.5, 0.5, 1.5).map((f) => f.value)).toEqual([3.5, 2, 0.5]);
    expect(sweepFrames(0, 0, 1, 0)).toEqual([]);
  });

  it("turns the 3-D view once about its own vertical axis", () => {
    const start: Quaternion = [0, 0, 0, 1];
    const frames = turntableFrames(start, 4);
    expect(frames).toHaveLength(4);
    expect(frames[0].orientation).toEqual([0, 0, 0, 1]);
    const quarter = frames[1].orientation;
    expect(quarter[1]).toBeCloseTo(Math.SQRT1_2);
    expect(quarter[3]).toBeCloseTo(Math.SQRT1_2);
    // From a tilted start, the turn is about the view's axis: start × turn.
    const tilted: Quaternion = [Math.sin(0.3), 0, 0, Math.cos(0.3)];
    const turned = turntableFrames(tilted, 8)[2].orientation;
    const expected = multiply(tilted, [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]);
    turned.forEach((v, i) => expect(v).toBeCloseTo(expected[i]));
  });

  it("trims a picture to what differs from its background, with a margin", () => {
    const img = image(10, 8, (x, y) => (x >= 3 && x <= 5 && y >= 2 && y <= 6 ? [200, 100, 50] : [0, 0, 0]));
    expect(trimBox(img.data, 10, 8)).toEqual({ x: 3, y: 2, width: 3, height: 5 });
    expect(trimBox(img.data, 10, 8, 2)).toEqual({ x: 1, y: 0, width: 7, height: 8 });
    const empty = image(4, 4, () => [255, 255, 255]);
    expect(trimBox(empty.data, 4, 4)).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(unionBox([{ x: 3, y: 2, width: 3, height: 5 }, { x: 1, y: 4, width: 2, height: 1 }])).toEqual({ x: 1, y: 2, width: 5, height: 5 });
    expect(evenBox({ x: 3, y: 2, width: 3, height: 5 }, 10, 8)).toEqual({ x: 3, y: 2, width: 4, height: 6 });
    expect(evenBox({ x: 7, y: 0, width: 3, height: 8 }, 10, 8)).toEqual({ x: 6, y: 0, width: 4, height: 8 });
  });

  it("numbers frames so they sort", () => {
    expect(frameName("frame_", 0, 12)).toBe("frame_0001.png");
    expect(frameName("frame_", 41, 12000)).toBe("frame_00042.png");
  });
});
