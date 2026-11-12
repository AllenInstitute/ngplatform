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

import { compressMap, compressWarp, fitView, histogramHandles, type MapPlacement, slideWarp, stretchMap, warpForward, warpInverse } from "../editor.js";
import { readSaved } from "../plugin.js";

describe("the histogram's warp", () => {
  const warp = [{ from: 100, to: 120 }, { from: 200, to: 180 }, { from: 300, to: 330 }];
  it("maps image values through its points (past them at the slope of the whole warp) and back", () => {
    expect(warpForward(100, warp)).toBe(120);
    expect(warpForward(150, warp)).toBe(150);
    // First to last point: 210 over 200.
    expect(warpForward(50, warp)).toBeCloseTo(120 - 50 * 1.05, 9);
    expect(warpForward(400, warp)).toBeCloseTo(330 + 100 * 1.05, 9);
    expect(warpForward(400, [{ from: 100, to: 130 }])).toBe(430);
    for (const v of [40, 100, 133, 250, 500]) expect(warpInverse(warpForward(v, warp), warp)).toBeCloseTo(v, 6);
    expect(warpForward(77, undefined)).toBe(77);
  });
  it("slides, and compresses about a point, the whole histogram alike", () => {
    const slid = slideWarp(warp, 25);
    for (const v of [0, 100, 250, 600]) expect(warpForward(v, slid)).toBeCloseTo(warpForward(v, warp) + 25, 9);
    const squeezed = compressWarp(warp, 200, 0.5);
    for (const v of [0, 100, 250, 600]) expect(warpForward(v, squeezed)).toBeCloseTo(200 + (warpForward(v, warp) - 200) * 0.5, 9);
  });
  it("holds the histogram at its quantiles", () => {
    const counts = new Array(100).fill(0).map((_, i) => (i >= 20 && i < 80 ? 10 : 0));
    const h = histogramHandles({ lo: 0, hi: 100, counts }, 0, 100, [0.25, 0.5, 0.75]);
    expect(h[0]).toBeCloseTo(34.5, 0);
    expect(h[1]).toBeCloseTo(49.5, 0);
    expect(h[2]).toBeCloseTo(64.5, 0);
  });
});

describe("the colourmap moved and compressed in place", () => {
  // Visible from 150 to 490 (opacity 0 below 150), compressed about 300.
  const m: MapPlacement = { base: stops, centre: 300, shift: 20, scale: 0.8 };
  const placed = (p: { shift: number; scale: number }, v: number) => 300 + (v - 300) * p.scale + p.shift;

  it("stretches by an end, the other end staying where it is", () => {
    const right = stretchMap(m, 1, 600);
    expect(placed(right, 150)).toBeCloseTo(placed(m, 150), 9);
    expect(placed(right, 490)).toBeCloseTo(600, 9);
    const left = stretchMap(m, 0, 100);
    expect(placed(left, 490)).toBeCloseTo(placed(m, 490), 9);
    expect(placed(left, 150)).toBeCloseTo(100, 9);
    // An end dragged past the other stops short of it.
    const crossed = stretchMap(m, 1, 0);
    expect(placed(crossed, 490)).toBeGreaterThan(placed(crossed, 150));
  });

  it("compresses about the pointer: the value there stays, the rest draw in", () => {
    const c = compressMap(m, 400, 0.5);
    expect(c.scale).toBeCloseTo(0.4, 9);
    // The stop placed at 400 stays at 400; one 100 past it comes to 50 past it.
    const at400 = 300 + (400 - 20 - 300) / 0.8;
    expect(placed(c, at400)).toBeCloseTo(400, 9);
    expect(placed(c, at400 + 100 / 0.8)).toBeCloseTo(450, 9);
  });

  it("fits the view to the map and the bulk of the histogram, or all of it, leaving out the background's bin", () => {
    // Background (a lone, huge bin) at 0..10; the image's bulk from 200 to 400.
    const counts = new Array(100).fill(0);
    counts[0] = 1e6;
    for (let i = 20; i < 40; ++i) counts[i] = 100;
    const hist = { lo: 0, hi: 1000, counts };
    const [a, b] = fitView(stops, hist, [], false);
    expect(a).toBeLessThan(150);
    expect(a).toBeGreaterThan(100);
    expect(b).toBeGreaterThan(490);
    expect(b).toBeLessThan(560);
    const all = fitView(stops, hist, [], true);
    expect(all[0]).toBeLessThan(0);
    expect(all[1]).toBeGreaterThan(1000);
  });
});

describe("crops", () => {
  it("take an old clip box as the first crop", () => {
    const s = readSaved({ box: { on: true, lo: [0.1, 0, 0], hi: [0.5, 1, 1] } });
    expect(s.boxes).toEqual([{ name: "Crop 1", on: true, keep: true, lo: [0.1, 0, 0], hi: [0.5, 1, 1] }]);
    expect(readSaved({}).boxes).toEqual([]);
  });
});
