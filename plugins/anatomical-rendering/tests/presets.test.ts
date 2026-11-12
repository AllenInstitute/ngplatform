/**
 * The presets in this browser: every one the host has (the brain set and
 * the HiP-CT organs), and the organs' colours placed as the host places
 * them, through each scan's tissue histogram (presets._to_texture,
 * volumes.tissue_quantiles).
 */
import { describe, expect, it } from "vitest";
import { type LevelPreset, levelQuantiles, levelResolved, PRESETS, windowSide } from "../local/local.js";

/** A scan of tissue (values about 160) in a medium (about 60) filling a round jar: z slices of a disc. */
function scan(n = 48) {
  const data = new Uint8Array(n * n * n);
  for (let z = 0; z < n; ++z)
    for (let y = 0; y < n; ++y)
      for (let x = 0; x < n; ++x) {
        const r = Math.hypot(x - n / 2, y - n / 2) / (n / 2);
        const tissue = r < 0.5;
        data[(z * n + y) * n + x] = tissue ? 140 + ((x * 7 + y * 3 + z * 5) % 41) : 55 + ((x + y + z) % 11);
      }
  return { data, size: [n, n, n] as [number, number, number] };
}

/** numpy's percentile (linear between ranks) of values, at 1..99. */
function npPercentiles(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  return Array.from({ length: 99 }, (_, i) => {
    const pos = ((i + 1) / 100) * (s.length - 1);
    const f = Math.floor(pos);
    return s[f] + (s[Math.min(s.length - 1, f + 1)] - s[f]) * (pos - f);
  });
}

describe("the presets in this browser", () => {
  it("are every preset the host has, the HiP-CT organs among them", () => {
    const names = PRESETS.map((p) => p.name);
    expect(names).toContain("HiP-CT brain");
    for (const organ of ["kidney", "heart", "lung", "liver", "spleen", "brain (fixed)"]) expect(names).toContain(`HiP-CT organ: ${organ}`);
    const kidney = PRESETS.find((p) => p.name === "HiP-CT organ: kidney") as LevelPreset;
    expect(kidney.domain).toBe("window");
    expect(kidney.histogram).toHaveLength(99);
  });
});

describe("a scan's tissue histogram", () => {
  const { data, size } = scan();
  const range: [number, number] = [1000, 3550];
  const value = (b: number) => range[0] + ((range[1] - range[0]) * b) / 255;
  // The window from just past the medium (its values reach 65) to past the tissue.
  const window: [number, number] = [value(70), value(200)];

  it("finds the tissue above the medium", () => {
    expect(windowSide(data, size, range, window)).toBe("above");
    expect(windowSide(data, size, range, [value(0), value(60)])).toBe("below");
  });

  it("is the tissue's values at percentiles 1..99, as numpy's percentile of the voxels kept", () => {
    // The voxels the host keeps: every 2nd, inside the ring, 0.1 to 3 windows past its low end.
    const [n] = size;
    const half = Math.ceil(n / 2);
    const kept: number[] = [];
    for (let z = 0; z < n; z += 2)
      for (let y = 0; y < n; y += 2)
        for (let x = 0; x < n; x += 2) {
          const r = Math.hypot((y / 2 - (half - 1) / 2) / (half / 2), (x / 2 - (half - 1) / 2) / (half / 2));
          const v = value(data[(z * n + y) * n + x]);
          const u = (v - window[0]) / (window[1] - window[0]);
          if (r < 0.9 && u > 0.1 && u < 3) kept.push(v);
        }
    const q = levelQuantiles(data, size, range, window)!;
    const expected = npPercentiles(kept);
    expect(q).toHaveLength(99);
    q.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
  });

  it("places a window preset's stops through it: the preset scan's quantile, this scan's value there", () => {
    const mine = Array.from({ length: 99 }, (_, i) => 2000 + 10 * i);
    const ref = Array.from({ length: 99 }, (_, i) => 0.2 + 0.005 * i);
    const level = { range, pct: new Map<number, number>(), window: [70, 200] as [number, number], quantiles: mine };
    const preset: LevelPreset = { name: "organ", domain: "window", density: 40, histogram: ref, stops: [0.2, 0.3, 0.1, 0.8].map((value) => ({ value, color: [1, 1, 1], opacity: 1 })) };
    const w = (200 - 70) * ((range[1] - range[0]) / 255);
    const placed = levelResolved(preset, level).stops.map((s) => s.value);
    expect(placed[0]).toBeCloseTo(2000, 6);
    expect(placed[1]).toBeCloseTo(2200, 6);
    // Past the ends, the window's scale.
    expect(placed[2]).toBeCloseTo(2000 - 0.1 * w, 6);
    expect(placed[3]).toBeCloseTo(2980 + (0.8 - 0.69) * w, 6);
    // A window set by hand is used as it is.
    const own = levelResolved({ ...preset, window: [1500, 2500] }, level).stops.map((s) => s.value);
    expect(own).toEqual([1700, 1800, 1600, 2300]);
  });
});
