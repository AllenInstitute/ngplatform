import { describe, expect, it } from "vitest";
import type { LayerTransform } from "@ngplatform/sdk";
import { checkManifest } from "@ngplatform/sdk";
import { conjugate, damped, fromRotationVector, multiplyQuat, toRotationVector } from "../camera.js";
import { buildChunk, objectKey, TEXTURE_WIDTH } from "../chunk_build.js";
import { keyOf, selectChunks } from "../chunks.js";
import type { StoreInfo } from "../client.js";
import { LUXAR_MANIFEST } from "../manifest.js";
import { DEFAULT_STYLE, readSaved, readStyle, rgbOf, scalarOf } from "../style.js";
import { apply, autoGain, boxInFrustum, chooseLevel, chunkRange, coverage, directionMatrix, invertAffine, measurePanel, modelTo, modelToPanel, multiply, pixelsPerUnit, screenArea } from "../view_math.js";

const identityTransform = (offset = [0, 0, 0], scale = 1): LayerTransform => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = scale;
  m[15] = 1;
  m.set(offset, 12);
  return {
    rank: 3,
    input: { names: ["x", "y", "z"], scales: [0.001, 0.001, 0.001], units: ["m", "m", "m"] },
    output: { names: ["x", "y", "z"], scales: [0.001, 0.001, 0.001], units: ["m", "m", "m"] },
    matrix: m,
    defaultMatrix: m,
  };
};

describe("the manifest", () => {
  it("passes the platform's checks and is off by default", () => {
    expect(checkManifest(LUXAR_MANIFEST)).toEqual([]);
    expect(LUXAR_MANIFEST.enabledByDefault).toBe(false);
    expect(LUXAR_MANIFEST.requires?.plugins).toContain("org.ngplatform.zarr-vectors");
  });
});

describe("styles", () => {
  it("fills in and clamps what is saved", () => {
    const s = readStyle({ blending: "nonsense", width: 1000, exposure: -3, colour: "red", range: [1, "x"] });
    expect(s.blending).toBe(DEFAULT_STYLE.blending);
    expect(s.width).toBe(40);
    expect(s.exposure).toBe(-3);
    expect(s.colour).toBe(DEFAULT_STYLE.colour);
    expect(s.range).toBeUndefined();
    expect(s.on).toBe(true);
  });

  it("reads the plugin's state, layer by layer", () => {
    const saved = readSaved({ layers: { a: { on: false, colourBy: "object" } }, momentum: true });
    expect(saved.layers.a.on).toBe(false);
    expect(saved.layers.a.colourBy).toBe("object");
    expect(saved.momentum).toBe(true);
    expect(readSaved(undefined)).toEqual({ layers: {}, momentum: false });
  });

  it("says what each vertex's value holds", () => {
    expect(scalarOf({ ...DEFAULT_STYLE, colourBy: "direction" })).toBe("none");
    expect(scalarOf({ ...DEFAULT_STYLE, colourBy: "object" })).toBe("object");
    expect(scalarOf({ ...DEFAULT_STYLE, colourBy: "attribute", attribute: "fa" })).toBe("attribute:fa");
    expect(rgbOf("#ff8000")).toEqual([1, 128 / 255, 0]);
  });
});

describe("building a chunk", () => {
  // Two lines: 0-1-2-3 (a bend at 1 and 2), and 4-5 ending at a copy (5) of a neighbour's vertex.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 2, 1, 0, 5, 5, 5, 6, 5, 5]);
  const input = {
    numVertices: 6,
    numOwnVertices: 5,
    positions,
    segmentIds: new Uint32Array([7, 0, 7, 0, 7, 0, 7, 0, 9, 0, 9, 0]),
    edges: new Uint32Array([0, 1, 1, 2, 2, 3, 4, 5]),
    attributes: [new Float32Array([0, 1, 2, 3, 4, 5])],
  };

  it("joins each segment to its neighbours where the line goes on, and nowhere else", () => {
    const c = buildChunk(input, { kind: "none" });
    expect(c.segmentCount).toBe(4);
    expect(Array.from(c.segments)).toEqual([
      0, 0, 1, 2, // a free end at 0; joins 2 at 1
      0, 1, 2, 3,
      1, 2, 3, 3, // a free end at 3
      4, 4, 5, 5, // the copy of a neighbour's vertex joins nothing
    ]);
    expect(c.pointCount).toBe(0);
    expect(c.vertices.length).toBe(TEXTURE_WIDTH * 4);
    expect(Array.from(c.vertices.slice(8, 12))).toEqual([1, 1, 0, 0]);
    expect(c.lower).toEqual([0, 0, 0]);
    expect(c.upper).toEqual([6, 5, 5]);
    expect(c.objects).toBe(2);
  });

  it("puts an attribute's value, or an object's colour key, in each vertex's fourth slot", () => {
    const a = buildChunk(input, { kind: "attribute", index: 0, components: 1 });
    expect(a.vertices[4 * 3 + 3]).toBe(3);
    expect(a.valueRange?.[0]).toBeLessThanOrEqual(a.valueRange![1]);
    const o = buildChunk(input, { kind: "object" });
    expect(o.vertices[3]).toBe(Math.fround(objectKey(7, 0)));
    expect(o.vertices[3]).toBe(o.vertices[7]);
    expect(o.vertices[3]).not.toBe(o.vertices[4 * 4 + 3]);
  });

  it("draws a chunk with no segments as points", () => {
    const c = buildChunk({ ...input, edges: new Uint32Array(0) }, { kind: "none" });
    expect(c.segmentCount).toBe(0);
    expect(c.pointCount).toBe(5);
  });

  it("does not join at a branch", () => {
    // A star: 0 joined to 1, 2 and 3.
    const star = buildChunk(
      { numVertices: 4, numOwnVertices: 4, positions: new Float32Array(12), segmentIds: new Uint32Array(8), edges: new Uint32Array([0, 1, 0, 2, 0, 3]), attributes: [] },
      { kind: "none" },
    );
    for (let s = 0; s < 3; ++s) expect(star.segments[4 * s]).toBe(0);
  });

  it("spreads object keys over [0, 1)", () => {
    const keys = Array.from({ length: 1000 }, (_, i) => objectKey(i, 0));
    expect(Math.min(...keys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...keys)).toBeLessThan(1);
    const low = keys.filter((k) => k < 0.5).length;
    expect(low).toBeGreaterThan(400);
    expect(low).toBeLessThan(600);
  });
});

describe("view geometry", () => {
  it("maps a store through the layer's transform to the displayed dimensions", () => {
    const m = modelTo(identityTransform([10, 20, 30]), ["y", "x", "z"])!;
    expect(apply(m, [1, 2, 3]).slice(0, 3)).toEqual([22, 11, 33]);
    expect(modelTo(identityTransform(), ["x", "y", "t"])).toBeUndefined();
    const inv = invertAffine(m)!;
    expect(apply(inv, [22, 11, 33]).slice(0, 3).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 2, 3]);
  });

  it("colours by direction in physical axes", () => {
    const d = directionMatrix(identityTransform([0, 0, 0], 2));
    expect(d[0]).toBeCloseTo(0.002);
    expect(d[4]).toBeCloseTo(0.002);
    expect(d[1]).toBe(0);
  });

  it("finds the chunks a box touches", () => {
    expect(chunkRange([-78.5, 0, 0], [78.5, 31, 33.9], [31, 32, 34])).toEqual({ from: [-3, 0, 0], to: [2, 0, 0] });
  });

  it("tells chunks in a frustum from chunks outside it", () => {
    // An orthographic view of x, y in [-10, 10], z in [-10, 10].
    const ortho = new Float64Array([0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1]);
    expect(boxInFrustum(ortho, [0, 0, 0], [5, 5, 5])).toBe(true);
    expect(boxInFrustum(ortho, [-20, -20, -20], [20, 20, 20])).toBe(true);
    expect(boxInFrustum(ortho, [11, 0, 0], [12, 1, 1])).toBe(false);
    expect(boxInFrustum(multiply(ortho, new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -20, 0, 0, 1])), [11, 0, 0], [12, 1, 1])).toBe(true);
  });

  it("reads the finest level whose chunks in view fit the budget", () => {
    const levels = [
      { vertexCount: 100e6, visible: 10, total: 100 },
      { vertexCount: 10e6, visible: 10, total: 100 },
      { vertexCount: 1e6, visible: 10, total: 100 },
    ];
    expect(chooseLevel(levels, 2e6)).toBe(1);
    expect(chooseLevel(levels, 20e6)).toBe(0);
    expect(chooseLevel(levels, 10)).toBe(2);
  });

  it("dims lines by how many times over they cover the view", () => {
    // An orthographic view 200 px across 20 units: 10 px a unit.
    const ortho = new Float64Array([0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1]);
    expect(pixelsPerUnit(ortho, [0, 0, 0], [200, 200])).toBeCloseTo((10 + 10 + 0) / 3);
    // 4000 units of 2 px line at 10 px a unit over 200 × 200 px: twice over.
    expect(coverage([{ length: 4000, pointCount: 0 }], 10, 2, 40000)).toBeCloseTo(2);
    expect(coverage([{ length: 4000, pointCount: 0 }], 10, 2, 40000, 0.5)).toBeCloseTo(1);
    // A box a quarter of the view across is a sixteenth of its area; one past its edges, all of it.
    expect(screenArea(ortho, [0, 0, 0], [5, 5, 1], [200, 200])).toBeCloseTo(40000 / 16);
    expect(screenArea(ortho, [-50, -50, 0], [50, 50, 1], [200, 200])).toBeCloseTo(40000);
    expect(autoGain(0.5)).toBe(1);
    expect(autoGain(1)).toBe(1);
    expect(autoGain(4)).toBe(0.25);
    expect(autoGain(40)).toBeLessThan(0.1);
    expect(autoGain(400)).toBeLessThan(autoGain(40));
  });

  it("measures a 2-D view's affine map, and carries a layer through it", () => {
    // A view of x, y at 4 px a unit, centred on (100, 50), depth along z.
    const project = (g: number[]) => ({ x: 4 * (g[0] - 100) + 200, y: -4 * (g[1] - 50) + 150, depth: (g[2] - 7) / 2 });
    const rows = measurePanel(project, [100, 50, 7])!;
    expect(rows[0].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([4, 0, 0, -200]);
    expect(rows[2].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 0.5, -3.5]);
    const m = modelToPanel(identityTransform([100, 0, 0]), ["x", "y", "z"], rows);
    const p = apply(m, [1, 50, 9]);
    expect(p.slice(0, 3).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([204, 150, 1]);
  });
});

describe("choosing chunks", () => {
  const info: StoreInfo = {
    axisNames: ["x", "y", "z"],
    axisUnits: ["m", "m", "m"],
    axisScales: [0.001, 0.001, 0.001],
    bounds: { lower: [0, 0, 0], upper: [39.9, 9.9, 9.9] },
    levels: [
      { index: 0, vertexCount: 4e6, chunkShape: [10, 10, 10], objectShare: 1 },
      { index: 1, vertexCount: 4e5, chunkShape: [10, 10, 10], objectShare: 0.1 },
      { index: 2, vertexCount: 4e4, chunkShape: [20, 10, 10], objectShare: 0.01 },
    ],
    geometry: "streamline",
    primitive: "lines",
    attributes: [],
    warnings: [],
  };
  const everywhere = () => true;

  it("reads the coarsest level first, then the chosen level, nearest the centre first", () => {
    const s = selectChunks(info, everywhere, [35, 5, 5], 1e6, () => false);
    expect(s.level).toBe(1);
    expect(s.want.slice(0, 2)).toEqual([keyOf(2, [1, 0, 0]), keyOf(2, [0, 0, 0])]);
    expect(s.want[2]).toBe(keyOf(1, [3, 0, 0]));
    expect(s.complete).toBe(false);
    expect(s.draw).toEqual([]);
  });

  it("stands in with a coarser level until a chunk arrives", () => {
    const arrived = new Set([keyOf(2, [0, 0, 0]), keyOf(2, [1, 0, 0]), keyOf(1, [0, 0, 0])]);
    const s = selectChunks(info, everywhere, [0, 0, 0], 1e6, (k) => arrived.has(k));
    expect(new Set(s.draw)).toEqual(new Set([keyOf(1, [0, 0, 0]), keyOf(2, [0, 0, 0]), keyOf(2, [1, 0, 0])]));
    const all = selectChunks(info, everywhere, [0, 0, 0], 1e6, () => true);
    expect(all.complete).toBe(true);
    expect(all.draw.every((k) => k.startsWith("1|"))).toBe(true);
  });

  it("reads only what is in view", () => {
    const s = selectChunks(info, (lo) => lo[0] < 10, [0, 0, 0], 0.5e6, () => false);
    expect(s.want.filter((k) => k.startsWith("1|"))).toEqual([keyOf(1, [0, 0, 0])]);
  });
});

describe("momentum", () => {
  it("turns rotations into rotation vectors and back", () => {
    const q = fromRotationVector([0, 0, Math.PI / 4]);
    const v = toRotationVector(q);
    expect(v[2]).toBeCloseTo(Math.PI / 4);
    const back = multiplyQuat(q, conjugate(q));
    expect(back[3]).toBeCloseTo(1);
  });

  it("damps as Luxar's camera does: a quarter a frame", () => {
    expect(damped(1, 1000 / 60)).toBeCloseTo(0.75);
    expect(damped(1, 0)).toBe(1);
  });
});
