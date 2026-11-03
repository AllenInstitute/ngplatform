/**
 * A level of a virtual image store read back whole, as a volume to write
 * out: the store's own keys (`zarr.json`, `<level>/zarr.json`, the chunks)
 * reassembled, x fastest, with its voxel-to-RAS placement from the
 * multiscales metadata (the 0.6 affine from the array's axes to the world,
 * and the level's scale and translation).  Works on any store that writes
 * OME-Zarr 0.6 as the platform's image stores do.
 */
import { invert4, type Mat4, multiply4 } from "../../core/mat4.js";
import type { VirtualStore } from "../images/store.js";
import { ARRAYS, type Volume, type VoxelType } from "./volume.js";

const json = async (store: VirtualStore, key: string): Promise<any> => {
  const bytes = await store.get(key);
  if (bytes === undefined) throw new Error(`the store has no ${key}`);
  return JSON.parse(new TextDecoder().decode(bytes));
};

export interface LevelInfo {
  path: string;
  /** Voxels along the spatial axes (i, j, k). */
  size: [number, number, number];
  type: VoxelType;
  bytes: number;
  voxelToRas: Mat4;
}

/** A dataset's transform (scale, translation, or a sequence of them) as a 4 × 4 on the spatial axes. */
function levelMatrix(transforms: any[] | undefined, spatial: number[]): Mat4 {
  let m: Mat4 = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const apply = (t: any) => {
    if (t.type === "sequence") {
      for (const inner of t.transformations ?? []) apply(inner);
      return;
    }
    const step = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    spatial.forEach((axis, k) => {
      if (t.type === "scale") step[5 * k] = t.scale[axis];
      if (t.type === "translation") step[4 * k + 3] = t.translation[axis];
    });
    // Each transformation applies after the ones before it.
    m = multiply4(step, m);
  };
  for (const t of transforms ?? []) apply(t);
  return m;
}

/** The store's levels, finest first, with their sizes and placements. */
export async function storeLevels(store: VirtualStore): Promise<{ levels: LevelInfo[]; extra: number; label: boolean }> {
  const group = await json(store, "zarr.json");
  const ms = group.attributes?.ome?.multiscales?.[0];
  if (ms === undefined) throw new Error("the store has no multiscales");
  const arraySpace = (ms.coordinateSystems ?? []).find((c: any) => c.name === "array");
  const names: string[] = (arraySpace?.axes ?? []).map((a: any) => a.name);
  const spatial = names.map((n, i) => (["x", "y", "z"].includes(n) ? i : -1)).filter((i) => i !== -1);
  if (spatial.length !== 3) throw new Error("the store's image is not three-dimensional");
  const world = (ms.coordinateSystems ?? []).find((c: any) => c.name !== "array");
  const worldNames: string[] = (world?.axes ?? []).map((a: any) => a.name);
  const affine: number[][] | undefined = (ms.coordinateTransformations ?? []).find((t: any) => t.type === "affine")?.affine;
  // Array (spatial) to world x, y, z.
  const toWorld = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  if (affine !== undefined) {
    ["x", "y", "z"].forEach((w, r) => {
      const row = affine[worldNames.indexOf(w)];
      if (row === undefined) return;
      spatial.forEach((axis, c) => (toWorld[4 * r + c] = row[axis]));
      toWorld[4 * r + 3] = row[row.length - 1];
    });
  }
  const levels: LevelInfo[] = [];
  for (const dataset of ms.datasets ?? []) {
    const meta = await json(store, `${dataset.path}/zarr.json`);
    const size = spatial.map((a) => meta.shape[a]) as [number, number, number];
    const type = meta.data_type as VoxelType;
    const per = ARRAYS[type]?.BYTES_PER_ELEMENT ?? 4;
    levels.push({ path: dataset.path, size, type, bytes: size[0] * size[1] * size[2] * per, voxelToRas: multiply4(toWorld, levelMatrix(dataset.coordinateTransformations, spatial)) });
  }
  // Label images are downsampled by picking, not averaging.
  const label = ms.type === "nearest";
  return { levels, extra: names.length - 3, label };
}

/**
 * Reads one level whole, or the box `region` of it (voxel indices, `hi`
 * exclusive), x fastest; the first time point or component of a 4-D image.
 */
export async function readLevel(store: VirtualStore, level: LevelInfo, onProgress?: (done: number, total: number) => void, region?: { lo: number[]; hi: number[] }): Promise<Volume> {
  const meta = await json(store, `${level.path}/zarr.json`);
  const shape: number[] = meta.shape;
  const chunk: number[] = meta.chunk_grid.configuration.chunk_shape;
  const order: number[] = meta.codecs.find((c: any) => c.name === "transpose")?.configuration.order ?? shape.map((_: number, d: number) => d);
  const rank = shape.length;
  const spatial = [rank - 3, rank - 2, rank - 1];
  const lo = [0, 1, 2].map((k) => Math.max(0, Math.min(level.size[k], Math.floor(region?.lo[k] ?? 0))));
  const hi = [0, 1, 2].map((k) => Math.max(lo[k], Math.min(level.size[k], Math.ceil(region?.hi[k] ?? level.size[k]))));
  const size = [0, 1, 2].map((k) => hi[k] - lo[k]) as [number, number, number];
  const [ni, nj] = size;
  const Array_ = ARRAYS[level.type];
  if (Array_ === undefined) throw new Error(`${level.type} images cannot be written yet`);
  const out = new Array_(size[0] * size[1] * size[2]);
  // The chunks the box touches, along each axis.
  const first = shape.map((_, d) => (d < rank - 3 ? 0 : Math.floor(lo[d - (rank - 3)] / chunk[d])));
  const grid = shape.map((n, d) => (d < rank - 3 ? 1 : Math.max(0, Math.ceil(hi[d - (rank - 3)] / chunk[d]) - first[d])));
  const total = grid.reduce((a, b) => a * b, 1);
  let done = 0;
  const index = shape.map(() => 0);
  for (let n = 0; n < total; ++n) {
    let rest = n;
    for (let d = rank - 1; d >= 0; --d) {
      index[d] = first[d] + (rest % grid[d]);
      rest = Math.floor(rest / grid[d]);
    }
    const bytes = await store.get(`${level.path}/c/${index.join("/")}`);
    if (bytes !== undefined) {
      const data = new Array_(bytes.slice().buffer);
      const local = chunk.map(() => 0);
      for (let flat = 0; flat < data.length; ++flat) {
        const g = spatial.map((d, k) => index[d] * chunk[d] + local[d] - lo[k]);
        if (local.slice(0, rank - 3).every((v) => v === 0) && g.every((v, k) => v >= 0 && v < size[k])) {
          out[g[0] + ni * (g[1] + nj * g[2])] = data[flat];
        }
        // The next element in stored order: the last stored axis fastest.
        for (let s = order.length - 1; s >= 0; --s) {
          const d = order[s];
          if (++local[d] < chunk[d]) break;
          local[d] = 0;
        }
      }
    }
    onProgress?.(++done, total);
  }
  const shift = Float64Array.from([1, 0, 0, lo[0], 0, 1, 0, lo[1], 0, 0, 1, lo[2], 0, 0, 0, 1]);
  return { data: out, size, type: level.type, voxelToRas: multiply4(level.voxelToRas, shift) };
}

/** The box of `size` voxels (along each axis, at most the level's) of a level centred on a point (RAS mm). */
export function regionAround(level: LevelInfo, centre: number[], size: number): { lo: number[]; hi: number[] } {
  const inverse = invert4(level.voxelToRas);
  const at = [0, 1, 2].map((r) => inverse[4 * r] * centre[0] + inverse[4 * r + 1] * centre[1] + inverse[4 * r + 2] * centre[2] + inverse[4 * r + 3]);
  const lo = at.map((v, k) => Math.max(0, Math.min(level.size[k] - Math.min(size, level.size[k]), Math.round(v - size / 2))));
  return { lo, hi: lo.map((v, k) => Math.min(level.size[k], v + size)) };
}
