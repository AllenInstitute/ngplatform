/**
 * Exporting local images: a level read back whole from its virtual store,
 * and written as NIfTI or MGH, reads back with the same voxels and placement.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openMgh } from "../src/virtual/images/mgh.js";
import { openNifti } from "../src/virtual/images/nifti.js";
import { readLevel, regionAround, storeLevels } from "../src/virtual/out/read_level.js";
import { csvFile, objFile, plyFile, stlFile, tckFile, trkFile } from "../src/virtual/out/vectors.js";
import { mghFile, niftiFile } from "../src/virtual/out/volume.js";
import { parseMeshFile } from "../src/virtual/vectors/mesh_files.js";
import { parsePointTable } from "../src/virtual/vectors/point_files.js";
import { parseTckHeader, readTck } from "../src/virtual/vectors/tck.js";
import { parseTrkHeader, readTrk } from "../src/virtual/vectors/trk.js";

const DIR = new URL("./testdata/mgh/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8"));

describe("export", () => {
  it("reads a level whole, x fastest, with its voxel-to-RAS placement", async () => {
    const store = await openMgh(new Blob([readFileSync(new URL("short.mgz", DIR))]), "short");
    const { levels, label } = await storeLevels(store);
    expect(label).toBe(false);
    expect(levels[0].size).toEqual([7, 6, 5]);
    const volume = await readLevel(store, levels[0]);
    expect(Array.from(volume.data)).toEqual(expected["short.mgz"].voxels);
    for (let r = 0; r < 3; ++r) for (let c = 0; c < 4; ++c) expect(volume.voxelToRas[4 * r + c]).toBeCloseTo(expected["short.mgz"].affine[r][c], 4);
    // A coarser level sits over the same space: its first voxel's centre is the mean of the first 2 × 2 × 2 block's.
    if (levels.length > 1) {
      const at = (m: Float64Array, p: number[]) => [0, 1, 2].map((r) => m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3]);
      at(levels[1].voxelToRas, [0, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo(at(levels[0].voxelToRas, [0.5, 0.5, 0.5])[k], 4));
    }
  });

  it("writes MGH and NIfTI that read back the same", async () => {
    const store = await openMgh(new Blob([readFileSync(new URL("short.mgz", DIR))]), "short");
    const { levels } = await storeLevels(store);
    const volume = await readLevel(store, levels[0]);
    for (const [name, bytes, open] of [
      ["mgh", mghFile(volume), openMgh],
      ["nii", niftiFile(volume), openNifti],
    ] as const) {
      const again = await open(new Blob([bytes as BlobPart]), name);
      const back = await readLevel(again, (await storeLevels(again)).levels[0]);
      expect(Array.from(back.data), name).toEqual(Array.from(volume.data));
      back.voxelToRas.slice(0, 12).forEach((v, i) => expect(v, `${name} ${i}`).toBeCloseTo(volume.voxelToRas[i], 4));
    }
  });
});

describe("export of geometry", () => {
  const TRACTS = new URL("../plugins/zarr-vectors/testdata/tractograms/", import.meta.url);
  const MESHES = new URL("../plugins/zarr-vectors/testdata/meshes/", import.meta.url);

  async function curvesOf(bytes: Uint8Array, name: string) {
    const points: number[] = [];
    const lengths: number[] = [];
    const take = (b: { points: Float32Array; offsets: Uint32Array }) => {
      points.push(...b.points);
      for (let i = 0; i + 1 < b.offsets.length; ++i) lengths.push(b.offsets[i + 1] - b.offsets[i]);
    };
    const blob = new Blob([bytes as BlobPart]);
    if (name.endsWith(".tck")) await readTck(blob, parseTckHeader(bytes.slice(0, 65536)), take);
    else await readTrk(blob, parseTrkHeader(bytes.slice(0, 1000)), take);
    return { points, lengths };
  }

  it("writes .trk and .tck that read back as the same streamlines, RAS mm", async () => {
    const source = new Uint8Array(readFileSync(new URL("oblique.trk", TRACTS)));
    const original = await curvesOf(source, "oblique.trk");
    const offsets = new Uint32Array(original.lengths.length + 1);
    original.lengths.forEach((n, i) => (offsets[i + 1] = offsets[i] + n));
    const curves = { positions: Float32Array.from(original.points), offsets };
    for (const [name, bytes] of [
      ["out.trk", trkFile(curves)],
      ["out.tck", tckFile(curves)],
    ] as const) {
      const back = await curvesOf(bytes, name);
      expect(back.lengths, name).toEqual(original.lengths);
      back.points.forEach((v, i) => expect(v, `${name} ${i}`).toBeCloseTo(original.points[i], 3));
    }
  });

  it("writes OBJ, STL and PLY meshes that read back the same", async () => {
    const mesh = await parseMeshFile(new Uint8Array(readFileSync(new URL("cube_le.ply", MESHES))), "cube_le.ply");
    for (const [name, bytes] of [
      ["out.obj", objFile(mesh)],
      ["out.ply", plyFile(mesh)],
    ] as const) {
      const back = await parseMeshFile(bytes, name);
      expect(Array.from(back.triangles), name).toEqual(Array.from(mesh.triangles));
      expect(Array.from(back.positions), name).toEqual(Array.from(mesh.positions));
    }
    // STL keeps triangles, not shared vertices: compare the triangles' corners.
    const stl = await parseMeshFile(stlFile(mesh), "out.stl");
    const corners = (m: typeof mesh) => Array.from(m.triangles, (v) => [m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]].join(" "));
    expect(corners(stl)).toEqual(corners(mesh));
  });

  it("writes points as CSV", () => {
    const text = new TextDecoder().decode(csvFile([1, 2, 3, 4, 5, 6], [{ name: "a", values: [7, 8] }]));
    expect(text).toBe("x,y,z,a\n1,2,3,7\n4,5,6,8\n");
    expect(parsePointTable(text).positions.length).toBe(6);
  });
});

describe("export of a region", () => {
  it("reads just a box of a level, placed where it is in the whole", async () => {
    const store = await openMgh(new Blob([readFileSync(new URL("short.mgz", DIR))]), "short");
    const { levels } = await storeLevels(store);
    const whole = await readLevel(store, levels[0]);
    const box = await readLevel(store, levels[0], undefined, { lo: [2, 1, 1], hi: [6, 4, 3] });
    expect(box.size).toEqual([4, 3, 2]);
    for (let z = 0; z < 2; ++z) for (let y = 0; y < 3; ++y) for (let x = 0; x < 4; ++x) expect(box.data[x + 4 * (y + 3 * z)]).toBe(whole.data[x + 2 + 7 * (y + 1 + 6 * (z + 1))]);
    // Voxel (0, 0, 0) of the box is voxel (2, 1, 1) of the whole.
    const at = (m: Float64Array, p: number[]) => [0, 1, 2].map((r) => m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3]);
    at(box.voxelToRas, [0, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo(at(whole.voxelToRas, [2, 1, 1])[k], 5));
    // A box around a point, kept inside the image.
    const centre = at(whole.voxelToRas, [6, 5, 4]);
    expect(regionAround(levels[0], centre, 4)).toEqual({ lo: [3, 2, 1], hi: [7, 6, 5] });
  });
});
