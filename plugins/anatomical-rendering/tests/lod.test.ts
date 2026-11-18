import { describe, expect, it } from "vitest";
import { lodChunks, nested } from "../geometry/lod.js";

// Three levels over a 64-unit cube: chunks of 16, 32 and 64 (finest first); 4096, 1024 and 256 vertices.
const levels = [16, 32, 64].map((s, i) => ({ chunkShape: [s, s, s], vertexCount: [4096, 1024, 256][i] }));
const lower = [0, 0, 0], upper = [64, 64, 64];
const parse = (k: string) => {
  const [l, c] = k.split("|");
  return { level: Number(l), c: c.split(".").map(Number) };
};
/** The volume each chosen chunk covers within the store, and whether any two overlap. */
function cover(keys: string[]): { volume: number; overlap: boolean } {
  const boxes = keys.map((k) => {
    const { level, c } = parse(k);
    const s = levels[level].chunkShape;
    return c.map((v, a) => [Math.max(v * s[a], lower[a]), Math.min((v + 1) * s[a], upper[a])]);
  });
  let overlap = false;
  for (let i = 0; i < boxes.length; ++i)
    for (let j = i + 1; j < boxes.length; ++j)
      if (boxes[i].every(([a0, a1], a) => Math.min(a1, boxes[j][a][1]) - Math.max(a0, boxes[j][a][0]) > 1e-9)) overlap = true;
  return { volume: boxes.reduce((v, b) => v + b.reduce((p, [a0, a1]) => p * (a1 - a0), 1), 0), overlap };
}

describe("detail by distance", () => {
  it("covers the store once, finer near the eye, within the budget", () => {
    const keys = lodChunks(levels, lower, upper, [2, 2, 2], 1500)!;
    const { volume, overlap } = cover(keys);
    expect(volume).toBeCloseTo(64 ** 3, 6);
    expect(overlap).toBe(false);
    // The chunk at the eye at the finest level; the far corner coarser.
    const at = (p: number[]) => keys.map(parse).find(({ level, c }) => c.every((v, a) => p[a] >= v * levels[level].chunkShape[a] && p[a] < (v + 1) * levels[level].chunkShape[a]))!.level;
    expect(at([2, 2, 2])).toBe(0);
    expect(at([60, 60, 60])).toBeGreaterThan(0);
    const per = [64, 128, 256];
    expect(keys.map(parse).reduce((n, { level }) => n + per[level], 0)).toBeLessThanOrEqual(1500);
  });

  it("is the coarsest level alone within a small budget, and the finest within a large one", () => {
    expect(lodChunks(levels, lower, upper, [2, 2, 2], 256)).toEqual(["2|0.0.0"]);
    expect(lodChunks(levels, lower, upper, [2, 2, 2], 1e9)!.every((k) => k.startsWith("0|"))).toBe(true);
  });

  it("covers the store where the levels do not nest, each chunk once", () => {
    const odd = [{ chunkShape: [16, 16, 16], vertexCount: 4096 }, { chunkShape: [24, 24, 24], vertexCount: 1000 }];
    expect(nested(levels)).toBe(true);
    expect(nested(odd)).toBe(false);
    const keys = lodChunks(odd, lower, upper, [2, 2, 2], 1600)!;
    expect(new Set(keys).size).toBe(keys.length);
    // Every point of the store in some chunk chosen; near the eye at the finer level.
    const chosen = keys.map(parse);
    const within = (p: number[]) => chosen.filter(({ level, c }) => c.every((v, a) => p[a] >= v * odd[level].chunkShape[a] && p[a] < (v + 1) * odd[level].chunkShape[a]));
    for (let x = 0.5; x < 64; x += 3) for (let y = 0.5; y < 64; y += 3) for (let z = 0.5; z < 64; z += 3) expect(within([x, y, z]).length).toBeGreaterThan(0);
    expect(within([2, 2, 2]).some(({ level }) => level === 0)).toBe(true);
    expect(within([62, 62, 62]).every(({ level }) => level === 1)).toBe(true);
  });
});
