import { describe, expect, it } from "vitest";
import { RenderService, ServiceError, type Link } from "../client.js";
import { clampInt, evenSide, LIMITS, movieSettings, RETRY_MS, retryDelay, stillProblem, windowStep } from "../limits.js";

describe("what the panel may ask of the render service", () => {
  it("keeps movie sides even and within the limits", () => {
    expect(evenSide(1281)).toBe(1280);
    expect(evenSide(721)).toBe(720);
    expect(evenSide(0)).toBe(8);
    expect(evenSide(-50)).toBe(8);
    expect(evenSide(10 ** 6)).toBe(8192);
    expect(evenSide(Number.NaN)).toBe(8);
  });

  it("keeps fps and samples whole and within the limits", () => {
    const m = movieSettings({ fps: 0, width: 1281, height: 9, samples: 1e9, easing: "smooth" as const });
    expect(m).toEqual({ fps: 1, width: 1280, height: 8, samples: LIMITS.maxSamples, easing: "smooth" });
    expect(movieSettings({ fps: 1000, width: 1280, height: 720, samples: -3 })).toMatchObject({ fps: LIMITS.maxFps, samples: 1 });
    expect(clampInt(2.6, 1, 10)).toBe(3);
  });

  it("refuses a still past the service's pixels times samples", () => {
    expect(stillProblem(1920, 1080, 512)).toBeUndefined();
    expect(stillProblem(8192, 8192, 256)).toBeUndefined();
    expect(stillProblem(8192, 8192, 512)).toMatch(/too large/);
  });

  it("windows a 0..1 image in steps finer than 1, and an integer one in whole steps", () => {
    expect(windowStep(0, 1, "float32")).toBeCloseTo(0.001);
    expect(windowStep(0, 3.7, "float32")).toBeCloseTo(0.005);
    expect(windowStep(0, 255, "uint8")).toBe(1);
    expect(windowStep(0, 65535, "uint16")).toBe(100);
    expect(windowStep(0, 1)).toBe(1); // type unknown: whole steps, as before
    expect(windowStep(5, 5, "float32")).toBe(0.001);
  });

  it("asks a computer that does not answer less and less often, then stops", () => {
    expect(retryDelay(1)).toBe(RETRY_MS[0]);
    const waits = RETRY_MS.map((_, i) => retryDelay(i + 1)!);
    expect(waits.every((w, i) => i === 0 || w > waits[i - 1])).toBe(true);
    expect(retryDelay(RETRY_MS.length + 1)).toBeUndefined();
    // About a minute in all before it says so.
    expect(RETRY_MS.reduce((a, b) => a + b)).toBeGreaterThan(30_000);
  });
});

describe("the service's answers", () => {
  function service(answer: (path: string, init?: RequestInit) => Response): { svc: RenderService; asked: { path: string; init?: RequestInit }[] } {
    const asked: { path: string; init?: RequestInit }[] = [];
    const link: Link = {
      base: "http://host/svc/render",
      token: "",
      viaRunner: true,
      label: "workstation",
      hostFetch: async (path, init) => {
        asked.push({ path, init });
        return answer(path, init);
      },
    };
    return { svc: new RenderService(link), asked };
  }

  it("closes a session with a request that outlives the page", async () => {
    const { svc, asked } = service(() => new Response(JSON.stringify({ closed: "a" }), { status: 200 }));
    await svc.close("a", true);
    await svc.close("b");
    expect(asked[0]).toMatchObject({ path: "render/sessions/a", init: { method: "DELETE", keepalive: true } });
    expect(asked[1].init?.keepalive).toBeUndefined();
  });

  it("tells a forgotten session (404) from a failed one (410)", async () => {
    const gone = service(() => new Response(JSON.stringify({ error: "no such session" }), { status: 404 })).svc;
    const failed = service(() => new Response(JSON.stringify({ error: "The GPU ran out of memory", status: "failed" }), { status: 410 })).svc;
    await expect(gone.frame("a", 0)).rejects.toMatchObject({ status: 404 });
    const e = await failed.frame("a", 0).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).status).toBe(410);
    expect((e as Error).message).toMatch(/out of memory/);
    await expect(gone.session("a")).rejects.toMatchObject({ status: 404 });
  });

  it("makes a still as a job", async () => {
    const { svc, asked } = service((path) => new Response(JSON.stringify({ id: "s1", status: path.endsWith("stills") ? "queued" : "done", progress: 0, message: "", error: null, file: null })));
    expect((await svc.still("a", { width: 64 })).status).toBe("queued");
    expect((await svc.stillInfo("s1")).status).toBe("done");
    expect(asked.map((x) => `${x.init?.method} ${x.path}`)).toEqual(["POST render/sessions/a/stills", "GET render/stills/s1"]);
  });
});
