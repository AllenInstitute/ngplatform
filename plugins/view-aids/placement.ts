/**
 * Placing labels at the sides of the 3-D view, pure.  Each point goes to
 * the side it is on; down each side the labels keep the order of their
 * points' angles (so leader lines fan out and do not cross), each as near
 * where it wants to be as the others allow, spaced so none overlap and
 * kept within the side (a least-squares fit in order: pool adjacent
 * violators).
 */

export interface LabelPoint {
  /** Where the point is in the view (pixels from its top left). */
  x: number;
  y: number;
  /** Nearer the viewer is smaller (Neuroglancer's -1..1); used to choose which to keep when a side is full. */
  depth: number;
  /** The label's width: its leader ends at its inner edge. */
  width?: number;
}

export interface PlacedLabel {
  /** Index into the points given. */
  index: number;
  side: "left" | "right";
  /** The label's middle, pixels from the view's top. */
  y: number;
}

/**
 * Heights for labels kept in order down a column: as near `wanted` as they
 * can be (least squares), each at least `gap` below the one before, all
 * within [top, bottom] (the middles of the first and last).  When they do
 * not fit, they are spread evenly from top to bottom.
 */
export function spaceColumn(wanted: readonly number[], gap: number, top: number, bottom: number): number[] {
  const n = wanted.length;
  if (n === 0) return [];
  if (n > 1 && (n - 1) * gap > bottom - top) return wanted.map((_, i) => top + ((bottom - top) * i) / (n - 1));
  // Shifted so the spacing becomes "never decreasing", then clamped so the column fits.
  const lo = (i: number) => top + i * gap;
  const hi = (i: number) => bottom - (n - 1 - i) * gap;
  const z = wanted.map((w, i) => Math.min(hi(i), Math.max(lo(i), w)) - i * gap);
  // Pool adjacent violators: blocks of equal value, each the mean of its members.
  const blocks: { sum: number; count: number }[] = [];
  for (const v of z) {
    blocks.push({ sum: v, count: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.count <= b.sum / b.count) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, count: a.count + b.count });
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.count; ++k) out.push(b.sum / b.count);
  return out.map((v, i) => Math.min(hi(i), Math.max(lo(i), v + i * gap)));
}

/** Whether segments ab and cd cross (touching at an end does not count). */
export function segmentsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const side = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

/**
 * Where each point's label goes: its side, and its height there.  Down a
 * side the labels keep the order of their points' angles about the middle
 * of the far side (so leaders fan out, nearly level), each wanting where
 * its point's ray from there meets the side; spaced so none overlap
 * (`height`: a label's height with the space between labels; `inset`:
 * labels' distance from the side), within
 * `top` and `bottom` (`rightTop` lets the right side start lower, below
 * the orientation cube).  Leaders the spacing makes cross swap labels
 * (which shortens them) until none do.  A side that cannot hold all its
 * labels keeps those nearest the viewer.
 */
export function placeLabels(
  points: readonly LabelPoint[],
  view: { width: number; height: number },
  options: { height: number; top: number; bottom: number; rightTop?: number; inset?: number },
): PlacedLabel[] {
  const cx = view.width / 2;
  const cy = view.height / 2;
  const out: PlacedLabel[] = [];
  for (const side of ["left", "right"] as const) {
    const top = side === "right" ? Math.max(options.top, options.rightTop ?? options.top) : options.top;
    const bottom = options.bottom;
    if (bottom < top) continue;
    const room = Math.floor((bottom - top) / options.height) + 1;
    let members = points.map((p, index) => ({ p, index })).filter(({ p }) => (side === "left" ? p.x < cx : p.x >= cx));
    if (members.length > room) members = [...members].sort((a, b) => a.p.depth - b.p.depth).slice(0, room);
    // Rays from the middle of the far side through each point, to this side.
    const from = side === "left" ? view.width : 0;
    const edge = side === "left" ? 0 : view.width;
    const ray = (p: LabelPoint) => cy + ((p.y - cy) * (edge - from)) / (p.x - from || 1e-6);
    members.sort((a, b) => ray(a.p) - ray(b.p) || a.p.y - b.p.y);
    const slots = spaceColumn(
      members.map(({ p }) => Math.min(bottom, Math.max(top, ray(p)))),
      options.height,
      top,
      bottom,
    );
    // Uncross: each swap shortens the leaders in all, so this ends.
    const at = members.map((m) => m.p);
    const inset = options.inset ?? 0;
    const end = (k: number): [number, number] => [side === "left" ? inset + (at[k].width ?? 0) : view.width - inset - (at[k].width ?? 0), slots[k]];
    for (let pass = 0, swapped = true; swapped && pass < members.length * members.length; ++pass) {
      swapped = false;
      for (let i = 0; i < at.length; ++i) {
        for (let j = i + 1; j < at.length; ++j) {
          if (!segmentsCross([at[i].x, at[i].y], end(i), [at[j].x, at[j].y], end(j))) continue;
          [at[i], at[j]] = [at[j], at[i]];
          [members[i], members[j]] = [members[j], members[i]];
          swapped = true;
        }
      }
    }
    members.forEach(({ index }, k) => out.push({ index, side, y: slots[k] }));
  }
  return out;
}
