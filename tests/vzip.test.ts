/** vzip archives (refkv), against refkv 0.2.0's own reader: every key resolves to the same bytes. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openVzip } from "../src/virtual/refkv/store.js";
import { Vzip } from "../src/virtual/refkv/vzip.js";

const DIR = new URL("./testdata/vzip/", import.meta.url);
const expected: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8"));

/** Sources by file name: the archives name the TIFFs by where they were made. */
const resolve = async (url: string, offset: number, length: number) => {
  const name = url.split("/").pop()!;
  return new Uint8Array(readFileSync(new URL(name, DIR))).subarray(offset, offset + length);
};

describe("vzip", () => {
  for (const name of ["tiles", "strips", "lzw_delta"]) {
    it(`resolves every key of ${name}.vzip as refkv does`, async () => {
      const zip = await Vzip.open(new Blob([readFileSync(new URL(`${name}.vzip`, DIR))]), resolve);
      expect(zip.keys().sort()).toEqual(Object.keys(expected[name]).sort());
      for (const [key, sha] of Object.entries(expected[name])) {
        const bytes = await zip.get(key);
        expect(createHash("sha256").update(bytes!).digest("hex"), key).toBe(sha);
      }
      expect(await zip.get("no/such/key")).toBeUndefined();
      expect(await zip.get("__vz__/sources")).toBeUndefined();
    });
  }

  for (const name of ["tiles", "strips", "lzw_delta"]) {
    it(`serves ${name}.vzip as Zarr Neuroglancer reads: the TIFF's image, codecs decoded`, async () => {
      const file = (n: string) => new File([readFileSync(new URL(n, DIR))], n);
      const store = await openVzip(file(`${name}.vzip`), { [`${name}.tif`]: file(`${name}.tif`) });
      const group = JSON.parse(new TextDecoder().decode((await store.get("zarr.json"))!));
      expect(group.attributes.ome.multiscales[0].datasets[0].path).toBe("0");
      const meta = JSON.parse(new TextDecoder().decode((await store.get("0/zarr.json"))!));
      // Only codecs Neuroglancer reads are left.
      expect(meta.codecs.map((c: { name: string }) => c.name).every((n: string) => ["bytes", "transpose", "gzip", "zstd", "blosc"].includes(n))).toBe(true);
      const [ny, nx] = meta.shape;
      const [cy, cx] = meta.chunk_grid.configuration.chunk_shape;
      const image = new Uint16Array(ny * nx);
      for (let by = 0; by * cy < ny; ++by) {
        for (let bx = 0; bx * cx < nx; ++bx) {
          const bytes = (await store.get(`0/c/${by}/${bx}`))!;
          const chunk = new Uint16Array(bytes.buffer, bytes.byteOffset, cy * cx);
          for (let y = 0; y < cy && by * cy + y < ny; ++y) for (let x = 0; x < cx && bx * cx + x < nx; ++x) image[(by * cy + y) * nx + bx * cx + x] = chunk[y * cx + x];
        }
      }
      for (let i = 0; i < image.length; ++i) if (image[i] !== (i * 7) % 3001) throw new Error(`${name}: voxel ${i} is ${image[i]}, not ${(i * 7) % 3001}`);
      expect(store.list!("")).toContain("0/");
    });
  }

  it("says what it cannot read", async () => {
    await expect(Vzip.open(new Blob([new Uint8Array(100)]), resolve)).rejects.toThrow(/not a vzip/);
  });
});
