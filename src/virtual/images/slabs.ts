/**
 * Slabs: the unit in which a virtual image's coarser levels are computed.
 *
 * A slab of a level is one row of its chunks: the chunks' depth of z
 * planes, the chunks' height of rows, and the whole width (or, for a very
 * wide image, a part of the width, whole chunks, kept under a size in
 * bytes).  A file is read in slabs of level 0 (each byte once: strips and
 * rows are read whole across the width anyway), and a slab of level k is
 * made from the slabs of level k − 1 inside it, one at a time, then they are
 * dropped.  So making the coarsest level reads the file once, holding about
 * one slab per level, and on the way every level's chunks pass by once to
 * be kept (the overview cache) or written (Export → OME-Zarr).
 *
 * Coordinates are a level's voxels along i, j, k (x, y, z in the file's
 * order); a slab's data is its volumes (slots) one after another, each
 * k, j, i with i fastest, sized exactly to the slab (no padding).
 */

/** A level's grid, as slabs need it. */
export interface Grid {
  /** Voxels along i, j, k. */
  size: number[];
  /** Chunk size along i, j, k. */
  chunk: number[];
  /** How this level halves the finer one, along i, j, k (2 or 1). */
  step: number[];
}

/** A box of a level's voxels: [lo, hi) along i, j, k. */
export interface Box {
  lo: number[];
  hi: number[];
}

/** Any typed array of voxels. */
export type Voxels = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array | BigUint64Array | BigInt64Array;

export interface Slab {
  box: Box;
  /** Volumes held, one after another (time points or components kept together in a chunk). */
  slots: number;
  data: Voxels;
}

const extent = (box: Box) => box.hi.map((h, a) => h - box.lo[a]);

export function boxVoxels(box: Box): number {
  return extent(box).reduce((a, b) => a * b, 1);
}

/**
 * The width (voxels along i) of a level's slabs: whole chunks, as many as
 * keep one slab of `slots` volumes of `bytes` a voxel under `limit` bytes,
 * at least one chunk, at most the chunks across the level (a slab is cut
 * off at the level's edge).
 */
export function slabWidth(grid: Grid, bytes: number, slots: number, limit: number): number {
  const column = grid.chunk[0] * grid.chunk[1] * grid.chunk[2] * bytes * slots;
  const chunks = Math.max(1, Math.floor(limit / column));
  return Math.min(Math.ceil(grid.size[0] / grid.chunk[0]), chunks) * grid.chunk[0];
}

/** The slab of a level that holds chunk `b` (chunk indices along i, j, k), slabs being `width` voxels wide. */
export function slabOf(grid: Grid, b: number[], width: number): Box {
  const x0 = Math.floor((b[0] * grid.chunk[0]) / width) * width;
  return {
    lo: [x0, b[1] * grid.chunk[1], b[2] * grid.chunk[2]],
    hi: [Math.min(grid.size[0], x0 + width), Math.min(grid.size[1], (b[1] + 1) * grid.chunk[1]), Math.min(grid.size[2], (b[2] + 1) * grid.chunk[2])],
  };
}

/** Every slab of a level, z rows slowest, then y, then pieces of the width. */
export function levelSlabs(grid: Grid, width: number): Box[] {
  return finerPieces(grid, { lo: [0, 0, 0], hi: [...grid.size] }, width);
}

/** The chunk rows (and pieces of `width`) of `grid` that tile a chunk-aligned box of it. */
function finerPieces(grid: Grid, box: Box, width: number): Box[] {
  const out: Box[] = [];
  const [, cj, ck] = grid.chunk;
  for (let z = box.lo[2]; z < box.hi[2]; z += ck) {
    for (let y = box.lo[1]; y < box.hi[1]; y += cj) {
      for (let x = box.lo[0]; x < box.hi[0]; x += width) {
        out.push({ lo: [x, y, z], hi: [Math.min(box.hi[0], x + width), Math.min(box.hi[1], y + cj, grid.size[1]), Math.min(box.hi[2], z + ck, grid.size[2])] });
      }
    }
  }
  return out;
}

/**
 * The slabs of the finer level that make up `box` of the coarser one
 * (`grid` the coarser level's, its `step` the halving): the finer voxels
 * under the box, cut into the finer level's chunk rows and pieces of
 * `width`.  A box of whole chunks always covers whole chunks of the finer
 * level, since the chunk size is the same at every level (or the level's
 * whole size, when smaller).
 */
export function finerSlabs(grid: Grid, finer: Grid, box: Box, width: number): Box[] {
  const lo = box.lo.map((v, a) => v * grid.step[a]);
  const hi = box.hi.map((v, a) => Math.min(finer.size[a], v * grid.step[a]));
  if (lo.some((v, a) => v % finer.chunk[a] !== 0)) throw new Error(`a box at ${box.lo} does not start on the finer level's chunks`);
  return finerPieces(finer, { lo, hi }, width);
}

/** The chunks (indices along i, j, k) a chunk-aligned box holds. */
export function chunksOf(grid: Grid, box: Box): number[][] {
  const out: number[][] = [];
  const first = box.lo.map((v, a) => Math.floor(v / grid.chunk[a]));
  const last = box.hi.map((v, a) => Math.ceil(v / grid.chunk[a]));
  for (let k = first[2]; k < last[2]; ++k) for (let j = first[1]; j < last[1]; ++j) for (let i = first[0]; i < last[0]; ++i) out.push([i, j, k]);
  return out;
}

/**
 * Chunk `b` of a level as the store serves it, cut from a slab holding it:
 * the full chunk shape (zeros beyond the level's edge), volumes slowest,
 * then k, j, i; `bytes` a voxel.
 */
export function chunkFromSlab(grid: Grid, slab: Slab, b: number[], bytes: number): Uint8Array {
  const [ci, cj, ck] = grid.chunk;
  const [ni, nj, nk] = extent(slab.box);
  const lo = b.map((v, a) => v * grid.chunk[a]);
  const hi = lo.map((v, a) => Math.min(grid.size[a], v + grid.chunk[a]));
  const out = new Uint8Array(slab.slots * ci * cj * ck * bytes);
  const src = new Uint8Array(slab.data.buffer, slab.data.byteOffset, slab.data.byteLength);
  const run = (hi[0] - lo[0]) * bytes;
  for (let s = 0; s < slab.slots; ++s) {
    for (let z = lo[2]; z < hi[2]; ++z) {
      for (let y = lo[1]; y < hi[1]; ++y) {
        const from = (((s * nk + (z - slab.box.lo[2])) * nj + (y - slab.box.lo[1])) * ni + (lo[0] - slab.box.lo[0])) * bytes;
        const to = (((s * ck + (z - lo[2])) * cj + (y - lo[1])) * ci) * bytes;
        out.set(src.subarray(from, from + run), to);
      }
    }
  }
  return out;
}

/** A slab put together from its chunks (as `chunkFromSlab` cuts them). */
export function slabFromChunks(grid: Grid, box: Box, slots: number, bytes: number, chunks: Map<string, Uint8Array>, make: (n: number) => Voxels): Slab {
  const [ci, cj, ck] = grid.chunk;
  const [ni, nj, nk] = extent(box);
  const data = make(slots * ni * nj * nk);
  const dst = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  for (const b of chunksOf(grid, box)) {
    const chunk = chunks.get(b.join("/"));
    if (chunk === undefined) throw new Error(`no chunk ${b}`);
    const lo = b.map((v, a) => v * grid.chunk[a]);
    const hi = lo.map((v, a) => Math.min(box.hi[a], v + grid.chunk[a]));
    const run = (hi[0] - lo[0]) * bytes;
    for (let s = 0; s < slots; ++s) {
      for (let z = lo[2]; z < hi[2]; ++z) {
        for (let y = lo[1]; y < hi[1]; ++y) {
          const from = (((s * ck + (z - lo[2])) * cj + (y - lo[1])) * ci) * bytes;
          const to = (((s * nk + (z - box.lo[2])) * nj + (y - box.lo[1])) * ni + (lo[0] - box.lo[0])) * bytes;
          dst.set(chunk.subarray(from, from + run), to);
        }
      }
    }
  }
  return { box, slots, data };
}

/** Whether integer sums of up to 8 voxels of this type are exact in float32. */
const SMALL = (data: Voxels) => data instanceof Uint8Array || data instanceof Int8Array || data instanceof Uint16Array || data instanceof Int16Array;

/**
 * A slab of a coarser level made from the finer slabs under it, added one
 * at a time: each voxel the mean of the finer level's box under it
 * (`mean`), or that box's first voxel (`nearest`, for labels and colours).
 * Sums are float32 where that is exact (8- and 16-bit integers), else
 * float64; the count under each voxel follows from where it is.
 */
export class Reducer {
  private readonly sum: Float32Array | Float64Array | undefined;
  private readonly out: Voxels;
  private readonly n: number[];

  constructor(
    private readonly grid: Grid,
    private readonly finer: Grid,
    readonly box: Box,
    private readonly slots: number,
    private readonly mode: "mean" | "nearest",
    make: (n: number) => Voxels,
  ) {
    this.n = extent(box);
    const voxels = slots * this.n[0] * this.n[1] * this.n[2];
    this.out = make(voxels);
    if (mode === "mean") {
      if (this.out instanceof BigUint64Array || this.out instanceof BigInt64Array) throw new Error("64-bit integers are picked, not averaged");
      this.sum = SMALL(this.out) ? new Float32Array(voxels) : new Float64Array(voxels);
    }
  }

  add(slab: Slab): void {
    const [ni, nj, nk] = this.n;
    const [si, sj, sk] = this.grid.step;
    const [fi, fj, fk] = extent(slab.box);
    const [li, lj, lk] = slab.box.lo;
    const [pi, pj, pk] = this.box.lo;
    const from = slab.data;
    if (this.mode === "nearest") {
      const to = this.out as unknown as { [i: number]: number | bigint };
      const src = from as unknown as { [i: number]: number | bigint };
      const first = (lo: number, s: number) => Math.ceil(lo / s) * s;
      for (let s = 0; s < this.slots; ++s) {
        for (let z = first(lk, sk); z < lk + fk; z += sk) {
          for (let y = first(lj, sj); y < lj + fj; y += sj) {
            const srcRow = ((s * fk + (z - lk)) * fj + (y - lj)) * fi - li;
            const dstRow = ((s * nk + (z / sk - pk)) * nj + (y / sj - pj)) * ni - pi;
            for (let x = first(li, si); x < li + fi; x += si) to[dstRow + x / si] = src[srcRow + x];
          }
        }
      }
      return;
    }
    const sum = this.sum!;
    const src = from as Exclude<Voxels, BigUint64Array | BigInt64Array>;
    for (let s = 0; s < this.slots; ++s) {
      for (let z = 0; z < fk; ++z) {
        const dz = Math.floor((lk + z) / sk) - pk;
        for (let y = 0; y < fj; ++y) {
          const dy = Math.floor((lj + y) / sj) - pj;
          const srcRow = ((s * fk + z) * fj + y) * fi;
          const dstRow = ((s * nk + dz) * nj + dy) * ni - pi;
          if (si === 2) {
            // Pairs along i: the common case, kept tight.
            let x = 0;
            if (li & 1) {
              sum[dstRow + ((li >> 1))] += src[srcRow];
              x = 1;
            }
            for (; x + 1 < fi; x += 2) sum[dstRow + ((li + x) >> 1)] += src[srcRow + x] + src[srcRow + x + 1];
            if (x < fi) sum[dstRow + ((li + x) >> 1)] += src[srcRow + x];
          } else {
            for (let x = 0; x < fi; ++x) sum[dstRow + li + x] += src[srcRow + x];
          }
        }
      }
    }
  }

  /** The coarser slab: sums divided by their counts (rounded for integer types). */
  finish(): Slab {
    if (this.mode === "mean") {
      const [ni, nj, nk] = this.n;
      // Finer voxels under each coarse one, along each axis: the step, less at the far edge.
      const count = (a: number, p: number) => Math.max(1, Math.min(this.grid.step[a], this.finer.size[a] - p * this.grid.step[a]));
      const ci = Array.from({ length: ni }, (_, x) => count(0, this.box.lo[0] + x));
      const sum = this.sum!;
      const out = this.out as Exclude<Voxels, BigUint64Array | BigInt64Array>;
      const round = !(out instanceof Float32Array || out instanceof Float64Array);
      for (let s = 0; s < this.slots; ++s) {
        for (let z = 0; z < nk; ++z) {
          const cz = count(2, this.box.lo[2] + z);
          for (let y = 0; y < nj; ++y) {
            const czy = cz * count(1, this.box.lo[1] + y);
            const row = ((s * nk + z) * nj + y) * ni;
            if (round) for (let x = 0; x < ni; ++x) out[row + x] = Math.round(sum[row + x] / (czy * ci[x]));
            else for (let x = 0; x < ni; ++x) out[row + x] = sum[row + x] / (czy * ci[x]);
          }
        }
      }
    }
    return { box: this.box, slots: this.slots, data: this.out };
  }
}
