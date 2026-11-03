/** Mask regions: tracks through a volume's chosen voxels, sampled at most half a voxel apart along each segment. */
import { describe, expect, it } from "vitest";
import { compactChunk, IdSet, maskBits, maskBounds, testChunkMask } from "../roi.js";

function tracks(lines: [number[], number[]][]) {
  const positions = new Float32Array(lines.flatMap(([a, b]) => [...a, ...b]));
  const ids = new Uint32Array(lines.flatMap((_, i) => [i + 1, 0, i + 1, 0]));
  const edges = new Uint32Array(lines.flatMap((_, i) => [2 * i, 2 * i + 1]));
  return compactChunk(positions, ids, edges);
}

// A 10³ volume of 2 mm voxels, voxel (0, 0, 0) centred at store (-9, -9, -9): store = 2 · voxel - 9.
const storeToVoxel = Float64Array.from([0.5, 0, 0, 4.5, 0, 0.5, 0, 4.5, 0, 0, 0.5, 4.5, 0, 0, 0, 1]);
const size: [number, number, number] = [10, 10, 10];
const values = new Float32Array(1000);
// One voxel (5, 5, 5) at 7, and (2, 2, 2) labelled 3: centred at store (1, 1, 1) and (-5, -5, -5).
values[5 + 10 * (5 + 10 * 5)] = 7;
values[2 + 10 * (2 + 10 * 2)] = 3;

const hits = (mask: ReturnType<typeof maskBits>, chunk: ReturnType<typeof tracks>) => {
  const set = new IdSet();
  testChunkMask(chunk, mask, set);
  return [...set.toArray()].map(Number).sort((a, b) => a - b);
};

describe("mask regions", () => {
  const chunk = tracks([
    [[-20, 1, 1], [20, 1, 1]], // 1: a long segment straight through voxel (5, 5, 5)
    [[-20, 2.9, 1], [20, 2.9, 1]], // 2: just past its edge (y = 2 is the boundary): misses
    [[-5, -5, -20], [-5, -5, 20]], // 3: through voxel (2, 2, 2)
    [[1, 1, 1], [1, 1, 1]], // 4: a point inside voxel (5, 5, 5)... as a segment of length 0
  ]);

  it("keeps the tracks through the chosen voxels, however long their segments", () => {
    expect(hits(maskBits(values, size, {}, storeToVoxel), chunk)).toEqual([1, 3, 4]);
    expect(hits(maskBits(values, size, { threshold: 5 }, storeToVoxel), chunk)).toEqual([1, 4]);
    expect(hits(maskBits(values, size, { label: 3 }, storeToVoxel), chunk)).toEqual([3]);
  });

  it("bounds the set voxels in store coordinates, and an empty mask has none", () => {
    const { lo, hi } = maskBounds(maskBits(values, size, { threshold: 5 }, storeToVoxel));
    expect(lo).toEqual([0, 0, 0]);
    expect(hi).toEqual([2, 2, 2]);
    expect(maskBits(values, size, { threshold: 100 }, storeToVoxel).hi).toEqual([0, 0, 0]);
  });
});
