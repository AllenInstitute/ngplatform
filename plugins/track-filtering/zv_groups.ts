/**
 * Track groups written into a zarr-vectors store, as the format keeps
 * groups: a level's `groups` array (Zarr v3, vlen-bytes, one row per group:
 * its members' object ids as int64), with the names in the array's
 * `group_names` attribute and in `group_attributes/name`, and the member
 * counts in `group_attributes/n_objects` (as zarr-vectors-py writes them).
 * The viewer then shows each group as a segment tag.
 */

export interface StoredGroup {
  name: string;
  /** Object ids (the store's, not Neuroglancer's segment ids). */
  members: BigUint64Array;
}

/** The files to write (path under the level → bytes). */
export type GroupFiles = Map<string, Uint8Array>;

/** A vlen chunk: the item count, then each item's length and bytes (little-endian u32s). */
export function vlenChunk(items: Uint8Array[]): Uint8Array {
  const size = 4 + items.reduce((n, item) => n + 4 + item.byteLength, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, items.length, true);
  let at = 4;
  for (const item of items) {
    view.setUint32(at, item.byteLength, true);
    out.set(item, at + 4);
    at += 4 + item.byteLength;
  }
  return out;
}

function arrayJson(n: number, dataType: string, codec: object, fill: unknown, attributes: object = {}): Uint8Array {
  const json = {
    zarr_format: 3,
    node_type: "array",
    shape: [n],
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: [Math.max(1, n)] } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: fill,
    codecs: [codec],
    attributes,
  };
  return new TextEncoder().encode(JSON.stringify(json, null, 2));
}

/** Merges groups by name: a group with a stored one's name replaces it; others are added after. */
export function mergeGroups(stored: StoredGroup[], mine: StoredGroup[]): StoredGroup[] {
  const out = stored.map((g) => ({ ...g }));
  for (const group of mine) {
    const at = out.findIndex((g) => g.name === group.name);
    if (at === -1) out.push(group);
    else out[at] = group;
  }
  return out;
}

/** The files of a level's groups. */
export function groupFiles(groups: StoredGroup[]): GroupFiles {
  const n = groups.length;
  const names = groups.map((g) => g.name);
  const files: GroupFiles = new Map();
  files.set(
    "groups/zarr.json",
    arrayJson(n, "variable_length_bytes", { name: "vlen-bytes", configuration: {} }, "", { zv_array: "groups", num_groups: n, group_names: names, written_by: "ngplatform track filtering" }),
  );
  files.set("groups/c/0", vlenChunk(groups.map((g) => new Uint8Array(g.members.buffer, g.members.byteOffset, g.members.byteLength))));
  files.set("group_attributes/name/zarr.json", arrayJson(n, "string", { name: "vlen-utf8", configuration: {} }, "", { zv_array: "groupings_attribute", name: "name" }));
  files.set("group_attributes/name/c/0", vlenChunk(names.map((name) => new TextEncoder().encode(name))));
  files.set(
    "group_attributes/n_objects/zarr.json",
    arrayJson(n, "int64", { name: "bytes", configuration: { endian: "little" } }, 0, { zv_array: "groupings_attribute", name: "n_objects" }),
  );
  const counts = new BigInt64Array(n);
  groups.forEach((g, i) => (counts[i] = BigInt(g.members.length)));
  files.set("group_attributes/n_objects/c/0", new Uint8Array(counts.buffer));
  return files;
}

/** The level's zarr.json with `groups` among its arrays, from its current text. */
export function withGroupsListed(levelJson: string): string {
  const json = JSON.parse(levelJson);
  const level = json?.attributes?.zarr_vectors_level;
  if (level !== undefined) {
    const present: string[] = Array.isArray(level.arrays_present) ? level.arrays_present : [];
    if (!present.includes("groups")) level.arrays_present = [...present, "groups"];
  }
  return JSON.stringify(json, null, 2);
}
