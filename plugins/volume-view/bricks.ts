/**
 * Bricks of the image's finer levels for the solid: boxes of 32³ voxels,
 * each held in a slot of one 3-D texture (the atlas) with a voxel of its
 * neighbours around it (the apron, so linear filtering stays inside the
 * slot), and found through a page table: per level, one entry per brick,
 * saying which slot holds it, that it is one value throughout, or that it
 * is not held.  The ray takes, at each point, the finest held brick from
 * the finest level allowed; where none is held, the coarse whole level.
 *
 * Which bricks: those a view shows (in the frustum, not in the cut-away
 * octant, with tissue near them by the coarse level and background or the
 * cut near them too, since a ray stops where it first meets tissue), from
 * the coarsest brick level, each split into the next finer level's bricks
 * while its voxels show larger than a pixel (bricks on the cut's faces as
 * if twice as near), the most needed first, while the atlas has slots.
 * A brick behind the tissue's near surface is not wanted: every ray from
 * the camera to it (its centre and corners) meets tissue first, by the
 * coarse level, outside the cut-away octant.
 * They load nearest first; a slot goes to a new brick from the brick least
 * recently wanted.  A brick of one value takes no slot.
 *
 * This is the CPU side, without WebGL; ./solid.ts holds the textures and
 * samples them.
 */
import { invert, type Mat4, multiply } from "./ome.js";
import type { Region } from "./volume_reader.js";

/** A brick's voxels a side, and its slot's (the brick and an apron of one voxel each side). */
export const BRICK = 32;
export const SLOT = BRICK + 2;

/** The page table's states (an entry's fourth byte; the first three are the slot, or the first the value). */
export const ABSENT = 0;
export const RESIDENT = 1;
export const CONSTANT = 2;

/** Most brick levels the shader walks, and most page table entries (four bytes each). */
export const MAX_LEVELS = 8;
export const MAX_PAGES = 1 << 22;

/** Bricks read at once. */
const LOADING = 6;

export type Vec3 = [number, number, number];

export interface BrickLevel {
  /** The level's index among the image's levels. */
  index: number;
  /** Voxels along x, y and z. */
  size: Vec3;
  /** Voxel (x, y, z) to RAS mm, row-major. */
  voxelToRas: Mat4;
}

export const brickGrid = (size: Vec3): Vec3 => size.map((s) => Math.ceil(s / BRICK)) as Vec3;

export interface PageLayout {
  /** The page texture's size. */
  size: Vec3;
  /** Each level's bricks along x, y and z, and its corner in the texture. */
  grids: Vec3[];
  offsets: Vec3[];
}

/**
 * The levels' page tables in one texture at most `max` a side: stacked
 * along z, in columns side by side along x when z is full.  Undefined when
 * they do not fit.
 */
export function packPages(grids: Vec3[], max: number): PageLayout | undefined {
  const offsets: Vec3[] = [];
  let x = 0;
  let z = 0;
  let column = 0;
  let height = 0;
  let depth = 0;
  for (const g of grids) {
    if (g.some((n) => n > max)) return undefined;
    if (z + g[2] > max) {
      x += column;
      z = 0;
      column = 0;
    }
    if (x + g[0] > max) return undefined;
    offsets.push([x, 0, z]);
    z += g[2];
    column = Math.max(column, g[0]);
    height = Math.max(height, g[1]);
    depth = Math.max(depth, z);
  }
  return { size: [x + column, height, depth], grids, offsets };
}

/**
 * Of `levels` (finest first), those whose page tables fit in a texture at
 * most `max` a side and MAX_PAGES entries, at most MAX_LEVELS: the finest
 * are left out first.  Their layout, or undefined when none fit.
 */
export function brickLevels(levels: BrickLevel[], max: number): { levels: BrickLevel[]; layout: PageLayout } | undefined {
  for (let first = Math.max(0, levels.length - MAX_LEVELS); first < levels.length; ++first) {
    const kept = levels.slice(first);
    const layout = packPages(kept.map((l) => brickGrid(l.size)), max);
    if (layout !== undefined && layout.size[0] * layout.size[1] * layout.size[2] <= MAX_PAGES) return { levels: kept, layout };
  }
  return undefined;
}

/** The box of a level to read for brick `b`: the brick and its apron, within the level. */
export function brickRegion(size: Vec3, b: Vec3): Region {
  return {
    lo: [0, 1, 2].map((k) => Math.max(0, b[k] * BRICK - 1)) as Vec3,
    hi: [0, 1, 2].map((k) => Math.min(size[k], b[k] * BRICK + BRICK + 1)) as Vec3,
  };
}

/**
 * A brick's slot (SLOT³, x fastest) from its region as read: voxel i of
 * the slot is the level's voxel b·BRICK − 1 + i, the nearest inside the
 * level past its edges (as the whole level's texture clamps).  `constant`
 * is the value when the slot holds one value only.
 */
export function fillSlot(data: Uint8Array, region: Region, size: Vec3, b: Vec3): { data: Uint8Array; constant: number | undefined } {
  const rs = [0, 1, 2].map((k) => region.hi[k] - region.lo[k]);
  // For each axis, the region's voxel each of the slot's voxels takes.
  const from = [0, 1, 2].map((k) => Int32Array.from({ length: SLOT }, (_, i) => Math.min(size[k] - 1, Math.max(0, b[k] * BRICK - 1 + i)) - region.lo[k]));
  const out = new Uint8Array(SLOT * SLOT * SLOT);
  const first = data[(from[2][0] * rs[1] + from[1][0]) * rs[0] + from[0][0]];
  let constant = true;
  let o = 0;
  for (let z = 0; z < SLOT; ++z) {
    for (let y = 0; y < SLOT; ++y) {
      const row = (from[2][z] * rs[1] + from[1][y]) * rs[0];
      for (let x = 0; x < SLOT; ++x, ++o) {
        const v = data[row + from[0][x]];
        out[o] = v;
        if (v !== first) constant = false;
      }
    }
  }
  return { data: out, constant: constant ? first : undefined };
}

/** The coarse whole level, which says where the tissue is. */
export interface BrickContext {
  data: Uint8Array;
  size: Vec3;
  voxelToRas: Mat4;
  /** The background is dark (tissue is brighter). */
  darkBackground: boolean;
}

export interface BrickView {
  /** Display coordinates to clip space and back, column-major (as Frame3d's). */
  viewProjection: ArrayLike<number>;
  invViewProjection: ArrayLike<number>;
  /** The view's height, pixels. */
  height: number;
  /** Display coordinates of RAS mm. */
  toDisplay: Mat4;
  /** The cut-away octant: where the position is, and which side of it (±1 an axis) is removed. */
  cut?: { point: ArrayLike<number>; side: ArrayLike<number> };
  /** Tissue threshold, 0..1. */
  threshold: number;
  /** The finest brick level to use (its place in the brick levels, finest first). */
  finest: number;
}

export type BrickLoader = (level: number, region: Region, signal: AbortSignal) => Promise<Uint8Array>;

/** Clip coordinates of display point p (vp column-major). */
function clip(vp: ArrayLike<number>, p: ArrayLike<number>): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let r = 0; r < 4; ++r) out[r] = vp[r] * p[0] + vp[4 + r] * p[1] + vp[8 + r] * p[2] + vp[12 + r];
  return out;
}

function unproject(inv: ArrayLike<number>, x: number, y: number, z: number): Vec3 {
  const c = clip(inv, [x, y, z]);
  return [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
}

/** The six clip planes (w ± x, w ± y, w ± z ≥ 0 inside). */
const PLANES = [
  [1, 0, 0, 1],
  [-1, 0, 0, 1],
  [0, 1, 0, 1],
  [0, -1, 0, 1],
  [0, 0, 1, 1],
  [0, 0, -1, 1],
];

interface Candidate {
  id: number;
  level: number;
  /** Corners of its box, display coordinates. */
  corners: Vec3[];
  /** Its voxels' size over a pixel's at its nearest point (×2 on the cut's faces). */
  error: number;
  /** A pixel's size at its nearest point (halved on the cut's faces): smaller loads sooner. */
  near: number;
}

export class BrickSet {
  readonly levels: BrickLevel[];
  readonly layout: PageLayout;
  /** Slots in the atlas along each axis, and in all. */
  readonly slotsPerAxis: number;
  readonly slots: number;
  /** The page table (RGBA8 per entry, x fastest), and entries changed since `takeDirty`. */
  readonly pages: Uint8Array;
  private dirty = new Set<number>();
  /** Bricks' first ids, per level (an id is a level's first plus the brick's place in its grid). */
  private readonly firstId: number[] = [];
  /** Each slot's brick (-1 free), when it was last wanted, and each held brick's slot. */
  private readonly slotBrick: Int32Array;
  private readonly slotWanted: Float64Array;
  private readonly slotOf = new Map<number, number>();
  /** Bricks found to be one value, their value. */
  private readonly constants = new Map<number, number>();
  /** Bricks that could not be read: not asked for again. */
  private readonly failed = new Set<number>();
  /** Per brick, the least and most tissue (0..255) near it in the coarse level. */
  private readonly tissue = new Map<number, number>();
  private readonly toContext: Mat4;
  /** The bricks wanted, most needed first, and when the choice was made. */
  wanted: number[] = [];
  private wantedSet = new Set<number>();
  private choice = 0;
  private readonly loading = new Map<number, AbortController>();
  /** Bricks read and placed, for the atlas: the slot and its voxels (SLOT³). */
  uploads: { slot: number; data: Uint8Array }[] = [];
  /** A brick was placed (or a choice changed what is held). */
  onChange: (() => void) | undefined;

  constructor(
    levels: BrickLevel[],
    layout: PageLayout,
    slotsPerAxis: number,
    private readonly context: BrickContext,
    private readonly load: BrickLoader,
  ) {
    this.levels = levels;
    this.layout = layout;
    this.slotsPerAxis = slotsPerAxis;
    this.slots = slotsPerAxis ** 3;
    this.slotBrick = new Int32Array(this.slots).fill(-1);
    this.slotWanted = new Float64Array(this.slots);
    this.pages = new Uint8Array(layout.size[0] * layout.size[1] * layout.size[2] * 4);
    let id = 0;
    for (const g of layout.grids) {
      this.firstId.push(id);
      id += g[0] * g[1] * g[2];
    }
    this.toContext = invert(context.voxelToRas);
  }

  /** Whether a coarse-level voxel position is tissue. */
  private inTissue(p: Vec3, threshold: number): boolean {
    const { data, size, darkBackground } = this.context;
    const [x, y, z] = p.map(Math.round);
    if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) return false;
    const raw = data[(z * size[1] + y) * size[0] + x];
    return (darkBackground ? raw : 255 - raw) >= threshold * 255;
  }

  /** A brick's id from its level and place in the level's grid. */
  id(level: number, b: ArrayLike<number>): number {
    const g = this.layout.grids[level];
    return this.firstId[level] + (b[2] * g[1] + b[1]) * g[0] + b[0];
  }

  /** A brick's level and place in the level's grid. */
  brick(id: number): { level: number; b: Vec3 } {
    let level = this.firstId.length - 1;
    while (this.firstId[level] > id) --level;
    const g = this.layout.grids[level];
    const i = id - this.firstId[level];
    return { level, b: [i % g[0], Math.floor(i / g[0]) % g[1], Math.floor(i / (g[0] * g[1]))] };
  }

  /** A brick's entry in the page table (its texel's index). */
  page(id: number): number {
    const { level, b } = this.brick(id);
    const o = this.layout.offsets[level];
    const s = this.layout.size;
    return ((o[2] + b[2]) * s[1] + o[1] + b[1]) * s[0] + o[0] + b[0];
  }

  private setPage(id: number, entry: [number, number, number, number]): void {
    const t = this.page(id);
    this.pages.set(entry, 4 * t);
    this.dirty.add(t);
  }

  /** Page table texels changed since last asked. */
  takeDirty(): number[] {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }

  /** Slot s's corner in the atlas, in slots. */
  slotAt(s: number): Vec3 {
    const n = this.slotsPerAxis;
    return [s % n, Math.floor(s / n) % n, Math.floor(s / (n * n))];
  }

  get held(): number {
    return this.slotOf.size;
  }

  get pending(): number {
    return this.loading.size;
  }

  /** The least and most tissue (0..255, difference from the background) near brick `id` in the coarse level; outside the image counts as background. */
  tissueNear(id: number): [number, number] {
    const known = this.tissue.get(id);
    if (known !== undefined) return [known >> 8, known & 255];
    const { level, b } = this.brick(id);
    const l = this.levels[level];
    const toContext = multiply(this.toContext, l.voxelToRas);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const corner of boxCorners(l.size, b)) {
      for (let r = 0; r < 3; ++r) {
        const v = toContext[4 * r] * corner[0] + toContext[4 * r + 1] * corner[1] + toContext[4 * r + 2] * corner[2] + toContext[4 * r + 3];
        lo[r] = Math.min(lo[r], v);
        hi[r] = Math.max(hi[r], v);
      }
    }
    // The context's voxels whose interpolation reaches the box, and one more.
    const { data, size, darkBackground } = this.context;
    const from = lo.map((v) => Math.floor(v) - 1);
    const to = hi.map((v) => Math.ceil(v) + 1);
    let least = from.some((v) => v < 0) || to.some((v, k) => v > size[k] - 1) ? 0 : 255;
    let most = 0;
    for (let z = Math.max(0, from[2]); z <= Math.min(size[2] - 1, to[2]); ++z) {
      for (let y = Math.max(0, from[1]); y <= Math.min(size[1] - 1, to[1]); ++y) {
        const row = (z * size[1] + y) * size[0];
        for (let x = Math.max(0, from[0]); x <= Math.min(size[0] - 1, to[0]); ++x) {
          const v = darkBackground ? data[row + x] : 255 - data[row + x];
          if (v < least) least = v;
          if (v > most) most = v;
        }
      }
    }
    if (most < least) least = most;
    this.tissue.set(id, (least << 8) | most);
    return [least, most];
  }

  /** The camera and display-to-coarse-voxel map while bricks are chosen, when hidden bricks can be told (a perspective view from outside the tissue). */
  private occlusion: { eye: Vec3; toContext: Mat4; view: BrickView } | undefined;

  /** Whether a box is hidden: every ray from the camera to its centre and corners meets tissue first. */
  hidden(corners: Vec3[]): boolean {
    const o = this.occlusion;
    if (o === undefined) return false;
    const centre: Vec3 = [0, 1, 2].map((k) => corners.reduce((s, c) => s + c[k], 0) / corners.length) as Vec3;
    return [centre, ...corners].every((p) => this.blocked(o.eye, p));
  }

  /** Whether the coarse level has tissue (outside the cut-away octant) between the camera and a display point, a few voxels short of it. */
  private blocked(eye: Vec3, target: Vec3): boolean {
    const o = this.occlusion!;
    const { data, size, darkBackground } = this.context;
    const a = applyRow(o.toContext, eye);
    const b = applyRow(o.toContext, target);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const threshold = o.view.threshold * 255;
    const cut = o.view.cut;
    for (let d = 1; d < length - 3; d += 1.5) {
      const t = d / length;
      const x = Math.round(a[0] + (b[0] - a[0]) * t);
      const y = Math.round(a[1] + (b[1] - a[1]) * t);
      const z = Math.round(a[2] + (b[2] - a[2]) * t);
      if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) continue;
      const raw = data[(z * size[1] + y) * size[0] + x];
      if ((darkBackground ? raw : 255 - raw) < threshold) continue;
      if (cut !== undefined) {
        const p = [0, 1, 2].map((k) => eye[k] + (target[k] - eye[k]) * t);
        if ([0, 1, 2].every((k) => (p[k] - cut.point[k]) * cut.side[k] >= 0)) continue;
      }
      return true;
    }
    return false;
  }

  /** A brick of `level` as the view sees it; undefined when it is not needed. */
  private candidate(level: number, b: Vec3, view: BrickView, voxel: number, toDisplay: Mat4): Candidate | undefined {
    const id = this.id(level, b);
    const corners = boxCorners(this.levels[level].size, b).map((c) => applyRow(toDisplay, c));
    // In the frustum: not all corners outside one clip plane.
    const clips = corners.map((c) => clip(view.viewProjection, c));
    for (const plane of PLANES) if (clips.every((c) => plane[0] * c[0] + plane[1] * c[1] + plane[2] * c[2] + plane[3] * c[3] < 0)) return undefined;
    // Not inside the removed octant, and whether it meets it (the cut's faces).
    let onCut = false;
    if (view.cut !== undefined) {
      const { point, side } = view.cut;
      let inside = true;
      let meets = true;
      for (let k = 0; k < 3; ++k) {
        const s = corners.map((c) => (c[k] - point[k]) * side[k]);
        if (Math.min(...s) < 0) inside = false;
        if (Math.max(...s) < 0) meets = false;
      }
      if (inside) return undefined;
      onCut = meets;
    }
    // Tissue near it, and background (or the cut) too: else no ray stops in it.
    const [least, most] = this.tissueNear(id);
    const threshold = view.threshold * 255;
    if (most < threshold || (least >= threshold && !onCut)) return undefined;
    if (this.hidden(corners)) return undefined;
    // A pixel's size at its nearest corner (in depth: the least w).
    let nearest = clips[0];
    let at = corners[0];
    clips.forEach((c, i) => {
      if (c[3] < nearest[3]) {
        nearest = c;
        at = corners[i];
      }
    });
    let pixel = 0;
    if (nearest[3] > 1e-9) {
      const [x, y, z] = [nearest[0] / nearest[3], nearest[1] / nearest[3], nearest[2] / nearest[3]];
      const next = unproject(view.invViewProjection, x, y + 2 / view.height, z);
      pixel = Math.hypot(next[0] - at[0], next[1] - at[1], next[2] - at[2]);
    }
    const boost = onCut ? 2 : 1;
    return { id, level, corners, error: pixel > 0 ? (voxel / pixel) * boost : Infinity, near: pixel / boost };
  }

  /**
   * Chooses the bricks the view wants (see the top of the file), most
   * needed first, and starts reading those not held.
   */
  choose(view: BrickView): number[] {
    const L = this.levels.length;
    const finest = Math.min(Math.max(0, view.finest), L - 1);
    const toDisplay = this.levels.map((l) => multiply(view.toDisplay, l.voxelToRas));
    const voxel = toDisplay.map((m) => Math.min(...[0, 1, 2].map((c) => Math.hypot(m[c], m[4 + c], m[8 + c]))));
    const cost = (c: Candidate) => (this.constants.has(c.id) ? 0 : 1);
    // Hidden bricks are told from the camera, when it is a point outside the tissue.
    const eye = eyeOf(view.viewProjection);
    const displayToContext = multiply(this.toContext, invert(view.toDisplay));
    this.occlusion = eye === undefined ? undefined : { eye, toContext: displayToContext, view };
    if (eye !== undefined && this.inTissue(applyRow(displayToContext, eye), view.threshold)) this.occlusion = undefined;
    // From the coarsest level's bricks.
    const top = L - 1;
    const seen = new Set<number>();
    let chosen: Candidate[] = [];
    const g = this.layout.grids[top];
    for (let z = 0; z < g[2]; ++z) {
      for (let y = 0; y < g[1]; ++y) {
        for (let x = 0; x < g[0]; ++x) {
          const c = this.candidate(top, [x, y, z], view, voxel[top], toDisplay[top]);
          if (c !== undefined) chosen.push(c);
          seen.add(this.id(top, [x, y, z]));
        }
      }
    }
    chosen.sort((a, b) => b.error - a.error);
    let used = 0;
    chosen = chosen.filter((c) => (used += cost(c)) <= this.slots);
    // Split the bricks most in need (a max-heap on error) while they have slots.
    const heap = new Heap<Candidate>((a, b) => a.error > b.error);
    for (const c of chosen) heap.push(c);
    const leaves: Candidate[] = [];
    for (let c = heap.pop(); c !== undefined; c = heap.pop()) {
      if (c.error <= 1 || c.level <= finest) {
        leaves.push(c);
        continue;
      }
      const children: Candidate[] = [];
      const finer = c.level - 1;
      const fromDisplay = invert(toDisplay[finer]);
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const corner of c.corners) {
        const v = applyRow(fromDisplay, corner);
        for (let k = 0; k < 3; ++k) {
          lo[k] = Math.min(lo[k], v[k]);
          hi[k] = Math.max(hi[k], v[k]);
        }
      }
      // Bricks of the finer level that its box overlaps (not just touches).
      const grid = this.layout.grids[finer];
      const first = lo.map((v) => Math.max(0, Math.floor((v + 0.5 + 1e-6) / BRICK)));
      const last = hi.map((v, k) => Math.min(grid[k] - 1, Math.floor((v + 0.5 - 1e-6) / BRICK)));
      for (let z = first[2]; z <= last[2]; ++z) {
        for (let y = first[1]; y <= last[1]; ++y) {
          for (let x = first[0]; x <= last[0]; ++x) {
            const id = this.id(finer, [x, y, z]);
            if (seen.has(id)) continue;
            seen.add(id);
            const child = this.candidate(finer, [x, y, z], view, voxel[finer], toDisplay[finer]);
            if (child !== undefined) children.push(child);
          }
        }
      }
      const more = children.reduce((s, k) => s + cost(k), 0) - cost(c);
      if (used + more > this.slots) {
        leaves.push(c);
        continue;
      }
      used += more;
      for (const k of children) heap.push(k);
    }
    leaves.sort((a, b) => a.near - b.near);
    this.wanted = leaves.map((c) => c.id);
    this.wantedSet = new Set(this.wanted);
    this.choice += 1;
    for (const id of this.wanted) {
      const s = this.slotOf.get(id);
      if (s !== undefined) this.slotWanted[s] = this.choice;
    }
    for (const [id, controller] of this.loading) {
      if (this.wantedSet.has(id)) continue;
      controller.abort();
      this.loading.delete(id);
    }
    this.pump();
    return this.wanted;
  }

  /** Starts reading wanted bricks not held, nearest first, a few at a time. */
  private pump(): void {
    for (const id of this.wanted) {
      if (this.loading.size >= LOADING) break;
      if (this.slotOf.has(id) || this.constants.has(id) || this.failed.has(id) || this.loading.has(id)) continue;
      const controller = new AbortController();
      this.loading.set(id, controller);
      const { level, b } = this.brick(id);
      const l = this.levels[level];
      const region = brickRegion(l.size, b);
      this.load(l.index, region, controller.signal).then(
        (data) => {
          if (controller.signal.aborted) return;
          this.loading.delete(id);
          const slot = fillSlot(data, region, l.size, b);
          this.place(id, slot.data, slot.constant);
          this.pump();
          this.onChange?.();
        },
        () => {
          if (controller.signal.aborted) return;
          this.loading.delete(id);
          this.failed.add(id);
          this.pump();
        },
      );
    }
  }

  /**
   * Holds brick `id`: one value goes in its page entry; else, if still
   * wanted, into a free slot or the slot of the brick least recently wanted
   * (whose entry is then absent).
   */
  place(id: number, data: Uint8Array, constant: number | undefined): void {
    if (constant !== undefined) {
      this.constants.set(id, constant);
      this.setPage(id, [constant, 0, 0, CONSTANT]);
      return;
    }
    if (!this.wantedSet.has(id)) return;
    let slot = this.slotOf.get(id);
    if (slot === undefined) {
      slot = 0;
      for (let s = 0; s < this.slots; ++s) {
        if (this.slotBrick[s] === -1) {
          slot = s;
          break;
        }
        if (this.slotWanted[s] < this.slotWanted[slot]) slot = s;
      }
      const old = this.slotBrick[slot];
      if (old !== -1) {
        this.slotOf.delete(old);
        this.setPage(old, [0, 0, 0, ABSENT]);
      }
      this.slotBrick[slot] = id;
      this.slotOf.set(id, slot);
    }
    this.slotWanted[slot] = this.choice;
    this.setPage(id, [...this.slotAt(slot), RESIDENT]);
    this.uploads.push({ slot, data });
  }

  /** Stops reading. */
  dispose(): void {
    for (const controller of this.loading.values()) controller.abort();
    this.loading.clear();
    this.onChange = undefined;
  }
}

/** The corners of brick b's box (its voxels' cells), in the level's voxel coordinates. */
function boxCorners(size: Vec3, b: Vec3): Vec3[] {
  const lo = b.map((v) => v * BRICK - 0.5);
  const hi = b.map((v, k) => Math.min(size[k], v * BRICK + BRICK) - 0.5);
  return Array.from({ length: 8 }, (_, c) => [0, 1, 2].map((k) => ((c >> k) & 1 ? hi[k] : lo[k])) as Vec3);
}

function applyRow(m: Mat4, p: ArrayLike<number>): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (let r = 0; r < 3; ++r) out[r] = m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3];
  return out;
}

/** A binary heap: `before(a, b)` puts a nearer the top. */
class Heap<T> {
  private items: T[] = [];
  constructor(private readonly before: (a: T, b: T) => boolean) {}

  push(item: T): void {
    const a = this.items;
    a.push(item);
    for (let i = a.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!this.before(a[i], a[parent])) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.before(a[l], a[m])) m = l;
        if (r < a.length && this.before(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The camera of a perspective view, display coordinates: the point clip
 * space puts at x = y = w = 0 (vp column-major).  Undefined for an
 * orthographic view (no such point).
 */
export function eyeOf(vp: ArrayLike<number>): Vec3 | undefined {
  const rows = [0, 1, 3].map((r) => [vp[r], vp[4 + r], vp[8 + r], vp[12 + r]]);
  const m = rows.map((r) => r.slice(0, 3));
  const rhs = rows.map((r) => -r[3]);
  const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const D = det(m);
  if (Math.abs(D) < 1e-12) return undefined;
  return [0, 1, 2].map((k) => det(m.map((row, i) => row.map((v, j) => (j === k ? rhs[i] : v)))) / D) as Vec3;
}
