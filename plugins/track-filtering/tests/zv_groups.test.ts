import { describe, expect, it } from "vitest";
import { decodeVlenElements } from "../../zarr-vectors/src/zarr_array.js";
import { freeSeparator, groupFiles, type LevelFiles, mergeGroups, vlenChunk, withGroupsListed, writeGroups } from "../zv_groups.js";

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

  /** A level's files in memory, every write recorded; `failOn` makes writing that path fail. */
  function level(files: Record<string, string | Uint8Array>, failOn?: string) {
    const store = new Map<string, string | Uint8Array>(Object.entries(files));
    const writes: string[] = [];
    const io: LevelFiles = {
      read: async (path) => {
        const v = store.get(path);
        return v === undefined ? undefined : typeof v === "string" ? v : new TextDecoder().decode(v);
      },
      write: async (path, data) => {
        if (path === failOn) throw new Error("no room");
        writes.push(path);
        store.set(path, data);
      },
    };
    const text = (path: string) => {
      const v = store.get(path);
      return typeof v === "string" ? v : v && new TextDecoder().decode(v);
    };
    return { io, store, writes, text };
  }
  const levelJson = JSON.stringify({ attributes: { zarr_vectors_level: { arrays_present: ["vertices"] } } });

  it("puts each new chunk beside the old one, under the key its zarr.json does not use", () => {
    expect(freeSeparator(undefined)).toBe("/");
    const files = groupFiles([{ name: "cc", members: ids(1) }]);
    expect(freeSeparator(new TextDecoder().decode(files.get("groups/zarr.json")))).toBe(".");
    const dotted = groupFiles([{ name: "cc", members: ids(1) }], { groups: ".", "group_attributes/name": ".", "group_attributes/n_objects": "." });
    expect([...dotted.keys()].filter((k) => !k.endsWith("zarr.json"))).toEqual(["groups/c.0", "group_attributes/name/c.0", "group_attributes/n_objects/c.0"]);
    expect(freeSeparator(new TextDecoder().decode(dotted.get("groups/zarr.json")))).toBe("/");
    // A v2 key ("0") is neither.
    expect(freeSeparator(JSON.stringify({ chunk_key_encoding: { name: "v2" } }))).toBe("/");
  });

  it("writes the chunks first and swaps the zarr.json files in last, the groups' after the attributes'", async () => {
    const before = groupFiles([{ name: "atlas", members: ids(1, 2) }]);
    const l = level({ "zarr.json": levelJson, ...Object.fromEntries(before) });
    await writeGroups(l.io, [{ name: "cc", members: ids(4, 5) }]);
    expect(l.writes).toEqual([
      "groups/c.0",
      "group_attributes/name/c.0",
      "group_attributes/n_objects/c.0",
      "group_attributes/name/zarr.json",
      "group_attributes/n_objects/zarr.json",
      "groups/zarr.json",
      "zarr.json",
    ]);
    // The old chunk is as it was; the new zarr.json reads the new one.
    expect(l.store.get("groups/c/0")).toBe(before.get("groups/c/0"));
    expect(JSON.parse(l.text("groups/zarr.json")!).chunk_key_encoding.configuration.separator).toBe(".");
    expect(JSON.parse(l.text("groups/zarr.json")!).attributes.group_names).toEqual(["cc"]);
    expect(JSON.parse(l.text("zarr.json")!).attributes.zarr_vectors_level.arrays_present).toEqual(["vertices", "groups"]);
    // The next save goes back the other way, beside these.
    await writeGroups(l.io, [{ name: "cst", members: ids(6) }]);
    expect(l.writes.slice(7, 10)).toEqual(["groups/c/0", "group_attributes/name/c/0", "group_attributes/n_objects/c/0"]);
  });

  it("puts the old zarr.json files back when the swap fails, so the store keeps its old groups", async () => {
    const before = groupFiles([{ name: "atlas", members: ids(1, 2) }]);
    const old = Object.fromEntries([...before].map(([k, v]) => [k, new TextDecoder().decode(v)]));
    const l = level({ "zarr.json": levelJson, ...Object.fromEntries(before) }, "groups/zarr.json");
    await expect(writeGroups(l.io, [{ name: "cc", members: ids(4) }])).rejects.toThrow("no room");
    for (const path of ["groups/zarr.json", "group_attributes/name/zarr.json", "group_attributes/n_objects/zarr.json"]) expect(l.text(path)).toBe(old[path]);
    expect(l.store.get("groups/c/0")).toBe(before.get("groups/c/0"));
    expect(l.text("zarr.json")).toBe(levelJson);
    // Nothing is swapped at all when a chunk cannot be written.
    const m = level({ "zarr.json": levelJson, ...Object.fromEntries(before) }, "group_attributes/name/c.0");
    await expect(writeGroups(m.io, [{ name: "cc", members: ids(4) }])).rejects.toThrow("no room");
    expect(m.writes).toEqual(["groups/c.0"]);
  });
});
