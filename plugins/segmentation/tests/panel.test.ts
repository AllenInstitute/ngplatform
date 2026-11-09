/**
 * The Segmentation panel against a stand-in editor (only the fields and
 * calls the panel uses), and the browser copies: the empty state, a save
 * that fails (the status line, the Save card opened, Save again), the
 * kept copies listed with size and age and removed only when confirmed,
 * on/off controls from the shared parts, the panel kept in place, and a
 * session's changes kept when the page is hidden.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import type { Editor } from "../editor.js";
import { age, forgetPersist, type KeptInfo, keptBytes, persist } from "../keep.js";
import { LabelVolume } from "../label_volume.js";
import { Panel } from "../panel.js";
import { SamModel } from "../sam_model.js";
import { noGroups } from "../segment_groups.js";
import { Session } from "../session.js";
import type { Voxels } from "../../annotations/voxels.js";

const PLACE = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function fakeContext() {
  const ctx = {
    viewer: { layers: () => [], layerSpec: () => undefined },
    ui: { toast: vi.fn(), confirm: vi.fn(async () => true), showPanel: vi.fn() },
    commands: { invoke: vi.fn(async () => undefined) },
    log: { info: vi.fn(), error: vi.fn() },
  };
  return { ctx: ctx as unknown as PlatformContext, raw: ctx };
}

/** An editor with no volume open, or one session; `changed()` tells the panel. */
function fakeEditor(session?: Partial<Session>) {
  const listeners = new Set<() => void>();
  const e = {
    current: session as Session | undefined,
    editing: false,
    tool: "move",
    value: 1,
    radius: 2,
    unit: "voxels",
    shape: "disc",
    overwrite: "all",
    eraseOnly: false,
    lassoErase: false,
    fill3d: false,
    fillBy: "label",
    reach: 32,
    method: "threshold",
    tolerance: 0.1,
    quickMode: "preview",
    quickContext: 256,
    quickStatus: undefined,
    pending: undefined,
    spreadCount: 5,
    limit: false,
    low: 0,
    high: 1,
    saveFormat: "nii.gz",
    saveCrop: false,
    saveInPlace: "edits",
    saveStatus: undefined as { kind: "progress" | "error"; text: string } | undefined,
    saveFailures: 0,
    keptHere: [] as KeptInfo[],
    storage: {},
    sam: new SamModel(),
    quickSelect: { methods: () => [{ id: "threshold", title: "Threshold" }] },
    quickMethod: () => ({ id: "threshold", title: "Threshold" }),
    canSpread: () => false,
    rows: vi.fn(() => [{ value: 1, name: "", colour: "#ff0000", voxels: 10, visible: true }]),
    groups: () => noGroups(),
    inScene: () => (session ? [session] : []),
    refreshKept: vi.fn(async () => {}),
    discardKept: vi.fn(async (id: string) => void (e.keptHere = e.keptHere.filter((k) => k.id !== id))),
    save: vi.fn(async () => {}),
    setTool: vi.fn(),
    onChanged: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    changed: () => listeners.forEach((f) => f()),
  };
  return e;
}

const session = (): Partial<Session> => ({
  fileName: "labels-1.ngplabels",
  layer: "Labels",
  volume: new LabelVolume([64, 64, 64], "uint8", PLACE, "t"),
  unsaved: 2,
  reference: undefined,
  placement: () => undefined,
});

let dom: FakeDom;
beforeEach(() => {
  dom = fakeDocument();
  // A frame at once: the panel draws on the next one.
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => (f(), 0));
});
afterEach(() => {
  dom.restore();
  vi.unstubAllGlobals();
});

function draw(e: ReturnType<typeof fakeEditor>) {
  const { ctx, raw } = fakeContext();
  const host = dom.host();
  const off = new Panel(ctx, e as unknown as Editor, {} as Voxels).render(host);
  return { host, raw, off };
}

describe("the Segmentation panel", () => {
  it("with nothing to draw on, says so with Open data… in a card (no heading of its own)", () => {
    const { host, raw } = draw(fakeEditor());
    expect(host.querySelector(".an-sub")).toBeNull();
    expect(dom.text(dom.find(host, "span.card-title", "New segmentation layer"))).toBe("New segmentation layer");
    expect(dom.text(host)).toContain("No image or segmentation to draw on.");
    dom.find(host, "button", "Open data…").click();
    expect(raw.commands.invoke).toHaveBeenCalledWith("dataset.add");
    expect(dom.find(host, "div.status-line").hidden).toBe(true);
  });

  it("shows a failed save in its status line, opens the Save card once, and saves again from there", () => {
    const e = fakeEditor(session());
    const { host } = draw(e);
    const save = host.querySelector('details[data-card="segmentation.save"]') as HTMLDetailsElement;
    expect(save.open).toBe(false);
    e.saveStatus = { kind: "progress", text: "Writing: 40%" };
    e.changed();
    const status = dom.find(host, "div.status-line");
    expect(dom.text(status)).toBe("Writing: 40%");
    e.saveStatus = { kind: "error", text: "Could not save: the disk is full" };
    e.saveFailures++;
    e.changed();
    expect(status.className).toContain("error");
    expect(dom.text(status)).toContain("Could not save: the disk is full");
    expect(save.open).toBe(true);
    // Closed by the person, it stays closed for the same failure.
    save.open = false;
    e.changed();
    expect(save.open).toBe(false);
    dom.find(status, "button", "Save again").click();
    expect(e.save).toHaveBeenCalled();
    e.saveStatus = undefined;
    e.changed();
    expect(status.hidden).toBe(true);
  });

  it("narrates nothing: no counts or 'nothing unsaved' line, the unsaved count on the Save card", () => {
    const { host } = draw(fakeEditor(session()));
    const text = dom.text(host);
    expect(text).not.toContain("Nothing unsaved");
    expect(text).not.toContain("not saved");
    expect(dom.text(dom.find(host, 'details[data-card="segmentation.save"]').querySelector(".card-badge")!)).toBe("2 unsaved");
  });

  it("makes every on/off control with the shared parts", () => {
    const e = fakeEditor(session());
    const { host } = draw(e);
    const boxes = [...host.querySelectorAll("input")].filter((i) => i.getAttribute("type") === "checkbox");
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect((b.parentNode as HTMLElement).className).toBe("choice");
    const crop = boxes.find((b) => b.getAttribute("aria-label") === null && dom.text(b.parentNode as HTMLElement) === "Only the painted box")!;
    dom.check(crop, true);
    expect(e.saveCrop).toBe(true);
  });

  it("offers the brush when nothing is painted", () => {
    const e = fakeEditor(session());
    e.rows.mockReturnValue([{ value: 1, name: "", colour: "#ff0000", voxels: 0, visible: true }]);
    const { host } = draw(e);
    dom.find(host, "button", "Brush (B)").click();
    expect(e.setTool).toHaveBeenCalledWith("brush");
  });

  it("is kept in place: a change to the segments leaves the tool's card as it was", () => {
    const e = fakeEditor(session());
    const { host } = draw(e);
    const tools = () => dom.find(host, 'details[data-card="segmentation.tool"]').querySelector("div.segmented");
    const tool = tools();
    e.rows.mockReturnValue([
      { value: 1, name: "", colour: "#ff0000", voxels: 10, visible: true },
      { value: 2, name: "two", colour: "#00ff00", voxels: 5, visible: true },
    ]);
    e.changed();
    expect(dom.text(host)).toContain("two");
    expect(tools()).toBe(tool);
  });

  it("lists the copies kept in this browser with size and age, and removes one only when confirmed", async () => {
    const e = fakeEditor();
    const now = Date.now();
    e.keptHere = [
      { id: "a", name: "Cortex", size: [64, 64, 64], type: "uint16", voxelToRas: [], labels: [], time: now - 3 * 86400_000, chunks: 2 },
      { id: "b", name: "Nuclei", size: [64, 64, 64], type: "uint8", voxelToRas: [], labels: [], time: now - 120_000, chunks: 1 },
    ];
    e.storage = { usage: 5 * 2 ** 20, quota: 2 ** 30, persisted: false };
    const { host, raw } = draw(e);
    const kept = dom.find(host, 'details[data-card="segmentation.kept"]');
    expect(kept.hidden).toBe(false);
    const text = dom.text(kept);
    expect(text).toContain("Cortex");
    expect(text).toContain("1 MB · 3 days ago");
    expect(text).toContain("256 KB · 2 min ago");
    expect(text).toContain("may be cleared");
    raw.ui.confirm.mockResolvedValueOnce(false);
    dom.find(kept, "button", "Remove…").click();
    await vi.waitFor(() => expect(raw.ui.confirm).toHaveBeenCalledTimes(1));
    expect(e.discardKept).not.toHaveBeenCalled();
    dom.find(kept, "button", "Remove…").click();
    await vi.waitFor(() => expect(e.discardKept).toHaveBeenCalledWith("a"));
    e.changed();
    expect(dom.text(kept)).not.toContain("Cortex");
  });
});

describe("the copies kept in this browser", () => {
  it("are sized by their chunks and dated by their age", () => {
    const info = { id: "x", name: "x", size: [1, 1, 1], type: "uint32", voxelToRas: [], labels: [], time: 0, chunks: 3 } as KeptInfo;
    expect(keptBytes(info)).toBe(3 * 64 ** 3 * 4);
    expect(age(1000, 30_000)).toBe("just now");
    expect(age(0, 5 * 60_000)).toBe("5 min ago");
    expect(age(0, 3 * 3600_000)).toBe("3 h ago");
    expect(age(0, 86400_000)).toBe("1 day ago");
  });

  it("are asked to be kept for good once a visit", async () => {
    forgetPersist();
    const ask = vi.fn(async () => false);
    vi.stubGlobal("navigator", { storage: { persist: ask, persisted: async () => false } });
    expect(await persist()).toBe(false);
    expect(await persist()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    forgetPersist();
    vi.stubGlobal("navigator", {});
    expect(await persist()).toBeUndefined();
    forgetPersist();
  });
});

/** Browser storage in memory: folders and files, as much as keep.ts uses. */
function memoryStorage() {
  const files = new Map<string, unknown>();
  const folder = (path: string): unknown => ({
    kind: "directory",
    getDirectoryHandle: async (name: string) => folder(`${path}/${name}`),
    getFileHandle: async (name: string) => ({ createWritable: async () => ({ write: async (d: unknown) => void files.set(`${path}/${name}`, d), close: async () => {} }) }),
    removeEntry: async (name: string) => void files.delete(`${path}/${name}`),
  });
  return { files, storage: { getDirectory: async () => folder(""), persist: async () => false, persisted: async () => false } };
}

describe("a session's strokes", () => {
  it("are kept at once when the page is hidden, and the browser asked to keep them (said once if it will not)", async () => {
    forgetPersist();
    const { files, storage } = memoryStorage();
    vi.stubGlobal("navigator", { storage });
    const toast = vi.fn();
    const ctx = {
      workspace: { local: { open: async (f: File) => [{ source: `zarr3://http://local/${f.name}` }], close: vi.fn() }, datasets: () => [], addDataset: vi.fn() },
      viewer: { layers: () => [] },
      ui: { toast },
      log: { info: vi.fn(), error: vi.fn() },
    } as unknown as PlatformContext;
    const volume = new LabelVolume([64, 64, 64], "uint8", PLACE, "t");
    volume.chunk(0, true)![1] = 3;
    const s = await Session.open(ctx, {} as Voxels, volume, "Labels");
    s.changed([0]);
    expect([...files.keys()]).toEqual([]);
    // Hidden (another tab): kept now, not 1.5 s later.
    (document as unknown as { visibilityState: string }).visibilityState = "hidden";
    dom.fire(document, "visibilitychange");
    await vi.waitFor(() => expect([...files.keys()].some((k) => k.endsWith("/c0"))).toBe(true));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0]).toContain("may clear");
    s.dispose();
    forgetPersist();
  });
});
