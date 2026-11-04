/**
 * A virtual image's store with its array axes in the order z, y, x (after
 * any others, such as t or c), under the key prefix `zyx/`: chunkmirage's
 * engine, which the Filters plugin runs, reads only images whose last axes
 * are z, y, x, and a NIfTI store (and the TIFF, MGH and NumPy stores made
 * from it) lists the file's own order, x, y, z.
 *
 * The axes, shapes and chunk shapes are permuted, a chunk key's indices
 * too, and the view has no transpose codec (the engine reads chunks in C
 * order): where the store's own transpose and the permutation cancel (a
 * NIfTI stored x, y, z, the usual case) a chunk's bytes are the store's
 * own; otherwise (an image whose axes lie y, z, x, say) they are reordered.
 * The OME metadata's level transforms and affine are permuted to match,
 * so the image lands where it did.
 *
 * `zyx/zarr.json` is absent (404) when the store is not an image with
 * axes named x, y and z; a level is absent when its chunks are in shards
 * (whose index order would change) or compressed and need reordering.
 */
import { jsonBytes, type VirtualStore } from "./store.js";

export const ZYX_PREFIX = "zyx/";

/** The order of `names` with z, y, x last (the others first, in their order); undefined without all three. */
export function zyxOrder(names: string[]): number[] | undefined {
  const spatial = ["z", "y", "x"].map((n) => names.indexOf(n));
  if (spatial.some((i) => i === -1)) return undefined;
  return [...names.map((_, i) => i).filter((i) => !spatial.includes(i)), ...spatial];
}

/** `values` in the order `order` (new axis j is old axis order[j]). */
const permute = <T>(values: T[], order: number[]): T[] => order.map((i) => values[i]);

/** The inverse of a permutation. */
function inverse(order: number[]): number[] {
  const out = new Array<number>(order.length);
  order.forEach((o, j) => (out[o] = j));
  return out;
}

const isIdentity = (order: number[]) => order.every((o, i) => o === i);

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A coordinate transform's per-axis vectors (scale, translation) permuted, through sequences. */
function permuteVectors(t: any, order: number[]): any {
  if (t?.type === "sequence") return { ...t, transformations: (t.transformations ?? []).map((u: any) => permuteVectors(u, order)) };
  if (t?.type === "scale" && Array.isArray(t.scale)) return { ...t, scale: permute(t.scale, order) };
  if (t?.type === "translation" && Array.isArray(t.translation)) return { ...t, translation: permute(t.translation, order) };
  if (t?.type === "identity") return t;
  throw new Error(`cannot reorder a ${t?.type} transform`);
}

/** A transform of `n` input axes as an affine (rows: output axes; n + 1 columns), or undefined. */
function asAffine(t: any, n: number): number[][] | undefined {
  const identity = (): number[][] => Array.from({ length: n }, (_, r) => Array.from({ length: n + 1 }, (_, c) => (r === c ? 1 : 0)));
  const times = (a: number[][], b: number[][]) =>
    a.map((row) => Array.from({ length: n + 1 }, (_, c) => row.slice(0, n).reduce((s, v, k) => s + v * b[k][c], 0) + (c === n ? row[n] : 0)));
  switch (t?.type) {
    case "identity":
      return identity();
    case "scale":
      return identity().map((row, r) => row.map((v, c) => (c < n ? v * Number(t.scale[r]) : 0)));
    case "translation":
      return identity().map((row, r) => row.map((v, c) => (c === n ? Number(t.translation[r]) : v)));
    case "affine": {
      const m: number[][] = Array.isArray(t.affine?.[0]) ? t.affine : undefined;
      if (m === undefined || m.some((row) => row.length !== n + 1)) return undefined;
      return m.map((row) => row.map(Number));
    }
    case "sequence": {
      let out = identity();
      for (const u of t.transformations ?? []) {
        const m = asAffine(u, n);
        if (m === undefined || m.length !== n) return undefined;
        out = times(m, out);
      }
      return out;
    }
  }
  return undefined;
}

/**
 * The group's metadata with the array's axes in `order`, or undefined
 * when it is not an OME multiscale image whose axes are named x, y and z.
 * Returns the order found too.
 */
export function zyxGroup(group: any): { group: any; order: number[] } | undefined {
  const ome = group?.attributes?.ome;
  const ms = ome?.multiscales?.[0];
  if (ms === undefined || !Array.isArray(ms.datasets)) return undefined;
  const nameOf = (a: any) => String(typeof a === "string" ? a : a?.name);
  try {
    if (Array.isArray(ms.coordinateSystems) && ms.coordinateSystems.length > 0) {
      // OME-Zarr 0.6: the datasets map into one system (the array's); the multiscale's transforms lead on from it.
      const first = (ms.datasets[0]?.coordinateTransformations ?? []).find((t: any) => t?.output);
      const system = typeof first?.output === "string" ? first.output : first?.output?.name;
      const at = ms.coordinateSystems.findIndex((s: any) => s.name === system);
      if (at === -1) return undefined;
      const axes = ms.coordinateSystems[at].axes ?? [];
      const order = zyxOrder(axes.map(nameOf));
      if (order === undefined) return undefined;
      const n = axes.length;
      const systems = ms.coordinateSystems.map((s: any, i: number) => (i === at ? { ...s, axes: permute(axes, order) } : s));
      const datasets = ms.datasets.map((d: any) => ({ ...d, coordinateTransformations: (d.coordinateTransformations ?? []).map((t: any) => permuteVectors(t, order)) }));
      const transforms = (ms.coordinateTransformations ?? []).map((t: any) => {
        if (t?.input !== system) return t;
        const m = asAffine(t, n);
        if (m === undefined) throw new Error(`cannot reorder a ${t?.type} transform`);
        // Columns are input axes: reordered; the last (the translation) stays.
        return { type: "affine", affine: m.map((row) => [...permute(row.slice(0, n), order), row[n]]), input: t.input, output: t.output, ...(t.name ? { name: t.name } : {}) };
      });
      const multiscale = { ...ms, coordinateSystems: systems, datasets, coordinateTransformations: transforms };
      return { group: { ...group, attributes: { ...group.attributes, ome: { ...ome, multiscales: [multiscale, ...ome.multiscales.slice(1)] } } }, order };
    }
    // OME-Zarr 0.4 and 0.5: axes beside per-axis scales and translations.
    const axes = ms.axes ?? [];
    const order = zyxOrder(axes.map(nameOf));
    if (order === undefined) return undefined;
    const multiscale = {
      ...ms,
      axes: permute(axes, order),
      datasets: ms.datasets.map((d: any) => ({ ...d, coordinateTransformations: (d.coordinateTransformations ?? []).map((t: any) => permuteVectors(t, order)) })),
      ...(ms.coordinateTransformations ? { coordinateTransformations: ms.coordinateTransformations.map((t: any) => permuteVectors(t, order)) } : {}),
    };
    return { group: { ...group, attributes: { ...group.attributes, ome: { ...ome, multiscales: [multiscale, ...ome.multiscales.slice(1)] } } }, order };
  } catch {
    return undefined;
  }
}

const ITEM_BYTES: Record<string, number> = { bool: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, float16: 2, int32: 4, uint32: 4, float32: 4, int64: 8, uint64: 8, float64: 8 };

/**
 * A level's array metadata with its axes in `order` and no transpose codec,
 * and how a chunk's stored bytes become the view's (`stored`: the view's
 * axis each stored axis is, slowest first; `chunk`, `item`: the view's
 * chunk shape and bytes a voxel); undefined when its chunks are sharded,
 * or compressed and in need of reordering.
 */
export function zyxArray(array: any, order: number[]): { meta: any; stored: number[]; chunk: number[]; item: number } | undefined {
  if (array?.node_type !== "array" || !Array.isArray(array.shape) || array.shape.length !== order.length) return undefined;
  const codecs: any[] = array.codecs ?? [];
  if (codecs.some((c) => c?.name === "sharding_indexed")) return undefined;
  const n = order.length;
  const at = codecs.findIndex((c) => c?.name === "transpose");
  const configured = at === -1 ? "C" : codecs[at].configuration?.order;
  const own: number[] = Array.isArray(configured) ? configured : configured === "F" ? order.map((_, i) => n - 1 - i) : order.map((_, i) => i);
  // Stored axis i is array axis own[i]; that axis is the view's inverse(order)[own[i]].
  const back = inverse(order);
  const stored = own.map((s) => back[s]);
  const rest = codecs.filter((_, i) => i !== at);
  const bytes = rest.findIndex((c) => c?.name === "bytes");
  if (!isIdentity(stored) && (bytes === -1 || bytes !== rest.length - 1)) return undefined;
  const item = ITEM_BYTES[String(array.data_type)];
  if (item === undefined) return undefined;
  const grid = array.chunk_grid;
  const chunk = permute<number>(grid?.configuration?.chunk_shape ?? [], order);
  const meta = {
    ...array,
    shape: permute(array.shape, order),
    chunk_grid: { ...grid, configuration: { ...grid?.configuration, chunk_shape: chunk } },
    codecs: rest,
    ...(Array.isArray(array.dimension_names) ? { dimension_names: permute(array.dimension_names, order) } : {}),
  };
  return { meta, stored, chunk, item };
}

/** A chunk's stored bytes (its axes, slowest first, the view's axes `stored`) in the view's C order. */
export function reorderChunk(bytes: Uint8Array, stored: number[], chunk: number[], item: number): Uint8Array {
  if (isIdentity(stored)) return bytes;
  const n = chunk.length;
  const storedShape = stored.map((a) => chunk[a]);
  // Strides (in voxels) of the stored layout, by the view's axis.
  const stride = new Array<number>(n).fill(0);
  let step = 1;
  for (let i = n - 1; i >= 0; --i) {
    stride[stored[i]] = step;
    step *= storedShape[i];
  }
  const count = chunk.reduce((a, b) => a * b, 1);
  if (bytes.byteLength < count * item) return bytes;
  const Typed = { 1: Uint8Array, 2: Uint16Array, 4: Uint32Array, 8: BigUint64Array }[item as 1 | 2 | 4 | 8];
  const source = new Typed(bytes.slice(0, count * item).buffer);
  const out = new Typed(count);
  const index = new Array<number>(n).fill(0);
  for (let o = 0; o < count; ++o) {
    let from = 0;
    for (let a = 0; a < n; ++a) from += index[a] * stride[a];
    out[o] = source[from];
    for (let a = n - 1; a >= 0 && ++index[a] === chunk[a]; --a) index[a] = 0;
  }
  return new Uint8Array(out.buffer);
}

/** A chunk key of the permuted array (`rest`, after its level's path) as the store's own, or undefined. */
export function zyxChunkKey(rest: string, array: any, order: number[]): string | undefined {
  const encoding = array?.chunk_key_encoding;
  const separator = String(encoding?.configuration?.separator ?? (encoding?.name === "v2" ? "." : "/"));
  let indices: string;
  let lead = "";
  if (encoding?.name === "v2") indices = rest;
  else {
    if (!rest.startsWith(`c${separator}`)) return undefined;
    lead = `c${separator}`;
    indices = rest.slice(lead.length);
  }
  const parts = indices.split(separator);
  if (parts.length !== order.length || parts.some((p) => !/^\d+$/.test(p))) return undefined;
  // New index j is old axis order[j].
  const old = new Array<string>(order.length);
  order.forEach((o, j) => (old[o] = parts[j]));
  return lead + old.join(separator);
}

const decode = (bytes: Uint8Array | undefined): any => {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
};

/** `store`, also answering `zyx/…` keys with its z, y, x view. */
export function withZyxView(store: VirtualStore): VirtualStore {
  let group: Promise<{ group: any; order: number[]; paths: string[] } | undefined> | undefined;
  const arrays = new Map<string, Promise<any>>();
  const view = () =>
    (group ??= store.get("zarr.json").then((bytes) => {
      const found = zyxGroup(decode(bytes));
      if (found === undefined) return undefined;
      const paths = (found.group.attributes.ome.multiscales[0].datasets as any[]).map((d) => String(d.path).replace(/^\/+|\/+$/g, ""));
      return { ...found, paths };
    }));
  const arrayOf = (path: string) => {
    let a = arrays.get(path);
    if (a === undefined) arrays.set(path, (a = store.get(`${path}/zarr.json`).then(decode)));
    return a;
  };
  const get = async (key: string): Promise<Uint8Array | undefined> => {
    if (!key.startsWith(ZYX_PREFIX)) return store.get(key);
    const inner = key.slice(ZYX_PREFIX.length);
    const v = await view();
    if (v === undefined) return undefined;
    if (inner === "zarr.json") return jsonBytes(v.group);
    const path = v.paths.filter((p) => inner.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0];
    if (path === undefined) return undefined;
    const rest = inner.slice(path.length + 1);
    const array = await arrayOf(path);
    const permuted = zyxArray(array, v.order);
    if (permuted === undefined) return undefined;
    if (rest === "zarr.json") return jsonBytes(permuted.meta);
    const own = zyxChunkKey(rest, array, v.order);
    const bytes = own === undefined ? undefined : await store.get(`${path}/${own}`);
    return bytes === undefined ? undefined : reorderChunk(bytes, permuted.stored, permuted.chunk, permuted.item);
  };
  const wrapped: VirtualStore = {
    get,
    list: store.list === undefined ? undefined : (prefix) => (prefix.startsWith(ZYX_PREFIX) ? undefined : store.list!(prefix)),
    message: store.message?.bind(store),
    close: store.close?.bind(store),
  };
  return wrapped;
}
