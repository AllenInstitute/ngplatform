/**
 * A virtual image's z, y, x view (src/virtual/images/zyx.ts), as the
 * Filters plugin's engine reads it: axes and metadata permuted, every voxel
 * where it was (an image stored x, y, z, and one whose sform puts its axes
 * in the order y, z, x), the affine's columns following; and the engine's
 * output placed as the source is (`placeLike`).
 */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";
import { placeLike } from "../src/virtual/computed.js";
import { openNifti } from "../src/virtual/images/nifti.js";
import type { VirtualStore } from "../src/virtual/images/store.js";
import { withZyxView, zyxChunkKey, zyxOrder } from "../src/virtual/images/zyx.js";

/** A little-endian NIfTI-1 file of int16 voxels, value(i) at flat index i (i fastest), with an sform when given. */
function nifti(dim: number[], value: (i: number) => number, sform?: number[][]): Uint8Array {
  const count = dim.reduce((a, b) => a * b, 1);
  const out = new Uint8Array(352 + count * 2);
  const v = new DataView(out.buffer);
  v.setInt32(0, 348, true);
  [dim.length, ...dim, ...Array(7 - dim.length).fill(1)].forEach((d, k) => v.setInt16(40 + 2 * k, d, true));
  v.setInt16(70, 4, true);
  v.setInt16(72, 16, true);
  [1, 2, 2, 2, 0, 0, 0, 0].forEach((p, k) => v.setFloat32(76 + 4 * k, p, true));
  v.setFloat32(108, 352, true);
  if (sform !== undefined) {
    v.setInt16(254, 1, true);
    sform.forEach((row, r) => row.forEach((x, c) => v.setFloat32(280 + 16 * r + 4 * c, x, true)));
  }
  out.set([110, 43, 49, 0], 344);
  for (let i = 0; i < count; ++i) v.setInt16(352 + 2 * i, value(i), true);
  return out;
}

const json = (bytes: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(bytes!));

/** A level of a store read whole with zarrita, under `prefix`. */
async function readLevel(store: VirtualStore, prefix: string, level: number) {
  const root = zarr.root({ get: (key: string) => store.get(`${prefix}${key.replace(/^\//, "")}`) } as zarr.Readable);
  const array = await zarr.open(root.resolve(String(level)), { kind: "array" });
  const got = await zarr.get(array, array.shape.map(() => null));
  const data = got.data as Int16Array;
  // zarrita keeps a transposed chunk's strides.
  const at = (...index: number[]) => data[index.reduce((s, v, a) => s + v * got.stride[a], 0)];
  const cOrder = got.stride.every((s, a) => s === got.shape.slice(a + 1).reduce((p, q) => p * q, 1));
  return { data: Array.from(data), at, cOrder, shape: got.shape };
}

describe("the z, y, x view of a virtual image", () => {
  it("orders axes and keys", () => {
    expect(zyxOrder(["x", "y", "z"])).toEqual([2, 1, 0]);
    expect(zyxOrder(["t", "y", "z", "x"])).toEqual([0, 2, 1, 3]);
    expect(zyxOrder(["c", "y", "x"])).toBeUndefined();
    const array = { chunk_key_encoding: { name: "default", configuration: { separator: "/" } } };
    expect(zyxChunkKey("c/3/4/5", array, [2, 1, 0])).toBe("c/5/4/3");
    expect(zyxChunkKey("c/3/4", array, [2, 1, 0])).toBeUndefined();
  });

  it("serves an x, y, z image as z, y, x, every voxel in place", async () => {
    const dim = [150, 70, 13];
    const store = withZyxView(await openNifti(new Blob([nifti(dim, (i) => i % 30000)]), "a"));
    const group = json(await store.get("zyx/zarr.json"));
    const ms = group.attributes.ome.multiscales[0];
    expect(ms.coordinateSystems[1].axes.map((a: { name: string }) => a.name)).toEqual(["z", "y", "x"]);
    // Voxels of 2 mm: the affine's columns are k, j, i now.
    const affine = ms.coordinateTransformations[0].affine;
    expect(affine.map((r: number[]) => r.slice(0, 3))).toEqual([
      [0, 0, 2],
      [0, 2, 0],
      [2, 0, 0],
    ]);
    const meta = json(await store.get("zyx/0/zarr.json"));
    expect(meta.shape).toEqual([13, 70, 150]);
    expect(meta.codecs.some((c: { name: string }) => c.name === "transpose")).toBe(false);
    const level = await readLevel(store, "zyx/", 0);
    expect(level.shape).toEqual([13, 70, 150]);
    expect(level.cOrder).toBe(true);
    for (let k = 0; k < 13; k += 3) for (let j = 0; j < 70; j += 4) for (let i = 0; i < 150; i += 5) {
      expect(level.data[(k * 70 + j) * 150 + i]).toBe((i + 150 * (j + 70 * k)) % 30000);
    }
    // A coarser level: the original's, its axes reversed.
    const original = await readLevel(store, "", 1);
    const viewed = await readLevel(store, "zyx/", 1);
    const [nx, ny, nz] = original.shape;
    expect(viewed.shape).toEqual([nz, ny, nx]);
    for (let x = 0; x < nx; ++x) for (let y = 0; y < ny; ++y) for (let z = 0; z < nz; ++z) {
      expect(viewed.at(z, y, x)).toBe(original.at(x, y, z));
    }
    // Other keys are the store's own.
    expect(json(await store.get("zarr.json")).attributes.ome.multiscales[0].coordinateSystems[1].axes.map((a: { name: string }) => a.name)).toEqual(["x", "y", "z"]);
  });

  it("serves an image whose axes lie y, z, x", async () => {
    // i → y, j → z, k → x (2 mm voxels).
    const dim = [9, 7, 5];
    const sform = [
      [0, 0, 2, 10],
      [2, 0, 0, 20],
      [0, 2, 0, 30],
    ];
    const store = withZyxView(await openNifti(new Blob([nifti(dim, (i) => i)]), "b"));
    expect(json(await store.get("zarr.json")).attributes.ome.multiscales[0].coordinateSystems[1].axes.map((a: { name: string }) => a.name)).toEqual(["x", "y", "z"]);
    const oblique = withZyxView(await openNifti(new Blob([nifti(dim, (i) => i, sform)]), "c"));
    const own = json(await oblique.get("zarr.json")).attributes.ome.multiscales[0];
    expect(own.coordinateSystems[1].axes.map((a: { name: string }) => a.name)).toEqual(["y", "z", "x"]);
    const ms = json(await oblique.get("zyx/zarr.json")).attributes.ome.multiscales[0];
    expect(ms.coordinateSystems[1].axes.map((a: { name: string }) => a.name)).toEqual(["z", "y", "x"]);
    // Columns: z was j, y was i, x was k.
    expect(ms.coordinateTransformations[0].affine).toEqual([
      [0, 0, 2, 10],
      [0, 2, 0, 20],
      [2, 0, 0, 30],
    ]);
    const level = await readLevel(oblique, "zyx/", 0);
    expect(level.shape).toEqual([7, 9, 5]);
    expect(level.cOrder).toBe(true);
    for (let j = 0; j < 7; ++j) for (let i = 0; i < 9; ++i) for (let k = 0; k < 5; ++k) {
      expect(level.data[(j * 9 + i) * 5 + k]).toBe(i + 9 * (j + 7 * k));
    }
  });
});

describe("the engine's output placed as its source", () => {
  it("keeps the source's affine, on the output's levels", () => {
    const source = {
      attributes: {
        ome: {
          multiscales: [
            {
              coordinateSystems: [
                { name: "scanner", axes: ["x", "y", "z"].map((name) => ({ name, type: "space", unit: "millimeter" })) },
                { name: "array", axes: ["z", "y", "x"].map((name) => ({ name, type: "space" })) },
              ],
              datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1], input: "0", output: "array" }] }],
              coordinateTransformations: [
                {
                  type: "affine",
                  input: "array",
                  output: "scanner",
                  affine: [
                    [0, 0, -2, 90],
                    [0, 2, 0, -126],
                    [2, 0, 0, -72],
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    const output = {
      zarr_format: 3,
      node_type: "group",
      attributes: {
        ome: {
          version: "0.5",
          multiscales: [
            {
              name: "p1",
              axes: ["z", "y", "x"].map((name) => ({ name, type: "space" })),
              datasets: [
                { path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1] }, { type: "translation", translation: [0, 0, 0] }] },
                { path: "1", coordinateTransformations: [{ type: "scale", scale: [2, 2, 2] }, { type: "translation", translation: [0.5, 0.5, 0.5] }] },
              ],
            },
          ],
        },
      },
    };
    const placed = placeLike(output, source).attributes.ome;
    expect(placed.version).toBe("0.6");
    const ms = placed.multiscales[0];
    expect(ms.coordinateSystems.map((s: { name: string }) => s.name)).toEqual(["scanner", "array"]);
    expect(ms.coordinateSystems[0].axes.map((a: { name: string }) => a.name)).toEqual(["x", "y", "z"]);
    expect(ms.coordinateTransformations[0].affine).toEqual(source.attributes.ome.multiscales[0].coordinateTransformations[0].affine);
    expect(ms.datasets[1].coordinateTransformations[0]).toEqual({ type: "sequence", input: "1", output: "array", transformations: output.attributes.ome.multiscales[0].datasets[1].coordinateTransformations });
    // No affine to a world (an OME-Zarr 0.5 source): as the engine says.
    expect(placeLike(output, { attributes: { ome: { multiscales: [{ axes: [], datasets: [] }] } } })).toBe(output);
  });
});
