import { quat, vec3 } from "neuroglancer/unstable/util/geom.js";
import { describe, expect, it } from "vitest";
import { looksAnatomical, panelRotations, screenQuaternion, standardView } from "../src/engine/anatomical.js";

const screen = (q: number[] | undefined) => {
  const r = q === undefined ? quat.create() : quat.fromValues(q[0], q[1], q[2], q[3]);
  const t = (v: number[]) => Array.from(vec3.transformQuat(vec3.create(), vec3.fromValues(v[0], v[1], v[2]), r)).map((x) => Math.round(x) + 0);
  return { right: t([1, 0, 0]), down: t([0, 1, 0]) };
};

describe("panel conventions", () => {
  it("reproduces Neuroglancer's own panel rotations", () => {
    const own = panelRotations("neuroglancer");
    expect(own.xy).toBeUndefined();
    const xz = quat.rotateX(quat.create(), quat.create(), Math.PI / 2);
    const yz = quat.rotateY(quat.create(), quat.create(), Math.PI / 2);
    own.xz!.forEach((v, i) => expect(v).toBeCloseTo(xz[i], 6));
    own.yz!.forEach((v, i) => expect(v).toBeCloseTo(yz[i], 6));
  });

  it("shows RAS data as Freeview does (radiological): anterior and superior up, patient's right on the left", () => {
    const p = panelRotations("radiological");
    // Axial: screen right is patient left (-x), screen down is posterior (-y).
    expect(screen(p.xy)).toEqual({ right: [-1, 0, 0], down: [0, -1, 0] });
    // Coronal: right is -x, down is inferior (-z).
    expect(screen(p.xz)).toEqual({ right: [-1, 0, 0], down: [0, 0, -1] });
    // Sagittal: right is posterior (-y), so anterior is on the left; down is inferior.
    expect(screen(p.yz)).toEqual({ right: [0, -1, 0], down: [0, 0, -1] });
  });

  it("starts the 3-D view from the front when radiological: superior up, the patient's right on the screen's left", () => {
    const front = screen(standardView("radiological"));
    expect(front).toEqual({ right: [-1, 0, 0], down: [0, 0, -1] });
    // Looking from the front (+y) towards the back: into the screen is -y.
    const into = [front.right[1] * front.down[2] - front.right[2] * front.down[1], front.right[2] * front.down[0] - front.right[0] * front.down[2], front.right[0] * front.down[1] - front.right[1] * front.down[0]];
    expect(into.map((x) => x + 0)).toEqual([0, -1, 0]);
    // Neurological from behind, right on the right; Neuroglancer's own as it starts.
    expect(screen(standardView("neurological"))).toEqual({ right: [1, 0, 0], down: [0, 0, -1] });
    expect(standardView("neuroglancer")).toBeUndefined();
  });

  it("neurological keeps the patient's right on the right", () => {
    const p = panelRotations("neurological");
    expect(screen(p.xy)).toEqual({ right: [1, 0, 0], down: [0, -1, 0] });
    expect(screen(p.xz)).toEqual({ right: [1, 0, 0], down: [0, 0, -1] });
  });

  it("is a proper rotation for any right and down", () => {
    const q = screenQuaternion([0, 0, 1], [1, 0, 0]);
    expect(Math.hypot(...q)).toBeCloseTo(1, 9);
    expect(screen(q)).toEqual({ right: [0, 0, 1], down: [1, 0, 0] });
  });

  it("calls millimetre and micrometre x, y, z anatomy, and nanometre EM not", () => {
    expect(looksAnatomical(["x", "y", "z"], [0.001, 0.001, 0.001], ["m", "m", "m"])).toBe(true);
    expect(looksAnatomical(["x", "y", "z"], [1e-6, 1e-6, 1e-6], ["m", "m", "m"])).toBe(true);
    expect(looksAnatomical(["x", "y", "z"], [4e-9, 4e-9, 4e-8], ["m", "m", "m"])).toBe(false);
    expect(looksAnatomical(["t", "y", "x"], [1, 1, 1], ["s", "m", "m"])).toBe(false);
  });
});
