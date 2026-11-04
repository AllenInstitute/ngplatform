/** Requests to a worker as promises (src/sdk/worker_rpc.ts), against a stand-in worker. */
import { describe, expect, it } from "vitest";
import { WorkerRpc } from "../src/sdk/worker_rpc.js";

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: any[] = [];
  terminated = false;
  postMessage(message: any): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  answer(data: object): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  fail(message = ""): void {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

function setUp(options: Partial<ConstructorParameters<typeof WorkerRpc>[1]> = {}) {
  const workers: FakeWorker[] = [];
  const rpc = new WorkerRpc(
    () => {
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    },
    { stopped: (why) => `stopped: ${why}`, ...options },
  );
  return { rpc, workers };
}

describe("worker requests", () => {
  it("starts the worker on the first request and answers each request by its id", async () => {
    const { rpc, workers } = setUp();
    expect(workers).toHaveLength(0);
    const a = rpc.request<{ v: number }>({ type: "read", n: 1 });
    const b = rpc.request<{ v: number }>({ type: "read", n: 2 });
    expect(workers).toHaveLength(1);
    const [m1, m2] = workers[0].posted;
    expect(m1).toEqual({ type: "read", n: 1, id: m1.id });
    expect(m2.id).not.toBe(m1.id);
    workers[0].answer({ id: m2.id, type: "done", v: 2 });
    workers[0].answer({ id: m1.id, type: "done", v: 1 });
    expect((await a).v).toBe(1);
    expect((await b).v).toBe(2);
  });

  it("passes progress and interim messages on, and rejects with the worker's error", async () => {
    const { rpc, workers } = setUp({ interim: (msg) => msg.type === "plane" && !msg.final });
    const seen: string[] = [];
    const p = rpc.request({ type: "x" }, { progress: (msg) => seen.push(msg.type) });
    const id = workers[0].posted[0].id;
    workers[0].answer({ id, type: "progress", done: 1, total: 2 });
    workers[0].answer({ id, type: "plane", final: false });
    workers[0].answer({ id, type: "error", message: "no such file" });
    await expect(p).rejects.toThrow("no such file");
    expect(seen).toEqual(["progress", "plane"]);
    // Messages for no request (or after the answer) are ignored.
    workers[0].answer({ id, type: "done" });
    workers[0].answer({ id: 999, type: "done" });
  });

  it("cancels: the worker is told, the request fails as aborted", async () => {
    const { rpc, workers } = setUp();
    const controller = new AbortController();
    const p = rpc.request({ type: "slow" }, { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].posted[1]).toEqual({ type: "cancel", id: workers[0].posted[0].id });
    // A signal aborted before the request: nothing is posted.
    await expect(rpc.request({ type: "late" }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].posted).toHaveLength(2);
  });

  it("a worker that stops fails every request waiting; later ones fail too unless it restarts", async () => {
    const { rpc, workers } = setUp();
    const p = rpc.request({ type: "a" });
    workers[0].fail("out of memory");
    await expect(p).rejects.toThrow("stopped: out of memory");
    expect(workers[0].terminated).toBe(true);
    await expect(rpc.request({ type: "b" })).rejects.toThrow("stopped: out of memory");
    expect(workers).toHaveLength(1);

    let dropped = 0;
    const restarting = setUp({ restart: true, onStopped: () => ++dropped });
    const q = restarting.rpc.request({ type: "a" });
    restarting.workers[0].fail();
    await expect(q).rejects.toThrow("stopped: it could not start");
    expect(dropped).toBe(1);
    const r = restarting.rpc.request<{ ok: boolean }>({ type: "b" });
    expect(restarting.workers).toHaveLength(2);
    restarting.workers[1].answer({ id: restarting.workers[1].posted[0].id, ok: true });
    expect((await r).ok).toBe(true);
    // A late error from the old worker changes nothing.
    restarting.workers[0].fail("late");
    expect(dropped).toBe(1);
  });

  it("an answer that cannot be read fails the requests", async () => {
    const { rpc, workers } = setUp();
    const p = rpc.request({ type: "a" });
    workers[0].onmessageerror?.();
    await expect(p).rejects.toThrow("stopped: its answer could not be read");
  });

  it("dispose fails what is waiting, and what comes later unless it restarts", async () => {
    const { rpc, workers } = setUp();
    const p = rpc.request({ type: "a" });
    rpc.dispose();
    await expect(p).rejects.toThrow("closed");
    expect(workers[0].terminated).toBe(true);
    await expect(rpc.request({ type: "b" })).rejects.toThrow("closed");

    const restarting = setUp({ restart: true });
    restarting.rpc.dispose();
    void restarting.rpc.request({ type: "b" });
    expect(restarting.workers).toHaveLength(1);
  });
});
