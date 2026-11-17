import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildLbvh, CONE, SPHERE, traceBvh, TRIANGLE } from "../geometry/lbvh.js";

// The render computer's build of the same primitives (CUDA), written by runner/tests/make_geometry_vectors.py.
const vectors = JSON.parse(readFileSync(new URL("../../../runner/tests/geometry_vectors.json", import.meta.url), "utf8")) as {
  input: { prims: number[]; kinds: number[]; objects: number[]; origins: number[]; directions: number[] };
  built: { prims: number[]; kinds: number[]; objects: number[]; nodes: number[]; kids: number[]; t: number[]; prim: number[] };
};

describe("the linear BVH, as the render computer builds it", () => {
  const input = vectors.input;
  const bvh = buildLbvh(new Float32Array(input.prims), new Int32Array(input.objects), new Int32Array(input.kinds));

  it("sorts the primitives and builds the same tree as CUDA, to the bit", () => {
    const want = vectors.built;
    expect(Array.from(bvh.kinds)).toEqual(want.kinds);
    expect(Array.from(bvh.objects)).toEqual(want.objects);
    expect(Array.from(bvh.prims)).toEqual(Array.from(new Float32Array(want.prims)));
    expect(Array.from(bvh.kids.subarray(0, 2 * (bvh.n - 1)))).toEqual(want.kids);
    expect(Array.from(bvh.nodes)).toEqual(Array.from(new Float32Array(want.nodes)));
    expect(new Set(bvh.kinds)).toEqual(new Set([TRIANGLE, CONE, SPHERE]));
  });

  it("finds each ray's nearest hit as CUDA does", () => {
    const { t, prim } = vectors.built;
    let hits = 0;
    for (let i = 0; i < t.length; ++i) {
      const o = input.origins.slice(3 * i, 3 * i + 3) as [number, number, number];
      const d = input.directions.slice(3 * i, 3 * i + 3) as [number, number, number];
      const got = traceBvh(bvh, o, d);
      if (t[i] < 0) {
        expect(got.t).toBe(-1);
        continue;
      }
      ++hits;
      expect(got.prim).toBe(prim[i]);
      // CUDA in float32, this in float64: a round cone's formula loses a few digits.
      expect(Math.abs(got.t - t[i])).toBeLessThan(3e-4 * Math.max(1, t[i]));
    }
    expect(hits).toBeGreaterThan(30);
  });

  it("holds one primitive, and none", () => {
    const one = buildLbvh(new Float32Array([0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).subarray(0, 9), undefined, new Int32Array([SPHERE]));
    expect(one.n).toBe(1);
    expect(traceBvh(one, [-2, 0, 0], [1, 0, 0]).t).toBeCloseTo(1.5, 6);
    expect(traceBvh(buildLbvh(new Float32Array(0)), [0, 0, 0], [1, 0, 0]).t).toBe(-1);
  });
});
