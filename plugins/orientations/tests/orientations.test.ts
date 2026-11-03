/**
 * The orientations plugin end to end without a browser: synthetic
 * multiscale stores (./synthetic.ts) read through the reader, voxels picked
 * by a section's slab, and the glyphs made from them; the level chosen by
 * zoom; a section's geometry; and the settings resolved from a store's own
 * attributes.
 *
 * With ORIENTATIONS_WRITE=<folder>, the stores are also written there, to
 * serve and look at in the app.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { computeGlyphs, type GlyphOptions, voxelFrame, withFlips } from "../glyphs.js";
import { spatialGroup } from "../ome4.js";
import { readSaved, resolveBasis, resolveFrame, resolveKind } from "../plugin.js";
import { OrientationReader } from "../reader.js";
import { directionShader } from "../shader.js";
import { icosphere } from "../sphere.js";
import { boxAround, chooseLevel, layerMove, planesAround, planSection, sectionOf, slabOf, slabVoxels, unproject, type Vec3 } from "../view.js";
import { buildStore, crossingSh, type Store, storeFetch, tensorField, vectorField } from "./synthetic.js";

const SIZE: [number, number, number] = [32, 32, 8];
const stores: Record<string, Store> = {};

beforeAll(() => {
  stores["http://synthetic.test/sh.ome.zarr/"] = buildStore(crossingSh(SIZE));
  stores["http://synthetic.test/tensor.ome.zarr/"] = buildStore(tensorField(SIZE));
  stores["http://synthetic.test/vector.ome.zarr/"] = buildStore(vectorField(SIZE));
  const out = process.env.ORIENTATIONS_WRITE;
  if (out) {
    // Bigger ones to look at.
    const big: [number, number, number] = [96, 96, 24];
    for (const s of [crossingSh(big), tensorField(big), vectorField(big)]) {
      const store = buildStore({ ...s, levels: 5 });
      for (const [key, value] of store) {
        const file = path.join(out, `${s.name}.ome.zarr`, key);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
      }
    }
  }
});

afterEach(() => vi.unstubAllGlobals());

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const options = (patch: Partial<GlyphOptions> = {}): GlyphOptions => ({
  kind: "sh",
  basis: "descoteaux07-legacy",
  tensorOrder: "fsl",
  toData: IDENTITY,
  normalise: "minmax",
  tensorGlyph: "ellipsoid",
  subdivisions: 2,
  ...patch,
});

/** The sphere vertex nearest a direction, and the radius there. */
function radiusToward(radii: Float32Array, glyph: number, d: Vec3, subdivisions = 2): number {
  const { vertices, count } = icosphere(subdivisions);
  let best = 0;
  let bestDot = -Infinity;
  for (let v = 0; v < count; ++v) {
    const dot = vertices[3 * v] * d[0] + vertices[3 * v + 1] * d[1] + vertices[3 * v + 2] * d[2];
    if (dot > bestDot) [best, bestDot] = [v, dot];
  }
  return radii[glyph * count + best];
}

describe("reading orientation pyramids", () => {
  it("opens every level with its components and placement", async () => {
    vi.stubGlobal("fetch", storeFetch(stores));
    const reader = new OrientationReader();
    const opened = await reader.open("http://synthetic.test/sh.ome.zarr/");
    expect(opened.componentAxis).toBe("c");
    expect(opened.metadata).toMatchObject({ type: "sh", basis: "descoteaux07", legacy: true });
    expect(opened.levels.map((l) => l.size)).toEqual([
      [32, 32, 8],
      [16, 16, 4],
      [8, 8, 2],
      [4, 4, 1],
    ]);
    expect(opened.levels.map((l) => l.voxelSize)).toEqual([2, 4, 8, 16]);
    expect(opened.levels.every((l) => l.components === 45)).toBe(true);
    // Level 1's voxel 0 is the middle of level 0's voxels 0 and 1: 1 mm.
    expect(opened.levels[1].voxelToRas[3]).toBeCloseTo(1, 9);
  });

  it("reads the voxels of a section, with every component", async () => {
    vi.stubGlobal("fetch", storeFetch(stores));
    const reader = new OrientationReader();
    const opened = await reader.open("http://synthetic.test/tensor.ome.zarr/");
    const level = opened.levels[0];
    // The axial plane through z = 3 (RAS z = 6 mm).
    const slab = slabOf(level.voxelToRas, [10, 10, 6], [0, 0, 1]);
    expect(slab.n).toEqual([0, 0, 1]);
    expect(slab.d).toBeCloseTo(3, 9);
    const voxels = await reader.voxels(0, { lo: [0, 0, 0], hi: [32, 32, 8], slabs: [slab] }, new AbortController().signal);
    expect(voxels.count).toBe(32 * 32);
    for (let i = 0; i < voxels.count; ++i) expect(voxels.indices[3 * i + 2]).toBe(3);
    // Voxel (4, 12, 3) is in the band along x: Dxx is the largest component.
    const i = [...Array(voxels.count).keys()].find((k) => voxels.indices[3 * k] === 4 && voxels.indices[3 * k + 1] === 12)!;
    const d = voxels.values.slice(6 * i, 6 * i + 6);
    expect(d[0]).toBeCloseTo(1.7e-3, 6);
    expect(d[3]).toBeCloseTo(0.3e-3, 6);
    expect(d[5]).toBeCloseTo(0.3e-3, 6);
  });

  it("strips a NIfTI's fourth axis (t, read in place) from OME-Zarr 0.6 metadata", () => {
    const group = {
      attributes: {
        ome: {
          version: "0.6",
          multiscales: [
            {
              coordinateSystems: [
                { name: "scanner", axes: [{ name: "t", type: "time" }, { name: "x" }, { name: "y" }, { name: "z" }] },
                { name: "array", axes: [{ name: "t", type: "time" }, { name: "x" }, { name: "y" }, { name: "z" }] },
              ],
              datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1, 1], input: "0", output: "array" }] }],
              coordinateTransformations: [
                {
                  type: "affine",
                  input: "array",
                  output: "scanner",
                  affine: [
                    [1, 0, 0, 0, 0],
                    [0, -2, 0, 0, 90],
                    [0, 0, 2, 0, -126],
                    [0, 0, 0, 2, -72],
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    const { group: spatial, component, name } = spatialGroup(group);
    expect(component).toBe(0);
    expect(name).toBe("t");
    const ms = spatial.attributes.ome.multiscales[0];
    expect(ms.coordinateSystems[0].axes.map((a: { name: string }) => a.name)).toEqual(["x", "y", "z"]);
    expect(ms.datasets[0].coordinateTransformations[0].scale).toEqual([1, 1, 1]);
    expect(ms.coordinateTransformations[0].affine).toEqual([
      [-2, 0, 0, 90],
      [0, 2, 0, -126],
      [0, 0, 2, -72],
    ]);
    expect(() => spatialGroup({ attributes: { ome: { multiscales: [{ axes: [{ name: "z" }, { name: "y" }, { name: "x" }], datasets: [{ path: "0" }] }] } } })).toThrow(/components/);
  });
});

describe("glyphs", () => {
  it("draws crossing fibres as an ODF with lobes along x and y", async () => {
    vi.stubGlobal("fetch", storeFetch(stores));
    const reader = new OrientationReader();
    const opened = await reader.open("http://synthetic.test/sh.ome.zarr/");
    const level = opened.levels[0];
    // Voxel (20, 12, 2) is where the bands cross; (4, 12, 2) is along x; (4, 4, 2) along z; (0, 0, 2) is border.
    const picks = [
      [20, 12, 2],
      [4, 12, 2],
      [4, 4, 2],
      [0, 0, 2],
    ];
    const voxels = await reader.voxels(0, { lo: [0, 0, 2], hi: [32, 32, 3] }, new AbortController().signal);
    const pick = (p: number[]) => [...Array(voxels.count).keys()].find((k) => p.every((v, j) => voxels.indices[3 * k + j] === v))!;
    const indices = picks.slice(0, 3).flatMap((p) => p);
    const values = new Float32Array(3 * 45);
    picks.slice(0, 3).forEach((p, k) => values.set(voxels.values.subarray(45 * pick(p), 45 * pick(p) + 45), 45 * k));
    const set = computeGlyphs(indices, values, 45, level.voxelToRas, options());
    expect(set.shape).toBe("surface");
    expect(set.count).toBe(3);
    const r = (g: number, d: Vec3) => radiusToward(set.radii!, g, d);
    // Min-max normalised: 0..1.
    expect(Math.min(...set.radii!)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...set.radii!)).toBeLessThanOrEqual(1);
    // The crossing: long along x and y, short along z.
    expect(r(0, [1, 0, 0])).toBeGreaterThan(0.85);
    expect(r(0, [0, 1, 0])).toBeGreaterThan(0.85);
    expect(r(0, [0, 0, 1])).toBeLessThan(0.15);
    expect(r(0, [Math.SQRT1_2, Math.SQRT1_2, 0])).toBeLessThan(0.5);
    // One fibre along x.
    expect(r(1, [1, 0, 0])).toBeGreaterThan(0.95);
    expect(r(1, [0, 1, 0])).toBeLessThan(0.1);
    // Along z.
    expect(r(2, [0, 0, 1])).toBeGreaterThan(0.95);
    // Centres in RAS mm: voxel (20, 12, 2) at 2 mm voxels.
    expect(Array.from(set.centres.slice(0, 3))).toEqual([40, 24, 4]);
    // An empty voxel makes no glyph.
    const none = computeGlyphs([0, 0, 2], voxels.values.slice(45 * pick(picks[3]), 45 * pick(picks[3]) + 45), 45, level.voxelToRas, options());
    expect(none.count).toBe(0);
  });

  it("averages a coarse level's crossing from its finer voxels", async () => {
    vi.stubGlobal("fetch", storeFetch(stores));
    const reader = new OrientationReader();
    const opened = await reader.open("http://synthetic.test/sh.ome.zarr/");
    // Level 1 voxel (10, 6, 1) covers level 0's (20..21, 12..13, 2..3): all crossing.
    const voxels = await reader.voxels(1, { lo: [10, 6, 1], hi: [11, 7, 2] }, new AbortController().signal);
    const set = computeGlyphs(voxels.indices, voxels.values, 45, opened.levels[1].voxelToRas, options());
    expect(set.count).toBe(1);
    expect(radiusToward(set.radii!, 0, [1, 0, 0])).toBeGreaterThan(0.85);
    expect(radiusToward(set.radii!, 0, [0, 1, 0])).toBeGreaterThan(0.85);
  });

  it("turns directions from the voxel axes into RAS, and flips them", () => {
    // A level stored with x running right to left (a radiological NIfTI).
    const voxelToRas = [-2, 0, 0, 90, 0, 2, 0, -126, 0, 0, 2, -72, 0, 0, 0, 1];
    const frame = voxelFrame(voxelToRas);
    expect(frame).toEqual([-1, 0, 0, 0, 1, 0, 0, 0, 1].map((v) => v + 0));
    const tilted = Float32Array.from([0.8, 0.6, 0]);
    const plain = computeGlyphs([0, 0, 0], tilted, 3, voxelToRas, options({ kind: "vector", toData: frame }));
    // Voxel axis x is RAS -x.
    expect(Array.from(plain.dirs!).map((v) => +v.toFixed(6))).toEqual([-0.8, 0.6, 0]);
    const flipped = computeGlyphs([0, 0, 0], tilted, 3, voxelToRas, options({ kind: "vector", toData: withFlips(frame, [false, true, false]) }));
    expect(Array.from(flipped.dirs!).map((v) => +v.toFixed(6))).toEqual([-0.8, -0.6, 0]);
    // Colours by direction, whatever the sign.
    expect(Array.from(flipped.colours!).map((v) => +v.toFixed(6))).toEqual([0.8, 0.6, 0]);
  });

  it("draws tensors as ellipsoids along their principal direction, or as lines", () => {
    // Prolate along y (FSL order: xx xy xz yy yz zz).
    const d = Float32Array.from([0.3, 0, 0, 1.7, 0, 0.3]);
    const voxelToRas = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const set = computeGlyphs([0, 0, 0], d, 6, voxelToRas, options({ kind: "tensor" }));
    expect(set.shape).toBe("surface");
    expect(radiusToward(set.radii!, 0, [0, 1, 0])).toBeCloseTo(1, 2);
    expect(radiusToward(set.radii!, 0, [1, 0, 0])).toBeCloseTo(0.3 / 1.7, 2);
    // Green (y), bright for an FA of 0.8.
    const [r, g, b] = Array.from(set.colours!);
    expect(g).toBeGreaterThan(0.8);
    expect(r).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(0, 6);
    const lines = computeGlyphs([0, 0, 0], d, 6, voxelToRas, options({ kind: "tensor", tensorGlyph: "line" }));
    expect(lines.shape).toBe("lines");
    expect(Math.abs(lines.dirs![1])).toBeCloseTo(1, 9);
    // The same tensor in DIPY's order reads the same.
    const dipy = Float32Array.from([0.3, 0, 1.7, 0, 0, 0.3]);
    const again = computeGlyphs([0, 0, 0], dipy, 6, voxelToRas, options({ kind: "tensor", tensorOrder: "dipy" }));
    expect(radiusToward(again.radii!, 0, [0, 1, 0])).toBeCloseTo(1, 2);
  });

  it("draws peaks as lines, each scaled to the voxel's largest", () => {
    const voxelToRas = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // Two peaks, one empty slot.
    const v = Float32Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0]);
    const set = computeGlyphs([5, 6, 7], v, 9, voxelToRas, options({ kind: "peaks" }));
    expect(set.count).toBe(2);
    expect(Array.from(set.dirs!)).toEqual([1, 0, 0, 0, 0.5, 0]);
    expect(Array.from(set.centres)).toEqual([5, 6, 7, 5, 6, 7]);
    // Slots MRtrix leaves NaN are no peak, not an empty voxel.
    const nan = Float32Array.from([0, 0, 3, NaN, NaN, NaN, NaN, NaN, NaN]);
    const one = computeGlyphs([1, 1, 1], nan, 9, voxelToRas, options({ kind: "peaks" }));
    expect(one.count).toBe(1);
    expect(Array.from(one.dirs!)).toEqual([0, 0, 1]);
  });

  it("leaves out glyphs below an anisotropy", () => {
    const voxelToRas = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // An isotropic tensor (FA 0) and a prolate one (FA 0.8).
    const d = Float32Array.from([1, 0, 0, 1, 0, 1, 0.3, 0, 0, 1.7, 0, 0.3]);
    expect(computeGlyphs([0, 0, 0, 1, 0, 0], d, 6, voxelToRas, options({ kind: "tensor" })).count).toBe(2);
    const kept = computeGlyphs([0, 0, 0, 1, 0, 0], d, 6, voxelToRas, options({ kind: "tensor", minAnisotropy: 0.5 }));
    expect(kept.count).toBe(1);
    expect(kept.centres[0]).toBe(1);
  });
});

describe("views", () => {
  it("chooses the finest level whose voxels are far enough apart on the screen", () => {
    const sizes = [0.5, 1, 2, 4];
    expect(chooseLevel(sizes, 30, 12)).toBe(0); // 15 px apart at 0.5 mm
    expect(chooseLevel(sizes, 10, 12)).toBe(2); // 5, 10 too close; 20 px
    expect(chooseLevel(sizes, 1, 12)).toBe(3); // none is: the coarsest
    // Zooming in only ever moves to finer levels.
    let last = Infinity;
    for (let px = 0.5; px < 100; px *= 1.3) {
      const level = chooseLevel(sizes, px, 12);
      expect(level).toBeLessThanOrEqual(last);
      last = level;
    }
  });

  /** An axial view, radiological (right on the left, anterior up), centred at `origin`, `zoom` px/mm. */
  const axial = (origin: Vec3, zoom: number, width = 400, height = 300) =>
    sectionOf(
      (p) => ({ x: width / 2 - zoom * (p[0] - origin[0]), y: height / 2 - zoom * (p[1] - origin[1]), depth: 0.1 * (p[2] - origin[2]) }),
      origin,
      width,
      height,
    )!;

  it("finds a view's section and what it shows", () => {
    const s = axial([10, 20, 30], 4);
    expect(s.pxPerMm).toBeCloseTo(4, 9);
    expect(s.normal.map((v) => +v.toFixed(9))).toEqual([0, 0, 1]);
    const corner = unproject(s, 0, 0)!;
    // The top left is the patient's right (+x) and anterior (+y).
    expect(corner[0]).toBeCloseTo(10 + 50, 9);
    expect(corner[1]).toBeCloseTo(20 + 37.5, 9);
    expect(corner[2]).toBeCloseTo(30, 9);
  });

  it("reads only the voxels in view on the section, a few thousand at most", () => {
    const voxelToRas = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const size: Vec3 = [256, 256, 200];
    const s = axial([128, 128, 100.2], 8);
    const corners = [
      [0, 0],
      [400, 0],
      [0, 300],
      [400, 300],
    ].map(([x, y]) => unproject(s, x, y)!);
    const visible = boxAround(voxelToRas, size, corners, 0)!;
    const slab = slabOf(voxelToRas, s.origin, s.normal);
    expect(slab.d).toBeCloseTo(100.2, 9);
    // 50 × 37.5 mm at 1 mm, give or take the edges.
    expect(slabVoxels(visible, slab)).toBeGreaterThan(50 * 37);
    expect(slabVoxels(visible, slab)).toBeLessThan(55 * 42);
    // One plane of voxels: z = 100 only (|100 - 100.2| < 0.5).
    for (const z of [99, 100, 101]) {
      const inside = -slab.h <= z - slab.d && z - slab.d < slab.h;
      expect(inside).toBe(z === 100);
    }
  });

  it("plans a view's reading: finer levels as it zooms in, coarser beyond the cap", () => {
    // A pyramid of 1, 2, 4 and 8 mm over 256 mm, like a pyramid writer makes.
    const levels = [1, 2, 4, 8].map((v) => ({
      voxelSize: v,
      voxelToRas: [v, 0, 0, (v - 1) / 2, 0, v, 0, (v - 1) / 2, 0, 0, v, (v - 1) / 2, 0, 0, 0, 1],
      size: [256 / v, 256 / v, 256 / v] as Vec3,
    }));
    const plan = (zoom: number, maxGlyphs = 8000) => planSection(levels, axial([128, 128, 128], zoom), { spacing: 24, maxGlyphs, size: 1 });
    const levelAt = (zoom: number, maxGlyphs?: number) => {
      const p = plan(zoom, maxGlyphs);
      return "note" in p ? p.note : p.level;
    };
    // 3 px/mm: 8 mm voxels are 24 px apart; 6: 4 mm; 12: 2 mm; 24 and more: 1 mm.
    expect([3, 6, 12, 24, 48].map((z) => levelAt(z))).toEqual([3, 2, 1, 0, 0]);
    // Zoomed out past the coarsest: glyphs too small.
    expect(levelAt(0.4)).toMatch(/under 4 pixels/);
    // At 24 px/mm the 1 mm level reads about 20 × 16 voxels (what shows, and a voxel round it); capped at 300, the 2 mm level.
    expect(levelAt(24, 300)).toBe(1);
    expect(levelAt(24, 10)).toMatch(/coarsest/);
    // What is read covers what is shown, with a margin, on the section's plane of voxels.
    const p = plan(12);
    if ("note" in p) throw new Error(p.note);
    expect(p.box.lo.every((v, k) => v <= p.visible.lo[k])).toBe(true);
    expect(p.box.hi.every((v, k) => v >= p.visible.hi[k])).toBe(true);
    expect(p.slabs[0].n.map(Math.abs)).toEqual([0, 0, 1]);
    // Big glyphs get the finer sphere.
    expect(p.subdivisions).toBe(2);
    const big = plan(48);
    expect("note" in big ? 0 : big.subdivisions).toBe(3);
  });

  it("follows a layer moved from where its store puts it", () => {
    // Output dimensions c', z, y, x (2 mm), as an OME-Zarr image with a channel axis gives them.
    const output = { names: ["c'", "z", "y", "x"], scales: [1, 0.002, 0.002, 0.002], units: ["", "m", "m", "m"] };
    const eye = (n: number) => Float64Array.from({ length: n * n }, (_, i) => (i % (n + 1) === 0 ? 1 : 0));
    expect(layerMove({ rank: 4, output, matrix: eye(5), defaultMatrix: eye(5) })).toBeUndefined();
    // Moved 5 units (10 mm) along x, and the default placed 3 units along z.
    const def = eye(5);
    def[4 * 5 + 1] = 3;
    const moved = Float64Array.from(def);
    moved[4 * 5 + 3] = 5;
    const m = layerMove({ rank: 4, output, matrix: moved, defaultMatrix: def })!;
    expect(m).toEqual([1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // A quarter turn about z (x to y), around the origin.
    const turned = Float64Array.from(def);
    // Columns: input x (index 3) goes to output y (index 2), input y to output -x.
    turned[3 * 5 + 3] = 0;
    turned[3 * 5 + 2] = 1;
    turned[2 * 5 + 2] = 0;
    turned[2 * 5 + 3] = -1;
    const r = layerMove({ rank: 4, output, matrix: turned, defaultMatrix: def })!;
    expect(r.map((v) => +v.toFixed(12) || 0)).toEqual([0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it("places three planes around the position for the 3-D view", () => {
    const { box, slabs } = planesAround([10.4, 3.6, 7], [64, 64, 32], 5)!;
    expect(box.lo).toEqual([5, 0, 2]);
    expect(box.hi).toEqual([16, 10, 13]);
    expect(slabs.map((s) => s.d)).toEqual([10, 4, 7]);
  });
});

describe("settings", () => {
  it("fills in defaults", () => {
    const s = readSaved(undefined);
    expect(s).toMatchObject({ on: false, kind: "auto", basis: "auto", normalise: "minmax", spacing: 24, show2d: true, show3d: true });
    expect(readSaved({ spacing: 1000, flips: [true, 0, false] }).spacing).toBe(200);
  });

  it("takes the kind, basis and frame from the store, then from the number of components", () => {
    const none = { metadata: undefined };
    expect(resolveKind({ kind: "auto" }, none, 3)).toBe("vector");
    expect(resolveKind({ kind: "auto" }, none, 6)).toBe("tensor");
    expect(resolveKind({ kind: "auto" }, none, 45)).toBe("sh");
    expect(resolveKind({ kind: "auto" }, none, 9)).toBe("peaks");
    expect(resolveKind({ kind: "auto" }, { metadata: { type: "sh" } }, 6)).toBe("sh");
    expect(resolveKind({ kind: "tensor" }, { metadata: { type: "sh" } }, 6)).toBe("tensor");
    expect(resolveBasis({ basis: "auto" }, none)).toBe("descoteaux07-legacy");
    expect(resolveBasis({ basis: "auto" }, { metadata: { basis: "tournier07" } })).toBe("tournier07");
    expect(resolveBasis({ basis: "auto" }, { metadata: { basis: "descoteaux07", legacy: false } })).toBe("descoteaux07");
    expect(resolveFrame({ frame: "auto" }, none, "tournier07", "sh")).toBe("world");
    expect(resolveFrame({ frame: "auto" }, none, "descoteaux07-legacy", "sh")).toBe("voxel");
  });

  it("writes a direction-colour shader for each kind", () => {
    for (const [kind, n] of [
      ["vector", 3],
      ["tensor", 6],
      ["sh", 45],
    ] as const) {
      const shader = directionShader(options({ kind }), n)!;
      expect(shader).toContain("emitRGB");
      expect(shader).toContain("getDataValue(i)");
    }
    expect(directionShader(options({ kind: "sh" }), 1)).toBeUndefined();
  });
});
