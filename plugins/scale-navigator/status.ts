/**
 * The navigator's two status line items: the breadcrumb (the image layers
 * holding the position, coarse to fine, each a button that frames it, cut
 * short at its left when the line is full) and the level chip (the
 * pyramid level drawn, and its voxel size).
 */
import { el, readout } from "@ngplatform/sdk/dom";
import { lengthText } from "./hierarchy.js";

export interface Crumb {
  name: string;
  /** Its finest voxel, metres. */
  voxel: number;
  /** The layer the views are on. */
  current: boolean;
  visible: boolean;
}

const SEPARATOR = " › ";

/** The chain as text: what the tooltip holds, what a screen reader reads. */
export function chainText(crumbs: Crumb[]): string {
  return crumbs
    .map((c) => {
      const { value, unit } = lengthText(c.voxel);
      return `${c.name} ${value}\u2009${unit}${c.visible ? "" : " (hidden)"}`;
    })
    .join(SEPARATOR);
}

export class Breadcrumb {
  readonly element = el("div", { class: "scale-nav-crumbs" });
  private readonly more = el("span", { class: "scale-nav-more", "aria-hidden": "true", hidden: true });
  private readonly list = el("span", { class: "scale-nav-list" });
  private key = "";

  constructor(private readonly onFrame: (name: string) => void) {
    this.element.append(this.more, this.list);
  }

  /** Shows a chain (drawn again only when it changed). */
  set(crumbs: Crumb[]): void {
    const key = JSON.stringify(crumbs);
    if (key === this.key) return;
    this.key = key;
    const children: Node[] = [];
    crumbs.forEach((c, i) => {
      if (i > 0) children.push(el("span", { class: "scale-nav-sep", "aria-hidden": "true" }, SEPARATOR));
      const { value, unit } = lengthText(c.voxel);
      const button = el(
        "button",
        {
          type: "button",
          class: `scale-nav-crumb${c.current ? " current" : ""}${c.visible ? "" : " hidden-layer"}`,
          "aria-label": `Frame ${c.name}, ${value} ${unit} voxels${c.visible ? "" : ", hidden"}`,
          ...(c.current ? { "aria-current": "location" } : {}),
          onclick: () => this.onFrame(c.name),
        },
        el("span", { class: "status-label" }, c.name),
        " ",
        readout(value, unit),
      );
      children.push(button);
    });
    this.list.replaceChildren(...children);
    this.element.title = `${chainText(crumbs)}\nClick a layer to frame it (Alt+↑, Alt+↓: coarser, finer).`;
    this.fit();
  }

  /** Cuts the chain short at its left, a crumb at a time, until it fits (the finest always shows). */
  fit(): void {
    const items = [...this.list.children] as HTMLElement[];
    for (const item of items) item.hidden = false;
    this.more.hidden = true;
    const over = () => this.element.scrollWidth > this.element.clientWidth + 0.5;
    // Crumbs and separators alternate: hide a crumb with the separator after it.
    let i = 0;
    while (over() && i < items.length - 1) {
      items[i].hidden = true;
      if (items[i + 1]?.classList.contains("scale-nav-sep")) items[i + 1].hidden = true;
      i += 2;
      this.more.hidden = false;
    }
  }
}

export interface LevelShown {
  /** Index of the level, 0 the finest. */
  index: number;
  count: number;
  /** Its voxel, metres. */
  voxel: number;
  /** Worked out from the zoom, not read from what Neuroglancer drew. */
  estimated: boolean;
  /** A finer level Neuroglancer is still loading (an index), when there is one. */
  loading?: number;
  layer: string;
}

export class LevelChip {
  readonly element = el("div", { class: "scale-nav-level" });
  /** "≈" while the level is worked out rather than read. */
  private readonly approx = el("span", { class: "scale-nav-approx" });
  private readonly index = readout("");
  private readonly dot = el("span", { class: "scale-nav-dot", "aria-hidden": "true" }, " · ");
  private readonly size = readout("");
  private key = "";

  constructor() {
    this.element.append(this.approx, el("span", { class: "status-label" }, "level"), " ", this.index, this.dot, this.size);
  }

  /** A layer whose levels are not known yet (no section has drawn it, and it is not drawn in one now): a dash, so the chip keeps its place. */
  unknown(layer: string): void {
    const key = `unknown:${layer}`;
    if (key === this.key) return;
    this.key = key;
    this.approx.textContent = "";
    this.index.set("–");
    this.dot.hidden = true;
    this.size.hidden = true;
    this.element.title = `The levels of ${layer}'s pyramid are not known yet: they are read once a section draws it.`;
  }

  set(level: LevelShown): void {
    const key = JSON.stringify(level);
    if (key === this.key) return;
    this.key = key;
    this.dot.hidden = false;
    this.size.hidden = false;
    this.approx.textContent = level.estimated ? "≈ " : "";
    this.index.set(`${level.index}/${level.count}`);
    const { value, unit } = lengthText(level.voxel);
    this.size.set({ value, unit });
    const which = `Level ${level.index} of ${level.count} of ${level.layer}'s pyramid (0 is the finest), ${value} ${unit} voxels`;
    this.element.title = level.estimated
      ? `${which}: worked out from the zoom, as Neuroglancer would choose it (no section draws the layer now).`
      : level.loading !== undefined
        ? `${which}: drawn in the sections now; level ${level.loading} is loading.`
        : `${which}: drawn in the sections now (as Resolution (slice) in the layer's Rendering tab shows).`;
  }
}
