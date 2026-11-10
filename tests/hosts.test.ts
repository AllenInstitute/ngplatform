/** The computers with runners (This computer, and others through an SSH tunnel): pairing links with a name, the list kept in the browser, the check every 5 s, pick and fetch. */
import { describe, expect, it } from "vitest";
import { fetchRemoteState } from "../src/platform/deadline.js";
import { HostList, hostStatusLine, LOCAL_HOST } from "../src/platform/hosts.js";
import { pairingFromHash, RunnerClient, RunnerService } from "../src/platform/runner.js";
import type { HostGpu, HostInfo } from "../src/sdk/types.js";

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const A6000: HostGpu = { index: 0, name: "NVIDIA RTX A6000", memoryTotal: 49140, memoryUsed: 1000, memoryFree: 48140, busId: "00000000:2B:00.0", ok: true };
const RESET: HostGpu = { index: 1, name: "GPU", memoryTotal: null, memoryUsed: null, memoryFree: null, busId: "", ok: false, problem: "GPU requires reset" };

interface FakeHost {
  token: string;
  hostname: string;
  gpus: HostGpu[];
  services: Record<string, { ready: boolean; error: string | null; pid: number | null }>;
  down: boolean;
  /** A half-open tunnel: asked, it never answers (until the request is given up). */
  hung: boolean;
}

/** Runners at several addresses: each answers /status with its computer, and /svc/ with what it was asked. */
function fakeHosts(hosts: Record<string, Partial<FakeHost>>) {
  const all = new Map<string, FakeHost>(Object.entries(hosts).map(([address, h]) => [address, { token: "token-0123456789abcdef", hostname: "box", gpus: [], services: {}, down: false, hung: false, ...h }]));
  const calls: { url: string; auth: string | null; method: string; headers: Headers; body?: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const address = url.match(/^http:\/\/[^/]+/)![0];
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("Authorization"), method: init?.method ?? "GET", headers, body: init?.body });
    const host = all.get(address);
    if (host === undefined || host.down) throw new TypeError("Failed to fetch");
    if (host.hung) {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    }
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (headers.get("Authorization") !== `Bearer ${host.token}`) return reply(401, { error: "the pairing token is missing or wrong" });
    const path = url.slice(address.length);
    if (path === "/status")
      return reply(200, { name: "ngplatform-runner", version: "0.1.0", pid: 1, address, roots: ["/data"], python: "python", tools: null, maxRunning: 2, kinds: [], hostname: host.hostname, platform: "Linux", gpus: host.gpus, services: host.services });
    if (path === "/jobs") return reply(200, { jobs: [] });
    if (path.startsWith("/svc/")) {
      // A streamed answer, in two parts.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${path} `));
          controller.enqueue(new TextEncoder().encode("done"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "X-Session": "s1" } });
    }
    return reply(404, { error: `no ${path}` });
  }) as typeof fetch;
  return { fetchImpl, calls, hosts: all };
}

const WS = "http://localhost:7000";
const NODE = "http://localhost:7001";
const LOCAL = "http://127.0.0.1:8765";
const TOKEN = "token-0123456789abcdef";

describe("pairing links", () => {
  it("carry a computer's name", () => {
    expect(pairingFromHash(`#runner=${encodeURIComponent(WS)}&token=${TOKEN}&name=workstation`)).toEqual({ address: WS, token: TOKEN, name: "workstation" });
    expect(pairingFromHash(`#runner=${encodeURIComponent(WS)}&token=${TOKEN}&name=%20my%20%20node%20`)).toEqual({ address: WS, token: TOKEN, name: "my node" });
    // No name: This computer, as before.
    expect(pairingFromHash(`#runner=${encodeURIComponent(LOCAL)}&token=${TOKEN}`)).toEqual({ address: LOCAL, token: TOKEN });
    expect(pairingFromHash(`#runner=${encodeURIComponent(LOCAL)}&token=${TOKEN}&name=`)).toEqual({ address: LOCAL, token: TOKEN });
    // A tunnel's address is still this computer's: nothing else is taken.
    expect(pairingFromHash(`#runner=${encodeURIComponent("http://ws.example:7000")}&token=${TOKEN}&name=ws`)).toBeUndefined();
  });
});

describe("HostList", () => {
  it("adds named computers beside This computer, keeps them in this browser, and forgets them", async () => {
    const fake = fakeHosts({ [LOCAL]: {}, [WS]: { hostname: "czi001", gpus: [A6000] } });
    const storage = memory();
    const local = new RunnerService(storage, fake.fetchImpl, 10);
    await local.pair(LOCAL, TOKEN);
    const hosts = new HostList(local, storage, fake.fetchImpl, 10);
    let heard = 0;
    hosts.onChange(() => heard++);
    await expect(hosts.add("workstation", WS, "wrong-token-000000000")).rejects.toThrow(/pairing token/);
    expect(hosts.others()).toEqual([]);
    await hosts.add("workstation", WS, TOKEN);
    expect(heard).toBeGreaterThan(0);
    expect(hosts.names()).toEqual([LOCAL_HOST, "workstation"]);
    // This computer's pairing is untouched.
    expect(JSON.parse(storage.map.get("ngplatform.runner")!)).toEqual({ address: LOCAL, token: TOKEN });
    expect(JSON.parse(storage.map.get("ngplatform.hosts")!)).toEqual([{ name: "workstation", address: WS, token: TOKEN }]);
    // Paired again under the same name: updated, not added.
    fake.hosts.get(WS)!.token = "token-new-0123456789";
    await hosts.add("workstation", WS, "token-new-0123456789");
    expect(JSON.parse(storage.map.get("ngplatform.hosts")!)).toEqual([{ name: "workstation", address: WS, token: "token-new-0123456789" }]);
    // A new page finds them again.
    const again = new HostList(new RunnerService(storage, fake.fetchImpl, 10), storage, fake.fetchImpl, 10);
    expect(again.names()).toEqual([LOCAL_HOST, "workstation"]);
    expect(again.runner("workstation")?.pairing()).toEqual({ address: WS, token: "token-new-0123456789" });
    // Unpairing a computer (its section's Unpair) forgets it; This computer stays.
    again.runner("workstation")!.unpair();
    expect(again.names()).toEqual([LOCAL_HOST]);
    expect(storage.map.has("ngplatform.hosts")).toBe(false);
    expect(storage.map.has("ngplatform.runner")).toBe(true);
    // The name This computer pairs This computer.
    const third = new HostList(new RunnerService(memory(), fake.fetchImpl, 10), memory(), fake.fetchImpl, 10);
    await third.add(LOCAL_HOST, LOCAL, TOKEN);
    expect(third.others()).toEqual([]);
    expect(third.local.pairing()?.address).toBe(LOCAL);
  });

  it("checks every host and marks it up or down", async () => {
    const fake = fakeHosts({ [WS]: { hostname: "czi001", gpus: [A6000, RESET], services: { render: { ready: true, error: null, pid: 9 } } }, [NODE]: { hostname: "node12" } });
    const storage = memory();
    const hosts = new HostList(new RunnerService(storage, fake.fetchImpl, 10), storage, fake.fetchImpl, 5, 1000, 0);
    await hosts.add("workstation", WS, TOKEN);
    await hosts.add("node", NODE, TOKEN);
    await hosts.check();
    const [ws, node] = hosts.list();
    expect(ws).toMatchObject({ name: "workstation", address: WS, available: true, info: { hostname: "czi001", platform: "Linux" } });
    expect(ws.info!.gpus).toHaveLength(2);
    expect(hostStatusLine(ws)).toBe("workstation (czi001): RTX A6000, 47 GB free; GPU (gpu requires reset) — render ready");
    expect(hostStatusLine(node)).toBe("node (node12): no GPU");
    // The tunnel closes: the next check says so, and keeps what it knew.
    fake.hosts.get(WS)!.down = true;
    let heard = 0;
    hosts.onChange(() => heard++);
    hosts.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(hosts.list()[0]).toMatchObject({ available: false, error: "does not answer", info: { hostname: "czi001" } });
    expect(hostStatusLine(hosts.list()[0])).toBe("workstation (czi001): does not answer");
    expect(heard).toBe(1); // a change, not every check
    // And open again.
    fake.hosts.get(WS)!.down = false;
    await new Promise((r) => setTimeout(r, 40));
    hosts.stop();
    expect(hosts.list()[0].available).toBe(true);
    expect(heard).toBe(2);
    // A host that refuses the token.
    fake.hosts.get(NODE)!.token = "another-token-0000000";
    await hosts.check();
    expect(hosts.list()[1]).toMatchObject({ available: false, error: expect.stringMatching(/pair it again/) });
  });

  it("asks a host that did not answer less often", async () => {
    const fake = fakeHosts({ [WS]: {} });
    const storage = memory();
    const hosts = new HostList(new RunnerService(storage, fake.fetchImpl, 10), storage, fake.fetchImpl, 5, 1000, 60_000);
    await hosts.add("workstation", WS, TOKEN);
    fake.hosts.get(WS)!.down = true;
    await hosts.check();
    const asked = fake.calls.length;
    await hosts.check();
    await hosts.check();
    expect(fake.calls.length).toBe(asked);
    await hosts.check(true);
    expect(fake.calls.length).toBe(asked + 1);
  });

  it("picks a host with a GPU and a ready service, and fetches from its services with the token", async () => {
    const fake = fakeHosts({
      [LOCAL]: { hostname: "laptop" },
      [WS]: { hostname: "czi001", gpus: [A6000], services: { render: { ready: true, error: null, pid: 9 } } },
      [NODE]: { hostname: "node12", gpus: [RESET], services: { render: { ready: false, error: "render ended with exit code 1; starting it again in 2 s", pid: null } } },
    });
    const storage = memory();
    const local = new RunnerService(storage, fake.fetchImpl, 10);
    await local.pair(LOCAL, TOKEN);
    const hosts = new HostList(local, storage, fake.fetchImpl, 10);
    await hosts.add("node", NODE, TOKEN);
    await hosts.add("workstation", WS, TOKEN);
    await hosts.check();
    const api = hosts.api();
    expect(api.list().map((h) => h.name)).toEqual([LOCAL_HOST, "node", "workstation"]);
    // A GPU host first, then the list's order; a card that needs a reset is no GPU.
    expect(api.pick()?.name).toBe("workstation");
    expect(api.pick({ gpu: true })?.name).toBe("workstation");
    expect(api.pick({ service: "render" })?.name).toBe("workstation");
    expect(api.pick({ service: "other" })).toBeUndefined();
    expect(hostStatusLine(api.list()[1])).toBe("node (node12): GPU (gpu requires reset) — render restarting");
    // The host chosen in the Remote tab first, when it has what is asked for.
    hosts.prefer(LOCAL_HOST);
    expect(hosts.preferred()).toBe(LOCAL_HOST);
    expect(api.pick()?.name).toBe(LOCAL_HOST);
    expect(api.pick({ gpu: true })?.name).toBe("workstation");
    hosts.prefer("nowhere");
    expect(hosts.preferred()).toBeUndefined();
    hosts.prefer(undefined);
    expect(api.pick()?.name).toBe("workstation");
    fake.hosts.get(WS)!.down = true;
    await hosts.check();
    expect(api.pick({ gpu: true })).toBeUndefined();
    expect(api.pick()?.name).toBe(LOCAL_HOST);
    fake.hosts.get(WS)!.down = false;
    await hosts.check(true);
    const ws = api.get("workstation")!;
    expect(ws.available()).toBe(true);
    expect(ws.address).toBe(WS);
    const response = await ws.fetch("render/sessions?x=1", { method: "POST", body: "{}", headers: { "X-Session": "s1" } });
    expect(response.headers.get("X-Session")).toBe("s1");
    expect(await response.text()).toBe("/svc/render/sessions?x=1 done");
    const call = fake.calls.at(-1)!;
    expect(call).toMatchObject({ url: `${WS}/svc/render/sessions?x=1`, auth: `Bearer ${TOKEN}`, method: "POST", body: "{}" });
    expect(call.headers.get("X-Session")).toBe("s1");
    await ws.fetch("/render/a");
    expect(fake.calls.at(-1)!.url).toBe(`${WS}/svc/render/a`);
    expect(api.get("nowhere")).toBeUndefined();
    fake.hosts.get(WS)!.down = true;
    await expect(ws.fetch("render/x")).rejects.toThrow(/does not answer/);
    // Forgotten: its handle says so.
    hosts.remove("workstation");
    await expect(ws.fetch("render/x")).rejects.toThrow(/not paired/);
    expect(ws.available()).toBe(false);
  });

  it("describes a host in one line", () => {
    const host = (h: Partial<HostInfo>): HostInfo => ({ name: "ws", address: WS, available: true, info: { hostname: "ws", platform: "", gpus: [], services: {} }, ...h });
    expect(hostStatusLine(host({}))).toBe("ws: no GPU");
    expect(hostStatusLine(host({ available: false, info: undefined }))).toBe("ws: connecting…");
    expect(hostStatusLine(host({ info: { hostname: "ws", platform: "", gpus: [A6000, { ...A6000, index: 1, memoryFree: 2048 }], services: { render: { ready: false, error: null, pid: 3 } } } }))).toBe(
      "ws: RTX A6000, 47 GB free; RTX A6000, 2 GB free — render starting",
    );
    expect(hostStatusLine(host({ info: { hostname: "ws", platform: "", gpus: [], services: { render: { ready: false, error: "render ended …; not started again (log: x)", pid: null } } } }))).toBe("ws: no GPU — render failed");
  });
});

describe("a half-open tunnel", () => {
  it("gives up a runner's request after its deadline, naming the computer", async () => {
    const fake = fakeHosts({ [WS]: { hung: true } });
    const named = new RunnerClient(WS, TOKEN, fake.fetchImpl, "workstation", 30);
    await expect(named.jobs()).rejects.toThrow(`workstation (${WS}) did not answer in 0 s: is the runner running and the tunnel open?`);
    const local = new RunnerClient(WS, TOKEN, fake.fetchImpl, undefined, 30);
    await expect(local.status()).rejects.toThrow(`The runner at ${WS} did not answer`);
    // Stopped by the caller: an abort, not a deadline.
    const stop = new AbortController();
    const asked = local.status(stop.signal);
    stop.abort();
    await expect(asked).rejects.toMatchObject({ name: "AbortError" });
  });

  it("gives up a host's service that does not start answering, and names the host", async () => {
    const fake = fakeHosts({ [WS]: {} });
    const storage = memory();
    const hosts = new HostList(new RunnerService(storage, fake.fetchImpl, 10), storage, fake.fetchImpl, 10, 1000, 30_000, 30);
    await hosts.add("workstation", WS, TOKEN);
    fake.hosts.get(WS)!.hung = true;
    await expect(hosts.fetch("workstation", "render/frame")).rejects.toThrow(`workstation (${WS}) did not answer in 0 s: is the tunnel open and the runner running?`);
    // Answering: the deadline does not cut a long answer short.
    fake.hosts.get(WS)!.hung = false;
    const response = await hosts.fetch("workstation", "render/frame");
    await new Promise((r) => setTimeout(r, 50));
    expect(await response.text()).toBe("/svc/render/frame done");
  });

  it("gives up reading a state from a URL, naming the computer", async () => {
    const hung = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    await expect(fetchRemoteState("https://states.example.org:8443/a.json", 30, hung)).rejects.toThrow("states.example.org:8443 did not answer in 0 s.");
    const gone = (async () => new Response("", { status: 404, statusText: "Not Found" })) as typeof fetch;
    await expect(fetchRemoteState("https://states.example.org/a.json", 30, gone)).rejects.toThrow("states.example.org answered 404 Not Found.");
  });
});

describe("checks while the page is hidden", () => {
  it("pause, and start again at once when it is shown", async () => {
    const fake = fakeHosts({ [WS]: {} });
    const storage = memory();
    const hosts = new HostList(new RunnerService(storage, fake.fetchImpl, 10), storage, fake.fetchImpl, 5);
    await hosts.add("workstation", WS, TOKEN);
    const listeners = new Set<() => void>();
    const page = {
      hidden: false,
      addEventListener: (_: string, f: () => void) => void listeners.add(f),
      removeEventListener: (_: string, f: () => void) => void listeners.delete(f),
    };
    const checks = () => fake.calls.filter((c) => c.url.endsWith("/status")).length;
    hosts.start(page as never);
    await new Promise((r) => setTimeout(r, 40));
    expect(checks()).toBeGreaterThan(2);
    page.hidden = true;
    listeners.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 10));
    const paused = checks();
    await new Promise((r) => setTimeout(r, 50));
    expect(checks()).toBe(paused);
    page.hidden = false;
    listeners.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 1));
    expect(checks()).toBe(paused + 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(checks()).toBeGreaterThan(paused + 2);
    hosts.stop();
    expect(listeners.size).toBe(0);
  });
});
