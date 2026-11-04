/**
 * Labels on the views, for figures, as an anatomy atlas draws them: a pin on
 * what is named (a point, a track group's centre, an annotation), a thin
 * leader line, and the name beside it or lined up at the view's edge.  Shown
 * in the 2-D views, the 3-D view or both; dragged off their place and
 * resized in the views; painted into Neuroglancer's screenshots.  Kept in
 * the workspace (this plugin's state).
 */
import type { Disposer, PlatformContext, ViewPanelInfo } from "@ngplatform/sdk";
import { el } from "@ngplatform/sdk/dom";
import type { AnnotationJson } from "./measure.js";
import { rankOf, toGlobalOf } from "./scene.js";

export type Placement = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right" | "side";
type Anchor = { kind: "point"; position: number[] } | { kind: "group"; group: string } | { kind: "annotation"; layer: string; annotation: string };

export interface Label {
  id: string;
  text: string;
  anchor: Anchor;
  placement: Placement;
  /** Text size, CSS pixels. */
  size: number;
  views: "both" | "2d" | "3d";
  /** In a 2-D view, only when its pin is near the section shown. */
  nearSection: boolean;
  colour: string;
  visible: boolean;
  /** Where it was dragged to from its place, CSS pixels, in 2-D and 3-D views. */
  offset2d: [number, number];
  offset3d: [number, number];
}

const GAP = 6;
const MARGIN = 10;

export const PLACEMENTS: [Placement, string][] = [
  ["side", "At the side"],
  ["top-right", "Above right"],
  ["top", "Above"],
  ["top-left", "Above left"],
  ["right", "Right"],
  ["center", "On it"],
  ["left", "Left"],
  ["bottom-right", "Below right"],
  ["bottom", "Below"],
  ["bottom-left", "Below left"],
];

/** A label box's alignment to its point (fractions of its size) and the gap's direction, beside its pin. */
export function shift(placement: Exclude<Placement, "side">): { fx: number; fy: number; gx: number; gy: number } {
  const col = placement.endsWith("left") ? 0 : placement.endsWith("right") ? 2 : 1;
  const row = placement.startsWith("top") ? 0 : placement.startsWith("bottom") ? 2 : 1;
  return { fx: [-1, -0.5, 0][col], fy: [-1, -0.5, 0][row], gx: col - 1, gy: row - 1 };
}

/**
 * Callouts at a view's sides: labels whose pins are left of the middle go
 * to the left edge, the others to the right, each in its pin's order down
 * the view and pushed apart so none overlap.  Returns each one's y (its
 * middle), in the order given.
 */
export function stackColumn(wanted: number[], heights: number[], top: number, bottom: number): number[] {
  const order = wanted.map((y, i) => i).sort((a, b) => wanted[a] - wanted[b]);
  const out = new Array<number>(wanted.length);
  let next = top;
  for (const i of order) {
    const y = Math.max(wanted[i], next + heights[i] / 2);
    out[i] = y;
    next = y + heights[i] / 2 + 4;
  }
  // Past the bottom: shift the column up, as far as its top allows.
  const over = next - 4 - bottom;
  if (over > 0) {
    const room = Math.max(0, Math.min(...order.map((i) => out[i] - heights[i] / 2)) - top);
    const by = Math.min(over, room);
    for (const i of order) out[i] -= by;
  }
  return out;
}

interface TrackGroups {
  list(): { id: string; name: string; colour: string; version: number }[];
  onChanged(callback: () => void): () => void;
  curves(id: string, maxPoints: number): Promise<{ positions: Float32Array }>;
}

/** A label as laid out in one panel: overlay pixels for its pin and its box's reference point, and the box's alignment. */
interface Placed {
  label: Label;
  kind: "2d" | "3d";
  key: string;
  pin: [number, number];
  at: [number, number];
  fx: number;
  fy: number;
}

export class Labels {
  private labels: Label[] = [];
  private readonly overlay: { element: HTMLElement; dispose(): void };
  private readonly lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private readonly elements = new Map<string, HTMLElement>();
  /** Group centres in RAS mm, by group id and answer version. */
  private readonly centres = new Map<string, { version: number; mm?: [number, number, number] }>();
  private groups: TrackGroups | undefined;
  private panelUpdate: (() => void) | undefined;
  private queued = false;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.overlay = ctx.ui.overlay();
    this.lines.classList.add("labels-lines");
    this.overlay.element.append(this.lines);
    this.read();
    this.offs.push(
      ctx.state.onChanged(() => {
        this.read();
        this.schedule();
        this.panelUpdate?.();
      }),
      ctx.viewer.onRendered(() => this.schedule()),
      ctx.viewer.onStateChanged(() => this.schedule()),
      ctx.ui.screenshotOverlay((context, canvas) => this.paint(context, canvas)),
    );
    void ctx.services.get<TrackGroups>("trackFiltering.groups").then((groups) => {
      this.groups = groups;
      this.offs.push(
        groups.onChanged(() => {
          this.schedule();
          this.panelUpdate?.();
        }),
      );
      this.schedule();
      this.panelUpdate?.();
    });
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.overlay.dispose();
  }

  private read(): void {
    const raw = this.ctx.state.get<{ labels?: Label[] }>();
    this.labels = Array.isArray(raw?.labels) ? raw.labels : [];
  }

  private write(labels: Label[]): void {
    this.labels = labels;
    // The slice holds the Annotate section's record too (under `annotate`).
    this.ctx.state.set({ ...(this.ctx.state.get<object>() ?? {}), labels });
  }

  private update(id: string, patch: Partial<Label>): void {
    this.write(this.labels.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  add(anchor: Anchor, text: string, colour = "#ffffff"): void {
    const label: Label = {
      id: crypto.randomUUID().slice(0, 8),
      text,
      anchor,
      placement: "side",
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

  /** A label's pin as a global position, when it can be found. */
  private position(label: Label): number[] | undefined {
    const ng = this.ctx.viewer.getState() as { dimensions?: Record<string, [number, string]>; position?: number[]; layers?: unknown[] };
    const anchor = label.anchor;
    if (anchor.kind === "point") return anchor.position;
    if (anchor.kind === "annotation") {
      const layer = (ng.layers as { name?: string; annotations?: Record<string, unknown>[] }[] | undefined)?.find((l) => l.name === anchor.layer);
      const a = layer?.annotations?.find((x) => x.id === anchor.annotation);
      if (a === undefined) return undefined;
      // The middle of its points (a line's middle, a box's or polyline's centre), placed by the layer's transform.
      const own = a as unknown as AnnotationJson;
      const points = own.point ? [own.point] : own.center ? [own.center] : (own.points ?? (own.pointA && own.pointB ? [own.pointA, own.pointB] : []));
      if (points.length === 0) return undefined;
      const toGlobal = toGlobalOf(this.ctx, anchor.layer, rankOf(own));
      const g = points.map((p) => toGlobal(p));
      const position = ng.position ?? [];
      return g[0].map((_, i) => {
        const v = g.reduce((s, p) => s + p[i], 0) / g.length;
        return Number.isFinite(v) ? v : (position[i] ?? 0);
      });
    }
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

  // ---------------------------------------------------------- layout

  /** Every shown label in every panel, in overlay pixels. */
  private layout(): Placed[] {
    const out: Placed[] = [];
    const base = this.overlay.element.getBoundingClientRect();
    const panels = this.ctx.viewer.panels();
    const positions = new Map(this.labels.map((l) => [l.id, l.visible && l.text.trim() !== "" ? this.position(l) : undefined]));
    panels.forEach((panel: ViewPanelInfo, index) => {
      const rect = panel.element.getBoundingClientRect();
      const left = rect.left - base.left;
      const top = rect.top - base.top;
      const side: { label: Label; pin: [number, number]; right: boolean }[] = [];
      for (const label of this.labels) {
        const position = positions.get(label.id);
        if (position === undefined) continue;
        if (label.views !== "both" && label.views !== panel.kind) continue;
        const p = panel.project(position);
        if (p === undefined) continue;
        if (panel.kind === "2d" && label.nearSection && Math.abs(p.depth) > 1) continue;
        if (p.x < 0 || p.y < 0 || p.x > rect.width || p.y > rect.height) continue;
        const pin: [number, number] = [left + p.x, top + p.y];
        const offset = panel.kind === "2d" ? label.offset2d : label.offset3d;
        const key = `${label.id}|${index}`;
        if (label.placement === "side") {
          side.push({ label, pin, right: p.x > rect.width / 2 });
          continue;
        }
        const { fx, fy, gx, gy } = shift(label.placement);
        out.push({ label, kind: panel.kind, key, pin, at: [pin[0] + offset[0] + gx * GAP, pin[1] + offset[1] + gy * GAP], fx, fy });
      }
      for (const right of [false, true]) {
        const column = side.filter((s) => s.right === right);
        if (column.length === 0) continue;
        const ys = stackColumn(
          column.map((s) => s.pin[1]),
          column.map((s) => s.label.size * 1.2 + 6),
          top + MARGIN,
          top + rect.height - MARGIN,
        );
        column.forEach(({ label, pin }, i) => {
          const offset = panel.kind === "2d" ? label.offset2d : label.offset3d;
          const x = right ? left + rect.width - MARGIN : left + MARGIN;
          out.push({ label, kind: panel.kind, key: `${label.id}|${index}`, pin, at: [x + offset[0], ys[i] + offset[1]], fx: right ? -1 : 0, fy: -0.5 });
        });
      }
    });
    return out;
  }

  private place(): void {
    const placed = this.layout();
    const seen = new Set<string>();
    const ns = "http://www.w3.org/2000/svg";
    const marks: SVGElement[] = [];
    for (const { label, kind, key, pin, at, fx, fy } of placed) {
      seen.add(key);
      let element = this.elements.get(key);
      if (element === undefined) {
        element = this.makeElement();
        this.elements.set(key, element);
        this.overlay.element.append(element);
      }
      element.firstChild!.textContent = label.text;
      element.style.font = `500 ${label.size}px/1.2 var(--ui, sans-serif)`;
      element.style.color = label.colour;
      element.style.left = `${at[0]}px`;
      element.style.top = `${at[1]}px`;
      element.style.transform = `translate(${fx * 100}%, ${fy * 100}%)`;
      element.dataset.label = label.id;
      element.dataset.kind = kind;
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", String(pin[0]));
      dot.setAttribute("cy", String(pin[1]));
      dot.setAttribute("r", "3");
      dot.setAttribute("fill", label.colour);
      marks.push(dot);
      // The line runs to the box's nearer side.
      const box = element.getBoundingClientRect();
      const end = lineEnd(pin, at, fx, fy, box.width, box.height);
      if (Math.hypot(end[0] - pin[0], end[1] - pin[1]) > 4) {
        const line = document.createElementNS(ns, "line");
        line.setAttribute("x1", String(pin[0]));
        line.setAttribute("y1", String(pin[1]));
        line.setAttribute("x2", String(end[0]));
        line.setAttribute("y2", String(end[1]));
        line.setAttribute("stroke", label.colour);
        marks.push(line);
      }
    }
    for (const [key, element] of this.elements) {
      if (!seen.has(key)) {
        element.remove();
        this.elements.delete(key);
      }
    }
    this.lines.replaceChildren(...marks);
  }

  /** A label's element: dragging it moves it, its corner resizes it, a double-click puts it back. */
  private makeElement(): HTMLElement {
    const grip = el("span", { class: "label-grip", title: "Drag to resize" });
    const element = el("div", { class: "view-label", title: "Drag to move; double-click to put it back" }, el("span", {}), grip);
    const drag = (e: PointerEvent, resize: boolean) => {
      e.preventDefault();
      e.stopPropagation();
      const label = this.labels.find((l) => l.id === element.dataset.label);
      if (label === undefined) return;
      const start = [e.clientX, e.clientY];
      const offsetKey = element.dataset.kind === "2d" ? "offset2d" : "offset3d";
      const from = label[offsetKey];
      const size = label.size;
      const move = (m: PointerEvent) => {
        const dx = m.clientX - start[0];
        const dy = m.clientY - start[1];
        this.labels = this.labels.map((l) =>
          l.id !== label.id ? l : resize ? { ...l, size: Math.max(8, Math.min(96, size + dx / 4)) } : { ...l, [offsetKey]: [from[0] + dx, from[1] + dy] },
        );
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
    element.addEventListener("pointerdown", (e) => drag(e, false));
    grip.addEventListener("pointerdown", (e) => drag(e, true));
    element.addEventListener("dblclick", () => {
      const id = element.dataset.label;
      if (id) this.update(id, element.dataset.kind === "2d" ? { offset2d: [0, 0] } : { offset3d: [0, 0] });
    });
    return element;
  }

  /** The labels, painted into a screenshot of the viewer's canvas (in its pixels). */
  private paint(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvas.width / Math.max(1, canvasRect.width);
    const base = this.overlay.element.getBoundingClientRect();
    const toCanvas = (p: [number, number]): [number, number] => [(p[0] + base.left - canvasRect.left) * scale, (p[1] + base.top - canvasRect.top) * scale];
    for (const { label, pin, at, fx, fy } of this.layout()) {
      const size = label.size * scale;
      context.font = `500 ${size}px "IBM Plex Sans", system-ui, sans-serif`;
      const pad = 3 * scale;
      const boxW = context.measureText(label.text).width + 2 * pad;
      const boxH = size * 1.2 + 2 * pad;
      const [px, py] = toCanvas(pin);
      const [x0, y0] = toCanvas(at);
      const left = x0 + fx * boxW;
      const top = y0 + fy * boxH;
      const end = lineEnd([px, py], [x0, y0], fx, fy, boxW, boxH);
      context.strokeStyle = label.colour;
      context.fillStyle = label.colour;
      context.lineWidth = Math.max(1, scale);
      if (Math.hypot(end[0] - px, end[1] - py) > 4 * scale) {
        context.beginPath();
        context.moveTo(px, py);
        context.lineTo(end[0], end[1]);
        context.stroke();
      }
      context.beginPath();
      context.arc(px, py, 3 * scale, 0, 2 * Math.PI);
      context.fill();
      context.fillStyle = "rgba(0, 0, 0, 0.55)";
      context.fillRect(left, top, boxW, boxH);
      context.fillStyle = label.colour;
      context.textBaseline = "top";
      context.fillText(label.text, left + pad, top + pad + size * 0.1);
    }
  }

  // ------------------------------------------------------------- panel

  render(host: HTMLElement): Disposer {
    const list = el("div", { class: "labels-list" });
    const atPosition = () => {
      const position = (this.ctx.viewer.getState() as { position?: number[] }).position;
      if (position) this.add({ kind: "point", position: [...position] }, "Label");
    };
    const forGroups = () => {
      const have = new Set(this.labels.flatMap((l) => (l.anchor.kind === "group" ? [l.anchor.group] : [])));
      for (const g of this.groups?.list() ?? []) if (!have.has(g.id)) this.add({ kind: "group", group: g.id }, g.name, g.colour);
    };
    const fromAnnotations = () => {
      const have = new Set(this.labels.flatMap((l) => (l.anchor.kind === "annotation" ? [`${l.anchor.layer}|${l.anchor.annotation}`] : [])));
      const layers = ((this.ctx.viewer.getState() as { layers?: unknown[] }).layers ?? []) as { name: string; annotations?: { id: string; description?: string }[] }[];
      let added = 0;
      for (const layer of layers) {
        for (const a of layer.annotations ?? []) {
          if (!a.description || have.has(`${layer.name}|${a.id}`)) continue;
          this.add({ kind: "annotation", layer: layer.name, annotation: a.id }, a.description);
          added++;
        }
      }
      if (added === 0) this.ctx.ui.toast("No annotations with a description to label: give one a description in its layer's Annotations tab.");
    };
    const groupsButton = el("button", { class: "btn outline small", type: "button", onclick: forGroups }, "+ Track groups") as HTMLButtonElement;
    host.append(
      el(
        "div",
        { class: "labels-actions" },
        el("button", { class: "btn outline small", type: "button", onclick: atPosition }, "+ At the position"),
        groupsButton,
        el("button", { class: "btn outline small", type: "button", onclick: fromAnnotations }, "+ Annotations"),
      ),
      list,
    );
    const draw = () => {
      groupsButton.disabled = (this.groups?.list().length ?? 0) === 0;
      if (this.labels.length === 0) {
        list.replaceChildren(el("p", { class: "empty", title: "Drag a label in a view to move it, or by its corner to resize it." }, "No labels yet."));
        return;
      }
      list.replaceChildren(
        ...this.labels.map((label) => {
          const visible = el("input", { type: "checkbox", "aria-label": "Show" }) as HTMLInputElement;
          visible.checked = label.visible;
          visible.addEventListener("change", () => this.update(label.id, { visible: visible.checked }));
          const text = el("input", { class: "text-input", type: "text", value: label.text, "aria-label": "Text" }) as HTMLInputElement;
          text.addEventListener("change", () => this.update(label.id, { text: text.value }));
          const colour = el("input", { type: "color", value: label.colour, "aria-label": "Colour" }) as HTMLInputElement;
          colour.addEventListener("change", () => this.update(label.id, { colour: colour.value }));
          const placement = el("select", { class: "text-input", "aria-label": "Where" }) as HTMLSelectElement;
          for (const [value, name] of PLACEMENTS) placement.append(el("option", { value }, name));
          placement.value = label.placement;
          placement.addEventListener("change", () => this.update(label.id, { placement: placement.value as Placement, offset2d: [0, 0], offset3d: [0, 0] }));
          const views = el("select", { class: "text-input", "aria-label": "Views" }) as HTMLSelectElement;
          for (const [value, name] of [
            ["both", "2-D and 3-D"],
            ["2d", "2-D only"],
            ["3d", "3-D only"],
          ])
            views.append(el("option", { value }, name));
          views.value = label.views;
          views.addEventListener("change", () => this.update(label.id, { views: views.value as Label["views"] }));
          const size = el("input", { type: "range", min: "8", max: "64", step: "1", value: String(Math.round(label.size)), "aria-label": "Size" }) as HTMLInputElement;
          size.addEventListener("change", () => this.update(label.id, { size: Number(size.value) }));
          const near = el("input", { type: "checkbox", "aria-label": "Only near the section in 2-D" }) as HTMLInputElement;
          near.checked = label.nearSection;
          near.addEventListener("change", () => this.update(label.id, { nearSection: near.checked }));
          const what = label.anchor.kind === "group" ? "track group" : label.anchor.kind === "annotation" ? `annotation in ${label.anchor.layer}` : "point";
          const remove = el("button", { class: "btn icon", type: "button", title: "Remove", "aria-label": "Remove", onclick: () => this.write(this.labels.filter((l) => l.id !== label.id)) }, "×");
          return el(
            "div",
            { class: "label-row" },
            el("div", { class: "label-head" }, visible, text, colour, remove),
            el("div", { class: "label-opts" }, placement, views, el("label", { class: "field check" }, near, el("span", {}, "2-D: only near its section"))),
            el("label", { class: "label-size" }, el("span", {}, "Size"), size, el("span", { class: "type" }, what)),
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

/** Where a leader line from the pin meets a label box: the middle of the box's side nearer the pin. */
export function lineEnd(pin: [number, number], at: [number, number], fx: number, fy: number, width: number, height: number): [number, number] {
  const left = at[0] + fx * width;
  const top = at[1] + fy * height;
  const cx = left + width / 2;
  const cy = top + height / 2;
  const dx = pin[0] - cx;
  const dy = pin[1] - cy;
  if (Math.abs(dx) * height > Math.abs(dy) * width) return [dx < 0 ? left : left + width, cy];
  return [cx, dy < 0 ? top : top + height];
}

export const STYLE = `
.labels-lines { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.labels-lines line { stroke-width: 1; opacity: 0.85; }
.view-label {
  position: absolute; pointer-events: auto; cursor: move; white-space: nowrap; user-select: none;
  padding: 2px 4px; background: rgba(0, 0, 0, 0.55); text-shadow: 0 0 2px #000;
}
.label-grip { position: absolute; right: -3px; bottom: -3px; width: 8px; height: 8px; cursor: nwse-resize; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; opacity: 0; }
.view-label:hover .label-grip { opacity: 0.8; }
.labels-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.labels-list { display: grid; gap: 6px; }
.label-row { border: 1px solid var(--line); padding: 6px; display: grid; gap: 4px; }
.label-head { display: grid; grid-template-columns: auto minmax(0, 1fr) 28px auto; gap: 6px; align-items: center; }
.label-head input[type="color"] { width: 28px; height: 22px; padding: 0; border: 1px solid var(--line); background: none; }
.label-opts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; align-items: center; }
.label-opts .field.check { grid-column: 1 / -1; }
.label-size { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); }
`;
