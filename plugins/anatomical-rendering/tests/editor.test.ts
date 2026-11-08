import { describe, expect, it } from "vitest";
import { controlPoints, type DataStop, reshape, shifted, warp } from "../editor.js";

const stops: DataStop[] = Array.from({ length: 40 }, (_, i) => ({
  value: 100 + i * 10,
  color: [i / 40, 0.5, 0.2],
  opacity: i < 5 ? 0 : 0.9,
  tissue: i < 20 ? "grey matter" : "white matter",
}));

describe("the colourmap editor", () => {
  it("gives handles where the tissue and the opacity change, a few in all", () => {
    const p = controlPoints(stops, 10);
    expect(p.length).toBeLessThanOrEqual(10);
    expect(p[0]).toBe(0);
    expect(p[p.length - 1]).toBe(39);
    expect(p.some((k) => k === 19 || k === 20)).toBe(true);
  });
  it("warps the stops between a moved point's neighbours, keeping their order", () => {
    const p = [0, 10, 20, 39];
    const w = warp(stops, p, 10, 150);
    expect(w[10].value).toBe(150);
    expect(w[0].value).toBe(100);
    expect(w[20].value).toBe(300);
    for (let i = 1; i < w.length; ++i) expect(w[i].value).toBeGreaterThan(w[i - 1].value);
    // Past a neighbour it stops at the neighbour.
    expect(warp(stops, p, 10, 1000)[10].value).toBeLessThan(300);
  });
  it("changes opacity and colour most at the point, none past its neighbours", () => {
    const p = [0, 10, 20, 39];
    const r = reshape(stops, p, 10, { opacity: 0.2, color: [1, 0, 0] });
    expect(r[10].opacity).toBeCloseTo(0.2);
    expect(r[10].color).toEqual([1, 0, 0]);
    expect(r[15].opacity).toBeGreaterThan(0.2);
    expect(r[15].opacity).toBeLessThan(0.9);
    expect(r[25]).toEqual(stops[25]);
  });
  it("shifts and compresses the map about its middle", () => {
    const s = shifted(stops, 50, 0.5, 300);
    expect(s[0].value).toBeCloseTo(300 + (100 - 300) * 0.5 + 50);
    expect(shifted(stops, 0, 1, 300)).toBe(stops);
  });
});
