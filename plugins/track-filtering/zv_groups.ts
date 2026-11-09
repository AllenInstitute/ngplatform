/**
 * Track groups written into a zarr-vectors store, as the format keeps
 * groups: a level's `groups` array (Zarr v3, vlen-bytes, one row per group:
 * its members' object ids as int64), with the names in the array's
 * `group_names` attribute and in `group_attributes/name`, and the member
 * counts in `group_attributes/n_objects` (as zarr-vectors-py writes them).
 * The viewer then shows each group as a segment tag.
 *
 * `writeGroups` writes them so that a reader sees the old groups or the
 * new, never a mix: the new chunks go beside the old ones, and each array's
 * zarr.json is the swap.
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

/** The separator between a chunk key's parts: "c/0" or "c.0". */
export type Separator = "/" | ".";

/** The arrays of a level's groups, under the level. */
export const GROUP_ARRAYS = ["groups", "group_attributes/name", "group_attributes/n_objects"] as const;
type GroupArray = (typeof GROUP_ARRAYS)[number];

function arrayJson(n: number, dataType: string, codec: object, fill: unknown, attributes: object, separator: Separator): Uint8Array {
  const json = {
    zarr_format: 3,
    node_type: "array",
    shape: [n],
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: [Math.max(1, n)] } },
    chunk_key_encoding: { name: "default", configuration: { separator } },
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

/**
 * The files of a level's groups; each array's chunk key with its own
 * separator (`/` unless `separators` says otherwise).
 */
export function groupFiles(groups: StoredGroup[], separators: Partial<Record<GroupArray, Separator>> = {}): GroupFiles {
  const n = groups.length;
  const names = groups.map((g) => g.name);
  const files: GroupFiles = new Map();
  const sep = (array: GroupArray) => separators[array] ?? "/";
  files.set(
    "groups/zarr.json",
    arrayJson(n, "variable_length_bytes", { name: "vlen-bytes", configuration: {} }, "", { zv_array: "groups", num_groups: n, group_names: names, written_by: "ngplatform track filtering" }, sep("groups")),
  );
  files.set(`groups/c${sep("groups")}0`, vlenChunk(groups.map((g) => new Uint8Array(g.members.buffer, g.members.byteOffset, g.members.byteLength))));
  files.set("group_attributes/name/zarr.json", arrayJson(n, "string", { name: "vlen-utf8", configuration: {} }, "", { zv_array: "groupings_attribute", name: "name" }, sep("group_attributes/name")));
  files.set(`group_attributes/name/c${sep("group_attributes/name")}0`, vlenChunk(names.map((name) => new TextEncoder().encode(name))));
  files.set(
    "group_attributes/n_objects/zarr.json",
    arrayJson(n, "int64", { name: "bytes", configuration: { endian: "little" } }, 0, { zv_array: "groupings_attribute", name: "n_objects" }, sep("group_attributes/n_objects")),
  );
  const counts = new BigInt64Array(n);
  groups.forEach((g, i) => (counts[i] = BigInt(g.members.length)));
  files.set(`group_attributes/n_objects/c${sep("group_attributes/n_objects")}0`, new Uint8Array(counts.buffer));
  return files;
}

/**
 * The separator a new chunk goes under: the one an array's current zarr.json
 * does not use, so its chunk is written beside the old one, not over it.
 */
export function freeSeparator(arrayJson: string | undefined): Separator {
  if (arrayJson === undefined) return "/";
  const encoding = JSON.parse(arrayJson)?.chunk_key_encoding;
  // The default encoding's keys are "c/0" or "c.0"; v2's ("0") are neither.
  return encoding?.name === "default" && (encoding.configuration?.separator ?? "/") === "/" ? "." : "/";
}

/** Reading and writing a level's files, by path under the level; `read` gives undefined for a file that is not there. */
export interface LevelFiles {
  read(path: string): Promise<string | undefined>;
  write(path: string, data: Uint8Array | string): Promise<void>;
}

/**
 * Writes a level's groups, replacing those it has, so that a reader sees the
 * old groups or the new, never a mix.  Each array's chunk is written beside
 * the old one (under the other chunk key, see freeSeparator), which nothing
 * reads yet; then each array's zarr.json, which points at it, is the swap
 * (a file is replaced whole: the browser writes it aside and moves it in on
 * close), the groups array's last; then the level lists `groups`.  When a
 * zarr.json cannot be written, those already swapped are put back as they
 * were, so the store keeps its old groups, and the error is thrown.
 */
export async function writeGroups(files: LevelFiles, groups: StoredGroup[]): Promise<void> {
  const before = new Map<GroupArray, string | undefined>();
  for (const array of GROUP_ARRAYS) before.set(array, await files.read(`${array}/zarr.json`));
  const levelJson = await files.read("zarr.json");
  if (levelJson === undefined) throw new Error("the level's zarr.json could not be read");
  const separators = Object.fromEntries(GROUP_ARRAYS.map((a) => [a, freeSeparator(before.get(a))])) as Record<GroupArray, Separator>;
  const written = groupFiles(groups, separators);
  // The chunks: beside the old ones, read by nothing until the swap.
  for (const [path, bytes] of written) if (!path.endsWith("zarr.json")) await files.write(path, bytes);
  // The swap: the attributes first, the groups (what readers open first) last.
  const order: GroupArray[] = ["group_attributes/name", "group_attributes/n_objects", "groups"];
  const swapped: GroupArray[] = [];
  try {
    for (const array of order) {
      await files.write(`${array}/zarr.json`, written.get(`${array}/zarr.json`)!);
      swapped.push(array);
    }
    await files.write("zarr.json", withGroupsListed(levelJson));
  } catch (e) {
    // Back as they were: the old chunks are still there.  (An array that was not there before stays; nothing reads it without the groups array.)
    for (const array of swapped.reverse()) {
      const old = before.get(array);
      if (old !== undefined) await files.write(`${array}/zarr.json`, old).catch(() => {});
    }
    throw e;
  }
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
