import { describe, expect, it } from "vitest";
import { guessWindow, transferTable, type LocalPreset } from "../local/local.js";

/** A HiP-CT-like scan (0..255): a round jar of medium (outside it 0), a ball of tissue, maybe a fleck of calcium. */
function specimen(tissue: number, medium: number, calcium?: number): Uint8Array {
  const n = 64;
  const a = new Uint8Array(n * n * n);
  let seed = 1;
  const uniform = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31 - 0.5;
  };
  // Bell-shaped noise of about this standard deviation (the sum of four uniforms).
  const noise = (s: number) => (uniform() + uniform() + uniform() + uniform()) * Math.sqrt(3) * s;
  for (let z = 0; z < n; ++z)
    for (let y = 0; y < n; ++y)
      for (let x = 0; x < n; ++x) {
        const r = Math.hypot(y - (n - 1) / 2, x - (n - 1) / 2) / (n / 2);
        let v = r < 0.97 ? medium + noise(Math.abs(tissue - medium) * 0.04) : 0;
        if (Math.hypot(z - 32, y - 32, x - 30) < 18) v = tissue + noise(Math.abs(tissue - medium) * 0.1);
        if (calcium !== undefined && z >= 30 && z < 34 && y >= 30 && y < 34 && x >= 28 && x < 32) v = calcium;
        a[(z * n + y) * n + x] = Math.max(0, Math.min(255, Math.round(v)));
      }
  return a;
}

describe("window presets in the browser", () => {
  it("guess a window with the tissue in its middle, whichever side of the medium it is", () => {
    for (const [tissue, medium, calcium] of [[180, 90, 255], [40, 120, undefined]] as const) {
      const w = guessWindow(specimen(tissue, medium, calcium), 64, 64, 64)!;
      expect(medium < w[0] || medium > w[1]).toBe(true);
      expect((w[0] + w[1]) / 2).toBeGreaterThan(tissue * 0.93);
      expect((w[0] + w[1]) / 2).toBeLessThan(tissue * 1.07);
    }
  });
  it("spread a window preset's stops over the window", () => {
    const p: LocalPreset = { name: "w", domain: "window", density: 40, stops: [{ value: 0, color: [0, 0, 0], opacity: 0 }, { value: 1, color: [1, 1, 1], opacity: 1 }] };
    const tab = transferTable(p, new Map(), [51, 102]);
    const n = tab.length / 4;
    expect(tab[4 * Math.floor(0.19 * n) + 3]).toBe(0);
    expect(tab[4 * Math.ceil(0.41 * n) + 3]).toBeCloseTo(1);
  });
});
