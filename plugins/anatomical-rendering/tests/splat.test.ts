import { describe, expect, it } from "vitest";
import { covariance, parsePly, parseSplat, sortByDepth, worldToCamera } from "../splatview.js";

/** A binary little-endian 3-D Gaussian splatting .ply of `rows` (each value in the order of `props`). */
function ply(props: string[], rows: number[][], format = "binary_little_endian 1.0", type = "float"): ArrayBuffer {
  const head = `ply\nformat ${format}\nelement vertex ${rows.length}\n${props.map((p) => `property ${type} ${p}\n`).join("")}end_header\n`;
  const h = new TextEncoder().encode(head);
  const out = new Uint8Array(h.length + rows.length * props.length * 4);
  out.set(h);
  const v = new DataView(out.buffer, h.length);
  rows.flat().forEach((x, i) => v.setFloat32(4 * i, x, true));
  return out.buffer;
}

const PROPS = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];

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

  it("reads a 3-D Gaussian splatting .ply: positions, scales (logs), colours (SH degree 0) and opacity (logit)", () => {
    // Header lengths that leave the floats unaligned are fine: the reader copies them out.
    const rows = [
      [1, 2, 3, 0, 0, 1, 0, 0, 0, 0, Math.log(2), 0, 0, 1, 0, 0, 0],
      [4, 5, 6, 0, 0, 1, 1 / 0.28209479177387814 / 2, 0, -10, 10, 0, 0, 0, 0.5, 0, 0, 0.5],
    ];
    const s = parsePly(ply(PROPS, rows));
    expect(s.count).toBe(2);
    expect(Array.from(s.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    // A scale of e^log(2) = 2 along x: variance 4; the rest 1.
    expect(s.covariances[0]).toBeCloseTo(4);
    expect(s.covariances[3]).toBeCloseTo(1);
    // f_dc 0: grey 0.5; opacity logit 0: a half.  The second: red 1, blue clamped to 0, opacity near 1.
    expect(Array.from(s.colors.subarray(0, 4))).toEqual([128, 128, 128, 128]);
    expect(Array.from(s.colors.subarray(4, 8))).toEqual([255, 128, 0, 255]);
  });

  it("refuses a .ply it cannot read, saying why", () => {
    expect(() => parsePly(new TextEncoder().encode("ply\nformat ascii 1.0\n").buffer as ArrayBuffer)).toThrow(/no end_header/);
    expect(() => parsePly(ply(PROPS, [], "ascii 1.0"))).toThrow(/binary little-endian/);
    expect(() => parsePly(ply(PROPS, [], undefined, "double"))).toThrow(/only float properties/);
    expect(() => parsePly(ply(["x", "y", "z"], [[0, 0, 0]]))).toThrow(/no f_dc_0: not a Gaussian splat/);
  });
});
