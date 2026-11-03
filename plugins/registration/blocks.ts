/**
 * Saving a moved image larger than memory holds, as OME-Zarr written into
 * a folder: the output grid in blocks of BLOCK voxels a side, each made by
 * reading only the box of the source it needs (with a margin for the
 * interpolation, and for the cubic B-spline's prefilter, whose influence
 * falls below 1e-6 within it) and resampling that.  Each block writes its
 * chunks of levels 0 to 2 (it halves to 128 and 64 voxels, whole chunks);
 * level 3, an eighth a side, is kept in memory and the coarser levels are
 * made from it at the end, with the metadata.
 */
import { displayWindow, gzip, halve, type LevelGrid, MGH_FOOTER_BYTES, mghBody, mghHeader, niftiHeader, omeZarrMetadata, pyramidGrids } from "@ngplatform/sdk/volume_out";
import { invert4, type Mat4, multiply4 } from "./fit.js";
import { ARRAYS, type Method, resample, type TypedArray, type Volume, type VoxelType } from "./volume_io.js";

export const BLOCK = 256;
const CHUNK = 64;
/** Levels written block by block (each block halves to whole chunks down to this one). */
const BLOCK_LEVELS = 3;

const translate = (t: number[]): Mat4 => Float64Array.from([1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1]);

/**
 * The source voxels (x, y, z, `hi` exclusive) that the output voxels from
 * `lo` to `hi` (exclusive) need, given the map from output voxels to
 * source voxels; undefined when they fall outside the source.
 */
export function sourceBox(toSource: Mat4, lo: number[], hi: number[], margin: number, size: number[]): { lo: [number, number, number]; hi: [number, number, number] } | undefined {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; ++c) {
    const p = [0, 1, 2].map((k) => ((c >> k) & 1 ? hi[k] - 1 : lo[k]));
    for (let r = 0; r < 3; ++r) {
      const v = toSource[4 * r] * p[0] + toSource[4 * r + 1] * p[1] + toSource[4 * r + 2] * p[2] + toSource[4 * r + 3];
      min[r] = Math.min(min[r], v);
      max[r] = Math.max(max[r], v);
    }
  }
  const from = min.map((v, k) => Math.max(0, Math.floor(v) - margin)) as [number, number, number];
  const to = max.map((v, k) => Math.min(size[k], Math.ceil(v) + 1 + margin)) as [number, number, number];
  return from.some((v, k) => v >= to[k]) ? undefined : { lo: from, hi: to };
}

/** A block's chunks (zero ones left out: the fill value), gzipped, by key, for a block whose first voxel is at `origin` (multiples of CHUNK). */
export async function blockChunks(block: Volume, origin: number[], path: string): Promise<[string, Uint8Array][]> {
  const [nx, ny, nz] = block.size;
  const out: [string, Uint8Array][] = [];
  const chunk = new ARRAYS[block.type](CHUNK ** 3);
  for (let cz = 0; cz * CHUNK < nz; ++cz) {
    for (let cy = 0; cy * CHUNK < ny; ++cy) {
      for (let cx = 0; cx * CHUNK < nx; ++cx) {
        chunk.fill(0);
        let any = false;
        const run = Math.min(CHUNK, nx - cx * CHUNK);
        for (let z = 0; z < CHUNK && cz * CHUNK + z < nz; ++z) {
          for (let y = 0; y < CHUNK && cy * CHUNK + y < ny; ++y) {
            const from = cx * CHUNK + nx * (cy * CHUNK + y + ny * (cz * CHUNK + z));
            const row = block.data.subarray(from, from + run);
            chunk.set(row as never, (z * CHUNK + y) * CHUNK);
            if (!any) any = row.some((v) => v !== 0);
          }
        }
        if (!any) continue;
        const key = [origin[2] / CHUNK + cz, origin[1] / CHUNK + cy, origin[0] / CHUNK + cx].join("/");
        out.push([`${path}/c/${key}`, await gzip(new Uint8Array(chunk.buffer.slice(0)))]);
      }
    }
  }
  return out;
}

/** Copies `block` into `into` at `origin`. */
function paste(into: Volume, block: Volume, origin: number[]): void {
  const [nx, ny, nz] = block.size;
  for (let z = 0; z < nz; ++z) {
    for (let y = 0; y < ny; ++y) {
      const from = nx * (y + ny * z);
      into.data.set(block.data.subarray(from, from + nx) as never, origin[0] + into.size[0] * (origin[1] + y + into.size[1] * (origin[2] + z)));
    }
  }
}

/** Margin of source voxels around a box, for the interpolation (and the B-spline prefilter). */
const marginFor = (method: Method) => (method === "cubic" ? 16 : method === "linear" ? 2 : 1);

/** The output voxels from `lo` to `hi` (exclusive) of `grid`, resampled from only the source box they need. */
async function resampleBox(source: BlockSource, grid: LevelGrid, move: Mat4, method: Method, lo: number[], hi: number[], toSource: Mat4, margin: number): Promise<Volume> {
  const size = hi.map((v, k) => v - lo[k]) as [number, number, number];
  const block: Volume = { data: new ARRAYS[source.type](size[0] * size[1] * size[2]), size, type: source.type, voxelToRas: multiply4(grid.voxelToRas, translate(lo)) };
  const box = sourceBox(toSource, lo, hi, margin, source.size);
  if (box === undefined) return block;
  const region: Volume = { data: (await source.read(box.lo, box.hi)) as unknown as TypedArray, size: box.hi.map((v, k) => v - box.lo[k]) as [number, number, number], type: source.type, voxelToRas: multiply4(source.voxelToRas, translate(box.lo)) };
  return { ...block, data: resample(region, block, move, method) };
}

/**
 * The moved image on `grid` as one NIfTI (`.nii`) or MGH file, handed to
 * `write` in order (header, then the voxels a slab of z planes at a time,
 * each slab read from only the source box it needs; for MGH the footer),
 * so a file of any size is written without being held.  The display window
 * in a NIfTI header is `window` (from a coarse level: the voxels are not all
 * seen before the header is written).
 */
export async function saveInSlabs(
  source: BlockSource,
  grid: LevelGrid,
  move: Mat4,
  options: { method: Method; label: boolean; format: "nii" | "mgh"; description: string; window?: [number, number]; placement?: Mat4; slabVoxels?: number },
  write: (bytes: Uint8Array) => Promise<void>,
  progress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const toSource = multiply4(invert4(source.voxelToRas), multiply4(invert4(move), grid.voxelToRas));
  const method = options.label ? "nearest" : options.method;
  const margin = marginFor(method);
  const placed = { size: grid.size, type: source.type, voxelToRas: options.placement ?? grid.voxelToRas };
  await write(options.format === "nii" ? niftiHeader(placed, { label: options.label, window: options.label ? undefined : options.window, description: options.description.slice(0, 79) }) : mghHeader(placed));
  // Slabs of about `slabVoxels` voxels, whole planes, at most a block deep; each made of
  // tiles a block across, so a turned image reads only a block's worth of source at once.
  const [nx, ny, nz] = grid.size;
  const depth = Math.max(1, Math.min(nz, BLOCK, Math.floor((options.slabVoxels ?? 32 * 2 ** 20) / (nx * ny))));
  for (let z = 0; z < nz; z += depth) {
    signal.throwIfAborted();
    const d = Math.min(nz, z + depth) - z;
    const slab: Volume = { data: new ARRAYS[source.type](nx * ny * d), size: [nx, ny, d], type: source.type, voxelToRas: grid.voxelToRas };
    for (let y = 0; y < ny; y += BLOCK) {
      for (let x = 0; x < nx; x += BLOCK) {
        const tile = await resampleBox(source, grid, move, method, [x, y, z], [Math.min(nx, x + BLOCK), Math.min(ny, y + BLOCK), z + d], toSource, margin);
        paste(slab, tile, [x, y, 0]);
      }
    }
    await write(options.format === "nii" ? new Uint8Array(slab.data.buffer, slab.data.byteOffset, slab.data.byteLength) : mghBody(slab.data, source.type));
    progress(Math.min(grid.size[2], z + depth), grid.size[2]);
  }
  if (options.format === "mgh") await write(new Uint8Array(MGH_FOOTER_BYTES));
}

export interface BlockSource {
  /** The source level's voxels along x, y, z and their placement. */
  size: [number, number, number];
  voxelToRas: Mat4;
  type: VoxelType;
  /** Its values in a box (x fastest). */
  read(lo: [number, number, number], hi: [number, number, number]): Promise<Float32Array>;
}

/**
 * The moved image on `grid` as OME-Zarr files, handed to `write` as they
 * are made (chunks of levels 0 to 2 block by block, then the coarser
 * levels and the metadata).  `move` takes the source's RAS to the output's;
 * `placement`, when given, is written as level 0's placement instead of the
 * grid's (the voxels kept, a new header).
 */
export async function saveInBlocks(
  source: BlockSource,
  grid: LevelGrid,
  move: Mat4,
  options: { method: Method; label: boolean; name: string; description: string; placement?: Mat4 },
  write: (files: [string, Uint8Array][]) => Promise<void>,
  progress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const toSource = multiply4(invert4(source.voxelToRas), multiply4(invert4(move), grid.voxelToRas));
  const method = options.label ? "nearest" : options.method;
  const margin = marginFor(method);
  const levels = pyramidGrids({ size: grid.size, voxelToRas: options.placement ?? grid.voxelToRas }, options.label);
  const kept = Math.min(BLOCK_LEVELS, levels.length - 1);
  // The first level made whole, in memory: an eighth a side.
  const coarse: Volume = { data: new ARRAYS[source.type](levels[kept].size[0] * levels[kept].size[1] * levels[kept].size[2]), size: levels[kept].size, type: source.type, voxelToRas: levels[kept].voxelToRas };
  const counts = grid.size.map((n) => Math.ceil(n / BLOCK));
  const total = counts[0] * counts[1] * counts[2];
  let done = 0;
  for (let bz = 0; bz < counts[2]; ++bz) {
    for (let by = 0; by < counts[1]; ++by) {
      for (let bx = 0; bx < counts[0]; ++bx) {
        signal.throwIfAborted();
        const lo = [bx, by, bz].map((b) => b * BLOCK);
        const hi = lo.map((v, k) => Math.min(grid.size[k], v + BLOCK));
        const size = hi.map((v, k) => v - lo[k]) as [number, number, number];
        let block = await resampleBox(source, grid, move, method, lo, hi, toSource, margin);
        let origin = lo;
        for (let l = 0; ; ++l) {
          if (l === kept) {
            paste(coarse, block, origin);
            break;
          }
          await write(await blockChunks(block, origin, String(l)));
          block = halve(block, options.label);
          origin = origin.map((v) => v / 2);
        }
        progress(++done, total);
      }
    }
  }
  // The coarser levels, from the one in memory.
  let level = coarse;
  for (let l = kept; l < levels.length; ++l) {
    signal.throwIfAborted();
    await write(await blockChunks(level, [0, 0, 0], String(l)));
    if (l + 1 < levels.length) level = halve(level, options.label);
  }
  const window = options.label ? undefined : displayWindow(coarse.data);
  await write([...omeZarrMetadata(levels, source.type, options.name, { label: options.label, window, description: options.description })]);
}
