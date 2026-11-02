/**
 * Precomputed annotations: record sizes and chunk decoding as Neuroglancer
 * lays them out; `NET=1` also asks the hemibrain's synapses (lines, seven
 * sharded spatial levels) which meet a small box.
 */
import { describe, expect, it } from "vitest";
import { decodeSpatialChunk, PrecomputedAnnotations, readAnnotationInfo, recordBytes } from "../src/sdk/precomputed_annotations.js";

const dims = { x: [8e-9, "m"], y: [8e-9, "m"], z: [8e-9, "m"] } as Record<string, [number, string]>;

describe("precomputed annotations", () => {
  it("sizes records as Neuroglancer does: geometry, properties by alignment, padded to 4", () => {
    expect(recordBytes({ annotation_type: "POINT", dimensions: dims })).toBe(12);
    expect(recordBytes({ annotation_type: "LINE", dimensions: dims, properties: [{ id: "a", type: "float32" }, { id: "b", type: "float32" }] })).toBe(32);
    expect(recordBytes({ annotation_type: "POINT", dimensions: dims, properties: [{ id: "c", type: "uint8" }, { id: "d", type: "uint16" }] })).toBe(16);
  });

  it("decodes a chunk: count, records, then ids", () => {
    const info = { annotation_type: "LINE" as const, dimensions: dims, properties: [{ id: "w", type: "float32" }] };
    const bytes = new Uint8Array(8 + 2 * 28 + 16);
    const v = new DataView(bytes.buffer);
    v.setUint32(0, 2, true);
    [[1, 2, 3, 4, 5, 6, 0.5], [7, 8, 9, 10, 11, 12, 0.25]].forEach((rec, i) => rec.forEach((x, k) => v.setFloat32(8 + 28 * i + 4 * k, x, true)));
    v.setBigUint64(8 + 56, 41n, true);
    v.setBigUint64(8 + 64, 2n ** 60n, true);
    expect(decodeSpatialChunk(bytes, info)).toEqual([
      { id: 41n, points: [[1, 2, 3], [4, 5, 6]] },
      { id: 2n ** 60n, points: [[7, 8, 9], [10, 11, 12]] },
    ]);
  });

  it.skipIf(!process.env.NET)("finds the hemibrain synapses in a small box (NET=1)", async () => {
    const url = "https://storage.googleapis.com/neuroglancer-janelia-flyem-hemibrain/v1.0/synapses/";
    const source = new PrecomputedAnnotations(url, await readAnnotationInfo(url));
    const centre = [17000, 22000, 21000];
    const { annotations, chunks } = await source.inBox(centre.map((c) => c - 250), centre.map((c) => c + 250));
    expect(chunks).toBeGreaterThan(6);
    expect(annotations.length).toBeGreaterThan(10);
    // Decoded right, every point lies within the dataset's bounds, and some in the box.
    const { lower_bound: lo, upper_bound: hi } = source.info;
    for (const a of annotations) for (const p of a.points) p.forEach((x, k) => expect(x >= lo[k] - 1 && x <= hi[k] + 1).toBe(true));
    const inside = annotations.filter((a) => a.points.some((p) => p.every((x, k) => Math.abs(x - centre[k]) <= 250)));
    expect(inside.length).toBeGreaterThan(0);
    console.log(`${annotations.length} synapses from ${chunks} chunks, ${inside.length} with an end in the box`);
  }, 120_000);
});

describe("precomputed sources a region cannot be read from", () => {
  it("says why for skeletons and meshes", async () => {
    const { readInfo } = await import("../src/sdk/precomputed.js");
    const serve = (info: object) => async () => new TextEncoder().encode(JSON.stringify(info));
    await expect(readInfo("x/", serve({ "@type": "neuroglancer_skeletons" }), undefined, "segmentation")).rejects.toThrow(/skeletons, which have no spatial index/);
    await expect(readInfo("x/", serve({ "@type": "neuroglancer_multilod_draco" }), undefined, "segmentation")).rejects.toThrow(/meshes/);
    await expect(readInfo("x/", serve({ type: "image", num_channels: 1 }), undefined, "segmentation")).rejects.toThrow(/a precomputed image, not a segmentation/);
  });
});
