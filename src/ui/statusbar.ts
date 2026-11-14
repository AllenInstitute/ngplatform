/**
 * Items on the right of the status line (the Activity dock's head, also
 * while it is collapsed): the activity message keeps the left and the
 * room left over; the items follow it in their order, each as wide as its
 * content until the line is full, then cut short with an ellipsis (its
 * whole text in its tooltip).  Items are readouts (readout() in
 * @ngplatform/sdk/dom): values in the mono face with tabular digits, as the
 * coordinates over the views are, a unit (`.readout-unit`) quiet; an
 * element marked `.status-label` inside an item is in the interface's face,
 * quiet.  A scale breadcrumb and the level on screen go here.
 */
import type { Disposer } from "../sdk/types.js";
import { h } from "./dom.js";

export interface StatusItemOptions {
  /** Lower comes first (further left); 100 when not given.  Items of one order keep the order they came in. */
  order?: number;
  /** What the item is, for a screen reader and a tooltip (its text when not given). */
  label?: string;
}

interface Item {
  element: HTMLElement;
  wrap: HTMLElement;
  order: number;
  seq: number;
}

export class StatusItems {
  /** Where the items are drawn: placed on the status line by the shell. */
  readonly element = h("div", { class: "status-items", role: "group", "aria-label": "Status", hidden: true });
  private readonly items: Item[] = [];
  private seq = 0;

  /** Adds `element` to the status line, until the disposer is called. */
  add(element: HTMLElement, options: StatusItemOptions = {}): Disposer {
    const wrap = h("div", { class: "status-item" }, element);
    if (options.label !== undefined) wrap.setAttribute("aria-label", options.label);
    // The whole text when it is cut short (updated as the item changes).
    const title = () => {
      wrap.title = options.label !== undefined ? `${options.label}: ${element.textContent ?? ""}` : (element.textContent ?? "");
    };
    title();
    const watch = typeof MutationObserver === "function" ? new MutationObserver(title) : undefined;
    watch?.observe(element, { childList: true, characterData: true, subtree: true });
    const item: Item = { element, wrap, order: options.order ?? 100, seq: this.seq++ };
    this.items.push(item);
    this.layout();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      watch?.disconnect();
      this.items.splice(this.items.indexOf(item), 1);
      wrap.remove();
      this.layout();
    };
  }

  /** The items' elements, in the order shown. */
  list(): HTMLElement[] {
    return this.sorted().map((i) => i.element);
  }

  private sorted(): Item[] {
    return [...this.items].sort((a, b) => a.order - b.order || a.seq - b.seq);
  }

  private layout(): void {
    this.element.replaceChildren(...this.sorted().map((i) => i.wrap));
    this.element.hidden = this.items.length === 0;
  }
}

/** The app's status line items. */
export const statusItems = new StatusItems();

/** Adds an item to the right of the status line, until the disposer is called. */
export function addStatusItem(element: HTMLElement, options?: StatusItemOptions): Disposer {
  return statusItems.add(element, options);
}
