// chunkmirage's GeoTIFF source (vendor/chunkmirage/web/src/sources.ts) read through the
// geotiff package the app pins: a tiled, two-level float GeoTIFF with a mask page, served
// by range as a bucket serves a COG. Its levels, placement, tiles and no-data are checked,
// so a change of geotiff that reads any of them differently fails here.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSource } from "chunkmirage-web/sources";

type Value = number[] | string;
interface Page { width: number; height: number; tile: number; bits: 8 | 32; format: 1 | 3; subfile: number; pixel: (y: number, x: number) => number; geo?: boolean }

const NODATA = -9999;
const SCALE = [2.5, 2.5, 0], TIE = [0, 0, 0, 500000, 4100000, 0];

/** A little-endian classic TIFF of tiled, uncompressed, one-sample pages. */
function tiff(pages: Page[]): ArrayBuffer {
  const parts: Uint8Array[] = [];
  let size = 8;
  const put = (b: Uint8Array) => { const at = size; parts.push(b); size += b.length + (b.length & 1); if (b.length & 1) parts.push(new Uint8Array(1)); return at; };
  const header = new DataView(new ArrayBuffer(8));
  header.setUint16(0, 0x4949, true); header.setUint16(2, 42, true);
  parts.push(new Uint8Array(header.buffer));
  let link = 4;  // where the previous IFD's "next" offset is written
  const links: [number, number][] = [];
  for (const p of pages) {
    const across = Math.ceil(p.width / p.tile), down = Math.ceil(p.height / p.tile), bytes = p.bits / 8;
    const offsets: number[] = [], counts: number[] = [];
    for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) {
      const t = new DataView(new ArrayBuffer(p.tile * p.tile * bytes));
      for (let y = 0; y < p.tile; y++) for (let x = 0; x < p.tile; x++) {
        const Y = ty * p.tile + y, X = tx * p.tile + x, v = Y < p.height && X < p.width ? p.pixel(Y, X) : 0, i = (y * p.tile + x) * bytes;
        if (p.bits === 32) t.setFloat32(i, v, true); else t.setUint8(i, v);
      }
      offsets.push(put(new Uint8Array(t.buffer))); counts.push(t.byteLength);
    }
    // tag: [type, values]; type 3 SHORT, 4 LONG, 12 DOUBLE, 2 ASCII
    const tags: [number, number, Value][] = [
      [254, 4, [p.subfile]], [256, 4, [p.width]], [257, 4, [p.height]], [258, 3, [p.bits]], [259, 3, [1]],
      [262, 3, [1]], [277, 3, [1]], [322, 4, [p.tile]], [323, 4, [p.tile]], [324, 4, offsets], [325, 4, counts], [339, 3, [p.format]],
      ...(p.geo ? [[33550, 12, SCALE], [33922, 12, TIE], [42113, 2, `${NODATA}\0`]] as [number, number, Value][] : []),
    ];
    const width = (type: number) => ({ 2: 1, 3: 2, 4: 4, 12: 8 })[type]!;
    const ifd = new DataView(new ArrayBuffer(2 + tags.length * 12 + 4));
    ifd.setUint16(0, tags.length, true);
    tags.forEach(([tag, type, value], k) => {
      const n = typeof value === "string" ? value.length : value.length, e = 2 + k * 12;
      const v = new DataView(new ArrayBuffer(n * width(type)));
      for (let i = 0; i < n; i++) {
        if (typeof value === "string") v.setUint8(i, value.charCodeAt(i));
        else if (type === 3) v.setUint16(i * 2, value[i], true);
        else if (type === 4) v.setUint32(i * 4, value[i], true);
        else v.setFloat64(i * 8, value[i], true);
      }
      ifd.setUint16(e, tag, true); ifd.setUint16(e + 2, type, true); ifd.setUint32(e + 4, n, true);
      if (v.byteLength <= 4) new Uint8Array(ifd.buffer).set(new Uint8Array(v.buffer), e + 8);
      else ifd.setUint32(e + 8, put(new Uint8Array(v.buffer)), true);
    });
    const at = put(new Uint8Array(ifd.buffer));
    links.push([link, at]); link = at + 2 + tags.length * 12;
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  for (const [where, to] of links) new DataView(out.buffer).setUint32(where, to, true);
  return out.buffer;
}

const full = (y: number, x: number) => (y >= 10 && y < 20 && x >= 5 && x < 30 ? NODATA : y * 1000 + x);
const half = (y: number, x: number) => y * 10 + x + 0.5;
const FILE = tiff([
  { width: 100, height: 70, tile: 32, bits: 32, format: 3, subfile: 0, pixel: full, geo: true },
  { width: 50, height: 35, tile: 16, bits: 32, format: 3, subfile: 1, pixel: half },
  { width: 100, height: 70, tile: 32, bits: 8, format: 1, subfile: 4, pixel: (y, x) => (full(y, x) === NODATA ? 0 : 255) },
]);

/** A bucket that serves FILE by range. */
function serve() {
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get("range") ?? "");
    if (!range) return new Response(FILE, { status: 200 });
    const lo = +range[1], hi = Math.min(+range[2], FILE.byteLength - 1);
    return new Response(FILE.slice(lo, hi + 1), { status: 206, headers: { "content-range": `bytes ${lo}-${hi}/${FILE.byteLength}` } });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("chunkmirage's GeoTIFF source", () => {
  it("reads the pages as levels, without the mask, placed by the GeoTIFF's tags", async () => {
    serve();
    const s = await openSource("https://bucket/dem.tif");
    expect(s.dtype).toBe("float32");
    expect(s.levels).toEqual([
      { shape: [1, 70, 100], voxel: [1, 2.5, 2.5], origin: [0, -4100000 + 1.25, 500000 + 1.25], chunks: [1, 32, 32] },
      { shape: [1, 35, 50], voxel: [1, 5, 5], origin: [0, -4100000 + 2.5, 500000 + 2.5], chunks: [1, 16, 16] },
    ]);
    expect(s.geo).toEqual({ bbox: [500000, 4100000 - 70 * 2.5, 500000 + 100 * 2.5, 4100000] });
  });

  it("reads a region across tiles and image edges, with no-data as NaN", async () => {
    serve();
    const s = await openSource("https://bucket/dem.tif");
    const lo = [0, 5, 20], hi = [1, 70, 100];
    const got = Array.from(await s.read(0, 0, lo, hi) as ArrayLike<number>);
    const want: number[] = [];
    for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[2]; x < hi[2]; x++) want.push(full(y, x) === NODATA ? NaN : full(y, x));
    expect(got).toEqual(want);
    expect(got.filter(Number.isNaN)).toHaveLength(10 * 10);
    const small = Array.from(await s.read(1, 0, [0, 30, 40], [1, 35, 50]) as ArrayLike<number>);
    expect(small).toEqual(Array.from({ length: 50 }, (_, i) => half(30 + Math.floor(i / 10), 40 + (i % 10))));
  });
});
