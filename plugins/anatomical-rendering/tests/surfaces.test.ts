import { describe, expect, it } from "vitest";
import type { BuiltChunk } from "../../luxar/chunk_build.js";
import { geoData, geoLayout } from "../geometry/live_geometry.js";
import { type Bvh, buildLbvh, CONE, primHit, SPHERE, TRIANGLE } from "../geometry/lbvh.js";
import { expandPrims, meshPrimitives, NO_NORMAL, orientOutward, packNormal, type Primitives, unpackNormal } from "../geometry/primitives.js";
import { buildBlock, packSurfaces, traceSurfaces } from "../geometry/surfaces.js";
import { collapse, LEAF, WIDE, wideChildren } from "../geometry/wide.js";

/** One chunk of two triangles (a unit square at z = 0), the first object 5, the second 9 (64-bit ids as two words). */
function square(normals = true): BuiltChunk {
  const vertices = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 2, 1, 0, 0]);
  return {
    vertices, vertexCount: 6, normals: normals ? new Float32Array(Array.from({ length: 6 }, () => [0, 0, 1, 0]).flat()) : new Float32Array(),
    triangles: new Uint32Array([0, 1, 2, 3, 4, 5]), triangleCount: 2,
    slots: new Uint32Array([0, 0, 0, 1, 1, 1]), objectIds: new Uint32Array([5, 0, 9, 0]),
  } as unknown as BuiltChunk;
}

/** A seeded random number in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A scene of triangles, spheres and round cones, `n` of them, in a box of 2 about the origin; objects 0..3. */
function scene(n: number, seed = 1): Primitives {
  const r = random(seed);
  const vertices: number[] = [], index: number[] = [], objects: number[] = [], kinds: number[] = [];
  const vert = (x: number, y: number, z: number, w: number) => {
    vertices.push(x, y, z, w);
    return vertices.length / 4 - 1;
  };
  for (let i = 0; i < n; ++i) {
    const c = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    const k = i % 3 === 0 ? TRIANGLE : i % 3 === 1 ? SPHERE : CONE;
    if (k === TRIANGLE) index.push(...[0, 1, 2].map(() => vert(c[0] + r() * 0.2, c[1] + r() * 0.2, c[2] + r() * 0.2, 0)));
    else if (k === SPHERE) {
      const v = vert(c[0], c[1], c[2], 0.01 + r() * 0.05);
      index.push(v, v, v);
    } else {
      const a = vert(c[0], c[1], c[2], 0.01 + r() * 0.03), b = vert(c[0] + r() * 0.3, c[1] + r() * 0.3, c[2], 0.01 + r() * 0.03);
      index.push(a, b, b);
    }
    objects.push(i % 4);
    kinds.push(k);
  }
  return { vertices: new Float32Array(vertices), index: new Uint32Array(index), objects: new Int32Array(objects), kinds: new Int32Array(kinds) };
}

/** The nearest primitive of `p` the ray meets, by testing them all. */
function brute(p: Primitives, o: number[], d: number[]): number {
  const b = { prims: expandPrims(p), kinds: p.kinds } as unknown as Bvh;
  let best = 1e30;
  for (let i = 0; i < p.objects.length; ++i) {
    const t = primHit(b, i, o as [number, number, number], d as [number, number, number]);
    if (t > 0 && t < best) best = t;
  }
  return best < 1e30 ? best : -1;
}

/** Rays from outside the scene's box toward points in it. */
function rays(count: number, seed = 7): { o: number[]; d: number[] }[] {
  const r = random(seed);
  return Array.from({ length: count }, () => {
    const o = [r() * 6 - 3, r() * 6 - 3, -4];
    const at = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    const d = at.map((x, a) => x - o[a]);
    const l = Math.hypot(...d);
    return { o, d: d.map((x) => x / l) };
  });
}

/** Part of a scene: primitives `from`..`to`, their vertices renumbered. */
function slice(p: Primitives, from: number, to: number): Primitives {
  const used = new Map<number, number>();
  const vertices: number[] = [];
  const index = Array.from(p.index.subarray(3 * from, 3 * to), (v) => {
    if (!used.has(v)) {
      used.set(v, used.size);
      vertices.push(...p.vertices.subarray(4 * v, 4 * v + 4));
    }
    return used.get(v)!;
  });
  return { vertices: new Float32Array(vertices), index: new Uint32Array(index), objects: p.objects.slice(from, to), kinds: p.kinds.slice(from, to) };
}

describe("surfaces from a mesh", () => {
  it("packs normals as the shader unpacks them", () => {
    for (const n of [[0, 0, 1], [0, 0, -1], [1, 2, -3], [-0.3, 0.9, 0.1]]) {
      const l = Math.hypot(...n);
      const got = unpackNormal(packNormal(n[0], n[1], n[2]));
      got.forEach((x, i) => expect(x).toBeCloseTo(n[i] / l, 3));
    }
  });

  it("places a mesh's vertices in millimetres, each triangle its corners, its object, and normals turned as the space is", () => {
    const ids: bigint[] = [];
    // Store units of 2 µm, mirrored in z: a normal's z turns over.
    const toMm = [0.002, 0, 0, 1, 0, 0.002, 0, 0, 0, 0, -0.002, 0, 0, 0, 0, 1];
    const p = meshPrimitives([square()], toMm, ids);
    expect(ids).toEqual([5n, 9n]);
    expect(Array.from(p.objects)).toEqual([0, 1]);
    expect(Array.from(p.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(p.vertices.subarray(0, 3))).toEqual([1, 0, 0]);
    expect(p.vertices[4]).toBeCloseTo(1.002, 6);
    const bits = new Uint32Array(p.vertices.buffer);
    expect(unpackNormal(bits[3])[2]).toBeCloseTo(-1, 3);
    // No normals: marked, so the shader takes the face's.
    expect(new Uint32Array(meshPrimitives([square(false)], toMm, []).vertices.buffer)[3]).toBe(NO_NORMAL);
  });
});

describe("the wide BVH", () => {
  it("stores each child's box around its true box, in float32 as a GPU decodes it", () => {
    const p = scene(500);
    const bvh = buildLbvh(expandPrims(p), p.objects, p.kinds);
    const n = bvh.n;
    const nodes = collapse({ root: 0, isLeaf: (k) => k >= n - 1, left: (k) => bvh.kids[2 * k], right: (k) => bvh.kids[2 * k + 1], box: (k) => bvh.nodes.subarray(6 * k, 6 * k + 6), ref: (k) => (LEAF | (k - (n - 1))) >>> 0 });
    // About a third of the binary tree's nodes, each with up to four children; every primitive once.
    const count = nodes.length / WIDE;
    expect(count).toBeLessThan((2 * n) / 3);
    const seen = new Set<number>();
    for (let w = 0; w < count; ++w) {
      for (const c of wideChildren(nodes, w)) {
        if (!(c.ref & LEAF)) continue;
        const i = (c.ref & ~LEAF) >>> 0;
        seen.add(i);
        const truth = bvh.nodes.subarray(6 * (n - 1 + i), 6 * (n - 1 + i) + 6);
        for (let a = 0; a < 3; ++a) {
          expect(c.box[a]).toBeLessThanOrEqual(truth[a]);
          expect(c.box[3 + a]).toBeGreaterThanOrEqual(truth[3 + a]);
        }
      }
    }
    expect(seen.size).toBe(n);
  });

  it("finds the nearest primitive, as testing every one does: one block, and several under a top tree", () => {
    const p = scene(900);
    const one = packSurfaces([{ block: buildBlock(scene(900), 4), objectBase: 0 }], 4);
    // Three blocks, the second and third's objects after the first's.
    const parts = [slice(p, 0, 300), slice(p, 300, 600), slice(p, 600, 900)];
    const several = packSurfaces(parts.map((q, i) => ({ block: buildBlock(q, 4), objectBase: 4 * i })), 12);
    expect(several.root).toBeGreaterThan(0);
    let met = 0;
    for (const { o, d } of rays(400)) {
      const want = brute(p, o, d);
      if (want > 0) ++met;
      for (const s of [one, several]) {
        const got = traceSurfaces(s, o, d);
        expect(got.t > 0).toBe(want > 0);
        if (want > 0) expect(got.t).toBeCloseTo(want, 4);
      }
    }
    expect(met).toBeGreaterThan(50);
    // A primitive's object, moved past the blocks before it.
    expect(new Set(Array.from({ length: several.n }, (_, i) => several.prims[4 * i + 3] & 0x3fffffff)).size).toBe(12);
  });

  it("lays the data out in rows: vertices, primitives, nodes, then objects", () => {
    const ids: bigint[] = [];
    const p = meshPrimitives([square()], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], ids);
    const s = packSurfaces([{ block: buildBlock(p, ids.length), objectBase: 0 }], ids.length);
    const width = 8;
    const { primAt, nodeAt, objAt, rows } = geoLayout(s, width);
    expect([primAt, nodeAt, objAt, rows]).toEqual([8, 16, 24, 4]);
    const data = geoData(s, width);
    // The root: two children, both primitives.
    expect(data[4 * nodeAt + 3] >>> 24).toBe(2);
    expect((data[4 * (nodeAt + 3)] & LEAF) >>> 0).toBe(LEAF);
    // Each primitive's kind (triangles: 0) and object.
    expect(data[4 * primAt + 3] >>> 30).toBe(TRIANGLE);
  });
});

describe("meshes wound outward", () => {
  // A tetrahedron about the origin, each face wound outward; and the same wound inward (each face turned over).
  const vertices = new Float32Array([1, 1, 1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1, 1, 0]);
  const outward = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];
  const inward = outward.map((_, i) => outward[i - (i % 3) + [0, 2, 1][i % 3]]);
  const volume = (index: Uint32Array, from: number) => {
    let v = 0;
    for (let k = from; k < from + 4; ++k) {
      const [a, b, c] = [0, 1, 2].map((j) => Array.from(vertices.subarray(4 * index[3 * k + j], 4 * index[3 * k + j] + 3)));
      v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    return v;
  };

  it("turns over an object wound inward, and leaves one wound outward", () => {
    const index = new Uint32Array([...outward, ...inward]);
    expect(volume(index, 0)).toBeGreaterThan(0);
    expect(volume(index, 4)).toBeLessThan(0);
    orientOutward(vertices, index, new Int32Array([0, 0, 0, 0, 1, 1, 1, 1]), 8);
    expect(Array.from(index.subarray(0, 12))).toEqual(outward);
    expect(volume(index, 4)).toBeGreaterThan(0);
  });
});
