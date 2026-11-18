/**
 * Detail by distance within one store (a large segment's mesh): its chunks
 * chosen across its levels, finer where they are near the camera, within
 * a budget of vertices. From the coarsest level's chunks, the chunk that
 * looks largest from the eye (its size over its distance) is replaced by
 * the finer level's chunks inside it, while the vertices still fit; so
 * the near part of a cell comes at its finest and the far part coarse.
 *
 * Only for levels whose chunk grids nest (each a whole number of the
 * finer level's chunks a side, all from 0, as Luxar's keys are): a chunk
 * is then exactly its finer chunks, and a mix of levels covers the store
 * once, with nothing doubled.
 */
import { chunkBox, chunkRange, chunksIn } from "../../luxar/view_math.js";
import { keyOf } from "../../luxar/chunks.js";

export interface LodLevel {
  chunkShape: number[];
  vertexCount: number | undefined;
}

/** Each level a whole number of the finer one's chunks a side. */
export function nested(levels: readonly LodLevel[]): boolean {
  for (let i = 0; i + 1 < levels.length; ++i) {
    for (let a = 0; a < 3; ++a) {
      const r = levels[i + 1].chunkShape[a] / levels[i].chunkShape[a];
      if (!(r >= 1) || Math.abs(r - Math.round(r)) > 1e-6) return false;
    }
  }
  return true;
}

/**
 * The chunks (Luxar keys) of a store over `lower`..`upper` (store coordinates), finer near `eye`, within `budget`
 * vertices (each chunk taken as its level's count shared by the level's chunks); undefined when the levels do not
 * nest or their sizes are unknown.
 */
export function lodChunks(levels: readonly LodLevel[], lower: number[], upper: number[], eye: number[], budget: number, maxChunks = 4096): string[] | undefined {
  if (levels.length === 0 || !nested(levels) || levels.some((l) => l.vertexCount === undefined)) return undefined;
  // The chunks within the store (an upper bound on a chunk's edge starts no chunk).
  const inside = (shape: number[]) => chunkRange(lower, upper.map((v, k) => v - 1e-9 * shape[k]), shape);
  const per = levels.map((l) => {
    const r = inside(l.chunkShape);
    const n = [0, 1, 2].reduce((m, k) => m * (r.to[k] - r.from[k] + 1), 1);
    return l.vertexCount! / Math.max(1, n);
  });
  const coarsest = levels.length - 1;
  interface C { level: number; c: number[]; size: number }
  const sizeOf = (level: number, c: number[]) => {
    const b = chunkBox(c, levels[level].chunkShape);
    const half = Math.hypot(...[0, 1, 2].map((k) => b.upper[k] - b.lower[k])) / 2;
    const d = Math.hypot(...[0, 1, 2].map((k) => (b.lower[k] + b.upper[k]) / 2 - eye[k]));
    // How large it looks: its size over its distance (the eye inside it: very large).
    return half / Math.max(d - half, 1e-3 * half);
  };
  const open: C[] = chunksIn(inside(levels[coarsest].chunkShape), maxChunks).map((c) => ({ level: coarsest, c, size: sizeOf(coarsest, c) }));
  const done: C[] = [];
  let total = open.length * per[coarsest];
  while (open.length > 0) {
    // The largest-looking first.
    let at = 0;
    for (let i = 1; i < open.length; ++i) if (open[i].size > open[at].size) at = i;
    const x = open[at];
    open[at] = open[open.length - 1];
    open.pop();
    if (x.level === 0) {
      done.push(x);
      continue;
    }
    const finer = x.level - 1;
    const box = chunkBox(x.c, levels[x.level].chunkShape);
    // Inside the parent, and inside the store.
    const lo = box.lower.map((v, k) => Math.max(v, lower[k])), hi = box.upper.map((v, k) => Math.min(v, upper[k]) - 1e-9 * levels[finer].chunkShape[k]);
    const kids = chunksIn(chunkRange(lo, hi, levels[finer].chunkShape), 4096);
    const more = kids.length * per[finer] - per[x.level];
    if (total + more > budget || open.length + done.length + kids.length > maxChunks) {
      done.push(x);
      continue;
    }
    total += more;
    for (const c of kids) open.push({ level: finer, c, size: sizeOf(finer, c) });
  }
  return done.map((x) => keyOf(x.level, x.c));
}
