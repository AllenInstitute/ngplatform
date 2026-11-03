import { describe, expect, it } from "vitest";
import type { LayerTransform } from "@ngplatform/sdk";
import { annotationToGlobal, distanceMm, type GlobalSpace, placement, toGlobal, toVoxel, unprojector, voxelVolume } from "../geometry.js";
import { measure, measureAll, sampleCount, samplePath, samplePoints, sectionAxis, spanned } from "../measure.js";
import { csv, physical } from "../ui.js";

/** Global x, y, z in mm, as the app's MNI examples have it. */
const MM: GlobalSpace = { names: ["x", "y", "z"], scales: [0.001, 0.001, 0.001], units: ["m", "m", "m"] };
/** Anisotropic nanometres, as MICrONS: 4 × 4 × 40 nm. */
const NM: GlobalSpace = { names: ["x", "y", "z"], scales: [4e-9, 4e-9, 4e-8], units: ["m", "m", "m"] };

const identity = (space: GlobalSpace) => annotationToGlobal(undefined, space, 3);

describe("measuring annotations", () => {
  it("measures lines and polylines in millimetres, whatever the dimensions' scales", () => {
    expect(measure({ type: "line", id: "a", pointA: [0, 0, 0], pointB: [3, 4, 0] }, "m", identity(MM), MM)?.value).toBeCloseTo(5);
    // 100 voxels of 4 nm along x and 1 section of 40 nm along z.
    expect(measure({ type: "line", id: "a", pointA: [0, 0, 0], pointB: [100, 0, 1] }, "m", identity(NM), NM)?.value).toBeCloseTo(Math.hypot(400e-6, 40e-6), 9);
    const poly = measure({ type: "polyline", id: "p", points: [[0, 0, 0], [0, 10, 0], [0, 10, 10]] }, "m", identity(MM), MM);
    expect(poly?.quantity).toBe("length");
    expect(poly?.value).toBeCloseTo(20);
  });

  it("gives a box's volume, or its area when it is flat", () => {
    const box = measure({ type: "axis_aligned_bounding_box", id: "b", pointA: [0, 0, 0], pointB: [2, 3, 4] }, "m", identity(MM), MM);
    expect(box?.quantity).toBe("volume");
    expect(box?.value).toBeCloseTo(24);
    expect(box?.sides).toEqual([2, 3, 4]);
    const flat = measure({ type: "axis_aligned_bounding_box", id: "b", pointA: [0, 0, 5], pointB: [2, 3, 5] }, "m", identity(MM), MM);
    expect(flat?.quantity).toBe("area");
    expect(flat?.value).toBeCloseTo(6);
    // As Neuroglancer draws a box in a 2-D view: one coordinate deep, so a rectangle.
    const drawn = measure({ type: "axis_aligned_bounding_box", id: "b", pointA: [18.3, -33, 9.999999], pointB: [-17.7, -63, 10.999999] }, "m", identity(MM), MM);
    expect(drawn?.quantity).toBe("area");
    expect(drawn?.value).toBeCloseTo(36 * 30);
    expect(sectionAxis([0, 0, 0], [1, 1, 1])).toBe(-1);
  });

  it("gives an ellipsoid's volume (4/3 π abc), or an ellipse's area", () => {
    const e = measure({ type: "ellipsoid", id: "e", center: [0, 0, 0], radii: [1, 2, 3] }, "m", identity(MM), MM);
    expect(e?.value).toBeCloseTo((4 / 3) * Math.PI * 6);
    const flat = measure({ type: "ellipsoid", id: "e", center: [0, 0, 0], radii: [1, 2, 0] }, "m", identity(MM), MM);
    expect(flat?.quantity).toBe("area");
    expect(flat?.value).toBeCloseTo(Math.PI * 2);
  });

  it("measures through the layer's transform: a layer scaled by 2 doubles lengths", () => {
    const t: LayerTransform = {
      rank: 3,
      input: { names: ["0", "1", "2"], scales: [0.001, 0.001, 0.001], units: ["m", "m", "m"] },
      output: { names: ["x", "y", "z"], scales: [0.001, 0.001, 0.001], units: ["m", "m", "m"] },
      matrix: Float64Array.from([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 0, 0, 1]),
      defaultMatrix: Float64Array.from([1]),
    };
    const g = annotationToGlobal(t, MM, 3);
    expect(g([1, 0, 0])).toEqual([12, 0, 0]);
    expect(measure({ type: "line", id: "a", pointA: [0, 0, 0], pointB: [1, 0, 0] }, "m", g, MM)?.value).toBeCloseTo(2);
    expect(measure({ type: "axis_aligned_bounding_box", id: "b", pointA: [0, 0, 0], pointB: [1, 1, 1] }, "m", g, MM)?.value).toBeCloseTo(8);
  });

  it("reads a source whose coordinates are in another scale than the scene's, as Neuroglancer draws it", () => {
    // Annotations in 1 µm coordinates, the scene in mm: the identity matrix is physical, so
    // a point at 1000 is 1 mm along; the translation is in the scene's units.
    const t: LayerTransform = {
      rank: 3,
      input: { names: ["x", "y", "z"], scales: [1e-6, 1e-6, 1e-6], units: ["m", "m", "m"] },
      output: { names: ["x", "y", "z"], scales: [0.001, 0.001, 0.001], units: ["m", "m", "m"] },
      matrix: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]),
      defaultMatrix: Float64Array.from([1]),
    };
    const g = annotationToGlobal(t, MM, 3);
    expect(g([1000, 2000, 0]).map((v) => +v.toFixed(9))).toEqual([6, 2, 0]);
  });

  it("lists every measurable annotation of the state's layers, points left out", () => {
    const all = measureAll(
      [
        { name: "m", annotations: [{ type: "point", id: "p", point: [0, 0, 0] }, { type: "line", id: "l", pointA: [0, 0, 0], pointB: [1, 0, 0], description: "a" }] },
        { name: "image" },
      ],
      () => identity(MM),
      MM,
    );
    expect(all.map((m) => [m.layer, m.id, m.description])).toEqual([["m", "l", "a"]]);
  });

  it("spans lengths, areas and volumes from edges", () => {
    expect(spanned([[1, 0, 0]])).toEqual({ quantity: "length", value: 1 });
    expect(spanned([[2, 0, 0], [0, 3, 0], [0, 0, 0]])).toEqual({ quantity: "area", value: 6 });
    expect(spanned([[1, 1, 0], [-1, 1, 0], [0, 0, 2]]).value).toBeCloseTo(4);
  });
});

describe("profiles", () => {
  it("samples a line evenly from end to end, with distances in mm", () => {
    const { positions, distances } = samplePoints([0, 0, 0], [10, 0, 0], 11, MM);
    expect(positions.length).toBe(11);
    expect(positions[5]).toEqual([5, 0, 0]);
    expect(distances[10]).toBeCloseTo(10);
  });

  it("samples a polyline evenly along its length, through its corners", () => {
    const { positions, distances } = samplePath([[0, 0, 0], [10, 0, 0], [10, 10, 0]], 5, MM);
    expect(distances).toEqual([0, 5, 10, 15, 20]);
    expect(positions[1]).toEqual([5, 0, 0]);
    expect(positions[2]).toEqual([10, 0, 0]);
    expect(positions[3]).toEqual([10, 5, 0]);
    expect(positions[4]).toEqual([10, 10, 0]);
  });

  it("takes about one sample a voxel", () => {
    expect(sampleCount(10, 0.5)).toBe(21);
    expect(sampleCount(1e6, 0.001, 4096)).toBe(4096);
    expect(sampleCount(0, 1)).toBe(2);
  });
});

describe("placing a grid", () => {
  // As SRB 2026a's layer reads: input z, y, x in 0.1 mm, output z, y, x in mm, translation in mm.
  const srb: LayerTransform = {
    rank: 3,
    input: { names: ["z", "y", "x"], scales: [1e-4, 1e-4, 1e-4], units: ["m", "m", "m"] },
    output: { names: ["z", "y", "x"], scales: [0.001, 0.001, 0.001], units: ["m", "m", "m"] },
    matrix: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -72.2, -134.2, -98.2, 1]),
    defaultMatrix: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -72.2, -134.2, -98.2, 1]),
  };
  // Its level 0 as the volume reader gives it: 0.1 mm voxels from (-98.2, -134.2, -72.2).
  const voxelToRas = Float64Array.from([0.1, 0, 0, -98.2, 0, 0.1, 0, -134.2, 0, 0, 0.1, -72.2, 0, 0, 0, 1]);

  it("takes voxels to global coordinates by name, though the layer's axes are z, y, x", () => {
    const p = placement(srb, voxelToRas, MM)!;
    expect(p.dims).toEqual([2, 1, 0]);
    const g = toGlobal(p, [10, 20, 30], [0, 0, 0]);
    expect(g[0]).toBeCloseTo(-97.2);
    expect(g[1]).toBeCloseTo(-132.2);
    expect(g[2]).toBeCloseTo(-69.2);
    const v = toVoxel(p, g);
    [10, 20, 30].forEach((x, k) => expect(v[k]).toBeCloseTo(x));
    expect(voxelVolume(p.voxelToMm)).toBeCloseTo(0.001);
  });

  it("follows a layer moved from its own place", () => {
    const moved = { ...srb, matrix: Float64Array.from(srb.matrix) };
    // 5 mm along z (the first output, z).
    moved.matrix[12] += 5;
    const p = placement(moved, voxelToRas, MM)!;
    const g = toGlobal(p, [0, 0, 0], [0, 0, 0]);
    expect(g[2]).toBeCloseTo(-72.2 + 5);
    expect(g[0]).toBeCloseTo(-98.2);
  });

  it("measures distances over the dimensions in metres only", () => {
    const space: GlobalSpace = { names: ["x", "y", "t"], scales: [0.001, 0.001, 1], units: ["m", "m", "s"] };
    expect(distanceMm([0, 0, 0], [3, 4, 100], space)).toBeCloseTo(5);
  });
});

describe("a 2-D view's pixels", () => {
  it("unprojects a pixel to the global position on the section", () => {
    // An xy view: 4 pixels a unit, centred at (100, 50), depth along z.
    const position = [10, 20, 30];
    const project = (g: ArrayLike<number>) => ({ x: 100 + 4 * (g[0] - 10), y: 50 + 4 * (g[1] - 20), depth: (g[2] - 30) / 2 });
    const u = unprojector(project, position)!;
    expect(u.dims).toEqual([0, 1, 2]);
    const g = u.at(140, 30);
    expect(g[0]).toBeCloseTo(20);
    expect(g[1]).toBeCloseTo(15);
    expect(g[2]).toBeCloseTo(30);
    expect(u.pixelsPerUnit[0]).toBeCloseTo(4);
    expect(u.depthPerUnit[2]).toBeCloseTo(0.5);
  });
});

describe("formatting", () => {
  it("writes quantities in a unit that suits them", () => {
    expect(physical(12.5)).toBe("12.5 mm");
    expect(physical(0.0042)).toBe("4.2 µm");
    expect(physical(0.5, 3)).toBe("0.5 mm³");
    expect(physical(2e-9, 3)).toBe("2 µm³");
    // A stroke on EM: 0.089 µm³, not 8.9e+7 nm³.
    expect(physical(8.9e-11, 3)).toBe("0.089 µm³");
    expect(physical(0.02, 2)).toBe("0.02 mm²");
  });

  it("quotes CSV fields that need it", () => {
    expect(csv([["a", "b,c", 'say "x"'], [1, NaN, 2.5]])).toBe('a,"b,c","say ""x"""\n1,,2.5\n');
  });
});
