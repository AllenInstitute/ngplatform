/**
 * The docks: named places (left, tools, bottom) holding tabs that the
 * platform and plugins contribute.  A tab renders the first time it is
 * shown and stays mounted (Neuroglancer widgets keep their state), unless it
 * is marked transient, in which case it is disposed whenever it is hidden.
 *
 * The left column holds two of them, one above the other: Layers and
 * Plugins on top, and below a divider the Tools section, the tools that
 * are on (ordered by kind), which is not there while it has none.  The
 * Tools section belongs to the left column: collapsing the column hides it
 * too, and showing a tool opens both.  Each dock shows its tabs as a row.
 * Sizes, open tabs and collapsed docks are remembered per browser; the
 * bottom dock starts collapsed to its status line.
 */
import type { ContextKeys } from "../core/when.js";
import type { DockTabSpec } from "../platform/plugin_host.js";
import type { Disposer, DockSlot } from "../sdk/types.js";
import { emptyState, type Roving, roving } from "../sdk/dom.js";
import { h, icon } from "./dom.js";

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

/**
 * Where a dock is: the left column's top (Layers, Plugins), the left
 * column's Tools section below it, or the bottom (Activity).
 */
export type DockPlace = "left" | "tools" | "bottom";

export interface DockTab extends Omit<DockTabSpec, "slot"> {
  /** A plugin's `right` slot is the Tools section (`tools`), as `asTool` places it. */
  slot: DockSlot | "tools";
  /** Disposed when hidden, rendered again when shown (e.g. polling views). */
  transient?: boolean;
}

/** The dock a tab's slot is: the old right dock is the Tools section. */
function placeOf(slot: DockTab["slot"]): DockPlace {
  return slot === "right" ? "tools" : slot;
}

/**
 * Where a plugin's panel goes, TypeScript or Python: one in the left (or
 * right) slot is a tool, so it goes to the Tools section under its group
 * (`fallback` when it names none); the bottom slot keeps its own.
 */
export function asTool(tab: DockTab | DockTabSpec, fallback = "Other"): DockTab {
  return tab.slot === "left" || tab.slot === "right" || tab.slot === "tools" ? { ...tab, slot: "tools", group: tab.group ?? fallback } : (tab as DockTab);
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

const TITLES: Record<DockPlace, string> = { left: "Layers", tools: "Tools", bottom: "Activity" };
/** The left column's width, the Tools section's height (a share of the column until dragged) and the bottom dock's height. */
const DEFAULT_SIZE: Record<DockPlace, string> = { left: "300px", tools: "50%", bottom: "190px" };
/** Collapsed until the person opens them: the bottom dock (to its status line). */
const START_COLLAPSED: Record<DockPlace, boolean> = { left: false, tools: false, bottom: true };
/** Room the Layers part keeps above the Tools section, and the least the Tools section takes. */
const LAYERS_MIN = 120;
const TOOLS_MIN = 96;

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
  /** Left and Right move between the tabs. */
  readonly keys: Roving;
  readonly body = h("div", { class: "dock-body" });
  readonly tabs = new Map<string, Mounted>();
  selected: string | undefined;

  constructor(
    readonly slot: DockPlace,
    manager: DockManager,
  ) {
    this.el = h("aside", { class: `dock dock-${slot}`, id: `dock-${slot}`, "aria-label": TITLES[slot] });
    this.tabsEl.setAttribute("role", "tablist");
    this.tabsEl.setAttribute("aria-label", TITLES[slot]);
    this.keys = roving(this.tabsEl, {
      items: () => this.ordered().map((m) => m.button),
      orientation: "horizontal",
      tabStop: true,
      current: () => (this.selected !== undefined ? this.tabs.get(this.selected)?.button : undefined),
      onMove: (button) => button.click(),
    });
    // The Tools section folds to its row of tabs; the docks collapse to a rail or a line.
    const toggle = h(
      "button",
      {
        class: "btn icon dock-toggle",
        type: "button",
        title: slot === "tools" ? "Fold or unfold the tools" : `Show or hide the ${TITLES[slot].toLowerCase()} dock`,
        "aria-label": slot === "tools" ? "Toggle tools" : `Toggle ${TITLES[slot].toLowerCase()} dock`,
        "aria-controls": `dock-${slot}`,
        onclick: () => manager.toggle(slot),
      },
      icon(slot === "left" ? "panel-left" : slot === "tools" ? "chevron-down" : "panel-bottom"),
    );
    const rail = h("span", { class: "rail-title" }, TITLES[slot]);
    if (slot === "left") this.head.append(toggle, this.tabsEl, rail);
    else this.head.append(this.tabsEl, rail, toggle);
    this.el.append(this.head, this.body);
  }

  /** The tabs in their order; the Tools section's grouped by kind first (the groups in the order their first tool came). */
  ordered(): Mounted[] {
    const byOrder = [...this.tabs.values()].sort((a, b) => (a.tab.order ?? 100) - (b.tab.order ?? 100));
    if (this.slot !== "tools") return byOrder;
    const groups = [...new Set(byOrder.map((m) => m.tab.group ?? "Other"))];
    return byOrder.sort((a, b) => groups.indexOf(a.tab.group ?? "Other") - groups.indexOf(b.tab.group ?? "Other"));
  }

  layoutTabs(): void {
    this.tabsEl.replaceChildren(...this.ordered().map((m) => m.button));
    this.keys.sync();
  }

  visibleTabs(): Mounted[] {
    return this.ordered().filter((m) => !m.button.hidden);
  }
}

export class DockManager {
  private readonly docks: Record<DockPlace, Dock>;
  private readonly bySlotOf = new Map<string, DockPlace>();
  private readonly listeners = new Set<(id: string) => void>();
  /** Tabs that moved (Datasets into Layers, Auth into Settings): what showing one does now. */
  private readonly redirects = new Map<string, () => void>();

  constructor(
    private readonly root: HTMLElement,
    private readonly context: ContextKeys,
  ) {
    this.docks = { left: new Dock("left", this), tools: new Dock("tools", this), bottom: new Dock("bottom", this) };
    context.onChange(() => this.applyWhen());
    // None has a tab yet: the Tools section is not there until a tool is on.
    this.applyEmpty();
  }

  element(slot: DockPlace): HTMLElement {
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
  addToHead(slot: DockPlace, element: HTMLElement): void {
    const dock = this.docks[slot];
    dock.head.insertBefore(element, dock.tabsEl.nextSibling);
  }

  /** A dock with no tab to show is not there at all (the Tools section with no tool on, or none for the data selected). */
  private applyEmpty(): void {
    for (const dock of Object.values(this.docks)) {
      const empty = dock.visibleTabs().length === 0;
      dock.el.hidden = empty;
      this.root.classList.toggle(`${dock.slot}-empty`, empty);
    }
  }

  addTab(tab: DockTab): Disposer {
    const slot = placeOf(tab.slot);
    const dock = this.docks[slot];
    if (this.bySlotOf.has(tab.id)) throw new Error(`dock tab ${tab.id} already exists`);
    // A tab panel named by its tab.
    const host = h("div", { class: "dock-pane", "data-tab": tab.id, id: `pane-${tab.id}`, role: "tabpanel", "aria-labelledby": `tab-${tab.id}`, hidden: true });
    const button = h(
      "button",
      { class: "tab", type: "button", role: "tab", id: `tab-${tab.id}`, "aria-selected": "false", "aria-controls": `pane-${tab.id}`, onclick: () => this.show(tab.id) },
      tab.title,
    );
    const mounted: Mounted = { tab, button, host, rendered: false, renders: 0 };
    dock.tabs.set(tab.id, mounted);
    this.bySlotOf.set(tab.id, slot);
    dock.body.append(host);
    dock.layoutTabs();
    this.applyWhen();
    // The tab last chosen in this dock (on this visit or an earlier one), whichever tabs are added before it.
    const remembered = prefs.get(`${slot}.tab`);
    if (!button.hidden && (dock.selected === undefined || remembered === tab.id)) this.select(slot, tab.id);
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

  /** Whether a dock's panel is on screen: not collapsed, and for the Tools section, its column not collapsed either. */
  private isOpen(slot: DockPlace): boolean {
    return !this.isCollapsed(slot) && (slot !== "tools" || !this.isCollapsed("left"));
  }

  /**
   * Shows `id` in its dock.  Only a tab the person chose (`chosen`) is kept
   * as the one to show next visit: a tab selected because it came first,
   * or because the one shown went, is not, so it does not replace the
   * remembered tab before that tab is added.
   */
  private select(slot: DockPlace, id: string, chosen = false): void {
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
    if (this.isOpen(slot)) this.render(mounted);
    if (chosen) prefs.set(`${slot}.tab`, id);
    for (const listener of this.listeners) listener(id);
  }

  /**
   * Shows a tab: selects it and opens its dock.  A tool opens the left
   * column and the Tools section too, and is scrolled into view.
   */
  show(id: string): void {
    const redirect = this.redirects.get(id);
    if (redirect !== undefined) return redirect();
    id = this.alias(id);
    const slot = this.bySlotOf.get(id);
    if (slot === undefined) return;
    // Selected before the dock opens, so opening it renders this tab and not the one shown before.
    this.select(slot, id, true);
    if (slot === "tools") this.setCollapsed("left", false);
    this.setCollapsed(slot, false);
    const mounted = this.docks[slot].tabs.get(id)!;
    if (slot === "tools") {
      // A tab on a second row, or a column floating over the views on a phone: brought into view.
      mounted.button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      this.docks.tools.body.scrollTop = 0;
    }
    // A panel that needs room grows its dock for now; the size the person set stays saved.
    const min = mounted.tab.minSize;
    if (min !== undefined) {
      const now = this.sizeOf(slot);
      const limit = this.limits(slot)[1];
      if (now > 0 && now < min) this.root.style.setProperty(`--${slot}`, `${Math.round(Math.min(min, limit))}px`);
    }
  }

  selected(slot: DockPlace): string | undefined {
    return this.docks[slot].selected;
  }

  isShowing(id: string): boolean {
    const slot = this.bySlotOf.get(this.alias(id));
    return slot !== undefined && this.docks[slot].selected === id && this.isOpen(slot);
  }

  onSelect(listener: (id: string) => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Lists the tabs whose `when` holds (a tool for the data selected, say).
   * A dock whose tab went shows another; the tab last chosen comes back
   * when it holds again (the selection moved back to its data).
   */
  private applyWhen(): void {
    for (const dock of Object.values(this.docks)) {
      for (const m of dock.tabs.values()) m.button.hidden = !this.context.matches(m.tab.when);
      dock.keys.sync();
      const remembered = prefs.get(`${dock.slot}.tab`);
      const back = remembered !== null ? dock.tabs.get(remembered) : undefined;
      if (back !== undefined && !back.button.hidden && dock.selected !== remembered) this.select(dock.slot, remembered!);
      else if (dock.selected === undefined || dock.tabs.get(dock.selected)?.button.hidden) {
        const next = dock.visibleTabs()[0];
        if (next !== undefined) this.select(dock.slot, next.tab.id);
      }
    }
    this.applyEmpty();
  }

  // ------------------------------------------------------------- sizing

  isCollapsed(slot: DockPlace): boolean {
    return this.docks[slot].el.classList.contains("collapsed");
  }

  setCollapsed(slot: DockPlace, collapsed: boolean, remember = true): void {
    const dock = this.docks[slot];
    dock.el.classList.toggle("collapsed", collapsed);
    dock.el.querySelector(".dock-toggle")?.setAttribute("aria-expanded", String(!collapsed));
    this.root.classList.toggle(`${slot}-collapsed`, collapsed);
    if (remember) prefs.set(`${slot}.collapsed`, collapsed ? "1" : "0");
    this.applyOpen(slot);
    // The Tools section is in the left column: it opens and shuts with it.
    if (slot === "left") this.applyOpen("tools");
  }

  /**
   * Renders a dock's tab once it is on screen; a transient tab (Chunk
   * statistics) stops its work while its dock is shut, as when another tab
   * is chosen.
   */
  private applyOpen(slot: DockPlace): void {
    const dock = this.docks[slot];
    const shown = dock.selected !== undefined ? dock.tabs.get(dock.selected) : undefined;
    if (shown === undefined) return;
    if (this.isOpen(slot)) this.render(shown);
    else if (shown.tab.transient) this.unrender(shown);
  }

  toggle(slot: DockPlace): void {
    this.setCollapsed(slot, !this.isCollapsed(slot));
  }

  /** Restores remembered sizes and collapsed docks; a narrow window starts with the left column collapsed. */
  restore(narrow: boolean): void {
    for (const slot of ["left", "tools", "bottom"] as const) {
      this.root.style.setProperty(`--${slot}`, prefs.get(`${slot}.size`) || DEFAULT_SIZE[slot]);
      const kept = prefs.get(`${slot}.collapsed`);
      const collapsed = (kept === null ? START_COLLAPSED[slot] : kept === "1") || (narrow && slot === "left");
      this.setCollapsed(slot, collapsed, false);
    }
  }

  /** The smallest and largest a dock may be, in pixels, in this window. */
  private limits(slot: DockPlace): [number, number] {
    if (slot === "bottom") return [90, window.innerHeight * 0.6];
    if (slot === "tools") {
      // Within the left column, leaving the Layers part some room.
      const column = this.docks.tools.el.parentElement?.getBoundingClientRect().height || window.innerHeight * 0.8;
      return [TOOLS_MIN, Math.max(TOOLS_MIN, column - LAYERS_MIN)];
    }
    return [160, window.innerWidth * (window.innerWidth <= 760 ? 0.34 : 0.5)];
  }

  /** Sets a dock's size (within its limits) and says so on its resizer; returns the size set. */
  private resize(slot: DockPlace, size: number, handle: HTMLElement): number {
    const [min, max] = this.limits(slot);
    const px = Math.round(Math.max(min, Math.min(max, size)));
    this.root.style.setProperty(`--${slot}`, `${px}px`);
    describeSize(handle, px, min, max);
    return px;
  }

  /** The size a dock is now: as drawn, or as set. */
  private sizeOf(slot: DockPlace): number {
    const rect = this.docks[slot].el.getBoundingClientRect();
    const drawn = slot === "left" ? rect.width : rect.height;
    if (drawn > 0) return drawn;
    const set = this.root.style.getPropertyValue(`--${slot}`) || DEFAULT_SIZE[slot];
    // A share of the column (the Tools section until it is dragged): in pixels of the column.
    return set.endsWith("%") ? (parseFloat(set) / 100) * (this.limits(slot)[1] + LAYERS_MIN) : parseFloat(set);
  }

  /**
   * A handle that resizes `slot`: dragged, or with the keyboard, as a
   * separator a screen reader reads with its size.  The arrows move it 10
   * px (40 with Shift), Home and End to the smallest and largest.  The size
   * is kept when a drag ends, or at each key.  The left column's handle is
   * at its right edge; the Tools section's and the bottom dock's above them.
   */
  resizer(slot: DockPlace): HTMLElement {
    const vertical = slot !== "left";
    const el = h("div", {
      class: `resizer resizer-${slot}`,
      role: "separator",
      tabindex: 0,
      "aria-orientation": vertical ? "horizontal" : "vertical",
      "aria-label": slot === "tools" ? "Resize the Tools section" : `Resize the ${TITLES[slot]} dock`,
      "aria-controls": `dock-${slot}`,
      title: "Drag to resize",
    });
    describeSize(el, this.sizeOf(slot), ...this.limits(slot));
    const keep = () => prefs.set(`${slot}.size`, this.root.style.getPropertyValue(`--${slot}`));
    // Which way grows the dock: right for the left column, up for the Tools section and the bottom dock.
    const grow = vertical ? "ArrowUp" : "ArrowRight";
    const shrink = vertical ? "ArrowDown" : "ArrowLeft";
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
