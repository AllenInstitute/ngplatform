/**
 * The stills, movies and splats the panel has asked a render computer for:
 * kept in this browser (Settings, not the link), so after a reload the
 * panel still lists them, follows those still running, and fetches what
 * finished.  Pure, so they are tested on their own.
 */

export type JobKind = "still" | "movie" | "splat";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "gone";

export interface JobRecord {
  kind: JobKind;
  /** The job's id on its computer. */
  id: string;
  /** The computer it runs on (a paired host's name). */
  host: string;
  /** What it is called in the list and its file. */
  name: string;
  status: JobStatus;
  progress: number;
  message: string;
  error?: string;
  /** A splat's files the page can fetch. */
  files?: string[];
  /** When it was asked for (ms since 1970). */
  started: number;
}

/** How many jobs the list keeps (the oldest finished ones go first). */
export const MAX_JOBS = 12;

const KINDS: JobKind[] = ["still", "movie", "splat"];
const STATUSES: JobStatus[] = ["queued", "running", "done", "failed", "cancelled", "gone"];

/** Whether a job has stopped (done, failed, cancelled, or no longer known to its computer). */
export function finished(status: JobStatus): boolean {
  return status !== "queued" && status !== "running";
}

/** The jobs as kept, whatever an older version (or nothing) left. */
export function readJobs(raw: unknown): JobRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((j): j is JobRecord => !!j && typeof j === "object" && KINDS.includes(j.kind) && typeof j.id === "string" && typeof j.host === "string")
    .map((j) => ({
      kind: j.kind,
      id: j.id,
      host: j.host,
      name: typeof j.name === "string" ? j.name : j.kind,
      status: STATUSES.includes(j.status) ? j.status : "gone",
      progress: typeof j.progress === "number" && Number.isFinite(j.progress) ? j.progress : 0,
      message: typeof j.message === "string" ? j.message : "",
      ...(typeof j.error === "string" ? { error: j.error } : {}),
      ...(Array.isArray(j.files) ? { files: j.files.filter((f) => typeof f === "string") } : {}),
      started: typeof j.started === "number" ? j.started : 0,
    }))
    .slice(-MAX_JOBS);
}

/**
 * The list with `job` added, or put in place of the one with its kind, id
 * and computer; past MAX_JOBS, the oldest finished ones are dropped (one
 * still running is kept while any finished one can go).
 */
export function putJob(list: readonly JobRecord[], job: JobRecord): JobRecord[] {
  const same = (j: JobRecord) => j.kind === job.kind && j.id === job.id && j.host === job.host;
  const out = list.some(same) ? list.map((j) => (same(j) ? job : j)) : [...list, job];
  while (out.length > MAX_JOBS) {
    const old = out.findIndex((j) => finished(j.status));
    out.splice(old >= 0 ? old : 0, 1);
  }
  return out;
}

/** The list without the job with this kind, id and computer. */
export function dropJob(list: readonly JobRecord[], job: Pick<JobRecord, "kind" | "id" | "host">): JobRecord[] {
  return list.filter((j) => !(j.kind === job.kind && j.id === job.id && j.host === job.host));
}

/** One line for a job in the list: its name, then how far it is or how it ended. */
export function jobText(j: JobRecord): string {
  switch (j.status) {
    case "queued":
      return `${j.name}: waiting`;
    case "running":
      return `${j.name}: ${Math.round(j.progress * 100)}%${j.message ? `, ${j.message}` : ""}`;
    case "done":
      return `${j.name}: done`;
    case "failed":
      return `${j.name}: failed${j.error ? ` (${j.error})` : ""}`;
    case "cancelled":
      return `${j.name}: cancelled`;
    case "gone":
      return `${j.name}: no longer on ${j.host}`;
  }
}
