// @vitest-environment dom
/**
 * The docks (src/ui/docks.ts) in a DOM: a tab's panel is made the first
 * time it is shown and stays mounted, a transient one is disposed when it
 * is hidden; the bottom dock starts collapsed and showing a tab opens its
 * dock; the Tools section, below the layers in the left column, lists the
 * tools that are on (and whose `when` holds for the data selected), is not
 * there with none, folds to its tabs, and opens with its column when a
 * tool is shown; a panel that fails shows Retry; what was open is kept for
 * the next visit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextKeys } from "../src/core/when.js";
import { DockManager, type DockTab } from "../src/ui/docks.js";
import { closeMenu } from "../src/ui/overlays.js";

let root: HTMLElement;
let context: ContextKeys;
let docks: DockManager;

beforeEach(() => {
  localStorage.clear();
  root = document.body.appendChild(document.createElement("div"));
  context = new ContextKeys();
  docks = new DockManager(root, context);
  // As the shell lays them out: the left column (layers, the Tools section's divider, the Tools section), then the bottom dock.
  const side = document.createElement("div");
  side.className = "side";
  side.append(docks.element("left"), docks.resizer("tools"), docks.element("tools"));
  root.append(side, docks.element("bottom"));
  docks.restore(false);
});
afterEach(() => {
  closeMenu();
  document.body.replaceChildren();
});

/** A tab whose panel counts its renders and disposals. */
function tab(id: string, slot: DockTab["slot"], extra: Partial<DockTab> = {}) {
  const counts = { renders: 0, disposals: 0 };
  const spec: DockTab = {
    id,
    title: id[0].toUpperCase() + id.slice(1),
    slot,
    render: (host) => {
      counts.renders++;
      host.append(Object.assign(document.createElement("p"), { textContent: `${id} panel` }));
      return () => counts.disposals++;
    },
    ...extra,
  };
  return { spec, counts };
}
const pane = (id: string) => root.querySelector<HTMLElement>(`.dock-pane[data-tab="${id}"]`)!;
const tabButton = (id: string) => root.querySelector<HTMLButtonElement>(`#tab-${id}`)!;

describe("mounting", () => {
  it("lays out three docks, the bottom one collapsed to its status line to start with", () => {
    expect(docks.element("left").getAttribute("aria-label")).toBe("Layers");
    expect(docks.element("tools").getAttribute("aria-label")).toBe("Tools");
    expect(docks.element("bottom").getAttribute("aria-label")).toBe("Activity");
    expect([docks.isCollapsed("left"), docks.isCollapsed("tools"), docks.isCollapsed("bottom")]).toEqual([false, false, true]);
    expect(root.classList.contains("bottom-collapsed")).toBe(true);
  });

  it("selects a dock's first tab and renders it once, keeping it mounted while another is shown", () => {
    const layers = tab("layers", "left", { order: 10 });
    const plugins = tab("plugins", "left", { order: 90 });
    docks.addTab(layers.spec);
    docks.addTab(plugins.spec);
    expect(docks.selected("left")).toBe("layers");
    expect(tabButton("layers").getAttribute("role")).toBe("tab");
    expect(tabButton("layers").getAttribute("aria-selected")).toBe("true");
    expect(pane("layers").hidden).toBe(false);
    expect(pane("layers").getAttribute("role")).toBe("tabpanel");
    expect(pane("layers").textContent).toBe("layers panel");
    expect(layers.counts.renders).toBe(1);
    expect(plugins.counts.renders).toBe(0);

    tabButton("plugins").click();
    expect(docks.selected("left")).toBe("plugins");
    expect(tabButton("layers").getAttribute("aria-selected")).toBe("false");
    expect(pane("layers").hidden).toBe(true);
    expect(plugins.counts.renders).toBe(1);
    tabButton("layers").click();
    expect(layers.counts).toEqual({ renders: 1, disposals: 0 });
  });

  it("orders the tabs by their order, whatever order they were added in", () => {
    docks.addTab(tab("plugins", "left", { order: 90 }).spec);
    docks.addTab(tab("layers", "left", { order: 10 }).spec);
    expect([...docks.element("left").querySelectorAll(".dock-tabs .tab")].map((b) => b.textContent)).toEqual(["Layers", "Plugins"]);
  });

  it("does not render a tab in a collapsed dock until the dock opens", () => {
    const activity = tab("activity", "bottom");
    docks.addTab(activity.spec);
    expect(docks.selected("bottom")).toBe("activity");
    expect(activity.counts.renders).toBe(0);
    docks.element("bottom").querySelector<HTMLButtonElement>(".dock-toggle")!.click();
    expect(docks.isCollapsed("bottom")).toBe(false);
    expect(activity.counts.renders).toBe(1);
  });

  it("disposes of a removed tab and selects the next", () => {
    const layers = tab("layers", "left", { order: 10 });
    const remove = docks.addTab(layers.spec);
    docks.addTab(tab("plugins", "left", { order: 90 }).spec);
    remove();
    expect(layers.counts.disposals).toBe(1);
    expect(pane("layers")).toBeNull();
    expect(docks.selected("left")).toBe("plugins");
    expect(() => docks.addTab(tab("plugins", "left").spec)).toThrow(/already exists/);
  });
});

describe("opening and closing", () => {
  it("show() opens a collapsed dock on the tab, and the toggle closes it again", () => {
    const activity = tab("activity", "bottom", { order: 10 });
    docks.addTab(activity.spec);
    docks.addTab(tab("python", "bottom", { order: 40 }).spec);
    docks.show("python");
    expect(docks.isCollapsed("bottom")).toBe(false);
    expect(docks.isShowing("python")).toBe(true);
    expect(pane("python").hidden).toBe(false);
    expect(pane("activity").hidden).toBe(true);
    // Opening the dock on python makes python's panel, not the one selected before.
    expect(activity.counts.renders).toBe(0);
    docks.toggle("bottom");
    expect(docks.isShowing("python")).toBe(false);
    expect(root.classList.contains("bottom-collapsed")).toBe(true);
  });

  it("disposes of a transient tab when another is chosen or its dock closes, and makes it again when shown", () => {
    docks.setCollapsed("bottom", false);
    const stats = tab("statistics", "bottom", { order: 10, transient: true });
    docks.addTab(stats.spec);
    docks.addTab(tab("python", "bottom", { order: 40 }).spec);
    expect(stats.counts).toEqual({ renders: 1, disposals: 0 });
    docks.show("python");
    expect(stats.counts).toEqual({ renders: 1, disposals: 1 });
    expect(pane("statistics").childElementCount).toBe(0);
    docks.show("statistics");
    expect(stats.counts.renders).toBe(2);
    docks.setCollapsed("bottom", true);
    expect(stats.counts.disposals).toBe(2);
  });

  it("tells listeners which tab was shown, and follows tabs that moved", () => {
    docks.addTab(tab("layers", "left").spec);
    const seen: string[] = [];
    docks.onSelect((id) => seen.push(id));
    const moved = vi.fn();
    docks.redirect("datasets", "layers");
    docks.redirect("auth", moved);
    docks.show("datasets");
    docks.show("auth");
    expect(seen).toEqual(["layers"]);
    expect(moved).toHaveBeenCalledOnce();
  });
});

describe("the Tools section", () => {
  const tools = () => [...docks.element("tools").querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const listed = () => tools().filter((b) => !b.hidden).map((b) => b.textContent);

  it("is not there with no tool, and shows its tools as tabs, grouped by kind", () => {
    docks.addTab(tab("filtering", "tools", { group: "Tractography" }).spec)();
    expect(docks.element("tools").hidden).toBe(true);
    expect(root.classList.contains("tools-empty")).toBe(true);
    docks.addTab(tab("filtering", "tools", { group: "Tractography" }).spec);
    docks.addTab(tab("stats", "tools", { group: "Measure" }).spec);
    docks.addTab(tab("tracks", "tools", { group: "Tractography" }).spec);
    expect(docks.element("tools").hidden).toBe(false);
    expect(root.classList.contains("tools-empty")).toBe(false);
    expect(docks.element("tools").querySelector('[role="tablist"]')).not.toBeNull();
    // The kinds together, in the order their first tool came.
    expect(tools().map((b) => b.textContent)).toEqual(["Filtering", "Tracks", "Stats"]);
    expect(tools()[0].getAttribute("aria-selected")).toBe("true");
    tools()[2].click();
    expect(docks.isShowing("stats")).toBe(true);
    expect(tools()[2].getAttribute("aria-selected")).toBe("true");
    expect(tools()[0].getAttribute("aria-selected")).toBe("false");
  });

  it("is below the layers, in the left column, with a divider between them", () => {
    const side = docks.element("left").parentElement!;
    expect([...side.children].map((e) => e.className.split(" ").slice(0, 2).join(" "))).toEqual(["dock dock-left", "resizer resizer-tools", "dock dock-tools"]);
    const divider = side.querySelector(".resizer-tools")!;
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.getAttribute("aria-orientation")).toBe("horizontal");
    expect(divider.getAttribute("aria-controls")).toBe("dock-tools");
  });

  it("takes a plugin's right-slot panel as a tool", () => {
    docks.addTab(tab("legacy", "right").spec);
    expect(docks.selected("tools")).toBe("legacy");
    expect(pane("legacy").closest(".dock-tools")).not.toBeNull();
  });

  it("lists the tools whose when-clause holds for the data selected, and goes back to the one chosen when it holds again", () => {
    docks.addTab(tab("filtering", "tools", { when: "datasetKind == tractogram" }).spec);
    docks.addTab(tab("stats", "tools").spec);
    expect(docks.selected("tools")).toBe("stats");
    expect(listed()).toEqual(["Stats"]);
    context.set("datasetKind", "tractogram");
    expect(listed()).toEqual(["Filtering", "Stats"]);
    docks.show("filtering");
    // An image selected: Filtering is not for it, so Stats is shown; the tractogram again: Filtering is back.
    context.set("datasetKind", "image");
    expect(listed()).toEqual(["Stats"]);
    expect(docks.selected("tools")).toBe("stats");
    context.set("datasetKind", "tractogram");
    expect(docks.selected("tools")).toBe("filtering");
  });

  it("is not there while no tool is for the data selected", () => {
    docks.addTab(tab("filtering", "tools", { when: "datasetKind == tractogram" }).spec);
    expect(docks.element("tools").hidden).toBe(true);
    context.set("datasetKind", "tractogram");
    expect(docks.element("tools").hidden).toBe(false);
    expect(docks.selected("tools")).toBe("filtering");
  });

  it("folds to its row of tabs, and a tab unfolds it", () => {
    const filtering = tab("filtering", "tools");
    docks.addTab(filtering.spec);
    docks.addTab(tab("stats", "tools").spec);
    const toggle = docks.element("tools").querySelector<HTMLButtonElement>(".dock-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(docks.isCollapsed("tools")).toBe(true);
    expect(root.classList.contains("tools-collapsed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(docks.isShowing("filtering")).toBe(false);
    tools()[1].click();
    expect(docks.isCollapsed("tools")).toBe(false);
    expect(docks.isShowing("stats")).toBe(true);
  });

  it("goes with its column: collapsed with it, and a tool shown opens both", () => {
    const stats = tab("stats", "tools", { transient: true });
    docks.addTab(stats.spec);
    expect(stats.counts.renders).toBe(1);
    docks.toggle("left");
    expect(docks.isShowing("stats")).toBe(false);
    // A transient tool stops its work while its column is shut, as its dock's own tab would.
    expect(stats.counts.disposals).toBe(1);
    docks.setCollapsed("tools", true);
    docks.show("stats");
    expect([docks.isCollapsed("left"), docks.isCollapsed("tools")]).toEqual([false, false]);
    expect(docks.isShowing("stats")).toBe(true);
    expect(stats.counts.renders).toBe(2);
  });

  it("does not render a tool while its column is collapsed", () => {
    docks.setCollapsed("left", true);
    const stats = tab("stats", "tools");
    docks.addTab(stats.spec);
    expect(stats.counts.renders).toBe(0);
    docks.setCollapsed("left", false);
    expect(stats.counts.renders).toBe(1);
  });
});

describe("a failed panel", () => {
  it("says what went wrong, with Retry, which makes the panel again", async () => {
    let fail = true;
    const spec: DockTab = {
      id: "layers",
      title: "Layers",
      slot: "left",
      render: async (host) => {
        if (fail) throw new Error("no store");
        host.textContent = "made";
        return () => {};
      },
    };
    docks.addTab(spec);
    await vi.waitFor(() => expect(pane("layers").textContent).toContain("This panel failed to load: no store"));
    const retry = [...pane("layers").querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    fail = false;
    retry.click();
    await vi.waitFor(() => expect(pane("layers").textContent).toBe("made"));
  });
});

describe("remembered", () => {
  it("keeps the dock opened for the next visit", () => {
    docks.addTab(tab("activity", "bottom").spec);
    docks.show("activity");
    const again = new DockManager(document.body.appendChild(document.createElement("div")), new ContextKeys());
    again.restore(false);
    expect(again.isCollapsed("bottom")).toBe(false);
  });

  it("keeps the tab shown for the next visit, whatever order the tabs are added in", () => {
    docks.addTab(tab("activity", "bottom", { order: 10 }).spec);
    docks.addTab(tab("python", "bottom", { order: 40 }).spec);
    docks.show("python");
    document.body.replaceChildren();

    const again = new DockManager(document.body.appendChild(document.createElement("div")), new ContextKeys());
    again.restore(false);
    again.addTab(tab("activity", "bottom", { order: 10 }).spec);
    again.addTab(tab("python", "bottom", { order: 40 }).spec);
    expect(again.selected("bottom")).toBe("python");
    expect(again.isCollapsed("bottom")).toBe(false);
  });

  it("keeps the Tools section's size and its fold for the next visit", () => {
    docks.addTab(tab("stats", "tools").spec);
    const divider = docks.element("tools").parentElement!.querySelector<HTMLElement>(".resizer-tools")!;
    root.style.setProperty("--tools", "300px");
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(root.style.getPropertyValue("--tools")).toBe("310px");
    docks.toggle("tools");
    const again = document.body.appendChild(document.createElement("div"));
    const next = new DockManager(again, new ContextKeys());
    next.restore(false);
    expect(again.style.getPropertyValue("--tools")).toBe("310px");
    expect(next.isCollapsed("tools")).toBe(true);
  });

  it("collapses the left column (and with it the tools) on a narrow screen", () => {
    docks.restore(true);
    expect([docks.isCollapsed("left"), docks.isCollapsed("tools"), docks.isCollapsed("bottom")]).toEqual([true, false, true]);
    docks.addTab(tab("stats", "tools").spec);
    expect(docks.isShowing("stats")).toBe(false);
  });
});
