// @vitest-environment dom
/**
 * The docks (src/ui/docks.ts) in a DOM: a tab's panel is made the first
 * time it is shown and stays mounted, a transient one is disposed when it
 * is hidden; the right and bottom docks start collapsed and showing a tab
 * opens its dock; the Tools dock picks its tab from a menu; a dock with no
 * tab is not there; a panel that fails shows Retry; what was open is kept
 * for the next visit.
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
  root.append(docks.element("left"), docks.element("right"), docks.element("bottom"));
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
  it("lays out three docks, the right and bottom ones collapsed to start with", () => {
    expect(docks.element("left").getAttribute("aria-label")).toBe("Layers");
    expect(docks.element("right").getAttribute("aria-label")).toBe("Tools");
    expect(docks.element("bottom").getAttribute("aria-label")).toBe("Activity");
    expect([docks.isCollapsed("left"), docks.isCollapsed("right"), docks.isCollapsed("bottom")]).toEqual([false, true, true]);
    expect(root.classList.contains("right-collapsed")).toBe(true);
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

describe("the Tools dock", () => {
  it("is not there with no tool, and picks its tool from a menu grouped by kind", () => {
    docks.addTab(tab("filtering", "right", { group: "Tractography" }).spec)();
    expect(docks.element("right").hidden).toBe(true);
    expect(root.classList.contains("right-empty")).toBe(true);
    docks.addTab(tab("filtering", "right", { group: "Tractography" }).spec);
    docks.addTab(tab("stats", "right", { group: "Measure" }).spec);
    expect(docks.element("right").hidden).toBe(false);
    const picker = docks.element("right").querySelector<HTMLButtonElement>(".dock-picker")!;
    expect(picker.getAttribute("aria-haspopup")).toBe("menu");
    expect(picker.textContent).toBe("Filtering");

    picker.click();
    const items = [...document.querySelectorAll<HTMLButtonElement>(".menu .menu-item")];
    expect(items.map((b) => b.textContent)).toEqual(["Tractography", "Filtering", "Measure", "Stats"]);
    expect(items[0].disabled).toBe(true);
    expect(items[1].getAttribute("aria-current")).toBe("true");
    items[3].click();
    expect(docks.isShowing("stats")).toBe(true);
    expect(docks.element("right").querySelector(".dock-picker")!.textContent).toBe("Stats");
  });

  it("hides a tool whose when-clause does not hold, choosing another", () => {
    docks.addTab(tab("filtering", "right", { when: "hasTracts" }).spec);
    docks.addTab(tab("stats", "right").spec);
    expect(docks.selected("right")).toBe("stats");
    const listed = () => {
      docks.element("right").querySelector<HTMLButtonElement>(".dock-picker")!.click();
      const titles = [...document.querySelectorAll(".menu .menu-item:not([disabled])")].map((b) => b.textContent);
      closeMenu();
      return titles;
    };
    expect(listed()).toEqual(["Stats"]);
    context.set("hasTracts", true);
    expect(listed()).toEqual(["Filtering", "Stats"]);
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

  it("collapses the side docks on a narrow screen", () => {
    docks.restore(true);
    expect([docks.isCollapsed("left"), docks.isCollapsed("right"), docks.isCollapsed("bottom")]).toEqual([true, true, true]);
  });
});
