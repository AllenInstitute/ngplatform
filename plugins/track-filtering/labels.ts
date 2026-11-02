/**
 * Region tests on a segmentation volume (Neuroglancer precomputed): the
 * segments with at least one voxel inside a region.  A segment "passes
 * through" a region when the region holds a piece of it, which for cells
 * and neurites is what a track's "passes through" means.
 *
 * Regions are in nanometres.  The level read is the finest at which the
 * region's box holds at most `maxVoxels` voxels, so small regions are exact
 * at full resolution and large ones still answer in about a second.  Pure
 * code over a chunk reader, run by ./labels_worker.ts and tested without one.
 */
import type { PrecomputedScale, Scale } from "@ngplatform/sdk/precomputed";

export interface NmRegion {
  shape: "sphere" | "box";
  /** Centre, nm, x y z. */
  center: [number, number, number];
  /** Sphere radius, nm. */
  radius: number;
  /** Box widths, nm. */
  size: [number, number, number];
}

/** A region's half-widths, nm. */
function half(region: NmRegion): number[] {
  return region.shape === "sphere" ? [region.radius, region.radius, region.radius] : region.size.map((s) => Math.abs(s) / 2);
}

/** The voxel box [lo, hi) of a scale that a region covers, clamped to the volume. */
export function voxelBox(scale: Scale, region: NmRegion): { lo: number[]; hi: number[] } {
  const offset = scale.voxel_offset ?? [0, 0, 0];
  const h = half(region);
  // Voxel v spans [(v + offset) r, (v + offset + 1) r).
  const lo = [0, 1, 2].map((k) => Math.max(0, Math.floor((region.center[k] - h[k]) / scale.resolution[k] - offset[k])));
  const hi = [0, 1, 2].map((k) => Math.min(scale.size[k], Math.ceil((region.center[k] + h[k]) / scale.resolution[k] - offset[k])));
  return { lo, hi };
}

/** The finest scale whose box for `region` holds at most `maxVoxels` voxels (else the coarsest). */
export function chooseScale(scales: Scale[], region: NmRegion, maxVoxels = 2_000_000): number {
  const order = scales.map((s, i) => ({ i, size: s.resolution[0] * s.resolution[1] * s.resolution[2] })).sort((a, b) => a.size - b.size);
  for (const { i } of order) {
    const { lo, hi } = voxelBox(scales[i], region);
    const voxels = [0, 1, 2].reduce((n, k) => n * Math.max(0, hi[k] - lo[k]), 1);
    if (voxels <= maxVoxels) return i;
  }
  return order[order.length - 1].i;
}

/** Whether a point (nm) is inside a region. */
export function inside(region: NmRegion, p: ArrayLike<number>): boolean {
  if (region.shape === "sphere") {
    const dx = p[0] - region.center[0];
    const dy = p[1] - region.center[1];
    const dz = p[2] - region.center[2];
    return dx * dx + dy * dy + dz * dz <= region.radius * region.radius;
  }
  const h = half(region);
  return Math.abs(p[0] - region.center[0]) <= h[0] && Math.abs(p[1] - region.center[1]) <= h[1] && Math.abs(p[2] - region.center[2]) <= h[2];
}

/**
 * The segment ids (not 0) with a voxel centre inside `region`, read from
 * `reader` (one scale), chunks a few at a time.
 */
export async function labelsInRegion(
  reader: Pick<PrecomputedScale, "scale" | "chunk" | "readLabels">,
  region: NmRegion,
  signal?: AbortSignal,
  progress?: (done: number, total: number) => void,
): Promise<{ ids: BigUint64Array; chunks: number; voxels: number }> {
  const { scale, chunk } = reader;
  const { lo, hi } = voxelBox(scale, region);
  const offset = scale.voxel_offset ?? [0, 0, 0];
  const res = scale.resolution;
  const first = [0, 1, 2].map((k) => Math.floor(lo[k] / chunk[k]));
  const last = [0, 1, 2].map((k) => Math.ceil(hi[k] / chunk[k]) - 1);
  const positions: [number, number, number][] = [];
  for (let z = first[2]; z <= last[2]; ++z) for (let y = first[1]; y <= last[1]; ++y) for (let x = first[0]; x <= last[0]; ++x) positions.push([x, y, z]);
  const ids = new Set<bigint>();
  let voxels = 0;
  let done = 0;
  let next = 0;
  const p = [0, 0, 0];
  const work = async () => {
    while (next < positions.length) {
      signal?.throwIfAborted();
      const at = positions[next++];
      const data = await reader.readLabels(at, signal);
      if (data !== undefined) {
        const origin = [0, 1, 2].map((k) => at[k] * chunk[k]);
        const from = [0, 1, 2].map((k) => Math.max(lo[k], origin[k]));
        const to = [0, 1, 2].map((k) => Math.min(hi[k], origin[k] + chunk[k]));
        for (let z = from[2]; z < to[2]; ++z) {
          p[2] = (z + offset[2] + 0.5) * res[2];
          for (let y = from[1]; y < to[1]; ++y) {
            p[1] = (y + offset[1] + 0.5) * res[1];
            let index = ((z - origin[2]) * chunk[1] + (y - origin[1])) * chunk[0] + (from[0] - origin[0]);
            for (let x = from[0]; x < to[0]; ++x, ++index) {
              p[0] = (x + offset[0] + 0.5) * res[0];
              if (!inside(region, p)) continue;
              ++voxels;
              const id = data[index];
              if (id !== 0n) ids.add(id);
            }
          }
        }
      }
      progress?.(++done, positions.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, positions.length) }, work));
  signal?.throwIfAborted();
  return { ids: BigUint64Array.from([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))), chunks: positions.length, voxels };
}
