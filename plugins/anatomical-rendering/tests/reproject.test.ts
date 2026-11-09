import { describe, expect, it } from "vitest";
import { scaledDistance } from "../client.js";
import { invert4, type Picture, sameView } from "../draw.js";
import { columnMajor, viewCutPlane, viewForward } from "../view.js";

// A perspective camera at z = 10 looking down -z (a GL projection, column-major), and its inverse.
function camera(): { vp: number[]; inv: number[] } {
  const f = 1 / Math.tan(Math.PI / 12), n = 1, fa = 100;
  const proj = columnMajor([f, 0, 0, 0, 0, f, 0, 0, 0, 0, (fa + n) / (n - fa), (2 * fa * n) / (n - fa), 0, 0, -1, 0]);
  const view = columnMajor([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -10, 0, 0, 0, 1]);
  const vp = new Array(16).fill(0);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) for (let k = 0; k < 4; ++k) vp[4 * c + r] += proj[4 * k + r] * view[4 * c + k];
  return { vp, inv: Array.from(invert4(vp)) };
}

describe("drawing the frame moving with the view", () => {
  it("inverts a view-projection", () => {
    const { vp, inv } = camera();
    const back = invert4(inv);
    vp.forEach((x, i) => expect(back[i]).toBeCloseTo(x, 4));
  });
  it("finds the camera's forward direction", () => {
    const { inv } = camera();
    const f = viewForward(inv);
    expect(f[0]).toBeCloseTo(0, 5);
    expect(f[1]).toBeCloseTo(0, 5);
    expect(f[2]).toBeCloseTo(-1, 5);
  });
  it("cuts across the view, keeping what lies beyond, offset in mm", () => {
    const { inv } = camera();
    const mm = { names: ["x", "y", "z"], scales: [1e-3, 1e-3, 1e-3], units: ["m", "m", "m"] };
    const [nx, ny, nz, d] = viewCutPlane(inv, [0, 0, 0], 2, mm);
    const keep = (p: number[]) => nx * p[0] + ny * p[1] + nz * p[2] + d >= 0;
    expect(keep([0, 0, -3])).toBe(true); // beyond the plane (2 mm past the position, away from the camera)
    expect(keep([0, 0, -1])).toBe(false);
    expect(keep([0, 0, 5])).toBe(false); // between the camera and the plane
  });
});

describe("frames of one view", () => {
  const pic = (inv: number[] | undefined, w = 64, h = 48): Picture =>
    ({ bitmap: { width: w, height: h } as ImageBitmap, view: inv ? { invViewProjection: inv, distance: { width: 32, height: 24, data: new Float32Array(768) } } : undefined }) as Picture;

  it("fade into each other only when they are of the same camera", () => {
    const { inv } = camera();
    expect(sameView(undefined, pic(inv))).toBe(false);
    expect(sameView(pic(inv), pic(inv.slice()))).toBe(true);
    // The camera stopped: a still frame (full size) of the moving frame's camera.
    expect(sameView(pic(inv, 32, 24), pic(inv))).toBe(true);
    const moved = inv.slice();
    moved[12] += 1e-3;
    expect(sameView(pic(inv), pic(moved))).toBe(false);
    // Frames drawn flat (no camera with them): the same size.
    expect(sameView(pic(undefined), pic(undefined))).toBe(true);
    expect(sameView(pic(undefined), pic(undefined, 32, 24))).toBe(false);
    expect(sameView(pic(undefined), pic(inv))).toBe(false);
  });

  it("read their points as half floats over a scale, keeping 'nothing there'", () => {
    // 0.5, 1.0 and -1 as IEEE half floats.
    const d = scaledDistance(new Uint16Array([0x3800, 0x3c00, 0xbc00]), 250);
    expect(Array.from(d)).toEqual([125, 250, -1]);
  });
});
