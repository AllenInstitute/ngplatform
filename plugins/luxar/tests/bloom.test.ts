import { describe, expect, it } from "vitest";
import { BLOOM_KNEE, BLOOM_RADIUS, BLOOM_SIGMA, BLOOM_THRESHOLD, brightPass, gaussianKernel } from "../bloom.js";
import { DEFAULT_STYLE, readStyle } from "../style.js";

describe("bloom", () => {
  it("blurs with a Gaussian that keeps the light", () => {
    const w = gaussianKernel(BLOOM_SIGMA, BLOOM_RADIUS);
    expect(w.length).toBe(BLOOM_RADIUS + 1);
    expect(w[0] + 2 * w.slice(1).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    // Falling away from the centre as a Gaussian of that width does.
    for (let i = 1; i < w.length; ++i) expect(w[i]).toBeLessThan(w[i - 1]);
    expect(w[2] / w[0]).toBeCloseTo(Math.exp(-4 / (2 * BLOOM_SIGMA ** 2)), 5);
    // The taps reach three widths out, where what is left is small.
    expect(w[BLOOM_RADIUS] / w[0]).toBeLessThan(0.02);
    expect(Array.from(gaussianKernel(1, 0))).toEqual([1]);
  });

  it("lets through only light brighter than the threshold, fading in over the knee", () => {
    expect(brightPass(0)).toBe(0);
    expect(brightPass(BLOOM_THRESHOLD - BLOOM_KNEE)).toBe(0);
    expect(brightPass(0.2)).toBe(0);
    // Above the knee, all of the light beyond the threshold.
    const x = BLOOM_THRESHOLD + 2 * BLOOM_KNEE;
    expect(brightPass(x) * x).toBeCloseTo(x - BLOOM_THRESHOLD, 6);
    // Smooth and rising through the knee, never more than the light itself.
    let last = 0;
    for (let v = BLOOM_THRESHOLD - BLOOM_KNEE; v <= BLOOM_THRESHOLD + 3; v += 0.05) {
      const kept = brightPass(v) * v;
      expect(kept).toBeGreaterThanOrEqual(last - 1e-9);
      expect(brightPass(v)).toBeLessThanOrEqual(1);
      last = kept;
    }
    // Continuous where the knee meets the line.
    const edge = BLOOM_THRESHOLD + BLOOM_KNEE;
    expect(brightPass(edge - 1e-6) * edge).toBeCloseTo(brightPass(edge + 1e-6) * edge, 4);
  });

  it("is a style setting, off by default and clamped", () => {
    expect(DEFAULT_STYLE.bloom).toBe(0);
    expect(readStyle({ bloom: 0.75 }).bloom).toBe(0.75);
    expect(readStyle({ bloom: 99 }).bloom).toBe(3);
    expect(readStyle({ bloom: "x" }).bloom).toBe(0);
  });
});
