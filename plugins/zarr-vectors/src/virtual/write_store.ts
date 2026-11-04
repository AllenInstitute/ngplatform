/**
 * Test-only: a virtual store written out as a folder, for checking with
 * zarr-vectors-py (its validator, its readers).
 */
import fs from "node:fs";
import path from "node:path";

/** Writes every key of a store into a folder: each group and array's zarr.json, and every chunk its metadata names. */
export async function writeStore(store: { get(key: string): Promise<Uint8Array | undefined>; list(prefix: string): string[] | undefined }, dir: string): Promise<number> {
  let written = 0;
  const put = async (key: string) => {
    const bytes = await store.get(key);
    if (bytes === undefined) return undefined;
    fs.mkdirSync(path.dirname(path.join(dir, key)), { recursive: true });
    fs.writeFileSync(path.join(dir, key), bytes);
    ++written;
    return bytes;
  };
  const walk = async (prefix: string) => {
    const meta = await put(`${prefix}zarr.json`);
    if (meta !== undefined) {
      const json = JSON.parse(new TextDecoder().decode(meta));
      if (json.node_type === "array") {
        const attrs = json.attributes ?? {};
        if (Array.isArray(attrs.nonempty_chunks)) {
          const origin: number[] = attrs.chunk_grid_origin ?? [0, 0, 0];
          for (const c of attrs.nonempty_chunks as string[]) await put(`${prefix}c/${c.split(".").map((v, k) => Number(v) - origin[k]).join("/")}`);
        } else {
          const rows = json.chunk_grid.configuration.chunk_shape[0];
          for (let i = 0; i * rows < json.shape[0]; ++i) await put(`${prefix}c/${i}`);
        }
        return;
      }
    }
    for (const name of store.list(prefix) ?? []) if (name.endsWith("/")) await walk(`${prefix}${name}`);
  };
  await walk("");
  return written;
}
