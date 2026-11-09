/**
 * The Anatomical panel, drawn into the SDK's stand-in document against a
 * context with a stand-in render service: its empty state, its cards and
 * controls (all made with the SDK's parts), updated in place, the image's
 * axes checked first, and the jobs (stills, movies, splats) kept across a
 * reload with their progress and cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { moveKeyframe, plugin, readSaved } from "../plugin.js";
import { fakeContext, frame3d, IMAGE, XYZ } from "./fake_context.js";

const PANEL = "anatomicalRendering.panel";

/** Every context activated in a test: switched off after it. */
const active: ReturnType<typeof fakeContext>[] = [];

async function activate(f: ReturnType<typeof fakeContext>) {
  active.push(f);
  await plugin.activate(f.ctx);
}

async function open(dom: FakeDom, f: ReturnType<typeof fakeContext>) {
  await activate(f);
  const host = dom.host();
  const dispose = f.panels.get(PANEL)!(host);
  // Connected to the stand-in computer: its GPU shows in Remote.
  await vi.waitFor(() => expect(dom.text(host)).toContain("Test GPU"));
  return { host, dispose: dispose as () => void };
}

/** The card titled `title`. */
const cardOf = (dom: FakeDom, host: HTMLElement, title: string) => [...host.querySelectorAll("details")].find((d) => dom.text(d.querySelector(".card-title")!) === title)!;

describe("the Anatomical panel", () => {
  let dom: FakeDom;
  beforeEach(() => {
    dom = fakeDocument();
  });
  afterEach(() => {
    for (const f of active.splice(0)) for (const off of f.ctx.subscriptions.splice(0)) off();
    dom.restore();
  });

  it("offers to open data while the scene has no image it can render, and shows only Remote", async () => {
    const f = fakeContext();
    await activate(f);
    const host = dom.host();
    f.panels.get(PANEL)!(host);
    const empty = host.querySelector<HTMLElement>(".empty-state")!;
    expect(dom.text(empty)).toBe("No OME-Zarr or N5 image in this scene. Open data…");
    empty.querySelector("button")!.click();
    expect(f.invoked).toEqual(["dataset.add"]);
    expect(host.querySelector<HTMLInputElement>("input.switch")!.disabled).toBe(true);
    const shown = [...host.querySelectorAll("details")].filter((d) => !d.hidden).map((d) => dom.text(d.querySelector(".card-title")!));
    expect(shown).toEqual(["Remote"]);
  });

  it("is cards of SDK parts: every on/off control a toggle or a checkbox, Regions and Quality, Movie and Splat their own", async () => {
    const f = fakeContext({ layers: [IMAGE], axes: { brain: XYZ } });
    const { host } = await open(dom, f);
    const titles = [...host.querySelectorAll("details")].map((d) => dom.text(d.querySelector(".card-title")!));
    expect(titles).toEqual(["Remote", "Rendering", "Regions", "Quality", "Lighting", "Crops", "Output", "Movie", "Splat"]);
    const boxes = host.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(boxes.length).toBeGreaterThan(5);
    for (const b of boxes) {
      let e: HTMLElement | null = b;
      while (e && !(e.tagName === "LABEL" && e.className.split(" ").includes("choice"))) e = e.parentNode as HTMLElement | null;
      expect(e, "an on/off control made with toggle() or checkbox()").not.toBeNull();
    }
    // Nothing styled inline, and the splats marked as in progress.
    expect(host.querySelectorAll("[style]")).toHaveLength(0);
    expect(dom.text(cardOf(dom, host, "Splat").querySelector(".chip")!)).toBe("In progress");
    // The status line says nothing while all is well and Render is off (no "off", no GPU: Remote shows it).
    expect(host.querySelector<HTMLElement>(".status-line")!.hidden).toBe(true);
  });

  it("updates in place: a change of state keeps the elements and shows the new value", async () => {
    const f = fakeContext({ layers: [IMAGE], axes: { brain: XYZ } });
    const { host } = await open(dom, f);
    const cards = host.querySelectorAll("details");
    const inputs = host.querySelectorAll("input");
    const exposure = host.querySelector<HTMLInputElement>("input.num-input[aria-label=Exposure]")!;
    f.ctx.state.set({ ...readSaved(f.state()), exposure: 2.5 });
    expect(exposure.value).toBe("2.5");
    // Typing in it: an undo arriving meanwhile waits until the box is left.
    exposure.focus();
    exposure.value = "3";
    f.ctx.state.set({ ...readSaved(f.state()), exposure: 1 });
    expect(exposure.value).toBe("3");
    exposure.blur();
    expect(exposure.value).toBe("1");
    expect(host.querySelectorAll("details")).toEqual(cards);
    expect(host.querySelectorAll("input")).toEqual(inputs);
  });

  it("writes no state from viewing alone", async () => {
    const f = fakeContext({ layers: [IMAGE], axes: { brain: XYZ } });
    const set = vi.spyOn(f.ctx.state, "set");
    await open(dom, f);
    f.setLayers([IMAGE]);
    expect(set).not.toHaveBeenCalled();
  });

  it("hides what this browser's renderer cannot do: region colours, the jar, finer detail", async () => {
    const f = fakeContext({ layers: [IMAGE], axes: { brain: XYZ }, state: { where: "browser" } });
    await activate(f);
    const host = dom.host();
    f.panels.get(PANEL)!(host);
    expect(cardOf(dom, host, "Regions").hidden).toBe(true);
    expect(dom.text(host)).not.toContain("Hide the jar");
    expect(dom.text(host)).not.toContain("Finer detail");
    expect(dom.text(cardOf(dom, host, "Remote"))).not.toContain("Computer");
  });

  it("checks the image's axes first: a 2-D image is not rendered, and says why", async () => {
    const flat = { names: ["y", "x"], units: ["m", "m"] };
    const f = fakeContext({ layers: [IMAGE], axes: { brain: flat } });
    const { host } = await open(dom, f);
    expect(dom.text(cardOf(dom, host, "Rendering"))).toContain("This image has 2 spatial axes: rendering needs x, y and z.");
    dom.check(host.querySelector<HTMLInputElement>("input.switch")!, true);
    expect(f.toasts.at(-1)).toMatch(/rendering needs x, y and z/);
    expect(readSaved(f.state()).on).toBe(false);
    expect(f.services.get("workstation")!.asked("POST", /^render\/sessions$/)).toHaveLength(0);
  });

  it("renders the first time point of a time series on a computer, and refuses it in this browser", async () => {
    const series = { names: ["t", "z", "y", "x"], units: ["s", "m", "m", "m"], bounds: { lower: [0, 0, 0, 0], upper: [12, 10, 10, 10] } };
    const f = fakeContext({ layers: [IMAGE], axes: { brain: series } });
    const { host } = await open(dom, f);
    expect(dom.text(cardOf(dom, host, "Rendering"))).toContain("This image has 12 time points: the first time point is rendered.");
    f.ctx.state.set({ ...readSaved(f.state()), where: "browser" });
    expect(dom.text(cardOf(dom, host, "Rendering"))).toContain("this browser renders an image with one of each");
  });

  it("labels the view buttons by axis when the image's metadata gives no anatomical orientation", async () => {
    const f = fakeContext({ layers: [IMAGE], axes: { brain: XYZ } });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ attributes: { ome: { multiscales: [{ axes: [{ name: "x", type: "space" }] }] } } })));
    try {
      const { host } = await open(dom, f);
      const labels = [...host.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")!).filter((l) => l.startsWith("Look from"));
      expect(labels).toEqual(["Look from +x", "Look from −x", "Look from +y", "Look from −y", "Look from +z", "Look from −z"]);
      dom.find(host, "button", "+x").click();
      expect(f.ng.projectionOrientation).toHaveLength(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the jobs across a reload, follows one still running, and cancels it", async () => {
    const settings = new Map<string, unknown>();
    const f = fakeContext({ layers: [IMAGE], axes: { brain: XYZ }, state: { on: true, layer: "brain" }, settings });
    const { host, dispose } = await open(dom, f);
    const service = f.services.get("workstation")!;
    await vi.waitFor(() => expect(service.asked("POST", /^render\/sessions$/)).toHaveLength(1));
    // A still asked for: the job is listed with its progress.
    f.drawers.at(-1)!.draw(frame3d());
    dom.find(host, "button", "Save still (PNG)").click();
    await vi.waitFor(() => expect(dom.text(cardOf(dom, host, "Output"))).toContain("25%, frame 1"));
    expect((settings.get("jobs") as { id: string }[])[0].id).toBe("stills-1");
    dispose();
    for (const off of f.ctx.subscriptions.splice(0)) off();

    // A reload: the list comes back from this browser's settings, and the still is followed again.
    const g = fakeContext({ layers: [IMAGE], axes: { brain: XYZ }, settings });
    g.services.get("workstation")!.jobs.set("stills-1", { id: "stills-1", status: "running", progress: 0.5, message: "", error: null });
    const again = await open(dom, g);
    await vi.waitFor(() => expect(dom.text(cardOf(dom, again.host, "Output"))).toContain("50%"));
    dom.find(cardOf(dom, again.host, "Output"), "button", "Cancel").click();
    await vi.waitFor(() => expect(dom.text(cardOf(dom, again.host, "Output"))).toContain("cancelled"));
    expect(g.services.get("workstation")!.asked("DELETE", /^render\/stills\/stills-1$/)).toHaveLength(1);
  });

  it("goes back to a keyframe's camera, and moves keyframes earlier and later", async () => {
    const view = { inv_view_projection: [], width: 1, height: 1, preset: "p" };
    const camera = { position: [1, 2, 3], orientation: [0, 0, 0, 1], scale: 9 };
    const f = fakeContext({ layers: [IMAGE], axes: { brain: XYZ }, state: { keyframes: [{ time: 0, view, camera }, { time: 2, view }] } });
    const { host } = await open(dom, f);
    const movie = cardOf(dom, host, "Movie");
    dom.find(movie, "button", "Go to").click();
    expect(f.ng).toMatchObject({ position: [1, 2, 3], projectionScale: 9 });
    movie.querySelector<HTMLButtonElement>("button[aria-label=\"Move keyframe 1 later\"]")!.click();
    const k = readSaved(f.state()).keyframes;
    expect(k.map((x) => [x.time, x.camera?.scale])).toEqual([[0, undefined], [2, 9]]);
  });
});

describe("keyframes in order", () => {
  it("swap places and keep the places' times", () => {
    const k = (time: number, name: string) => ({ time, view: { preset: name } as never });
    const list = [k(0, "a"), k(2, "b"), k(5, "c")];
    expect(moveKeyframe(list, 2, -1).map((x) => [x.time, (x.view as { preset: string }).preset])).toEqual([[0, "a"], [2, "c"], [5, "b"]]);
    expect(moveKeyframe(list, 0, -1)).toEqual(list);
  });
});
