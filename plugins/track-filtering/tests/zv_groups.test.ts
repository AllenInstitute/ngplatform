import { describe, expect, it } from "vitest";
import { decodeVlenElements } from "../../zarr-vectors/src/zarr_array.js";
import { groupFiles, mergeGroups, vlenChunk, withGroupsListed } from "../zv_groups.js";

const ids = (...v: number[]) => BigUint64Array.from(v.map(BigInt));

describe("track groups written into a zarr-vectors store", () => {
  it("encodes vlen chunks as the reader decodes them", () => {
    const items = [new Uint8Array([1, 2, 3]), new Uint8Array(0), new Uint8Array([9])];
    expect(decodeVlenElements(vlenChunk(items)).map((x) => [...x])).toEqual([[1, 2, 3], [], [9]]);
  });

  it("replaces a stored group of the same name and keeps the others", () => {
    const merged = mergeGroups(
      [
        { name: "atlas", members: ids(1, 2) },
        { name: "cc", members: ids(3) },
      ],
      [
        { name: "cc", members: ids(4, 5) },
        { name: "cst", members: ids(6) },
      ],
    );
    expect(merged.map((g) => [g.name, [...g.members].map(Number)])).toEqual([
      ["atlas", [1, 2]],
      ["cc", [4, 5]],
      ["cst", [6]],
    ]);
  });

  it("writes the groups array, names and counts", () => {
    const files = groupFiles([
      { name: "cc", members: ids(4, 5) },
      { name: "cst", members: ids(6) },
    ]);
    const meta = JSON.parse(new TextDecoder().decode(files.get("groups/zarr.json")));
    expect(meta.attributes).toMatchObject({ zv_array: "groups", num_groups: 2, group_names: ["cc", "cst"] });
    const rows = decodeVlenElements(files.get("groups/c/0")!);
    expect(rows.map((r) => [...new BigInt64Array(r.slice().buffer)].map(Number))).toEqual([[4, 5], [6]]);
    expect([...new BigInt64Array(files.get("group_attributes/n_objects/c/0")!.slice().buffer)].map(Number)).toEqual([2, 1]);
    const names = decodeVlenElements(files.get("group_attributes/name/c/0")!).map((b) => new TextDecoder().decode(b));
    expect(names).toEqual(["cc", "cst"]);
  });

  it("lists groups among the level's arrays", () => {
    const level = JSON.stringify({ attributes: { zarr_vectors_level: { arrays_present: ["vertices"] } } });
    expect(JSON.parse(withGroupsListed(level)).attributes.zarr_vectors_level.arrays_present).toEqual(["vertices", "groups"]);
    expect(JSON.parse(withGroupsListed(withGroupsListed(level))).attributes.zarr_vectors_level.arrays_present).toEqual(["vertices", "groups"]);
  });
});
