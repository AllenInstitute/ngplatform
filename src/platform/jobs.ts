/**
 * Long-running work: each job shows in the Jobs tab with its progress, and
 * can be cancelled.  Cancellation is cooperative: the work checks
 * `control.cancelled` between steps.
 */
import type { JobControl } from "../sdk/types.js";

export interface Job {
  id: number;
  title: string;
  owner: string;
  state: "running" | "done" | "failed" | "cancelled";
  progress: number | undefined;
  message: string;
  started: number;
  finished?: number;
  cancel(): void;
}

export class JobCancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

export class JobService {
  private jobs: Job[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();

  list(): Job[] {
    return [...this.jobs];
  }

  running(): number {
    return this.jobs.filter((j) => j.state === "running").length;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  async run<T>(title: string, work: (control: JobControl) => Promise<T>, owner = "core"): Promise<T> {
    let cancelled = false;
    const job: Job = {
      id: this.nextId++,
      title,
      owner,
      state: "running",
      progress: undefined,
      message: "",
      started: Date.now(),
      cancel: () => {
        if (job.state !== "running") return;
        cancelled = true;
        job.message = "Cancelling…";
        this.notify();
      },
    };
    this.jobs = [job, ...this.jobs].slice(0, 50);
    this.notify();
    const control: JobControl = {
      progress: (fraction, message) => {
        job.progress = fraction;
        if (message !== undefined) job.message = message;
        this.notify();
      },
      get cancelled() {
        return cancelled;
      },
    };
    try {
      const result = await work(control);
      job.state = cancelled ? "cancelled" : "done";
      return result;
    } catch (e) {
      job.state = cancelled || e instanceof JobCancelled ? "cancelled" : "failed";
      job.message = (e as Error).message;
      throw e;
    } finally {
      job.finished = Date.now();
      if (job.state === "done") job.progress = 1;
      this.notify();
    }
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.state === "running");
    this.notify();
  }
}
