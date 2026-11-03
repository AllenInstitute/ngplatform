/**
 * The volume view's OME-Zarr reading, against BigBrain's published metadata
 * (OME-Zarr 0.6, a physical system and an affine to MNI) and hand-made 0.4
 * and 0.5 groups; and how it tells tissue from background.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apply, identity, invert, mergeLevels, multiply, parseOmeLevels, rasBounds } from "../ome.js";
import { borderMean, displayOfRas, tissueWindow } from "../solid.js";
import { omeZarrUrl, readSaved } from "../plugin.js";

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

  it("follows the image's first transform, as Neuroglancer does, when another system is not asked for or not there", () => {
    const asked = parseOmeLevels(`${BB}400um`, fixture("bigbrain_400um_zarr.json"), "MNI152NLin2009bAsym");
    for (const p of [parseOmeLevels(`${BB}400um`, fixture("bigbrain_400um_zarr.json")), parseOmeLevels(`${BB}400um`, fixture("bigbrain_400um_zarr.json"), "nowhere")]) {
      expect(p.space).toBe("MNI152NLin2009bAsym");
      expect(Array.from(p.levels[0].voxelToRas)).toEqual(Array.from(asked.levels[0].voxelToRas));
    }
  });

  it("stays in the image's own system when no transform leads out of it", () => {
    const group = fixture("bigbrain_400um_zarr.json");
    const ms = (group.attributes?.ome ?? group).multiscales[0];
    const own = parseOmeLevels(`${BB}400um`, { attributes: { ome: { ...(group.attributes?.ome ?? {}), multiscales: [{ ...ms, coordinateTransformations: [] }] } } });
    expect(own.space).toBe("physical");
    // physical (z, y, x) µm = 400 i + 190, so voxel x = 1 is 0.59 mm along x.
    apply(own.levels[0].voxelToRas, [1, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo([0.59, 0.19, 0.19][k], 12));
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

describe("tissue and background", () => {
  // A 6 x 5 x 4 volume: a background shell around a block of tissue.
  const size: [number, number, number] = [6, 5, 4];
  const volume = (background: number, tissue: (i: number) => number) => {
    const data = new Uint8Array(size[0] * size[1] * size[2]).fill(background);
    let i = 0;
    for (let z = 1; z < 3; ++z) for (let y = 1; y < 4; ++y) for (let x = 1; x < 5; ++x) data[(z * size[1] + y) * size[0] + x] = tissue(i++);
    return data;
  };

  it("finds the background on the volume's border", () => {
    expect(borderMean(volume(0, () => 200), size)).toBe(0);
    expect(borderMean(volume(255, () => 40), size)).toBe(255);
  });

  it("stretches the tissue's values, not the background's", () => {
    // An MRI: dark background, tissue 100..123.
    const [lo, hi] = tissueWindow(volume(0, (i) => 100 + i), true);
    expect(lo * 255).toBeCloseTo(100, 6);
    expect(hi * 255).toBeCloseTo(123, 6);
    // A stain: pale background, tissue 40..63.
    const [lo2, hi2] = tissueWindow(volume(255, (i) => 40 + i), false);
    expect(lo2 * 255).toBeCloseTo(40, 6);
    expect(hi2 * 255).toBeCloseTo(63, 6);
    // Nothing but background: the full range.
    expect(tissueWindow(new Uint8Array(8), true)).toEqual([0, 1]);
  });
});

describe("drawing in Neuroglancer's 3-D view", () => {
  it("finds the OME-Zarr store behind an image layer's source", () => {
    expect(omeZarrUrl("zarr://https://a.org/x.ome.zarr")).toBe("https://a.org/x.ome.zarr/");
    expect(omeZarrUrl("https://a.org/x.ome.zarr/|zarr3:")).toBe("https://a.org/x.ome.zarr/");
    expect(omeZarrUrl("zarr2://gs://bucket/brain/")).toBe("https://storage.googleapis.com/bucket/brain/");
    expect(omeZarrUrl("precomputed://gs://bucket/em")).toBeUndefined();
    // Zarr Vectors stores are not images.
    expect(omeZarrUrl("gs://bucket/tracts.zarrvectors/|zarr-vectors:")).toBeUndefined();
    expect(omeZarrUrl(undefined)).toBeUndefined();
  });

  it("maps RAS millimetres to display coordinates by dimension name and unit", () => {
    const m = displayOfRas({ names: ["x", "y", "z"], scales: [0.001, 0.001, 0.002], units: ["m", "m", "m"] })!;
    expect([m[0], m[5], m[10], m[15]]).toEqual([1, 1, 0.5, 1]);
    const swapped = displayOfRas({ names: ["z", "y", "x"], scales: [0.001, 0.001, 0.001], units: ["m", "m", "m"] })!;
    expect([swapped[2], swapped[5], swapped[8]]).toEqual([1, 1, 1]);
    expect(displayOfRas({ names: ["t", "y", "x"], scales: [1, 1, 1], units: ["s", "m", "m"] })).toBeUndefined();
  });

  it("starts off, with the cut on", () => {
    expect(readSaved(undefined)).toMatchObject({ on: false, cut: true });
    expect(readSaved({ on: true, threshold: 0.3 })).toMatchObject({ on: true, threshold: 0.3 });
  });
});
