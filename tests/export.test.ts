/**
 * Exporting local images: a level read back whole from its virtual store,
 * and written as NIfTI or MGH, reads back with the same voxels and placement.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openMgh } from "../src/virtual/images/mgh.js";
import { openNifti } from "../src/virtual/images/nifti.js";
import { readLevel, storeLevels } from "../src/virtual/out/read_level.js";
import { mghFile, niftiFile } from "../src/virtual/out/volume.js";

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
