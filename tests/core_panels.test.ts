/**
 * The core app's own panels on the shared parts: the Layers panel's list
 * (its tick boxes made with checkbox(), drawn again only when what it shows
 * changes, the keyboard kept on the control that had it, its empty state
 * with an action, and each dataset's card opening on its settings), the Activity jobs of a runner with nothing to show,
 * and a panel that failed, with Retry; against the SDK's stand-in document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDom, fakeDocument } from "../src/sdk/testing.js";
import { renderDatasetsPanel } from "../src/ui/panels/datasets.js";
import { failedPanel, renderPanel } from "../src/ui/docks.js";
import { renderRunnerSection } from "../src/ui/runner.js";
import type { Workbench } from "../src/ui/workbench.js";

let dom: FakeDom;
beforeEach(() => {
  dom = fakeDocument();
});
afterEach(() => dom.restore());

interface FakeLayer {
  name: string;
  visible: boolean;
}

/** Just enough of the workbench for the list: a scene of datasets, each shown through its layers. */
function fakeWorkbench(datasets: { id: string; name: string; layers: string[] }[]) {
  const layers = new Map<string, FakeLayer>(datasets.flatMap((d) => d.layers.map((name) => [name, { name, visible: true }] as const)));
  const listeners = new Set<() => void>();
  let selected: string | undefined;
  const changed = () => listeners.forEach((l) => l());
  const store = {
    sceneDatasets: () => datasets.map((d) => ({ dataset: { id: d.id, name: d.name, source: `https://example.org/${d.id}`, kind: "image" }, layers: d.layers })),
    dataset: (id: string) => datasets.find((d) => d.id === id),
    onChange: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    setDatasetVisible: vi.fn((id: string, visible: boolean) => {
      for (const name of datasets.find((d) => d.id === id)!.layers) layers.get(name)!.visible = visible;
      changed();
    }),
    selectDataset: vi.fn((id: string) => {
      selected = datasets.find((d) => d.id === id)!.layers[0];
      changed();
    }),
    setLayerVisible: vi.fn(),
    selectLayer: vi.fn(),
    ng: () => ({ layers: [] }),
  };
  const off = () => () => {};
  /** Each layer's settings mounted (in a card), and let go. */
  const unmount = vi.fn();
  const engine = {
    layers: () => [...layers.values()].map((l) => ({ ...l, type: "image", ready: true, sources: [`https://example.org/${l.name}`] })),
    selectedLayer: () => selected,
    onLayersChanged: off,
    onSelectionChanged: off,
    layerToken: (name: string) => layers.get(name),
    layerSpec: () => undefined,
    mountLayerControls: vi.fn((host: HTMLElement, name: string) => {
      host.append(Object.assign(document.createElement("div"), { className: "settings", textContent: name }));
      return unmount;
    }),
  };
  const localData = { base: "https://app/", parse: () => undefined, list: () => [], restored: false, has: () => false, onChange: off };
  const offers = { list: () => [], onChange: off };
  const signIns = { rules: { list: () => [] }, google: { accounts: () => [], defaultAccount: () => undefined }, auth: { list: () => [], sourceSignIns: () => [] } };
  const wb = { store, engine, localData, offers, run: vi.fn(), ...signIns } as unknown as Workbench;
  return { wb, store, changed, layers, engine, unmount };
}

describe("Layers panel: the list", () => {
  it("shows or hides a dataset with an SDK checkbox, without selecting its row", () => {
    const { wb, store } = fakeWorkbench([{ id: "a", name: "brain", layers: ["brain"] }]);
    const host = dom.host();
    renderDatasetsPanel(host, wb);
    const box = dom.find<HTMLInputElement>(host, "input");
    // checkbox(): a plain tick box in label.choice, named for the dataset.
    expect(box.parentNode).toBe(host.querySelector("label"));
    expect(host.querySelector("label")!.className).toBe("choice");
    expect(box.className).toBe("");
    expect(box.getAttribute("aria-label")).toBe("Show brain");
    expect(box.checked).toBe(true);
    dom.check(box, false);
    expect(store.setDatasetVisible).toHaveBeenCalledWith("a", false);
    box.click();
    expect(store.selectDataset).not.toHaveBeenCalled();
  });

  it("is drawn again only when what it shows changes, and keeps the keyboard on the control that had it", () => {
    const { wb, changed } = fakeWorkbench([
      { id: "a", name: "brain", layers: ["brain"] },
      { id: "b", name: "tracts", layers: ["tracts"] },
    ]);
    const host = dom.host();
    renderDatasetsPanel(host, wb);
    const before = host.querySelectorAll("input");
    // A change elsewhere (the views moved): the same rows.
    changed();
    expect(host.querySelectorAll("input")[1]).toBe(before[1]);
    // Hidden from the keyboard: the list is drawn again, and the new tick box has the keyboard.
    before[1].focus();
    dom.check(before[1], false);
    const after = host.querySelectorAll("input")[1];
    expect(after).not.toBe(before[1]);
    // Only that dataset's row: the other is kept.
    expect(host.querySelectorAll("input")[0]).toBe(before[0]);
    expect(after.checked).toBe(false);
    expect(document.activeElement).toBe(after);
  });

  it("with 200 datasets, a settle replaces no row and a change to one dataset draws only its row again", () => {
    const datasets = Array.from({ length: 200 }, (_, i) => ({ id: `d${i}`, name: `data ${i}`, layers: [`layer ${i}`] }));
    const { wb, changed, layers } = fakeWorkbench(datasets);
    const host = dom.host();
    renderDatasetsPanel(host, wb);
    const list = host.querySelector(".datasets")!;
    const rowsOf = () => [...list.querySelectorAll<HTMLElement>(".ds-row")];
    const before = rowsOf();
    expect(before).toHaveLength(200);
    // Counts the rows put into the list from here on.
    let inserted = 0;
    const insertBefore = list.insertBefore.bind(list);
    list.insertBefore = ((node: Node, ref: Node | null) => (++inserted, insertBefore(node, ref))) as typeof list.insertBefore;
    // A settle after the views moved: nothing the list shows changed.
    changed();
    expect(inserted).toBe(0);
    expect(rowsOf().every((r, i) => r === before[i])).toBe(true);
    // Dataset 57 hidden: its row alone is drawn again, in its place in its card (the card stays where it is).
    layers.get("layer 57")!.visible = false;
    changed();
    const after = rowsOf();
    expect(inserted).toBe(0);
    expect(after.filter((r, i) => r !== before[i])).toEqual([after[57]]);
    expect(dom.find<HTMLInputElement>(after[57], "input").checked).toBe(false);
  });

  it("keeps rows when datasets move or go, and draws a new one alone", () => {
    const datasets = [
      { id: "a", name: "brain", layers: ["brain"] },
      { id: "b", name: "tracts", layers: ["tracts"] },
      { id: "c", name: "labels", layers: ["labels"] },
    ];
    const { wb, changed } = fakeWorkbench(datasets);
    const host = dom.host();
    renderDatasetsPanel(host, wb);
    const rowsOf = () => [...host.querySelectorAll<HTMLElement>(".ds-row")];
    const [a, b, c] = rowsOf();
    datasets.reverse();
    changed();
    expect(rowsOf()).toEqual([c, b, a]);
    datasets.splice(1, 1);
    datasets.push({ id: "d", name: "mesh", layers: ["mesh"] });
    changed();
    const now = rowsOf();
    expect(now.slice(0, 2)).toEqual([c, a]);
    expect(dom.text(now[2])).toContain("mesh");
    // All gone: the empty state, and back.
    datasets.length = 0;
    changed();
    expect(host.querySelector(".empty-state")).not.toBeNull();
    datasets.push({ id: "a", name: "brain", layers: ["brain"] });
    changed();
    expect(host.querySelector(".empty-state")).toBeNull();
    expect(rowsOf()).toHaveLength(1);
  });

  it("opens a dataset's card on its settings when it is selected; its arrow closes and opens it, and several may be open", () => {
    const { wb, changed, engine, unmount } = fakeWorkbench([
      { id: "a", name: "brain", layers: ["brain"] },
      { id: "b", name: "tracts", layers: ["tracts"] },
    ]);
    const host = dom.host();
    renderDatasetsPanel(host, wb);
    const cards = () => host.querySelectorAll(".ds-card");
    const open = () => [...cards()].filter((c) => c.className.split(" ").includes("open")).flatMap((c) => [...c.querySelectorAll(".settings")].map((e) => e.textContent));
    expect(open()).toEqual([]);
    // Selected (a click on its row): its card opens on the layer's settings.
    host.querySelectorAll<HTMLElement>(".ds-row")[0].click();
    expect(open()).toEqual(["brain"]);
    expect(engine.mountLayerControls).toHaveBeenCalledTimes(1);
    // A change elsewhere: the settings stay as they are, mounted once.
    changed();
    expect(engine.mountLayerControls).toHaveBeenCalledTimes(1);
    // The other's arrow opens it too, without selecting it.
    dom.find<HTMLElement>(cards()[1], "button.ds-expand").click();
    expect(open()).toEqual(["brain", "tracts"]);
    // The first's arrow closes it: its settings let go.
    dom.find<HTMLElement>(cards()[0], "button.ds-expand").click();
    expect(open()).toEqual(["tracts"]);
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(dom.find<HTMLElement>(cards()[0], "button.ds-expand").getAttribute("aria-expanded")).toBe("false");
  });

  it("says when the scene has no data, with the action that adds some", () => {
    const { wb } = fakeWorkbench([]);
    const host = dom.host();
    renderDatasetsPanel(host, wb);
    expect(dom.text(host.querySelector(".empty-state")!)).toBe("No data in this scene. Add data…");
    expect(dom.find(host.querySelector(".empty-state")!, "button", "Add data…")).toBeTruthy();
  });
});

describe("Activity: a runner's jobs", () => {
  it("with none, says so with the action that starts one, in place of its button above", () => {
    const runner = {
      connection: () => "connected",
      info: () => ({ version: "1", address: "http://127.0.0.1:8765", pid: 1, roots: ["/data"], tools: "1" }),
      pairing: () => ({ address: "http://127.0.0.1:8765", token: "t" }),
      jobs: () => [],
      onChange: () => () => {},
      watch: () => () => {},
      client: () => undefined,
    };
    const wb = { hosts: { info: () => undefined, onChange: () => () => {} } } as unknown as Workbench;
    const section = renderRunnerSection(wb, runner as never, "This computer", "jobs");
    dom.host().append(section.element);
    expect(dom.text(section.element.querySelector(".empty-state")!)).toBe("No jobs on this computer. Convert a tractogram…");
    expect(section.element.querySelector<HTMLElement>(".runner-convert")!.hidden).toBe(true);
    section.dispose();
  });
});

describe("Docks: a panel that failed", () => {
  it("says what went wrong, as an error, with Retry", () => {
    const retry = vi.fn();
    const shown = failedPanel("This panel failed: boom", retry);
    expect(shown.querySelector(".empty")!.className).toBe("empty error");
    dom.find(shown, "button", "Retry").click();
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("Docks: a panel rendered while an earlier render is still loading", () => {
  it("disposes of the earlier one when it finishes, and keeps the later one", async () => {
    const loads: ((d: () => void) => void)[] = [];
    const disposers = [vi.fn(), vi.fn()];
    const mounted = {
      tab: { id: "t", title: "T", slot: "right", render: () => new Promise<() => void>((resolve) => loads.push(resolve)) },
      host: {} as HTMLElement,
      rendered: false,
      renders: 0,
      dispose: undefined as (() => void) | undefined,
    };
    const failed = vi.fn();
    renderPanel(mounted as never, failed);
    // Hidden (a transient tab) and shown again before the first render finished.
    mounted.rendered = false;
    renderPanel(mounted as never, failed);
    // The later render finishes first, then the earlier one.
    loads[1](disposers[1]);
    await Promise.resolve();
    loads[0](disposers[0]);
    await Promise.resolve();
    expect(mounted.dispose).toBe(disposers[1]);
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(disposers[1]).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});
