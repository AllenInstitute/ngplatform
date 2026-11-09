import { describe, expect, it } from "vitest";
import { covariance, parseSplat, sortByDepth, worldToCamera } from "../splatview.js";

describe("splat viewer", () => {
  it("makes the covariance of a rotated Gaussian", () => {
    // 90 degrees about z: the x scale goes to y.
    const h = Math.SQRT1_2;
    const c = covariance([2, 1, 1], [h, 0, 0, h]);
    expect(c[0]).toBeCloseTo(1);
    expect(c[3]).toBeCloseTo(4);
    expect(c[5]).toBeCloseTo(1);
    expect(c[1]).toBeCloseTo(0);
  });

  it("reads a .splat file", () => {
    const buf = new ArrayBuffer(64);
    const f = new Float32Array(buf);
    const u = new Uint8Array(buf);
    f.set([1, 2, 3, 0.5, 0.5, 0.5], 0);
    f.set([4, 5, 6, 1, 1, 1], 8);
    u.set([10, 20, 30, 255, 255, 128, 128, 128], 24);
    u.set([1, 2, 3, 4, 255, 128, 128, 128], 56);
    const s = parseSplat(buf);
    expect(s.count).toBe(2);
    expect(Array.from(s.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.covariances[0]).toBeCloseTo(0.25);
    expect(Array.from(s.colors.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it("sorts front to back from the camera", () => {
    // Camera at -10 on y looking along +y, z up.
    const view = worldToCamera([0, -10, 0], [0, 0, 0], [0, 0, 1]);
    const positions = new Float32Array([0, 5, 0, 0, -5, 0, 0, 0, 0]);
    expect(Array.from(sortByDepth(positions, 3, view))).toEqual([1, 2, 0]);
    // OpenCV axes: the point above the target is up the image (negative y).
    const y = view[1] * 0 + view[5] * 0 + view[9] * 1 + view[13];
    expect(y).toBeLessThan(0);
  });
});
