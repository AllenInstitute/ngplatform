/**
 * Undo and redo over whole-state snapshots.
 *
 * The shell records the serialised `{ng, app}` state after each pause in
 * editing (a drag or a slider move records once, when it settles).  Undo and
 * redo hand back a snapshot to restore; the state that restoring it produces
 * is adopted as the current entry rather than recorded as a new edit, so
 * Neuroglancer re-serialising a restored state slightly differently does not
 * wipe the redo stack.
 *
 * Each entry also keeps a few words saying what the change was and when it
 * was made, for the history menu beside the undo and redo buttons.
 */

interface Entry {
  snapshot: string;
  label: string;
  time: number;
}

/** One row of the history menu: oldest first. */
export interface HistoryRow {
  label: string;
  time: number;
  /** Done (in the past), the state shown now, or undone (redo would bring it back). */
  state: "done" | "current" | "undone";
}

export class StateHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private current: Entry | undefined;
  private adopting = false;

  constructor(
    private readonly limit = 200,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a settled state; returns whether it became a new undo step. */
  record(snapshot: string, label = "Changed"): boolean {
    if (this.adopting) {
      this.adopting = false;
      if (this.current !== undefined) this.current = { ...this.current, snapshot };
      else this.current = { snapshot, label, time: this.now() };
      return false;
    }
    if (snapshot === this.current?.snapshot) return false;
    if (this.current !== undefined) {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.current = { snapshot, label, time: this.now() };
    this.future = [];
    return true;
  }

  /**
   * Replaces the current entry without making an undo step: for changes not
   * worth undoing on their own, such as which layer is selected.  The entry
   * keeps its label and time.
   */
  replaceCurrent(snapshot: string): void {
    if (this.adopting) this.adopting = false;
    this.current = this.current === undefined ? { snapshot, label: "Opened", time: this.now() } : { ...this.current, snapshot };
  }

  /** The snapshot to restore for undo, or undefined when there is none. */
  undo(): string | undefined {
    return this.move(-1);
  }

  redo(): string | undefined {
    return this.move(1);
  }

  /**
   * Moves `steps` entries back (negative) or forward (positive) through the
   * history, as that many undos or redos; returns the snapshot to restore.
   */
  move(steps: number): string | undefined {
    if (this.current === undefined || steps === 0) return undefined;
    const n = Math.min(Math.abs(steps), steps < 0 ? this.past.length : this.future.length);
    if (n === 0) return undefined;
    for (let i = 0; i < n; ++i) {
      if (steps < 0) {
        this.future.push(this.current!);
        this.current = this.past.pop();
      } else {
        this.past.push(this.current!);
        this.current = this.future.pop();
      }
    }
    this.adopting = true;
    return this.current!.snapshot;
  }

  /** Every entry, oldest first, marked done, current or undone. */
  rows(): HistoryRow[] {
    const row = (e: Entry, state: HistoryRow["state"]) => ({ label: e.label, time: e.time, state });
    return [
      ...this.past.map((e) => row(e, "done")),
      ...(this.current === undefined ? [] : [row(this.current, "current")]),
      ...[...this.future].reverse().map((e) => row(e, "undone")),
    ];
  }

  /** Ends an adoption window that produced no state change (restoring an identical state). */
  settle(): void {
    this.adopting = false;
  }

  /** True between an undo or redo and the state it produces being recorded. */
  get isAdopting(): boolean {
    return this.adopting;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
