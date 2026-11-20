/**
 * Multiscale bricks (plans/adaptive-multiscale.md), shared by this browser's two renderers (the WebGL one, live.ts,
 * and the WebGPU one, local/local.ts): each image's regions and the level each is chosen and drawn at, the bricks
 * read for them (by the image's own reader, so their values are the base's) and the pool's slots they are in, and
 * the table the shaders look regions and bricks up in. The bricks are held here (on the CPU) in their slots; each
 * renderer copies the slots written since it last looked into its own pool.
 *
 * - Levels are chosen where the camera rests (`plan`), again once it has moved a fifth of its distance.
 * - A region steps up a level at a time toward the one chosen, switched as soon as that level's bricks are all held;
 *   bricks are read coarser levels first, then nearest first, eight at a time.
 * - A slot is reused for a new brick when no region draws its brick and the plan now does not want it (the least
 *   recently wanted first).
 */
import { APRON, BRICK_SIDE, brickCount, chooseLevels, finerLevels, levelShares, MAX_LEVELS, type MsLevel, REGION, regionBricks, regionGrid, SLOT } from "./adaptive.js";
import { type Level8, readerUrl } from "./local/local.js";
import { VolumeClient } from "../volume-view/volume_client.js";

/** The pool: SLOT³ voxels a slot, POOL_X × POOL_Y × POOL_Z slots (about 97 MB at a byte a voxel). */
export const POOL_X = 56;
export const POOL_Y = 37;
export const POOL_Z = 1;
export const POOL_SLOTS = POOL_X * POOL_Y * POOL_Z;
/** The table's width (entries of four 32-bit numbers: a texture's row, or as a buffer, its length is all that counts). */
export const MS_TABLE_W = 4096;
/** Bricks read at once. */
const READS = 8;

type V3 = [number, number, number];

/** What a plan needs of the view: the camera (column-major), the view's height (pixels) and the image's place. */
export interface PlanView {
  invViewProjection: ArrayLike<number>;
  viewProjection: ArrayLike<number>;
  height: number;
  /** Base voxel to world (column-major). */
  worldFromVox: ArrayLike<number>;
  cropLo: ArrayLike<number>;
  cropHi: ArrayLike<number>;
  /** What else the choice depends on (the cuts, the table): a change chooses again. */
  key: string;
}

/** The table and what the shaders take with it. */
export interface MsTable {
  /** Entries of four 32-bit numbers: each image's regions (in the order asked for), then each region's bricks' slots. */
  data: Uint32Array;
  rows: number;
  /** Per image: whether it is multiscale, its first region's entry, its regions along x, y, z, and its levels' scale and offset. */
  ms: Int32Array;
  base: Int32Array;
  grid: Float32Array;
  scale: Float32Array;
  off: Float32Array;
  /** The slots it points at (pinned by a renderer drawing with it: not reused until it lets them go). */
  slots: Set<number>;
}

interface Held {
  slot: number;
  /** Regions drawn with it. */
  refs: number;
  /** The plan that last wanted it. */
  last: number;
  /** Its least and greatest values (0…1). */
  lo: number;
  hi: number;
}

interface Image {
  url: string;
  client: VolumeClient | undefined;
  opened: Promise<void>;
  basePath: string;
  levels: MsLevel[];
  grid: V3;
  size: V3;
  chosen: Uint8Array;
  active: Uint8Array;
  activeKeys: Map<number, string[]>;
  want: Map<number, { level: number; keys: string[] }>;
  rank: Map<number, number>;
  planEye?: number[];
  planKey?: string;
}

/** The pool's slot at x, y, z (in slots). */
export function slotAt(slot: number): V3 {
  return [slot % POOL_X, Math.floor(slot / POOL_X) % POOL_Y, Math.floor(slot / (POOL_X * POOL_Y))];
}

export class Multiscale {
  /** Called as bricks come and regions switch (now and then): the panel and the views drawn again. */
  private readonly listeners = new Set<() => void>();
  /** Counts each change to the table (the light held and the path tracer start again once they take it). */
  version = 0;
  /** When levels were last chosen. */
  plannedAt = 0;
  private readonly images = new Map<string, Image>();
  private readonly bricks = new Map<string, Held>();
  private readonly pins = new Map<object, Set<number>>();
  private readonly slotData: (Uint8Array | undefined)[];
  private readonly slotStamp: Uint32Array;
  private stamp = 0;
  private free: number[];
  private queue: { image: Image; key: string; level: MsLevel; brick: V3; plan: number; order: number }[] = [];
  private readonly reading = new Set<string>();
  private planNo = 0;
  private read = 0;
  private told = 0;
  private tableCache: { key: string; table: MsTable } | undefined;

  private readonly redraws = new Set<() => void>();

  /** `poolSlots`: the pool's slots (fewer in tests, so slots are reused). */
  constructor(private readonly poolSlots = POOL_SLOTS) {
    this.slotData = new Array(poolSlots);
    this.slotStamp = new Uint32Array(poolSlots);
    this.free = Array.from({ length: poolSlots }, (_, i) => poolSlots - 1 - i);
  }

  /** Calls `f` as bricks come and regions switch (now and then); returns what stops it. */
  listen(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** Calls `f` as each brick comes (the views drawn again, taking it); returns what stops it. */
  listenRedraw(f: () => void): () => void {
    this.redraws.add(f);
    return () => this.redraws.delete(f);
  }

  /**
   * An image to draw multiscale: its level read whole (with every level's place). Its bricks are read by a reader of
   * its own, opened as `readLevel` opens one (so their values are the base's). False: no finer level lies over it.
   */
  attach(url: string, level: Level8): boolean {
    const had = this.images.get(url);
    if (had !== undefined && had.basePath === level.path) return had.levels.length > 0;
    if (had !== undefined) this.detach(url);
    const base = level.levels?.find((l) => l.path === level.path);
    if (base === undefined || level.levels === undefined) return false;
    const levels = finerLevels(
      { voxelToRas: level.voxelToRas, voxelMm: base.voxelMm },
      level.levels.flatMap((l, index) => (l.voxelToRas ? [{ index, path: l.path, size: l.size, voxelMm: l.voxelMm, voxelToRas: l.voxelToRas }] : [])),
    );
    const size = [...level.size] as V3;
    const grid = regionGrid(size);
    const n = grid[0] * grid[1] * grid[2];
    let reader: string | undefined;
    try {
      reader = readerUrl(url);
    } catch {
      // Not a store this browser reads: drawn at its base.
    }
    let client: VolumeClient | undefined;
    if (levels.length > 0 && reader !== undefined) {
      client = new VolumeClient();
      const opened = client.open([reader], undefined, { full: true }).then(() => undefined);
      opened.catch(() => undefined);
      this.images.set(url, { url, client, opened, basePath: level.path, levels, grid, size, chosen: new Uint8Array(n), active: new Uint8Array(n), activeKeys: new Map(), want: new Map(), rank: new Map() });
    } else this.images.set(url, { url, client: undefined, opened: Promise.resolve(), basePath: level.path, levels: [], grid, size, chosen: new Uint8Array(n), active: new Uint8Array(n), activeKeys: new Map(), want: new Map(), rank: new Map() });
    return client !== undefined;
  }

  /** An image let go: its regions' bricks no longer drawn (kept until their slots are wanted). */
  detach(url: string): void {
    const image = this.images.get(url);
    if (image === undefined) return;
    for (const keys of image.activeKeys.values()) this.release(keys);
    this.images.delete(url);
    image.client?.dispose();
    this.queue = this.queue.filter((q) => q.image !== image);
    this.changed();
  }

  /** Regions of an image drawn coarser than chosen (bricks still coming, or no room for them). */
  unreached(url: string): number {
    const image = this.images.get(url);
    let n = 0;
    if (image) for (let r = 0; r < image.chosen.length; ++r) if (image.active[r] < image.chosen[r]) ++n;
    return n;
  }

  /** Every image let go (Multiscale switched off). */
  clear(): void {
    for (const url of [...this.images.keys()]) this.detach(url);
  }

  has(url: string): boolean {
    return (this.images.get(url)?.levels.length ?? 0) > 0;
  }

  /** The levels an image is drawn at and their shares of it; undefined when it is not multiscale. */
  shares(url: string, basePath: string): { path: string; share: number }[] | undefined {
    const image = this.images.get(url);
    if (image === undefined || image.levels.length === 0) return undefined;
    const s = levelShares(image.active, image.grid, image.size, image.levels.length);
    return [basePath, ...image.levels.map((l) => l.path)].map((path, i) => ({ path, share: s[i] }));
  }

  /** Whether regions wait for bricks that are coming. */
  busy(): boolean {
    const waiting = [...this.images.values()].some((i) => i.want.size > 0);
    if (!waiting) return false;
    if (this.queue.length > 0 || this.reading.size > 0) return true;
    // Nothing more coming (the pool full): what could not be held stays where it is.
    for (const i of this.images.values()) i.want.clear();
    return false;
  }

  /** What the bricks are doing, in a few words ("" when nothing). */
  get text(): string {
    return this.queue.length > 0 || this.reading.size > 0 ? `Multiscale: reading finer levels, ${this.read} bricks read, ${this.queue.length + this.reading.size} to go` : "";
  }

  /** The slots written since `since` (a stamp this gave), and the stamp now. */
  written(since: number): { slots: number[]; stamp: number } {
    const slots: number[] = [];
    if (since < this.stamp) for (let s = 0; s < this.poolSlots; ++s) if (this.slotStamp[s] > since && this.slotData[s] !== undefined) slots.push(s);
    return { slots, stamp: this.stamp };
  }

  /** A slot's brick: SLOT³ bytes, x fastest. */
  slotBytes(slot: number): Uint8Array | undefined {
    return this.slotData[slot];
  }

  /**
   * The least and greatest values (0…1) of each of a base's cells (`cell` voxels a side, `cells` along x, y, z) where
   * a region of it is drawn finer: from that level's bricks (what tracking must bound there). Undefined where not.
   */
  cellBounds(url: string, cell: number, cells: V3): Map<number, [number, number]> | undefined {
    const image = this.images.get(url);
    if (image === undefined) return undefined;
    const out = new Map<number, [number, number]>();
    for (const [r, keys] of image.activeKeys) {
      let lo = 1;
      let hi = 0;
      for (const k of keys) {
        const h = this.bricks.get(k);
        if (h === undefined) continue;
        lo = Math.min(lo, h.lo);
        hi = Math.max(hi, h.hi);
      }
      const g = [r % image.grid[0], Math.floor(r / image.grid[0]) % image.grid[1], Math.floor(r / (image.grid[0] * image.grid[1]))];
      const a = g.map((x) => Math.floor((x * REGION) / cell));
      const b = g.map((x, k) => Math.min(cells[k], Math.ceil(Math.min((x + 1) * REGION, image.size[k]) / cell)));
      for (let z = a[2]; z < b[2]; ++z) for (let y = a[1]; y < b[1]; ++y) for (let x = a[0]; x < b[0]; ++x) out.set(x + cells[0] * (y + cells[1] * z), [lo, hi]);
    }
    return out;
  }

  /**
   * Chooses each region of an image's level for the view at rest (adaptive.ts chooseLevels): a region's error is its
   * level's voxel over the size of a pixel there; off screen, cropped away or `clear` at the base, it stays there.
   * Again only once the camera has moved a fifth of its distance, or the view's key changed. `slots`: its share of
   * the pool.
   */
  plan(url: string, view: PlanView, slots: number, clear?: (region: number) => boolean): void {
    const image = this.images.get(url);
    if (image === undefined || image.levels.length === 0) return;
    const inv = view.invViewProjection;
    const un = (x: number, y: number, z: number) => {
      const w = [0, 1, 2, 3].map((r) => inv[r] * x + inv[4 + r] * y + inv[8 + r] * z + inv[12 + r]);
      return [w[0] / w[3], w[1] / w[3], w[2] / w[3]];
    };
    const eye = un(0, 0, -1);
    const far = un(0, 0, 1);
    const dir = far.map((x, k) => x - eye[k]);
    const len = Math.hypot(...dir);
    const wfv = view.worldFromVox;
    const { grid, size, levels } = image;
    if (image.planEye !== undefined && image.planKey === view.key) {
      const moved = Math.hypot(...eye.map((x, k) => x - image.planEye![k]));
      const centre = [0, 1, 2].map((r) => wfv[r] * (size[0] / 2) + wfv[4 + r] * (size[1] / 2) + wfv[8 + r] * (size[2] / 2) + wfv[12 + r]);
      const at = Math.hypot(...eye.map((x, k) => x - centre[k]));
      if (moved < 0.2 * at) return;
    }
    image.planEye = eye;
    image.planKey = view.key;
    // A pixel's angle at the view's centre (radians).
    const n2 = un(2 / Math.max(1, view.height), 0, 1);
    const n1 = un(2 / Math.max(1, view.height), 0, -1);
    const d2 = n2.map((x, k) => x - n1[k]);
    const cos = (dir[0] * d2[0] + dir[1] * d2[1] + dir[2] * d2[2]) / (len * Math.hypot(...d2));
    const pixelAngle = Math.acos(Math.min(1, Math.max(-1, cos)));
    const vp = view.viewProjection;
    const regions = grid[0] * grid[1] * grid[2];
    const pixel = new Float32Array(regions);
    for (let gz = 0, r = 0; gz < grid[2]; ++gz)
      for (let gy = 0; gy < grid[1]; ++gy)
        for (let gx = 0; gx < grid[0]; ++gx, ++r) {
          const c = [gx, gy, gz].map((g, k) => (g * REGION + Math.min((g + 1) * REGION, size[k])) / 2 - 0.5);
          if (c.some((x, k) => x < view.cropLo[k] - REGION || x > view.cropHi[k] + REGION)) {
            pixel[r] = Infinity;
            continue;
          }
          const w = [0, 1, 2].map((row) => wfv[row] * c[0] + wfv[4 + row] * c[1] + wfv[8 + row] * c[2] + wfv[12 + row]);
          const clip = [0, 1, 2, 3].map((row) => vp[row] * w[0] + vp[4 + row] * w[1] + vp[8 + row] * w[2] + vp[12 + row]);
          if (clip[3] <= 0 || Math.abs(clip[0] / clip[3]) > 1.3 || Math.abs(clip[1] / clip[3]) > 1.3) {
            pixel[r] = Infinity;
            continue;
          }
          pixel[r] = Math.hypot(w[0] - eye[0], w[1] - eye[1], w[2] - eye[2]) * pixelAngle;
        }
    // The base voxel's size in the world: the longest of its edges.
    const baseVoxel = Math.max(...[0, 1, 2].map((c) => Math.hypot(wfv[4 * c], wfv[4 * c + 1], wfv[4 * c + 2])));
    const voxelWorld = [baseVoxel, ...levels.map((l) => baseVoxel / Math.max(...l.scale))];
    const at = (r: number): V3 => [r % grid[0], Math.floor(r / grid[0]) % grid[1], Math.floor(r / (grid[0] * grid[1]))];
    image.chosen = chooseLevels({ regions, levels: levels.length, voxelWorld, pixel, slots, cost: (r, l) => brickCount(at(r), levels[l - 1], size), skip: clear, current: image.active, grid });
    const plan = ++this.planNo;
    this.read = 0;
    this.plannedAt = performance.now();
    image.want.clear();
    const order: { r: number; px: number }[] = [];
    let changed = false;
    for (let r = 0; r < regions; ++r) {
      const want = image.chosen[r];
      if (want === image.active[r]) {
        for (const k of image.activeKeys.get(r) ?? []) this.bricks.get(k)!.last = plan;
        continue;
      }
      if (want < image.active[r]) {
        // Coarser: drawn at the base at once, its bricks let go.
        this.release(image.activeKeys.get(r) ?? []);
        image.activeKeys.delete(r);
        image.active[r] = 0;
        changed = true;
      }
      if (want > 0) order.push({ r, px: pixel[r] });
    }
    order.sort((a, b) => a.px - b.px);
    this.queue = this.queue.filter((q) => q.image !== image);
    image.rank = new Map(order.map((o, i) => [o.r, i]));
    for (const { r } of order) this.request(image, r, plan);
    if (changed) this.changed();
    this.pump();
  }

  /** The table for the images in `urls` (the order the shaders index them in), made again only when it changed. */
  table(urls: string[]): MsTable {
    const key = `${this.version}|${urls.join("\n")}`;
    if (this.tableCache?.key === key) return this.tableCache.table;
    const n = urls.length;
    const t: MsTable = { slots: new Set(), data: new Uint32Array(0), rows: 1, ms: new Int32Array(n), base: new Int32Array(n), grid: new Float32Array(3 * n).fill(1), scale: new Float32Array(3 * MAX_LEVELS * n).fill(1), off: new Float32Array(3 * MAX_LEVELS * n) };
    const images = urls.map((u) => this.images.get(u)).map((i) => (i !== undefined && i.levels.length > 0 ? i : undefined));
    let regions = 0;
    let bricks = 0;
    for (const i of images) {
      if (i === undefined) continue;
      regions += i.active.length;
      for (const keys of i.activeKeys.values()) bricks += keys.length;
    }
    t.rows = Math.max(1, Math.ceil((regions + bricks) / MS_TABLE_W));
    const data = new Uint32Array(4 * MS_TABLE_W * t.rows);
    let next = regions;
    let at = 0;
    images.forEach((i, k) => {
      if (i === undefined) return;
      t.ms[k] = 1;
      t.base[k] = at;
      t.grid.set(i.grid, 3 * k);
      i.levels.forEach((l, j) => {
        t.scale.set(l.scale, 3 * (k * MAX_LEVELS + j));
        t.off.set(l.offset, 3 * (k * MAX_LEVELS + j));
      });
      for (let r = 0; r < i.active.length; ++r, ++at) {
        const level = i.active[r];
        if (level === 0) continue;
        const keys = i.activeKeys.get(r)!;
        const g = [r % i.grid[0], Math.floor(r / i.grid[0]) % i.grid[1], Math.floor(r / (i.grid[0] * i.grid[1]))] as V3;
        const { b0, n: cnt } = regionBricks(g, i.levels[level - 1], i.size);
        data[4 * at] = level | (cnt[0] << 8) | (cnt[1] << 16) | (cnt[2] << 24);
        data[4 * at + 1] = next;
        data[4 * at + 2] = b0[0] | (b0[1] << 16);
        data[4 * at + 3] = b0[2];
        for (const kk of keys) {
          const slot = this.bricks.get(kk)!.slot;
          t.slots.add(slot);
          data[4 * next++] = slot;
        }
      }
    });
    t.data = data;
    this.tableCache = { key, table: t };
    return t;
  }

  /**
   * The slots a renderer draws with now (its table's; undefined: none): not reused for other bricks while it does, so
   * what it draws between taking tables never changes under it.
   */
  pin(owner: object, slots: Set<number> | undefined): void {
    if (slots === undefined) this.pins.delete(owner);
    else this.pins.set(owner, slots);
  }

  // -------------------------------------------------------------- inside

  private changed(): void {
    ++this.version;
    queueMicrotask(() => {
      for (const f of this.redraws) f();
      this.tell(true);
    });
  }

  private tell(now = false): void {
    const t = performance.now();
    if (!now && t - this.told < 500) return;
    this.told = t;
    for (const f of this.listeners) f();
  }

  private release(keys: string[]): void {
    for (const k of keys) {
      const h = this.bricks.get(k);
      if (h) h.refs = Math.max(0, h.refs - 1);
    }
  }

  /** Asks for the bricks of a region's next level up toward the one chosen. */
  private request(image: Image, r: number, plan: number): void {
    const level = Math.min(image.chosen[r], image.active[r] + 1);
    if (level <= image.active[r]) return;
    const lv = image.levels[level - 1];
    const g = [r % image.grid[0], Math.floor(r / image.grid[0]) % image.grid[1], Math.floor(r / (image.grid[0] * image.grid[1]))] as V3;
    const { b0, n } = regionBricks(g, lv, image.size);
    const keys: string[] = [];
    const rank = image.rank.get(r) ?? 0;
    for (let z = 0; z < n[2]; ++z)
      for (let y = 0; y < n[1]; ++y)
        for (let x = 0; x < n[0]; ++x) {
          const brick = [b0[0] + x, b0[1] + y, b0[2] + z] as V3;
          const key = `${image.url}|${lv.index}|${brick.join(",")}`;
          keys.push(key);
          const held = this.bricks.get(key);
          if (held !== undefined) held.last = plan;
          else if (!this.reading.has(key)) this.queue.push({ image, key, level: lv, brick, plan, order: level * 1e7 + rank });
        }
    image.want.set(r, { level, keys });
    this.queue.sort((a, b) => a.order - b.order);
    this.activate(image);
  }

  /** Regions whose bricks are all held: drawn at their level, and the next level up asked for. */
  private activate(image: Image): void {
    let any = false;
    for (const [r, w] of image.want) {
      if (!w.keys.every((k) => this.bricks.has(k))) continue;
      this.release(image.activeKeys.get(r) ?? []);
      for (const k of w.keys) this.bricks.get(k)!.refs++;
      image.activeKeys.set(r, w.keys);
      image.active[r] = w.level;
      image.want.delete(r);
      any = true;
      if (image.chosen[r] > image.active[r]) this.request(image, r, this.planNo);
    }
    if (any) this.changed();
  }

  /** A free slot, or one whose brick no region draws or waits for (the least recently wanted). */
  private slot(): number | undefined {
    const free = this.free.pop();
    if (free !== undefined) return free;
    let oldest: [string, Held] | undefined;
    // Not drawn, not waited for by a region (its level's bricks not all here yet), not pinned by a renderer. (A level a
    // region has passed through on the way to a finer one is let go so: the budget counts each region's final level.)
    const pinned = new Set<number>();
    for (const p of this.pins.values()) for (const slot of p) pinned.add(slot);
    const waited = new Set<string>();
    for (const image of this.images.values()) for (const w of image.want.values()) for (const k of w.keys) waited.add(k);
    for (const e of this.bricks) if (e[1].refs === 0 && (oldest === undefined || e[1].last < oldest[1].last) && !pinned.has(e[1].slot) && !waited.has(e[0])) oldest = e;
    if (oldest === undefined) return undefined;
    this.bricks.delete(oldest[0]);
    return oldest[1].slot;
  }

  private pump(): void {
    while (this.reading.size < READS && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (this.bricks.has(job.key) || this.reading.has(job.key)) continue;
      const image = job.image;
      const client = image.client;
      if (this.images.get(image.url) !== image || client === undefined) continue;
      ++this.read;
      this.reading.add(job.key);
      const size = job.level.size;
      const lo = job.brick.map((b) => Math.max(0, b * BRICK_SIDE - APRON)) as V3;
      const hi = job.brick.map((b, k) => Math.min(size[k], b * BRICK_SIDE - APRON + SLOT)) as V3;
      void image.opened
        .then(() => client.volume(job.level.index, undefined, undefined, { lo, hi }))
        .then(({ data, size: got }) => {
          if (this.images.get(image.url) !== image) return;
          // SLOT³, edge voxels repeated where the brick's apron passes the level's edge.
          const out = new Uint8Array(SLOT * SLOT * SLOT);
          const start = job.brick.map((b) => b * BRICK_SIDE - APRON);
          let min = 255;
          let max = 0;
          for (let z = 0; z < SLOT; ++z) {
            const sz = Math.min(got[2] - 1, Math.max(0, start[2] + z - lo[2]));
            for (let y = 0; y < SLOT; ++y) {
              const sy = Math.min(got[1] - 1, Math.max(0, start[1] + y - lo[1]));
              const row = (sz * got[1] + sy) * got[0];
              const to = (z * SLOT + y) * SLOT;
              for (let x = 0; x < SLOT; ++x) {
                const v = data[row + Math.min(got[0] - 1, Math.max(0, start[0] + x - lo[0]))];
                out[to + x] = v;
                if (v < min) min = v;
                if (v > max) max = v;
              }
            }
          }
          if (this.bricks.has(job.key)) return;
          const slot = this.slot();
          if (slot === undefined) return;
          this.slotData[slot] = out;
          this.slotStamp[slot] = ++this.stamp;
          this.bricks.set(job.key, { slot, refs: 0, last: job.plan, lo: min / 255, hi: max / 255 });
          this.activate(image);
        })
        .catch(() => {
          // Not read (the image let go, a network error): the region stays where it is.
        })
        .finally(() => {
          this.reading.delete(job.key);
          this.pump();
          for (const f of this.redraws) f();
          this.tell();
        });
    }
  }
}

/** The one this page draws with (both renderers: their bricks read once). */
export const multiscale = new Multiscale();

/**
 * A sample of image `k` at base voxel point `v` through table `t` (0…1; undefined where the region is drawn at the
 * base), as `msSample` in live.ts and pathtrace.wgsl take it: the CPU's copy of the shaders' lookup (the table's
 * encoding and the pool's addressing), trilinear over the slot's bytes, for tests.
 */
export function tableSample(t: MsTable, k: number, v: V3, bytes: (slot: number) => Uint8Array | undefined): number | undefined {
  if (!t.ms[k]) return undefined;
  const g = [0, 1, 2].map((i) => t.grid[3 * k + i]);
  const c = v.map((x, i) => Math.min(g[i] - 1, Math.max(0, Math.floor((x + 0.5) / REGION))));
  const at = t.base[k] + c[0] + g[0] * (c[1] + g[1] * c[2]);
  const a = [0, 1, 2, 3].map((i) => t.data[4 * at + i]);
  const level = a[0] & 255;
  if (level === 0) return undefined;
  const li = 3 * (k * MAX_LEVELS + level - 1);
  const u = v.map((x, i) => x * t.scale[li + i] + t.off[li + i]);
  const n = [(a[0] >>> 8) & 255, (a[0] >>> 16) & 255, a[0] >>> 24];
  const b0 = [a[2] & 65535, a[2] >>> 16, a[3]];
  const b = u.map((x, i) => Math.min(n[i] - 1, Math.max(0, Math.floor((x + 0.5) / BRICK_SIDE) - b0[i])));
  const slot = t.data[4 * (a[1] + b[0] + n[0] * (b[1] + n[1] * b[2]))];
  const data = bytes(slot);
  if (data === undefined) return undefined;
  // Within the slot: its apron, then the point (voxel centres at integers), clamped as the shaders clamp it.
  const p = u.map((x, i) => APRON + Math.min(BRICK_SIDE + APRON - 1.5, Math.max(0.5 - APRON, x - (b[i] + b0[i]) * BRICK_SIDE)));
  const f = p.map(Math.floor);
  const w = p.map((x, i) => x - f[i]);
  const at3 = (x: number, y: number, z: number) => data[(Math.min(SLOT - 1, z) * SLOT + Math.min(SLOT - 1, y)) * SLOT + Math.min(SLOT - 1, x)];
  let s = 0;
  for (let dz = 0; dz < 2; ++dz)
    for (let dy = 0; dy < 2; ++dy)
      for (let dx = 0; dx < 2; ++dx) s += (dx ? w[0] : 1 - w[0]) * (dy ? w[1] : 1 - w[1]) * (dz ? w[2] : 1 - w[2]) * at3(f[0] + dx, f[1] + dy, f[2] + dz);
  return s / 255;
}
