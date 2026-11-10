/**
 * The graph's layout at scale (a hundred members over two systems, and
 * some joined to none): no box overlaps another or leaves the drawing, names
 * fit their boxes, a large group is folded and opened, and the keyboard's
 * moves between boxes.
 */
import { describe, expect, it } from "vitest";
import { fit, GRAPH, shortName, type GraphBox, type GraphInput, layoutGraph, nextBox, SHOWN } from "../graph_view.js";

/** `n` members: most joined to MNI by a translation, every fifth to World by an affine too, the last three to nothing. */
function synthetic(n: number): GraphInput {
  const members = Array.from({ length: n }, (_, i) => ({ name: `sub-${String(i).padStart(3, "0")}_sample-brain_stain-lectin.ome.zarr`, keys: [`m${i}`] }));
  const transforms = members.slice(0, n - 3).flatMap((m, i) => [
    { input: `m${i}`, output: "mni", type: "translation" },
    ...(i % 5 === 0 ? [{ input: `m${i}`, output: "world", type: "affine" }] : []),
  ]);
  transforms.push({ input: "world", output: "mni", type: "affine" });
  return { systems: [{ id: "mni", name: "MNI" }, { id: "world", name: "World" }], members, transforms };
}

const overlap = (a: GraphBox, b: GraphBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function expectTidy(boxes: GraphBox[], width: number, height: number) {
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(width);
    expect(b.y + b.h).toBeLessThanOrEqual(height);
    // Each line fits its box at a caption character's width.
    for (const line of b.lines) if (line) expect(line.length * GRAPH.char).toBeLessThanOrEqual(b.w);
  }
  for (let i = 0; i < boxes.length; ++i) for (let j = i + 1; j < boxes.length; ++j) expect(overlap(boxes[i], boxes[j]), `${boxes[i].key} / ${boxes[j].key}`).toBe(false);
}

describe("the collection graph's layout", () => {
  it("groups a hundred members by system, folded, with no box overlapping another", () => {
    const layout = layoutGraph(synthetic(100), new Set(), "mni");
    expectTidy(layout.boxes, layout.width, layout.height);
    const systems = layout.boxes.filter((b) => b.kind === "system");
    expect(systems.map((b) => b.lines[0])).toEqual(["MNI", "World"]);
    // MNI's 97 members fold to SHOWN - 1 and "+86 more"; World's 20 likewise; the three joined to nothing are shown.
    const more = layout.boxes.filter((b) => b.kind === "more");
    expect(more.map((b) => b.lines[0])).toEqual([`+${97 - (SHOWN - 1)} more`, `+${20 - (SHOWN - 1)} more`, ]);
    expect(layout.boxes.filter((b) => b.kind === "member")).toHaveLength(2 * (SHOWN - 1) + 3);
    // Readable at the panel's width: under a thousand units tall.
    expect(layout.height).toBeLessThan(1000);
    // The transform between the systems is said in World's box and drawn as an arc, not a label over a box.
    expect(systems[1].lines[1]).toBe("affine → MNI");
    expect(layout.arcs).toHaveLength(1);
  });

  it("shows every member of a group opened, still with no overlaps", () => {
    const layout = layoutGraph(synthetic(100), new Set(["s:mni", "s:world"]));
    expectTidy(layout.boxes, layout.width, layout.height);
    expect(layout.boxes.filter((b) => b.kind === "member")).toHaveLength(97 + 20 + 3);
    expect(layout.boxes.filter((b) => b.kind === "more").map((b) => b.lines[0])).toEqual(["Show fewer", "Show fewer"]);
  });

  it("names each box for a screen reader, and cuts long names to their box", () => {
    const layout = layoutGraph(synthetic(10), new Set(), "mni");
    const first = layout.boxes.find((b) => b.kind === "member")!;
    expect(first.label).toBe("member sub-000_sample-brain_stain-lectin.ome.zarr, in system MNI, translation");
    expect(first.lines[0]).toMatch(/^sub-000_sample-bra.*…$/);
    expect(fit(shortName("sub-000_brain.ome.zarr", 20), 20)).toBe("sub-000_brain");
    expect(shortName("short.ome.zarr", 20)).toBe("short.ome.zarr");
    expect(layout.boxes[0].label).toBe("system MNI, viewed, 7 members");
    expect(layout.boxes.find((b) => b.member?.startsWith("sub-009"))!.label).toContain("joined to no system, no transform");
    expect(fit("translation", 6)).toBe("trans…");
    expect(fit("affine", 6)).toBe("affine");
  });

  it("moves the keyboard's focus along rows, between rows, and to either end", () => {
    const { boxes } = layoutGraph(synthetic(10));
    // 0 is MNI's box; 1 and 2 its first row of members.
    expect(boxes[1].y).toBe(boxes[2].y);
    expect(nextBox(boxes, 0, "ArrowDown")).toBe(1);
    expect(nextBox(boxes, 1, "ArrowRight")).toBe(2);
    expect(nextBox(boxes, 2, "ArrowDown")).toBe(4);
    expect(nextBox(boxes, 4, "ArrowUp")).toBe(2);
    expect(nextBox(boxes, 1, "ArrowUp")).toBe(0);
    expect(nextBox(boxes, 0, "ArrowUp")).toBeUndefined();
    expect(nextBox(boxes, 0, "ArrowLeft")).toBeUndefined();
    expect(nextBox(boxes, 3, "End")).toBe(boxes.length - 1);
    expect(nextBox(boxes, 5, "Home")).toBe(0);
    expect(nextBox(boxes, boxes.length - 1, "ArrowRight")).toBeUndefined();
    expect(nextBox(boxes, 0, "a")).toBeUndefined();
  });
});
