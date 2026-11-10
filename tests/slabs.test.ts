/**
 * Slabs (src/virtual/images/slabs.ts): widths, the slabs of a level and the
 * finer slabs under a coarser one (tiling exactly, on the finer chunks, odd
 * chunk sizes and halving only some axes too), chunks cut from a slab and
 * put back, and the reducer's means and first voxels against brute force.
 * Then a store's coarser levels made from slabs, and Export's one pass
 * (`eachChunk`) handing over every chunk once, equal to what the store
 * serves.
 */
import { describe, expect, it } from "vitest";
import { NiftiStore, openNifti } from "../src/virtual/images/nifti.js";
import { type Box, boxVoxels, chunkFromSlab, chunksOf, finerSlabs, type Grid, levelSlabs, Reducer, type Slab, slabFromChunks, slabOf, slabWidth } from "../src/virtual/images/slabs.js";

const grid = (size: number[], chunk: number[], step = [2, 2, 2]): Grid => ({ size, chunk: chunk.map((c, a) => Math.min(c, size[a])), step });

/** Every voxel of `whole` covered exactly once by `boxes`. */
function tiles(whole: Box, boxes: Box[]): boolean {
  const n = whole.hi.map((h, a) => h - whole.lo[a]);
  const seen = new Uint8Array(n[0] * n[1] * n[2]);
  for (const b of boxes) {
    for (let z = b.lo[2]; z < b.hi[2]; ++z) for (let y = b.lo[1]; y < b.hi[1]; ++y) for (let x = b.lo[0]; x < b.hi[0]; ++x) {
      if (x < whole.lo[0] || y < whole.lo[1] || z < whole.lo[2] || x >= whole.hi[0] || y >= whole.hi[1] || z >= whole.hi[2]) return false;
      seen[(x - whole.lo[0]) + n[0] * ((y - whole.lo[1]) + n[1] * (z - whole.lo[2]))]++;
    }
  }
  return seen.every((v) => v === 1);
}

/** A slab of a level with value f(x, y, z, slot), as Float64Array. */
function slabOfValues(box: Box, slots: number, f: (x: number, y: number, z: number, s: number) => number): Slab {
  const n = box.hi.map((h, a) => h - box.lo[a]);
  const data = new Float64Array(slots * n[0] * n[1] * n[2]);
  let i = 0;
  for (let s = 0; s < slots; ++s) for (let z = box.lo[2]; z < box.hi[2]; ++z) for (let y = box.lo[1]; y < box.hi[1]; ++y) for (let x = box.lo[0]; x < box.hi[0]; ++x) data[i++] = f(x, y, z, s);
  return { box, slots, data };
}

describe("slab arithmetic", () => {
  it("makes slabs whole chunks wide, under the limit, at least one chunk", () => {
    const g = grid([4096, 4096, 512], [64, 64, 64]);
    // A chunk's column (64³ uint16) is 512 KB: 256 MB holds the whole width, 16 MB half of it.
    expect(slabWidth(g, 2, 1, 256 * 2 ** 20)).toBe(4096);
    expect(slabWidth(g, 2, 1, 16 * 2 ** 20)).toBe(4096 / 2);
    expect(slabWidth(g, 2, 1, 1)).toBe(64);
    expect(slabWidth(grid([70, 66, 65], [64, 64, 64]), 2, 1, 2 ** 30)).toBe(128);
    expect(slabOf(g, [17, 2, 5], 1024)).toEqual({ lo: [1024, 128, 320], hi: [2048, 192, 384] });
    expect(slabOf(grid([100, 70, 65], [64, 64, 64]), [1, 1, 1], 128)).toEqual({ lo: [0, 64, 64], hi: [100, 70, 65] });
  });

  it("tiles a level with its slabs, and a coarser slab with the finer slabs under it", () => {
    for (const [size, chunk, step, width] of [
      [[4096, 300, 130], [64, 64, 64], [2, 2, 2], 1024],
      [[130, 130, 20], [64, 64, 64], [2, 2, 1], 64],
      [[301, 77, 33], [55, 55, 55], [2, 2, 2], 110],
      [[512, 512, 1], [256, 256, 1], [2, 2, 1], 256],
    ] as [number[], number[], number[], number][]) {
      const fine = grid(size, chunk, [1, 1, 1]);
      const coarse = grid(size.map((n, a) => Math.ceil(n / step[a])), chunk, step);
      expect(tiles({ lo: [0, 0, 0], hi: size }, levelSlabs(fine, width))).toBe(true);
      for (const box of levelSlabs(coarse, width)) {
        const under = { lo: box.lo.map((v, a) => v * step[a]), hi: box.hi.map((v, a) => Math.min(size[a], v * step[a])) };
        const finer = finerSlabs(coarse, fine, box, width);
        expect(tiles(under, finer)).toBe(true);
        // Each starts on the finer level's chunks, so its chunks can be cut from it.
        for (const f of finer) expect(f.lo.every((v, a) => v % fine.chunk[a] === 0)).toBe(true);
      }
    }
    // Walks every slab of large levels: seconds on a shared CI machine.
  }, 60_000);

  it("cuts chunks from a slab and puts them back", () => {
    const g = grid([150, 70, 9], [64, 32, 4], [1, 1, 1]);
    const box: Box = { lo: [0, 32, 4], hi: [150, 64, 8] };
    const slab = slabOfValues(box, 2, (x, y, z, s) => x + 1000 * y + 1e6 * z + 1e8 * s);
    const data = new Float64Array(slab.data as Float64Array);
    const chunks = new Map<string, Uint8Array>();
    for (const b of chunksOf(g, box)) chunks.set(b.join("/"), chunkFromSlab(g, { ...slab, data }, b, 8));
    expect([...chunks.keys()]).toEqual(["0/1/1", "1/1/1", "2/1/1"]);
    // Past the level's edge, the chunk is zeros (Zarr's fill value).
    const last = new Float64Array(chunks.get("2/1/1")!.buffer);
    expect(last[0]).toBe(128 + 32 * 1000 + 4e6);
    expect(last[22]).toBe(0);
    const back = slabFromChunks(g, box, 2, 8, chunks, (n) => new Float64Array(n));
    expect([...(back.data as Float64Array)]).toEqual([...data]);
  });

  it("averages each box of the finer level, and picks its first voxel for labels", () => {
    for (const [size, chunk, step] of [
      [[37, 21, 11], [8, 8, 8], [2, 2, 2]],
      [[40, 33, 7], [16, 16, 16], [2, 2, 1]],
      [[29, 31, 17], [11, 11, 11], [2, 2, 2]],
    ] as [number[], number[], number[]][]) {
      const fine = grid(size, chunk, [1, 1, 1]);
      const coarse = grid(size.map((n, a) => Math.ceil(n / step[a])), chunk, step);
      const f = (x: number, y: number, z: number, s: number) => ((x * 31 + y * 17 + z * 7 + s * 5) % 97) + 0.25 * s;
      for (const box of levelSlabs(coarse, coarse.chunk[0])) {
        for (const mode of ["mean", "nearest"] as const) {
          const reducer = new Reducer(coarse, fine, box, 2, mode, (n) => new Float64Array(n));
          for (const finer of finerSlabs(coarse, fine, box, chunk[0])) reducer.add(slabOfValues(finer, 2, f));
          const out = reducer.finish();
          const n = box.hi.map((h, a) => h - box.lo[a]);
          for (let s = 0; s < 2; ++s) for (let z = box.lo[2]; z < box.hi[2]; ++z) for (let y = box.lo[1]; y < box.hi[1]; ++y) for (let x = box.lo[0]; x < box.hi[0]; ++x) {
            let want: number;
            if (mode === "nearest") want = f(x * step[0], y * step[1], z * step[2], s);
            else {
              let sum = 0;
              let count = 0;
              for (let k = z * step[2]; k < Math.min(size[2], (z + 1) * step[2]); ++k) for (let j = y * step[1]; j < Math.min(size[1], (y + 1) * step[1]); ++j) for (let i = x * step[0]; i < Math.min(size[0], (x + 1) * step[0]); ++i) {
                sum += f(i, j, k, s);
                count++;
              }
              want = sum / count;
            }
            const got = out.data[(s * n[2] + (z - box.lo[2])) * n[1] * n[0] + (y - box.lo[1]) * n[0] + (x - box.lo[0])];
            expect(got).toBeCloseTo(want, 9);
          }
        }
      }
      expect(boxVoxels({ lo: [0, 0, 0], hi: size })).toBe(size[0] * size[1] * size[2]);
    }
  });

  it("rounds integer means, summing 16-bit voxels exactly", () => {
    const fine = grid([4, 2, 2], [4, 2, 2], [1, 1, 1]);
    const coarse = grid([2, 1, 1], [4, 2, 2]);
    const box = { lo: [0, 0, 0], hi: [2, 1, 1] };
    const r = new Reducer(coarse, fine, box, 1, "mean", (n) => new Uint16Array(n));
    r.add({ box: { lo: [0, 0, 0], hi: [4, 2, 2] }, slots: 1, data: Uint16Array.from([65535, 65535, 1, 2, 65535, 65535, 1, 2, 65535, 65535, 1, 2, 65535, 65534, 1, 2]) });
    expect([...(r.finish().data as Uint16Array)]).toEqual([65535, 2]);
  });
});

// ------------------------------------------------------------ the store

/** A little-endian NIfTI-1 file of int16 or uint8 voxels, value(i) at flat index i. */
function nifti(dim: number[], value: (i: number) => number, datatype = 4, intent = 0): Uint8Array {
  const bytes = datatype === 2 ? 1 : 2;
  const count = dim.reduce((a, b) => a * b, 1);
  const out = new Uint8Array(352 + count * bytes);
  const v = new DataView(out.buffer);
  v.setInt32(0, 348, true);
  [dim.length, ...dim, ...Array(7 - dim.length).fill(1)].forEach((d, k) => v.setInt16(40 + 2 * k, d, true));
  v.setInt16(68, intent, true);
  v.setInt16(70, datatype, true);
  v.setInt16(72, bytes * 8, true);
  [1, 1, 1, 1, 0, 0, 0, 0].forEach((p, k) => v.setFloat32(76 + 4 * k, p, true));
  v.setFloat32(108, 352, true);
  out.set([110, 43, 49, 0], 344);
  for (let i = 0; i < count; ++i) {
    if (bytes === 1) out[352 + i] = value(i);
    else v.setInt16(352 + 2 * i, value(i), true);
  }
  return out;
}

/** Whether two chunks hold the same bytes (toEqual on large typed arrays is slow). */
const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b));

/** Every chunk key a store serves, by level. */
async function keys(s: NiftiStore): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < s.levels.length; ++i) {
    const meta = JSON.parse(new TextDecoder().decode((await s.get(`${i}/zarr.json`))!));
    const shape: number[] = meta.shape;
    const chunk: number[] = meta.chunk_grid.configuration.chunk_shape;
    const grid = shape.map((n, d) => Math.ceil(n / chunk[d]));
    const index = grid.map(() => 0);
    for (let n = grid.reduce((a, b) => a * b, 1); n > 0; --n) {
      out.push(`${i}/c/${index.join("/")}`);
      for (let d = index.length - 1; d >= 0 && ++index[d] === grid[d]; --d) index[d] = 0;
    }
  }
  return out;
}

describe("coarser levels from slabs", () => {
  const dim = [150, 140, 133];
  const value = (i: number) => ((i * 7919) % 30011) - 15000;

  it("serves the same coarse chunks asked in any order, and writes every chunk once in one pass", async () => {
    const bytes = nifti(dim, value);
    const a = await openNifti(new Blob([bytes]), "a");
    const b = await openNifti(new Blob([bytes]), "b");
    expect(a.levels.length).toBe(3);
    const all = await keys(a);
    // Coarsest first in one store, finest first in the other: the same bytes.
    const coarseFirst = new Map<string, Uint8Array>();
    for (const key of [...all].reverse()) coarseFirst.set(key, (await a.get(key))!);
    for (const key of all) expect(same(await b.get(key), coarseFirst.get(key))).toBe(true);
    // Export's one pass: every chunk not all zero, once, equal to what the store serves.
    const c = await openNifti(new Blob([bytes]), "c");
    const written = new Map<string, Uint8Array>();
    let last = 0;
    await c.eachChunk(
      async (key, chunk) => {
        expect(written.has(key)).toBe(false);
        written.set(key, chunk);
      },
      { progress: (done, total) => (last = done / total), cancelled: false },
    );
    expect(last).toBeCloseTo(1, 9);
    for (const key of all) {
      const served = coarseFirst.get(key)!;
      if (served.some((v) => v !== 0)) expect(same(written.get(key), served)).toBe(true);
      else expect(written.has(key)).toBe(false);
    }
  });

  it("cuts very wide slabs into pieces, the same voxels either way", async () => {
    const bytes = nifti([300, 70, 70], (i) => i % 251, 2);
    const whole = await openNifti(new Blob([bytes]), "w");
    const pieces = new NiftiStore(whole.header, () => Promise.resolve({ size: bytes.byteLength, read: async (s, e) => bytes.subarray(s, e) }), "p", { slabBytes: 64 * 64 * 64 });
    for (const key of await keys(whole)) expect(same(await pieces.get(key), await whole.get(key))).toBe(true);
  });

  it("says so when there is no overview cache to build into", async () => {
    const s = await openNifti(new Blob([nifti(dim, value)]), "s");
    // No overview cache here (no file to key it by, no private file system): a build says so.
    s.startBuild();
    const status = await s.status();
    expect(status.noCache).toBe(true);
    for (let i = 0; i < 100 && (await s.status()).state === "building"; ++i) await new Promise((r) => setTimeout(r, 10));
    expect((await s.status()).state).toBe("failed");
  });
});
