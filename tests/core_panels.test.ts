/**
 * The core app's own panels on the shared parts: the Layers panel's list
 * (its tick boxes made with checkbox(), drawn again only when what it shows
 * changes, the keyboard kept on the control that had it, and its empty
 * state with an action), the Activity jobs of a runner with nothing to show,
 * and a panel that failed, with Retry; against the SDK's stand-in document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDom, fakeDocument } from "../src/sdk/testing.js";
import { renderDatasetsPanel } from "../src/ui/panels/datasets.js";
import { failedPanel } from "../src/ui/docks.js";
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
  };
  const off = () => () => {};
  const engine = {
    layers: () => [...layers.values()].map((l) => ({ ...l, type: "image", ready: true, sources: [`https://example.org/${l.name}`] })),
    selectedLayer: () => selected,
    onLayersChanged: off,
    onSelectionChanged: off,
  };
  const localData = { base: "https://app/", parse: () => undefined, list: () => [], restored: false, has: () => false, onChange: off };
  const offers = { list: () => [], onChange: off };
  const wb = { store, engine, localData, offers, run: vi.fn() } as unknown as Workbench;
  return { wb, store, changed, layers };
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
    expect(after.checked).toBe(false);
    expect(document.activeElement).toBe(after);
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
