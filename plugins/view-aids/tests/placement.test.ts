import { describe, expect, it } from "vitest";
import { placeLabels, segmentsCross, spaceColumn } from "../placement.js";
import { describedPoints, toGlobal } from "../labels.js";

describe("spacing a column", () => {
  it("leaves labels that fit where they want to be", () => {
    expect(spaceColumn([10, 50, 90], 20, 0, 100)).toEqual([10, 50, 90]);
  });

  it("spreads a crowd evenly about where it wants to be, in order", () => {
    const ys = spaceColumn([50, 50, 50], 20, 0, 200);
    expect(ys).toEqual([30, 50, 70]);
  });

  it("never overlaps, and stays within the column", () => {
    const wanted = [5, 6, 7, 300, 301, 302, 303];
    const ys = spaceColumn(wanted, 22, 10, 290);
    for (let i = 1; i < ys.length; ++i) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(22 - 1e-9);
    expect(ys[0]).toBeGreaterThanOrEqual(10);
    expect(ys[ys.length - 1]).toBeLessThanOrEqual(290);
  });

  it("is the least-squares fit (pooled where labels collide)", () => {
    // Two that collide share the shift: each moves half the overlap.
    expect(spaceColumn([100, 110], 20, 0, 1000)).toEqual([95, 115]);
  });

  it("spreads labels that cannot fit from top to bottom", () => {
    expect(spaceColumn([0, 0, 0], 100, 0, 100)).toEqual([0, 50, 100]);
    expect(spaceColumn([], 10, 0, 100)).toEqual([]);
  });
});

describe("placing labels at the sides", () => {
  const view = { width: 400, height: 300 };
  const options = { height: 22, top: 20, bottom: 280 };

  it("sends each point to its side and keeps them apart", () => {
    const points = [
      { x: 100, y: 150, depth: 0 },
      { x: 110, y: 152, depth: 0 },
      { x: 300, y: 100, depth: 0 },
      { x: 120, y: 149, depth: 0 },
    ];
    const placed = placeLabels(points, view, options);
    expect(placed.filter((p) => p.side === "left").map((p) => p.index).sort()).toEqual([0, 1, 3]);
    // Where its ray from the far side's middle meets this side.
    expect(placed.find((p) => p.index === 2)!.side).toBe("right");
    expect(placed.find((p) => p.index === 2)!.y).toBeCloseTo(150 - (50 * 400) / 300);
    const left = placed.filter((p) => p.side === "left").sort((a, b) => a.y - b.y);
    for (let i = 1; i < left.length; ++i) expect(left[i].y - left[i - 1].y).toBeGreaterThanOrEqual(22 - 1e-9);
  });

  it("orders a side by angle, so leader lines do not cross", () => {
    // A point far from the edge and high, one near the edge and a little lower:
    // by height alone their lines would cross once pushed apart; by angle they fan out.
    const points = [
      { x: 190, y: 140, depth: 0 },
      { x: 20, y: 150, depth: 0 },
    ];
    const placed = placeLabels(points, view, options);
    const y0 = placed.find((p) => p.index === 0)!.y;
    const y1 = placed.find((p) => p.index === 1)!.y;
    // The one near the centre is at a steeper angle: it goes above.
    expect(y0).toBeLessThan(y1);
  });

  it("leaves no leaders crossing, however crowded", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 200; ++trial) {
      const points = Array.from({ length: 12 }, () => ({ x: 110 + random() * 180, y: 20 + random() * 260, depth: random(), width: 30 + random() * 60 }));
      const placed = placeLabels(points, view, { ...options, inset: 8 });
      expect(placed).toHaveLength(12);
      const leader = (k: number): [[number, number], [number, number]] => {
        const p = points[placed[k].index];
        const x = placed[k].side === "left" ? 8 + p.width : 400 - 8 - p.width;
        return [[p.x, p.y], [x, placed[k].y]];
      };
      for (let i = 0; i < placed.length; ++i)
        for (let j = i + 1; j < placed.length; ++j) {
          if (placed[i].side !== placed[j].side) continue;
          expect(segmentsCross(...leader(i), ...leader(j)), `trial ${trial}`).toBe(false);
          expect(Math.abs(placed[i].y - placed[j].y)).toBeGreaterThanOrEqual(22 - 1e-9);
        }
    }
  });

  it("tells crossing segments", () => {
    expect(segmentsCross([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true);
    expect(segmentsCross([0, 0], [10, 0], [0, 5], [10, 5])).toBe(false);
    expect(segmentsCross([0, 0], [10, 10], [10, 10], [20, 0])).toBe(false);
  });

  it("starts the right side below the cube, and keeps the nearest when a side is full", () => {
    const placed = placeLabels([{ x: 300, y: 10, depth: 0 }], view, { ...options, rightTop: 120 });
    expect(placed[0].y).toBe(120);
    const many = Array.from({ length: 30 }, (_, i) => ({ x: 50, y: 10 * i, depth: i / 30 }));
    const kept = placeLabels(many, view, options);
    expect(kept.length).toBe(Math.floor((280 - 20) / 22) + 1);
    expect(Math.max(...kept.map((p) => many[p.index].depth))).toBeLessThan(0.5);
  });
});

describe("labelled points", () => {
  it("reads point annotations with a description from visible annotation layers", () => {
    const layers = [
      {
        type: "annotation",
        name: "marks",
        annotations: [
          { type: "point", point: [1, 2, 3], description: "Hippocampus\nleft" },
          { type: "point", point: [4, 5, 6] },
          { type: "line", pointA: [0, 0, 0], pointB: [1, 1, 1], description: "a line" },
        ],
      },
      { type: "annotation", name: "hidden", visible: false, annotations: [{ type: "point", point: [0, 0, 0], description: "x" }] },
      { type: "image", name: "img" },
    ];
    expect(describedPoints(layers)).toEqual([{ layer: "marks", text: "Hippocampus", point: [1, 2, 3] }]);
  });

  it("places points through the layer's transform, else as global coordinates", () => {
    const space = { names: ["x", "y", "z"], scales: [0.001, 0.001, 0.001], units: ["m", "m", "m"] };
    expect(toGlobal(undefined, space, 3)([1, 2, 3])).toEqual([1, 2, 3]);
    // A 2 mm source shifted by 10 along x: its coordinates double, then move.
    const matrix = new Float64Array(16);
    matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
    matrix[12] = 10;
    const t = {
      rank: 3,
      input: { names: ["x", "y", "z"], scales: [0.002, 0.002, 0.002], units: ["m", "m", "m"] },
      output: { names: ["x", "y", "z"], scales: [0.001, 0.001, 0.001], units: ["m", "m", "m"] },
      matrix,
      defaultMatrix: matrix,
    };
    expect(toGlobal(t, space, 3)([1, 2, 3])).toEqual([12, 4, 6]);
  });
});
