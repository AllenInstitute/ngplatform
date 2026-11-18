/**
 * Format 0.10 stores, read as 0.9 ones.
 *
 * Zarr Vectors 0.10.0 moved the metadata onto the Zarr Vectors convention;
 * the data (every cell's bytes) is that of 0.9.4. Every node's properties
 * now sit under one attribute, `zarr_vectors`, told apart by `kind`:
 *
 * - **root:** the `zarr_vectors` block as before, plus its `axes`. The NGFF
 *   `multiscales` list becomes the multiscales convention's
 *   `{layout: [{asset: "<level>"}]}`.
 * - **level:** `zarr_vectors_level` becomes `zarr_vectors` with
 *   `kind: "level"`, and its `zarr_vectors_presence` becomes `presence`.
 * - **arrays:** the fields that sat beside `zv_array` (`dtype`,
 *   `nonempty_chunks`, `link_width`, `offsets`, …) move inside it, `kind`
 *   naming the array kind. Two kinds are renamed: `attribute` became
 *   `vertex_attribute`, and `groupings_attribute` became `group_attribute`.
 *
 * {@link asFormat09} gives a parsed `zarr.json` of either version in 0.9's
 * shape, so the rest of the reader knows only one. Every place that parses
 * a store's `zarr.json` passes it through.
 */

/** 0.10's array kinds whose 0.9 names differ. */
const RENAMED: Record<string, string> = {
  vertex_attribute: "attribute",
  group_attribute: "groupings_attribute",
};

/** A parsed `zarr.json` in 0.9's shape: 0.10's moved back; anything else as it is. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function asFormat09(json: any): any {
  const attrs = json?.attributes;
  const zv = attrs?.zarr_vectors;
  if (zv === null || typeof zv !== "object" || typeof zv.kind !== "string") return json;
  const { kind, ...rest } = zv;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any = { ...attrs };
  delete out.zarr_vectors;
  if (kind === "root") {
    out.zarr_vectors = rest;
    const layout = attrs.multiscales?.layout;
    if (Array.isArray(layout)) {
      out.multiscales = [
        {
          ...(Array.isArray(rest.axes) ? { axes: rest.axes } : {}),
          datasets: layout
            .map((l: { asset?: unknown }) => l?.asset)
            .filter((a: unknown): a is string => typeof a === "string")
            .map((path: string) => ({ path })),
        },
      ];
    }
  } else if (kind === "level") {
    const { presence, ...level } = rest;
    out.zarr_vectors_level = level;
    if (presence !== undefined) out.zarr_vectors_presence = presence;
  } else {
    Object.assign(out, rest);
    out.zv_array = RENAMED[kind] ?? kind;
  }
  return { ...json, attributes: out };
}
