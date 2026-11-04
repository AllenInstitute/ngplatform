/**
 * The main thread's side of the Atlas worker: a label volume's counts (per
 * label: voxels, centre, bounds) and a region's voxel nearest its centre,
 * as promises, with progress and cancelling.
 */
import { WorkerRpc } from "@ngplatform/sdk/worker_rpc";

/** One label's voxels at the level counted. */
export interface LabelStats {
  count: number;
  /** Sums of its voxels' x, y and z. */
  sum: [number, number, number];
  /** Its bounding box, in voxels, `hi` inclusive. */
  lo: [number, number, number];
  hi: [number, number, number];
}

export interface Counted {
  store: string;
  /** The level counted (0 the finest) and its size in voxels. */
  level: number;
  size: [number, number, number];
  /** Voxel indices (x, y, z) to RAS millimetres, 4 × 4 row-major. */
  voxelToRas: Float64Array;
  /** Cubic millimetres in one voxel. */
  voxelVolume: number;
  labels: Map<bigint, LabelStats>;
}

export class LabelClient {
  private readonly rpc = new WorkerRpc(() => new Worker(new URL("./label_worker.ts", import.meta.url), { type: "module", name: "atlas" }), {
    stopped: (why) => `the label counter stopped: ${why}`,
    // A failed worker is replaced by the next request.
    restart: true,
  });

  private request<T>(message: object, options: { progress?: (done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<T> {
    const { progress, signal } = options;
    return this.rpc.request<T>(message, { signal, progress: progress && ((msg) => progress(msg.done, msg.total)) });
  }

  /** Every label's voxels in a store, at its finest level of at most 64 M voxels. */
  async count(store: string, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Counted> {
    const r = await this.request<{ level: number; size: [number, number, number]; voxelToRas: number[]; labels: Float64Array; counts: Float64Array; sums: Float64Array; bounds: Int32Array }>(
      { type: "count", store },
      { progress, signal },
    );
    const labels = new Map<bigint, LabelStats>();
    r.labels.forEach((label, i) => {
      if (!Number.isInteger(label)) return;
      const b = r.bounds;
      labels.set(BigInt(label), {
        count: r.counts[i],
        sum: [r.sums[3 * i], r.sums[3 * i + 1], r.sums[3 * i + 2]],
        lo: [b[6 * i], b[6 * i + 1], b[6 * i + 2]],
        hi: [b[6 * i + 3], b[6 * i + 4], b[6 * i + 5]],
      });
    });
    const m = Float64Array.from(r.voxelToRas);
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
    return { store, level: r.level, size: r.size, voxelToRas: m, voxelVolume: Math.abs(det), labels };
  }

  /**
   * A voxel of `values` (a region's labels) nearest their centre: inside
   * the region, where the centre may not be (a region on both sides).
   */
  async centre(counted: Counted, values: bigint[], signal?: AbortSignal): Promise<[number, number, number] | undefined> {
    let n = 0;
    const sum = [0, 0, 0];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const present: number[] = [];
    for (const v of values) {
      const s = counted.labels.get(v);
      if (s === undefined) continue;
      present.push(Number(v));
      n += s.count;
      for (let k = 0; k < 3; ++k) {
        sum[k] += s.sum[k];
        lo[k] = Math.min(lo[k], s.lo[k]);
        hi[k] = Math.max(hi[k], s.hi[k] + 1);
      }
    }
    if (n === 0) return undefined;
    const point = sum.map((s) => s / n);
    const r = await this.request<{ voxel: [number, number, number] | null }>({ type: "nearest", store: counted.store, level: counted.level, labels: present, point, lo, hi }, { signal });
    return r.voxel ?? undefined;
  }

  dispose(): void {
    this.rpc.dispose();
  }
}
