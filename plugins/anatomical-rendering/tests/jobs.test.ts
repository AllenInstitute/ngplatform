import { describe, expect, it } from "vitest";
import { dropJob, finished, type JobRecord, jobText, MAX_JOBS, putJob, readJobs } from "../jobs.js";

const job = (id: string, status: JobRecord["status"] = "running", extra: Partial<JobRecord> = {}): JobRecord => ({ kind: "movie", id, host: "workstation", name: id, status, progress: 0.4, message: "frame 4 of 10", started: 1, ...extra });

describe("the jobs kept in this browser", () => {
  it("reads what was kept, whatever an older version (or nothing) left", () => {
    expect(readJobs(undefined)).toEqual([]);
    expect(readJobs([{ kind: "still", id: "a", host: "h" }, { kind: "film", id: "b", host: "h" }, null])).toEqual([
      { kind: "still", id: "a", host: "h", name: "still", status: "gone", progress: 0, message: "", started: 0 },
    ]);
    expect(readJobs([job("m1", "done", { files: ["x", 3 as never] })])[0].files).toEqual(["x"]);
  });

  it("puts a job in place of its last record, and keeps at most a few, the oldest finished going first", () => {
    let list = putJob([], job("m1"));
    list = putJob(list, job("m1", "done"));
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("done");
    // The same id on another computer is another job.
    expect(putJob(list, job("m1", "running", { host: "cluster" }))).toHaveLength(2);
    for (let i = 2; i <= MAX_JOBS + 1; ++i) list = putJob(list, job(`m${i}`));
    expect(list).toHaveLength(MAX_JOBS);
    expect(list.some((j) => j.id === "m1")).toBe(false);
    expect(list.every((j) => j.status === "running")).toBe(true);
    expect(dropJob(list, list[0]).length).toBe(MAX_JOBS - 1);
  });

  it("says how far each is, or how it ended", () => {
    expect(jobText(job("Movie"))).toBe("Movie: 40%, frame 4 of 10");
    expect(jobText(job("Movie", "queued"))).toBe("Movie: waiting");
    expect(jobText(job("Movie", "failed", { error: "no ffmpeg" }))).toBe("Movie: failed (no ffmpeg)");
    expect(jobText(job("Movie", "gone"))).toBe("Movie: no longer on workstation");
    expect(finished("running")).toBe(false);
    expect(finished("cancelled")).toBe(true);
  });
});
