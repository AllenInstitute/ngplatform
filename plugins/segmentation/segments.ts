/**
 * The segment list, as WebKnossos's: the segments of a label volume (those
 * painted, and those made with New segment or named before they are
 * painted), each with its name, colour, voxels and whether it shows.  Pure:
 * the rows, the next new segment, and which segments a layer shows.
 *
 * What a segmentation layer shows is Neuroglancer's `segments` list: ids
 * shown, and ids written "!id", listed but hidden.  With no id shown, the
 * layer shows every segment (`ignoreNullVisibleSet`, true by default) or
 * none (false).  A label volume with nothing hidden keeps the list empty,
 * so whatever is painted shows; hiding one lists every other one known.
 */

export interface SegmentRow {
  value: number;
  name: string;
  colour: string;
  voxels: number;
  visible: boolean;
}

/** What a segmentation layer's state says about its segments. */
export interface SegmentsState {
  segments?: string[];
  ignoreNullVisibleSet?: boolean;
}

/**
 * The id New segment gives: one more than the largest used, as WebKnossos
 * does, or (at the type's largest value) the smallest unused; 0 when every
 * value is used.
 */
export function nextSegment(used: Iterable<number>, max: number): number {
  let top = 0;
  const seen = new Set<number>();
  for (const v of used) {
    seen.add(v);
    if (v > top) top = v;
  }
  if (top < max) return top + 1;
  for (let v = 1; v <= max; ++v) if (!seen.has(v)) return v;
  return 0;
}

/** Whether a layer in this state shows a segment. */
export function isVisible(state: SegmentsState, value: number): boolean {
  const list = state.segments ?? [];
  const id = String(value);
  if (list.includes(id)) return true;
  if (list.includes(`!${id}`)) return false;
  return !list.some((s) => !s.startsWith("!")) && state.ignoreNullVisibleSet !== false;
}

/**
 * The state that shows or hides one segment of those `known`, leaving the
 * others as they were: an empty list when all of them show.
 */
export function withVisibility(state: SegmentsState, known: number[], value: number, visible: boolean): Required<SegmentsState> {
  const all = [...new Set([...known, value])].sort((a, b) => a - b);
  const shown = all.filter((v) => (v === value ? visible : isVisible(state, v)));
  if (shown.length === all.length) return { segments: [], ignoreNullVisibleSet: true };
  const hidden = all.filter((v) => !shown.includes(v));
  return { segments: [...shown.map(String), ...hidden.map((v) => `!${v}`)], ignoreNullVisibleSet: false };
}

/** The list's rows, by value: segments painted, and those named or made but not painted yet. */
export function segmentRows(
  counts: Map<number, number>,
  labels: Map<number, { name: string; colour: string }>,
  colour: (value: number) => string,
  visible: (value: number) => boolean,
): SegmentRow[] {
  const values = [...new Set([...counts.keys(), ...labels.keys()])].filter((v) => v > 0).sort((a, b) => a - b);
  return values.map((value) => ({ value, name: labels.get(value)?.name ?? "", colour: colour(value), voxels: counts.get(value) ?? 0, visible: visible(value) }));
}

/** A segment's name as the list shows it: its own, or "Segment <id>". */
export const segmentName = (row: { value: number; name: string }): string => row.name || `Segment ${row.value}`;

/** Murmur3's mixing of a 32-bit value into a hash state, without the final steps (Neuroglancer's `hashCombine`). */
function hashCombine(state: number, value: number): number {
  value = Math.imul(value >>> 0, 0xcc9e2d51) >>> 0;
  value = ((value << 15) | (value >>> 17)) >>> 0;
  value = Math.imul(value, 0x1b873593) >>> 0;
  state = ((state >>> 0) ^ value) >>> 0;
  state = ((state << 13) | (state >>> 19)) >>> 0;
  return (state * 5 + 0xe6546b64) >>> 0;
}

/**
 * The colour Neuroglancer gives a segment that has none of its own: a hue
 * and saturation from a hash of its id and the layer's colour seed
 * (`SegmentColorHash`), as #rrggbb.
 */
export function hashColour(value: number, seed = 0): string {
  let h = hashCombine(seed, value >>> 0);
  h = hashCombine(h, Math.floor(value / 2 ** 32));
  const hue = ((h & 0xff) / 255) * 6;
  const s = 0.5 + 0.5 * (((h >> 8) & 0xff) / 255);
  const i = Math.floor(hue);
  const f = hue - i;
  const [p, q, t] = [1 - s, 1 - s * f, 1 - s * (1 - f)];
  const rgb = [[1, t, p], [q, 1, p], [p, 1, t], [p, q, 1], [t, p, 1], [1, p, q]][i % 6];
  // Through 32-bit floats, as Neuroglancer keeps the colour.
  return `#${rgb.map((c) => Math.round(Math.fround(c) * 255).toString(16).padStart(2, "0")).join("")}`;
}
