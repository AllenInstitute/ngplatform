/** The runner client: addresses, pairing, requests with the token, and the job list it keeps. */
import { describe, expect, it } from "vitest";
import { normaliseAddress, pairingFromHash, RunnerClient, RunnerError, RunnerService } from "../src/platform/runner.js";
import type { RunnerJob } from "../src/sdk/types.js";

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function job(id: string, state: RunnerJob["state"], progress: number | null = null): RunnerJob {
  return { id, kind: "filter", title: `Job ${id}`, args: {}, pid: 100 + Number(id), state, created: 1, started: 1, finished: state === "running" ? null : 2, progress, message: "", outputs: [] };
}

const INFO = { name: "ngplatform-runner", version: "0.1.0", pid: 7, address: "http://127.0.0.1:8765", roots: ["/data"], python: "python", tools: "0.2.0", maxRunning: 2, kinds: [] };

/** A fake runner: answers by method and path, records what was asked. */
function fakeRunner(token = "secret-token-123456") {
  const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  let jobs: RunnerJob[] = [];
  let down = false;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method: init?.method ?? "GET", url, auth: headers.get("Authorization"), body });
    if (down) throw new TypeError("Failed to fetch");
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (headers.get("Authorization") !== `Bearer ${token}`) return reply(401, { error: "the pairing token is missing or wrong" });
    const path = url.replace(/^http:\/\/[^/]+/, "");
    if (path === "/status") return reply(200, INFO);
    if (path === "/jobs" && init?.method === "GET") return reply(200, { jobs });
    if (path === "/jobs" && init?.method === "POST") {
      if (body.kind !== "filter") return reply(400, { error: `unknown job kind '${body.kind}'` });
      const started = job(String(jobs.length + 1), "running");
      jobs = [started, ...jobs];
      return reply(201, started);
    }
    if (path.startsWith("/resolve")) return reply(200, { path: path.includes("stores%2Fabc") ? "/data/a.trk" : null });
    return reply(404, { error: `no ${path}` });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    setJobs: (j: RunnerJob[]) => (jobs = j),
    setDown: (d: boolean) => (down = d),
    token,
  };
}

describe("runner addresses", () => {
  it("takes this computer's addresses only", () => {
    expect(normaliseAddress("127.0.0.1:8765")).toBe("http://127.0.0.1:8765");
    expect(normaliseAddress(" http://localhost:9000/ ")).toBe("http://localhost:9000");
    expect(normaliseAddress("http://[::1]:8765")).toBe("http://[::1]:8765");
    expect(() => normaliseAddress("http://example.com:8765")).toThrow(/this computer/);
    expect(() => normaliseAddress("https://127.0.0.1:8765")).toThrow(/http:\/\//);
    expect(() => normaliseAddress("")).toThrow(RunnerError);
  });

  it("reads the pairing a link carries", () => {
    expect(pairingFromHash("#runner=http%3A%2F%2F127.0.0.1%3A8765&token=abcdefghijklmnopqrstu")).toEqual({ address: "http://127.0.0.1:8765", token: "abcdefghijklmnopqrstu" });
    expect(pairingFromHash("#!{}")).toBeUndefined();
    expect(pairingFromHash("#runner=http%3A%2F%2Fevil.example&token=abcdefghijklmnopqrstu")).toBeUndefined();
    expect(pairingFromHash("#runner=http%3A%2F%2F127.0.0.1%3A8765&token=short")).toBeUndefined();
  });
});

describe("RunnerClient", () => {
  it("sends the token, and reports the runner's errors", async () => {
    const fake = fakeRunner();
    const client = new RunnerClient("http://127.0.0.1:8765", fake.token, fake.fetchImpl);
    expect((await client.status()).name).toBe("ngplatform-runner");
    expect(fake.calls[0].auth).toBe(`Bearer ${fake.token}`);
    const started = await client.start("filter", { input: "/data/a.trk" });
    expect(started.state).toBe("running");
    expect(fake.calls[1]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8765/jobs", body: { kind: "filter", args: { input: "/data/a.trk" } } });
    await expect(client.start("shell", {})).rejects.toThrow(/unknown job kind/);
    const wrong = new RunnerClient("http://127.0.0.1:8765", "wrong", fake.fetchImpl);
    await expect(wrong.status()).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/pair again/) });
    fake.setDown(true);
    await expect(client.status()).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/does not answer/) });
  });
});

describe("RunnerService", () => {
  it("pairs, keeps the pairing in this browser, and unpairs", async () => {
    const fake = fakeRunner();
    const storage = memory();
    const service = new RunnerService(storage, fake.fetchImpl, 10);
    expect(service.connection()).toBe("unpaired");
    await expect(service.pair("127.0.0.1:8765", "wrong-token-0000000")).rejects.toThrow(/pairing token/);
    expect(storage.map.size).toBe(0);
    await service.pair("127.0.0.1:8765", fake.token);
    expect(service.connection()).toBe("connected");
    expect(service.info()?.roots).toEqual(["/data"]);
    expect(JSON.parse(storage.map.get("ngplatform.runner")!)).toEqual({ address: "http://127.0.0.1:8765", token: fake.token });
    // A new page finds the pairing again.
    const again = new RunnerService(storage, fake.fetchImpl, 10);
    expect(again.connection()).toBe("connecting");
    await again.refresh();
    expect(again.connection()).toBe("connected");
    again.unpair();
    expect(storage.map.size).toBe(0);
    expect(again.connection()).toBe("unpaired");
  });

  it("says when the runner is down or refuses the token", async () => {
    const fake = fakeRunner();
    const storage = memory();
    storage.setItem("ngplatform.runner", JSON.stringify({ address: "http://127.0.0.1:8765", token: "stale-token-000000000" }));
    const service = new RunnerService(storage, fake.fetchImpl, 10);
    await service.refresh();
    expect(service.connection()).toBe("refused");
    storage.setItem("ngplatform.runner", JSON.stringify({ address: "http://127.0.0.1:8765", token: fake.token }));
    const down = new RunnerService(storage, fake.fetchImpl, 10);
    fake.setDown(true);
    await down.refresh();
    expect(down.connection()).toBe("unreachable");
    expect(down.error()).toMatch(/does not answer/);
    expect(down.available()).toBe(false);
  });

  it("follows a job to its end", async () => {
    const fake = fakeRunner();
    const service = new RunnerService(memory(), fake.fetchImpl, 5);
    await service.pair("http://127.0.0.1:8765", fake.token);
    const started = await service.start("filter", { input: "/data/a.trk" });
    expect(service.jobs()[0].id).toBe(started.id);
    const seen: (number | null)[] = [];
    const finished = service.wait(started.id, (j) => seen.push(j.progress));
    fake.setJobs([job(started.id, "running", 0.5)]);
    await new Promise((r) => setTimeout(r, 30));
    fake.setJobs([{ ...job(started.id, "done", 1), outputs: [{ path: "/data/out.trk", type: "trk" }] }]);
    const done = await finished;
    expect(done.state).toBe("done");
    expect(done.outputs[0].path).toBe("/data/out.trk");
    expect(seen).toContain(0.5);
  });

  it("finds the file behind a source the runner serves", async () => {
    const fake = fakeRunner();
    const service = new RunnerService(memory(), fake.fetchImpl, 10);
    expect(await service.pathOf("http://127.0.0.1:8765/stores/abc/a.trk/|zarr-vectors:")).toBeUndefined();
    await service.pair("http://127.0.0.1:8765", fake.token);
    expect(await service.pathOf("http://127.0.0.1:8765/stores/abc/a.trk/|zarr-vectors:")).toBe("/data/a.trk");
    expect(await service.pathOf("gs://bucket/a.zarr/|zarr-vectors:")).toBeUndefined();
    expect(await service.pathOf("http://127.0.0.1:9999/stores/abc/a.trk/|zarr-vectors:")).toBeUndefined();
  });
});
