import { describe, expect, it } from "vitest";
import type { BuiltChunk } from "../../luxar/chunk_build.js";
import { layerGeometry } from "../geometry/from_read.js";
import { CONE, SPHERE } from "../geometry/lbvh.js";
import { lineRadius, pointRadius } from "../geometry/primitives.js";
import type { GeometryRead } from "../points.js";

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
  kind, chunks, mm: [1, 1, 1], level: 0, count: chunks.reduce((n, c) => n + (kind === "lines" ? c.segmentCount : c.vertexCount), 0), lower: [0, 0, 0], upper: [8, 8, 8], perVertex: false, radii: false, ...extra,
});

describe("points and lines to trace", () => {
  it("makes points spheres, a quarter of their spacing in radius, times the size, each its object's colour", () => {
    const c = chunk([[0, 0, 0, 0], [4, 0, 0, 0], [0, 4, 0, 0], [4, 4, 4, 0]], [0, 0, 1, 1], [7, 9]);
    const colour = (id: bigint) => (id === 7n ? [1, 0, 0] : [0, 0, 1]) as [number, number, number];
    const g = layerGeometry(read("points", [c]), ID, undefined, 2, colour);
    expect(g.prims.objects.length).toBe(4);
    expect(Array.from(g.prims.kinds!)).toEqual([SPHERE, SPHERE, SPHERE, SPHERE]);
    expect(g.radius).toBeCloseTo(2 * pointRadius(4, [0, 0, 0], [8, 8, 8]), 9);
    expect(g.prims.prims[3]).toBeCloseTo(g.radius!, 6);
    expect(Array.from(g.prims.objects)).toEqual([0, 0, 1, 1]);
    expect(Array.from(g.colours!)).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it("leaves out the groups not shown, and colours the rest as the layer does", () => {
    const c = chunk([[0, 0, 0, 0], [1, 0, 0, 0], [2, 0, 0, 0]], [0, 1, 2], [3, 5, 3]);
    const look = { by: "group", group: { tier: "class", attribute: "class_index", colours: "palette", shown: [3] } } as never;
    const g = layerGeometry(read("points", [c], { perVertex: true }), ID, look, 1, () => undefined);
    expect(g.prims.objects.length).toBe(2);
    expect(g.objectCount).toBe(1);
  });

  it("makes lines tubes between their vertices: a sixth of a segment in radius, or the store's radii", () => {
    const c = chunk([[0, 0, 0, 0.5], [6, 0, 0, 0.25], [6, 6, 0, 0.5]], [0, 0, 0], [4], [[0, 1], [1, 2]]);
    const g = layerGeometry(read("lines", [c]), ID, undefined, 1, () => [0, 1, 0]);
    expect(Array.from(g.prims.kinds!)).toEqual([CONE, CONE]);
    expect(g.radius).toBeCloseTo(lineRadius([6, 6], Math.hypot(8, 8, 8)), 9);
    expect(Array.from(g.prims.prims.subarray(0, 8))).toEqual([0, 0, 0, g.prims.prims[3], 6, 0, 0, g.prims.prims[7]]);
    const r = layerGeometry(read("lines", [c], { radii: true }), ID, undefined, 2, () => [0, 1, 0]);
    expect([r.prims.prims[3], r.prims.prims[7]]).toEqual([1, 0.5]);
    expect(r.text).toContain("the store's radii");
  });
});
