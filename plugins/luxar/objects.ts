/**
 * A layer's chosen objects read whole, by id, instead of the spatial
 * chunks that hold them.
 *
 * When a layer shows a few chosen objects (its segments, or a plugin's
 * temporary set such as a track-filtering group's), reading the chunks
 * that hold them reads far more than is shown, and coarse levels of a
 * tractogram hold only a sample of the objects, so zoomed out most of the
 * chosen ones are missing.  The store's object index says where each
 * object's vertices are, so the reader can fetch exactly those objects
 * (`ObjectReader`, in the worker).  Which way a layer is drawn is
 * `objectPlan`; `ObjectSets` keeps what has been read, by object, and asks
 * for only the objects not read yet when the selection changes.
 */
import { type BuiltChunk, PIECE_STRIDE, SAMPLES } from "./chunk_build.js";
import type { ObjectRead, StoreInfo } from "./luxar_worker.js";
import { MAX_SELECTION_BOOST } from "./view_math.js";

/** At most this many chosen objects are read whole as curves (many per request); more are drawn from chunks. */
export const MAX_CURVES = 100_000;
/** At most this many are read whole one at a time (skeletons, points, or curves coloured by a vertex attribute). */
export const MAX_SKELETONS = 2_000;
/** The first batch is small, so something shows soon; the rest come in larger batches. */
export const FIRST_BATCH = 256;
export const BATCH = 4096;
/** Objects read whole are kept (on this side) up to this many bytes; sets no chosen object is in go first. */
export const SET_BYTES = 512 * 1024 * 1024;

export interface ObjectPlan {
  /** The level read (finest first): level 0, or the finest that holds every object and fits the budget. */
  level: number;
  mode: "curves" | "skeletons";
}

/**
 * Whether a layer's chosen objects are read whole, and how: `count` chosen
 * objects, colouring by `scalar` (styles.scalarOf), with the Detail
 * (millions of vertices).  The chosen objects are read whole when there are
 * at most MAX_CURVES of them (MAX_SKELETONS read one at a time) and their
 * vertices, estimated from the level's vertices per object, are within
 * MAX_SELECTION_BOOST times the Detail, at the finest level that holds
 * every object (a level that keeps a sample of them would miss most of the
 * chosen ones).  Otherwise undefined: the chunks are read as before.
 * Once some have been read (`measured`: their mean vertices at that level),
 * that mean is used instead, and the selection may reach twice the budget.
 */
export function objectPlan(info: Pick<StoreInfo, "levels" | "objectRead">, count: number, scalar: string, detail: number, measured?: { level: number; perObject: number }): ObjectPlan | undefined {
  const read: ObjectRead = info.objectRead;
  if (read === undefined || count <= 0) return undefined;
  const mode = read === "curves" && !scalar.startsWith("attribute:") ? "curves" : "skeletons";
  if (count > (mode === "curves" ? MAX_CURVES : MAX_SKELETONS)) return undefined;
  const budget = MAX_SELECTION_BOOST * detail * 1e6;
  for (let i = 0; i < info.levels.length; ++i) {
    const level = info.levels[i];
    const share = level.objectShare ?? (i === 0 ? 1 : undefined);
    // A level that keeps a sample of the objects (or does not say) is no use here.
    if (share === undefined || share < 0.999) continue;
    const objects = level.objects ?? info.levels[0].objects;
    if (measured?.level === i) {
      // The chosen objects' own vertices, as read so far: the level's mean can be far off for a
      // bundle of long streamlines.  Twice the budget, so a selection does not go back and forth.
      if (count * measured.perObject <= 2 * budget) return { level: i, mode };
      continue;
    }
    if (level.vertexCount === undefined || objects === undefined) {
      // Unknown sizes: only a selection small enough to be safe either way.
      if (count <= MAX_SKELETONS) return { level: i, mode };
      continue;
    }
    if ((count * level.vertexCount) / objects <= budget) return { level: i, mode };
  }
  return undefined;
}

/**
 * The objects to read, in batches: those of `wanted` not `known` (read,
 * being read, or found missing), in ascending order (so a batch's rows of
 * the object index are together, and the index's chunks are read about
 * once), the first batch FIRST_BATCH when nothing has been read yet.
 */
export function planBatches(wanted: ArrayLike<bigint>, known: (id: bigint) => boolean, nothingYet: boolean): bigint[][] {
  const fresh: bigint[] = [];
  for (let i = 0; i < wanted.length; ++i) if (!known(wanted[i])) fresh.push(wanted[i]);
  fresh.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const batches: bigint[][] = [];
  let at = 0;
  if (nothingYet && fresh.length > FIRST_BATCH) {
    batches.push(fresh.slice(0, FIRST_BATCH));
    at = FIRST_BATCH;
  }
  for (; at < fresh.length; at += BATCH) batches.push(fresh.slice(at, at + BATCH));
  return batches;
}

/**
 * How many of the SAMPLES samples of the objects read whole a view draws:
 * all of them while their segments in view (the pieces `visible` says can
 * show) are within `budget` (the Detail), else about that share, at least
 * one.  Each sample is whole objects, the same ones in every piece, so a
 * view with more than its Detail draws a sample of the chosen objects, as
 * a coarse level of the store would, but whole.
 */
export function samplesFor(sets: { pieces?: Float64Array; segmentCount: number }[], visible: (lower: number[], upper: number[]) => boolean, budget: number): number {
  let segments = 0;
  for (const set of sets) {
    const p = set.pieces;
    if (p === undefined) {
      segments += set.segmentCount;
      continue;
    }
    for (let i = 0; i + PIECE_STRIDE <= p.length; i += PIECE_STRIDE) {
      if (visible([p[i + 2], p[i + 3], p[i + 4]], [p[i + 5], p[i + 6], p[i + 7]])) segments += p[i + 1];
    }
  }
  if (segments <= budget) return SAMPLES;
  return Math.max(1, Math.min(SAMPLES, Math.floor((SAMPLES * budget) / segments)));
}

const bytesOf = (c: BuiltChunk | null) =>
  c === null ? 0 : c.vertices.byteLength + c.segments.byteLength + c.slots.byteLength + c.objectIds.byteLength + c.objectWeight.byteLength + (c.pieces?.byteLength ?? 0);

/** How the sets are asked for: the worker reads `ids` whole at `plan`'s level and answers under `key`. */
export type SendObjects = (key: string, plan: ObjectPlan, ids: BigUint64Array) => void;

/**
 * The chosen objects read whole, kept by object: each answer is a set (one
 * chunk) of a batch's objects, and each object knows its set.  When the
 * selection changes only the objects not read yet are asked for; objects
 * no longer chosen are left out of the drawing by the sets' object tables,
 * and their sets are let go when memory is short.  At most `inFlight`
 * batches are asked for at once, so a new selection is not stuck behind a
 * long queue of the old one's.
 */
export class ObjectSets {
  private plan: ObjectPlan | undefined;
  private scalar = "";
  /** Each object read, and the set it is in. */
  private readonly setOf = new Map<bigint, string>();
  /** Objects read and not in the store. */
  private readonly absent = new Set<bigint>();
  private readonly sets = new Map<string, { chunk: BuiltChunk | null; ids: bigint[]; bytes: number }>();
  private readonly asked = new Map<string, bigint[]>();
  private readonly asking = new Set<bigint>();
  private queue: bigint[][] = [];
  private wanted: BigUint64Array = new BigUint64Array(0);
  private drawnKeys: string[] = [];
  private bytes = 0;
  private nextKey = 0;
  /** Vertices and objects read at this level so far (for `measured`). */
  private verticesRead = 0;
  private objectsRead = 0;
  /** Changes when every set is dropped (a new level or colouring), so views drop their copies. */
  generation = 0;
  /** Counts answers, so a view can tell when it has something new. */
  arrivals = 0;
  error: string | undefined;

  constructor(
    private readonly send: SendObjects,
    private readonly inFlight = 2,
    private readonly budget = SET_BYTES,
  ) {}

  /** Reads `wanted` whole at `plan` (undefined: none are wanted now; what was read is kept). */
  want(wanted: BigUint64Array | undefined, plan: ObjectPlan | undefined, scalar: string): void {
    if (plan !== undefined && (this.plan === undefined || plan.level !== this.plan.level || plan.mode !== this.plan.mode || scalar !== this.scalar)) {
      if (this.plan !== undefined || this.sets.size > 0) this.clear();
      this.plan = plan;
      this.scalar = scalar;
    }
    this.wanted = wanted === undefined || plan === undefined ? new BigUint64Array(0) : wanted;
    const known = (id: bigint) => this.setOf.has(id) || this.absent.has(id) || this.asking.has(id);
    this.queue = planBatches(this.wanted, known, this.setOf.size === 0 && this.asked.size === 0);
    this.updateDrawn();
    this.pump();
  }

  /** Drops everything read (the level or what each vertex's value holds changed). */
  clear(): void {
    this.setOf.clear();
    this.absent.clear();
    this.sets.clear();
    // Answers to what was asked before are ignored (their keys are forgotten).
    this.asked.clear();
    this.asking.clear();
    this.queue = [];
    this.drawnKeys = [];
    this.bytes = 0;
    this.verticesRead = this.objectsRead = 0;
    ++this.generation;
  }

  /** The mean vertices of the objects read, at the level read, once FIRST_BATCH of them are (for objectPlan). */
  measured(): { level: number; perObject: number } | undefined {
    if (this.plan === undefined || this.objectsRead < FIRST_BATCH) return undefined;
    return { level: this.plan.level, perObject: this.verticesRead / this.objectsRead };
  }

  private pump(): void {
    while (this.asked.size < this.inFlight && this.queue.length > 0 && this.plan !== undefined) {
      const ids = this.queue.shift()!;
      const key = `o${this.nextKey++}`;
      this.asked.set(key, ids);
      for (const id of ids) this.asking.add(id);
      this.send(key, this.plan, BigUint64Array.from(ids));
    }
  }

  /** The worker's answer: `chunk` holds the objects of `found`; the rest asked for are not in the store. */
  arrived(key: string, chunk: BuiltChunk | null, found: ArrayLike<bigint>): void {
    const ids = this.asked.get(key);
    if (ids === undefined) return;
    this.asked.delete(key);
    for (const id of ids) this.asking.delete(id);
    const has = new Set<bigint>();
    for (let i = 0; i < found.length; ++i) has.add(found[i]);
    const kept: bigint[] = [];
    for (const id of ids) {
      if (has.has(id)) {
        this.setOf.set(id, key);
        kept.push(id);
      } else this.absent.add(id);
    }
    const bytes = bytesOf(chunk);
    this.sets.set(key, { chunk, ids: kept, bytes });
    this.bytes += bytes;
    this.verticesRead += chunk?.vertexCount ?? 0;
    this.objectsRead += kept.length;
    this.updateDrawn();
    this.evict();
    ++this.arrivals;
    this.pump();
  }

  /** A batch could not be read: its objects are asked for again with the next selection. */
  failed(key: string, message: string): void {
    const ids = this.asked.get(key);
    if (ids === undefined) return;
    this.asked.delete(key);
    for (const id of ids) this.asking.delete(id);
    this.error = message;
    ++this.arrivals;
    this.pump();
  }

  /** The sets holding a chosen object: what is drawn. */
  private updateDrawn(): void {
    const keys = new Set<string>();
    for (const id of this.wanted) {
      const key = this.setOf.get(id);
      if (key !== undefined) keys.add(key);
    }
    this.drawnKeys = [...keys];
  }

  /** Lets go of sets no chosen object is in, oldest first, while over the budget. */
  private evict(): void {
    if (this.bytes <= this.budget) return;
    const drawn = new Set(this.drawnKeys);
    for (const [key, set] of this.sets) {
      if (this.bytes <= this.budget) break;
      if (drawn.has(key)) continue;
      this.sets.delete(key);
      this.bytes -= set.bytes;
      for (const id of set.ids) if (this.setOf.get(id) === key) this.setOf.delete(id);
    }
  }

  /** The keys of the sets to draw. */
  drawn(): string[] {
    return this.drawnKeys;
  }

  get(key: string): BuiltChunk | null | undefined {
    return this.sets.get(key)?.chunk;
  }

  has(key: string): boolean {
    return this.sets.has(key);
  }

  /** How far reading the chosen objects has got: wanted, read (in the store), not in the store, still to read. */
  progress(): { wanted: number; read: number; absent: number; pending: number } {
    let read = 0;
    let absent = 0;
    for (const id of this.wanted) {
      if (this.setOf.has(id)) ++read;
      else if (this.absent.has(id)) ++absent;
    }
    return { wanted: this.wanted.length, read, absent, pending: this.wanted.length - read - absent };
  }

  /** Whether anything is being read or waits to be. */
  get busy(): boolean {
    return this.asked.size > 0 || this.queue.length > 0;
  }

  get level(): number | undefined {
    return this.plan?.level;
  }
}
