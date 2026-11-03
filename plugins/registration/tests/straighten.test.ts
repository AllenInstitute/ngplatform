import { describe, expect, it } from "vitest";
import { apply4, type Vec3 } from "../fit.js";
import { straighten } from "../straighten.js";

describe("straightening with landmarks", () => {
  it("turns the first line onto its axis and the second into its plane, about the centre", () => {
    // An AC-PC line tilted 20° nose-down and turned 10° about z, and a point above the midline.
    const ac: Vec3 = [2, 5, 1];
    const tilt = (20 * Math.PI) / 180;
    const turn = (10 * Math.PI) / 180;
    const pc: Vec3 = [ac[0] + 25 * Math.sin(turn), ac[1] - 25 * Math.cos(turn) * Math.cos(tilt), ac[2] + 25 * Math.sin(tilt)];
    const above: Vec3 = [ac[0], ac[1] + 3, ac[2] + 30];
    const centre: Vec3 = [0, 0, 0];
    const m = straighten([pc, ac, ac, above], "P→A", "I→S", centre);
    // PC to AC now points along +y.
    const d = apply4(m, ac).map((v, k) => v - apply4(m, pc)[k]);
    const n = Math.hypot(...d);
    expect(d[0] / n).toBeCloseTo(0, 9);
    expect(d[1] / n).toBeCloseTo(1, 9);
    expect(d[2] / n).toBeCloseTo(0, 9);
    // The second line now has no x part: it lies in the midsagittal plane, pointing up.
    const e = apply4(m, above).map((v, k) => v - apply4(m, ac)[k]);
    expect(e[0]).toBeCloseTo(0, 9);
    expect(e[2]).toBeGreaterThan(0);
    // A rotation (det 1) that leaves the centre where it is.
    const r = [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[4 * i + j]));
    const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    expect(det).toBeCloseTo(1, 9);
    apply4(m, centre).forEach((v) => expect(v).toBeCloseTo(0, 9));
  });

  it("refuses two lines on one axis, and points at one place", () => {
    const p: Vec3 = [0, 0, 0];
    expect(() => straighten([p, [0, 1, 0], p, [0, 0, 1]], "P→A", "A→P", p)).toThrow(/different axes/);
    expect(() => straighten([p, p, p, [0, 0, 1]], "P→A", "I→S", p)).toThrow(/same place/);
  });
});
