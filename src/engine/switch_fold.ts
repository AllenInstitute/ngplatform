/**
 * The 3-D view's switches folded on a narrow panel: Neuroglancer lays out
 * the plugins' switches (`viewToggle`: Cube, Labels, Graphics, Zoom
 * boxes, Render…) beside its own Sections in one row in the panel's
 * corner; on a panel narrower than FOLD_BELOW they fold into one View
 * button, before Sections, that opens a small menu of them, so the row
 * never wraps.  Additive: a button put into Neuroglancer's group (again
 * whenever Neuroglancer fills the group anew) and the group marked
 * `data-folded`, which the stylesheet reads; Neuroglancer's own switches
 * are only hidden, and the menu's boxes set the same values.
 */
import { el, icon } from "../sdk/dom.js";

/** Below this width of its panel (CSS px), a 3-D view's switches fold into the View menu: about 600, kept just under the 3-D panel of a 4-panel layout beside the left column on a 1440 px screen, where the row fits. */
export const FOLD_BELOW = 560;

/** A switch the menu lists: its label, and its value (got and set). */
export interface FoldedSwitch {
  label: string;
  title?: string;
  get(): boolean;
  set(on: boolean): void;
}

/** Whether a group folds: on a panel narrower than FOLD_BELOW, with at least one plugin's switch to fold. */
export function folds(panelWidth: number, switches: number): boolean {
  return switches > 0 && panelWidth > 0 && panelWidth < FOLD_BELOW;
}

const GROUP = "div.perspective-panel-show-slice-views";

/**
 * Puts the View button into a group (first, before Neuroglancer's
 * switches) unless it is there, and marks the group folded or not for the
 * width of its panel.  `switches` lists the plugins' switches now.
 */
export function syncGroup(group: HTMLElement, panelWidth: number, switches: () => FoldedSwitch[]): void {
  let more = group.querySelector<HTMLButtonElement>(":scope > button.view-switches-more");
  if (more === null) {
    const button = el("button", { type: "button", class: "view-switches-more", "aria-haspopup": "true", "aria-expanded": "false" }, "View", icon("chevron-down"));
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu(group, button, switches);
    });
    group.prepend(button);
    more = button;
  }
  const count = group.querySelectorAll("label.perspective-panel-toggle").length - 1;
  const folded = folds(panelWidth, count);
  if (folded !== group.hasAttribute("data-folded")) group.toggleAttribute("data-folded", folded);
  if (!folded) closeMenu(group);
}

function closeMenu(group: HTMLElement): void {
  const menu = group.querySelector<HTMLElement>(":scope > .view-switches-menu");
  if (menu === null) return;
  (menu as HTMLElement & { close?: () => void }).close?.();
}

/** Opens (or closes) the menu of the plugins' switches above the View button. */
function toggleMenu(group: HTMLElement, button: HTMLButtonElement, switches: () => FoldedSwitch[]): void {
  if (group.querySelector(":scope > .view-switches-menu") !== null) return closeMenu(group);
  const menu = el("div", { class: "view-switches-menu float-surface", role: "group", "aria-label": "View" }) as HTMLElement & { close?: () => void };
  for (const s of switches()) {
    const box = el("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = s.get();
    box.addEventListener("change", () => s.set(box.checked));
    menu.append(el("label", { class: "view-switches-item", title: s.title }, box, s.label));
  }
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node) && e.target !== button && !button.contains(e.target as Node)) menu.close!();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    menu.close!();
    button.focus();
  };
  menu.close = () => {
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", key, true);
    button.setAttribute("aria-expanded", "false");
    menu.remove();
  };
  // The menu's presses are not the view's (no camera move under it).
  menu.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", key, true);
  button.setAttribute("aria-expanded", "true");
  group.append(menu);
  menu.querySelector<HTMLInputElement>("input")?.focus();
}

/**
 * Keeps every 3-D view's group of switches under `root` folded on narrow
 * panels: watches for groups Neuroglancer makes (or fills anew) and for
 * their panels' sizes.  Returns the means to stop.
 */
export function watchSwitchGroups(root: HTMLElement, switches: () => FoldedSwitch[]): () => void {
  const panels = new WeakSet<Element>();
  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const group = entry.target.querySelector<HTMLElement>(`:scope > ${GROUP}`);
      if (group !== null) syncGroup(group, (entry.target as HTMLElement).clientWidth, switches);
    }
  });
  const scan = () => {
    for (const group of root.querySelectorAll<HTMLElement>(GROUP)) {
      const panel = group.parentElement;
      if (panel === null) continue;
      if (!panels.has(panel)) {
        panels.add(panel);
        sizes.observe(panel);
      }
      syncGroup(group, panel.clientWidth, switches);
    }
  };
  // At most once a frame, whatever Neuroglancer changes meanwhile.
  let queued = 0;
  const changes = new MutationObserver(() => {
    if (queued === 0) queued = requestAnimationFrame(() => ((queued = 0), scan()));
  });
  changes.observe(root, { childList: true, subtree: true });
  scan();
  return () => {
    cancelAnimationFrame(queued);
    changes.disconnect();
    sizes.disconnect();
  };
}
