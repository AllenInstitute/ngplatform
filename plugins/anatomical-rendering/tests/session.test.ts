/**
 * The session on the render computer through its life: opened when Render
 * is on, closed through the service that opened it when another computer
 * is chosen, on Reconnect and as the page closes (a request that outlives
 * the page); views sent from Neuroglancer's frames (half size while the
 * camera moves, full size once it stops); and frames as the service sends
 * them, parsed.
 */
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { refusal, RenderService, ServiceError } from "../client.js";
import { plugin } from "../plugin.js";
import { fakeContext, frame3d, IMAGE, XYZ } from "./fake_context.js";

const ON = { on: true, layer: "brain" };

/** Every context activated in a test: switched off after it. */
const active: ReturnType<typeof fakeContext>[] = [];

async function started(dom: FakeDom, hosts = ["workstation"]) {
  const f = fakeContext({ layers: [IMAGE], axes: { brain: XYZ }, state: ON, hosts });
  active.push(f);
  await plugin.activate(f.ctx);
  const host = dom.host();
  f.panels.get("anatomicalRendering.panel")!(host);
  const first = f.services.get(hosts[0])!;
  await vi.waitFor(() => expect(first.asked("POST", /^render\/sessions$/)).toHaveLength(1));
  return { f, host };
}

describe("the session on the render computer", () => {
  let dom: FakeDom;
  beforeEach(() => {
    dom = fakeDocument();
  });
  afterEach(() => {
    for (const f of active.splice(0)) for (const off of f.ctx.subscriptions.splice(0)) off();
    dom.restore();
  });

  it("closes the session on the computer it was opened on when another is chosen", async () => {
    const { f, host } = await started(dom, ["workstation", "cluster"]);
    const a = f.services.get("workstation")!, b = f.services.get("cluster")!;
    const computer = host.querySelector<HTMLSelectElement>("select[aria-label=Computer]")!;
    computer.value = "cluster";
    dom.fire(computer, "change");
    await vi.waitFor(() => expect(b.asked("POST", /^render\/sessions$/)).toHaveLength(1));
    // The old session went to the old computer, not the new one.
    expect(a.asked("DELETE", /^render\/sessions\/workstation-s1$/)).toHaveLength(1);
    expect(b.asked("DELETE", /sessions/)).toHaveLength(0);
    expect(f.settings.get("host")).toEqual({ name: "cluster" });
  });

  it("closes the session and opens a new one on Reconnect", async () => {
    const { f, host } = await started(dom);
    const a = f.services.get("workstation")!;
    dom.find(host, "button", "Reconnect").click();
    await vi.waitFor(() => expect(a.asked("POST", /^render\/sessions$/)).toHaveLength(2));
    expect(a.asked("DELETE", /^render\/sessions\/workstation-s1$/)).toHaveLength(1);
  });

  it("closes the session as the page closes, with a request that outlives the page", async () => {
    const { f } = await started(dom);
    const a = f.services.get("workstation")!;
    dom.fire(window as unknown as Element, "pagehide");
    const del = a.asked("DELETE", /^render\/sessions\/workstation-s1$/);
    expect(del).toHaveLength(1);
    expect(del[0].keepalive).toBe(true);
  });

  it("closes the session when Render is switched off, and lets everything go when the plugin is", async () => {
    const { f, host } = await started(dom);
    const a = f.services.get("workstation")!;
    dom.check(host.querySelector<HTMLInputElement>("input.switch")!, false);
    expect(a.asked("DELETE", /^render\/sessions\/workstation-s1$/)).toHaveLength(1);
    expect((f.state() as { on: boolean }).on).toBe(false);
    for (const off of f.ctx.subscriptions.splice(0)) off();
    expect(f.listeners()).toBe(0);
  });

  it("sends a half-size view while the camera moves and the full one once it stops", async () => {
    const { f } = await started(dom);
    const a = f.services.get("workstation")!;
    const drawer = f.drawers.at(-1)!;
    drawer.draw(frame3d({ moving: true }));
    await vi.waitFor(() => expect(a.asked("PUT", /\/view$/)).toHaveLength(1));
    expect((a.asked("PUT", /\/view$/)[0].body as { scale: number }).scale).toBe(0.5);
    // No frame for a moment: the camera stopped, and the full-size view goes.
    await vi.waitFor(() => expect(a.asked("PUT", /\/view$/)).toHaveLength(2), { timeout: 2000 });
    expect((a.asked("PUT", /\/view$/)[1].body as { scale: number; width: number }).scale).toBe(1);
    // The same camera again sends nothing more.
    drawer.draw(frame3d());
    await new Promise((r) => setTimeout(r, 50));
    expect(a.asked("PUT", /\/view$/)).toHaveLength(2);
  });
});

describe("a frame as the service sends it", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is read as a JPEG, its alpha plane and its points (distances as scaled half floats)", async () => {
    vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({ width: 2, height: 1, close: () => undefined, size: blob.size, type: blob.type }));
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const alpha = deflateSync(new Uint8Array([0, 255]));
    // Distances 1 and "nothing there" (-1): half floats 1.0 (0x3c00) and -1.0 (0xbc00), times a scale of 2.
    const dist = deflateSync(new Uint8Array(new Uint16Array([0x3c00, 0xbc00]).buffer));
    const body = new Uint8Array([...jpeg, ...alpha, ...dist]);
    const headers = {
      "X-Frame": "7", "X-Samples": "32", "X-Version": "3", "X-Width": "2", "X-Height": "1", "X-Ms-Per-Pass": "12", "X-Detail": "level 1",
      "X-Alpha-Offset": String(jpeg.length),
      "X-Distance-Offset": String(jpeg.length + alpha.length), "X-Distance-Format": "float16-zlib", "X-Distance-Width": "2", "X-Distance-Height": "1", "X-Distance-Scale": "2",
    };
    const seen: string[] = [];
    const service = new RenderService({ base: "", token: "", viaRunner: true, hostFetch: async (path) => (seen.push(path), new Response(body, { headers })) });
    const f = (await service.frame("s1", 6, undefined, 2))!;
    expect(seen[0]).toBe("render/sessions/s1/frame?after=6&timeout=20&have=2");
    expect(f).toMatchObject({ number: 7, samples: 32, version: 3, width: 2, height: 1, msPerPass: 12, detail: "level 1" });
    expect((f.bitmap as unknown as { size: number; type: string }).size).toBe(jpeg.length);
    expect((f.bitmap as unknown as { type: string }).type).toBe("image/jpeg");
    expect(Array.from(f.alpha!)).toEqual([0, 255]);
    expect(f.distance).toMatchObject({ version: 3, width: 2, height: 1 });
    expect(Array.from(f.distance!.data)).toEqual([2, -1]);
  });

  it("is none when the long poll ends without one, and an error with its status otherwise", async () => {
    const answers = [new Response(null, { status: 204 }), new Response(JSON.stringify({ error: "no such session" }), { status: 404 })];
    const service = new RenderService({ base: "", token: "", viaRunner: true, hostFetch: async () => answers.shift()! });
    expect(await service.frame("s1", 0)).toBeUndefined();
    await expect(service.frame("s1", 0)).rejects.toMatchObject({ status: 404, message: "frame: no such session" });
  });
});

describe("the service's refusals, in plain words", () => {
  /** A service whose every request is answered with this status, body and headers. */
  const answering = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new RenderService({ base: "", token: "", viaRunner: true, hostFetch: async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } }) });

  it("says the GPU is busy (503), with what it needs and has, and keeps Retry-After", async () => {
    const service = answering(503, { error: "The render computer's GPU is busy: …", reason: "gpu-budget", need_mb: 900, free_mb: 300, budget_mb: 38000 }, { "Retry-After": "30" });
    const e = await service.open({ url: "https://example.org/brain.ome.zarr" }).catch((x) => x);
    expect(e).toBeInstanceOf(ServiceError);
    expect(e).toMatchObject({ status: 503, retryAfter: 30, message: "The render computer's GPU is busy (needs 900 MB, 300 MB free). Retry, or close another view." });
    expect(refusal(e)).toEqual({ text: e.message, retry: true });
    // A view larger than the session's frame so far: the same refusal.
    await expect(service.setView("s1", { inv_view_projection: [], width: 1, height: 1, preset: "p" })).rejects.toMatchObject({ status: 503 });
  });

  it("says too many jobs wait (429), and the disk is nearly full (507)", async () => {
    const queue = await answering(429, { error: "…", reason: "queue-full", waiting: 8 }, { "Retry-After": "30" }).still("s1", {}).catch((x) => x);
    expect(queue.message).toBe("Too many jobs waiting on the render computer. Retry when one has finished.");
    expect(refusal(queue)?.retry).toBe(true);
    const disk = await answering(507, { error: "…", reason: "disk", need_mb: 2048, free_mb: 900 }).movie("s1", {}).catch((x) => x);
    expect(disk.message).toBe("The render computer's disk is nearly full (needs 2.0 GB, 900 MB free). Free some space there, then Retry.");
    expect(refusal(disk)?.retry).toBe(true);
  });

  it("gives a job that could never fit (400) as the computer words it, with no Retry; other errors as before", async () => {
    const never = await answering(400, { error: "This splat needs about 60 GB of GPU memory, more than the render computer's budget of 38 GB: make it smaller" }).splat("s1", {}).catch((x) => x);
    expect(never.message).toMatch(/^This splat needs about 60 GB/);
    expect(refusal(never)?.retry).toBe(false);
    const gone = await answering(404, { error: "no such session" }).session("s1").catch((x) => x);
    expect(gone.message).toBe("GET /sessions/s1: no such session");
    expect(refusal(gone)).toBeUndefined();
  });
});

describe("refused on the render computer, in the panel", () => {
  let dom: FakeDom;
  beforeEach(() => {
    dom = fakeDocument();
  });
  afterEach(() => {
    for (const f of active.splice(0)) for (const off of f.ctx.subscriptions.splice(0)) off();
    dom.restore();
  });

  const BUSY = { error: "busy", reason: "gpu-budget", need_mb: 900, free_mb: 300, budget_mb: 38000 };
  const statusOf = (host: HTMLElement) => host.querySelector<HTMLElement>(".status-line")!;

  it("says the GPU is busy when the session is refused, and Retry opens it again", async () => {
    const f = fakeContext({ layers: [IMAGE], axes: { brain: XYZ }, state: ON });
    active.push(f);
    const a = f.services.get("workstation")!;
    a.refusals.push({ method: "POST", path: /^\/sessions$/, status: 503, body: BUSY, retryAfter: 30 });
    await plugin.activate(f.ctx);
    const host = dom.host();
    f.panels.get("anatomicalRendering.panel")!(host);
    await vi.waitFor(() => expect(dom.text(statusOf(host))).toContain("The render computer's GPU is busy (needs 900 MB, 300 MB free). Retry, or close another view."));
    dom.find(statusOf(host), "button", "Retry").click();
    await vi.waitFor(() => expect(a.asked("POST", /^render\/sessions$/)).toHaveLength(2));
    await vi.waitFor(() => expect(statusOf(host).hidden).toBe(true));
  });

  it("keeps the session when a view is refused, and Retry sends the view again", async () => {
    const { f, host } = await started(dom);
    const a = f.services.get("workstation")!;
    a.refusals.push({ method: "PUT", path: /\/view$/, status: 503, body: BUSY, retryAfter: 30 });
    const drawer = f.drawers.at(-1)!;
    drawer.draw(frame3d());
    await vi.waitFor(() => expect(dom.text(statusOf(host))).toContain("GPU is busy"));
    dom.find(statusOf(host), "button", "Retry").click();
    drawer.draw(frame3d());
    await vi.waitFor(() => expect(a.asked("PUT", /\/view$/)).toHaveLength(2));
    // The same session: not closed, not opened again.
    expect(a.asked("POST", /^render\/sessions$/)).toHaveLength(1);
    expect(a.asked("DELETE", /sessions/)).toHaveLength(0);
  });

  it("says too many jobs wait when a still is refused, and Retry asks for it again", async () => {
    const { f, host } = await started(dom);
    const a = f.services.get("workstation")!;
    a.refusals.push({ method: "POST", path: /\/stills$/, status: 429, body: { error: "…", reason: "queue-full", waiting: 8 }, retryAfter: 30 });
    f.drawers.at(-1)!.draw(frame3d());
    dom.find(host, "button", "Save still (PNG)").click();
    await vi.waitFor(() => expect(dom.text(statusOf(host))).toContain("Still: Too many jobs waiting on the render computer."));
    dom.find(statusOf(host), "button", "Retry").click();
    await vi.waitFor(() => expect(a.asked("POST", /\/stills$/)).toHaveLength(2));
    expect(statusOf(host).hidden).toBe(true);
    expect(f.toasts).toEqual([]);
  });

  it("says the disk is nearly full when a splat is refused, and Retry asks for it again", async () => {
    const { f, host } = await started(dom);
    const a = f.services.get("workstation")!;
    a.refusals.push({ method: "POST", path: /\/splats$/, status: 507, body: { error: "…", reason: "disk", need_mb: 5120, free_mb: 800 } });
    f.drawers.at(-1)!.draw(frame3d());
    dom.find(host, "button", "Make splat").click();
    await vi.waitFor(() => expect(dom.text(statusOf(host))).toContain("Splat: The render computer's disk is nearly full (needs 5.0 GB, 800 MB free)."));
    dom.find(statusOf(host), "button", "Retry").click();
    await vi.waitFor(() => expect(a.asked("POST", /\/splats$/)).toHaveLength(2));
  });

  it("says a job that could never fit in a toast, with no Retry", async () => {
    const { f, host } = await started(dom);
    const a = f.services.get("workstation")!;
    a.refusals.push({ method: "POST", path: /\/stills$/, status: 400, body: { error: "This still needs about 60 GB of GPU memory, more than the render computer's budget of 38 GB: make it smaller" } });
    f.drawers.at(-1)!.draw(frame3d());
    dom.find(host, "button", "Save still (PNG)").click();
    await vi.waitFor(() => expect(f.toasts).toEqual(["Still: This still needs about 60 GB of GPU memory, more than the render computer's budget of 38 GB: make it smaller"]));
    expect(statusOf(host).hidden).toBe(true);
  });
});
