/**
 * The starter plugin's tests, to copy: its pure functions, its panel
 * (drawn into the SDK's stand-in document, against a context that holds
 * only what the panel uses), and that switching it off leaves nothing
 * behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerInfo, PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { describeLayers, plugin, readSaved, renderPanel } from "../plugin.js";

describe("the starter plugin", () => {
  it("reads its state, whatever was saved", () => {
    expect(readSaved(undefined)).toEqual({ count: 0 });
    expect(readSaved({ count: 3 })).toEqual({ count: 3 });
    expect(readSaved({ count: "three" })).toEqual({ count: 0 });
  });

  it("counts the layers shown, for the badge", () => {
    expect(describeLayers([])).toBe("");
    expect(describeLayers([{ name: "a", type: "image", visible: true }, { name: "b", type: "segmentation", visible: false }])).toBe("1 of 2 shown");
  });
});

/**
 * A context with what the panel uses: the layers, the plugin's state and
 * commands, each counting its listeners so a test can see they are let go.
 */
function fakeContext() {
  let layers: Pick<LayerInfo, "name" | "type" | "visible">[] = [];
  let state: unknown;
  const layerListeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  const panels = new Map<string, (host: HTMLElement) => (() => void) | void>();
  const commands = new Map<string, () => unknown>();
  const invoked: string[] = [];
  const ctx = {
    viewer: {
      layers: () => layers,
      onLayersChanged: (f: () => void) => (layerListeners.add(f), () => layerListeners.delete(f)),
    },
    state: {
      get: () => state,
      set: (v: unknown) => ((state = v), stateListeners.forEach((f) => f())),
      onChanged: (f: () => void) => (stateListeners.add(f), () => stateListeners.delete(f)),
    },
    commands: {
      register: (id: string, run: () => unknown) => (commands.set(id, run), () => commands.delete(id)),
      invoke: async (id: string) => void invoked.push(id),
    },
    workspace: { selectedLayer: () => undefined },
    ui: { panel: (id: string, render: (host: HTMLElement) => (() => void) | void) => (panels.set(id, render), () => panels.delete(id)), toast: vi.fn() },
    log: { info: vi.fn() },
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    panels,
    commands,
    invoked,
    listeners: () => layerListeners.size + stateListeners.size,
    setLayers(next: typeof layers) {
      layers = next;
      layerListeners.forEach((f) => f());
    },
  };
}

describe("the starter panel", () => {
  let dom: FakeDom;
  beforeEach(() => {
    dom = fakeDocument();
  });
  afterEach(() => dom.restore());

  it("offers to open data while the scene is empty, then lists the layers", () => {
    const f = fakeContext();
    const host = dom.host();
    renderPanel(f.ctx, host);
    const empty = host.querySelector<HTMLElement>(".empty-state")!;
    expect(empty.hidden).toBe(false);
    expect(dom.text(empty)).toBe("No layers in this scene. Open data…");
    empty.querySelector("button")!.click();
    expect(f.invoked).toEqual(["dataset.add"]);

    f.setLayers([
      { name: "brain", type: "image", visible: true },
      { name: "labels", type: "segmentation", visible: false },
    ]);
    expect(empty.hidden).toBe(true);
    expect(dom.text(host.querySelector(".list")!)).toBe("brain (image) labels (segmentation)");
    expect(host.querySelector(".card-badge")!.textContent).toBe("1 of 2 shown");
  });

  it("updates in place: the count follows the state, but not while it is being typed", () => {
    const f = fakeContext();
    const host = dom.host();
    renderPanel(f.ctx, host);
    const count = host.querySelector<HTMLInputElement>("input")!;
    const cards = host.querySelectorAll("details");
    const add = dom.find<HTMLButtonElement>(host, "button", "Add one");
    add.click();
    expect(f.ctx.state.get()).toEqual({ count: 1 });
    expect(count.value).toBe("1");

    // Typing 7: an undo arriving meanwhile waits until the box is left.
    count.focus();
    count.value = "7";
    f.ctx.state.set({ count: 0 });
    expect(count.value).toBe("7");
    count.blur();
    expect(count.value).toBe("0");
    dom.type(count, "7");
    expect(f.ctx.state.get()).toEqual({ count: 7 });

    // The same elements throughout: nothing was drawn again.
    expect(host.querySelector("input")).toBe(count);
    expect(host.querySelectorAll("details")).toEqual(cards);
  });

  it("reports a failed copy as an error with Retry, and says nothing once it works", async () => {
    const f = fakeContext();
    f.setLayers([{ name: "brain", type: "image", visible: true }]);
    const host = dom.host();
    renderPanel(f.ctx, host);
    const status = host.querySelector<HTMLElement>(".status-line")!;
    expect(status.hidden).toBe(true);
    const writeText = vi.fn().mockRejectedValueOnce(new Error("not allowed")).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      dom.find(host, "button", "Copy the names").click();
      await vi.waitFor(() => expect(status.className).toBe("status-line error"));
      expect(dom.text(status)).toBe("Could not copy: not allowed Retry");
      status.querySelector("button")!.click();
      await vi.waitFor(() => expect(status.hidden).toBe(true));
      expect(writeText).toHaveBeenLastCalledWith("brain");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lets go of its listeners when the panel is disposed", async () => {
    const f = fakeContext();
    await plugin.activate(f.ctx);
    const render = f.panels.get("starter.panel")!;
    const dispose = render(dom.host());
    expect(f.listeners()).toBe(2);
    dispose?.();
    expect(f.listeners()).toBe(0);
    // A state change after disposal draws nothing and throws nothing.
    f.ctx.state.set({ count: 2 });
    f.setLayers([]);
  });
});
