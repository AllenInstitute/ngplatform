/**
 * Moving by hand as Freeview does: the composition checked against
 * Freeview's own steps (LayerMRI::DoTransform, as VTK pre-multiplies them
 * into the reslice transform, then inverted), the pivot and centre held
 * still, and Freeview's slider scales.
 */
import { describe, expect, it } from "vitest";
import { apply4, identity4, invert4, type Mat4, multiply4, type Vec3 } from "../fit.js";
import {
  axisAngleRotation,
  axisOrder,
  axisRotation,
  eulerOf,
  identityManual,
  type Manual,
  manualMatrix,
  moveManual,
  permute,
  readManual,
  rotationOf,
  scaleFromSlider,
  scaleManual,
  shownPivot,
  sliderFromScale,
  translationStep,
  turned,
  turnManual,
  unpermute,
} from "../manual.js";

const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 9) => Array.from(a).forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

/** A vtkTransform in its default PreMultiply mode: each call's matrix goes on the right. */
class VtkTransform {
  m = identity4();
  private post(n: Mat4) {
    this.m = multiply4(this.m, n);
  }
  translate(x: number, y: number, z: number) {
    const t = identity4();
    t[3] = x;
    t[7] = y;
    t[11] = z;
    this.post(t);
  }
  concatenate(n: Mat4) {
    this.post(n);
  }
  scale(x: number, y: number, z: number) {
    this.post(Float64Array.from([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]));
  }
  rotateWXYZ(degrees: number, axis: number) {
    const r = axisRotation(axis, degrees);
    this.post(Float64Array.from([r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1]));
  }
}

/** Freeview's reslice transform for these settings (target space = RAS), inverted: the volume's motion. */
function freeview(m: Manual, centre: Vec3, pivot: Vec3): Mat4 {
  const slice = new VtkTransform();
  for (let i = 0; i < 3; ++i) {
    if (!m.flip[i]) continue;
    const f = identity4();
    f[5 * i] = -1;
    slice.translate(...pivot);
    slice.concatenate(f);
    slice.translate(-pivot[0], -pivot[1], -pivot[2]);
  }
  slice.translate(...centre);
  slice.scale(1 / m.scale[0], 1 / m.scale[1], 1 / m.scale[2]);
  slice.translate(-centre[0], -centre[1], -centre[2]);
  for (let i = 0; i < 3; ++i) {
    slice.translate(...pivot);
    slice.rotateWXYZ(-m.rotate[i], i);
    slice.translate(-pivot[0], -pivot[1], -pivot[2]);
  }
  slice.translate(-m.translate[0], -m.translate[1], -m.translate[2]);
  return invert4(slice.m);
}

describe("moving by hand, as Freeview", () => {
  const centre: Vec3 = [3, -18, 12];

  it("composes flip, scale, rotations x then y then z, and translation as Freeview's reslice transform does", () => {
    const pivot: Vec3 = [-10, 4, 30];
    const m: Manual = { translate: [5, -2.5, 7], rotate: [12, -30, 47.5], scale: [1.2, 0.8, 1.5], flip: [true, false, true], around: "cursor", pivot };
    close(manualMatrix(m, centre), freeview(m, centre, pivot));
    // Each part alone too, about the centre.
    for (const part of [
      { rotate: [30, 0, 0] as Vec3 },
      { rotate: [0, 0, -90] as Vec3 },
      { scale: [2, 1, 0.5] as Vec3 },
      { flip: [false, true, false] as Manual["flip"] },
      { translate: [1, 2, 3] as Vec3 },
    ]) {
      const one = { ...identityManual(), ...part };
      close(manualMatrix(one, centre), freeview(one, centre, centre));
    }
  });

  it("keeps the pivot still under rotations and flips, and the centre under scaling", () => {
    const pivot: Vec3 = [20, 0, -5];
    const turn: Manual = { ...identityManual("cursor"), rotate: [10, 20, 30], flip: [true, true, false], pivot };
    close(apply4(manualMatrix(turn, centre), pivot), pivot);
    const grow: Manual = { ...identityManual(), scale: [3, 0.5, 2] };
    close(apply4(manualMatrix(grow, centre), centre), centre);
    // A positive angle turns anticlockwise looking down the axis: y to z about x.
    const quarter = manualMatrix({ ...identityManual(), rotate: [90, 0, 0] }, [0, 0, 0]);
    close(apply4(quarter, [0, 1, 0]), [0, 0, 1]);
  });

  it("is the identity untouched, and turned only with a rotation or flip", () => {
    close(manualMatrix(identityManual(), centre), identity4());
    expect(turned(identityManual())).toBe(false);
    expect(turned({ ...identityManual(), translate: [1, 0, 0], scale: [2, 2, 2] })).toBe(false);
    expect(turned({ ...identityManual(), flip: [false, false, true] })).toBe(true);
  });

  it("reads saved state defensively", () => {
    const m = readManual({ translate: [1, 2], rotate: [1, 2, 3], scale: [0, 2, 3], flip: [1, 0, 0], around: "cursor" });
    expect(m.translate).toEqual([0, 0, 0]);
    expect(m.rotate).toEqual([1, 2, 3]);
    expect(m.scale).toEqual([1, 2, 3]);
    expect(m.flip).toEqual([true, false, false]);
    expect(m.around).toBe("cursor");
    expect(readManual(undefined)).toEqual(identityManual());
  });

  it("maps x, y, z to a layer's own axis order and back", () => {
    expect(axisOrder(["x", "y", "z"])).toEqual([0, 1, 2]);
    expect(axisOrder(["z", "y", "x"])).toEqual([2, 1, 0]);
    expect(axisOrder(["a", "b", "c"])).toEqual([0, 1, 2]);
    const m = manualMatrix({ ...identityManual(), rotate: [10, 0, 0], translate: [1, 2, 3] }, centre);
    const order = axisOrder(["z", "y", "x"]);
    const p = permute(m, order);
    close(unpermute(p, order), m);
    // The same point, written in z, y, x order, moves the same way.
    const xyz: Vec3 = [4, 5, 6];
    const moved = apply4(m, xyz);
    const zyx = apply4(p, [6, 5, 4]);
    close(zyx, [moved[2], moved[1], moved[0]]);
  });

  it("uses Freeview's slider scales", () => {
    expect(scaleFromSlider(200)).toBe(1);
    expect(scaleFromSlider(400)).toBe(2);
    expect(scaleFromSlider(0)).toBe(0.5);
    expect(scaleFromSlider(300)).toBe(1.5);
    expect(scaleFromSlider(100)).toBe(0.75);
    for (const s of [0.5, 0.75, 1, 1.25, 2]) expect(scaleFromSlider(sliderFromScale(s))).toBeCloseTo(s, 9);
    expect(sliderFromScale(5)).toBe(400);
    expect(translationStep(256)).toBe(0.5);
    expect(translationStep(189)).toBe(0.2);
    expect(translationStep(1)).toBe(0.001);
  });
});

describe("moving the layer by its box in the views", () => {
  const centre: Vec3 = [10, -5, 3];
  const cursor: Vec3 = [0, 0, 0];

  it("reads the angles back from the rotation they make", () => {
    for (const r of [[10, 20, 30], [-170, 45, 90.5], [0, -89, 12], [179.5, 0, -179.5]] as Vec3[]) close(eulerOf(rotationOf(r)), r, 5);
    // Gimbal lock: the same rotation, its turn all about z.
    const locked = eulerOf(rotationOf([30, 90, 10]));
    close(rotationOf(locked), rotationOf([30, 90, 10]), 9);
    close(axisAngleRotation([0, 0, 1], 90), axisRotation(2, 90), 12);
  });

  it("turns about the shown pivot: the angles change, the translation stays", () => {
    for (const around of ["centre", "cursor"] as const) {
      const m: Manual = { ...identityManual(around), translate: [4, -2, 7], rotate: [10, -20, 35], scale: [1.2, 0.9, 1], flip: [true, false, false] };
      const p0: Vec3 = around === "centre" ? centre : cursor;
      const fixed = { ...m, pivot: p0 };
      const axis: Vec3 = [0.2, -0.5, 0.84];
      const n = Math.hypot(...axis);
      const unitAxis = axis.map((v) => v / n) as Vec3;
      const turned = turnManual(m, unitAxis, 25, p0);
      expect(turned.translate).toEqual(m.translate);
      expect(turned.pivot).toEqual(p0);
      // The whole transform is the old one turned about the shown pivot.
      const v = shownPivot(m, centre, cursor);
      const q = axisAngleRotation(unitAxis, 25);
      const about = identity4();
      for (let r = 0; r < 3; ++r) {
        for (let c = 0; c < 3; ++c) about[4 * r + c] = q[3 * r + c];
        about[4 * r + 3] = v[r] - (q[3 * r] * v[0] + q[3 * r + 1] * v[1] + q[3 * r + 2] * v[2]);
      }
      close(manualMatrix(turned, centre), multiply4(about, manualMatrix(fixed, centre)), 6);
      // The shown pivot stays put.
      close(apply4(manualMatrix(turned, centre), apply4(invert4(manualMatrix(fixed, centre)), v)), v, 6);
    }
  });

  it("moves and scales", () => {
    const m = { ...identityManual(), translate: [1, 2, 3] as Vec3, scale: [1, 2, 0.5] as Vec3 };
    expect(moveManual(m, [0.5, -2, 0]).translate).toEqual([1.5, 0, 3]);
    expect(scaleManual(m, [2, 0.5, 1]).scale).toEqual([2, 1, 0.5]);
    expect(scaleManual(m, [0, 1, 1]).scale).toEqual([1, 2, 0.5]);
    expect(shownPivot({ ...m, pivot: [5, 5, 5] }, centre, cursor)).toEqual([6, 7, 8]);
    expect(shownPivot(m, centre, cursor)).toEqual([11, -3, 6]);
  });
});
