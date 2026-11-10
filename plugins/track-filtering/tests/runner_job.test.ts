/** A track group as the runner's filter job: the zvf-predicate tree, and masks as voxels. */
import { describe, expect, it } from "vitest";
import { emptyFilter } from "../filter.js";
import { maskBits, type RoiGeometry } from "../roi.js";
import { groupPredicate, type JobRegion, maskRegion, objectSet, safeName, usesTags } from "../runner_job.js";

const sphere = (x: number, ends?: "either" | "both"): RoiGeometry => ({ shape: "sphere", center: [x, 0, 0], radius: 5, size: [10, 10, 10], ...(ends ? { ends } : {}) });
const box: RoiGeometry = { shape: "box", center: [10, 20, 30], radius: 1, size: [4, 6, -8] };

function unpack(bits: string, n: number): number[] {
  const bytes = Uint8Array.from(atob(bits), (c) => c.charCodeAt(0));
  return Array.from({ length: n }, (_, i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1);
}

describe("groupPredicate", () => {
  it("follows TrackVis's rule: every and, one of the ors, no not", () => {
    const regions: JobRegion[] = [
      { op: "and", geometry: sphere(1) },
      { op: "or", geometry: sphere(2, "either") },
      { op: "or", geometry: sphere(3, "both") },
      { op: "not", geometry: box },
    ];
    const doc = groupPredicate(regions, { ...emptyFilter(), ranges: { length: [80, 20] } });
    expect(doc.format).toBe("zvf-predicate");
    expect(doc.version).toBe(1);
    expect(doc.tree).toEqual({
      op: "and",
      args: [
        { op: "passes", mode: "path", region: { type: "sphere", center: [1, 0, 0], radius: 5 } },
        {
          op: "or",
          args: [
            { op: "passes", mode: "endpoints", region: { type: "sphere", center: [2, 0, 0], radius: 5 } },
            { op: "passes", mode: "both_endpoints", region: { type: "sphere", center: [3, 0, 0], radius: 5 } },
          ],
        },
        { op: "not", arg: { op: "passes", mode: "path", region: { type: "box", min: [8, 17, 26], max: [12, 23, 34] } } },
        { op: "column", name: "length", cmp: "between", value: [20, 80] },
      ],
    });
  });

  it("makes a single region its own tree, and nothing at all every streamline", () => {
    expect(groupPredicate([{ op: "or", geometry: sphere(1) }], emptyFilter()).tree).toMatchObject({ op: "passes" });
    expect(groupPredicate([], emptyFilter()).tree).toEqual({ op: "all" });
  });

  it("gives a disk its normal and angle, crossed by path only", () => {
    const disk: RoiGeometry = { shape: "disk", center: [0, 0, 5], radius: 3, size: [0, 0, 0], axis: 1, angle: 30, ends: "either" };
    expect(groupPredicate([{ op: "and", geometry: disk }], emptyFilter()).tree).toEqual({
      op: "passes",
      mode: "path",
      region: { type: "disk", center: [0, 0, 5], normal: [0, 1, 0], radius: 3, angle: [0, 30] },
    });
  });

  it("sends tags as the objects they choose, which the tree's group node tests", () => {
    expect(usesTags(emptyFilter())).toBe(false);
    const tagged = { ...emptyFilter(), includeTags: ["CST"], excludeTags: ["short"] };
    expect(usesTags(tagged)).toBe(true);
    // Without the objects the tags choose, there is nothing to send.
    expect(() => groupPredicate([], tagged)).toThrow(/tags/);
    const doc = groupPredicate([{ op: "and", geometry: sphere(1) }], tagged, BigUint64Array.from([0n, 9n, 3n]));
    expect(doc.tree).toMatchObject({ op: "and", args: [{ op: "passes" }, { op: "group", ids: [0] }] });
    // Bits 0, 3 and 9 of 10, most significant first: 1001 0000, 0100 0000.
    expect(doc.groups).toEqual([{ size: 10, bits: btoa(String.fromCharCode(0b10010000, 0b01000000)) }]);
    // Tags alone; and tags that choose nothing choose nothing.
    expect(groupPredicate([], tagged, new BigUint64Array(0))).toMatchObject({ tree: { op: "group", ids: [0] }, groups: [{ size: 0, bits: "" }] });
    // A group without tags carries no set.
    expect(groupPredicate([], emptyFilter(), BigUint64Array.from([1n])).groups).toBeUndefined();
    expect(() => objectSet(BigUint64Array.from([2n ** 40n]))).toThrow(/too large/);
  });
});

describe("maskRegion", () => {
  // A 4 x 3 x 2 volume (x fastest), voxel = store / 2 - 1: store = 2 voxel + 2.
  const size: [number, number, number] = [4, 3, 2];
  const values = new Uint8Array(24);
  const at = (x: number, y: number, z: number) => x + 4 * (y + 3 * z);
  values[at(1, 1, 0)] = 1;
  values[at(2, 1, 1)] = 1;
  values[at(2, 2, 1)] = 1;
  const storeToVoxel = Float64Array.from([0.5, 0, 0, -1, 0, 0.5, 0, -1, 0, 0, 0.5, -1, 0, 0, 0, 1]);

  it("keeps the box around the set voxels, z fastest, with its affine", () => {
    const mask = maskBits(values, size, {}, storeToVoxel);
    const region = maskRegion(mask);
    expect(region?.type).toBe("mask");
    if (region?.type !== "mask") return;
    // The box: x 1..2, y 1..2, z 0..1.
    expect(region.shape).toEqual([2, 2, 2]);
    const bits = unpack(region.bits, 8);
    // Index (i, j, k) of the box is i * 4 + j * 2 + k (numpy's C order).
    const cell = (i: number, j: number, k: number) => bits[i * 4 + j * 2 + k];
    expect(cell(0, 0, 0)).toBe(1); // volume (1, 1, 0)
    expect(cell(1, 0, 1)).toBe(1); // volume (2, 1, 1)
    expect(cell(1, 1, 1)).toBe(1); // volume (2, 2, 1)
    expect(bits.reduce((a, b) => a + b, 0)).toBe(3);
    // Box voxel (0, 0, 0) is volume voxel (1, 1, 0): store (4, 4, 2).
    expect(region.affine).toEqual([
      [2, 0, 0, 4],
      [0, 2, 0, 4],
      [0, 0, 2, 2],
      [0, 0, 0, 1],
    ]);
  });

  it("makes an empty mask meet nothing", () => {
    const empty = maskBits(new Uint8Array(24), size, {}, storeToVoxel);
    expect(maskRegion(empty)).toBeUndefined();
    const tree = groupPredicate([{ op: "and", geometry: { shape: "mask", center: [0, 0, 0], radius: 1, size: [1, 1, 1] }, mask: empty }], emptyFilter()).tree;
    expect(tree).toEqual({ op: "not", arg: { op: "all" } });
  });
});

describe("safeName", () => {
  it("keeps names usable as files", () => {
    expect(safeName("Left CST / motor")).toBe("Left_CST_motor");
    expect(safeName("  ")).toBe("group");
  });
});
