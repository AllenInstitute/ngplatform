/**
 * Camera planes: cuts across the view as it was when each was set, fixed
 * there (the camera moving does not move them); and the one cut facing the
 * camera of before, read into them.
 */
import { describe, expect, it } from "vitest";
import { readSaved, zarrVectorsStore } from "../plugin.js";
import { planeClip, planeFromView } from "../view.js";

// Display coordinates in mm; a camera looking along -z (as frame3d's) and one looking along +x.
const MM = { names: ["x", "y", "z"], scales: [1e-3, 1e-3, 1e-3], units: ["m", "m", "m"] };
const DOWN_Z = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -0.1, 0, 0, 0, 1];
const keeps = (c: number[], x: number[]) => c[0] * x[0] + c[1] * x[1] + c[2] * x[2] + c[3] >= 0;

describe("a camera plane", () => {
  it("cuts across the view it was set from, through the point given, keeping what lies beyond", () => {
    const p = planeFromView(DOWN_Z, [0, 0, 5], "Plane 1");
    const c = planeClip(p, MM);
    // The camera looks along -z: beyond the plane is z < 5.
    expect(keeps(c, [0, 0, 4])).toBe(true);
    expect(keeps(c, [0, 0, 6])).toBe(false);
  });

  it("is moved by its offset along its own direction, in mm", () => {
    const p = { ...planeFromView(DOWN_Z, [0, 0, 5], "Plane 1"), offset: 2 };
    expect(keeps(planeClip(p, MM), [0, 0, 3.5])).toBe(false);
    expect(keeps(planeClip(p, MM), [0, 0, 2.5])).toBe(true);
    // Display units of 10 µm: 2 mm is 200 of them.
    const um10 = { ...MM, scales: [1e-5, 1e-5, 1e-5] };
    expect(keeps(planeClip({ ...p, point: [0, 0, 500] }, um10), [0, 0, 301])).toBe(false);
  });
});

describe("where it renders", () => {
  it("is this browser unless a render computer was chosen", () => {
    expect(readSaved({}).where).toBe("browser");
    expect(readSaved({ where: "host" }).where).toBe("host");
    expect(readSaved({ where: "browser" }).where).toBe("browser");
  });
});

describe("camera planes saved", () => {
  it("are read back, several of them", () => {
    const planes = [
      { name: "Front", on: true, normal: [0, 0, -1], point: [1, 2, 3], offset: 1.5 },
      { name: "Side", on: false, normal: [1, 0, 0], point: [0, 0, 0], offset: 0 },
      { name: "Broken", on: true, normal: [1, 0], point: [0, 0, 0], offset: 0 },
    ];
    expect(readSaved({ planes }).planes).toEqual(planes.slice(0, 2));
  });

  it("take the one cut facing the camera of before: pinned, fixed where it was; following, set from the next view", () => {
    const pinned = readSaved({ viewCut: { on: true, offset: 3, fixed: [0, 0, -1, 5] } }).planes;
    expect(pinned).toHaveLength(1);
    expect(pinned[0].normal).toEqual([0, 0, -1]);
    expect(keeps(planeClip(pinned[0], MM), [0, 0, 4])).toBe(true);
    expect(keeps(planeClip(pinned[0], MM), [0, 0, 6])).toBe(false);
    const following = readSaved({ viewCut: { on: true, offset: 3, fixed: null } }).planes;
    expect(following).toEqual([{ name: "Plane 1", on: true, normal: [0, 0, 0], point: [0, 0, 0], offset: 3 }]);
    expect(readSaved({ viewCut: { on: false, offset: 3, fixed: null } }).planes).toEqual([]);
  });
});

describe("a Zarr Vectors layer's store, for objects", () => {
  it("is its source without the format, as the render computer reads it", () => {
    expect(zarrVectorsStore("https://h/b/t.zarrvectors/|zarr-vectors:")).toBe("https://h/b/t.zarrvectors/");
    expect(zarrVectorsStore("zarr-vectors://gs://b/t.zv/")).toBe("gs://b/t.zv/");
    expect(zarrVectorsStore("precomputed://gs://b/seg")).toBeUndefined();
  });
});
