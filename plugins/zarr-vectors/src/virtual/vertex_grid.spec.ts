/**
 * The vertex nearest a point (src/virtual/vectors/vertex_grid.ts), against
 * a search of every vertex: points in a box, on a sphere (a sheet, as a
 * cortex is), on a plane, outside the vertices' box, with a distance limit,
 * and a 160 000-vertex sphere looked up quickly.
 */
import { describe, expect, it } from "vitest";
import { medianEdgeLength, VertexGrid } from "../../../../src/virtual/vectors/vertex_grid.js";

/** A small seeded generator (mulberry32), so failures repeat. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bruteForce(vertices: Float32Array, p: number[], within = Infinity): { index: number; distance: number } | undefined {
  let best = -1;
  let bestSq = Infinity;
  for (let i = 0; i < vertices.length / 3; ++i) {
    const d = (vertices[3 * i] - p[0]) ** 2 + (vertices[3 * i + 1] - p[1]) ** 2 + (vertices[3 * i + 2] - p[2]) ** 2;
    if (d < bestSq) {
      bestSq = d;
      best = i;
    }
  }
  return best === -1 || Math.sqrt(bestSq) > within ? undefined : { index: best, distance: Math.sqrt(bestSq) };
}

function sphere(n: number, radius: number, rnd: () => number): Float32Array {
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; ++i) {
    // Fibonacci points, jittered a little.
    const z = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - z * z);
    const phi = i * Math.PI * (3 - Math.sqrt(5)) + 0.01 * rnd();
    out.set([radius * r * Math.cos(phi) + 3, radius * r * Math.sin(phi) - 20, radius * z + 7], 3 * i);
  }
  return out;
}

/** The grid's answer equals the full search's: the same distance (a tie may pick another vertex at it). */
function agrees(grid: VertexGrid, vertices: Float32Array, p: number[], within?: number): void {
  const got = grid.nearest(p, within);
  const want = bruteForce(vertices, p, within);
  if (want === undefined) {
    expect(got).toBeUndefined();
    return;
  }
  expect(got).toBeDefined();
  expect(got!.distance).toBeCloseTo(want.distance, 4);
  const v = got!.index;
  expect(Math.hypot(vertices[3 * v] - p[0], vertices[3 * v + 1] - p[1], vertices[3 * v + 2] - p[2])).toBeCloseTo(want.distance, 4);
}

describe("the vertex nearest a point", () => {
  it("equals a search of every vertex, for points in a box, inside and outside it", () => {
    const rnd = random(1);
    const vertices = Float32Array.from({ length: 3 * 3000 }, () => rnd() * 100 - 50);
    const grid = new VertexGrid(vertices);
    for (let q = 0; q < 500; ++q) agrees(grid, vertices, [rnd() * 300 - 150, rnd() * 300 - 150, rnd() * 300 - 150]);
    // A vertex itself is nearest, at 0.
    expect(grid.nearest(Array.from(vertices.subarray(30, 33)))).toEqual({ index: 10, distance: 0 });
  });

  it("equals it on a sphere (a sheet), with and without a distance limit", () => {
    const rnd = random(2);
    const vertices = sphere(5000, 60, rnd);
    const grid = new VertexGrid(vertices);
    for (let q = 0; q < 500; ++q) {
      // Points near the sphere (as the pointer on the surface is), and anywhere around it.
      const v = Math.floor(rnd() * 5000);
      const near = [0, 1, 2].map((k) => vertices[3 * v + k] + (rnd() - 0.5) * 6);
      agrees(grid, vertices, near);
      agrees(grid, vertices, near, 1.5);
      agrees(grid, vertices, [rnd() * 200 - 100, rnd() * 200 - 100, rnd() * 200 - 100], 4);
    }
    // The centre is 60 from every vertex: none within 59, one within 61.
    expect(grid.nearest([3, -20, 7], 59)).toBeUndefined();
    expect(grid.nearest([3, -20, 7], 61)?.distance).toBeCloseTo(60, 3);
  });

  it("works for flat, single and empty vertex sets, and refuses a point that is not one", () => {
    const rnd = random(3);
    const flat = Float32Array.from({ length: 3 * 400 }, (_, i) => (i % 3 === 2 ? 5 : rnd() * 40));
    const grid = new VertexGrid(flat);
    for (let q = 0; q < 200; ++q) agrees(grid, flat, [rnd() * 60 - 10, rnd() * 60 - 10, rnd() * 20 - 5]);
    const one = new VertexGrid(Float32Array.of(1, 2, 3));
    expect(one.nearest([1, 2, 7])).toEqual({ index: 0, distance: 4 });
    expect(one.nearest([1, 2, 7], 3)).toBeUndefined();
    expect(new VertexGrid(new Float32Array(0)).nearest([0, 0, 0])).toBeUndefined();
    expect(one.nearest([NaN, 0, 0])).toBeUndefined();
  });

  it("is quick on a 160 000-vertex surface", () => {
    const rnd = random(4);
    const vertices = sphere(160_000, 80, rnd);
    let t = performance.now();
    const grid = new VertexGrid(vertices);
    const build = performance.now() - t;
    const points = Array.from({ length: 2000 }, () => {
      const v = Math.floor(rnd() * 160_000);
      return [0, 1, 2].map((k) => vertices[3 * v + k] + (rnd() - 0.5) * 4);
    });
    t = performance.now();
    const found = points.map((p) => grid.nearest(p, 5));
    const each = (performance.now() - t) / points.length;
    // Checked against the full search for a few.
    for (let q = 0; q < 20; ++q) expect(found[q]!.distance).toBeCloseTo(bruteForce(vertices, points[q])!.distance, 4);
    expect(build).toBeLessThan(2000);
    expect(each).toBeLessThan(1);
  });
});

describe("a mesh's median edge length", () => {
  /** A square grid of n × n vertices `h` apart, each square two triangles: edges h (twice as many) and h√2. */
  function grid(n: number, h: number): { vertices: Float32Array; faces: Int32Array } {
    const vertices = new Float32Array(3 * n * n);
    for (let j = 0; j < n; ++j) for (let i = 0; i < n; ++i) vertices.set([i * h, j * h, 0], 3 * (j * n + i));
    const faces: number[] = [];
    for (let j = 0; j + 1 < n; ++j)
      for (let i = 0; i + 1 < n; ++i) {
        const a = j * n + i;
        faces.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
      }
    return { vertices, faces: Int32Array.from(faces) };
  }

  it("is the spacing of a regular mesh, however coarse, and the same from a sample of a large one", () => {
    for (const h of [0.8, 4.5]) {
      const { vertices, faces } = grid(30, h);
      expect(medianEdgeLength(vertices, faces)).toBeCloseTo(h, 5);
      // A sample of the triangles (every 17th) gives the same.
      expect(medianEdgeLength(vertices, faces, faces.length / 3 / 17)).toBeCloseTo(h, 5);
    }
    expect(medianEdgeLength(new Float32Array(9), new Int32Array(0))).toBe(0);
  });
});
