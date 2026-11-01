import { describe, expect, it } from "vitest";
import { lineEnd, shift, stackColumn } from "../labels.js";

describe("labels", () => {
  it("sets a label beside its pin", () => {
    expect(shift("top-right")).toEqual({ fx: 0, fy: -1, gx: 1, gy: -1 });
    expect(shift("center")).toEqual({ fx: -0.5, fy: -0.5, gx: 0, gy: 0 });
    expect(shift("bottom-left")).toEqual({ fx: -1, fy: 0, gx: -1, gy: 1 });
  });

  it("stacks callouts at a side in their pins' order, without overlap", () => {
    const ys = stackColumn([50, 52, 10], [20, 20, 20], 0, 200);
    expect(ys[2]).toBe(10);
    expect(ys[0]).toBeGreaterThanOrEqual(ys[2] + 20);
    expect(ys[1]).toBeGreaterThanOrEqual(ys[0] + 20);
  });

  it("moves a column up when it runs past the bottom", () => {
    const ys = stackColumn([190, 195], [20, 20], 0, 200);
    expect(Math.max(...ys) + 10).toBeLessThanOrEqual(200);
  });

  it("ends a leader line on the box's side nearer the pin", () => {
    // A box 100 x 20 with its left middle at (200, 100); the pin far to the left.
    expect(lineEnd([0, 100], [200, 100], 0, -0.5, 100, 20)).toEqual([200, 100]);
    // The pin below.
    expect(lineEnd([250, 300], [200, 100], 0, -0.5, 100, 20)).toEqual([250, 110]);
  });
});
