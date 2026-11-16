import { describe, expect, it } from "vitest";
import { cropsOf, editCrops, fractionsToMm, mmToFractions, readSaved } from "../plugin.js";
import { sceneAngles, sceneDirection } from "../view.js";

describe("each layer's crops and cuts", () => {
  it("reads a layer's own beside all layers', and a lighting style of before", () => {
    const s = readSaved({
      boxes: [{ name: "A", lo: [0, 0, 0], hi: [1, 1, 1], mm: true }],
      looks: { voi: { on: true, boxes: [{ name: "B", lo: [0.1, 0.2, 0.3], hi: [0.4, 0.5, 0.6] }], cuts: [{ on: true, offset: 2 }, {}, {}], planes: [{ name: "P", normal: [0, 0, 1], point: [1, 2, 3] }] } },
      lightStyle: "hard",
    });
    expect(s.boxes[0].mm).toBe(true);
    expect(cropsOf(s, "voi").boxes[0]).toMatchObject({ name: "B", on: true, keep: true });
    expect(cropsOf(s, "voi").cuts[0]).toMatchObject({ axis: "x", on: true, offset: 2 });
    expect(cropsOf(s, "voi").planes[0]).toMatchObject({ name: "P", on: true, offset: 0 });
    // A layer with none of its own: none, the axis planes off.
    expect(cropsOf(s, "other").boxes).toEqual([]);
    expect(cropsOf(s, "other").cuts.every((c) => !c.on)).toBe(true);
    expect(s.lightStyle).toBe("strong");
    expect(s.lightFrom).toBe("front");
  });

  it("edits a scope as new objects, leaving the state saved before as it was", () => {
    const s = readSaved({ looks: { voi: { on: true } } });
    const before = s.looks;
    editCrops(s, "voi", (c) => void c.boxes.push({ name: "B", on: true, keep: false, lo: [0, 0, 0], hi: [0.5, 0.5, 0.5] }));
    expect(s.looks).not.toBe(before);
    expect(before.voi.boxes).toBeUndefined();
    expect(s.looks.voi).toMatchObject({ on: true, boxes: [{ name: "B", keep: false }] });
    editCrops(s, null, (c) => void (c.cuts[2].on = true));
    expect(s.cuts[2].on).toBe(true);
    expect(cropsOf(s, "voi").cuts[2].on).toBe(false);
  });

  it("puts a box in millimetres and back as fractions of another volume", () => {
    // 100 voxels a side of 0.02 mm, and one of 10 voxels a side of 0.1 mm moved 0.5 mm along x.
    const fine = { m: [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 1], size: [100, 100, 100] };
    const coarse = { m: [0.1, 0, 0, 0.5, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1], size: [10, 10, 10] };
    const mm = fractionsToMm({ lo: [0, 0, 0], hi: [0.5, 1, 1] }, fine);
    expect(mm.lo.map((x) => +x.toFixed(4))).toEqual([-0.01, -0.01, -0.01]);
    expect(mm.hi.map((x) => +x.toFixed(4))).toEqual([0.99, 1.99, 1.99]);
    const back = mmToFractions(mm, fine);
    expect(back.lo.map((x) => +x.toFixed(6))).toEqual([0, 0, 0]);
    expect(back.hi.map((x) => +x.toFixed(6))).toEqual([0.5, 1, 1]);
    const there = mmToFractions(mm, coarse);
    expect(there.lo[0]).toBeCloseTo((-0.01 - 0.5) / 0.1 / 10 + 0.05, 6);
    expect(there.hi[1]).toBeCloseTo(1.99 / 0.1 / 10 + 0.05, 6);
  });
});

describe("the light", () => {
  it("turns a direction in the scene into angles and back", () => {
    expect(sceneDirection(0, 0).map((x) => +x.toFixed(6))).toEqual([1, 0, 0]);
    expect(sceneDirection(90, 0).map((x) => +x.toFixed(6))).toEqual([0, 1, 0]);
    expect(sceneDirection(0, 90).map((x) => +x.toFixed(6))).toEqual([0, 0, 1]);
    expect(sceneAngles(sceneDirection(-135, 30))).toEqual({ around: -135, up: 30 });
  });
});
