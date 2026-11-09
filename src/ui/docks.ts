/**
 * The docks: named slots (left, right, bottom) holding tabs that the
 * platform and plugins contribute.  A tab renders the first time it is
 * shown and stays mounted (Neuroglancer widgets keep their state), unless it
 * is marked transient, in which case it is disposed whenever it is hidden.
 * The right dock (Tools) picks its tab from one grouped menu instead of a
 * row of tabs, and is not there while it has none.  Sizes, open tabs and
 * collapsed docks are remembered per browser; the right and bottom docks
 * start collapsed.
 */
import type { ContextKeys } from "../core/when.js";
import type { DockTabSpec } from "../platform/plugin_host.js";
import type { Disposer, DockSlot } from "../sdk/types.js";
import { h, icon } from "./dom.js";
import { showMenu } from "./overlays.js";

export const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`ngplatform.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`ngplatform.${key}`, value);
    } catch {
      // Storage refused (private window, sandbox): the setting just is not kept.
    }
  },
};

export interface DockTab extends DockTabSpec {
  /** Disposed when hidden, rendered again when shown (e.g. polling views). */
  transient?: boolean;
  /** The heading it is listed under in a dock with a menu (the Tools dock). */
  group?: string;
}

interface Mounted {
  tab: DockTab;
  button: HTMLButtonElement;
  host: HTMLElement;
  rendered: boolean;
  dispose?: Disposer;
}

const TITLES: Record<DockSlot, string> = { left: "Layers", right: "Tools", bottom: "Activity" };
const DEFAULT_SIZE: Record<DockSlot, string> = { left: "300px", right: "360px", bottom: "190px" };
/** Collapsed until the person opens them. */
const START_COLLAPSED: Record<DockSlot, boolean> = { left: false, right: true, bottom: true };

class Dock {
  readonly el: HTMLElement;
  readonly head = h("div", { class: "dock-head", role: "tablist" });
  readonly tabsEl = h("div", { class: "dock-tabs" });
  readonly body = h("div", { class: "dock-body" });
  readonly tabs = new Map<string, Mounted>();
  selected: string | undefined;
  /** The Tools dock: one button naming the tab shown, whose menu lists them all by group. */
  readonly menu: boolean;

  constructor(
    readonly slot: DockSlot,
    private readonly manager: DockManager,
  ) {
    this.menu = slot === "right";
    this.el = h("aside", { class: `dock dock-${slot}`, "aria-label": TITLES[slot] });
    const toggle = h(
      "button",
      {
        class: "btn icon dock-toggle",
        type: "button",
        title: `Show or hide the ${TITLES[slot].toLowerCase()} dock`,
        "aria-label": `Toggle ${TITLES[slot].toLowerCase()} dock`,
        onclick: () => manager.toggle(slot),
      },
      icon(slot === "left" ? "panel-left" : slot === "right" ? "panel-right" : "panel-bottom"),
    );
    const rail = h("span", { class: "rail-title" }, TITLES[slot]);
    if (slot === "left") this.head.append(toggle, this.tabsEl, rail);
    else this.head.append(this.tabsEl, rail, toggle);
    this.el.append(this.head, this.body);
  }

  ordered(): Mounted[] {
    return [...this.tabs.values()].sort((a, b) => (a.tab.order ?? 100) - (b.tab.order ?? 100));
  }

  layoutTabs(): void {
    if (!this.menu) {
      this.tabsEl.replaceChildren(...this.ordered().map((m) => m.button));
      return;
    }
    const shown = this.selected !== undefined ? this.tabs.get(this.selected) : undefined;
    const picker = h(
      "button",
      { class: "tab dock-picker", type: "button", "aria-haspopup": "menu", "aria-selected": "true", title: "Choose a tool" },
      shown?.tab.title ?? "Tools",
      icon("chevron-down"),
    );
    picker.addEventListener("click", () => {
      const groups = new Map<string, Mounted[]>();
      for (const m of this.visibleTabs()) groups.set(m.tab.group ?? "Other", [...(groups.get(m.tab.group ?? "Other") ?? []), m]);
      showMenu(
        picker,
        [...groups].flatMap(([group, tabs], i) => [
          ...(i > 0 ? (["-"] as const) : []),
          { label: group, muted: true, disabled: true, run: () => {} },
          ...tabs.map((m) => ({ label: m.tab.title, current: m.tab.id === this.selected, run: () => this.manager.show(m.tab.id) })),
        ]),
      );
    });
    this.tabsEl.replaceChildren(picker);
  }

  visibleTabs(): Mounted[] {
    return this.ordered().filter((m) => !m.button.hidden);
  }
}

export class DockManager {
  private readonly docks: Record<DockSlot, Dock>;
  private readonly bySlotOf = new Map<string, DockSlot>();
  private readonly listeners = new Set<(id: string) => void>();
  /** Tabs that moved (Datasets into Layers, Auth into Settings): what showing one does now. */
  private readonly redirects = new Map<string, () => void>();

  constructor(
    private readonly root: HTMLElement,
    private readonly context: ContextKeys,
  ) {
    this.docks = { left: new Dock("left", this), right: new Dock("right", this), bottom: new Dock("bottom", this) };
    context.onChange(() => this.applyWhen());
  }

  element(slot: DockSlot): HTMLElement {
    return this.docks[slot].el;
  }

  /** What `show(id)` does for a tab that is no longer one: another tab's id (merged into it), or something to do. */
  redirect(id: string, to: string | (() => void)): void {
    if (typeof to === "string") this.aliases.set(id, to);
    else this.redirects.set(id, to);
  }

  private readonly aliases = new Map<string, string>();

  private alias(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  /** An element in a dock's head, after its tabs (the bottom dock's status line). */
  addToHead(slot: DockSlot, element: HTMLElement): void {
    const dock = this.docks[slot];
    dock.head.insertBefore(element, dock.tabsEl.nextSibling);
  }

  /** A dock with no tab to show is not there at all (the Tools dock with no tool on). */
  private applyEmpty(): void {
    for (const dock of Object.values(this.docks)) {
      const empty = dock.visibleTabs().length === 0;
      dock.el.hidden = empty;
      this.root.classList.toggle(`${dock.slot}-empty`, empty);
    }
  }

  addTab(tab: DockTab): Disposer {
    const dock = this.docks[tab.slot];
    if (this.bySlotOf.has(tab.id)) throw new Error(`dock tab ${tab.id} already exists`);
    const host = h("div", { class: "dock-pane", "data-tab": tab.id, role: "tabpanel", "aria-label": tab.title, hidden: true });
    const button = h(
      "button",
      { class: "tab", type: "button", role: "tab", id: `tab-${tab.id}`, "aria-selected": "false", onclick: () => this.show(tab.id) },
      tab.title,
    );
    const mounted: Mounted = { tab, button, host, rendered: false };
    dock.tabs.set(tab.id, mounted);
    this.bySlotOf.set(tab.id, tab.slot);
    dock.body.append(host);
    dock.layoutTabs();
    this.applyWhen();
    const remembered = prefs.get(`${tab.slot}.tab`);
    if (dock.selected === undefined || remembered === tab.id) this.select(tab.slot, tab.id);
    return () => this.removeTab(tab.id);
  }

  private removeTab(id: string): void {
    const slot = this.bySlotOf.get(id);
    if (slot === undefined) return;
    const dock = this.docks[slot];
    const mounted = dock.tabs.get(id)!;
    this.unrender(mounted);
    mounted.host.remove();
    dock.tabs.delete(id);
    this.bySlotOf.delete(id);
    dock.layoutTabs();
    if (dock.selected === id) {
      dock.selected = undefined;
      const next = dock.visibleTabs()[0];
      if (next !== undefined) this.select(slot, next.tab.id);
    }
    this.applyEmpty();
  }

  private unrender(mounted: Mounted): void {
    if (!mounted.rendered) return;
    try {
      mounted.dispose?.();
    } catch (e) {
      console.error(e);
    }
    mounted.dispose = undefined;
    mounted.rendered = false;
    mounted.host.replaceChildren();
  }

  private render(mounted: Mounted): void {
    if (mounted.rendered) return;
    mounted.rendered = true;
    try {
      const result = mounted.tab.render(mounted.host);
      if (result instanceof Promise) {
        result.then(
          (d) => {
            if (typeof d === "function") {
              if (mounted.rendered) mounted.dispose = d;
              else d();
            }
          },
          (e) => {
            mounted.host.replaceChildren(h("p", { class: "empty error" }, `This panel failed to load: ${(e as Error).message}`));
          },
        );
      } else if (typeof result === "function") {
        mounted.dispose = result;
      }
    } catch (e) {
      mounted.host.replaceChildren(h("p", { class: "empty error" }, `This panel failed: ${(e as Error).message}`));
    }
  }

  private select(slot: DockSlot, id: string): void {
    const dock = this.docks[slot];
    const mounted = dock.tabs.get(id);
    if (mounted === undefined) return;
    const previous = dock.selected !== undefined ? dock.tabs.get(dock.selected) : undefined;
    if (previous !== undefined && previous !== mounted) {
      previous.host.hidden = true;
      previous.button.setAttribute("aria-selected", "false");
      if (previous.tab.transient) this.unrender(previous);
    }
    dock.selected = id;
    mounted.button.setAttribute("aria-selected", "true");
    mounted.host.hidden = false;
    if (dock.menu) dock.layoutTabs();
    if (!dock.el.classList.contains("collapsed")) this.render(mounted);
    prefs.set(`${slot}.tab`, id);
    for (const listener of this.listeners) listener(id);
  }

  /** Shows a tab: selects it and opens its dock. */
  show(id: string): void {
    const redirect = this.redirects.get(id);
    if (redirect !== undefined) return redirect();
    id = this.alias(id);
    const slot = this.bySlotOf.get(id);
    if (slot === undefined) return;
    this.setCollapsed(slot, false);
    this.select(slot, id);
    // A panel that needs room grows its dock for now; the size the person set stays saved.
    const min = this.docks[slot].tabs.get(id)?.tab.minSize;
    if (min !== undefined) {
      const rect = this.docks[slot].el.getBoundingClientRect();
      const now = slot === "bottom" ? rect.height : rect.width;
      const limit = slot === "bottom" ? window.innerHeight * 0.6 : window.innerWidth * 0.5;
      if (now > 0 && now < min) this.root.style.setProperty(`--${slot}`, `${Math.round(Math.min(min, limit))}px`);
    }
  }

  selected(slot: DockSlot): string | undefined {
    return this.docks[slot].selected;
  }

  isShowing(id: string): boolean {
    const slot = this.bySlotOf.get(this.alias(id));
    return slot !== undefined && this.docks[slot].selected === id && !this.docks[slot].el.classList.contains("collapsed");
  }

  onSelect(listener: (id: string) => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applyWhen(): void {
    for (const dock of Object.values(this.docks)) {
      for (const m of dock.tabs.values()) m.button.hidden = !this.context.matches(m.tab.when);
      if (dock.selected !== undefined && dock.tabs.get(dock.selected)?.button.hidden) {
        const next = dock.visibleTabs()[0];
        if (next !== undefined) this.select(dock.slot, next.tab.id);
      }
      if (dock.menu) dock.layoutTabs();
    }
    this.applyEmpty();
  }

  // ------------------------------------------------------------- sizing

  isCollapsed(slot: DockSlot): boolean {
    return this.docks[slot].el.classList.contains("collapsed");
  }

  setCollapsed(slot: DockSlot, collapsed: boolean, remember = true): void {
    const dock = this.docks[slot];
    dock.el.classList.toggle("collapsed", collapsed);
    this.root.classList.toggle(`${slot}-collapsed`, collapsed);
    if (!collapsed && dock.selected !== undefined) this.render(dock.tabs.get(dock.selected)!);
    // A transient tab (Chunk statistics) stops its work while its dock is shut, as when another tab is chosen.
    const shown = dock.selected !== undefined ? dock.tabs.get(dock.selected) : undefined;
    if (collapsed && shown?.tab.transient) this.unrender(shown);
    if (remember) prefs.set(`${slot}.collapsed`, collapsed ? "1" : "0");
  }

  toggle(slot: DockSlot): void {
    this.setCollapsed(slot, !this.isCollapsed(slot));
  }

  /** Restores remembered sizes and collapsed docks. */
  restore(narrow: boolean): void {
    for (const slot of ["left", "right", "bottom"] as const) {
      this.root.style.setProperty(`--${slot}`, prefs.get(`${slot}.size`) || DEFAULT_SIZE[slot]);
      const kept = prefs.get(`${slot}.collapsed`);
      const collapsed = (kept === null ? START_COLLAPSED[slot] : kept === "1") || (narrow && slot !== "bottom");
      this.setCollapsed(slot, collapsed, false);
    }
  }

  /** A drag handle that resizes `slot`. */
  resizer(slot: DockSlot): HTMLElement {
    const vertical = slot === "bottom";
    const el = h("div", {
      class: `resizer resizer-${slot}`,
      role: "separator",
      "aria-orientation": vertical ? "horizontal" : "vertical",
      title: "Drag to resize",
    });
    el.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      el.setPointerCapture(down.pointerId);
      el.classList.add("dragging");
      const start = vertical ? down.clientY : down.clientX;
      const rect = this.docks[slot].el.getBoundingClientRect();
      const startSize = vertical ? rect.height : rect.width;
      const move = (e: PointerEvent) => {
        const now = vertical ? e.clientY : e.clientX;
        const delta = slot === "left" ? now - start : start - now;
        const limit = vertical ? window.innerHeight * 0.6 : window.innerWidth * (window.innerWidth <= 760 ? 0.34 : 0.5);
        const size = Math.max(vertical ? 90 : 160, Math.min(limit, startSize + delta));
        this.root.style.setProperty(`--${slot}`, `${Math.round(size)}px`);
      };
      const up = () => {
        el.classList.remove("dragging");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        prefs.set(`${slot}.size`, this.root.style.getPropertyValue(`--${slot}`));
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
    return el;
  }
}
