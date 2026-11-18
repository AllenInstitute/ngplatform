import { describe, expect, it } from "vitest";
import type { BuiltChunk } from "../../luxar/chunk_build.js";
import { layerGeometry } from "../geometry/from_read.js";
import { CONE, SPHERE } from "../geometry/lbvh.js";
import { expandPrims, lineRadius, pointRadius } from "../geometry/primitives.js";
import type { GeometryRead } from "../points.js";
import { readSaved } from "../plugin.js";

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A chunk of vertices (x, y, z, value), their objects' slots, the objects (ids), and segments (start, end pairs). */
function chunk(vertices: number[][], slots: number[], ids: number[], segments: [number, number][] = []): BuiltChunk {
  return {
    vertices: new Float32Array(vertices.flat()), vertexCount: vertices.length, pointCount: segments.length ? 0 : vertices.length,
    slots: new Uint32Array(slots), objectIds: new Uint32Array(ids.flatMap((id) => [id, 0])),
    segments: new Uint32Array(segments.flatMap(([a, b]) => [a, a, b, b])), segmentCount: segments.length, triangles: new Uint32Array(), triangleCount: 0, normals: new Float32Array(),
  } as unknown as BuiltChunk;
}

const read = (kind: GeometryRead["kind"], chunks: BuiltChunk[], extra: Partial<GeometryRead> = {}): GeometryRead => ({
  kind, chunks, mm: [1, 1, 1], level: 0, count: chunks.reduce((n, c) => n + (kind === "lines" ? c.segmentCount : c.vertexCount), 0), lower: [0, 0, 0], upper: [8, 8, 8], perVertex: false, radii: false, levels: [{ vertexCount: 4, chunkShape: [8, 8, 8] }], bounds: { lower: [0, 0, 0], upper: [8, 8, 8] }, ...extra,
});

describe("points and lines to trace", () => {
  it("makes points spheres, a quarter of their spacing in radius, times the size, each its object's colour", () => {
    const c = chunk([[0, 0, 0, 0], [4, 0, 0, 0], [0, 4, 0, 0], [4, 4, 4, 0]], [0, 0, 1, 1], [7, 9]);
    const colour = (id: bigint) => (id === 7n ? [1, 0, 0] : [0, 0, 1]) as [number, number, number];
    const g = layerGeometry(read("points", [c]), ID, undefined, 2, colour);
    expect(g.prims.objects.length).toBe(4);
    expect(Array.from(g.prims.kinds!)).toEqual([SPHERE, SPHERE, SPHERE, SPHERE]);
    expect(g.radius).toBeCloseTo(2 * pointRadius(4, [0, 0, 0], [8, 8, 8]), 9);
    expect(expandPrims(g.prims)[3]).toBeCloseTo(g.radius!, 6);
    expect(Array.from(g.prims.objects)).toEqual([0, 0, 1, 1]);
    expect(Array.from(g.colours!)).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it("keeps every group as an object, shown or not, so the look of a frame chooses and colours them", () => {
    const c = chunk([[0, 0, 0, 0], [1, 0, 0, 0], [2, 0, 0, 0]], [0, 1, 2], [3, 5, 3]);
    const look = { by: "group", group: { tier: "class", attribute: "class_index", colours: "palette", shown: [3] } } as never;
    const g = layerGeometry(read("points", [c], { perVertex: true }), ID, look, 1, () => undefined);
    expect(g.prims.objects.length).toBe(3);
    expect(g.objectCount).toBe(2);
    expect(g.groups).toEqual([{ group: 3 }, { group: 5 }]);
    expect(Array.from(g.prims.objects)).toEqual([0, 1, 0]);
  });

  it("makes lines tubes between their vertices: a sixth of a segment in radius, or the store's radii", () => {
    const c = chunk([[0, 0, 0, 0.5], [6, 0, 0, 0.25], [6, 6, 0, 0.5]], [0, 0, 0], [4], [[0, 1], [1, 2]]);
    const g = layerGeometry(read("lines", [c]), ID, undefined, 1, () => [0, 1, 0]);
    expect(Array.from(g.prims.kinds!)).toEqual([CONE, CONE]);
    expect(g.radius).toBeCloseTo(lineRadius([6, 6], Math.hypot(8, 8, 8)), 9);
    const e = expandPrims(g.prims);
    expect(Array.from(e.subarray(0, 8))).toEqual([0, 0, 0, e[3], 6, 0, 0, e[7]]);
    // Indexed: the two tubes share the corner vertex.
    expect(Array.from(g.prims.index)).toEqual([0, 1, 1, 1, 2, 2]);
    const r = layerGeometry(read("lines", [c], { radii: true }), ID, undefined, 2, () => [0, 1, 0]);
    const er = expandPrims(r.prims);
    expect([er[3], er[7]]).toEqual([1, 0.5]);
    expect(r.text).toContain("the store's radii");
  });
});

describe("a geometry layer's settings, as saved", () => {
  it("keeps a surface material's fields in range and the geometry budget within what can be traced", () => {
    const s = readSaved({ looks: { cells: { surface: { opacity: 1.5, roughness: 0, specular: 0.3, emission: "bright" } } }, geometryBudget: 50e6 });
    expect(s.looks.cells.surface).toEqual({ opacity: 1, roughness: 0.02, specular: 0.3 });
    expect(s.geometryBudget).toBe(8e6);
    expect(readSaved({}).geometryBudget).toBe(2e6);
  });
});
