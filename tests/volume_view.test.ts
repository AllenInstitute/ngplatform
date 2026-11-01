/**
 * The volume view's OME-Zarr reading, against BigBrain's published metadata
 * (OME-Zarr 0.6, a physical system and an affine to MNI) and hand-made 0.4
 * and 0.5 groups.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apply, identity, invert, mergeLevels, multiply, parseOmeLevels, rasBounds } from "../src/plugins/volume_view/ome.js";

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
const BB = "https://ftp.bigbrainproject.org/bigbrain-ftp/BigBrainRelease.2015/OME_Zarr/";

describe("OME-Zarr levels", () => {
  it("places BigBrain in MNI through its affine", () => {
    const p = parseOmeLevels(`${BB}400um`, fixture("bigbrain_400um_zarr.json"), "MNI152NLin2009bAsym");
    expect(p.space).toBe("MNI152NLin2009bAsym");
    expect(p.levels).toHaveLength(1);
    const [level] = p.levels;
    expect(level.url).toBe(`${BB}400um/`);
    expect(level.axes).toEqual(["z", "y", "x"]);
    // The centre voxel (x, y, z) = (164, 143, 185) is near the middle of the brain in MNI.
    const ras = apply(level.voxelToRas, [164, 143, 185]);
    [-0.5456, -17.1814, 4.8102].forEach((v, k) => expect(ras[k]).toBeCloseTo(v, 3));
    expect(level.voxelSize).toBeGreaterThan(0.4);
    expect(level.voxelSize).toBeLessThan(0.6);
    const { lo, hi } = rasBounds(level, [371, 286, 329]);
    expect(lo[0]).toBeLessThan(-60);
    expect(hi[0]).toBeGreaterThan(60);
  });

  it("stays in the image's own system when another is not asked for or not there", () => {
    const own = parseOmeLevels(`${BB}400um`, fixture("bigbrain_400um_zarr.json"));
    expect(own.space).toBe("physical");
    // physical (z, y, x) µm = 400 i + 190, so voxel x = 1 is 0.59 mm along x.
    apply(own.levels[0].voxelToRas, [1, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo([0.59, 0.19, 0.19][k], 12));
    expect(parseOmeLevels(`${BB}400um`, fixture("bigbrain_400um_zarr.json"), "nowhere").space).toBe("physical");
  });

  it("reads every level of a pyramid and merges stores by voxel size", () => {
    const deep = parseOmeLevels(`${BB}20um/`, fixture("bigbrain_20um_zarr.json"), "MNI152NLin2009bAsym");
    expect(deep.levels.map((l) => l.path)).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    const sizes = deep.levels.map((l) => l.voxelSize);
    expect(sizes[6] / sizes[0]).toBeCloseTo(50, 0);
    const single = parseOmeLevels(`${BB}400um`, fixture("bigbrain_400um_zarr.json"), "MNI152NLin2009bAsym");
    const merged = mergeLevels([single, deep]);
    // 400 µm comes from the store given first; finest first.
    expect(merged).toHaveLength(7);
    expect(merged.find((l) => Math.abs(l.voxelSize - single.levels[0].voxelSize) < 0.01)!.url).toBe(`${BB}400um/`);
    expect(merged.map((l) => l.voxelSize)).toEqual([...merged.map((l) => l.voxelSize)].sort((a, b) => a - b));
  });

  it("reads 0.4 and 0.5 scale-and-translation pyramids", () => {
    const group = {
      attributes: {
        ome: {
          version: "0.5",
          multiscales: [
            {
              axes: [
                { name: "z", type: "space", unit: "micrometer" },
                { name: "y", type: "space", unit: "micrometer" },
                { name: "x", type: "space", unit: "micrometer" },
              ],
              datasets: [
                { path: "0", coordinateTransformations: [{ type: "scale", scale: [20, 10, 10] }] },
                { path: "1", coordinateTransformations: [{ type: "scale", scale: [40, 20, 20] }, { type: "translation", translation: [10, 5, 5] }] },
              ],
              coordinateTransformations: [{ type: "translation", translation: [1000, 0, 0] }],
            },
          ],
        },
      },
    };
    const p = parseOmeLevels("https://x/img.zarr", group);
    apply(p.levels[0].voxelToRas, [1, 2, 3]).forEach((v, k) => expect(v).toBeCloseTo([0.01, 0.02, 1.06][k], 12));
    apply(p.levels[1].voxelToRas, [0, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo([0.005, 0.005, 1.01][k], 12));
    // A v2 group's .zattrs has the multiscales at the top.
    expect(parseOmeLevels("https://x/img.zarr", group.attributes.ome).levels).toHaveLength(2);
    expect(() => parseOmeLevels("https://x", { attributes: {} })).toThrow(/not an OME-Zarr image/);
  });

  it("inverts and composes matrices", () => {
    const m = Float64Array.from([0, 2, 0, 5, -3, 0, 0, 1, 0, 0, 0.5, -2, 0, 0, 0, 1]);
    const product = multiply(m, invert(m));
    identity().forEach((v, i) => expect(product[i]).toBeCloseTo(v, 12));
  });
});
