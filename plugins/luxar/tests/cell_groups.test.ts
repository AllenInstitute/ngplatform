/**
 * A store chunked finely for its size is read in groups of cells
 * (chunk_build's `cellGroup`, `mergeInputs`): the ABC atlas's MERFISH
 * point cloud (3.7 M cells in 26 × 16 × 22 cells of half a millimetre at
 * every level) was 9,152 tiny chunks a level, and turning Luxar on froze
 * the page under their messages, panel updates, textures and draw calls.
 */
import { describe, expect, it } from "vitest";
import { buildChunk, cellGroup, type ChunkInput, GROUP_VERTICES, MAX_GROUP, mergeInputs } from "../chunk_build.js";
import { selectChunks } from "../chunks.js";
import type { StoreInfo } from "../client.js";

const CELLS = 26 * 16 * 22;

describe("grouping a level's cells", () => {
  it("bounds the chunks of the ABC atlas's point cloud to a few hundred a level", () => {
    const counts = [3739946, 467493, 58436, 7304, 913];
    const groups = counts.map((n) => cellGroup(n, CELLS, "points"));
    expect(groups).toEqual([3, 5, 8, 8, 8]);
    const chunks = groups.map((g) => Math.ceil(26 / g) * Math.ceil(16 / g) * Math.ceil(22 / g));
    // 9,152 cells a level before.
    for (const n of chunks) expect(n).toBeLessThanOrEqual(9 * 6 * 8);
    // Each chunk of the finest levels holds about GROUP_VERTICES on average.
    expect(counts[0] / chunks[0]).toBeGreaterThan(GROUP_VERTICES / 2);
    expect(counts[1] / chunks[1]).toBeGreaterThan(GROUP_VERTICES / 4);
  });

  it("leaves well-filled cells, meshes and levels of unknown size alone, and groups at most MAX_GROUP a side", () => {
    expect(cellGroup(10 * GROUP_VERTICES * CELLS, CELLS, "lines")).toBe(1);
    expect(cellGroup(GROUP_VERTICES * CELLS, CELLS, "points")).toBe(1);
    expect(cellGroup(10, CELLS, "triangles")).toBe(1);
    expect(cellGroup(undefined, CELLS, "points")).toBe(1);
    expect(cellGroup(0, CELLS, "points")).toBe(1);
    expect(cellGroup(1, 1e6, "points")).toBe(MAX_GROUP);
  });

  it("selects grouped chunks as the views see them: a few hundred, not thousands", () => {
    const groups = [3, 8];
    const info = {
      bounds: { lower: [0.2, 0.01, 0.4], upper: [12.78, 7.98, 10.89] },
      levels: [3739946, 913].map((n, i) => ({ index: i, vertexCount: n, chunkShape: [0.5, 0.5, 0.5].map((c) => c * groups[i]), group: groups[i], objectShare: 1, objects: undefined })),
    } as unknown as StoreInfo;
    const s = selectChunks(info, () => true, [6, 4, 5], 8e6, () => false);
    expect(s.level).toBe(0);
    expect(s.want.length).toBeLessThanOrEqual(9 * 6 * 8 + 4 * 2 * 3);
  });
});

describe("merging cells' inputs", () => {
  const cell = (at: number, own: number, ghosts: number, id: number, edges: number[] = []): ChunkInput => {
    const n = own + ghosts;
    return {
      numVertices: n,
      numOwnVertices: own,
      positions: Float32Array.from({ length: 3 * n }, (_, i) => at + Math.floor(i / 3)),
      segmentIds: Uint32Array.from({ length: 2 * n }, (_, i) => (i % 2 === 0 ? id : 0)),
      edges: Uint32Array.from(edges),
      attributes: [Float32Array.from({ length: n }, (_, v) => at + v)],
    };
  };

  it("puts every cell's own vertices first, then their copies of neighbours', and follows them with edges", () => {
    // Cell a: 2 own vertices and a bridge to a neighbour's (vertex 2); cell b: 3 own, one ghost.
    const a = cell(100, 2, 1, 7, [0, 1, 1, 2]);
    const b = cell(200, 3, 1, 9, [0, 1, 2, 3]);
    const m = mergeInputs([a, b]);
    expect(m.numVertices).toBe(7);
    expect(m.numOwnVertices).toBe(5);
    // Own: a0 a1 b0 b1 b2; then ghosts: a2 b3.
    expect(Array.from(m.positions.filter((_, i) => i % 3 === 0))).toEqual([100, 101, 200, 201, 202, 102, 203]);
    expect(Array.from(m.attributes[0])).toEqual([100, 101, 200, 201, 202, 102, 203]);
    expect(Array.from(m.segmentIds.filter((_, i) => i % 2 === 0))).toEqual([7, 7, 9, 9, 9, 7, 9]);
    expect(Array.from(m.edges)).toEqual([0, 1, 1, 5, 2, 3, 4, 6]);
  });

  it("draws a group of point cells as one chunk holding every cell's points", () => {
    const parts = [cell(0, 40, 0, 1), cell(50, 60, 0, 2), cell(200, 1, 0, 3)];
    const built = buildChunk(mergeInputs(parts), { kind: "none" });
    expect(built.pointCount).toBe(101);
    expect(built.segmentCount).toBe(0);
    expect(built.objects).toBe(3);
    expect(built.lower[0]).toBe(0);
    expect(built.upper[0]).toBe(200);
  });

  it("gives a single cell back as it is", () => {
    const a = cell(0, 3, 0, 1);
    expect(mergeInputs([a])).toBe(a);
  });
});
