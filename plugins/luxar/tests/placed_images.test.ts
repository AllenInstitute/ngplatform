/**
 * Images given with a transform of their own, as a HiP-CT scene gives its
 * volumes of interest (`{url, transform}` sources at 2.196 µm placed in a
 * 20.022 µm overview): each is one Luxar can draw as splats, and its splats
 * (in the image's own RAS mm) are moved to where the layer's transform puts
 * the image, not left where its metadata alone would.
 */
import { describe, expect, it, vi } from "vitest";
import type { LayerInfo, LayerTransform } from "@ngplatform/sdk";

// The splat worker's module is imported for its helpers, and sets `self.onmessage` as it loads.
vi.hoisted(() => {
  (globalThis as { self?: unknown }).self ??= globalThis;
});

import { imageOfLayer } from "../plugin.js";
import { apply, placementMm } from "../view_math.js";

const BUCKET = "zarr://gs://ucl-hip-ct-cambridge-kidneys-2v2yyfzv697y6yxt/K336/kidney/";
const OVERVIEW = 2.0022e-5;
const VOI = 2.196e-6;

/** VOI-1's transform as the engine gives it (layerTransform): the link's matrix, and the source's own half-voxel offset. */
function voi1(): LayerTransform {
  const m = [
    [0.999917, 0.012889, 0, 667.6333525280193],
    [-0.012889, 0.999917, 0, 1566.4500811177707],
    [0, 0, 1, 523.4246094444112],
  ];
  const matrix = new Float64Array(16);
  for (let r = 0; r < 3; ++r) for (let c = 0; c < 4; ++c) matrix[4 * c + r] = m[r][c];
  matrix[15] = 1;
  const half = (0.5 * VOI) / OVERVIEW;
  const defaultMatrix = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, half, half, half, 1]);
  const space = (s: number) => ({ names: ["x", "y", "z"], scales: [s, s, s], units: ["m", "m", "m"] });
  return { rank: 3, input: space(VOI), output: space(OVERVIEW), matrix, defaultMatrix };
}

describe("a scene of images placed by their sources' transforms", () => {
  it("can draw the overview and each volume of interest; not the annotations", () => {
    const layers: LayerInfo[] = [
      { name: "K336_kidney_overview_20.022um_bm18", type: "image", visible: true, ready: true, sources: [`${BUCKET}20.022um_overview_bm18.ome.zarr/`] },
      ...[1, 2, 3, 4].map((i): LayerInfo => ({ name: `VOI-${i}`, type: "image", visible: true, ready: true, sources: [`${BUCKET}2.196um_VOI-${i}_bm18.ome.zarr/`] })),
      { name: "annotation", type: "annotation", visible: false, ready: true, sources: ["local://annotations"] },
    ];
    expect(layers.map(imageOfLayer)).toEqual([
      "https://storage.googleapis.com/ucl-hip-ct-cambridge-kidneys-2v2yyfzv697y6yxt/K336/kidney/20.022um_overview_bm18.ome.zarr/",
      ...[1, 2, 3, 4].map((i) => `https://storage.googleapis.com/ucl-hip-ct-cambridge-kidneys-2v2yyfzv697y6yxt/K336/kidney/2.196um_VOI-${i}_bm18.ome.zarr/`),
      undefined,
    ]);
  });

  it("moves a volume of interest's splats to where its transform places it", () => {
    const t = voi1();
    const p = placementMm(t)!;
    expect(p).toBeDefined();
    // Where the layer puts a voxel (input coordinates, in VOI voxels), in mm.
    const placed = (v: number[]) => [0, 1, 2].map((o) => (t.matrix[12 + o] + [0, 1, 2].reduce((s, j) => s + t.matrix[4 * j + o] * v[j] * (VOI / OVERVIEW), 0)) * OVERVIEW * 1000);
    // Where the image's own metadata puts it (its splats' RAS mm): scale and half-voxel offset.
    const own = (v: number[]) => v.map((x) => (x + 0.5) * VOI * 1000);
    for (const v of [
      [0, 0, 0],
      [1000, 0, 0],
      [0, 5000, 0],
      [2500, 2500, 10000],
    ]) {
      const got = apply(p, own(v)).slice(0, 3);
      const want = placed(v);
      for (let k = 0; k < 3; ++k) expect(got[k]).toBeCloseTo(want[k], 6);
    }
    // VOI-1's corner is about 13.4, 31.4 and 10.5 mm in: not at the origin.
    expect(apply(p, own([0, 0, 0]))[0]).toBeCloseTo(13.367, 2);
  });

  it("leaves an image where it puts itself when its transform is its own", () => {
    const t = voi1();
    expect(placementMm({ ...t, matrix: t.defaultMatrix })).toBeUndefined();
    expect(placementMm(undefined)).toBeUndefined();
  });
});
