import { describe, expect, it } from "vitest";
import { describeTransform, omeBase, summariseOme } from "../src/engine/inspector/ome.js";

describe("an OME-Zarr image's coordinate systems and transforms, in words", () => {
  it("reads 0.6 (RFC-5): named systems, an affine to the world, each level's transform", () => {
    const s = summariseOme({
      ome: {
        version: "0.6",
        multiscales: [
          {
            name: "brain",
            coordinateSystems: [
              { name: "mni152", axes: [{ name: "x", type: "space", unit: "millimeter" }, { name: "y", unit: "millimeter" }, { name: "z", unit: "millimeter" }] },
              { name: "array", axes: [{ name: "x" }, { name: "y" }, { name: "z" }] },
            ],
            datasets: [
              { path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1], input: "0", output: "array" }] },
              { path: "1", coordinateTransformations: [{ type: "sequence", transformations: [{ type: "scale", scale: [2, 2, 2] }, { type: "translation", translation: [0.5, 0.5, 0.5] }] }] },
            ],
            coordinateTransformations: [{ type: "affine", input: "array", output: "mni152", affine: [[-1, 0, 0, 90], [0, 1, 0, -126], [0, 0, 1, -72]] }],
          },
        ],
      },
    })!;
    expect(s.version).toBe("0.6");
    expect(s.systems).toEqual([
      { name: "mni152", axes: "x (millimeter), y (millimeter), z (millimeter)" },
      { name: "array", axes: "x, y, z" },
    ]);
    expect(s.transforms).toEqual([{ from: "array", to: "mni152", what: "affine (3 × 4): [-1, 0, 0, 90] [0, 1, 0, -126] [0, 0, 1, -72]" }]);
    expect(s.levels[1]).toEqual({ path: "1", what: "sequence: scale 2, 2, 2; translation 0.5, 0.5, 0.5" });
  });

  it("reads 0.4 axes and scale-only levels", () => {
    const s = summariseOme({ multiscales: [{ version: "0.4", axes: [{ name: "z", unit: "micrometer" }, { name: "y" }, { name: "x" }], datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [2, 0.5, 0.5] }] }] }] })!;
    expect(s.version).toBe("0.4");
    expect(s.systems[0].axes).toBe("z (micrometer), y, x");
    expect(s.levels[0].what).toBe("scale 2, 0.5, 0.5");
    expect(summariseOme({ something: "else" })).toBeUndefined();
    expect(describeTransform({ type: "translation", path: "t.bin" })).toBe("translation (t.bin)");
  });

  it("finds the store behind a layer source", () => {
    expect(omeBase("zarr://https://example.org/a.ome.zarr/")).toBe("https://example.org/a.ome.zarr");
    expect(omeBase("zarr3://gs://bucket/x.zarr")).toBe("https://storage.googleapis.com/bucket/x.zarr");
    expect(omeBase("precomputed://gs://b/c")).toBeUndefined();
  });
});
