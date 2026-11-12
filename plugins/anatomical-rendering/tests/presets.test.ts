/**
 * The presets in this browser: every one the host has (the brain set, the
 * general ones and the HiP-CT organs), and the organs' colours placed as the host places
 * them, through each scan's tissue histogram (presets._to_texture,
 * volumes.tissue_quantiles).
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import vector from "../../../runner/tests/class_matching.json";
import mediumScans from "../../../runner/tests/data/medium_scans.json";
import { classSplits, guessWindow, type LevelPreset, levelQuantiles, levelResolved, mediumSide, PRESETS, tissuePercentiles, windowSide } from "../local/local.js";
import { presetChoices } from "../plugin.js";

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

describe("two classes (grey and white matter)", () => {
  // The vector the host's test checks too (runner/tests/test_render.py): the same inputs, the same values.
  const level = {
    range: vector.range as [number, number],
    pct: new Map(Object.entries(vector.pct).map(([k, v]) => [Number(k), v])),
    window: vector.window as [number, number],
    quantiles: vector.quantiles,
  };
  const resolved = (extra: Partial<LevelPreset>, stops: number[]) =>
    levelResolved({ name: "t", domain: "window", density: 1, classes: 2, stops: stops.map((value) => ({ value, color: [1, 1, 1], opacity: 1 })), ...extra } as LevelPreset, level).stops.map((s) => s.value);

  it("split where the host splits them", () => {
    expect(classSplits(vector.window_preset.histogram)).toEqual([vector.design_split]);
    expect(classSplits(vector.quantiles)).toEqual([vector.scan_split]);
    // The tissue's values at percentiles 1..99, between its percentiles as stored.
    const keys = [...level.pct.keys()].sort((a, b) => a - b);
    const at = (r: number) => {
      const i = keys.findIndex((k) => k >= r);
      const [k0, k1] = [keys[i - 1], keys[i]];
      return level.pct.get(k0)! + ((level.pct.get(k1)! - level.pct.get(k0)!) * (r - k0)) / (k1 - k0);
    };
    expect(classSplits(Array.from({ length: 99 }, (_, i) => at(i + 1)), 3)).toEqual(vector.three_classes.scan_splits);
  });

  it("are each matched to their own, as the host matches them", () => {
    const w = vector.window_preset, p = vector.percentile_preset, p3 = vector.three_classes;
    resolved({ histogram: w.histogram }, w.stops).forEach((v, i) => expect(v).toBeCloseTo(w.expected[i], 9));
    resolved({ domain: "percentile", split: p.split }, p.stops).forEach((v, i) => expect(v).toBeCloseTo(p.expected[i], 9));
    resolved({ domain: "percentile", classes: 3, split: p3.split }, p3.stops).forEach((v, i) => expect(v).toBeCloseTo(p3.expected[i], 9));
  });

  it("of a specimen in a mounting medium are of its tissue alone, as the host takes them", () => {
    // presets._tissue_percentile and _placed: the tissue's quantiles, a three-class preset's lowest two classes
    // as one, and clear from the medium's edge to 2.5 windows on.
    const m = vector.medium;
    const inMedium = { ...level, medium: m.medium as "above" };
    for (const [classes, split, expected] of [[3, m.three_classes.split, m.three_classes.expected], [1, undefined, m.one_class.expected]] as const) {
      const got = levelResolved({ name: "t", domain: "percentile", density: 1, classes, split, stops: m.stops } as LevelPreset, inMedium).stops;
      expect(got.length).toBe(expected.length);
      got.forEach((s, i) => {
        expect(s.value).toBeCloseTo(expected[i].value, 9);
        expect(s.opacity).toBeCloseTo(expected[i].opacity, 9);
        s.color.forEach((c, k) => expect(c).toBeCloseTo(expected[i].color[k], 9));
      });
    }
  });

  it("are matched whole without classes", () => {
    const w = vector.window_preset;
    const whole = resolved({ histogram: w.histogram, classes: 1 }, [0.75])[0];
    expect(whole).not.toBeCloseTo(resolved({ histogram: w.histogram }, [0.75])[0], 3);
  });
});

describe("a mounting medium", () => {
  /** The host's _medium_phantom (test_render.py): a ball of tissue in a jar of medium, in 0, or in air; x fastest. */
  const phantom = (kind: "jar" | "masked" | "air") => {
    const n = 40;
    const data = new Uint8Array(n * n * n);
    for (let z = 0; z < n; ++z)
      for (let y = 0; y < n; ++y)
        for (let x = 0; x < n; ++x) {
          const r = Math.hypot(x - n / 2, y - n / 2) / (n / 2);
          const ball = Math.hypot(r * (n / 2), z - n / 2) < 12;
          const around = kind === "jar" ? (r < 0.95 ? 58 + ((x + 2 * y + 3 * z) % 5) : 0) : kind === "air" ? (x * 3 + y * 5 + z * 7) % 10 : 0;
          data[(z * n + y) * n + x] = ball ? 140 + ((x * 7 + y * 3 + z * 5) % 21) : around;
        }
    return { data, size: [n, n, n] as [number, number, number] };
  };
  const side = (data: Uint8Array, size: [number, number, number]) => {
    const w = guessWindow(data, ...size);
    return mediumSide(data, size, [0, 255], w);
  };

  it("is told from a background of 0 or of air, as the host tells them", () => {
    for (const [kind, want] of [["jar", "above"], ["masked", undefined], ["air", undefined]] as const) {
      const { data, size } = phantom(kind);
      expect(side(data, size)).toBe(want);
    }
  });

  it("is found in LADAF-2021-64's jar and in none of MNI, S-21-46 masked and BigBrain, whose percentile presets stay as they were", () => {
    const presets = PRESETS.filter((p) => p.domain === "percentile" && p.modality !== "labels") as LevelPreset[];
    for (const [name, info] of Object.entries(mediumScans.scans)) {
      const data = new Uint8Array(gunzipSync(readFileSync(new URL(`../../../runner/tests/data/${name}.u8.gz`, import.meta.url))));
      const size = info.size as [number, number, number];
      const found = side(data, size);
      expect(found ?? "").toBe(info.medium);
      const window = guessWindow(data, ...size);
      const level = { range: [0, 255] as [number, number], pct: tissuePercentiles(data), window, quantiles: window && levelQuantiles(data, size, [0, 255], window), medium: found };
      for (const p of presets) {
        const placed = levelResolved(p, level).stops.map((s) => s.value);
        if (found) {
          expect(Math.min(...placed)).toBeGreaterThanOrEqual(window![0] - 1e-9);
          expect(Math.max(...placed)).toBeLessThanOrEqual(window![0] + 2.5 * (window![1] - window![0]) + 1e-9);
        } else expect(placed).toEqual(levelResolved(p, { ...level, medium: undefined }).stops.map((s) => s.value));
      }
    }
  });
});

describe("the general presets", () => {
  const lightness = (c: number[]) => {
    const lin = c.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
  };

  it("are offered for any scan: through the window guessed from it, with no histogram to match", () => {
    const general = PRESETS.filter((p) => p.name.startsWith("General: ")) as LevelPreset[];
    expect(general.map((p) => p.name)).toEqual(expect.arrayContaining(["General: greyscale", "General: greyscale, inverted", "General: glass"]));
    for (const p of general) {
      expect(p.domain).toBe("window");
      expect(p.histogram ?? undefined).toBeUndefined();
    }
    // Black to white as the values rise; inverted, white to black.
    const grey = (name: string) => (PRESETS.find((p) => p.name === name) as LevelPreset).stops.filter((s) => s.opacity > 0).map((s) => lightness(s.color));
    const up = grey("General: greyscale"), down = grey("General: greyscale, inverted");
    expect(up[up.length - 1] - up[0]).toBeGreaterThan(60);
    expect(down[0] - down[down.length - 1]).toBeGreaterThan(60);
  });

  it("are grouped in the Preset box: General, the organs, the rest by modality, then those from a file", () => {
    const list = [
      { name: "HiP-CT brain", modality: "HiP-CT" },
      { name: "HiP-CT organ: kidney", modality: "HiP-CT" },
      { name: "General: greyscale", modality: "" },
      { name: "mine", modality: "from a file" },
    ];
    expect(presetChoices(list)).toEqual([
      ["General: greyscale", "Greyscale", "General"],
      ["HiP-CT organ: kidney", "Kidney", "HiP-CT organs"],
      ["HiP-CT brain", "HiP-CT brain (HiP-CT)", "By modality"],
      ["mine", "mine", "From a file"],
    ]);
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
