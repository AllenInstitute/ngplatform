/** Track density maps: the grid, each streamline counted once a voxel, and the NIfTI file placed in RAS+ mm. */
import { describe, expect, it } from "vitest";
import { niftiAffine, openNifti } from "../../../src/platform/virtual_zarr/nifti.js";
import { addDensity, densityGrid, displayMax, niftiFile, voxelSize } from "../density.js";
import type { StoreInfo } from "../roi_worker.js";

const info = (lower: number[], upper: number[], unit = "m", scale = 1e-3, offset?: number[]): StoreInfo => ({
  axisNames: ["x", "y", "z"],
  axisUnits: [unit, unit, unit],
  axisScales: [scale, scale, scale],
  coordinateOffset: offset,
  bounds: { lower, upper },
  levels: [{ index: 0, vertexCount: 10, chunkShape: [16, 16, 16] }],
  geometry: "streamline",
  objects: true,
});

describe("track density", () => {
  it("chooses 1 mm for brains, round sizes otherwise", () => {
    expect(voxelSize(180)).toBe(1);
    expect(voxelSize(400)).toBe(2);
    expect(voxelSize(10)).toBe(0.05);
    expect(voxelSize(0.5)).toBe(0.002);
    expect(voxelSize(0)).toBe(1);
  });

  it("covers the store's bounds, in mm, with its offset", () => {
    const g = densityGrid(info([0, 0, 0], [10.4, 5, 3], "m", 1e-3, [-5, 2, 0]));
    expect(g.voxel).toBe(0.05);
    expect(g.origin).toEqual([-5, 2, 0]);
    expect(g.dims).toEqual([209, 101, 61]);
  });

  it("counts each streamline once in each voxel it passes through", () => {
    const g = densityGrid(info([0, 0, 0], [40, 40, 40]));
    expect(g.voxel).toBe(1);
    const counts = new Float32Array(g.dims[0] * g.dims[1] * g.dims[2]);
    const stamp = new Int32Array(counts.length);
    // A straight line along x at y = z = 5, then one doubling back on itself over x = 0..3.
    const curves = {
      offsets: Uint32Array.from([0, 2, 5]),
      positions: Float32Array.from([0, 5, 5, 10, 5, 5, 0, 7, 7, 3, 7, 7, 0, 7, 7]),
    };
    addDensity(curves, g, counts, stamp, 0);
    const at = (i: number, j: number, k: number) => counts[i + g.dims[0] * (j + g.dims[1] * k)];
    expect([0, 5, 10].map((i) => at(i, 5, 5))).toEqual([1, 1, 1]);
    expect(at(11, 5, 5)).toBe(0);
    expect([0, 1, 2, 3].map((i) => at(i, 7, 7))).toEqual([1, 1, 1, 1]);
    // A second batch: the same line again counts again.
    addDensity({ offsets: Uint32Array.from([0, 2]), positions: Float32Array.from([0, 5, 5, 10, 5, 5]) }, g, counts, stamp, 2);
    expect(at(5, 5, 5)).toBe(2);
  });

  it("shows up to the 99th percentile of the voxels streamlines pass through", () => {
    const values = new Float32Array(1000);
    for (let i = 0; i < 200; ++i) values[i] = 1 + (i % 100);
    expect(displayMax(values)).toBe(99);
    expect(displayMax(new Float32Array(10))).toBe(1);
  });

  it("writes a NIfTI file whose voxels sit where the grid says", async () => {
    const g = densityGrid(info([0, 0, 0], [30, 20, 10], "m", 1e-3, [-15, -10, 0]));
    const counts = new Float32Array(g.dims[0] * g.dims[1] * g.dims[2]);
    counts[3 + g.dims[0] * (4 + g.dims[1] * 5)] = 7;
    const bytes = niftiFile(counts, g, "track density: test");
    const store = await openNifti(new Blob([bytes as BlobPart]), "density");
    expect(store.header.dim.slice(1, 4)).toEqual(g.dims);
    expect(store.header.description).toBe("track density: test");
    // Its display range, which the store gives Neuroglancer as the contrast.
    expect([store.header.calMin, store.header.calMax]).toEqual([0, 7]);
    const group = JSON.parse(new TextDecoder().decode((await store.get("zarr.json"))!));
    expect(group.attributes.ome.omero.channels[0].window).toMatchObject({ start: 0, end: 7 });
    const m = niftiAffine(store.header).matrix;
    // Voxel (3, 4, 5) at origin + 3, 4, 5 mm.
    expect([0, 1, 2].map((r) => m[r][0] * 3 + m[r][1] * 4 + m[r][2] * 5 + m[r][3])).toEqual([-15 + 3, -10 + 4, 0 + 5]);
  });
});
