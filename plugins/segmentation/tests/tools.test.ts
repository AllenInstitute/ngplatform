/**
 * The tool bar's tools and the segment list: cycling tools, the brush's
 * size steps, new segment ids, which segments a layer shows, the list's
 * rows; and what the list asks of a volume (counts kept by chunk, a
 * segment's centre, a copy written a block at a time), with the edits it
 * makes (merge, delete, fills in a section and in 3-D) undone and redone.
 */
import { describe, expect, it } from "vitest";
import { labelTypeOf } from "../editor.js";
import { History, Stroke } from "../history.js";
import { floodFill, paintBall, relabel, sameLabel, type Vec3 } from "../kernels.js";
import { LabelVolume } from "../label_volume.js";
import { SEGMENTATION_MANIFEST } from "../manifest.js";
import { isVisible, nextSegment, segmentName, segmentRows, withVisibility } from "../segments.js";
import { addGroup, assign, editGroup, groupOf, grouped, members, noGroups, readGroups, removeGroup } from "../segment_groups.js";
import { barSpan, rowsMax } from "../toolbar.js";
import { brushes, cycle, draws, stepRadius, TOOLS } from "../tools.js";
import { checkManifest } from "../../../src/sdk/manifest.js";

const PLACE = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const vol = (size: Vec3 = [100, 80, 70]) => new LabelVolume(size, "uint16", PLACE, "t");

describe("the tools", () => {
  it("starts with Move, the one tool that does not draw", () => {
    expect(TOOLS[0].id).toBe("move");
    expect(TOOLS.filter((t) => !draws(t.id)).map((t) => t.id)).toEqual(["move"]);
    expect(TOOLS.filter((t) => brushes(t.id)).map((t) => t.id)).toEqual(["brush", "erase"]);
  });

  it("cycles round the bar both ways (W, Shift+W)", () => {
    expect(cycle("move", 1)).toBe("brush");
    expect(cycle("quick", 1)).toBe("move");
    expect(cycle("move", -1)).toBe("quick");
    expect(cycle("fill", -2)).toBe("erase");
    expect(cycle("erase", 1)).toBe("lasso");
  });

  it("steps the brush by a quarter, and in whole voxels by at least one", () => {
    expect(stepRadius(1, 1, "mm")).toBe(1.25);
    expect(stepRadius(1, -1, "mm")).toBe(0.8);
    expect(stepRadius(1, 2, "mm")).toBe(1.56);
    expect(stepRadius(0.01, -3, "mm")).toBe(0.01);
    expect(stepRadius(1, 1, "voxels")).toBe(2);
    expect(stepRadius(2, -1, "voxels")).toBe(1);
    expect(stepRadius(1, -1, "voxels")).toBe(1);
    expect(stepRadius(20, 1, "voxels")).toBe(25);
    expect(stepRadius(5, 0, "voxels")).toBe(5);
  });

  it("binds WebKnossos's keys while a volume is edited, each to a declared command", () => {
    expect(checkManifest(SEGMENTATION_MANIFEST)).toEqual([]);
    const keys = new Map((SEGMENTATION_MANIFEST.contributes?.keybindings ?? []).map((k) => [k.key, k]));
    for (const [key, tool] of [["b", "brush"], ["e", "erase"], ["f", "fill"], ["i", "pick"], ["m", "move"]]) expect((keys.get(key)?.args as { tool: string }).tool).toBe(tool);
    expect(keys.get("c")?.command).toBe("segmentation.newSegment");
    expect(keys.get("v")?.command).toBe("segmentation.interpolate");
    expect(keys.get("mod+z")?.command).toBe("segmentation.undo");
    expect(keys.get("mod+y")?.command).toBe("segmentation.redo");
    for (const k of keys.values()) expect(k.when).toMatch(/^segmentation\./);
  });
});

describe("the tool bar's place", () => {
  const panel = (kind: "2d" | "3d", left: number, top: number, right: number, bottom: number) => ({ kind, rect: { left, top, right, bottom } });

  it("spans the 2-D view beside a 3-D one (xy-3d), not the 3-D view", () => {
    expect(barSpan([panel("2d", 0, 40, 550, 750), panel("3d", 550, 40, 1100, 750)])).toEqual({ left: 0, right: 550, top: 40 });
  });

  it("spans the top row of 2-D views in four panels", () => {
    const four = [panel("2d", 0, 40, 550, 395), panel("2d", 550, 40, 1100, 395), panel("2d", 0, 395, 550, 750), panel("3d", 550, 395, 1100, 750)];
    expect(barSpan(four)).toEqual({ left: 0, right: 1100, top: 40 });
  });

  it("takes the widest 2-D view when a 3-D view sits between them, and every view with no 2-D view", () => {
    expect(barSpan([panel("2d", 0, 40, 300, 750), panel("3d", 300, 40, 700, 750), panel("2d", 700, 40, 1100, 750)])).toEqual({ left: 700, right: 1100, top: 40 });
    expect(barSpan([panel("3d", 0, 40, 1100, 750)])).toEqual({ left: 0, right: 1100, top: 40 });
  });


  it("names New segment's id with half a million segments (no Math.max over a spread)", () => {
    const values = Array.from({ length: 500_000 }, (_, k) => k + 1);
    expect(rowsMax(values, 2 ** 32 - 1)).toBe("segment 500001");
    expect(rowsMax(values, 500_000)).toBe("the smallest unused id");
    expect(rowsMax([], 255)).toBe("segment 1");
  });
});

describe("segments", () => {
  it("gives a new segment one more than the largest used, or the smallest free one at the top", () => {
    expect(nextSegment([], 255)).toBe(1);
    expect(nextSegment([1, 2, 7], 255)).toBe(8);
    expect(nextSegment([255, 1], 255)).toBe(2);
    expect(nextSegment([1, 2, 3], 3)).toBe(0);
  });

  it("reads which segments a layer shows from Neuroglancer's list", () => {
    expect(isVisible({}, 3)).toBe(true);
    expect(isVisible({ segments: [] }, 3)).toBe(true);
    expect(isVisible({ segments: ["1"] }, 3)).toBe(false);
    expect(isVisible({ segments: ["1", "!3"], ignoreNullVisibleSet: false }, 3)).toBe(false);
    expect(isVisible({ segments: ["!3"], ignoreNullVisibleSet: false }, 1)).toBe(false);
    expect(isVisible({ segments: ["!3"] }, 1)).toBe(true);
  });

  it("hides one segment by listing the others, and shows all again with an empty list", () => {
    const hidden = withVisibility({}, [1, 2, 3], 2, false);
    expect(hidden).toEqual({ segments: ["1", "3", "!2"], ignoreNullVisibleSet: false });
    expect([1, 2, 3].map((v) => isVisible(hidden, v))).toEqual([true, false, true]);
    // A segment painted later, not in the list, does not show until it is shown.
    expect(isVisible(hidden, 4)).toBe(false);
    const four = withVisibility(hidden, [1, 2, 3, 4], 4, true);
    expect([1, 2, 3, 4].map((v) => isVisible(four, v))).toEqual([true, false, true, true]);
    expect(withVisibility(four, [1, 2, 3, 4], 2, true)).toEqual({ segments: [], ignoreNullVisibleSet: true });
    // Hiding the only one hides it: an empty list then shows nothing.
    const none = withVisibility({}, [5], 5, false);
    expect(isVisible(none, 5)).toBe(false);
  });

  it("lists segments painted and those made or named, in order", () => {
    const counts = new Map([
      [3, 10],
      [1, 5],
    ]);
    const labels = new Map([[7, { name: "Hippocampus", colour: "#00ff00" }]]);
    const rows = segmentRows(counts, labels, (v) => labels.get(v)?.colour ?? "#ffffff", (v) => v !== 3);
    expect(rows.map((r) => [r.value, r.voxels, r.visible, r.colour])).toEqual([
      [1, 5, true, "#ffffff"],
      [3, 10, false, "#ffffff"],
      [7, 0, true, "#00ff00"],
    ]);
    expect(rows.map(segmentName)).toEqual(["Segment 1", "Segment 3", "Hippocampus"]);
  });
});

describe("what the segment list asks of a volume", () => {
  it("keeps counts by chunk, counting again only what a stroke changed", () => {
    const v = vol();
    const s = new Stroke(v);
    paintBall(s, [10, 10, 10], [1 / 9, 0, 0, 0, 1 / 9, 0, 0, 0, 1 / 9], { value: 2 });
    s.finish();
    const first = v.counts().get(2)!;
    expect(first).toBeGreaterThan(100);
    const t = new Stroke(v);
    t.set(90, 70, 60, 2);
    t.set(10, 10, 10, 5);
    t.finish();
    expect(v.counts().get(2)).toBe(first);
    expect(v.counts().get(5)).toBe(1);
    const h = new History();
    h.push(t);
    h.undo();
    expect(v.counts().get(2)).toBe(first);
    expect(v.counts().has(5)).toBe(false);
  });

  it("finds a segment's voxel nearest its centre, inside even a ring", () => {
    const v = vol();
    const s = new Stroke(v);
    // A ring in z = 20 round (50, 40): its mean is the empty middle.
    for (let a = 0; a < 360; a += 2) s.set(Math.round(50 + 10 * Math.cos((a * Math.PI) / 180)), Math.round(40 + 10 * Math.sin((a * Math.PI) / 180)), 20, 4);
    s.finish();
    const c = v.centre(4)!;
    expect(v.get(...c)).toBe(4);
    expect(c[2]).toBe(20);
    expect(Math.abs(Math.hypot(c[0] - 50, c[1] - 40) - 10)).toBeLessThan(1);
    expect(v.centre(9)).toBeUndefined();
  });

  it("copies a segmentation a block at a time, making no chunk for zeros", () => {
    const v = vol([130, 70, 10]);
    const size: Vec3 = [70, 70, 10];
    const data = new Float32Array(size[0] * size[1] * size[2]);
    data[0] = 3;
    data[69] = 2.0000001;
    v.addBlock([0, 0, 0], size, data);
    v.addBlock([70, 0, 0], size, new Float32Array(data.length));
    expect(v.get(0, 0, 0)).toBe(3);
    expect(v.get(69, 0, 0)).toBe(2);
    expect(v.chunkCount).toBe(2);
    expect(v.counts()).toEqual(
      new Map([
        [3, 1],
        [2, 1],
      ]),
    );
    // Only what fits the volume is written.
    const edge = new Float32Array(8).fill(1);
    v.addBlock([128, 68, 8], [2, 2, 2], edge);
    expect(v.get(129, 69, 9)).toBe(1);
    expect(v.counts().get(1)).toBe(8);
  });

  it("gives a copy the label type that holds its values", () => {
    expect(labelTypeOf("uint8")).toBe("uint8");
    expect(labelTypeOf("int16")).toBe("uint16");
    expect(labelTypeOf("uint32")).toBe("uint32");
    expect(labelTypeOf("uint64")).toBe("uint32");
    expect(labelTypeOf("float32")).toBe("uint32");
  });

  it("merges a segment into the active one and deletes one, undoably", () => {
    const v = vol();
    const s = new Stroke(v);
    for (let x = 0; x < 5; ++x) s.set(x, 0, 0, 1);
    for (let x = 0; x < 3; ++x) s.set(x, 1, 0, 2);
    s.finish();
    const h = new History();
    const merge = new Stroke(v);
    expect(relabel(merge, 2, 1)).toBe(3);
    merge.finish();
    h.push(merge);
    expect(v.counts()).toEqual(new Map([[1, 8]]));
    const del = new Stroke(v);
    expect(relabel(del, 1, 0)).toBe(8);
    del.finish();
    h.push(del);
    expect(v.chunkCount).toBe(0);
    h.undo();
    h.undo();
    expect(v.counts()).toEqual(
      new Map([
        [1, 5],
        [2, 3],
      ]),
    );
    h.redo();
    expect(v.counts()).toEqual(new Map([[1, 8]]));
  });

  it("fills a closed outline in its section in 2-D, and through sections in 3-D", () => {
    const v = vol([40, 40, 10]);
    const s = new Stroke(v);
    // A square outline 10 × 10 in sections 2 to 4.
    for (let z = 2; z <= 4; ++z) {
      for (let i = 10; i <= 20; ++i) {
        s.set(i, 10, z, 1);
        s.set(i, 20, z, 1);
        s.set(10, i, z, 1);
        s.set(20, i, z, 1);
      }
    }
    s.finish();
    const seed: Vec3 = [15, 15, 3];
    const flat = new Stroke(v);
    const r2 = floodFill(flat, seed, sameLabel(v, seed), { value: 2 }, { axis: 2 });
    flat.finish();
    expect(r2.changed).toBe(81);
    expect(v.get(15, 15, 2)).toBe(0);
    const deep = new Stroke(v);
    // In 3-D the inside joins the sections above and below (open at their ends): a box keeps it near.
    const r3 = floodFill(deep, [15, 15, 2], sameLabel(v, [15, 15, 2]), { value: 3 }, { box: { lo: [5, 5, 0], hi: [26, 26, 10] } });
    deep.finish();
    expect(r3.limited).toBe(false);
    expect(v.get(15, 15, 2)).toBe(3);
    expect(v.get(15, 15, 3)).toBe(2);
    expect(v.get(4, 4, 2)).toBe(0);
  });
});

describe("segment groups", () => {
  it("makes groups with names and colours of their own, renames, folds and recolours them", () => {
    let vg = noGroups();
    const a = addGroup(vg);
    vg = a.next;
    const b = addGroup(vg, "  Ventricles ");
    vg = b.next;
    expect(vg.groups.map((g) => g.name)).toEqual(["Group 1", "Ventricles"]);
    expect(vg.groups[0].colour).not.toBe(vg.groups[1].colour);
    expect(a.id).not.toBe(b.id);
    vg = editGroup(vg, a.id, { name: "Left", collapsed: true });
    vg = editGroup(vg, b.id, { name: "   ", colour: "#123456" });
    expect(vg.groups).toEqual([
      { id: a.id, name: "Left", colour: vg.groups[0].colour, collapsed: true },
      { id: b.id, name: "Ventricles", colour: "#123456" },
    ]);
    // The next "Group n" is the smallest not taken.
    expect(addGroup(editGroup(vg, a.id, { name: "Group 2" })).next.groups[2].name).toBe("Group 1");
  });

  it("puts each segment in one group at most, lists the groups' rows, and keeps segments when a group goes", () => {
    let vg = noGroups();
    const g1 = addGroup(vg);
    const g2 = addGroup(g1.next);
    vg = g2.next;
    vg = assign(vg, [1, 2, 5], g1.id);
    vg = assign(vg, [2], g2.id);
    expect(groupOf(vg, 2)?.id).toBe(g2.id);
    expect(members(vg, g1.id, [1, 2, 3, 5])).toEqual([1, 5]);
    expect(assign(vg, [3], "nope")).toBe(vg);
    const rows = [1, 2, 3, 4, 5].map((value) => ({ value }));
    expect(grouped(vg, rows).map((s) => `${s.group?.name ?? "none"}:${s.rows.map((r) => r.value).join(",")}`)).toEqual(["Group 1:1,5", "Group 2:2", "none:3,4"]);
    vg = removeGroup(vg, g1.id);
    expect(vg.groups.length).toBe(1);
    expect(groupOf(vg, 1)).toBeUndefined();
    expect(groupOf(vg, 2)?.id).toBe(g2.id);
    vg = assign(vg, [2], undefined);
    expect(vg.of).toEqual({});
  });

  it("reads saved groups, dropping what does not fit", () => {
    expect(readGroups(undefined)).toEqual(noGroups());
    const raw = { groups: [{ id: "g1", name: "A", colour: "#ff0000" }, { id: 3, name: "bad" }, { id: "g2", name: "B" }], of: { "7": "g1", "8": "gone", x: "g1", "9": "g2" } };
    const vg = readGroups(raw);
    expect(vg.groups.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(vg.groups[1].colour).toMatch(/^#/);
    expect(vg.of).toEqual({ "7": "g1", "9": "g2" });
  });
});
