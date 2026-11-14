import { describe, expect, it } from "vitest";
import { chainAt, coarser, contains, current, estimateLevel, finer, framing, lengthText, nested, parents, voxelOf, type Volume } from "../hierarchy.js";

const um = 1e-6;
/** A volume in global coordinates of 1 µm, `size` µm across from `at`, with voxels of `voxel` µm. */
function vol(name: string, at: number[], size: number, voxel: number, visible = true): Volume {
  return { name, lower: at, upper: at.map((x) => x + size), voxelSize: [voxel * um, voxel * um, voxel * um], step: [voxel, voxel, voxel], visible };
}

// A whole organ at 20 µm, a zoom at 6.5 µm inside it, one at 2 µm inside that, and a second 6.5 µm zoom elsewhere.
const organ = vol("organ", [0, 0, 0], 100_000, 20);
const voi1 = vol("VOI-01", [20_000, 20_000, 20_000], 20_000, 6.5);
const voi1a = vol("VOI-01a", [25_000, 25_000, 25_000], 4_000, 2);
const voi2 = vol("VOI-02", [70_000, 70_000, 70_000], 20_000, 6.5, false);
const all = [voi1a, organ, voi2, voi1];

describe("containment", () => {
  it("nests a finer box inside a coarser one", () => {
    expect(contains(organ, voi1)).toBe(true);
    expect(contains(voi1, voi1a)).toBe(true);
    expect(contains(organ, voi1a)).toBe(true);
    expect(contains(voi1, organ)).toBe(false);
    expect(contains(voi1, voi2)).toBe(false);
  });

  it("does not nest a copy at the same resolution, nor a box that sticks out", () => {
    expect(contains(organ, vol("copy", [10, 10, 10], 100, 20))).toBe(false);
    expect(contains(organ, vol("out", [95_000, 0, 0], 10_000, 6.5))).toBe(false);
  });

  it("allows half the outer voxel at an edge", () => {
    expect(contains(organ, vol("edge", [-9, 0, 0], 1_000, 2))).toBe(true);
    expect(contains(organ, vol("past", [-11, 0, 0], 1_000, 2))).toBe(false);
  });

  it("compares only the dimensions both have", () => {
    const flat: Volume = { name: "2-D", lower: [100, 100, -Infinity], upper: [200, 200, Infinity], voxelSize: [um, um, NaN], step: [1, 1, NaN], visible: true };
    expect(contains(organ, flat)).toBe(true);
  });

  it("gives each its smallest container", () => {
    const p = parents(all);
    expect(p.get("VOI-01a")).toBe("VOI-01");
    expect(p.get("VOI-01")).toBe("organ");
    expect(p.get("VOI-02")).toBe("organ");
    expect(p.get("organ")).toBeUndefined();
    expect(nested(all).map((n) => [n.volume.name, n.parent.name, n.within.map((w) => w.name).sort()])).toEqual([
      ["VOI-01a", "VOI-01", ["VOI-01", "organ"]],
      ["VOI-02", "organ", ["organ"]],
      ["VOI-01", "organ", ["organ"]],
    ]);
  });
});

describe("the chain at a position", () => {
  it("lists the boxes holding it, coarse to fine", () => {
    expect(chainAt(all, [26_000, 26_000, 26_000]).map((v) => v.name)).toEqual(["organ", "VOI-01", "VOI-01a"]);
    expect(chainAt(all, [21_000, 21_000, 21_000]).map((v) => v.name)).toEqual(["organ", "VOI-01"]);
    expect(chainAt(all, [1, 1, 1]).map((v) => v.name)).toEqual(["organ"]);
    expect(chainAt(all, [-1, 1, 1])).toEqual([]);
  });

  it("knows where the views are on it", () => {
    const chain = chainAt(all, [26_000, 26_000, 26_000]);
    expect(current(chain, "VOI-01")?.name).toBe("VOI-01");
    expect(current(chain, "elsewhere")?.name).toBe("VOI-01a");
    const hiddenFinest = chain.map((v) => (v.name === "VOI-01a" ? { ...v, visible: false } : v));
    expect(current(hiddenFinest, undefined)?.name).toBe("VOI-01");
  });

  it("steps coarser and finer", () => {
    const at = [26_000, 26_000, 26_000];
    const chain = chainAt(all, at);
    expect(coarser(all, chain, voi1a)?.name).toBe("VOI-01");
    expect(coarser(all, chain, organ)).toBeUndefined();
    expect(finer(all, chain, organ, at)?.name).toBe("VOI-01");
    expect(finer(all, chain, voi1a, at)).toBeUndefined();
    // Outside every zoom: the nearest zoom inside the layer the views are on.
    const far = [85_000, 85_000, 85_000];
    expect(finer(all, chainAt(all, far), organ, far)?.name).toBe("VOI-02");
    // A layer left (the position moved out of it): its container.
    expect(coarser(all, chainAt(all, far), voi1)?.name).toBe("organ");
  });
});

describe("framing a layer", () => {
  it("centres it and fits its largest extent, in canonical voxels", () => {
    const f = framing(voi1, [um, um, um], [0, 1, 2], 400)!;
    expect(f.position).toEqual([30_000, 30_000, 30_000]);
    expect(f.crossSectionScale).toBeCloseTo((20_000 * 1.1) / 400);
    expect(f.projectionScale).toBeCloseTo(20_000 * 1.25);
  });

  it("measures in the finest displayed dimension's units", () => {
    // z counts 2 µm steps: a box 100 coordinates deep is 200 µm, the largest.
    const f = framing({ lower: [0, 0, 0], upper: [50, 50, 100] }, [um, um, 2 * um], [0, 1, 2], 100)!;
    expect(f.crossSectionScale).toBeCloseTo((200 * 1.1) / 100);
  });

  it("leaves dimensions the layer does not have", () => {
    const f = framing({ lower: [0, 0, -Infinity, 3], upper: [10, 10, Infinity, 4] }, [um, um, um, 1], [0, 1, 2], 100)!;
    expect(f.position[2]).toBeNaN();
    expect(f.position[3]).toBe(3.5);
  });
});

describe("the level drawn", () => {
  // A pyramid of six levels from 20 µm: 20, 40, 80, 160, 320, 640 µm.
  const levels = [20, 40, 80, 160, 320, 640].map((v) => v * um);
  it("is the finest when a screen pixel is smaller than a voxel", () => {
    expect(estimateLevel(levels, 5 * um)).toBe(0);
  });
  it("is the level nearest a screen pixel (enlarged by a tenth)", () => {
    expect(estimateLevel(levels, 290 * um)).toBe(4);
    expect(estimateLevel(levels, 150 * um)).toBe(3);
    expect(estimateLevel(levels, 100 * um)).toBe(2);
  });
  it("is the coarsest when zoomed far out", () => {
    expect(estimateLevel(levels, 10_000 * um)).toBe(5);
  });
  it("follows the render scale target", () => {
    expect(estimateLevel(levels, 150 * um, 2)).toBe(4);
  });
  it("has none without levels", () => {
    expect(estimateLevel([], um)).toBeUndefined();
  });
});

describe("voxel sizes", () => {
  it("are the middle of three, and shown in SI units", () => {
    expect(voxelOf({ voxelSize: [3, 1, 2] })).toBe(2);
    expect(voxelOf({ voxelSize: [1, NaN, 5] })).toBe(1);
    expect(lengthText(19.57e-6)).toEqual({ value: "19.6", unit: "µm" });
    expect(lengthText(6.5e-6)).toEqual({ value: "6.5", unit: "µm" });
    expect(lengthText(313e-6)).toEqual({ value: "313", unit: "µm" });
    expect(lengthText(1.252e-3)).toEqual({ value: "1.25", unit: "mm" });
    expect(lengthText(2e-6)).toEqual({ value: "2", unit: "µm" });
    expect(lengthText(NaN)).toEqual({ value: "–", unit: "" });
  });
});
