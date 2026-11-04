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
import { computeGlyphs, type GlyphOptions, odfRadius, voxelFrame, withFlips } from "../glyphs.js";
import { spatialGroup } from "../ome4.js";
import { readSaved, resolveBasis, resolveFrame, resolveKind, resolveTensorOrder } from "../plugin.js";
import { OrientationReader } from "../reader.js";
import { directionShader } from "../shader.js";
import { fitSh } from "../sh.js";
import { icosphere } from "../sphere.js";
import { boxAround, chooseLevel, layerMove, planesAround, planSection, sectionOf, slabOf, slabVoxels, unproject, type Vec3 } from "../view.js";
import { buildStore, crossingSh, fibreOdf, spiral, type Store, storeFetch, tensorField, toZarr2, vectorField } from "./synthetic.js";

const SIZE: [number, number, number] = [32, 32, 8];
const stores: Record<string, Store> = {};

beforeAll(() => {
  stores["http://synthetic.test/sh.ome.zarr/"] = buildStore(crossingSh(SIZE));
  stores["http://synthetic.test/tensor.ome.zarr/"] = buildStore(tensorField(SIZE));
  stores["http://synthetic.test/vector.ome.zarr/"] = buildStore(vectorField(SIZE));
  stores["http://synthetic.test/tensor-v2.ome.zarr/"] = toZarr2(stores["http://synthetic.test/tensor.ome.zarr/"]);
  stores["http://synthetic.test/tensor-v2f.ome.zarr/"] = toZarr2(stores["http://synthetic.test/tensor.ome.zarr/"], "F");
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

/** An ellipsoid glyph's radius along a unit direction: 1 / √Σ (d·a)² / |a|⁴ over its semi-axes a. */
function ellipsoidRadius(axes: Float32Array, glyph: number, d: Vec3): number {
  let s = 0;
  for (let k = 0; k < 3; ++k) {
    const a = axes.subarray(9 * glyph + 3 * k, 9 * glyph + 3 * k + 3);
    const aa = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    s += (d[0] * a[0] + d[1] * a[1] + d[2] * a[2]) ** 2 / (aa * aa);
  }
  return 1 / Math.sqrt(s);
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

  it("reads OME-Zarr 0.4 in Zarr v2, C or Fortran order, as it reads v3", async () => {
    vi.stubGlobal("fetch", storeFetch(stores));
    const request = { lo: [0, 0, 2] as Vec3, hi: [32, 32, 4] as Vec3 };
    const read = async (url: string) => {
      const reader = new OrientationReader();
      const opened = await reader.open(url);
      return { opened, voxels: await reader.voxels(1, request, new AbortController().signal) };
    };
    const v3 = await read("http://synthetic.test/tensor.ome.zarr/");
    for (const url of ["http://synthetic.test/tensor-v2.ome.zarr/", "http://synthetic.test/tensor-v2f.ome.zarr/"]) {
      const v2 = await read(url);
      expect(v2.opened.levels.map((l) => l.size)).toEqual(v3.opened.levels.map((l) => l.size));
      expect(Array.from(v2.opened.levels[1].voxelToRas)).toEqual(Array.from(v3.opened.levels[1].voxelToRas));
      expect(v2.voxels.count).toBe(v3.voxels.count);
      expect(Array.from(v2.voxels.values)).toEqual(Array.from(v3.voxels.values));
    }
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
    expect(set.shape).toBe("odfs");
    expect(set.count).toBe(3);
    const r = (g: number, d: Vec3) => odfRadius(set, g, d);
    // Min-max normalised from the sphere's vertices: 0..1 there.
    const sphere = icosphere(2);
    for (let g = 0; g < 3; ++g) {
      const at = [...Array(sphere.count).keys()].map((v) => r(g, [sphere.vertices[3 * v], sphere.vertices[3 * v + 1], sphere.vertices[3 * v + 2]]));
      expect(Math.min(...at)).toBeCloseTo(0, 5);
      expect(Math.max(...at)).toBeCloseTo(1, 4);
    }
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

  it("finds an ODF's peaks: two at a crossing, one along a single fibre", async () => {
    vi.stubGlobal("fetch", storeFetch(stores));
    const reader = new OrientationReader();
    const opened = await reader.open("http://synthetic.test/sh.ome.zarr/");
    const voxels = await reader.voxels(0, { lo: [4, 12, 2], hi: [21, 13, 3] }, new AbortController().signal);
    const pick = (x: number) => [...Array(voxels.count).keys()].find((k) => voxels.indices[3 * k] === x)!;
    const values = new Float32Array(90);
    values.set(voxels.values.subarray(45 * pick(20), 45 * pick(20) + 45), 0);
    values.set(voxels.values.subarray(45 * pick(4), 45 * pick(4) + 45), 45);
    const set = computeGlyphs([20, 12, 2, 4, 12, 2], values, 45, opened.levels[0].voxelToRas, options({ shGlyph: "peaks" }));
    expect(set.shape).toBe("lines");
    // The crossing's two peaks, then the single fibre's one.
    expect(set.count).toBe(3);
    const d = Array.from(set.dirs!);
    const along = (k: number) => [0, 1, 2].reduce((best, a) => (Math.abs(d[3 * k + a]) > Math.abs(d[3 * k + best]) ? a : best), 0);
    expect([along(0), along(1)].sort()).toEqual([0, 1]);
    expect(along(2)).toBe(0);
    // Each within 10° of its axis.
    for (let k = 0; k < 3; ++k) {
      const n = Math.hypot(d[3 * k], d[3 * k + 1], d[3 * k + 2]);
      expect(Math.abs(d[3 * k + along(k)]) / n).toBeGreaterThan(Math.cos((10 * Math.PI) / 180));
    }
  });

  it("averages a coarse level's crossing from its finer voxels", async () => {
    vi.stubGlobal("fetch", storeFetch(stores));
    const reader = new OrientationReader();
    const opened = await reader.open("http://synthetic.test/sh.ome.zarr/");
    // Level 1 voxel (10, 6, 1) covers level 0's (20..21, 12..13, 2..3): all crossing.
    const voxels = await reader.voxels(1, { lo: [10, 6, 1], hi: [11, 7, 2] }, new AbortController().signal);
    const set = computeGlyphs(voxels.indices, voxels.values, 45, opened.levels[1].voxelToRas, options());
    expect(set.count).toBe(1);
    expect(odfRadius(set, 0, [1, 0, 0])).toBeGreaterThan(0.85);
    expect(odfRadius(set, 0, [0, 1, 0])).toBeGreaterThan(0.85);
  });

  it("reads a coarse level of tensors as their log-Euclidean mean, the determinant kept", async () => {
    vi.stubGlobal("fetch", storeFetch(stores));
    const reader = new OrientationReader();
    await reader.open("http://synthetic.test/tensor.ome.zarr/");
    const signal = new AbortController().signal;
    // Level 2 voxel (4, 2, 0) covers level 0's x 16..19, y 8..11, z 0..3: fibres along z, x and y, and crossings.
    const box = await reader.voxels(0, { lo: [16, 8, 0], hi: [20, 12, 4] }, signal);
    const coarse = await reader.voxels(2, { lo: [4, 2, 0], hi: [5, 3, 1] }, signal);
    const det = (v: Float32Array, at: number) => {
      const [xx, xy, xz, yy, yz, zz] = Array.from(v.subarray(at, at + 6), Number);
      return xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz);
    };
    expect(box.count).toBe(64);
    const dets = Array.from({ length: box.count }, (_, i) => det(box.values, 6 * i));
    expect(new Set(dets.map((d) => d.toPrecision(4))).size).toBe(2);
    const geometric = Math.exp(dets.reduce((a, d) => a + Math.log(d), 0) / dets.length);
    expect(det(coarse.values, 0) / geometric).toBeCloseTo(1, 4);
    // A plain mean of the same tensors swells.
    const mean = new Float32Array(6);
    for (let i = 0; i < box.count; ++i) for (let c = 0; c < 6; ++c) mean[c] += box.values[6 * i + c] / box.count;
    expect(det(mean, 0) / geometric).toBeGreaterThan(1.3);
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
    // Three semi-axes for the renderer to ray-cast: no mesh.
    expect(set.shape).toBe("ellipsoids");
    expect(set.coefficients).toBeUndefined();
    expect(set.axes!.length).toBe(9);
    expect(ellipsoidRadius(set.axes!, 0, [0, 1, 0])).toBeCloseTo(1, 6);
    expect(ellipsoidRadius(set.axes!, 0, [1, 0, 0])).toBeCloseTo(0.3 / 1.7, 6);
    expect(ellipsoidRadius(set.axes!, 0, [0, 0, 1])).toBeCloseTo(0.3 / 1.7, 6);
    // The semi-axes are orthogonal (the renderer inverts them so).
    const ax = set.axes!;
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) expect(ax[3 * i] * ax[3 * j] + ax[3 * i + 1] * ax[3 * j + 1] + ax[3 * i + 2] * ax[3 * j + 2]).toBeCloseTo(0, 9);
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
    expect(ellipsoidRadius(again.axes!, 0, [0, 1, 0])).toBeCloseTo(1, 6);
    // Turned by the frame: data axis y is RAS x here.
    const turned = computeGlyphs([0, 0, 0], d, 6, voxelToRas, options({ kind: "tensor", toData: [0, 1, 0, 1, 0, 0, 0, 0, 1] }));
    expect(ellipsoidRadius(turned.axes!, 0, [1, 0, 0])).toBeCloseTo(1, 6);
    expect(ellipsoidRadius(turned.axes!, 0, [0, 1, 0])).toBeCloseTo(0.3 / 1.7, 6);
    // A flat disc keeps a thickness; scaled to the largest in the set when not normalised.
    const two = Float32Array.from([1, 0, 0, 1, 0, 0, 0.5, 0, 0, 0.5, 0, 0.5]);
    const flat = computeGlyphs([0, 0, 0, 1, 0, 0], two, 6, voxelToRas, options({ kind: "tensor", normalise: "none" }));
    expect(ellipsoidRadius(flat.axes!, 0, [0, 0, 1])).toBeCloseTo(0.08, 6);
    expect(ellipsoidRadius(flat.axes!, 1, [1, 0, 0])).toBeCloseTo(0.5, 6);
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
    // Tensor order: the store's, else DIPY's (NIfTI's lower triangle) for a symmetric-matrix intent, else FSL's.
    expect(resolveTensorOrder({ tensorOrder: "auto" }, none)).toBe("fsl");
    expect(resolveTensorOrder({ tensorOrder: "auto" }, { metadata: { order: "mrtrix" } })).toBe("mrtrix");
    expect(resolveTensorOrder({ tensorOrder: "auto" }, { metadata: undefined, nifti: { intent: 1005 } })).toBe("dipy");
    expect(resolveTensorOrder({ tensorOrder: "fsl" }, { metadata: undefined, nifti: { intent: 1005 } })).toBe("fsl");
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

describe("ray-cast ODFs", () => {
  const IDENTITY4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it("keep each glyph within its bound, between the sphere's vertices too", () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const dirs = spiral(600);
    const fine = spiral(6000);
    for (const subdivisions of [2, 3]) {
      for (const basis of ["descoteaux07-legacy", "tournier07"] as const) {
        const voxels = 24;
        const values = new Float32Array(45 * voxels);
        for (let v = 0; v < voxels; ++v) {
          // One to three fibres, sharper lobes than the synthetic store's.
          const fibres = Array.from({ length: 1 + (v % 3) }, () => {
            const f = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
            const n = Math.hypot(f[0], f[1], f[2]);
            return f.map((x) => x / n);
          });
          const sampled: number[] = [];
          for (let i = 0; i < dirs.length; i += 3) sampled.push(Math.max(...fibres.map((f) => Math.exp(-40 * (1 - (dirs[i] * f[0] + dirs[i + 1] * f[1] + dirs[i + 2] * f[2]) ** 2)))));
          values.set(fitSh(basis, 8, dirs, sampled, 1e-4), 45 * v);
        }
        const indices = Array.from({ length: voxels }, (_, v) => [v, 0, 0]).flat();
        // A turned frame (30° about z, x flipped), so the turn into the data's frame counts too.
        const c = Math.cos(Math.PI / 6);
        const s = Math.sin(Math.PI / 6);
        const toData = [-c, s, 0, s, c, 0, 0, 0, 1];
        const set = computeGlyphs(indices, values, 45, IDENTITY4, options({ basis, subdivisions, toData }));
        expect(set.count).toBe(voxels);
        for (let g = 0; g < voxels; ++g) {
          let top = 0;
          for (let i = 0; i < fine.length; i += 3) top = Math.max(top, odfRadius(set, g, [fine[i], fine[i + 1], fine[i + 2]]));
          expect(top, `subdivisions ${subdivisions}, ${basis}, glyph ${g}`).toBeLessThanOrEqual(set.bounds![g]);
          // And the bound not much more than needed.
          expect(set.bounds![g]).toBeLessThan(1.25 * Math.max(top, 1));
        }
      }
    }
  });

  it("are min-max, max or not normalised as the sphere's values say", () => {
    const values = Float32Array.from(fibreOdf([[1, 0, 0]], "descoteaux07-legacy", 8));
    const minmax = computeGlyphs([0, 0, 0], values, 45, IDENTITY4, options());
    const max = computeGlyphs([0, 0, 0], values, 45, IDENTITY4, options({ normalise: "max" }));
    const none = computeGlyphs([0, 0, 0, 1, 0, 0], Float32Array.from([...values, ...values.map((v) => v / 2)]), 45, IDENTITY4, options({ normalise: "none" }));
    expect(odfRadius(minmax, 0, [1, 0, 0])).toBeCloseTo(1, 4);
    expect(odfRadius(max, 0, [1, 0, 0])).toBeCloseTo(1, 4);
    // Max keeps the ratio to the highest (negative values at 0).
    const shape = computeGlyphs([0, 0, 0], values, 45, IDENTITY4, options({ normalise: "none" }));
    expect(odfRadius(max, 0, [0.6, 0.8, 0])).toBeCloseTo(odfRadius(shape, 0, [0.6, 0.8, 0]) / odfRadius(shape, 0, [1, 0, 0]), 4);
    // Not normalised: the half-strength glyph half the size.
    expect(odfRadius(none, 1, [1, 0, 0])).toBeCloseTo(odfRadius(none, 0, [1, 0, 0]) / 2, 4);
  });
});
