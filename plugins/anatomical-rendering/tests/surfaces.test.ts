import { describe, expect, it } from "vitest";
import type { BuiltChunk } from "../../luxar/chunk_build.js";
import { geoData, geoLayout } from "../geometry/live_geometry.js";
import { joinPrimitives, meshPrimitives, packNormal, unpackNormal } from "../geometry/primitives.js";
import { buildSurfaces } from "../geometry/surfaces.js";

/** One chunk of two triangles (a unit square at z = 0), the first object 5, the second 9 (64-bit ids as two words). */
function square(): BuiltChunk {
  const vertices = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 2, 1, 0, 0]);
  const normals = new Float32Array(Array.from({ length: 6 }, () => [0, 0, 1, 0]).flat());
  return {
    vertices, vertexCount: 6, normals, triangles: new Uint32Array([0, 1, 2, 3, 4, 5]), triangleCount: 2,
    slots: new Uint32Array([0, 0, 0, 1, 1, 1]), objectIds: new Uint32Array([5, 0, 9, 0]),
  } as unknown as BuiltChunk;
}

describe("surfaces from a mesh", () => {
  it("packs normals as the shader unpacks them", () => {
    for (const n of [[0, 0, 1], [0, 0, -1], [1, 2, -3], [-0.3, 0.9, 0.1]]) {
      const l = Math.hypot(...n);
      const got = unpackNormal(packNormal(n[0], n[1], n[2]));
      got.forEach((x, i) => expect(x).toBeCloseTo(n[i] / l, 3));
    }
  });

  it("places triangles in millimetres, with their objects and their normals turned as the space is", () => {
    const ids: bigint[] = [];
    // Store units of 2 µm, mirrored in z: a normal's z turns over.
    const toMm = [0.002, 0, 0, 1, 0, 0.002, 0, 0, 0, 0, -0.002, 0, 0, 0, 0, 1];
    const p = meshPrimitives([square()], toMm, ids);
    expect(ids).toEqual([5n, 9n]);
    expect(Array.from(p.objects)).toEqual([0, 1]);
    expect(Array.from(p.prims.subarray(0, 3))).toEqual([1, 0, 0]);
    expect(p.prims[3]).toBeCloseTo(1.002, 6);
    expect(unpackNormal(p.normals[0])[2]).toBeCloseTo(-1, 3);
    // Two layers as one: the second's objects after the first's.
    const joined = joinPrimitives([{ ...p, objectCount: 2 }, { ...p, objectCount: 2 }]);
    expect(Array.from(joined.objects)).toEqual([0, 1, 2, 3]);
    expect(joined.offsets).toEqual([0, 2]);
  });

  it("lays the BVH out in rows: primitives, nodes (children as indices), then objects", () => {
    const ids: bigint[] = [];
    const p = meshPrimitives([square()], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], ids);
    const s = buildSurfaces(p, ids.length);
    const width = 8;
    const { nodeAt, objAt, rows } = geoLayout(s, width);
    expect(nodeAt).toBe(8);
    expect(objAt).toBe(16);
    expect(rows).toBe(3);
    const data = geoData(s, width);
    // The root's children, and a leaf's none.
    expect([data[4 * nodeAt + 3], data[4 * nodeAt + 7]]).toEqual(Array.from(s.bvh.kids.subarray(0, 2)));
    expect(data[4 * (nodeAt + 2 * 1) + 3]).toBe(-1);
    // Each primitive's kind and object after its 9 floats.
    expect([data[9], data[10]]).toEqual([0, s.bvh.objects[0]]);
  });
});
