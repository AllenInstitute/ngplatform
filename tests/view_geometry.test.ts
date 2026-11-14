import { describe, expect, it } from "vitest";
import {
  arcball,
  axisDelta,
  boxSection,
  changedFrame,
  convexOrder,
  cornersSection,
  ellipsePoints,
  ellipseReach,
  ellipsoidSection,
  frameCorners,
  frameScale,
  insidePolygon,
  jacobian,
  planeDelta,
  planeFrame,
  planeSection,
  type Project3,
  rotate,
  screenOf,
  screenTurn,
  sectionDistance,
  sectionOf,
  segmentDistance,
  solve2,
  solve3,
  type Vec2,
  type Vec3,
  viewPlaneDelta,
} from "../src/core/view_geometry.js";

/** A 2-D view of the z = `z` section: 4 px a unit, x right, y down, centred at (100, 50); depth over ±1 unit of z. */
const axial =
  (z = 0): Project3 =>
  (p) => ({ x: 100 + 4 * p[0], y: 50 + 4 * p[1], depth: p[2] - z });

/** A 2-D view of the x = 0 section (sagittal): y right, z up. */
const sagittal: Project3 = (p) => ({ x: 100 + 2 * p[1], y: 50 - 2 * p[2], depth: p[0] });

/** A perspective camera at (0, 0, 10) looking down −z, focal length 100 px. */
const perspective: Project3 = (p) => {
  const w = 10 - p[2];
  if (w <= 0) return undefined;
  return { x: 200 + (100 * p[0]) / w, y: 150 - (100 * p[1]) / w, depth: 1 - 2 / w };
};

const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 6) => Array.from(a).forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe("solving", () => {
  it("solves 2 × 2 and 3 × 3 systems, and says when singular", () => {
    close(solve2(2, 1, 1, 3, 5, 10)!, [1, 3]);
    expect(solve2(1, 2, 2, 4, 1, 1)).toBeUndefined();
    close(solve3([2, 0, 1, 1, 3, 0, 0, 1, 4], [5, 7, 9])!, [1.6, 1.8, 1.8]);
    expect(solve3([1, 2, 3, 2, 4, 6, 0, 0, 1], [1, 2, 3])).toBeUndefined();
  });
});

describe("the screen Jacobian", () => {
  it("is the pixels a unit step along each axis moves, and the depth it changes", () => {
    const j = jacobian(axial(), [3, 4, 0])!;
    close(j, [4, 0, 0, 0, 4, 0, 0, 0, 1]);
    close(screenOf(j, [1, 2, 3]), [4, 8]);
  });

  it("follows a perspective view where the point is", () => {
    const j = jacobian(perspective, [0, 0, 0])!;
    close(j.slice(0, 2), [10, 0], 4);
    expect(j[4]).toBeCloseTo(-10, 4);
  });

  it("is undefined when a step goes behind the camera", () => {
    expect(jacobian(perspective, [0, 0, 10])).toBeUndefined();
  });
});

describe("mouse to world", () => {
  it("moves within the section in a 2-D view", () => {
    const j = jacobian(sagittal, [0, 5, 5])!;
    // 10 px right is 5 units along y; 10 px down is 5 units down z; x (the normal) does not change.
    close(viewPlaneDelta(j, 10, 10), [0, 5, -5]);
  });

  it("moves in the plane facing the camera in a 3-D view, following the mouse", () => {
    const p: Vec3 = [1, 1, 0];
    const j = jacobian(perspective, p)!;
    const d = viewPlaneDelta(j, 5, -3);
    expect(d[2]).toBeCloseTo(0, 6);
    const a = perspective(p)!;
    const b = perspective([p[0] + d[0], p[1] + d[1], p[2] + d[2]])!;
    close([b.x - a.x, b.y - a.y], [5, -3], 6);
  });

  it("solves the 2 × 2 system of a plane's two directions (project p, p + u, p + v)", () => {
    // The plane x = y, spanned by (1, 1, 0) and (0, 0, 1), seen axially: z does not show, so no answer.
    expect(planeDelta(axial(), [0, 0, 0], [1, 1, 0], [0, 0, 1], 8, 8)).toBeUndefined();
    // Seen sagittally: 4 px right is 2 along (1, 1, 0); 4 px up is 2 along z.
    close(planeDelta(sagittal, [0, 0, 0], [1, 1, 0], [0, 0, 1], 4, -4)!, [2, 2, 2]);
  });

  it("moves along an axis by the mouse's movement along its screen image", () => {
    const j = jacobian(axial(), [0, 0, 0])!;
    expect(axisDelta(j, [1, 0, 0], 8, 30)).toBeCloseTo(2);
    // An axis seen end on does not move.
    expect(axisDelta(j, [0, 0, 1], 8, 30)).toBe(0);
  });
});

describe("sections", () => {
  const section = (project: Project3, origin: Vec3) => {
    const j = jacobian(project, origin)!;
    const o = project(origin)!;
    return sectionOf(j, origin, [o.x, o.y]);
  };

  it("finds a sphere's circle where the section cuts it, smaller off its centre", () => {
    const s = section(axial(3), [0, 0, 3]);
    expect(sectionDistance(s, [0, 0, 5])).toBeCloseTo(2);
    const e = ellipsoidSection([10, 5, 0], [5, 5, 5], s)!;
    close(e.centre, [140, 70]);
    // Radius √(25 − 9) = 4 units, 16 px.
    expect(Math.hypot(...e.a)).toBeCloseTo(16);
    expect(Math.hypot(...e.b)).toBeCloseTo(16);
    expect(ellipsoidSection([10, 5, 0], [5, 5, 2], s)).toBeUndefined();
  });

  it("finds an ellipsoid's ellipse, and how far a knob sits along an axis", () => {
    const s = section(sagittal, [0, 0, 0]);
    const e = ellipsoidSection([0, 0, 0], [1, 4, 2], s)!;
    // y (4 units, 8 px) along screen x; z (2 units, 4 px) along screen y.
    expect(ellipseReach(e, [1, 0])).toBeCloseTo(8);
    expect(ellipseReach(e, [0, -1])).toBeCloseTo(4);
    const points = ellipsePoints(e, 16);
    expect(points).toHaveLength(16);
    for (const [x, y] of points) expect(((x - 100) / 8) ** 2 + ((y - 50) / 4) ** 2).toBeCloseTo(1);
  });

  it("finds a box's rectangle where the section cuts it, and nothing when it misses", () => {
    const s = section(axial(1), [0, 0, 1]);
    const cut = boxSection([0, 0, 0], [2, 3, 4], s);
    const screen = convexOrder(cut.map((p) => [100 + 4 * p[0], 50 + 4 * p[1]] as Vec2));
    expect(screen).toHaveLength(4);
    expect(screen.map((p) => p.join(",")).sort()).toEqual(["100,50", "100,62", "108,50", "108,62"]);
    expect(boxSection([0, 0, 2], [2, 3, 4], s)).toHaveLength(0);
  });

  it("finds a plane's line in a section, through the point nearest its own", () => {
    const s = section(axial(0), [0, 0, 0]);
    // The plane x = z + 2 (normal (1, 0, −1)) meets z = 0 along x = 2.
    const line = planeSection([3, 7, 1], [1, 0, -1], s)!;
    close(line.at, [2, 7, 0]);
    close(line.dir.map(Math.abs), [0, 1, 0]);
    expect(planeSection([0, 0, 5], [0, 0, 1], s)).toBeUndefined();
  });

  it("frames a plane", () => {
    const n: Vec3 = [0.3, -0.5, 0.8];
    const [a, b] = planeFrame(n);
    const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const nn = Math.hypot(...n);
    expect(dot(a, n) / nn).toBeCloseTo(0);
    expect(dot(b, n) / nn).toBeCloseTo(0);
    expect(dot(a, b)).toBeCloseTo(0);
  });
});

describe("turning", () => {
  it("turns about the line of sight round the rim", () => {
    const t = arcball([50, 0], [0, -50], 40);
    close(t.axis, [0, 0, 1]);
    expect(t.angle).toBeCloseTo(Math.PI / 2);
  });

  it("tilts about a screen axis across the ball", () => {
    const t = arcball([0, 0], [20, 0], 40);
    close(t.axis, [0, 1, 0]);
    expect(t.angle).toBeCloseTo(Math.asin(0.5));
  });

  it("turns a vector (Rodrigues)", () => {
    close(rotate([1, 0, 0], [0, 0, 1], Math.PI / 2), [0, 1, 0]);
    close(rotate([0, 0, 1], [0, 0, 1], 1), [0, 0, 1]);
  });
});

describe("hits", () => {
  it("measures distance to a segment and finds what is inside a polygon", () => {
    expect(segmentDistance([5, 3], [0, 0], [10, 0])).toBeCloseTo(3);
    expect(segmentDistance([-4, 3], [0, 0], [10, 0])).toBeCloseTo(5);
    const square: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(insidePolygon([5, 5], square)).toBe(true);
    expect(insidePolygon([15, 5], square)).toBe(false);
  });
});

describe("frames (a box turned any way: a layer's data as placed)", () => {
  const section = (project: Project3, origin: Vec3) => {
    const j = jacobian(project, origin)!;
    const o = project(origin)!;
    return sectionOf(j, origin, [o.x, o.y]);
  };
  const a: [Vec3, Vec3, Vec3] = [
    [Math.SQRT1_2 * 2, Math.SQRT1_2 * 2, 0],
    [-Math.SQRT1_2 * 3, Math.SQRT1_2 * 3, 0],
    [0, 0, 4],
  ];

  it("has its corners as a box's, and meets a section where its edges cross it", () => {
    const corners = frameCorners([1, 2, 3], [[2, 0, 0], [0, 3, 0], [0, 0, 4]]);
    expect(corners).toHaveLength(8);
    close(corners[0], [-1, -1, -1]);
    close(corners[7], [3, 5, 7]);
    // Turned 45° about z: its cut by z = 0 is the turned rectangle.
    const s = section(axial(0), [0, 0, 0]);
    const cut = cornersSection(frameCorners([0, 0, 0], a), s);
    const screen = convexOrder(cut.map((p) => [100 + 4 * p[0], 50 + 4 * p[1]] as Vec2));
    expect(screen).toHaveLength(4);
    for (const p of screen) expect(Math.hypot(p[0] - 100, p[1] - 50)).toBeCloseTo(4 * Math.hypot(2, 3), 6);
    expect(cornersSection(frameCorners([0, 0, 10], a), s)).toHaveLength(0);
  });

  it("turns clockwise on screen as a positive angle, wrapped to a half turn", () => {
    expect(screenTurn([0, 0], [10, 0], [0, 10])).toBeCloseTo(Math.PI / 2);
    expect(screenTurn([0, 0], [10, 0], [0, -10])).toBeCloseTo(-Math.PI / 2);
    // Across the left: a small turn, not nearly a whole one.
    expect(screenTurn([0, 0], [-10, 1], [-10, -1])).toBeCloseTo(0.2, 1);
  });

  it("scales the axes a dragged corner pulls, and keeps the one along the normal", () => {
    const box: [Vec3, Vec3, Vec3] = [[2, 0, 0], [0, 3, 0], [0, 0, 4]];
    // The corner (+2, +3) on the section z = 1 dragged 2 right and 3 down: both in-plane axes double.
    close(frameScale(box, [2, 3, 1], [2, 3, 0], [0, 0, 1]), [2, 2, 1]);
    // Dragged inwards past the centre: never below 1 %.
    close(frameScale(box, [2, 3, 1], [-5, 0, 0], [0, 0, 1]), [0.01, 1, 1]);
    // Shift: all three alike, by how far the corner moved out from the centre.
    close(frameScale(box, [2, 3, 1], [2, 3, 0], [0, 0, 1], true), [2, 2, 2]);
    // A turned frame: along its own axes (its corner +a0 +a1, pulled out along a0 by |a0|).
    const corner: Vec3 = [a[0][0] + a[1][0], a[0][1] + a[1][1], 0];
    close(frameScale(a, corner, a[0], [0, 0, 1]), [2, 1, 1]);
  });

  it("is moved (its pivot too), turned about a point, or scaled about its centre", () => {
    const g = { c: [1, 0, 0] as Vec3, a: [[1, 0, 0], [0, 2, 0], [0, 0, 3]] as [Vec3, Vec3, Vec3], pivot: [0, 0, 0] as Vec3 };
    const moved = changedFrame(g, { kind: "move", by: [0, 5, 0] });
    close(moved.c, [1, 5, 0]);
    close(moved.pivot, [0, 5, 0]);
    const turned = changedFrame(g, { kind: "turn", axis: [0, 0, 1], angle: Math.PI / 2, about: [0, 0, 0] });
    close(turned.c, [0, 1, 0]);
    close(turned.a[0], [0, 1, 0]);
    close(turned.a[1], [-2, 0, 0]);
    close(turned.pivot, [0, 0, 0]);
    const scaled = changedFrame(g, { kind: "scale", factors: [2, 1, 0.5], uniform: false });
    close(scaled.c, [1, 0, 0]);
    close(scaled.a[0], [2, 0, 0]);
    close(scaled.a[2], [0, 0, 1.5]);
  });
});
