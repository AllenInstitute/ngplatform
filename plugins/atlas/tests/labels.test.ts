import { niftiFile } from "@ngplatform/sdk/volume_out";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNifti } from "../../../src/virtual/images/nifti.js";
import { VolumeReader } from "../../volume-view/volume_reader.js";
import { countingLevel, LabelCounter, NearestVoxel, refineLevel } from "../labels.js";

afterEach(() => vi.unstubAllGlobals());

/** A 4 × 3 × 2 volume (x fastest), whole, as one chunk. */
const size = [4, 3, 2];
// prettier-ignore
const volume = Uint32Array.from([
  0, 7, 7, 0,
  0, 7, 9, 9,
  0, 0, 0, 0,

  0, 0, 0, 0,
  5, 5, 9, 0,
  0, 0, 0, 9,
]);
const whole = { lo: [0, 0, 0] as [number, number, number], hi: size as [number, number, number], start: 0, stride: [1, 4, 12] as [number, number, number] };

describe("passes over a label volume", () => {
  it("counts each label's voxels, centre and bounds, background aside", () => {
    const counter = new LabelCounter();
    counter.add(volume, whole);
    const r = counter.result();
    expect(Array.from(r.labels)).toEqual([7, 9, 5]);
    expect(Array.from(r.counts)).toEqual([3, 4, 2]);
    // Label 7 at (1,0,0), (2,0,0), (1,1,0).
    expect(Array.from(r.sums.slice(0, 3))).toEqual([4, 1, 0]);
    // Label 9 at (2,1,0), (3,1,0), (2,1,1), (3,2,1).
    expect(Array.from(r.sums.slice(3, 6))).toEqual([10, 5, 2]);
    expect(Array.from(r.bounds.slice(6, 12))).toEqual([2, 1, 0, 3, 2, 1]);
  });

  it("gives the same counts chunk by chunk, in another array order", () => {
    // The same volume stored z fastest (as a transposed array), in two chunks along x.
    const counter = new LabelCounter();
    for (const x0 of [0, 2]) {
      const chunk = new Uint32Array(2 * 3 * 2);
      for (let x = 0; x < 2; ++x) for (let y = 0; y < 3; ++y) for (let z = 0; z < 2; ++z) chunk[(x * 3 + y) * 2 + z] = volume[x0 + x + 4 * y + 12 * z];
      counter.add(chunk, { lo: [x0, 0, 0], hi: [x0 + 2, 3, 2], start: 0, stride: [6, 2, 1] });
    }
    const r = counter.result();
    const byLabel = new Map(Array.from(r.labels, (l, i) => [l, [r.counts[i], r.sums[3 * i], r.sums[3 * i + 1], r.sums[3 * i + 2]]]));
    expect(byLabel.get(7)).toEqual([3, 4, 1, 0]);
    expect(byLabel.get(9)).toEqual([4, 10, 5, 2]);
    expect(byLabel.get(5)).toEqual([2, 1, 2, 2]);
  });

  it("finds the voxel of some labels nearest a point", () => {
    const nearest = new NearestVoxel(new Set([9]), [0, 0, 1]);
    nearest.add(volume, whole);
    expect(nearest.best).toEqual([2, 1, 1]);
    const none = new NearestVoxel(new Set([3]), [0, 0, 0]);
    none.add(volume, whole);
    expect(none.best).toBeUndefined();
  });

  it("counts at the finest level within the budget", () => {
    const sizes: [number, number, number][] = [
      [1000, 1000, 1000],
      [500, 500, 500],
      [250, 250, 250],
    ];
    expect(countingLevel(sizes)).toBe(2);
    expect(countingLevel(sizes, 2e8)).toBe(1);
    expect(countingLevel(sizes, 10)).toBe(2);
  });

  it("counts again at the finest level the first count's rate reads in about a minute", () => {
    const sizes: [number, number, number][] = [
      [1000, 1000, 1000],
      [500, 500, 500],
      [250, 250, 250],
    ];
    // 250³ in a second: 500³ (8 s) and 1000³ (64 s) are about a minute or less.
    expect(refineLevel(sizes, 2, 1)).toBe(1);
    expect(refineLevel(sizes, 2, 0.5)).toBe(0);
    // 250³ in 10 s: 500³ would take 80 s.
    expect(refineLevel(sizes, 2, 10)).toBeUndefined();
    expect(refineLevel(sizes, 2, 10, 120)).toBe(1);
    // Nothing finer than level 0; an unknown time finds nothing affordable.
    expect(refineLevel(sizes, 0, 0.001)).toBeUndefined();
    expect(refineLevel(sizes, 2, Infinity)).toBeUndefined();
  });
});

describe("counting a label image through the volume reader", () => {
  it("counts a NIfTI's labels (Allen ids past 2^24) as they are, and finds a region's voxel", async () => {
    const size: [number, number, number] = [40, 30, 20];
    const data = new Uint32Array(size[0] * size[1] * size[2]);
    const expected = new Map<number, number>();
    for (let z = 0, i = 0; z < size[2]; ++z) {
      for (let y = 0; y < size[1]; ++y) {
        for (let x = 0; x < size[0]; ++x, ++i) {
          // Two blocks of large ids, and a small one; the rest background.
          const label = x < 10 ? 614454277 : x < 20 && y < 10 ? 382 : z > 15 ? 16777217 : 0;
          data[i] = label;
          if (label !== 0) expected.set(label, (expected.get(label) ?? 0) + 1);
        }
      }
    }
    const voxelToRas = Float64Array.from([0.5, 0, 0, -10, 0, 0.5, 0, -20, 0, 0, 0.5, 5, 0, 0, 0, 1]);
    const store = await openNifti(new Blob([niftiFile({ data, size, type: "uint32", voxelToRas }, { label: true }) as BlobPart]), "labels.nii");
    vi.stubGlobal("fetch", async (url: string) => {
      const bytes = await store.get(String(url).replace("http://nii.test/", ""));
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice() as BlobPart);
    });
    const reader = new VolumeReader();
    const { levels } = await reader.open(["http://nii.test/"], undefined);
    expect(levels[0].size).toEqual(size);
    const counter = new LabelCounter();
    const signal = new AbortController().signal;
    await reader.eachRawChunk(0, signal, (values, box) => counter.add(values, box));
    const r = counter.result();
    expect(new Map(Array.from(r.labels, (l, i) => [l, r.counts[i]]))).toEqual(expected);
    const i382 = Array.from(r.labels).indexOf(382);
    expect(Array.from(r.sums.slice(3 * i382, 3 * i382 + 3)).map((s) => s / r.counts[i382])).toEqual([14.5, 4.5, 9.5]);
    // Only the chunks meeting a box are read.
    const nearest = new NearestVoxel(new Set([16777217]), [0, 0, 0]);
    await reader.eachRawChunk(0, signal, (values, box) => nearest.add(values, box), undefined, { lo: [20, 0, 16], hi: [40, 30, 20] });
    expect(nearest.best).toEqual([20, 0, 16]);
  });

  it("counts a precomputed segmentation's labels, read as 32-bit ones", async () => {
    // Two chunks along x, raw uint64 ids; the edge chunk is short.
    const size: [number, number, number] = [6, 2, 2];
    const label = (x: number, y: number, z: number) => (x < 3 ? 997 : y + z > 0 ? 614454277 : 0);
    const chunk = (x0: number, x1: number) => {
      const out = new Uint8Array(8 * (x1 - x0) * 4);
      const view = new DataView(out.buffer);
      for (let z = 0, i = 0; z < 2; ++z) for (let y = 0; y < 2; ++y) for (let x = x0; x < x1; ++x, ++i) view.setBigUint64(8 * i, BigInt(label(x, y, z)), true);
      return out;
    };
    const files: Record<string, Uint8Array> = {
      info: new TextEncoder().encode(
        JSON.stringify({ type: "segmentation", data_type: "uint64", num_channels: 1, scales: [{ key: "s0", size, resolution: [10000, 10000, 10000], chunk_sizes: [[4, 2, 2]], encoding: "raw" }] }),
      ),
      "s0/0-4_0-2_0-2": chunk(0, 4),
      "s0/4-6_0-2_0-2": chunk(4, 6),
    };
    vi.stubGlobal("fetch", async (url: string) => {
      const bytes = files[String(url).replace("http://seg.test/", "")];
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice() as BlobPart);
    });
    const reader = new VolumeReader();
    const { levels } = await reader.open(["precomputed:http://seg.test/"], undefined);
    expect(levels[0]).toMatchObject({ size, type: "uint32" });
    const counter = new LabelCounter();
    await reader.eachRawChunk(0, new AbortController().signal, (values, box) => counter.add(values, box));
    const r = counter.result();
    expect(new Map(Array.from(r.labels, (l, i) => [l, r.counts[i]]))).toEqual(
      new Map([
        [997, 12],
        [614454277, 9],
      ]),
    );
  });
});
