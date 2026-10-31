import { describe, expect, it } from "vitest";
import { readSaved } from "../src/plugins/track_filtering/plugin.js";
import { compactChunk, groupMask, IdSet, type RoiGeometry, roiBounds, roiKey, rowIndex, rowMask, segmentHitsBox, testChunk } from "../src/plugins/track_filtering/roi.js";
import { previewLevel, type StoreInfo, toStore } from "../src/plugins/track_filtering/roi_client.js";

/** Two streamlines along x: object 7 at y = 0, object 9 at y = 10, one vertex per unit. */
function chunk() {
  const positions: number[] = [];
  const ids: number[] = [];
  const edges: number[] = [];
  for (const [object, y] of [
    [7, 0],
    [9, 10],
  ]) {
    const first = positions.length / 3;
    for (let x = 0; x <= 20; ++x) {
      positions.push(x, y, 0);
      ids.push(object, 0);
      if (x > 0) edges.push(first + x - 1, first + x);
    }
  }
  return { positions: new Float32Array(positions), ids: new Uint32Array(ids), edges: new Uint32Array(edges) };
}

const sphere = (center: [number, number, number], radius: number): RoiGeometry => ({ shape: "sphere", center, radius, size: [0, 0, 0] });
const box = (center: [number, number, number], size: [number, number, number]): RoiGeometry => ({ shape: "box", center, radius: 0, size });

function hitsOf(roi: RoiGeometry, data = chunk()): bigint[] {
  const hits = new IdSet();
  testChunk(compactChunk(data.positions, data.ids, data.edges), roi, hits);
  return Array.from(hits.toArray()).sort();
}

describe("region tests", () => {
  it("finds the streamlines a sphere touches, between vertices too", () => {
    expect(hitsOf(sphere([5, 0, 0], 1))).toEqual([7n]);
    // Between two vertices, off-axis: the segment passes within 0.4 of it.
    expect(hitsOf(sphere([5.5, 0.4, 0], 0.45))).toEqual([7n]);
    expect(hitsOf(sphere([5, 5, 0], 4))).toEqual([]);
    expect(hitsOf(sphere([5, 5, 0], 5))).toEqual([7n, 9n]);
  });

  it("finds the streamlines a box touches, including one that only crosses it", () => {
    expect(hitsOf(box([10, 10, 0], [2, 2, 2]))).toEqual([9n]);
    // A thin slab across x = 5.5, between vertices: both cross it.
    expect(hitsOf(box([5.5, 5, 0], [0.2, 30, 2]))).toEqual([7n, 9n]);
    expect(hitsOf(box([5, 5, 0], [30, 2, 2]))).toEqual([]);
  });

  it("tests vertices when there are no segments (points)", () => {
    const data = { positions: new Float32Array([0, 0, 0, 10, 0, 0]), ids: new Uint32Array([1, 0, 2, 0]), edges: new Uint32Array() };
    expect(hitsOf(sphere([10, 0, 0], 0.5), data)).toEqual([2n]);
    expect(hitsOf(box([0, 0, 0], [1, 1, 1]), data)).toEqual([1n]);
  });

  it("packs segments as a flag per vertex, keeping other pairs", () => {
    const data = chunk();
    const packed = compactChunk(data.positions, data.ids, data.edges);
    expect(packed.next.reduce((a, b) => a + b, 0)).toBe(40);
    expect(packed.extra.length).toBe(0);
    expect(packed.idHigh).toBeUndefined();
    expect(packed.bytes).toBeLessThan(data.positions.byteLength + data.ids.byteLength + data.edges.byteLength);
    // A pair that is not consecutive (a bridge, a branch) is kept as a pair.
    const branch = compactChunk(data.positions, data.ids, Uint32Array.from([0, 1, 1, 30]));
    expect(Array.from(branch.extra)).toEqual([1, 30]);
    const hits = new IdSet();
    // Object 7's vertex 1 (1, 0, 0) to object 9's vertex 30 (9, 10, 0): passes (5, 5, 0).
    testChunk(branch, sphere([5, 5, 0], 0.1), hits);
    expect(hits.size).toBe(1);
  });

  it("keeps 64-bit ids exact", () => {
    const hits = new IdSet();
    hits.add(5, 0);
    hits.add(1, 0x80000000);
    expect(Array.from(hits.toArray())).toEqual([5n, (0x80000000n << 32n) | 1n]);
  });

  it("bounds and keys regions", () => {
    expect(roiBounds(sphere([1, 2, 3], 2))).toEqual({ lo: [-1, 0, 1], hi: [3, 4, 5] });
    expect(roiBounds(box([0, 0, 0], [2, 4, 6]), 1)).toEqual({ lo: [-2, -3, -4], hi: [2, 3, 4] });
    expect(roiKey(sphere([1, 2, 3], 2), 0)).not.toBe(roiKey(sphere([1, 2, 3], 2), 1));
    expect(roiKey(sphere([1, 2, 3.0000001], 2), 0)).toBe(roiKey(sphere([1, 2, 3], 2), 0));
  });

  it("does the slab test edge cases", () => {
    const p = new Float32Array([0, 0, 0, 10, 0, 0]);
    expect(segmentHitsBox(p, 0, 1, [4, -1, -1], [6, 1, 1])).toBe(true);
    expect(segmentHitsBox(p, 0, 1, [4, 0.5, -1], [6, 1, 1])).toBe(false);
    expect(segmentHitsBox(p, 0, 1, [11, -1, -1], [12, 1, 1])).toBe(false);
  });
});

describe("combining a group", () => {
  const ids = new BigUint64Array([0n, 1n, 2n, 3n, 4n]);

  it("maps ids to rows, directly when ids are rows", () => {
    expect(rowIndex(ids)(3n)).toBe(3);
    expect(rowIndex(ids)(9n)).toBeUndefined();
    const sparse = rowIndex(new BigUint64Array([10n, 20n, 30n]));
    expect(sparse(20n)).toBe(1);
    expect(Array.from(rowMask(3, new BigUint64Array([30n, 99n]), sparse))).toEqual([0, 0, 1]);
  });

  it("is AND of the and-regions, OR of the or-regions, minus the not-regions, within the attributes", () => {
    const rows = (set: number[]) => Uint8Array.from([0, 1, 2, 3, 4], (i) => (set.includes(i) ? 1 : 0));
    expect(Array.from(groupMask(5, undefined, [{ op: "and", rows: rows([0, 1, 2]) }, { op: "and", rows: rows([1, 2, 3]) }]))).toEqual([0, 1, 1, 0, 0]);
    expect(Array.from(groupMask(5, undefined, [{ op: "or", rows: rows([0]) }, { op: "or", rows: rows([4]) }]))).toEqual([1, 0, 0, 0, 1]);
    expect(Array.from(groupMask(5, undefined, [{ op: "and", rows: rows([0, 1, 2, 3]) }, { op: "not", rows: rows([2]) }]))).toEqual([1, 1, 0, 1, 0]);
    expect(Array.from(groupMask(5, rows([1, 3]), [{ op: "and", rows: rows([0, 1, 2]) }]))).toEqual([0, 1, 0, 0, 0]);
  });
});

describe("coordinates and levels", () => {
  const info: StoreInfo = {
    axisNames: ["x", "y", "z"],
    axisUnits: ["m", "m", "m"],
    axisScales: [1e-3, 1e-3, 1e-3],
    coordinateOffset: undefined,
    levels: [
      { index: 0, vertexCount: 102_000_000, chunkShape: [31, 32, 34] },
      { index: 1, vertexCount: 10_000_000, chunkShape: [31, 32, 34] },
      { index: 2, vertexCount: 1_000_000, chunkShape: [62, 64, 68] },
    ],
    geometry: "streamline",
  };

  it("converts the viewer's coordinates to the store's", () => {
    const roi = { id: "r", shape: "sphere" as const, center: [1, 2, 3] as [number, number, number], radius: 2, size: [4, 4, 4] as [number, number, number], op: "and" as const };
    expect(toStore(roi, { x: [1e-3, "m"], y: [1e-3, "m"], z: [1e-3, "m"] }, info).center).toEqual([1, 2, 3]);
    // Viewer in micrometres: 1000 µm is 1 mm.
    const um = toStore({ ...roi, center: [1000, 0, 0], radius: 500 }, { x: [1e-6, "m"], y: [1e-6, "m"], z: [1e-6, "m"] }, info);
    expect(um.center[0]).toBeCloseTo(1);
    expect(um.radius).toBeCloseTo(0.5);
    expect(toStore(roi, { x: [1e-3, "m"], y: [1e-3, "m"], z: [1e-3, "m"] }, { ...info, coordinateOffset: [1, 1, 1] }).center).toEqual([0, 1, 2]);
  });

  it("previews on the finest level small enough", () => {
    expect(previewLevel(info)).toBe(1);
    expect(previewLevel(info, 5_000_000)).toBe(2);
    expect(previewLevel({ ...info, levels: [info.levels[0]] })).toBeUndefined();
  });
});

describe("saved groups", () => {
  it("reads version 1's single filter as a group", () => {
    const saved = readSaved({ dataset: "d", filter: { ranges: { length: [1, 2] }, includeTags: [], excludeTags: [] }, active: true });
    expect(saved.groups).toHaveLength(1);
    expect(saved.groups[0].filter.ranges).toEqual({ length: [1, 2] });
    expect(saved.editing).toBe(saved.groups[0].id);
    expect(readSaved({ filter: { ranges: {}, includeTags: [], excludeTags: [] } }).groups).toEqual([]);
  });

  it("fills in what a hand-written group leaves out", () => {
    const saved = readSaved({ groups: [{ id: "a", rois: [] }] });
    expect(saved.groups[0]).toMatchObject({ id: "a", name: "Group 1", rois: [], filter: { ranges: {}, includeTags: [], excludeTags: [] } });
  });
});
