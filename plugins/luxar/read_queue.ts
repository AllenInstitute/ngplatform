/**
 * The reading worker's queue of chunk reads (./luxar_worker.ts): the main
 * thread's list of wanted chunks, most wanted first, replaces the queue;
 * at most `concurrency` are read at once; and a read in flight that the new
 * list no longer names (out of view, or for another scalar) is cancelled,
 * its signal aborted, so its fetches stop and its slot is free at once.
 * Pure (the read is given), so the tests can use it.
 */

export type ChunkRead = (key: string, scalar: string, signal: AbortSignal) => Promise<void>;

export class ReadQueue {
  private queue: string[] = [];
  private scalar = "none";
  /** Reads in flight, by scalar and key. */
  private readonly reading = new Map<string, AbortController>();

  constructor(
    private readonly read: ChunkRead,
    private readonly concurrency = 6,
  ) {}

  private tag(key: string, scalar = this.scalar): string {
    return `${scalar}#${key}`;
  }

  /** The chunks wanted now, most wanted first (for `scalar`). */
  want(keys: readonly string[], scalar: string): void {
    this.scalar = scalar;
    const wanted = new Set(keys.map((k) => this.tag(k)));
    for (const [tag, control] of this.reading) {
      if (wanted.has(tag)) continue;
      control.abort();
      this.reading.delete(tag);
    }
    this.queue = keys.filter((k) => !this.reading.has(this.tag(k)));
    this.pump();
  }

  /** Every read stopped and the queue emptied (another store is opened). */
  cancelAll(): void {
    for (const control of this.reading.values()) control.abort();
    this.reading.clear();
    this.queue = [];
  }

  /** Reads in flight now (cancelled ones not counted). */
  get inFlight(): number {
    return this.reading.size;
  }

  get queued(): number {
    return this.queue.length;
  }

  private pump(): void {
    while (this.reading.size < this.concurrency && this.queue.length > 0) {
      const key = this.queue.shift()!;
      const scalar = this.scalar;
      const tag = this.tag(key, scalar);
      if (this.reading.has(tag)) continue;
      const control = new AbortController();
      this.reading.set(tag, control);
      void this.read(key, scalar, control.signal)
        .catch(() => {})
        .finally(() => {
          // A cancelled read's slot was freed when it was cancelled.
          if (this.reading.get(tag) === control) this.reading.delete(tag);
          this.pump();
        });
    }
  }
}
