/**
 * TIFF stacks read as virtual Zarr: every fixture's voxels (strips, tiles,
 * LZW, deflate, PackBits, the predictor, big-endian, BigTIFF, float32, RGB
 * and RGBA packed in a uint32), in
 * the store's plane order for ImageJ and OME hyperstacks, the voxel sizes,
 * reduced-resolution pages skipped, and the stack served as OME-Zarr.
 * The fixtures and expected.json come from tests/testdata/tiff/generate.py.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitVirtual, TIFF_FORMAT } from "../src/virtual/local_data.js";
import { lzwDecode, openTiff, packBitsDecode, readTiffStack, tiffLayout, tiffSource, tiffSpacing } from "../src/virtual/images/tiff.js";

const DIR = new URL("./testdata/tiff/", import.meta.url);
const expected: Record<string, { dim: number[]; size: number[]; sha256: string }> = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8"));
const blob = (name: string) => new Blob([readFileSync(new URL(name, DIR))]);

describe("TIFF stacks", () => {
  for (const [name, want] of Object.entries(expected)) {
    it(`reads ${name}`, async () => {
      const store = await openTiff(blob(name), name);
      const h = store.header;
      expect(h.dim.slice(1, 1 + h.dim[0])).toEqual(want.dim);
      expect(h.pixdim.slice(1, 4).map((v) => Number(v.toFixed(6)))).toEqual(want.size);
      const stack = await readTiffStack(blob(name));
      const layout = tiffLayout(stack);
      const planes = layout.z * layout.c * layout.t;
      // The voxels as the store reads them, in pieces that cross rows, strips and planes.
      const source = (await (store as unknown as { data: () => Promise<{ size: number; read: (a: number, b: number) => Promise<Uint8Array> }> }).data());
      const parts: Uint8Array[] = [];
      for (let at = 0; at < source.size; at += 1000) parts.push(await source.read(at, Math.min(source.size, at + 1000)));
      const all = new Uint8Array(source.size);
      parts.reduce((o, p) => (all.set(p, o), o + p.length), 0);
      const pixel = stack.pages[0].samples > 1 ? 4 : stack.pages[0].bits / 8;
      expect(source.size).toBe(planes * stack.pages[0].width * stack.pages[0].height * pixel);
      if (stack.pages[0].samples > 1) {
        expect((JSON.parse(new TextDecoder().decode((await store.get("zarr.json"))!))).attributes.ngplatform).toEqual({ rendering: "rgb" });
      }
      expect(createHash("sha256").update(all).digest("hex")).toBe(want.sha256);
    });
  }

  it("takes ImageJ's and OME's layouts and sizes", async () => {
    const ij = await readTiffStack(blob("imagej_channels.tif"));
    expect(tiffLayout(ij)).toEqual({ z: 3, c: 2, t: 1, order: "XYCZT" });
    expect(tiffSpacing(ij).size).toEqual([0.25, 0.25, 2]);
    const ome = await readTiffStack(blob("ome_time.ome.tif"));
    expect(tiffLayout(ome)).toEqual({ z: 4, c: 1, t: 3, order: "XYCZT" });
    expect(tiffSpacing(ome).size).toEqual([0.5, 0.5, 1.5]);
  });

  it("skips reduced-resolution pages", async () => {
    const stack = await readTiffStack(blob("with_thumbnail.tif"));
    expect(stack.pages.length).toBe(2);
  });

  it("serves the stack as OME-Zarr with micrometre voxel sizes", async () => {
    const store = await openTiff(blob("imagej_channels.tif"), "hyper");
    const group = JSON.parse(new TextDecoder().decode((await store.get("zarr.json"))!));
    const ms = group.attributes.ome.multiscales[0];
    expect(ms.coordinateSystems[0].axes.map((a: { name: string }) => a.name)).toContain("c");
    const level = JSON.parse(new TextDecoder().decode((await store.get("0/zarr.json"))!));
    expect(level.data_type).toBe("uint16");
    expect([...level.shape].sort((a: number, b: number) => a - b)).toEqual([2, 3, 10, 12]);
  });

  it("gives each channel a display window from its middle plane", async () => {
    const store = await openTiff(blob("imagej_channels.tif"), "hyper");
    const group = JSON.parse(new TextDecoder().decode((await store.get("zarr.json"))!));
    const channels = group.attributes.ome.omero.channels;
    expect(channels.length).toBe(2);
    for (const c of channels) {
      expect(c.window.min).toBeLessThanOrEqual(c.window.start);
      expect(c.window.start).toBeLessThan(c.window.end);
      expect(c.window.end).toBeLessThanOrEqual(c.window.max);
    }
    // Neuroglancer reads it as the channels' contrast.
    const { parseOmeMetadata } = await import("neuroglancer/unstable/datasource/zarr/ome.js");
    const ome = parseOmeMetadata("http://x/", group.attributes, 3);
    expect(ome?.channels?.channels[0].range).toEqual([channels[0].window.start, channels[0].window.end]);
  });

  it("decodes PackBits and LZW", () => {
    // PackBits: a literal run of 3, then 4 repeats.
    expect([...packBitsDecode(Uint8Array.of(2, 1, 2, 3, 0xfd, 9), 7)]).toEqual([1, 2, 3, 9, 9, 9, 9]);
    // LZW: clear, "A", "B", the new code for "AB", end (9-bit codes).
    expect([...lzwDecode(Uint8Array.of(128, 16, 72, 80, 40, 8), 4)]).toEqual([65, 66, 65, 66]);
  });

  it("splits a path under a TIFF file into the file and a key", () => {
    expect(splitVirtual("scans/stack.ome.tif/0/c/0/0/0", [TIFF_FORMAT])).toMatchObject({ file: "scans/stack.ome.tif", key: "0/c/0/0/0" });
  });
});
