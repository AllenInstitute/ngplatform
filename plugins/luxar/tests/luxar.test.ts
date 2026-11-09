import { describe, expect, it } from "vitest";
import type { LayerTransform } from "@ngplatform/sdk";
import { checkManifest } from "@ngplatform/sdk";
import { conjugate, damped, fromRotationVector, multiplyQuat, toRotationVector } from "../camera.js";
import { buildChunk, curvesInput, objectKey, PIECE_STRIDE, SAMPLES, skeletonsInput, sortIntoPieces, TEXTURE_WIDTH } from "../chunk_build.js";
import { keyOf, selectChunks } from "../chunks.js";
import type { StoreInfo } from "../client.js";
import { LUXAR_MANIFEST } from "../manifest.js";
import { BATCH, FIRST_BATCH, MAX_CURVES, MAX_SKELETONS, ObjectSets, objectPlan, planBatches, samplesFor } from "../objects.js";
import { alphaByte, alphaOf, idOf, needsTable, objectTable } from "../segments.js";
import { drawnSources } from "../sources.js";
import { autoSlab, DEFAULT_STYLE, extentMm, readSaved, readStyle, rgbOf, scalarOf, slabOf, slabScale } from "../style.js";
import { MAX_SEGMENTS, segmentCapNote } from "../mesh_layers.js";
import { apply, autoGain, boxInFrustum, chooseLevel, chunkRange, coverage, directionMatrix, invertAffine, MAX_SELECTION_BOOST, measurePanel, modelTo, modelToPanel, multiply, pixelsPerUnit, screenArea, shownShare, storeToGlobal, vertexBudget } from "../view_math.js";

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
    expect(readSaved(undefined)).toEqual({ version: 2, layers: {}, momentum: false });
  });

  it("says what each vertex's value holds", () => {
    expect(scalarOf({ ...DEFAULT_STYLE, colourBy: "direction" })).toBe("object");
    expect(scalarOf({ ...DEFAULT_STYLE, colourBy: "object" })).toBe("object");
    expect(scalarOf({ ...DEFAULT_STYLE, colourBy: "attribute", attribute: "fa" })).toBe("attribute:fa");
    expect(rgbOf("#ff8000")).toEqual([1, 128 / 255, 0]);
  });
});

describe("the 2-D slab", () => {
  const nm = { axisUnits: ["m", "m", "m"], axisScales: [4e-9, 4e-9, 4e-8], bounds: { lower: [0, 0, 0], upper: [200_000, 200_000, 20_000] } };
  const mm = { axisUnits: ["m", "m", "m"], axisScales: [0.001, 0.001, 0.001], bounds: { lower: [-70, -100, -60], upper: [80, 80, 80] } };

  it("measures a store in millimetres, whatever its unit (none read as mm)", () => {
    expect(extentMm(nm).map((v) => +v.toPrecision(6))).toEqual([0.8, 0.8, 0.8]);
    expect(extentMm(mm).map((v) => +v.toPrecision(6))).toEqual([150, 180, 140]);
    expect(extentMm({ axisUnits: ["", "", ""], axisScales: [1, 1, 1], bounds: { lower: [0, 0, 0], upper: [10, 20, 30] } })).toEqual([10, 20, 30]);
  });

  it("follows the data: 4 mm for a brain in mm, 20 µm for EM in nm, unless set", () => {
    expect(autoSlab(extentMm(mm))).toBe(4);
    expect(autoSlab(extentMm(nm))).toBeCloseTo(0.02);
    expect(autoSlab([])).toBe(4);
    expect(slabOf(readStyle({}), extentMm(nm))).toBeCloseTo(0.02);
    expect(slabOf(readStyle({ slab: 0.005 }), extentMm(nm))).toBe(0.005);
  });

  it("reads its slider in the unit that suits the data, 0.5 to 40 mm for a brain as before", () => {
    expect(slabScale(4)).toEqual({ unit: "mm", perUnit: 1, min: 0.5, max: 40, step: 0.5 });
    expect(slabScale(0.02)).toMatchObject({ unit: "µm", min: 2, max: 200, step: 2 });
    expect(slabScale(5e-5)).toMatchObject({ unit: "nm", min: 5, max: 500, step: 5 });
  });

  it("reads the 4 mm every style saved before as following the data, and any other slab as set", () => {
    expect(readSaved({ layers: { a: { slab: 4 }, b: { slab: 10 } } }).layers.a.slab).toBeUndefined();
    expect(readSaved({ layers: { a: { slab: 4 }, b: { slab: 10 } } }).layers.b.slab).toBe(10);
    // Saved since: 4 mm is a slab set.
    expect(readSaved({ version: 2, layers: { a: { slab: 4 } } }).layers.a.slab).toBe(4);
    expect(readStyle({ slab: -1 }).slab).toBeGreaterThan(0);
  });
});

describe("a segmentation's meshes", () => {
  it("says when more segments are shown than one store holds", () => {
    expect(segmentCapNote(MAX_SEGMENTS)).toBeUndefined();
    expect(segmentCapNote(14_203)).toBe("Showing 2,000 of 14,203 segments");
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

describe("a layer's chosen segments", () => {
  // Line 0-1-2 of object 7, line 3-4 of object 9, and a point of a 64-bit id.
  const input = {
    numVertices: 6,
    numOwnVertices: 6,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 3, 0, 0, 5, 5, 5, 5, 6, 5, 9, 9, 9]),
    segmentIds: new Uint32Array([7, 0, 7, 0, 7, 0, 9, 0, 9, 0, 1, 2]),
    edges: new Uint32Array([0, 1, 1, 2, 3, 4]),
    attributes: [],
  };

  it("names each vertex's object by a slot in the chunk's list, weighted by its lines' length", () => {
    const c = buildChunk(input, { kind: "none" });
    expect(Array.from(c.slots.slice(0, 6))).toEqual([0, 0, 0, 1, 1, 2]);
    expect(c.slots.length).toBe(TEXTURE_WIDTH);
    expect(Array.from(c.objectIds)).toEqual([7, 0, 9, 0, 1, 2]);
    expect(Array.from(c.objectWeight)).toEqual([3, 1, 0]);
    // A point cloud weighs its objects by their points.
    const p = buildChunk({ ...input, edges: new Uint32Array(0) }, { kind: "none" });
    expect(Array.from(p.objectWeight)).toEqual([3, 2, 1]);
  });

  it("reads 64-bit ids from their two words", () => {
    expect(idOf(7, 0)).toBe(7n);
    expect(idOf(1, 2)).toBe((2n << 32n) | 1n);
    expect(idOf(0xffffffff, 0xffffffff)).toBe(0xffffffffffffffffn);
  });

  it("shows only the chosen objects, and says how much of the chunk that is", () => {
    const c = buildChunk(input, { kind: "none" });
    const chosen = new Set([9n]);
    const t = objectTable(c.objectIds, c.objectWeight, { version: 1, all: false, has: (id) => chosen.has(id) });
    expect(t.rows).toBe(1);
    expect(t.table.length).toBe(TEXTURE_WIDTH * 4);
    expect([t.table[3], t.table[7], t.table[11]]).toEqual([0, 255, 0]);
    expect(t.shown).toBeCloseTo(1 / 4);
    const none = objectTable(c.objectIds, c.objectWeight, { version: 2, all: false, has: () => false });
    expect(none.shown).toBe(0);
    const all = objectTable(c.objectIds, c.objectWeight, { version: 3, all: true, has: () => false });
    expect(all.shown).toBe(1);
    expect([all.table[3], all.table[7], all.table[11]]).toEqual([255, 255, 255]);
  });

  it("colours each object as the layer does, when asked", () => {
    const c = buildChunk(input, { kind: "none" });
    const shading = { version: 1, all: true, has: () => true, colour: (id: bigint): [number, number, number] => (id === 7n ? [1, 0, 0.5] : [0, 1, 0]) };
    expect(needsTable(shading)).toBe(true);
    expect(needsTable({ ...shading, colour: undefined })).toBe(false);
    const t = objectTable(c.objectIds, c.objectWeight, shading);
    expect(Array.from(t.table.slice(0, 8))).toEqual([255, 0, 128, 255, 0, 255, 0, 255]);
  });

  it("reads more for a view that shows a few objects, within a limit", () => {
    expect(shownShare([])).toBe(1);
    expect(shownShare([{ length: 3, pointCount: 0, shown: 0.5 }, { length: 1, pointCount: 0, shown: 1 }])).toBeCloseTo(5 / 8);
    expect(vertexBudget(2, 1)).toBe(2e6);
    expect(vertexBudget(2, 0.5)).toBe(4e6);
    expect(vertexBudget(2, 0)).toBe(2e6 * MAX_SELECTION_BOOST);
    // Only the share of a chunk's lines shown counts toward how much of the view they cover.
    expect(coverage([{ length: 10, pointCount: 0, shown: 0.1 }], 1, 1, 10)).toBeCloseTo(0.1);
  });
});

describe("which sources a layer draws", () => {
  it("leaves out a source with its parts off, as a track-filtering group keeps its dataset beside its own store", () => {
    const base = "https://host/a.zarrvectors/|zarr-vectors:";
    const own = "http://localhost/local/derived-1/g.trk/|zarr-vectors:";
    const spec = { source: [{ url: base, enableDefaultSubsources: false }, { url: own, subsources: { objects: false, meshes: false } }] };
    expect(drawnSources([base, own], spec)).toEqual([own]);
    // Without its own store the group draws the dataset (its parts other than objects on).
    expect(drawnSources([base], { source: { url: base, subsources: { objects: false, meshes: false } } })).toEqual([base]);
    expect(drawnSources([base], { source: base })).toEqual([base]);
    expect(drawnSources([base], undefined)).toEqual([base]);
    // A part switched on draws.
    expect(drawnSources([base], { source: { url: base, enableDefaultSubsources: false, subsources: { default: true } } })).toEqual([base]);
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

  it("counts a store's units in the global dimensions' scales, as Neuroglancer does", () => {
    // A 1 mm tractogram in a scene whose global x, y, z are 0.5 mm (another layer set them): Neuroglancer
    // keeps the identity matrix (physical terms) and the translation in global units.
    const t = identityTransform([4, 0, -2]);
    t.output = { ...t.output, scales: [0.0005, 0.0005, 0.0005] };
    expect(Array.from(storeToGlobal(t))).toEqual([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 4, 0, -2, 1]);
    // (60, -40, 30) mm is (120, -80, 60) global units, plus the translation.
    const m = modelTo(t, ["x", "y", "z"])!;
    expect(apply(m, [60, -40, 30]).slice(0, 3)).toEqual([124, -80, 58]);
    // Anisotropic input scales (a 0.1 × 0.1 × 0.2 mm store in 1 mm global dimensions), swapped axes.
    const a = identityTransform();
    a.input = { ...a.input, scales: [0.0001, 0.0001, 0.0002] };
    expect(apply(modelTo(a, ["z", "x", "y"])!, [10, 20, 30]).slice(0, 3).map((v) => +v.toFixed(9))).toEqual([6, 1, 2]);
    // The same in a 2-D view: 4 px a global unit, centred on (120, -80).
    const project = (g: number[]) => ({ x: 4 * (g[0] - 120) + 200, y: -4 * (g[1] + 80) + 150, depth: g[2] - 60 });
    const rows = measurePanel(project, [120, -80, 60])!;
    const p = apply(modelToPanel(t, ["x", "y", "z"], rows), [58, -40, 31]);
    expect(p.slice(0, 3).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([200, 150, 0]);
    // Directions stay physical: a store step is 1 mm whatever the global scale.
    const d = directionMatrix(t);
    expect(d[0]).toBeCloseTo(0.001);
    expect(d[4]).toBeCloseTo(0.001);
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
      { index: 0, vertexCount: 4e6, chunkShape: [10, 10, 10], objectShare: 1, objects: 40000 },
      { index: 1, vertexCount: 4e5, chunkShape: [10, 10, 10], objectShare: 0.1, objects: 4000 },
      { index: 2, vertexCount: 4e4, chunkShape: [20, 10, 10], objectShare: 0.01, objects: 400 },
    ],
    geometry: "streamline",
    primitive: "lines",
    attributes: [],
    warnings: [],
    objectRead: "curves",
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

describe("reading the chosen objects whole", () => {
  // 100 vertices an object at level 0; coarser levels keep a tenth of the objects each.
  const levels = [
    { index: 0, vertexCount: 4e6, chunkShape: [10, 10, 10], objectShare: 1, objects: 40000 },
    { index: 1, vertexCount: 4e5, chunkShape: [10, 10, 10], objectShare: 0.1, objects: 4000 },
  ];
  const curves = { levels, objectRead: "curves" as const };

  it("reads a few chosen objects whole at level 0, and leaves many, or every object, to the chunks", () => {
    expect(objectPlan(curves, 18, "object", 2)).toEqual({ level: 0, mode: "curves" });
    // 8 M vertices (four times the Detail) is 80 000 objects of 100 vertices.
    expect(objectPlan(curves, 80_000, "object", 2)).toEqual({ level: 0, mode: "curves" });
    expect(objectPlan(curves, 80_001, "object", 2)).toBeUndefined();
    // However large the Detail, no more than MAX_CURVES.
    expect(objectPlan(curves, MAX_CURVES, "object", 12)).toEqual({ level: 0, mode: "curves" });
    expect(objectPlan(curves, MAX_CURVES + 1, "object", 12)).toBeUndefined();
    // A smaller Detail: 0.25 M x 4 = 1 M vertices, 10 000 objects.
    expect(objectPlan(curves, 10_000, "object", 0.25)).toEqual({ level: 0, mode: "curves" });
    expect(objectPlan(curves, 10_001, "object", 0.25)).toBeUndefined();
    expect(objectPlan(curves, 0, "object", 2)).toBeUndefined();
  });

  it("judges by the chosen objects' own vertices once some are read", () => {
    // 50 000 objects at the level's mean (100) is 5 M: read whole; measured at 400 each, 20 M > 2 x 8 M: chunks.
    expect(objectPlan(curves, 50_000, "object", 2)).toEqual({ level: 0, mode: "curves" });
    expect(objectPlan(curves, 50_000, "object", 2, { level: 0, perObject: 400 })).toBeUndefined();
    // Up to twice the budget once measured, so it does not go back and forth.
    expect(objectPlan(curves, 50_000, "object", 2, { level: 0, perObject: 200 })).toEqual({ level: 0, mode: "curves" });
    const sets = new ObjectSets(() => {}, 1);
    expect(sets.measured()).toBeUndefined();
    const ids = Array.from({ length: FIRST_BATCH }, (_, i) => BigInt(i));
    sets.want(BigUint64Array.from(ids), { level: 0, mode: "curves" }, "object");
    sets.arrived("o0", built(ids), ids);
    expect(sets.measured()).toEqual({ level: 0, perObject: 2 });
  });

  it("never reads them from a level that keeps only a sample of the objects", () => {
    // Level 0 over budget, level 1 within it but a sample: the chunks instead.
    expect(objectPlan(curves, 30_000, "object", 0.25)).toBeUndefined();
    // A level that simplifies the lines but keeps every object is used.
    const all = { levels: [levels[0], { ...levels[1], objectShare: 1, objects: 40000 }], objectRead: "curves" as const };
    expect(objectPlan(all, 30_000, "object", 0.25)).toEqual({ level: 1, mode: "curves" });
  });

  it("reads skeletons one at a time, fewer of them, as it does curves coloured by a vertex attribute", () => {
    expect(objectPlan(curves, 100, "attribute:fa", 2)).toEqual({ level: 0, mode: "skeletons" });
    expect(objectPlan(curves, MAX_SKELETONS + 1, "attribute:fa", 2)).toBeUndefined();
    expect(objectPlan({ levels, objectRead: "skeletons" }, 100, "object", 2)).toEqual({ level: 0, mode: "skeletons" });
    // A mesh, or a store without an object index: chunks.
    expect(objectPlan({ levels, objectRead: undefined }, 5, "object", 2)).toBeUndefined();
  });

  it("asks for the objects not read yet, in order, a small batch first", () => {
    const wanted = BigUint64Array.from([5n, 3n, 9n, 1n]);
    expect(planBatches(wanted, () => false, true)).toEqual([[1n, 3n, 5n, 9n]]);
    expect(planBatches(wanted, (id) => id === 3n || id === 9n, false)).toEqual([[1n, 5n]]);
    const many = BigUint64Array.from({ length: FIRST_BATCH + BATCH + 1 }, (_, i) => BigInt(1000 - i));
    const batches = planBatches(many, () => false, true);
    expect(batches.map((b) => b.length)).toEqual([FIRST_BATCH, BATCH, 1]);
    expect(batches[0][0] < batches[0][1]).toBe(true);
    expect(batches[1][0] > batches[0][FIRST_BATCH - 1]).toBe(true);
    // With something read already, no small first batch.
    expect(planBatches(many, () => false, false).map((b) => b.length)).toEqual([BATCH, FIRST_BATCH + 1]);
  });

  const built = (ids: bigint[]) =>
    buildChunk(
      curvesInput(
        ids,
        Uint32Array.from({ length: ids.length + 1 }, (_, i) => 2 * i),
        Float32Array.from({ length: 6 * ids.length }, (_, i) => i),
      ),
      { kind: "object" },
    );

  it("keeps what it has read by object, and asks only for the new ones when the selection changes", () => {
    const sent: { key: string; ids: bigint[] }[] = [];
    const sets = new ObjectSets((key, _plan, ids) => sent.push({ key, ids: Array.from(ids) }), 1);
    const plan = { level: 0, mode: "curves" as const };
    sets.want(BigUint64Array.from([1n, 2n, 3n]), plan, "object");
    expect(sent).toEqual([{ key: "o0", ids: [1n, 2n, 3n] }]);
    expect(sets.busy).toBe(true);
    // Object 3 is not in the store.
    sets.arrived("o0", built([1n, 2n]), [1n, 2n]);
    expect(sets.progress()).toEqual({ wanted: 3, read: 2, absent: 1, pending: 0 });
    expect(sets.drawn()).toEqual(["o0"]);
    expect(sets.busy).toBe(false);
    // 2 stays, 4 is new: only 4 is asked for (and 3, not in the store, is not asked again).
    sets.want(BigUint64Array.from([2n, 3n, 4n]), plan, "object");
    expect(sent.slice(1)).toEqual([{ key: "o1", ids: [4n] }]);
    expect(sets.drawn()).toEqual(["o0"]);
    sets.arrived("o1", built([4n]), [4n]);
    expect(new Set(sets.drawn())).toEqual(new Set(["o0", "o1"]));
    // Back to 1: read already, nothing to ask; only its set is drawn.
    sets.want(BigUint64Array.from([1n]), plan, "object");
    expect(sent.length).toBe(2);
    expect(sets.drawn()).toEqual(["o0"]);
    // Nothing chosen to read whole: nothing drawn, nothing asked, what was read kept.
    sets.want(undefined, undefined, "object");
    expect(sets.drawn()).toEqual([]);
    expect(sets.has("o0")).toBe(true);
    // Another level (or another colouring) starts again.
    const generation = sets.generation;
    sets.want(BigUint64Array.from([1n]), { level: 1, mode: "curves" }, "object");
    expect(sets.generation).toBe(generation + 1);
    expect(sent[2]).toEqual({ key: "o2", ids: [1n] });
    // An answer to what was asked before is ignored.
    sets.arrived("o1", built([4n]), [4n]);
    expect(sets.has("o1")).toBe(false);
  });

  it("asks a batch at a time, so a new selection is not stuck behind the old one's", () => {
    const sent: bigint[][] = [];
    const sets = new ObjectSets((_key, _plan, ids) => sent.push(Array.from(ids)), 1);
    const plan = { level: 0, mode: "curves" as const };
    const many = BigUint64Array.from({ length: FIRST_BATCH + 2 * BATCH }, (_, i) => BigInt(i));
    sets.want(many, plan, "object");
    expect(sent.length).toBe(1);
    // The selection changes before the rest are asked for: the queue is the new selection's.
    sets.want(BigUint64Array.from([1n, 99999n]), plan, "object");
    sets.arrived("o0", built([0n, 1n]), [0n, 1n]);
    expect(sent[1]).toEqual([99999n]);
  });

  it("lets go of sets no chosen object is in when memory is short", () => {
    const sets = new ObjectSets(() => {}, 4, 1);
    const plan = { level: 0, mode: "curves" as const };
    sets.want(BigUint64Array.from([1n, 2n]), plan, "object");
    sets.arrived("o0", built([1n, 2n]), [1n, 2n]);
    expect(sets.has("o0")).toBe(true);
    sets.want(BigUint64Array.from([5n]), plan, "object");
    sets.arrived("o1", built([5n]), [5n]);
    expect(sets.has("o0")).toBe(false);
    expect(sets.has("o1")).toBe(true);
  });

  it("builds curves read whole as one chunk, each joined vertex to vertex", () => {
    const input = curvesInput([7n, (2n << 32n) | 1n], new Uint32Array([0, 3, 5]), new Float32Array(15));
    expect(Array.from(input.edges)).toEqual([0, 1, 1, 2, 3, 4]);
    expect(Array.from(input.segmentIds)).toEqual([7, 0, 7, 0, 7, 0, 1, 2, 1, 2]);
    const s = skeletonsInput(
      [
        { id: 3n, positions: new Float32Array(6), edges: new Uint32Array([0, 1]), attributes: [new Float32Array([1, 2])] },
        { id: 4n, positions: new Float32Array(9), edges: new Uint32Array([0, 1, 1, 2]), attributes: [new Float32Array([3, 4, 5])] },
      ],
      [1],
    );
    expect(Array.from(s.edges)).toEqual([0, 1, 2, 3, 3, 4]);
    expect(Array.from(s.attributes[0])).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(s.segmentIds.filter((_, i) => i % 2 === 0))).toEqual([3, 3, 4, 4, 4]);
  });

  it("sorts a set's segments into pieces of space, so a 2-D view draws only those in its slab", () => {
    // One line along x from 0 to 40, a vertex every unit.
    const n = 41;
    const positions = Float32Array.from({ length: 3 * n }, (_, i) => (i % 3 === 0 ? i / 3 : 0));
    const c = buildChunk(curvesInput([1n], new Uint32Array([0, n]), positions), { kind: "none" });
    sortIntoPieces(c, 10);
    const pieces = c.pieces!;
    expect(pieces.length / PIECE_STRIDE).toBe(4);
    let total = 0;
    for (let i = 0; i < pieces.length; i += PIECE_STRIDE) {
      const [start, count, lx, , , ux] = pieces.slice(i, i + 8);
      total += count;
      // The samples' ends run up to the piece's count.
      expect(pieces[i + 7 + SAMPLES]).toBe(count);
      // Every segment of a piece lies within its bounds, and the joints are kept (previous and next).
      for (let s = start; s < start + count; ++s) {
        const a = c.segments[4 * s + 1];
        const b = c.segments[4 * s + 2];
        expect(c.vertices[4 * a]).toBeGreaterThanOrEqual(lx);
        expect(c.vertices[4 * b]).toBeLessThanOrEqual(ux);
        if (a > 0) expect(c.segments[4 * s]).toBe(a - 1);
      }
    }
    expect(total).toBe(n - 1);
    // A slab around x = 25 meets one piece.
    const met = [];
    for (let i = 0; i < pieces.length; i += PIECE_STRIDE) if (pieces[i + 2] <= 25 && pieces[i + 5] >= 25) met.push(i);
    expect(met.length).toBe(1);
  });

  it("orders each piece by samples of whole objects, so a view over its Detail draws a sample of them", () => {
    // 200 short lines across the same 2 x 1 x 1 box: two pieces along x.
    const ids = Array.from({ length: 200 }, (_, i) => BigInt(i + 1));
    const offsets = Uint32Array.from({ length: 201 }, (_, i) => 3 * i);
    const positions = Float32Array.from({ length: 200 * 9 }, (_, i) => (i % 3 === 0 ? (Math.floor(i / 3) % 3) * 0.99 : (i % 3) * 0.5));
    const c = buildChunk(curvesInput(ids, offsets, positions), { kind: "none" });
    sortIntoPieces(c, 1);
    const p = c.pieces!;
    expect(p.length / PIECE_STRIDE).toBe(2);
    // In every piece, the first k samples hold the segments of the same objects: those whose key is below k / SAMPLES.
    for (let i = 0; i < p.length; i += PIECE_STRIDE) {
      for (let k = 1; k <= SAMPLES; ++k) {
        const n = p[i + 7 + k];
        for (let s = p[i]; s < p[i] + p[i + 1]; ++s) {
          const slot = c.slots[c.segments[4 * s + 1]];
          const sample = Math.floor(objectKey(c.objectIds[2 * slot], c.objectIds[2 * slot + 1]) * SAMPLES);
          expect(s - p[i] < n).toBe(sample < k);
        }
      }
    }
    // Roughly an eighth of the objects in each sample.
    expect(p[8] + p[PIECE_STRIDE + 8]).toBeGreaterThan(400 / SAMPLES / 2);
    expect(p[8] + p[PIECE_STRIDE + 8]).toBeLessThan((400 / SAMPLES) * 2);
    const everywhere = () => true;
    expect(samplesFor([c], everywhere, 1000)).toBe(SAMPLES);
    expect(samplesFor([c], everywhere, 200)).toBe(4);
    expect(samplesFor([c], everywhere, 1)).toBe(1);
    // Only the pieces in view count.
    expect(samplesFor([c], (lo) => lo[0] > 0.9, 200)).toBe(SAMPLES);
  });
});

describe("the objects not chosen, faintly", () => {
  const input = {
    numVertices: 4,
    numOwnVertices: 4,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 5, 5, 5, 5, 6, 5]),
    segmentIds: new Uint32Array([7, 0, 7, 0, 9, 0, 9, 0]),
    edges: new Uint32Array([0, 1, 2, 3]),
    attributes: [],
  };

  it("draws the others at the layer's notSelectedAlpha, and leaves the chosen ones out when they are read whole", () => {
    const c = buildChunk(input, { kind: "none" });
    const chosen = (id: bigint) => id === 7n;
    expect(alphaByte(0)).toBe(0);
    expect(alphaByte(0.001)).toBe(1);
    expect(alphaByte(1)).toBe(255);
    const faint = objectTable(c.objectIds, c.objectWeight, { version: 1, all: false, has: chosen, othersAlpha: 0.2 });
    expect([faint.table[3], faint.table[7]]).toEqual([255, 51]);
    expect(faint.shown).toBe(1);
    expect(faint.light).toBeCloseTo(0.5 + 0.5 * (51 / 255));
    const others = objectTable(c.objectIds, c.objectWeight, { version: 2, all: false, has: chosen, chosenAlpha: 0, othersAlpha: 0.2 });
    expect([others.table[3], others.table[7]]).toEqual([0, 51]);
    expect(others.shown).toBeCloseTo(0.5);
    expect(alphaOf({ version: 3, all: true, has: () => false }, 9n)).toBe(1);
    // Faint lines count for less light when judging how much of the view they cover.
    expect(coverage([{ length: 10, pointCount: 0, shown: 1, light: 0.1 }], 1, 1, 10)).toBeCloseTo(0.1);
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
