// @vitest-environment dom
/**
 * Panels in a DOM, on the platform's real services with a fake network:
 * Settings › Compute pairs This computer's runner from its form (Enter in
 * the token field pairs, a wrong token is said in the panel, a paired
 * runner shows what it is and can be unpaired), and the Activity log puts
 * the newest line first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostList } from "../src/platform/hosts.js";
import { RunnerService } from "../src/platform/runner.js";
import { ActivityLog } from "../src/ui/panels/activity.js";
import { renderRemotePanel } from "../src/ui/panels/remote.js";
import type { Workbench } from "../src/ui/workbench.js";

const TOKEN = "a-pairing-token-of-some-length";
const STATUS = {
  name: "ngplatform-runner",
  version: "0.1.0",
  pid: 4242,
  address: "http://127.0.0.1:8765",
  roots: ["/data"],
  python: "/usr/bin/python3",
  tools: "0.9.0",
  maxRunning: 2,
  kinds: [],
};

/** A runner on 127.0.0.1:8765 that knows one token, counting what it is asked. */
function fakeRunner() {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const auth = new Headers(init?.headers).get("Authorization");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.origin !== "http://127.0.0.1:8765") throw new TypeError("Failed to fetch");
    if (auth !== `Bearer ${TOKEN}`) return json({ error: "unauthorised" }, 401);
    if (url.pathname === "/status") return json(STATUS);
    if (url.pathname === "/jobs") return json({ jobs: [] });
    if (url.pathname === "/serve") return json({ serves: [] });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, asked };
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

describe("Settings › Compute", () => {
  let host: HTMLElement;
  let runner: RunnerService;
  beforeEach(() => {
    localStorage.clear();
    const { fetchImpl } = fakeRunner();
    runner = new RunnerService(localStorage, fetchImpl, 60_000);
    // Checks that never come round during a test: the panel is driven by the pairing.
    const hosts = new HostList(runner, localStorage, fetchImpl, 60_000, 1000);
    const wb = { hosts, docks: { show: vi.fn() }, run: vi.fn() } as unknown as Workbench;
    host = document.body.appendChild(document.createElement("div"));
    dispose = renderRemotePanel(host, wb);
  });
  const section = () => host.querySelector<HTMLElement>('.runner-section[data-host]')!;
  const connection = () => section().querySelector(".runner-connection")!;
  const field = (cls: string) => host.querySelector<HTMLInputElement>(`.${cls}`)!;

  it("shows This computer not paired, with a form to pair it", () => {
    expect(host.textContent).toContain("This computer");
    expect(connection().textContent).toBe("not paired");
    expect(field("runner-address").value).toBe("http://127.0.0.1:8765");
    expect(field("runner-token").type).toBe("password");
    expect(field("runner-token").getAttribute("aria-label")).toBe("Runner token");
  });

  it("says in the panel when the token is refused, and keeps what was typed", async () => {
    field("runner-token").value = "not-the-right-token-at-all";
    field("runner-token").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const message = () => host.querySelector<HTMLElement>(".runner-pair-error")!;
    await vi.waitFor(() => expect(message().hidden).toBe(false));
    expect(message().textContent).toMatch(/refused the pairing token/);
    expect(field("runner-token").value).toBe("not-the-right-token-at-all");
    expect(runner.connection()).toBe("unpaired");
  });

  it("pairs with Enter in the token field, then shows the runner and can unpair it", async () => {
    field("runner-token").value = TOKEN;
    field("runner-token").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(connection().textContent).toBe("connected"));
    expect(section().textContent).toContain("Runner 0.1.0 at http://127.0.0.1:8765 (PID 4242)");
    expect(JSON.parse(localStorage.getItem("ngplatform.runner")!)).toEqual({ address: "http://127.0.0.1:8765", token: TOKEN });

    host.querySelector<HTMLButtonElement>(".runner-unpair")!.click();
    expect(connection().textContent).toBe("not paired");
    expect(localStorage.getItem("ngplatform.runner")).toBeNull();
    expect(field("runner-token")).not.toBeNull();
  });
});

describe("Activity", () => {
  it("puts the newest line first, an error marked as one", () => {
    const log = new ActivityLog();
    document.body.append(log.element);
    log.add("Opened the workspace");
    log.add("The store did not answer", "error", "zarr");
    const lines = [...log.element.querySelectorAll("li")];
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("zarr · The store did not answer");
    expect(lines[0].querySelector(".error")).not.toBeNull();
    expect(lines[1].textContent).toContain("Opened the workspace");
    expect(log.element.getAttribute("aria-live")).toBe("polite");
  });
});
