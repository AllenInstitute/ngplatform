/** Disk regions (TrackVis's): a track must cross the disk's plane within its radius, and within the angle limit of its normal. */
import { describe, expect, it } from "vitest";
import { compactChunk, IdSet, type RoiGeometry, roiKey, testChunk } from "../roi.js";

/** Straight two-point tracks, one object each (ids 1, 2, …). */
function tracks(lines: [number[], number[]][]) {
  const positions = new Float32Array(lines.flatMap(([a, b]) => [...a, ...b]));
  const ids = new Uint32Array(lines.flatMap((_, i) => [i + 1, 0, i + 1, 0]));
  const edges = new Uint32Array(lines.flatMap((_, i) => [2 * i, 2 * i + 1]));
  return compactChunk(positions, ids, edges);
}

const hit = (chunk: ReturnType<typeof tracks>, roi: RoiGeometry) => {
  const set = new IdSet();
  testChunk(chunk, roi, set);
  return [...set.toArray()].map(Number).sort((a, b) => a - b);
};

const disk = (extra: Partial<RoiGeometry> = {}): RoiGeometry => ({ shape: "disk", center: [0, 0, 0], radius: 5, size: [0, 0, 0], axis: 2, ...extra });

describe("disk regions", () => {
  const chunk = tracks([
    [[0, 0, -3], [0, 0, 3]], // 1: straight through the centre
    [[4, 0, -1], [4, 0, 1]], // 2: through, near the rim
    [[6, 0, -1], [6, 0, 1]], // 3: through the plane, outside the radius
    [[0, 0, 1], [0, 0, 4]], // 4: above it, not crossing
    [[-3, 0, -1], [3, 0, 1]], // 5: crossing at a slant (about 72° from the normal)
    [[0, 2, 0], [0, 3, 0]], // 6: lying in the plane
  ]);

  it("keeps the tracks that cross the plane within the radius", () => {
    expect(hit(chunk, disk())).toEqual([1, 2, 5, 6]);
  });

  it("with an angle limit, only those running near the normal", () => {
    expect(hit(chunk, disk({ angle: 45 }))).toEqual([1, 2]);
    expect(hit(chunk, disk({ angle: 80 }))).toEqual([1, 2, 5]);
  });

  it("lies across the axis chosen", () => {
    const across = tracks([[[-1, 0, 0], [1, 0, 0]], [[2, 0, -1], [2, 0, 1]]]);
    expect(hit(across, disk({ axis: 0 }))).toEqual([1]);
    expect(roiKey(disk({ axis: 0 }), 0)).not.toBe(roiKey(disk({ axis: 1 }), 0));
    expect(roiKey(disk({ angle: 30 }), 0)).not.toBe(roiKey(disk(), 0));
  });
});
