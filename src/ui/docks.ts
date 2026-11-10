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
import { emptyState, type Roving, roving } from "../sdk/dom.js";
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
}

/**
 * Where a plugin's panel goes, TypeScript or Python: one in the left slot
 * is a tool, so it goes to the Tools dock under its group (`fallback` when
 * it names none); the bottom slot keeps its own.
 */
export function asTool<T extends DockTab>(tab: T, fallback = "Other"): T {
  return tab.slot === "left" || tab.slot === "right" ? { ...tab, slot: "right", group: tab.group ?? fallback } : tab;
}

interface Mounted {
  tab: DockTab;
  button: HTMLButtonElement;
  host: HTMLElement;
  rendered: boolean;
  dispose?: Disposer;
  /** Counts the renders, so a slow render that a later one overtook disposes of itself. */
  renders: number;
}

/** What a panel that failed shows: what went wrong, and Retry. */
export function failedPanel(message: string, retry: () => void): HTMLElement {
  const shown = emptyState(message, { label: "Retry", run: retry });
  const text = shown.querySelector(".empty");
  if (text !== null) text.className = "empty error";
  return shown;
}

/**
 * Renders a mounted tab's panel, once: the disposer it gives is kept, or
 * called at once when the panel was hidden, or rendered again, before a
 * slow render finished (so two renders in flight never leak one).
 * `failed` shows why it failed.
 */
export function renderPanel(
  mounted: Pick<Mounted, "tab" | "host" | "rendered" | "dispose" | "renders">,
  failed: (message: string) => void,
): void {
  if (mounted.rendered) return;
  mounted.rendered = true;
  // A render still loading when the panel was hidden and shown again is no longer the panel's.
  const render = ++mounted.renders;
  const current = () => mounted.rendered && mounted.renders === render;
  try {
    const result = mounted.tab.render(mounted.host);
    if (result instanceof Promise) {
      result.then(
        (d) => {
          if (typeof d === "function") {
            if (current()) mounted.dispose = d;
            else d();
          }
        },
        (e) => {
          if (current()) failed(`This panel failed to load: ${(e as Error).message}`);
        },
      );
    } else if (typeof result === "function") {
      mounted.dispose = result;
    }
  } catch (e) {
    failed(`This panel failed: ${(e as Error).message}`);
  }
}

const TITLES: Record<DockSlot, string> = { left: "Layers", right: "Tools", bottom: "Activity" };
const DEFAULT_SIZE: Record<DockSlot, string> = { left: "300px", right: "360px", bottom: "190px" };
/** Collapsed until the person opens them. */
const START_COLLAPSED: Record<DockSlot, boolean> = { left: false, right: true, bottom: true };

/**
 * Follows a drag on `target` until it ends, however it ends: let go, or
 * taken away (a touch the browser takes for a scroll, a lost capture), so a
 * handle is never left stuck to the pointer.  `end` runs once.
 */
export function followDrag(target: HTMLElement | Window, move: (e: PointerEvent) => void, end: () => void): void {
  const onMove = (e: Event) => move(e as PointerEvent);
  const stops = ["pointerup", "pointercancel", "lostpointercapture"];
  const stop = () => {
    target.removeEventListener("pointermove", onMove);
    for (const type of stops) target.removeEventListener(type, stop);
    end();
  };
  target.addEventListener("pointermove", onMove);
  for (const type of stops) target.addEventListener(type, stop);
}

/** A separator's position, for a screen reader: its value now and its range. */
export function describeSize(handle: HTMLElement, now: number, min: number, max: number): void {
  handle.setAttribute("aria-valuenow", String(Math.round(now)));
  handle.setAttribute("aria-valuemin", String(Math.round(min)));
  handle.setAttribute("aria-valuemax", String(Math.round(max)));
}

class Dock {
  readonly el: HTMLElement;
  readonly head = h("div", { class: "dock-head" });
  readonly tabsEl = h("div", { class: "dock-tabs" });
  /** Left and Right move between the tabs (the Tools dock's one picker has its own keys). */
  readonly keys: Roving;
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
    this.el = h("aside", { class: `dock dock-${slot}`, id: `dock-${slot}`, "aria-label": TITLES[slot] });
    if (!this.menu) {
      this.tabsEl.setAttribute("role", "tablist");
      this.tabsEl.setAttribute("aria-label", TITLES[slot]);
    }
    this.keys = roving(this.tabsEl, {
      items: () => (this.menu ? [] : this.ordered().map((m) => m.button)),
      orientation: "horizontal",
      tabStop: true,
      current: () => (this.selected !== undefined ? this.tabs.get(this.selected)?.button : undefined),
      onMove: (button) => button.click(),
    });
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
      this.keys.sync();
      return;
    }
    const shown = this.selected !== undefined ? this.tabs.get(this.selected) : undefined;
    const picker = h(
      "button",
      { class: "tab dock-picker", type: "button", "aria-haspopup": "menu", title: "Choose a tool", "aria-label": `Tool: ${shown?.tab.title ?? "none"}. Choose a tool` },
      shown?.tab.title ?? "Tools",
      icon("chevron-down"),
    );
    const open = () => {
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
    };
    picker.addEventListener("click", open);
    // Down or Up opens the menu too, as on any menu button.
    picker.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      open();
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

  /** An element in a dock's head, after its tabs (the Activity dock's status line). */
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
    // A tab panel named by its tab; the Tools dock has a picker, not tabs, so its panels are regions named by their titles.
    const host = h("div", {
      class: "dock-pane",
      "data-tab": tab.id,
      id: `pane-${tab.id}`,
      role: dock.menu ? "region" : "tabpanel",
      "aria-labelledby": dock.menu ? undefined : `tab-${tab.id}`,
      "aria-label": dock.menu ? tab.title : undefined,
      hidden: true,
    });
    const button = h(
      "button",
      { class: "tab", type: "button", role: "tab", id: `tab-${tab.id}`, "aria-selected": "false", "aria-controls": `pane-${tab.id}`, onclick: () => this.show(tab.id) },
      tab.title,
    );
    const mounted: Mounted = { tab, button, host, rendered: false, renders: 0 };
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

  /** Shows that a panel failed, with Retry, which makes it again. */
  private failed(mounted: Mounted, message: string): void {
    mounted.host.replaceChildren(
      failedPanel(message, () => {
        this.unrender(mounted);
        this.render(mounted);
      }),
    );
  }

  private render(mounted: Mounted): void {
    renderPanel(mounted, (message) => this.failed(mounted, message));
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
    dock.keys.sync();
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

  /** The smallest and largest a dock may be, in pixels, in this window. */
  private limits(slot: DockSlot): [number, number] {
    if (slot === "bottom") return [90, window.innerHeight * 0.6];
    return [160, window.innerWidth * (window.innerWidth <= 760 ? 0.34 : 0.5)];
  }

  /** Sets a dock's size (within its limits) and says so on its resizer; returns the size set. */
  private resize(slot: DockSlot, size: number, handle: HTMLElement): number {
    const [min, max] = this.limits(slot);
    const px = Math.round(Math.max(min, Math.min(max, size)));
    this.root.style.setProperty(`--${slot}`, `${px}px`);
    describeSize(handle, px, min, max);
    return px;
  }

  /** The size a dock is now: as drawn, or as set. */
  private sizeOf(slot: DockSlot): number {
    const rect = this.docks[slot].el.getBoundingClientRect();
    const drawn = slot === "bottom" ? rect.height : rect.width;
    return drawn > 0 ? drawn : parseFloat(this.root.style.getPropertyValue(`--${slot}`)) || parseFloat(DEFAULT_SIZE[slot]);
  }

  /**
   * A handle that resizes `slot`: dragged, or with the keyboard, as a
   * separator a screen reader reads with its size.  The arrows move it 10
   * px (40 with Shift), Home and End to the smallest and largest.  The size
   * is kept when a drag ends, or at each key.
   */
  resizer(slot: DockSlot): HTMLElement {
    const vertical = slot === "bottom";
    const el = h("div", {
      class: `resizer resizer-${slot}`,
      role: "separator",
      tabindex: 0,
      "aria-orientation": vertical ? "horizontal" : "vertical",
      "aria-label": `Resize the ${TITLES[slot]} dock`,
      "aria-controls": `dock-${slot}`,
      title: "Drag to resize",
    });
    describeSize(el, this.sizeOf(slot), ...this.limits(slot));
    const keep = () => prefs.set(`${slot}.size`, this.root.style.getPropertyValue(`--${slot}`));
    // Which way grows the dock: right for the left dock, left for the right, up for the bottom.
    const grow = slot === "left" ? "ArrowRight" : slot === "right" ? "ArrowLeft" : "ArrowUp";
    const shrink = slot === "left" ? "ArrowLeft" : slot === "right" ? "ArrowRight" : "ArrowDown";
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 40 : 10;
      const [min, max] = this.limits(slot);
      const now = this.sizeOf(slot);
      const size = e.key === grow ? now + step : e.key === shrink ? now - step : e.key === "Home" ? min : e.key === "End" ? max : undefined;
      if (size === undefined) return;
      e.preventDefault();
      this.resize(slot, size, el);
      keep();
    });
    el.addEventListener("focus", () => describeSize(el, Math.round(this.sizeOf(slot)), ...this.limits(slot)));
    el.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      el.setPointerCapture?.(down.pointerId);
      el.classList.add("dragging");
      const start = vertical ? down.clientY : down.clientX;
      const startSize = this.sizeOf(slot);
      followDrag(
        el,
        (e) => {
          const now = vertical ? e.clientY : e.clientX;
          this.resize(slot, startSize + (slot === "left" ? now - start : start - now), el);
        },
        () => {
          el.classList.remove("dragging");
          keep();
        },
      );
    });
    return el;
  }
}
