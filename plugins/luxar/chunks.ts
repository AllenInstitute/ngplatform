/**
 * Which chunks a view draws, and their copies on its GPU.
 *
 * Levels of detail work as Neuroglancer's own do: the view reads the
 * finest level whose chunks in view hold about the vertex budget, and only
 * those chunks; until a chunk of it has arrived, the finest coarser level
 * whose chunks covering it have all arrived stands in for it.  The
 * coarsest level's chunks in view are always read first, so something
 * shows at once.
 */
import type { StoreClient, StoreInfo } from "./client.js";
import type { GpuChunk, Renderer } from "./render_gl.js";
import { chooseLevel, chunkBox, chunkRange, chunksIn } from "./view_math.js";

/** Levels with more chunks than this in all are skipped (unless the coarsest): enumerating them would cost more than it saves. */
const MAX_CHUNKS = 50000;

export interface Selection {
  /** The level read for this view (an index into the store's levels). */
  level: number;
  /** Chunks to draw (any level), and chunks to read, most wanted first. */
  draw: string[];
  want: string[];
  /** Every chunk the view wants at its level has arrived. */
  complete: boolean;
}

export const keyOf = (level: number, coords: number[]) => `${level}|${coords.join(".")}`;

/**
 * Chunks for a view.  `visible` says whether a box (store coordinates) can
 * show; `centre` (store coordinates) orders them; `budget` is in vertices.
 */
export function selectChunks(info: StoreInfo, visible: (lower: number[], upper: number[]) => boolean, centre: number[], budget: number, arrived: (key: string) => boolean): Selection {
  const { lower, upper } = info.bounds;
  const coarsest = info.levels.length - 1;
  const lists: (number[][] | undefined)[] = info.levels.map((level, i) => {
    const range = chunkRange(lower, upper, level.chunkShape);
    const total = [0, 1, 2].reduce((n, k) => n * (range.to[k] - range.from[k] + 1), 1);
    if (total > MAX_CHUNKS && i !== coarsest) return undefined;
    const shape = level.chunkShape;
    const list = chunksIn(range, MAX_CHUNKS).filter((c) => {
      const box = chunkBox(c, shape);
      return visible(box.lower, box.upper);
    });
    const distance = (c: number[]) => c.reduce((s, v, k) => s + ((v + 0.5) * shape[k] - centre[k]) ** 2, 0);
    return list.sort((a, b) => distance(a) - distance(b));
  });
  const totals = info.levels.map((level) => {
    const range = chunkRange(lower, upper, level.chunkShape);
    return [0, 1, 2].reduce((n, k) => n * (range.to[k] - range.from[k] + 1), 1);
  });
  const level = chooseLevel(
    info.levels.map((l, i) => ({ vertexCount: lists[i] === undefined ? undefined : l.vertexCount, visible: lists[i]?.length ?? 0, total: totals[i] })),
    budget,
  );
  const target = lists[level] ?? [];
  const want: string[] = [];
  const coarse = lists[coarsest] ?? [];
  for (const c of coarse) {
    const k = keyOf(coarsest, c);
    if (!arrived(k)) want.push(k);
  }
  const draw = new Set<string>();
  let complete = true;
  for (const c of target) {
    const k = keyOf(level, c);
    if (arrived(k)) {
      draw.add(k);
      continue;
    }
    complete = false;
    if (level !== coarsest) want.push(k);
    // Stand in with the finest coarser level that has all of this box.
    const box = chunkBox(c, info.levels[level].chunkShape);
    for (let j = level + 1; j <= coarsest; ++j) {
      const shape = info.levels[j].chunkShape;
      const inner = { lower: box.lower.map((v, k) => v + 1e-6 * shape[k]), upper: box.upper.map((v, k) => v - 1e-6 * shape[k]) };
      const keys = chunksIn(chunkRange(inner.lower, inner.upper, shape), 64).map((cc) => keyOf(j, cc));
      if (keys.every(arrived)) {
        for (const kk of keys) draw.add(kk);
        break;
      }
    }
  }
  return { level, draw: [...draw], want, complete };
}

/** One view's GPU copies of a layer's chunks, least recently drawn first. */
export class GpuChunks {
  private readonly map = new Map<string, GpuChunk | null>();
  private bytes = 0;
  private generation = -1;

  constructor(
    private readonly renderer: Renderer,
    private readonly client: StoreClient,
    private readonly budget: number,
  ) {}

  /** Whether a chunk can be drawn now (or is known to be empty). */
  arrived(key: string): boolean {
    this.check();
    return this.map.has(key) || this.client.has(key);
  }

  private check(): void {
    if (this.generation === this.client.generation) return;
    this.generation = this.client.generation;
    this.clear();
  }

  /**
   * The GPU chunks for keys, uploading those that have arrived (at most
   * `uploadBytes` this frame, so a burst of arrivals does not stall a
   * frame), then letting go of the least recently drawn beyond the budget.
   * `more` is set when some were left for the next frame.
   */
  take(keys: string[], uploadBytes = 96 * 1024 * 1024): { chunks: GpuChunk[]; more: boolean } {
    this.check();
    const out: GpuChunk[] = [];
    let uploaded = 0;
    let more = false;
    for (const key of keys) {
      let gpu = this.map.get(key);
      if (gpu === undefined) {
        const built = this.client.get(key);
        if (built === undefined) continue;
        if (built === null) gpu = null;
        else if (uploaded > uploadBytes) {
          more = true;
          continue;
        } else {
          gpu = this.renderer.upload(built);
          uploaded += gpu.bytes;
          this.bytes += gpu.bytes;
        }
      } else this.map.delete(key);
      this.map.set(key, gpu);
      if (gpu) out.push(gpu);
    }
    const keep = new Set(keys);
    for (const [key, gpu] of this.map) {
      if (this.bytes <= this.budget) break;
      if (keep.has(key)) continue;
      this.map.delete(key);
      if (gpu) {
        this.renderer.release(gpu);
        this.bytes -= gpu.bytes;
      }
    }
    return { chunks: out, more };
  }

  get gpuBytes(): number {
    return this.bytes;
  }

  clear(): void {
    for (const gpu of this.map.values()) if (gpu) this.renderer.release(gpu);
    this.map.clear();
    this.bytes = 0;
  }
}
