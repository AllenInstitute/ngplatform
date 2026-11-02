/**
 * Filtering what is not Zarr Vectors: regions on a segmentation volume (a
 * hand-made labelled volume), regions on annotations, and how regions'
 * answers combine.  `NET=1` also asks MICrONS' segmentation which cells
 * pass through a small sphere.
 */
import { describe, expect, it } from "vitest";
import { PrecomputedScale, readInfo, type Scale } from "@ngplatform/sdk/precomputed";
import { annotationGeometry, annotationMeets, boxMeets, segmentMeets } from "../annotation_regions.js";
import { chooseScale, labelsInRegion, type NmRegion, voxelBox } from "../labels.js";
import { combineIds } from "../plugin.js";

const sphere = (center: [number, number, number], radius: number): NmRegion => ({ shape: "sphere", center, radius, size: [0, 0, 0] });
const box = (center: [number, number, number], size: [number, number, number]): NmRegion => ({ shape: "box", center, radius: 0, size });

/** A labelled volume in memory: label = 1 + x div 10 (x in voxels), chunked 8³. */
function labelled(): { scale: Scale; reader: Pick<PrecomputedScale, "scale" | "chunk" | "readLabels"> } {
  const scale: Scale = { key: "s0", size: [40, 16, 16], resolution: [10, 10, 20], voxel_offset: [5, 0, 0], chunk_sizes: [[8, 8, 8]], encoding: "raw" };
  const chunk: [number, number, number] = [8, 8, 8];
  return {
    scale,
    reader: {
      scale,
      chunk,
      async readLabels(at) {
        const out = new BigUint64Array(512);
        for (let z = 0; z < 8; ++z) for (let y = 0; y < 8; ++y) for (let x = 0; x < 8; ++x) out[(z * 8 + y) * 8 + x] = BigInt(1 + Math.floor((at[0] * 8 + x) / 10));
        return out;
      },
    },
  };
}

describe("regions on a segmentation", () => {
  it("finds the segments with a voxel centre inside, at a scale small enough", async () => {
    const { scale, reader } = labelled();
    // Voxel x spans [(x + 5) 10, (x + 6) 10) nm: x = 0..9 is label 1, at 50..150 nm.
    // 90..110 nm in x is voxels 4 and 5; in z (20 nm voxels) 70..90 nm is voxels 3 and 4.
    expect(voxelBox(scale, box([100, 80, 80], [20, 20, 20]))).toEqual({ lo: [4, 7, 3], hi: [6, 9, 5] });
    const one = await labelsInRegion(reader, box([100, 80, 80], [20, 20, 20]));
    expect([...one.ids]).toEqual([1n]);
    // Centred on the boundary between labels 1 and 2 (x = 10 starts at 150 nm).
    // The nearest voxel centres are (145 or 155, 75 or 85, 70 or 90) nm: 12.2 nm away.
    const two = await labelsInRegion(reader, sphere([150, 80, 80], 13));
    expect([...two.ids]).toEqual([1n, 2n]);
    const all = await labelsInRegion(reader, box([250, 80, 160], [1000, 1000, 1000]));
    expect([...all.ids]).toEqual([1n, 2n, 3n, 4n]);
    expect(all.voxels).toBe(40 * 16 * 16);
  });

  it("chooses the finest scale whose box is small enough", () => {
    const scales: Scale[] = [8, 16, 32].map((r) => ({ key: `${r}`, size: [10000, 10000, 1000], resolution: [r, r, 40], chunk_sizes: [[64, 64, 64]], encoding: "raw" }));
    expect(chooseScale(scales, sphere([40000, 40000, 20000], 500))).toBe(0);
    // r = 1 µm: 250² × 50 voxels at 8 nm (too many), 125² × 50 at 16 nm.
    expect(chooseScale(scales, sphere([40000, 40000, 20000], 1000), 2_000_000)).toBe(1);
    expect(chooseScale(scales, sphere([40000, 40000, 20000], 50000), 1000)).toBe(2);
  });
});

describe("regions on annotations", () => {
  const region = sphere([0, 0, 0], 10);
  it("meets points, lines, boxes and ellipsoids", () => {
    expect(segmentMeets(region, [-20, 5, 0], [20, 5, 0])).toBe(true);
    expect(segmentMeets(region, [-20, 15, 0], [20, 15, 0])).toBe(false);
    expect(segmentMeets(box([0, 0, 0], [10, 10, 10]), [-20, 4, 4], [20, 4, 4])).toBe(true);
    expect(segmentMeets(box([0, 0, 0], [10, 10, 10]), [-20, 6, 4], [20, 6, 4])).toBe(false);
    expect(boxMeets(region, [8, 8, 8], [20, 20, 20])).toBe(false);
    expect(boxMeets(region, [5, 5, 5], [20, 20, 20])).toBe(true);
    const geometry = annotationGeometry(
      [
        { type: "point", id: "p", point: [1, 1, 1] },
        { type: "point", id: "far", point: [100, 0, 0] },
        { type: "line", id: "l", pointA: [-50, 0, 0], pointB: [50, 0, 0] },
        { type: "ellipsoid", id: "e", center: [15, 0, 0], radii: [6, 6, 6] },
        { type: "axis_aligned_bounding_box", id: "b", pointA: [30, 30, 30], pointB: [20, 20, 20] },
        { type: "polyline", id: "skipped" },
      ],
      [1, 1, 1],
    );
    expect(geometry.map((a) => a.id)).toEqual(["p", "far", "l", "e", "b"]);
    expect(geometry.filter((a) => annotationMeets(region, a)).map((a) => a.id)).toEqual(["p", "l", "e"]);
  });

  it("scales the viewer's coordinates to nanometres", () => {
    const [a] = annotationGeometry([{ type: "point", id: "p", point: [100, 200, 3] }], [4, 4, 40]);
    expect(a.points[0]).toEqual([400, 800, 120]);
  });
});

describe("combining regions", () => {
  it("keeps every AND, one of the ORs, none of the NOTs", () => {
    expect(combineIds([{ op: "and", ids: ["1", "2", "3"] }, { op: "and", ids: ["2", "3", "4"] }, { op: "not", ids: ["3"] }])).toEqual(["2"]);
    expect(combineIds([{ op: "or", ids: ["1"] }, { op: "or", ids: ["5"] }]).sort()).toEqual(["1", "5"]);
    expect(combineIds([{ op: "and", ids: ["1", "2"] }, { op: "or", ids: ["2", "9"] }])).toEqual(["2"]);
    expect(combineIds([{ op: "not", ids: ["1"] }])).toEqual([]);
  });
});

describe.skipIf(!process.env.NET)("MICrONS' segmentation (NET=1)", () => {
  it("names the cells around a point in the cortex", async () => {
    const url = "https://storage.googleapis.com/iarpa_microns/minnie/minnie65/seg_m1300/";
    const info = await readInfo(url, undefined, undefined, "segmentation");
    // The MICrONS example's position: (240640, 207872, 21360) in 4, 4, 40 nm voxels.
    const region = sphere([240640 * 4, 207872 * 4, 21360 * 40], 1500);
    const index = chooseScale(info.scales, region);
    const result = await labelsInRegion(new PrecomputedScale(url, info.scales[index], info.data_type), region);
    expect(result.ids.length).toBeGreaterThan(3);
    expect(result.ids[result.ids.length - 1]).toBeGreaterThan(864691135000000000n);
  }, 120_000);
});
