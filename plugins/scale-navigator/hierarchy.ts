/**
 * Pure: image layers that nest in space, as HiP-CT's are (a whole organ at
 * 20 µm, zooms at 6.5, 2 and 1 µm inside it): which lies inside which, the
 * chain of them at a position, the level of a pyramid Neuroglancer would
 * draw at a zoom, and the view that frames a layer.  Nothing here knows
 * about a data source: only boxes in global coordinates and voxel sizes.
 */

/** An image layer as the navigator sees it. */
export interface Volume {
  name: string;
  /** Its box in global coordinates; ±Infinity along a dimension it does not have. */
  lower: number[];
  upper: number[];
  /** Its finest voxel's physical size along each global dimension (NaN where it has none). */
  voxelSize: number[];
  /** Its voxel along each global dimension in global coordinates (voxelSize over the dimension's scale), when known. */
  step?: number[];
  /** Shown in the views now. */
  visible: boolean;
}

/** One voxel size for a volume: the middle of its sizes, as Neuroglancer's resolution widget gives a level. */
export function voxelOf(v: Pick<Volume, "voxelSize">): number {
  const sizes = v.voxelSize.filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
  if (sizes.length === 0) return NaN;
  return sizes[Math.floor((sizes.length - 1) / 2)];
}

/** Coarser by more than this ratio counts as another level of the hierarchy (not a copy at the same resolution). */
const COARSER = 1.05;

/**
 * Whether `inner` lies inside `outer` and is finer: along every dimension
 * both have, its box within the other's (give or take half the outer's
 * voxel, which an edge rounded to it may be off by).
 */
export function contains(outer: Volume, inner: Volume): boolean {
  if (outer === inner) return false;
  const vo = voxelOf(outer);
  const vi = voxelOf(inner);
  if (!(vo > vi * COARSER)) return false;
  let shared = 0;
  for (let g = 0; g < outer.lower.length; ++g) {
    const a = [outer.lower[g], outer.upper[g]];
    const b = [inner.lower[g], inner.upper[g]];
    if (![...a, ...b].every(Number.isFinite)) continue;
    // Half the outer voxel along this dimension, in global coordinates (else a millionth of its extent).
    const step = outer.step?.[g];
    const tolerance = step !== undefined && Number.isFinite(step) && step > 0 ? step / 2 : (a[1] - a[0]) * 1e-6;
    if (b[0] < a[0] - tolerance || b[1] > a[1] + tolerance) return false;
    ++shared;
  }
  return shared > 0;
}

/** The volume each lies directly inside: the smallest of those that contain it (undefined: none). */
export function parents(volumes: Volume[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const v of volumes) {
    let best: Volume | undefined;
    for (const o of volumes) {
      if (!contains(o, v)) continue;
      if (best === undefined || extent(o) < extent(best) || (extent(o) === extent(best) && voxelOf(o) < voxelOf(best))) best = o;
    }
    out.set(v.name, best?.name);
  }
  return out;
}

/** A volume's size: the product of its finite extents (in global coordinates). */
function extent(v: Volume): number {
  let p = 1;
  for (let g = 0; g < v.lower.length; ++g) {
    const e = v.upper[g] - v.lower[g];
    if (Number.isFinite(e)) p *= Math.max(e, 0);
  }
  return p;
}

/** Whether a position lies inside a volume's box (along the dimensions it has). */
export function inside(v: Volume, position: number[]): boolean {
  let any = false;
  for (let g = 0; g < v.lower.length; ++g) {
    if (!Number.isFinite(v.lower[g]) || !Number.isFinite(v.upper[g])) continue;
    const p = position[g];
    if (p === undefined || !Number.isFinite(p)) continue;
    if (p < v.lower[g] || p > v.upper[g]) return false;
    any = true;
  }
  return any;
}

/** The volumes whose boxes hold `position`, coarse to fine (ties in the order given). */
export function chainAt(volumes: Volume[], position: number[]): Volume[] {
  return volumes
    .map((v, i) => ({ v, i, size: voxelOf(v) }))
    .filter(({ v, size }) => Number.isFinite(size) && inside(v, position))
    .sort((a, b) => b.size - a.size || a.i - b.i)
    .map(({ v }) => v);
}

/** The volumes that lie inside another (zoom boxes), with the one each lies directly inside. */
export function nested(volumes: Volume[]): { volume: Volume; parent: Volume; within: Volume[] }[] {
  const byName = new Map(volumes.map((v) => [v.name, v]));
  const out: { volume: Volume; parent: Volume; within: Volume[] }[] = [];
  for (const [name, parent] of parents(volumes)) {
    if (parent === undefined) continue;
    const volume = byName.get(name)!;
    out.push({ volume, parent: byName.get(parent)!, within: volumes.filter((o) => contains(o, volume)) });
  }
  return out;
}

/**
 * The layer the views are on in the hierarchy: the selected layer when it
 * is in the chain, else the finest shown one in it, else the finest.
 */
export function current(chain: Volume[], selected: string | undefined): Volume | undefined {
  return chain.find((v) => v.name === selected) ?? [...chain].reverse().find((v) => v.visible) ?? chain[chain.length - 1];
}

/** The layer one step coarser than `from` at the position (the one it lies in). */
export function coarser(volumes: Volume[], chain: Volume[], from: Volume | undefined): Volume | undefined {
  if (from === undefined) return undefined;
  const i = chain.indexOf(from);
  if (i > 0) return chain[i - 1];
  const parent = parents(volumes).get(from.name);
  return parent === undefined ? undefined : volumes.find((v) => v.name === parent);
}

/**
 * The layer one step finer than `from`: the next in the chain at the
 * position, else of those lying directly inside it, the one whose centre
 * is nearest the position (from the overview, the nearest zoom).
 */
export function finer(volumes: Volume[], chain: Volume[], from: Volume | undefined, position: number[]): Volume | undefined {
  if (from === undefined) return chain[0] ?? undefined;
  const i = chain.indexOf(from);
  if (i !== -1 && i < chain.length - 1) return chain[i + 1];
  const map = parents(volumes);
  const children = volumes.filter((v) => map.get(v.name) === from.name);
  let best: Volume | undefined;
  let bestDistance = Infinity;
  for (const c of children) {
    const centre = centreOf(c);
    let d = 0;
    centre.forEach((x, g) => {
      if (Number.isFinite(x) && Number.isFinite(position[g])) d += (x - position[g]) ** 2;
    });
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return best;
}

/** A box's centre (NaN along a dimension it does not have). */
export function centreOf(v: Pick<Volume, "lower" | "upper">): number[] {
  return v.lower.map((lo, g) => (Number.isFinite(lo) && Number.isFinite(v.upper[g]) ? (lo + v.upper[g]) / 2 : NaN));
}

/**
 * The view that frames a box: its centre, and the zooms that fit its
 * largest displayed extent in the views (a cross-section's scale is the
 * size of a screen pixel, a 3-D view's the height it shows, both in
 * canonical voxels: the smallest displayed dimension's scale), as
 * Neuroglancer's own fit to the data does, with a margin.
 *
 * @param scales the global dimensions' scales (physical size of one coordinate)
 * @param display the displayed global dimensions (indices)
 * @param pixels the views' smaller side, px
 */
export function framing(
  box: Pick<Volume, "lower" | "upper">,
  scales: number[],
  display: number[],
  pixels: number,
): { position: number[]; crossSectionScale: number; projectionScale: number } | undefined {
  const shown = display.filter((d) => d >= 0 && d < scales.length && scales[d] > 0);
  if (shown.length === 0 || !(pixels > 0)) return undefined;
  const canonical = Math.min(...shown.map((d) => scales[d]));
  let largest = 0;
  for (const d of shown) {
    const e = box.upper[d] - box.lower[d];
    if (Number.isFinite(e)) largest = Math.max(largest, (e * scales[d]) / canonical);
  }
  if (!(largest > 0)) return undefined;
  return { position: centreOf(box), crossSectionScale: (largest * 1.1) / pixels, projectionScale: largest * 1.25 };
}

/**
 * The level of a pyramid Neuroglancer draws in a cross-section at a zoom,
 * as its slice views choose (sliceview/base.ts, filterVisibleSources): from
 * the coarsest, finer while a level is coarser than the target (a screen
 * pixel, a little enlarged, times the layer's render scale target) and the
 * next is nearer it.  On one voxel size per level (the middle of three),
 * which Neuroglancer also shows.
 *
 * @param levels voxel sizes, finest first
 * @returns an index into `levels`
 */
export function estimateLevel(levels: number[], pixelSize: number, renderScaleTarget = 1): number | undefined {
  if (levels.length === 0 || !(pixelSize > 0)) return undefined;
  const target = pixelSize * 1.1 * renderScaleTarget;
  const finest = levels[0];
  let i = levels.length - 1;
  while (i > 0) {
    const size = levels[i];
    if (!(size > target && size > 1.01 * finest)) break;
    const next = levels[i - 1];
    if (!(Math.abs(target - next) < Math.abs(target - size) && next < 1.01 * size)) break;
    --i;
  }
  return i;
}

/** A length in metres as a value and an SI unit, three significant digits at most (19.6 µm, 313 µm, 1.25 mm). */
export function lengthText(metres: number): { value: string; unit: string } {
  if (!Number.isFinite(metres) || metres <= 0) return { value: "–", unit: "" };
  const units: [number, string][] = [
    [1, "m"],
    [1e-3, "mm"],
    [1e-6, "µm"],
    [1e-9, "nm"],
  ];
  let [factor, unit] = units[units.length - 1];
  for (const [f, u] of units) {
    if (metres >= f * 0.9995) {
      [factor, unit] = [f, u];
      break;
    }
  }
  const v = metres / factor;
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return { value: String(Number(v.toFixed(digits))), unit };
}
