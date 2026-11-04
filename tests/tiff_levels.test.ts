/**
 * A TIFF's own pyramid used as the image's coarser levels: SubIFDs
 * (pyramidal OME-TIFF), reduced-resolution pages after each page, and a
 * lone thumbnail that is not a level.  Values against tifffile's reading of
 * each level (tests/testdata/tiff/generate_pyramids.py).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openTiff, ownLevels, type Page, readTiffStack } from "../src/virtual/images/tiff.js";

const DIR = new URL("./testdata/tiff/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("pyramid_expected.json", DIR), "utf8"));
const blob = (name: string) => new Blob([readFileSync(new URL(name, DIR))]);

/** Voxel (x, y, z) of a level, read through the store's chunk keys. */
async function voxel(store: Awaited<ReturnType<typeof openTiff>>, level: number, x: number, y: number, z: number): Promise<number> {
  const meta = JSON.parse(new TextDecoder().decode((await store.get(`${level}/zarr.json`))!));
  const [ci, cj, ck] = meta.chunk_grid.configuration.chunk_shape;
  const chunk = (await store.get(`${level}/c/${Math.floor(x / ci)}/${Math.floor(y / cj)}/${Math.floor(z / ck)}`))!;
  const at = ((z % ck) * cj + (y % cj)) * ci + (x % ci);
  return meta.data_type === "uint16" ? new DataView(chunk.buffer, chunk.byteOffset).getUint16(2 * at, true) : chunk[at];
}

describe("a TIFF's own pyramid", () => {
  it("reads each page's SubIFDs as levels, and serves them without computing", async () => {
    const stack = await readTiffStack(blob("pyramid_subifds.ome.tif"));
    expect(stack.pages.length).toBe(3);
    expect(stack.levels.map((l) => [l.length, l[0].width, l[0].height])).toEqual([
      [3, 80, 72],
      [3, 40, 36],
    ]);
    const store = await openTiff(blob("pyramid_subifds.ome.tif"), "p");
    const want = expected.subifds;
    expect(store.levels.slice(0, 3).map((l) => l.size)).toEqual(want.shapes.map(([z, y, x]: number[]) => [x, y, z]));
    // The file's levels halve x and y, not z: scale 2, 4 (and 1 along z).
    expect(store.levels.slice(1, 3).map((l) => l.factor)).toEqual([
      [2, 2, 1],
      [4, 4, 1],
    ]);
    for (let level = 0; level < 3; ++level) {
      for (const [z, y, x, value] of want.samples[level]) expect(await voxel(store, level, x, y, z)).toBe(value);
    }
    // Levels past the file's own would be computed from its coarsest (40 × 36 × 3 fits one chunk: none here).
    expect(store.levels.length).toBe(3);
    const status = await store.status();
    expect(status.levels.map((l) => l.from)).toEqual(["file", "file", "file"]);
  });

  it("reads reduced-resolution pages that follow each page as a level", async () => {
    const stack = await readTiffStack(blob("pyramid_pages.tif"));
    expect(stack.pages.length).toBe(2);
    expect(stack.levels.map((l) => [l.length, l[0].width, l[0].height])).toEqual([[2, 40, 20]]);
    const store = await openTiff(blob("pyramid_pages.tif"), "q");
    for (const [z, y, x, value] of expected.pages.half) expect(await voxel(store, 1, x, y, z)).toBe(value);
  });

  it("takes a lone thumbnail for no level", async () => {
    const stack = await readTiffStack(blob("thumbnail.tif"));
    expect(stack.pages.length).toBe(2);
    expect(stack.levels).toEqual([]);
  });

  it("keeps a level only while every page has one, the same size, smaller by one factor along x and y", () => {
    const page = (width: number, height: number, compression = 1): Page => ({ width, height, bits: 8, samples: 1, format: 1, compression, predictor: 1, offsets: [0], counts: [1], blockWidth: width, blockHeight: height, tiled: false });
    const full = [page(100, 80), page(100, 80)];
    expect(ownLevels(full, [[page(50, 40), page(25, 20)], [page(50, 40), page(25, 20)]]).length).toBe(2);
    expect(ownLevels(full, [[page(50, 40)], []]).length).toBe(0);
    expect(ownLevels(full, [[page(50, 40), page(25, 20)], [page(50, 40), page(26, 20)]]).length).toBe(1);
    expect(ownLevels(full, [[page(50, 20)], [page(50, 20)]]).length).toBe(0);
    expect(ownLevels(full, [[page(90, 72)], [page(90, 72)]]).length).toBe(0);
    // JPEG (7) is not decoded here: no level.
    expect(ownLevels(full, [[page(50, 40, 7)], [page(50, 40, 7)]]).length).toBe(0);
  });
});
