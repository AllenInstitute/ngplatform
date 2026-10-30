/**
 * Undo and redo over whole-state snapshots.
 *
 * The shell records the serialised `{ng, app}` state after each pause in
 * editing (a drag or a slider move records once, when it settles).  Undo and
 * redo hand back a snapshot to restore; the state that restoring it produces
 * is adopted as the current entry rather than recorded as a new edit, so
 * Neuroglancer re-serialising a restored state slightly differently does not
 * wipe the redo stack.
 */
export class StateHistory {
  private past: string[] = [];
  private future: string[] = [];
  private current: string | undefined;
  private adopting = false;

  constructor(private readonly limit = 200) {}

  /** Records a settled state; returns whether it became a new undo step. */
  record(snapshot: string): boolean {
    if (this.adopting) {
      this.adopting = false;
      this.current = snapshot;
      return false;
    }
    if (snapshot === this.current) return false;
    if (this.current !== undefined) {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.current = snapshot;
    this.future = [];
    return true;
  }

  /** The snapshot to restore for undo, or undefined when there is none. */
  undo(): string | undefined {
    const previous = this.past.pop();
    if (previous === undefined || this.current === undefined) return undefined;
    this.future.push(this.current);
    this.current = previous;
    this.adopting = true;
    return previous;
  }

  redo(): string | undefined {
    const next = this.future.pop();
    if (next === undefined || this.current === undefined) return undefined;
    this.past.push(this.current);
    this.current = next;
    this.adopting = true;
    return next;
  }

  /** Ends an adoption window that produced no state change (restoring an identical state). */
  settle(): void {
    this.adopting = false;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
