/**
 * Passes over a label volume, chunk by chunk (as the volume reader's
 * `eachRawChunk` gives them): each label's voxel count, the sum of its
 * voxels' positions (for its centre) and its bounding box; and the voxel of
 * some labels nearest a point (to go to a region, inside it).  Plain code,
 * run in ./label_worker.ts, tested without one.
 */

/** A chunk's voxels: the box (x, y, z) it covers, and steps through its values from `start` at `lo`. */
export interface ChunkBox {
  lo: [number, number, number];
  hi: [number, number, number];
  start: number;
  stride: [number, number, number];
}

/** Per label, in order of first seen: count, position sums (x, y, z) and bounds (lo x, y, z, hi x, y, z; hi inclusive). */
export interface LabelCounts {
  labels: Float64Array;
  counts: Float64Array;
  sums: Float64Array;
  bounds: Int32Array;
}

export class LabelCounter {
  private readonly slots = new Map<number, number>();
  private labels: number[] = [];
  private counts: number[] = [];
  private sums: number[] = [];
  private bounds: number[] = [];

  private slot(label: number): number {
    let s = this.slots.get(label);
    if (s === undefined) {
      s = this.labels.length;
      this.slots.set(label, s);
      this.labels.push(label);
      this.counts.push(0);
      this.sums.push(0, 0, 0);
      this.bounds.push(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    }
    return s;
  }

  /** Counts a chunk's voxels; `skip` (the background) is not counted. */
  add(values: ArrayLike<number>, box: ChunkBox, skip = 0): void {
    const { lo, hi, start, stride } = box;
    const { counts, sums, bounds } = this;
    for (let z = lo[2]; z < hi[2]; ++z) {
      for (let y = lo[1]; y < hi[1]; ++y) {
        let at = start + (z - lo[2]) * stride[2] + (y - lo[1]) * stride[1];
        // A run of one label along x is added at once.
        let x = lo[0];
        while (x < hi[0]) {
          const label = values[at];
          let end = x + 1;
          at += stride[0];
          while (end < hi[0] && values[at] === label) {
            ++end;
            at += stride[0];
          }
          if (label !== skip && label === label) {
            const s = this.slot(label);
            const n = end - x;
            counts[s] += n;
            sums[3 * s] += ((x + end - 1) * n) / 2;
            sums[3 * s + 1] += y * n;
            sums[3 * s + 2] += z * n;
            const b = 6 * s;
            if (x < bounds[b]) bounds[b] = x;
            if (y < bounds[b + 1]) bounds[b + 1] = y;
            if (z < bounds[b + 2]) bounds[b + 2] = z;
            if (end - 1 > bounds[b + 3]) bounds[b + 3] = end - 1;
            if (y > bounds[b + 4]) bounds[b + 4] = y;
            if (z > bounds[b + 5]) bounds[b + 5] = z;
          }
          x = end;
        }
      }
    }
  }

  result(): LabelCounts {
    return { labels: Float64Array.from(this.labels), counts: Float64Array.from(this.counts), sums: Float64Array.from(this.sums), bounds: Int32Array.from(this.bounds) };
  }
}

/** The voxel of `wanted` labels nearest `point`, over chunks given to `add`. */
export class NearestVoxel {
  best: [number, number, number] | undefined;
  private distance = Infinity;

  constructor(
    private readonly wanted: Set<number>,
    private readonly point: [number, number, number],
  ) {}

  add(values: ArrayLike<number>, box: ChunkBox): void {
    const { lo, hi, start, stride } = box;
    const [px, py, pz] = this.point;
    for (let z = lo[2]; z < hi[2]; ++z) {
      for (let y = lo[1]; y < hi[1]; ++y) {
        const dyz = (y - py) ** 2 + (z - pz) ** 2;
        if (dyz >= this.distance) continue;
        let at = start + (z - lo[2]) * stride[2] + (y - lo[1]) * stride[1];
        for (let x = lo[0]; x < hi[0]; ++x, at += stride[0]) {
          if (!this.wanted.has(values[at])) continue;
          const d = dyz + (x - px) ** 2;
          if (d < this.distance) {
            this.distance = d;
            this.best = [x, y, z];
          }
        }
      }
    }
  }
}

/** The finest level with at most `budget` voxels (else the coarsest), given levels finest first. */
export function countingLevel(sizes: [number, number, number][], budget = 2 ** 26): number {
  const i = sizes.findIndex((s) => s[0] * s[1] * s[2] <= budget);
  return i < 0 ? sizes.length - 1 : i;
}
