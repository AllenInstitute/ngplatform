/**
 * Labels on the views, for figures: text pinned to a point, a track group
 * (its centre) or an annotation, shown in the 2-D views, the 3-D view or
 * both, beside what it names (above, to the right, …).  In a view a label
 * can be dragged off its anchor (a thin line keeps it tied) and resized by
 * its corner.  Labels are drawn over the views as HTML, and painted into
 * Neuroglancer's screenshots too.  They are kept in the workspace.
 */
import type { ViewPanel } from "../engine/engine.js";
import { clear, h, iconButton } from "./dom.js";
import type { Workbench } from "./workbench.js";

export type Placement = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";
type Anchor = { kind: "point"; position: number[] } | { kind: "group"; group: string } | { kind: "annotation"; layer: string; annotation: string };

export interface Label {
  id: string;
  text: string;
  anchor: Anchor;
  placement: Placement;
  /** Text size, CSS pixels. */
  size: number;
  views: "both" | "2d" | "3d";
  /** In a 2-D view, only when its anchor is near the section shown. */
  nearSection: boolean;
  colour: string;
  visible: boolean;
  /** Where it was dragged to from its placement, CSS pixels, in 2-D and 3-D views. */
  offset2d: [number, number];
  offset3d: [number, number];
}

const KEY = "labels";
const VERSION = 1;
const GAP = 6;

const PLACEMENTS: [Placement, string][] = [
  ["top-left", "Above left"],
  ["top", "Above"],
  ["top-right", "Above right"],
  ["left", "Left"],
  ["center", "On it"],
  ["right", "Right"],
  ["bottom-left", "Below left"],
  ["bottom", "Below"],
  ["bottom-right", "Below right"],
];

/** How far a label's box is shifted from its anchor, as fractions of its size, and the gap's direction. */
function shift(placement: Placement): { fx: number; fy: number; gx: number; gy: number } {
  const col = placement.endsWith("left") ? 0 : placement.endsWith("right") ? 2 : 1;
  const row = placement.startsWith("top") ? 0 : placement.startsWith("bottom") ? 2 : 1;
  const fx = [-1, -0.5, 0][col];
  const fy = [-1, -0.5, 0][row];
  return { fx, fy, gx: col - 1, gy: row - 1 };
}

interface TrackGroups {
  list(): { id: string; name: string; colour: string; version: number }[];
  onChanged(callback: () => void): () => void;
  curves(id: string, maxPoints: number): Promise<{ positions: Float32Array }>;
}

export class Labels {
  private labels: Label[] = [];
  private readonly overlay = h("div", { class: "labels-overlay", "aria-hidden": "true" });
  private readonly lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private readonly elements = new Map<string, HTMLElement>();
  /** Group centres in RAS mm, by group id and answer version. */
  private readonly centres = new Map<string, { version: number; mm?: [number, number, number] }>();
  private groups: TrackGroups | undefined;
  private panelUpdate: (() => void) | undefined;
  private queued = false;

  constructor(
    private readonly wb: Workbench,
    host: HTMLElement,
  ) {
    this.lines.classList.add("labels-lines");
    this.overlay.append(this.lines);
    host.append(this.overlay);
    this.read();
    wb.store.onSliceChanged(() => {
      this.read();
      this.schedule();
      this.panelUpdate?.();
    });
    wb.engine.onRendered(() => this.schedule());
    wb.engine.onStateChanged(() => this.schedule());
    wb.engine.setScreenshotOverlay((context, canvas) => this.paint(context, canvas));
    void wb.services.get<TrackGroups>("trackFiltering.groups").then((groups) => {
      this.groups = groups;
      groups.onChanged(() => {
        this.schedule();
        this.panelUpdate?.();
      });
      this.schedule();
    });
  }

  private read(): void {
    const raw = this.wb.store.rawSlice(KEY) as { labels?: Label[] } | undefined;
    this.labels = Array.isArray(raw?.labels) ? raw.labels : [];
  }

  private write(labels: Label[]): void {
    this.labels = labels;
    this.wb.store.setRawSlice(KEY, VERSION, { labels });
  }

  private update(id: string, patch: Partial<Label>): void {
    this.write(this.labels.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  add(anchor: Anchor, text: string, colour = "#ffffff"): void {
    const label: Label = {
      id: crypto.randomUUID().slice(0, 8),
      text,
      anchor,
      placement: "top-right",
      size: 14,
      views: "both",
      nearSection: anchor.kind !== "group",
      colour,
      visible: true,
      offset2d: [0, 0],
      offset3d: [0, 0],
    };
    this.write([...this.labels, label]);
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.place();
    });
  }

  // ---------------------------------------------------------- anchors

  /** A label's anchor as a global position, when it can be found. */
  private position(label: Label): number[] | undefined {
    const ng = this.wb.store.ng() as { dimensions?: Record<string, [number, string]>; position?: number[]; layers?: unknown[] };
    const anchor = label.anchor;
    if (anchor.kind === "point") return anchor.position;
    if (anchor.kind === "annotation") {
      const layer = (ng.layers as { name?: string; annotations?: Record<string, unknown>[] }[] | undefined)?.find((l) => l.name === anchor.layer);
      const a = layer?.annotations?.find((x) => x.id === anchor.annotation);
      if (a === undefined) return undefined;
      const point = (a.point ?? a.center) as number[] | undefined;
      if (point) return point;
      const p = a.pointA as number[] | undefined;
      const q = a.pointB as number[] | undefined;
      return p && q ? p.map((v, i) => (v + q[i]) / 2) : p;
    }
    // A track group: the centre of its streamlines, in RAS mm, to global.
    const group = this.groups?.list().find((g) => g.id === anchor.group);
    if (group === undefined) return undefined;
    const known = this.centres.get(group.id);
    if (known === undefined || known.version !== group.version) {
      this.centres.set(group.id, { version: group.version });
      void this.groups!.curves(group.id, 200_000).then(
        ({ positions }) => {
          const n = positions.length / 3;
          if (n === 0) return;
          const mm: [number, number, number] = [0, 0, 0];
          for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; ++k) mm[k] += positions[i + k];
          this.centres.set(group.id, { version: group.version, mm: mm.map((v) => v / n) as [number, number, number] });
          this.schedule();
        },
        () => {},
      );
    }
    const mm = this.centres.get(group.id)?.mm;
    if (mm === undefined || ng.dimensions === undefined) return undefined;
    return Object.entries(ng.dimensions).map(([name, [scale, unit]], i) => {
      const axis = ["x", "y", "z"].indexOf(name);
      if (axis === -1) return ng.position?.[i] ?? 0;
      return unit === "m" ? (mm[axis] * 1e-3) / scale : mm[axis];
    });
  }

  // ---------------------------------------------------------- drawing

  /** Where each shown label is in each panel: CSS pixels relative to the overlay. */
  private layout(): { label: Label; panel: ViewPanel; index: number; anchor: [number, number]; at: [number, number] }[] {
    const out: { label: Label; panel: ViewPanel; index: number; anchor: [number, number]; at: [number, number] }[] = [];
    const base = this.overlay.getBoundingClientRect();
    const panels = this.wb.engine.panels();
    for (const label of this.labels) {
      if (!label.visible || label.text.trim() === "") continue;
      const position = this.position(label);
      if (position === undefined) continue;
      for (const [index, panel] of panels.entries()) {
        if (label.views !== "both" && label.views !== panel.kind) continue;
        const p = panel.project(position);
        if (p === undefined) continue;
        if (panel.kind === "2d" && label.nearSection && Math.abs(p.depth) > 1) continue;
        const rect = panel.element.getBoundingClientRect();
        if (p.x < 0 || p.y < 0 || p.x > rect.width || p.y > rect.height) continue;
        const ax = rect.left - base.left + p.x;
        const ay = rect.top - base.top + p.y;
        const offset = panel.kind === "2d" ? label.offset2d : label.offset3d;
        out.push({ label, panel, index, anchor: [ax, ay], at: [ax + offset[0], ay + offset[1]] });
      }
    }
    return out;
  }

  private place(): void {
    const placed = this.layout();
    const seen = new Set<string>();
    const lines: SVGLineElement[] = [];
    placed.forEach(({ label, panel, index, anchor, at }) => {
      const key = `${label.id}|${index}`;
      seen.add(key);
      let el = this.elements.get(key);
      if (el === undefined) {
        el = this.makeElement(label.id, panel.kind);
        this.elements.set(key, el);
        this.overlay.append(el);
      }
      const { fx, fy, gx, gy } = shift(label.placement);
      el.firstChild!.textContent = label.text;
      el.style.font = `500 ${label.size}px/1.2 var(--ui)`;
      el.style.color = label.colour;
      el.style.left = `${at[0] + gx * GAP}px`;
      el.style.top = `${at[1] + gy * GAP}px`;
      el.style.transform = `translate(${fx * 100}%, ${fy * 100}%)`;
      el.dataset.label = label.id;
      el.dataset.kind = panel.kind;
      if (at[0] !== anchor[0] || at[1] !== anchor[1]) {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(anchor[0]));
        line.setAttribute("y1", String(anchor[1]));
        line.setAttribute("x2", String(at[0]));
        line.setAttribute("y2", String(at[1]));
        line.setAttribute("stroke", label.colour);
        lines.push(line);
      }
    });
    for (const [key, el] of this.elements) {
      if (!seen.has(key)) {
        el.remove();
        this.elements.delete(key);
      }
    }
    this.lines.replaceChildren(...lines);
  }

  /** A label's element: dragging it moves it off its anchor, its corner resizes it. */
  private makeElement(id: string, kind: "2d" | "3d"): HTMLElement {
    const grip = h("span", { class: "label-grip", title: "Drag to resize" });
    const el = h("div", { class: "view-label", title: "Drag to move; double-click to put it back" }, h("span", {}), grip);
    const drag = (e: PointerEvent, resize: boolean) => {
      e.preventDefault();
      e.stopPropagation();
      const label = this.labels.find((l) => l.id === (el.dataset.label ?? id));
      if (label === undefined) return;
      const start = [e.clientX, e.clientY];
      const offsetKey = kind === "2d" ? "offset2d" : "offset3d";
      const from = label[offsetKey];
      const size = label.size;
      const move = (m: PointerEvent) => {
        const dx = m.clientX - start[0];
        const dy = m.clientY - start[1];
        if (resize) this.labels = this.labels.map((l) => (l.id === label.id ? { ...l, size: Math.max(8, Math.min(96, size + dx / 4)) } : l));
        else this.labels = this.labels.map((l) => (l.id === label.id ? { ...l, [offsetKey]: [from[0] + dx, from[1] + dy] } : l));
        this.place();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.write(this.labels);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    el.addEventListener("pointerdown", (e) => drag(e, false));
    grip.addEventListener("pointerdown", (e) => drag(e, true));
    el.addEventListener("dblclick", () => this.update(el.dataset.label ?? id, kind === "2d" ? { offset2d: [0, 0] } : { offset3d: [0, 0] }));
    return el;
  }

  /** The labels, painted into a screenshot of the viewer's canvas (in its pixels). */
  private paint(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvas.width / Math.max(1, canvasRect.width);
    const base = this.overlay.getBoundingClientRect();
    for (const { label, anchor, at } of this.layout()) {
      // Overlay pixels to canvas pixels.
      const toCanvas = (p: [number, number]) => [(p[0] + base.left - canvasRect.left) * scale, (p[1] + base.top - canvasRect.top) * scale];
      const [ax, ay] = toCanvas(anchor);
      const [x0, y0] = toCanvas(at);
      const size = label.size * scale;
      context.font = `500 ${size}px "IBM Plex Sans", system-ui, sans-serif`;
      const width = context.measureText(label.text).width;
      const pad = 3 * scale;
      const boxW = width + 2 * pad;
      const boxH = size * 1.2 + 2 * pad;
      const { fx, fy, gx, gy } = shift(label.placement);
      const left = x0 + gx * GAP * scale + fx * boxW;
      const top = y0 + gy * GAP * scale + fy * boxH;
      if (ax !== x0 || ay !== y0) {
        context.strokeStyle = label.colour;
        context.lineWidth = Math.max(1, scale);
        context.beginPath();
        context.moveTo(ax, ay);
        context.lineTo(x0, y0);
        context.stroke();
      }
      context.fillStyle = "rgba(0, 0, 0, 0.55)";
      context.fillRect(left, top, boxW, boxH);
      context.fillStyle = label.colour;
      context.textBaseline = "top";
      context.fillText(label.text, left + pad, top + pad + size * 0.1);
    }
  }

  // ------------------------------------------------------------- panel

  render(host: HTMLElement): () => void {
    const list = h("div", { class: "list labels-list" });
    const atPosition = () => {
      const position = (this.wb.store.ng() as { position?: number[] }).position;
      if (position) this.add({ kind: "point", position: [...position] }, "Label");
    };
    const forGroups = () => {
      const have = new Set(this.labels.flatMap((l) => (l.anchor.kind === "group" ? [l.anchor.group] : [])));
      for (const g of this.groups?.list() ?? []) if (!have.has(g.id)) this.add({ kind: "group", group: g.id }, g.name, g.colour);
    };
    const fromAnnotations = () => {
      const have = new Set(this.labels.flatMap((l) => (l.anchor.kind === "annotation" ? [`${l.anchor.layer}|${l.anchor.annotation}`] : [])));
      const layers = ((this.wb.store.ng() as { layers?: unknown[] }).layers ?? []) as { name: string; annotations?: { id: string; description?: string }[] }[];
      let added = 0;
      for (const layer of layers) {
        for (const a of layer.annotations ?? []) {
          if (!a.description || have.has(`${layer.name}|${a.id}`)) continue;
          this.add({ kind: "annotation", layer: layer.name, annotation: a.id }, a.description);
          added++;
        }
      }
      if (added === 0) this.wb.log.add("No annotations with a description to label. Give one a description in its layer's Annotations tab.");
    };
    host.append(
      h(
        "div",
        { class: "panel-actions" },
        h("button", { class: "btn outline small", type: "button", onclick: atPosition }, "+ At the position"),
        h("button", { class: "btn outline small", type: "button", disabled: this.groups === undefined, onclick: forGroups }, "+ Track groups"),
        h("button", { class: "btn outline small", type: "button", onclick: fromAnnotations }, "+ Annotations"),
      ),
      list,
    );
    const draw = () => {
      if (this.labels.length === 0) {
        clear(list, h("p", { class: "empty" }, "No labels. Add one at the position, one per track group, or one per annotation with a description; then drag it in a view to move it, and by its corner to resize it."));
        return;
      }
      clear(
        list,
        ...this.labels.map((label) => {
          const visible = h("input", { type: "checkbox", "aria-label": "Show" });
          visible.checked = label.visible;
          visible.addEventListener("change", () => this.update(label.id, { visible: visible.checked }));
          const text = h("input", { class: "text-input", type: "text", value: label.text, "aria-label": "Text" });
          text.addEventListener("change", () => this.update(label.id, { text: text.value }));
          const colour = h("input", { type: "color", value: label.colour, "aria-label": "Colour" });
          colour.addEventListener("change", () => this.update(label.id, { colour: colour.value }));
          const placement = h("select", { class: "text-input", "aria-label": "Where" });
          for (const [value, name] of PLACEMENTS) placement.append(h("option", { value }, name));
          placement.value = label.placement;
          placement.addEventListener("change", () => this.update(label.id, { placement: placement.value as Placement, offset2d: [0, 0], offset3d: [0, 0] }));
          const views = h("select", { class: "text-input", "aria-label": "Views" });
          for (const [value, name] of [
            ["both", "2-D and 3-D"],
            ["2d", "2-D only"],
            ["3d", "3-D only"],
          ])
            views.append(h("option", { value }, name));
          views.value = label.views;
          views.addEventListener("change", () => this.update(label.id, { views: views.value as Label["views"] }));
          const size = h("input", { type: "range", min: "8", max: "64", step: "1", value: String(Math.round(label.size)), "aria-label": "Size" });
          size.addEventListener("change", () => this.update(label.id, { size: Number(size.value) }));
          const near = h("input", { type: "checkbox", "aria-label": "Only near the section in 2-D" });
          near.checked = label.nearSection;
          near.addEventListener("change", () => this.update(label.id, { nearSection: near.checked }));
          const what = label.anchor.kind === "group" ? "track group" : label.anchor.kind === "annotation" ? `annotation in ${label.anchor.layer}` : "point";
          return h(
            "div",
            { class: "label-row" },
            h("div", { class: "label-head" }, visible, text, colour, iconButton("close", "Remove", () => this.write(this.labels.filter((l) => l.id !== label.id)))),
            h("div", { class: "label-opts" }, placement, views, h("label", { class: "field check" }, near, h("span", {}, "2-D: near its section only"))),
            h("label", { class: "label-size" }, h("span", {}, "Size"), size, h("span", { class: "type" }, what)),
          );
        }),
      );
    };
    this.panelUpdate = draw;
    draw();
    return () => {
      if (this.panelUpdate === draw) this.panelUpdate = undefined;
    };
  }
}
