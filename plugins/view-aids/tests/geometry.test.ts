import { describe, expect, it } from "vitest";
import {
  angleBetween,
  axesOf,
  easeInOut,
  FACES,
  letterBasis,
  lookingFrom,
  nearestStandard,
  pickCube,
  projectCube,
  quarterTurn,
  type Quat,
  shownOrientation,
  slerp,
  standardViews,
  targetLetters,
  targetWords,
  toDisplay,
  toView,
  type Vec3,
  visibleFaces,
  zoneOnFace,
} from "../geometry.js";
import { panelRotations } from "../../../src/engine/anatomical.js";

const RAS = axesOf({ x: [0.001, "m"], y: [0.001, "m"], z: [0.001, "m"] }, undefined);
const EM = axesOf({ x: [4e-9, "m"], y: [4e-9, "m"], z: [40e-9, "m"] }, undefined);
const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const sameRotation = (a: Quat, b: Quat) => expect(angleBetween(a, b)).toBeLessThan(1e-6);
const axisAngle = (axis: Vec3, angle: number): Quat => {
  const l = Math.hypot(...axis);
  const s = Math.sin(angle / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};

describe("axes", () => {
  it("letters anatomy in RAS, and other data by axis", () => {
    expect(RAS.anatomical).toBe(true);
    expect(RAS.ends).toEqual([
      ["R", "L"],
      ["A", "P"],
      ["S", "I"],
    ]);
    expect(RAS.up).toEqual([0, 0, 1]);
    expect(EM.anatomical).toBe(false);
    expect(EM.ends[0]).toEqual(["+x", "−x"]);
    expect(EM.up).toEqual([0, -1, 0]);
  });

  it("follows the displayed order", () => {
    const axes = axesOf({ x: [0.001, "m"], y: [0.001, "m"], z: [0.001, "m"], t: [1, "s"] }, ["z", "x", "y"]);
    expect(axes.ends.map((e) => e[0])).toEqual(["S", "R", "A"]);
    expect(axes.up).toEqual([1, 0, 0]);
    expect(axes.alt).toEqual([0, 0, 1]);
  });

  it("names cube targets", () => {
    expect(targetLetters([1, 0, 0], RAS)).toBe("R");
    expect(targetLetters([1, -1, 1], RAS)).toBe("R P S");
    expect(targetWords([0, 1, -1], RAS)).toBe("anterior inferior");
  });
});

describe("standard views", () => {
  it("looks from the front with superior up, the patient's right on the left (the engine's radiological view)", () => {
    const q = lookingFrom([0, 1, 0], RAS);
    sameRotation(q, panelRotations("radiological").xz!);
    // On screen: anterior faces the viewer, superior is up, right is on the left.
    expect(toView(q, [0, 1, 0])[2]).toBeCloseTo(-1);
    expect(toView(q, [0, 0, 1])[1]).toBeCloseTo(-1);
    expect(toView(q, [1, 0, 0])[0]).toBeCloseTo(-1);
  });

  it("looks from above with anterior up", () => {
    const q = lookingFrom([0, 0, 1], RAS);
    expect(toView(q, [0, 0, 1])[2]).toBeCloseTo(-1);
    expect(toView(q, [0, 1, 0])[1]).toBeCloseTo(-1);
  });

  it("keeps Neuroglancer's own view for other data: from −z, y down", () => {
    sameRotation(lookingFrom([0, 0, -1], EM), [0, 0, 0, 1]);
  });

  it("stands upright from an edge or a corner", () => {
    for (const from of [
      [1, 1, 0],
      [1, -1, 1],
      [-1, 0, -1],
    ] as Vec3[]) {
      const q = lookingFrom(from, RAS);
      const n = Math.hypot(...from);
      // Looking back at the centre: the target faces the viewer.
      expect(toView(q, from)[2]).toBeCloseTo(-n);
      // Superior is up the screen (or at least not down it).
      expect(toView(q, [0, 0, 1])[0]).toBeCloseTo(0);
      expect(toView(q, [0, 0, 1])[1]).toBeLessThan(1e-9);
    }
  });

  it("realigns to the nearest standard view", () => {
    const front = lookingFrom([0, 1, 0], RAS);
    const tilted = slerp(front, lookingFrom([1, 1, 1], RAS), 0.3);
    const near = nearestStandard(tilted, RAS);
    expect(near.from).toEqual([0, 1, 0]);
    sameRotation(near.orientation, front);
    expect(near.angle).toBeGreaterThan(0.05);
    expect(standardViews(RAS)).toHaveLength(6);
    // An exact standard view is its own nearest.
    for (const from of FACES) expect(nearestStandard(lookingFrom(from, RAS), RAS).angle).toBeLessThan(1e-6);
  });
});

describe("slerp and easing", () => {
  it("goes the short way at an even rate", () => {
    const a: Quat = [0, 0, 0, 1];
    const b = axisAngle([0, 0, 1], Math.PI / 2);
    sameRotation(slerp(a, b, 0), a);
    sameRotation(slerp(a, b, 1), b);
    sameRotation(slerp(a, b, 0.5), axisAngle([0, 0, 1], Math.PI / 4));
    // The same rotation with the other sign: no turn the long way round.
    const minus = b.map((v) => -v) as Quat;
    expect(angleBetween(slerp(a, minus, 0.5), a)).toBeCloseTo(Math.PI / 4);
    // Nearly equal: stays a unit quaternion.
    const c = slerp(a, axisAngle([1, 0, 0], 1e-5), 0.5);
    expect(Math.hypot(...c)).toBeCloseTo(1);
  });

  it("eases in and out", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.9)).toBeGreaterThan(0.9);
    expect(easeInOut(2)).toBe(1);
  });

  it("turns view and display coordinates both ways", () => {
    const q = axisAngle([1, 2, 3], 0.7);
    close(toDisplay(q, toView(q, [0.3, -0.2, 0.9])), [0.3, -0.2, 0.9]);
  });
});

describe("the cube", () => {
  const front = lookingFrom([0, 1, 0], RAS);

  it("picks a face's middle, an edge's strip and a corner", () => {
    // Seen from the front: A faces the viewer, S is up, R is on the left.
    expect(pickCube(front, 0, 0)).toEqual([0, 1, 0]);
    expect(pickCube(front, 0, -0.9)).toEqual([0, 1, 1]);
    expect(pickCube(front, -0.9, 0)).toEqual([1, 1, 0]);
    expect(pickCube(front, -0.9, 0.9)).toEqual([1, 1, -1]);
    expect(pickCube(front, 1.4, 0)).toBeUndefined();
  });

  it("picks the face nearer the viewer where faces overlap in depth", () => {
    const corner = lookingFrom([1, 1, 1], RAS);
    // The middle of the picture is the corner nearest the viewer.
    expect(pickCube(corner, 0, 0)).toEqual([1, 1, 1]);
    // Every pick is on a face turned to the viewer.
    for (let x = -1.6; x <= 1.6; x += 0.2) {
      for (let y = -1.6; y <= 1.6; y += 0.2) {
        const t = pickCube(corner, x, y);
        if (t === undefined) continue;
        expect(t.some((v, i) => v !== 0 && toView(corner, [i === 0 ? v : 0, i === 1 ? v : 0, i === 2 ? v : 0])[2] < 0)).toBe(true);
      }
    }
  });

  it("shows one face from a face, three from a corner", () => {
    expect(visibleFaces(front).map((f) => f.normal)).toEqual([[0, 1, 0]]);
    expect(visibleFaces(lookingFrom([1, 1, 1], RAS))).toHaveLength(3);
  });

  it("marks the zone a target names on each face it touches", () => {
    expect(zoneOnFace([0, 1, 0], [0, 1, 0])).toEqual([
      [-0.65, 1, -0.65],
      [0.65, 1, -0.65],
      [0.65, 1, 0.65],
      [-0.65, 1, 0.65],
    ]);
    const edge = zoneOnFace([1, 0, 0], [1, 0, 1])!;
    expect(edge.every((p) => p[0] === 1 && p[2] >= 0.65 - 1e-9)).toBe(true);
    expect(zoneOnFace([0, 0, 1], [1, 0, 0])).toBeUndefined();
  });

  it("writes each face's letter upright as its standard view sees it", () => {
    for (const face of FACES) {
      const { right, down } = letterBasis(face, RAS);
      const q = lookingFrom(face, RAS);
      close(toView(q, right), [1, 0, 0]);
      close(toView(q, down), [0, 1, 0]);
    }
  });
});

describe("the cube as shown", () => {
  it("turns exactly as the view does: no tilt of its own", () => {
    for (const q of [[0, 0, 0, 1], axisAngle([0, 1, 0], Math.PI / 2), axisAngle([0.3, -0.4, 0.8], 1.1)] as Quat[]) {
      expect(angleBetween(q, shownOrientation(q))).toBeLessThan(1e-9);
    }
  });

  it("is seen in perspective, as the view sees the data: its near face larger than its far one", () => {
    const front = lookingFrom([0, 1, 0], RAS);
    const near = projectCube(front, [1, 1, 1]);
    const far = projectCube(front, [1, -1, 1]);
    expect(Math.abs(near[0])).toBeGreaterThan(Math.abs(far[0]));
    // A point through the centre's plane at its own size.
    close(projectCube(front, [0, 0, 1]).slice(0, 2) as number[], toView(front, [0, 0, 1]).slice(0, 2) as number[]);
    // Face-on, only the face looked at shows (the eye is in front of no other face's plane).
    expect(visibleFaces(front).map((f) => f.normal)).toEqual([[0, 1, 0]]);
  });

  it("picks what it draws: a corner's picture names that corner", () => {
    const q = axisAngle([0.3, -0.4, 0.8], 1.1);
    for (const face of visibleFaces(q)) {
      // Just inside each drawn corner of each face seen.
      for (const corner of face.corners) {
        const inside = corner.map((v, i) => (face.normal[i] !== 0 ? v : v * 0.9)) as Vec3;
        const [sx, sy] = projectCube(q, inside);
        const t = pickCube(q, sx, sy);
        if (t === undefined) continue;
        expect(t.every((v, i) => v === 0 || v === Math.sign(inside[i]))).toBe(true);
      }
    }
  });
});

describe("quarter turns", () => {
  const near = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 6));
  const axes = (q: Quat) => ({ r: toDisplay(q, [1, 0, 0]), d: toDisplay(q, [0, 1, 0]), f: toDisplay(q, [0, 0, 1]) });

  it("turns the object a quarter as seen, and back", () => {
    const q: Quat = [0.2, -0.4, 0.1, 0.89];
    const a = axes(q);
    // Left: what was on the right faces the camera.
    near(axes(quarterTurn(q, "left")).f, a.r.map((x) => -x));
    near(axes(quarterTurn(q, "left")).d, a.d);
    // Up: the underside faces the camera.
    near(axes(quarterTurn(q, "up")).f, a.d.map((x) => -x));
    // Clockwise: the screen's right goes down, the view's direction kept.
    near(axes(quarterTurn(q, "cw")).d, a.r);
    near(axes(quarterTurn(q, "cw")).f, a.f);
    for (const [there, back] of [["left", "right"], ["up", "down"], ["cw", "ccw"]] as const) {
      const r = axes(quarterTurn(quarterTurn(q, there), back));
      near(r.r, a.r);
      near(r.d, a.d);
    }
    // Four make a whole turn.
    let p = q;
    for (let i = 0; i < 4; ++i) p = quarterTurn(p, "up");
    near(axes(p).f, a.f);
  });
});
