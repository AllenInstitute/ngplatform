/** A 2-D view's camera for splats: RAS millimetres to the panel, and its section as a plane. */
import { describe, expect, it } from "vitest";
import { rasToPanel, sectionPlane } from "../view_math.js";

describe("splats in a 2-D view", () => {
  it("maps RAS mm through the global dimensions to the panel, and finds the section in mm", () => {
    // Global x, y, z in 0.5 mm, and t held at 3; an axial view: 10 px per global unit on x and
    // y (y down), depth 1 per global unit of z, the section at z = 4 (global) = 2 mm.
    const globals = { names: ["x", "y", "z", "t"], scales: [0.5, 0.5, 0.5, 1], units: ["mm", "mm", "mm", "s"], position: [0, 0, 4, 3] };
    const rows = [
      [10, 0, 0, 0, 100],
      [0, -10, 0, 0, 80],
      [0, 0, 1, 0, -4],
    ];
    const m = rasToPanel(globals, rows);
    const at = (p: number[]) => [0, 1, 2].map((i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]);
    // 1 mm right = 2 global units = 20 px; 1 mm anterior = 20 px up.
    expect(at([1, 1, 2])).toEqual([120, 60, 0]);
    expect(sectionPlane(m)).toEqual([0, 0, 1, -2]);
    // A plane's distance is in mm whatever the depth's units.
    const [a, b, c, d] = sectionPlane(m)!;
    expect(a * 0 + b * 0 + c * 5 + d).toBe(3);
  });
});
