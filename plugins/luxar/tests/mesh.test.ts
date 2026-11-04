import { describe, expect, it } from "vitest";
import { buildChunk, TEXTURE_WIDTH } from "../chunk_build.js";
import { coverage, eyeOf, glowFalloff, invert4, layeredLight, multiply } from "../view_math.js";

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

describe("a mesh's glow on a folded surface", () => {
  it("fades behind the nearest surface, so many folds do not add up to white", () => {
    // A ray through a cortex: 20 layers 1.5 mm apart.
    const folds = Array.from({ length: 20 }, (_, k) => 40 + 1.5 * k);
    // Without the fade every layer adds its light (as lines do).
    expect(layeredLight(folds, 0)).toBe(20);
    // With it (4.4 mm: 2 % of a 220 mm hemisphere), the nearest counts 1 and the rest little.
    const falloff = glowFalloff([0, 0, 0], [70, 180, 110], 0.02);
    expect(falloff).toBeCloseTo(0.02 * Math.hypot(70, 180, 110), 9);
    const light = layeredLight(folds, falloff);
    expect(light).toBeGreaterThan(1);
    expect(light).toBeLessThan(1 / (1 - Math.exp(-1.5 / falloff)) + 1e-9);
    expect(light).toBeLessThan(4);
    // A single shell (front and back 60 mm apart) is its front.
    expect(layeredLight([10, 70], falloff)).toBeCloseTo(1, 4);
  });

  it("finds the store point under a pixel from its depth (the inverse of a perspective projection)", () => {
    // A perspective projection (near 1, far 100, 90°) after a turn and a shift.
    const [n, far] = [1, 100];
    const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, (far + n) / (n - far), -1, 0, 0, (2 * far * n) / (n - far), 0];
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const view = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 2, -1, -30, 1];
    const m = multiply(projection, view);
    const inv = invert4(m)!;
    const p = [3, 4, 5, 1];
    const clip = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);
    const ndc = clip.map((v) => v / clip[3]);
    const back = [0, 1, 2, 3].map((r) => inv[r] * ndc[0] + inv[4 + r] * ndc[1] + inv[8 + r] * ndc[2] + inv[12 + r]);
    for (let k = 0; k < 3; ++k) expect(back[k] / back[3]).toBeCloseTo(p[k], 9);
    expect(invert4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])).toBeUndefined();
  });
});
