/**
 * Strokes, and undoing them.  A stroke keeps a copy of each chunk it
 * changes as the chunk was before (on its first change), and as it is
 * after when it ends; undo and redo put those back.  Copies of whole
 * chunks cost more than a list of voxels for a small dab but stay bounded
 * for a 3-D fill of millions of voxels, which a list would not.
 */
import { type LabelArray, LabelVolume } from "./label_volume.js";

export class Stroke {
  /** Each chunk changed, as it was before (undefined: it was not there). */
  readonly before = new Map<number, LabelArray | undefined>();
  after: Map<number, LabelArray | undefined> | undefined;
  /** Voxels changed. */
  changes = 0;
  /** When it was kept for undo (ms since 1970). */
  time = 0;
  /** Chunks changed since `flush`, to tell the volume (and the viewer). */
  private readonly dirty = new Set<number>();

  constructor(readonly volume: LabelVolume) {}

  /** Sets a voxel (inside the volume); returns whether it changed. */
  set(x: number, y: number, z: number, value: number): boolean {
    const v = this.volume;
    const key = v.key(x >> 6, y >> 6, z >> 6);
    let chunk = v.chunk(key);
    const at = LabelVolume.offset(x, y, z);
    if ((chunk === undefined ? 0 : chunk[at]) === value) return false;
    if (!this.before.has(key)) this.before.set(key, chunk?.slice());
    chunk ??= v.chunk(key, true)!;
    chunk[at] = value;
    this.dirty.add(key);
    ++this.changes;
    return true;
  }

  /** Tells the volume which chunks changed since last asked; returns them. */
  flush(): number[] {
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) this.volume.changed(key);
    return keys;
  }

  /** Ends the stroke: chunks left all 0 are dropped, and the after copies kept. */
  finish(): number[] {
    const keys = this.flush();
    this.after = new Map();
    for (const key of this.before.keys()) {
      const c = this.volume.chunk(key);
      if (c !== undefined && isEmpty(c)) this.volume.putChunk(key, undefined);
      const now = this.volume.chunk(key);
      this.after.set(key, now?.slice());
    }
    return keys;
  }

  get bytes(): number {
    let n = 0;
    for (const c of this.before.values()) n += c?.byteLength ?? 0;
    for (const c of this.after?.values() ?? []) n += c?.byteLength ?? 0;
    return n;
  }

  /** The chunks this stroke changed. */
  keys(): number[] {
    return [...this.before.keys()];
  }
}

function isEmpty(c: LabelArray): boolean {
  for (let i = 0; i < c.length; ++i) if (c[i] !== 0) return false;
  return true;
}

/** Undo and redo of strokes, keeping at most `budget` bytes of copies (the oldest go first). */
export class History {
  private done: Stroke[] = [];
  private undone: Stroke[] = [];

  constructor(
    private readonly budget = 512 * 2 ** 20,
    private readonly now: () => number = Date.now,
  ) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** When the stroke undo would take back was made. */
  get undoTime(): number | undefined {
    return this.done[this.done.length - 1]?.time;
  }

  /** When the stroke redo would bring back was made. */
  get redoTime(): number | undefined {
    return this.undone[this.undone.length - 1]?.time;
  }

  push(stroke: Stroke): void {
    if (stroke.changes === 0) return;
    stroke.time = this.now();
    this.done.push(stroke);
    this.undone = [];
    let total = this.done.reduce((n, s) => n + s.bytes, 0);
    while (total > this.budget && this.done.length > 1) total -= this.done.shift()!.bytes;
  }

  /** Undoes the last stroke; returns the chunks it changed. */
  undo(): number[] {
    const stroke = this.done.pop();
    if (stroke === undefined) return [];
    this.undone.push(stroke);
    for (const [key, data] of stroke.before) stroke.volume.putChunk(key, data?.slice());
    return stroke.keys();
  }

  redo(): number[] {
    const stroke = this.undone.pop();
    if (stroke === undefined) return [];
    this.done.push(stroke);
    for (const [key, data] of stroke.after ?? []) stroke.volume.putChunk(key, data?.slice());
    return stroke.keys();
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }
}

/**
 * Which undo Ctrl+Z (or Ctrl+Y, `redo`) takes while a label volume is
 * edited, from when the stroke and the workspace's change it could undo
 * were made: undo takes back whichever came last, and redo brings back
 * whichever of the two undone came first, so strokes and workspace
 * changes undo and redo as one history.  Undefined when neither can.
 */
export function chooseUndo(stroke: number | undefined, workspace: number | undefined, redo: boolean): "stroke" | "workspace" | undefined {
  if (stroke === undefined) return workspace === undefined ? undefined : "workspace";
  if (workspace === undefined) return "stroke";
  // A tie (the same millisecond) goes to the stroke: the tool bar is showing.
  return (redo ? stroke <= workspace : stroke >= workspace) ? "stroke" : "workspace";
}
