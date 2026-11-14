/**
 * The live image: the preset's table at the level's values, the shader's
 * values for a view, and when the drawer shows it rather than the picture
 * (any frame but the picture's own camera and look, and the picture coming
 * in over it as the camera rests).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewSpec } from "../client.js";
import { FADE_MS, PictureDrawer } from "../draw.js";
import { LIGHT_SIDE, lightGrid, liveParams, type LivePreset, liveTable, occupancy } from "../live.js";
import { levelHistogram, levelResolved, levelTable, TF_SIZE } from "../local/local.js";
import { frame3d } from "./fake_context.js";

const preset = (over: Partial<LivePreset>): LivePreset => ({ name: "p", domain: "data", density: 40, stops: [], ...over });

describe("the live image's colours", () => {
  it("puts stops at data values through the reader's window", () => {
    // 16-bit values 1000..3000 read as 0..255: a stop at 2000 is half way.
    const p = preset({ stops: [{ value: 1000, color: [0, 0, 0], opacity: 0 }, { value: 2000, color: [1, 1, 1], opacity: 1 }] });
    const t = liveTable(p, { range: [1000, 3000], pct: new Map(), window: undefined });
    const at = (x: number) => t[4 * Math.round(x * (TF_SIZE - 1)) + 3];
    expect(at(0.25)).toBeCloseTo(0.5, 2);
    expect(at(0.5)).toBeCloseTo(1, 2);
    expect(at(0.9)).toBeCloseTo(1, 2);
  });

  it("takes a window preset's window at data values, else the window guessed here", () => {
    const stops = [{ value: 0, color: [1, 1, 1], opacity: 0 }, { value: 1, color: [1, 1, 1], opacity: 1 }];
    const level = { range: [0, 1000] as [number, number], pct: new Map(), window: [0, 255] as [number, number] };
    const own = liveTable(preset({ domain: "window", stops, window: [0, 500] }), level);
    const guessed = liveTable(preset({ domain: "window", stops }), level);
    const mid = 4 * Math.round(0.25 * (TF_SIZE - 1)) + 3;
    expect(own[mid]).toBeCloseTo(0.5, 2);
    expect(guessed[mid]).toBeCloseTo(0.25, 2);
  });
});

describe("the colourmap at this image's values, in this browser", () => {
  // 16-bit values 1000..3000 read as 0..255; the tissue's percentiles at 8-bit values.
  const level = { range: [1000, 3000] as [number, number], pct: new Map([[0, 51], [50, 102], [100, 204]]), window: [51, 153] as [number, number] };
  const stops = [{ value: 0, color: [0, 0, 0], opacity: 0 }, { value: 1, color: [1, 1, 1], opacity: 1 }];

  it("places a preset's stops at data values, as the host does", () => {
    const pct = levelResolved(preset({ domain: "percentile", stops: [{ value: 50, color: [1, 1, 1], opacity: 1 }] }), level);
    expect(pct.domain).toBe("data");
    expect(pct.stops[0].value).toBeCloseTo(1000 + (102 / 255) * 2000, 6);
    // A window preset: through the window guessed here (8-bit), or its own (data values).
    expect(levelResolved(preset({ domain: "window", stops }), level).stops.map((s) => s.value)).toEqual([1400, 2200]);
    expect(levelResolved(preset({ domain: "window", stops, window: [1500, 2500] }), level).stops.map((s) => s.value)).toEqual([1500, 2500]);
  });

  it("draws the same table placed as unplaced", () => {
    const p = preset({ domain: "window", stops });
    const a = levelTable(p, level), b = levelTable(levelResolved(p, level), level);
    for (let i = 0; i < a.length; ++i) expect(b[i]).toBeCloseTo(a[i], 4);
  });

  it("counts the level's values over its data range, every second voxel, each bin centred on its value", () => {
    const data = new Uint8Array(4 * 4 * 4).fill(7);
    data[0] = 200;
    const h = levelHistogram({ data, size: [4, 4, 4], range: [1000, 3000] });
    const step = 2000 / 255;
    expect(h.lo).toBeCloseTo(1000 - step / 2, 9);
    expect(h.hi).toBeCloseTo(3000 + step / 2, 9);
    // The bin of 8-bit value 200 is centred on the data value read as 200.
    const width = (h.hi - h.lo) / 256;
    expect(h.lo + (200 + 0.5) * width).toBeCloseTo(1000 + 200 * step, 6);
    expect(h.counts[200]).toBe(1);
    expect(h.counts[7]).toBe(7);
    expect(h.counts.reduce((x, y) => x + y, 0)).toBe(8);
  });
});

describe("the bricks the live image steps over", () => {
  it("are those whose values the table leaves clear", () => {
    // Opaque from 0.5 up.
    const table = new Float32Array(TF_SIZE * 4);
    for (let i = TF_SIZE / 2; i < TF_SIZE; ++i) table[4 * i + 3] = 1;
    const bounds = Float32Array.from([0, 0.2, 0.1, 0.6, 0.7, 0.9, 0.49, 0.495]);
    // The last brick lies just below the opaque values.
    expect(Array.from(occupancy(bounds, table))).toEqual([0, 255, 255, 0]);
    expect(Array.from(occupancy(Float32Array.from([0, 0.4]), table))).toEqual([0]);
  });
});

describe("the light held in the object", () => {
  it("has a cell a voxel for a small level, and at most LIGHT_SIDE cells a side for a large one", () => {
    expect(lightGrid([64, 40, 20])).toEqual({ cell: 1, grid: [64, 40, 20] });
    const big = lightGrid([320, 300, 100]);
    expect(big.cell).toBe(4);
    expect(big.grid).toEqual([80, 75, 25]);
    expect(Math.max(...big.grid)).toBeLessThanOrEqual(LIGHT_SIDE);
  });
});

describe("the live image's view", () => {
  const view = (over: Partial<ViewSpec> = {}): ViewSpec =>
    ({ inv_view_projection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1], width: 8, height: 8, unit_mm: 1, preset: "p", ...over }) as ViewSpec;
  // Voxels of 2 mm, the level's corner at (10, 0, 0) mm.
  const level = { size: [10, 20, 30] as [number, number, number], voxelToRas: [2, 0, 0, 10, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1] };

  it("maps the world back to voxels", () => {
    const q = liveParams(view(), preset({}), level);
    const m = q.voxFromWorld;
    const at = (w: number[]) => [0, 1, 2].map((r) => m[r] * w[0] + m[4 + r] * w[1] + m[8 + r] * w[2] + m[12 + r]);
    expect(at([16, 8, 4]).map((x) => Math.round(x * 1e6) / 1e6)).toEqual([3, 4, 2]);
  });

  it("turns a light given in the camera's frame into the world's, and keeps one crop and six cuts", () => {
    const q = liveParams(view({ light: { direction: [0, 0, 1], camera_space: true }, boxes: [{ lo: [0.5, 0, 0], hi: [1, 1, 1], keep: true }], clips: [[1, 0, 0, -3]], unit_mm: 0.5 }), preset({ density: 40 }), level);
    // Back, toward the camera: the camera looks along -z here.
    expect(q.lightDir.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 0, 1]);
    expect(q.cropLo[0]).toBe(4.5);
    expect(q.cropHi[2]).toBe(29.5);
    expect(q.clips.slice(0, 4)).toEqual([1, 0, 0, -3]);
    expect(q.clips).toHaveLength(24);
    expect(q.nclip).toBe(1);
    expect(q.density).toBe(20);
  });
});

describe("the drawer with a live image", () => {
  // A context that answers every call: what is drawn is not looked at, only which of the two is.
  const gl = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) =>
      k === "getParameter" ? () => new Int32Array([0, 0, 4, 4])
      : k === "getShaderParameter" || k === "getProgramParameter" ? () => true
      : typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1
      : () => ({}),
  }) as unknown as WebGL2RenderingContext;
  const frame = (turn = 0) => ({ ...frame3d({ turn }), gl });
  const bitmap = () => ({ width: 4, height: 4, close: vi.fn() }) as unknown as ImageBitmap;
  afterEach(() => vi.restoreAllMocks());

  it("draws the live image for any frame but the picture's own camera and look, and brings the picture in over it", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const d = new PictureDrawer();
    const live = { ready: () => true, draw: vi.fn((_frame: unknown, _split: number) => true) };
    d.live = live;
    d.look = "a";
    const here = frame();
    d.set({ bitmap: bitmap(), camera: Array.from(here.invViewProjection), look: "a" });

    // The camera turned: the live image alone.
    d.draw(frame(0.5));
    expect(live.draw).toHaveBeenLastCalledWith(expect.anything(), 1);
    expect(d.stats.live).toBe(1);

    // Back at the picture's camera: the picture comes in, the live image keeping the pixels not taken yet.
    live.draw.mockClear();
    d.draw(here);
    expect(live.draw).toHaveBeenCalledOnce();
    expect(live.draw.mock.calls[0][1]).toBeCloseTo(1, 5);
    now.mockReturnValue(1000 + FADE_MS / 2);
    d.draw(here);
    expect(live.draw.mock.calls[1][1]).toBeCloseTo(0.5, 5);
    now.mockReturnValue(1000 + FADE_MS);
    d.draw(here);
    expect(live.draw).toHaveBeenCalledTimes(2);
    expect(d.stats.live).toBe(1);

    // Another look (a preset changed): the live image again until the picture of it comes.
    d.look = "b";
    d.draw(here);
    expect(d.stats.live).toBe(2);
    vi.unstubAllGlobals();
  });

  it("draws the live image alone, even at the picture's camera, when the picture is not wanted at rest", () => {
    const d = new PictureDrawer();
    const live = { ready: () => true, draw: vi.fn((_frame: unknown, _split: number) => true) };
    d.live = live;
    d.pictureAtRest = false;
    const here = frame();
    d.set({ bitmap: bitmap(), camera: Array.from(here.invViewProjection), look: "" });
    d.draw(here);
    expect(live.draw).toHaveBeenCalledWith(expect.anything(), 1);
    expect(d.stats.live).toBe(1);
  });

  it("draws the picture as before when the live image cannot be drawn", () => {
    const d = new PictureDrawer();
    const live = { ready: () => false, draw: vi.fn(() => true) };
    d.live = live;
    d.set({ bitmap: bitmap() });
    d.draw(frame(0.5));
    expect(live.draw).not.toHaveBeenCalled();
    expect(d.stats.flat).toBe(1);
  });
});
