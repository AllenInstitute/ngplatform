import { describe, expect, it } from "vitest";
import { buildChunk, TEXTURE_WIDTH } from "../chunk_build.js";
import { coverage, eyeOf, multiply } from "../view_math.js";

describe("a mesh chunk", () => {
  // Two triangles of a unit square in z = 0 (object 3), a degenerate face, and one reaching a vertex not here.
  const input = {
    numVertices: 4,
    numOwnVertices: 4,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    segmentIds: new Uint32Array([3, 0, 3, 0, 3, 0, 3, 0]),
    edges: new Uint32Array(0),
    attributes: [],
    faces: new Uint32Array([0, 1, 2, 0, 2, 3, 1, 1, 2, 0, 2, 9]),
  };

  it("keeps its triangles, with a normal per vertex, and draws no points", () => {
    const c = buildChunk(input, { kind: "none" });
    expect(c.triangleCount).toBe(2);
    expect(Array.from(c.triangles)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(c.pointCount).toBe(0);
    expect(c.segmentCount).toBe(0);
    expect(c.normals.length).toBe(TEXTURE_WIDTH * 4);
    for (let v = 0; v < 4; ++v) expect(Array.from(c.normals.slice(4 * v, 4 * v + 4))).toEqual([0, 0, 1, 0]);
    expect(c.area).toBeCloseTo(1);
    expect(Array.from(c.objectWeight)).toEqual([1]);
  });

  it("weighs normals by area, so a vertex between faces leans to the larger", () => {
    // A large face in z = 0 and a small one in x = 0, sharing the edge 0-1.
    const c = buildChunk(
      {
        numVertices: 4,
        numOwnVertices: 4,
        positions: new Float32Array([0, 0, 0, 0, 1, 0, 4, 0, 0, 0, 0, 0.1]),
        segmentIds: new Uint32Array(8),
        edges: new Uint32Array(0),
        attributes: [],
        faces: new Uint32Array([0, 2, 1, 0, 1, 3]),
      },
      { kind: "none" },
    );
    const n = c.normals.slice(0, 3);
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1);
    expect(Math.abs(n[2])).toBeGreaterThan(Math.abs(n[0]));
  });

  it("finds the eye that lights a mesh, for a perspective or an orthographic view", () => {
    const n = 0.1;
    const f = 100;
    // Perspective (column-major) after moving the eye at (1, 2, 3) to the origin.
    const p = [1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, (n + f) / (n - f), -1, 0, 0, (2 * n * f) / (n - f), 0];
    const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, -2, -3, 1];
    const eye = eyeOf(multiply(p, view));
    expect(eye[3]).toBe(1);
    expect(eye.slice(0, 3).map((v) => +v.toFixed(6))).toEqual([1, 2, 3]);
    // Orthographic, looking along z: a direction, along z.
    const o = eyeOf([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, -0.02, 0, 3, 4, 0.5, 1]);
    expect(o[3]).toBe(0);
    expect(Math.abs(o[2])).toBeGreaterThan(0);
    expect([o[0], o[1]]).toEqual([0, 0]);
  });

  it("counts a surface's area toward how much of a 3-D view is covered", () => {
    expect(coverage([{ length: 0, pointCount: 0, area: 10 }], 2, 1, 100)).toBe(0);
    expect(coverage([{ length: 0, pointCount: 0, area: 10 }], 2, 1, 100, 1, true)).toBeCloseTo(0.2);
  });

  it("is a line or point chunk when it has no faces", () => {
    const c = buildChunk({ ...input, faces: undefined }, { kind: "none" });
    expect(c.triangleCount).toBe(0);
    expect(c.normals.length).toBe(0);
    expect(c.pointCount).toBe(4);
  });
});
