/**
 * In-view tools: shapes with handles drawn over Neuroglancer's 2-D and 3-D
 * views (the plugins' `views` API, ViewToolsApi in ../sdk/types.ts).
 *
 * Additive to Neuroglancer: a canvas over each view panel (in the views'
 * overlay, never in captures, which read Neuroglancer's own canvas),
 * redrawn after each frame Neuroglancer draws; pointer and wheel listeners
 * on the panels, in the capture phase, that take an event only when it
 * lands on a handle (or a selected shape), else leave it to Neuroglancer
 * untouched; edits go back to the plugins, which write their state.
 *
 * Geometry is in display coordinates (the three displayed global
 * dimensions); the maths is in ../core/view_geometry.ts.
 */
import {
  add,
  arcball,
  axis,
  axisDelta,
  boxCorners,
  BOX_EDGES,
  boxSection,
  convexOrder,
  cross,
  dot,
  ellipsePoints,
  ellipseReach,
  ellipsoidSection,
  insidePolygon,
  jacobian,
  type Mat3,
  norm,
  onSection,
  planeFrame,
  planeSection,
  type Project3,
  rotate,
  scale,
  screenOf,
  type Section,
  sectionDistance,
  sectionOf,
  segmentDistance,
  solve3,
  sub,
  unit,
  type Vec2,
  type Vec3,
  viewPlaneDelta,
} from "../core/view_geometry.js";
import { el, iconButton } from "../sdk/dom.js";
import type { Disposer, ViewPanelInfo, ViewShape, ViewShapeHandle, ViewToolsApi } from "../sdk/types.js";

/** What the tools need of the viewer; the shell supplies it (./apis.ts), tests fake it. */
export interface ViewToolsHost {
  /** An element over the views, for the canvases and the card. */
  overlay(): { element: HTMLElement; dispose(): void };
  panels(): ViewPanelInfo[];
  onRendered(callback: () => void): Disposer;
  /** The global position (the views' centre). */
  position(): number[];
  /** The global position under the mouse, when it is over something in a view. */
  mouse(): number[] | undefined;
}

/** Look (DESIGN.md, "The Instrument Panel"; the surface brief's in-view tools). */
const LOOK = {
  line: 1.5,
  idle: "#a3a3a3",
  accent: "#d0d0d0",
  hover: "#f0f0f0",
  keyline: "#000",
  knob: 7,
  /** Radius of a plane's turning ring, px (3-D; smaller in a 2-D view). */
  ring: 34,
  ring2d: 26,
  font: '11px "Source Sans 3", system-ui, sans-serif',
  text: "#e6e6e6",
};
/** How near a handle or a line the mouse must be to take it, px: a target of 24 px or more (WCAG 2.5.8). */
const REACH = 12;
const LINE_REACH = 6;
/** The least distance between two handles, px. */
const MIN_GAP = 14;
/** A press that moves less than this, px, and is let go soon, is a click. */
const CLICK_SLOP = 4;
const CLICK_MS = 600;
/** The floating card's place in its panel: right of Neuroglancer's axis-label strip. */
const CARD_AT = { left: 36, top: 8 };

type HandleKind = "move" | "corner" | "face" | "radius" | "normal" | "ring";
interface Handle {
  kind: HandleKind;
  x: number;
  y: number;
  /** Corner index (bits: upper along x, y, z); a face's or a radius knob's axis × 2 + side. */
  index?: number;
  /** A radius knob's screen direction from the centre (unit) and its distance. */
  dir?: Vec2;
  reach?: number;
  /** A ring's radius, px. */
  ring?: number;
}

interface Entry {
  key: string;
  owner: string;
  shape: ViewShape;
  order: number;
  /** The panel it was last selected or dragged in: where its card shows. */
  home?: HTMLElement;
}

/** An entry as drawn in a panel: its lines, its area (2-D), its handles; for hit tests. */
interface Drawn {
  entry: Entry;
  lines: { points: Vec2[]; closed: boolean }[];
  area?: Vec2[];
  handles: Handle[];
  /** Screen centre (the move handle's place). */
  centre?: Vec2;
  label?: { at: Vec2; text: string };
  point?: Vec2;
}

/** A panel's projection, read once a frame. */
interface Lens {
  kind: "2d" | "3d";
  width: number;
  height: number;
  /** The global dimensions displayed (−1: none). */
  axes: number[];
  base: number[];
  project: Project3;
  /** The Jacobian where a point is (the same everywhere in a 2-D view). */
  jac(p: Vec3): Mat3 | undefined;
  section?: Section;
}

interface PanelState {
  info: ViewPanelInfo;
  canvas: HTMLCanvasElement;
  lens?: Lens;
  drawn: Drawn[];
  off: Disposer;
  cursor?: string;
}

/** A shape's geometry in display coordinates, as dragged. */
type Geometry = { kind: "point"; p: Vec3 } | { kind: "sphere"; c: Vec3; r: Vec3 } | { kind: "box"; lo: Vec3; hi: Vec3 } | { kind: "plane"; q: Vec3; n: Vec3 };

interface Drag {
  entry: Entry;
  panel: PanelState;
  lens: Lens;
  handle: Handle;
  start: Vec2;
  last: Vec2;
  /** The handle's centre on screen when the drag began (radius knobs and rings turn about it). */
  centre: Vec2;
  /** The panel's top left on the page when the drag began. */
  origin: Vec2;
  g0: Geometry;
  g: Geometry;
  moved: boolean;
}

const finite = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
const shows = (shape: ViewShape, kind: "2d" | "3d") => (shape.views ?? "both") === "both" || shape.views === kind;
const editable = (shape: ViewShape) => shape.editable !== false;

/** Whether the keyboard is in something that takes keys (a field, a menu), so the arrow keys are not the views'. */
function typing(target: Element | null): boolean {
  if (target === null) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target as HTMLElement).isContentEditable === true;
}

export class ViewTools {
  private readonly entries = new Map<string, Entry>();
  private readonly panelStates = new Map<HTMLElement, PanelState>();
  private overlay: { element: HTMLElement; dispose(): void } | undefined;
  private selectedKey: string | undefined;
  private readonly selectListeners = new Set<() => void>();
  private hover: { key: string; handle?: Handle } | undefined;
  private drag: Drag | undefined;
  /** A press not taken: a click if it is let go nearby, soon. */
  private press: { panel: PanelState; x: number; y: number; time: number; select?: string } | undefined;
  private swallowClick = false;
  private picker: { owner: string; onPick: (at: number[], view: "2d" | "3d") => void } | undefined;
  private pointerPanel: PanelState | undefined;
  /** The mouse's last place over a view, on the page. */
  private pointerAt: Vec2 | undefined;
  /** The top left (on the page) of the panel the card is over. */
  private cardPanel: Vec2 | undefined;
  private lastMouse: { panel: PanelState; at: number[] } | undefined;
  private wheelDone: { timer: ReturnType<typeof setTimeout>; finish: () => void } | undefined;
  private card: { key: string; element: HTMLElement; dispose: Disposer | void } | undefined;
  private frame = 0;
  private order = 0;
  private readonly offs: Disposer[] = [];

  constructor(private readonly host: ViewToolsHost) {
    this.offs.push(host.onRendered(() => this.draw()));
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener("keydown", onKey, true);
    this.offs.push(() => window.removeEventListener("keydown", onKey, true));
    const onResize = () => this.redraw();
    window.addEventListener("resize", onResize);
    this.offs.push(() => window.removeEventListener("resize", onResize));
  }

  /** The API one plugin sees: its own shapes, by its own ids. */
  api(owner: string, own: (dispose: Disposer) => Disposer = (d) => d): ViewToolsApi {
    const prefix = `${owner}\u0000`;
    const mine = (key: string | undefined) => (key?.startsWith(prefix) ? key.slice(prefix.length) : undefined);
    return {
      add: (shape) => {
        const key = prefix + shape.id;
        const handle = this.add(key, owner, shape);
        return { update: handle.update, dispose: own(handle.dispose) };
      },
      selected: () => mine(this.selectedKey),
      select: (id) => this.select(id === undefined ? undefined : prefix + id),
      onSelect: (callback) => {
        let last = mine(this.selectedKey);
        const listener = () => {
          const now = mine(this.selectedKey);
          if (now === last) return;
          last = now;
          callback(now);
        };
        this.selectListeners.add(listener);
        return own(() => this.selectListeners.delete(listener));
      },
      pick: (onPick) => {
        const picker = { owner, onPick };
        this.picker = picker;
        this.updateCursors();
        return own(() => {
          if (this.picker === picker) this.picker = undefined;
          this.updateCursors();
        });
      },
      lookingAt: () => this.lookingAt(),
    };
  }

  dispose(): void {
    this.offs.splice(0).forEach((off) => off());
    for (const p of this.panelStates.values()) p.off();
    this.panelStates.clear();
    this.closeCard();
    this.overlay?.dispose();
    this.overlay = undefined;
    cancelAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------- shapes

  private add(key: string, owner: string, shape: ViewShape): ViewShapeHandle {
    this.entries.get(key) && this.remove(key);
    const entry: Entry = { key, owner, shape, order: this.order++ };
    this.entries.set(key, entry);
    this.redraw();
    return {
      update: (patch) => {
        if (this.entries.get(key) !== entry) return;
        entry.shape = { ...entry.shape, ...patch } as ViewShape;
        // An open card stays (it keeps itself up to date); a new `card` is drawn when the shape is next selected.
        if (this.selectedKey === key && this.card !== undefined && patch.label !== undefined) this.card.element.querySelector(".view-card-title")!.textContent = this.title(entry);
        this.redraw();
      },
      dispose: () => {
        if (this.entries.get(key) === entry) this.remove(key);
      },
    };
  }

  private remove(key: string): void {
    this.entries.delete(key);
    if (this.drag?.entry.key === key) this.drag = undefined;
    if (this.hover?.key === key) this.hover = undefined;
    if (this.selectedKey === key) this.select(undefined);
    this.redraw();
  }

  private select(key: string | undefined): void {
    if (key !== undefined && !this.entries.has(key)) key = undefined;
    if (key === this.selectedKey) return;
    this.selectedKey = key;
    this.closeCard();
    if (key !== undefined) this.openCard();
    for (const listener of [...this.selectListeners]) listener();
    this.redraw();
  }

  private title(entry: Entry): string {
    const s = entry.shape;
    return s.label ?? { point: "Point", sphere: "Sphere", box: "Box", plane: "Plane" }[s.kind];
  }

  // --------------------------------------------------------------- card

  private openCard(): void {
    this.closeCard();
    const entry = this.selectedKey === undefined ? undefined : this.entries.get(this.selectedKey);
    if (entry?.shape.card === undefined) return;
    const body = el("div", { class: "view-card-body" });
    const element = el(
      "div",
      { class: "view-card", role: "group", "aria-label": this.title(entry) },
      el("div", { class: "view-card-head" }, el("span", { class: "view-card-title" }, this.title(entry)), iconButton("close", "Close (Esc)", () => this.select(undefined))),
      body,
    );
    // The card's own clicks and keys are not the views'.
    element.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root().append(element);
    this.card = { key: entry.key, element, dispose: entry.shape.card(body) };
    // Laid out first (a shape just added has not been drawn yet), so the card is put where it does not cover it.
    this.cardPanel = undefined;
    this.draw();
  }

  private closeCard(): void {
    if (this.card === undefined) return;
    const { element, dispose } = this.card;
    this.card = undefined;
    dispose?.();
    element.remove();
  }

  /**
   * Puts the card at the top left of a panel its shape is in: the one it
   * was selected in, else the one under the mouse, else a 2-D one; one
   * where the card does not cover the shape when there is a choice.  The
   * panel is chosen when the card opens and when a drag ends, and kept by
   * its place on the page (Neuroglancer may make its panels again).
   */
  private placeCard(choose = false): void {
    const card = this.card;
    if (card === undefined) return;
    const entry = this.entries.get(card.key);
    if (entry === undefined) return;
    const panels = [...this.panelStates.values()].filter((p) => p.info.element.isConnected);
    const rectOf = (p: PanelState) => p.info.element.getBoundingClientRect();
    let panel = choose || this.cardPanel === undefined ? undefined : panels.find((p) => Math.abs(rectOf(p).left - this.cardPanel![0]) < 1 && Math.abs(rectOf(p).top - this.cardPanel![1]) < 1);
    if (panel === undefined) {
      const drawnIn = (p: PanelState) => p.drawn.find((d) => d.entry === entry);
      const ranked = [
        ...panels.filter((p) => p.info.element === entry.home && drawnIn(p)),
        ...panels.filter((p) => p === this.pointerPanel && drawnIn(p)),
        ...panels.filter((p) => p.info.kind === "2d" && drawnIn(p)),
        ...panels.filter((p) => drawnIn(p)),
        ...panels,
      ];
      const box = [CARD_AT.left, CARD_AT.top, CARD_AT.left + card.element.offsetWidth, CARD_AT.top + card.element.offsetHeight];
      const covers = (p: PanelState) => {
        const d = drawnIn(p);
        if (d === undefined) return false;
        const points = [...d.lines.flatMap((l) => l.points), ...d.handles.map((h): Vec2 => [h.x, h.y]), ...(d.point ? [d.point] : [])];
        if (points.length === 0) return false;
        const xs = points.map((q) => q[0]);
        const ys = points.map((q) => q[1]);
        return Math.min(...xs) - REACH < box[2] && Math.max(...xs) + REACH > box[0] && Math.min(...ys) - REACH < box[3] && Math.max(...ys) + REACH > box[1];
      };
      panel = ranked.find((p) => drawnIn(p) && !covers(p)) ?? ranked[0];
      if (panel === undefined) return;
      const r = rectOf(panel);
      this.cardPanel = [r.left, r.top];
    }
    const root = this.root().getBoundingClientRect();
    const rect = rectOf(panel);
    card.element.style.left = `${Math.round(rect.left - root.left + CARD_AT.left)}px`;
    card.element.style.top = `${Math.round(rect.top - root.top + CARD_AT.top)}px`;
  }

  // ------------------------------------------------------------ drawing

  private root(): HTMLElement {
    this.overlay ??= this.host.overlay();
    this.overlay.element.classList.add("view-tools");
    return this.overlay.element;
  }

  /** Draws again on the next animation frame (after a change of a shape, a resize). */
  redraw(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Keeps a canvas and listeners on each panel, and draws every shape into each. */
  private draw(): void {
    const infos = this.entries.size === 0 && this.panelStates.size === 0 ? [] : this.host.panels();
    const seen = new Set<HTMLElement>();
    for (const info of infos) {
      seen.add(info.element);
      const state = this.panelStates.get(info.element);
      if (state === undefined) this.panelStates.set(info.element, this.watch(info));
      else state.info = info;
    }
    for (const [element, state] of this.panelStates) {
      if (seen.has(element) && element.isConnected) continue;
      state.off();
      state.canvas.remove();
      this.panelStates.delete(element);
    }
    if (this.panelStates.size === 0) return;
    const root = this.root();
    const rootRect = root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const state of this.panelStates.values()) {
      const { canvas } = state;
      if (this.entries.size === 0) {
        canvas.hidden = true;
        state.drawn = [];
        continue;
      }
      const rect = state.info.element.getBoundingClientRect();
      canvas.hidden = rect.width === 0 || rect.height === 0;
      if (canvas.hidden) continue;
      if (canvas.parentElement !== root) root.prepend(canvas);
      canvas.style.left = `${rect.left - rootRect.left}px`;
      canvas.style.top = `${rect.top - rootRect.top}px`;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const context = canvas.getContext("2d");
      state.lens = this.lens(state.info, rect.width, rect.height);
      state.drawn = [];
      if (context === null) continue;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, w, h);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const lens = state.lens;
      if (lens === undefined) continue;
      const entries = [...this.entries.values()].sort((a, b) => (a.key === this.selectedKey ? 1 : b.key === this.selectedKey ? -1 : a.order - b.order));
      for (const entry of entries) {
        if (!shows(entry.shape, lens.kind)) continue;
        const drawn = this.layout(entry, lens, entry.key === this.selectedKey);
        if (drawn === undefined) continue;
        state.drawn.push(drawn);
        this.paint(context, drawn);
      }
    }
    this.placeCard();
  }

  /** A canvas over a panel, and the listeners that find its handles. */
  private watch(info: ViewPanelInfo): PanelState {
    const canvas = el("canvas", { class: "view-tools-canvas", "aria-hidden": "true" });
    const state: PanelState = { info, canvas, drawn: [], off: () => {} };
    const element = info.element;
    const down = (e: PointerEvent) => this.onPointerDown(state, e);
    const move = (e: PointerEvent) => this.onHover(state, e);
    const leave = () => {
      // Neuroglancer still has the last place the mouse was over (its own mouseleave comes after).
      const mouse = this.host.mouse();
      if (mouse !== undefined) this.lastMouse = { panel: state, at: mouse };
      if (this.pointerPanel === state) {
        this.pointerPanel = undefined;
        this.pointerAt = undefined;
      }
      this.setHover(undefined, state);
    };
    const wheel = (e: WheelEvent) => this.onWheel(state, e);
    // What follows a press taken by a handle: Neuroglancer's mouse-down (should a browser send it) and click.
    const mouseDown = (e: MouseEvent) => {
      if (this.drag !== undefined) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const click = (e: MouseEvent) => {
      if (!this.swallowClick) return;
      this.swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    };
    element.addEventListener("pointerdown", down, true);
    element.addEventListener("pointermove", move, { passive: true });
    element.addEventListener("pointerleave", leave);
    element.addEventListener("wheel", wheel, { capture: true, passive: false });
    element.addEventListener("mousedown", mouseDown, true);
    element.addEventListener("click", click, true);
    state.off = () => {
      element.removeEventListener("pointerdown", down, true);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("wheel", wheel, true);
      element.removeEventListener("mousedown", mouseDown, true);
      element.removeEventListener("click", click, true);
      if (state.cursor !== undefined) element.style.cursor = "";
    };
    return state;
  }

  /** How a panel projects now: its displayed dimensions, and (2-D) its section. */
  private lens(info: ViewPanelInfo, width: number, height: number): Lens | undefined {
    const base = this.host.position();
    const at = info.project(base);
    if (at === undefined) return undefined;
    // The displayed dimensions: those a step along moves on screen or in depth.
    const axes: number[] = [];
    for (let k = 0; k < base.length && axes.length < 3; ++k) {
      const p = base.slice();
      p[k] += 1;
      const q = info.project(p);
      if (q !== undefined && Math.abs(q.x - at.x) + Math.abs(q.y - at.y) + Math.abs(q.depth - at.depth) > 1e-9) axes.push(k);
    }
    while (axes.length < 3) axes.push(-1);
    const global = (d: Vec3) => {
      const g = base.slice();
      axes.forEach((k, i) => k >= 0 && (g[k] = d[i]));
      return g;
    };
    const b3 = axes.map((k) => (k >= 0 ? base[k] : 0)) as Vec3;
    const direct: Project3 = (d) => info.project(global(d));
    if (info.kind === "3d") return { kind: "3d", width, height, axes, base, project: direct, jac: (p) => jacobian(direct, p) };
    // A 2-D view is orthographic: one Jacobian, and an affine map.
    const j = jacobian(direct, b3);
    if (j === undefined) return undefined;
    const project: Project3 = (d) => {
      const v = sub(d, b3);
      return { x: at.x + j[0] * v[0] + j[1] * v[1] + j[2] * v[2], y: at.y + j[3] * v[0] + j[4] * v[1] + j[5] * v[2], depth: at.depth + j[6] * v[0] + j[7] * v[1] + j[8] * v[2] };
    };
    return { kind: "2d", width, height, axes, base, project, jac: () => j, section: sectionOf(j, b3, [at.x, at.y]) };
  }

  // ---------------------------------------------------- shapes in a lens

  private toDisplay(lens: Lens, g: ArrayLike<number> | undefined, fallback: "base" | "zero" | "last" = "base"): Vec3 {
    return lens.axes.map((k) => {
      if (k < 0) return 0;
      const v = g?.[k];
      if (v !== undefined) return v;
      if (fallback === "zero") return 0;
      if (fallback === "last") return g?.[(g?.length ?? 1) - 1] ?? 1;
      return lens.base[k];
    }) as Vec3;
  }

  /** A display point back in global coordinates, in the shape of `template` (its other dimensions kept). */
  private toGlobal(lens: Lens, d: Vec3, template: readonly number[]): number[] {
    const out = template.slice();
    lens.axes.forEach((k, i) => {
      if (k >= 0 && k < out.length) out[k] = d[i];
    });
    return out;
  }

  private geometry(entry: Entry, lens: Lens): Geometry | undefined {
    const s = entry.shape;
    switch (s.kind) {
      case "point":
        return finite(s.at) ? { kind: "point", p: this.toDisplay(lens, s.at) } : undefined;
      case "sphere":
        return finite(s.centre) && finite(s.radii) ? { kind: "sphere", c: this.toDisplay(lens, s.centre), r: this.toDisplay(lens, s.radii, "last").map(Math.abs) as Vec3 } : undefined;
      case "box": {
        if (!finite(s.lower) || !finite(s.upper)) return undefined;
        const a = this.toDisplay(lens, s.lower);
        const b = this.toDisplay(lens, s.upper);
        return { kind: "box", lo: a.map((v, i) => Math.min(v, b[i])) as Vec3, hi: a.map((v, i) => Math.max(v, b[i])) as Vec3 };
      }
      case "plane": {
        if (!finite(s.point) || !finite(s.normal)) return undefined;
        const n = unit(this.toDisplay(lens, s.normal, "zero"));
        return norm(n) > 0 ? { kind: "plane", q: this.toDisplay(lens, s.point), n } : undefined;
      }
    }
  }

  /** Writes a dragged geometry back into the shape, and the value its plugin is told. */
  private apply(entry: Entry, lens: Lens, g: Geometry): Record<string, number[]> {
    const s = entry.shape;
    let value: Record<string, number[]>;
    if (g.kind === "point" && s.kind === "point") value = { at: this.toGlobal(lens, g.p, s.at) };
    else if (g.kind === "sphere" && s.kind === "sphere") value = { centre: this.toGlobal(lens, g.c, s.centre), radii: this.toGlobal(lens, g.r, s.radii.length >= 3 ? s.radii : [g.r[0], g.r[1], g.r[2]]) };
    else if (g.kind === "box" && s.kind === "box") {
      const lo = g.lo.map((v, i) => Math.min(v, g.hi[i])) as Vec3;
      const hi = g.lo.map((v, i) => Math.max(v, g.hi[i])) as Vec3;
      value = { lower: this.toGlobal(lens, lo, s.lower), upper: this.toGlobal(lens, hi, s.upper) };
    } else if (g.kind === "plane" && s.kind === "plane") value = { point: this.toGlobal(lens, g.q, s.point), normal: this.toGlobal(lens, g.n, s.normal.map(() => 0)) };
    else return {};
    entry.shape = { ...s, ...value } as ViewShape;
    return value;
  }

  private tell(entry: Entry, value: Record<string, number[]>, done: boolean): void {
    try {
      (entry.shape.onChange as ((v: unknown, done: boolean) => void) | undefined)?.(value, done);
    } catch (e) {
      console.error(e);
    }
  }

  /** Where an entry shows in a lens: lines, area, handles; undefined when it does not (a 2-D section that misses it). */
  private layout(entry: Entry, lens: Lens, selected: boolean): Drawn | undefined {
    const g = this.geometry(entry, lens);
    if (g === undefined) return undefined;
    const handles = selected && editable(entry.shape);
    const out: Drawn = { entry, lines: [], handles: [] };
    const screen = (p: Vec3): Vec2 | undefined => {
      const s = lens.project(p);
      return s && [s.x, s.y];
    };
    const polyline = (points: Vec3[], closed: boolean) => {
      // Split where a point is behind the camera.
      let run: Vec2[] = [];
      const runs: Vec2[][] = [];
      for (const p of points) {
        const s = screen(p);
        if (s === undefined) {
          if (run.length > 1) runs.push(run);
          run = [];
        } else run.push(s);
      }
      if (run.length > 1) runs.push(run);
      const whole = runs.length === 1 && runs[0].length === points.length;
      for (const r of runs) out.lines.push({ points: r, closed: closed && whole });
    };
    // A handle too near one placed before it is left out: a shape small on screen keeps its
    // move handle (and its faces before its corners), and is sized with Alt+wheel or its card.
    const handle = (kind: HandleKind, p: Vec3 | Vec2 | undefined, extra: Partial<Handle> = {}) => {
      const s = p === undefined ? undefined : p.length === 2 ? (p as Vec2) : screen(p as Vec3);
      if (s === undefined) return;
      if (kind !== "ring" && out.handles.some((h) => h.kind !== "ring" && Math.hypot(h.x - s[0], h.y - s[1]) < MIN_GAP)) return;
      out.handles.push({ kind, x: s[0], y: s[1], ...extra });
    };
    const section = lens.section;
    const s = entry.shape;

    if (g.kind === "point") {
      if (section !== undefined && Math.abs(sectionDistance(section, g.p)) > 0.5 + 1e-6) return undefined;
      const at = screen(g.p);
      if (at === undefined) return undefined;
      out.point = at;
      out.centre = at;
      if (s.label) out.label = { at, text: s.label };
      if (handles) handle("move", at);
      return out;
    }

    if (g.kind === "sphere") {
      const { c, r } = g;
      if (section === undefined) {
        for (const [i, k] of [
          [0, 1],
          [1, 2],
          [0, 2],
        ]) {
          const points: Vec3[] = [];
          for (let t = 0; t < 48; ++t) {
            const a = (2 * Math.PI * t) / 48;
            points.push(add(c, add(scale(axis(i), r[i] * Math.cos(a)), scale(axis(k), r[k] * Math.sin(a)))));
          }
          polyline(points, true);
        }
        if (out.lines.length === 0) return undefined;
        out.centre = screen(c);
        if (handles) {
          handle("move", c);
          for (let k = 0; k < 3; ++k) {
            for (const side of [1, -1]) {
              const at = screen(add(c, scale(axis(k), side * r[k])));
              if (at === undefined || out.centre === undefined) continue;
              const v: Vec2 = [at[0] - out.centre[0], at[1] - out.centre[1]];
              const reach = Math.hypot(v[0], v[1]);
              if (reach > 10) handle("radius", at, { index: 2 * k + (side > 0 ? 1 : 0), dir: [v[0] / reach, v[1] / reach], reach });
            }
          }
        }
        return out;
      }
      const e = ellipsoidSection(c, r, section);
      if (e === undefined) return undefined;
      const points = ellipsePoints(e, 72);
      out.lines.push({ points, closed: true });
      out.area = points;
      out.centre = e.centre;
      if (handles) {
        handle("move", e.centre);
        const j = lens.jac(c)!;
        const lengths = [0, 1, 2].map((k) => Math.hypot(...screenOf(j, axis(k))));
        const longest = Math.max(...lengths);
        for (let k = 0; k < 3; ++k) {
          if (lengths[k] < 0.2 * longest) continue;
          const [sx, sy] = screenOf(j, axis(k));
          for (const side of [1, -1]) {
            const dir: Vec2 = [(side * sx) / lengths[k], (side * sy) / lengths[k]];
            const reach = ellipseReach(e, dir);
            if (reach > 6) handle("radius", [e.centre[0] + dir[0] * reach, e.centre[1] + dir[1] * reach], { index: 2 * k + (side > 0 ? 1 : 0), dir, reach });
          }
        }
      }
      return out;
    }

    if (g.kind === "box") {
      const { lo, hi } = g;
      const centre = scale(add(lo, hi), 0.5);
      const corners = boxCorners(lo, hi);
      const faces: { k: number; side: number; at: Vec3 }[] = [];
      for (let k = 0; k < 3; ++k) {
        for (const side of [0, 1]) {
          const at: Vec3 = [...centre];
          at[k] = side ? hi[k] : lo[k];
          faces.push({ k, side, at });
        }
      }
      const j = lens.jac(section ? section.origin : centre);
      const lengths = [0, 1, 2].map((k) => (j ? Math.hypot(...screenOf(j, axis(k))) : 0));
      const longest = Math.max(...lengths);
      if (section === undefined) {
        for (const [a, b] of BOX_EDGES) {
          const points: Vec3[] = [];
          for (let t = 0; t <= 8; ++t) points.push(add(corners[a], scale(sub(corners[b], corners[a]), t / 8)));
          polyline(points, false);
        }
        if (out.lines.length === 0) return undefined;
        out.centre = screen(centre);
        if (handles) {
          handle("move", centre);
          for (const f of faces) if (lengths[f.k] >= 0.15 * longest) handle("face", f.at, { index: 2 * f.k + f.side });
          corners.forEach((p, i) => handle("corner", p, { index: i }));
        }
        return out;
      }
      const cut = boxSection(lo, hi, section);
      const polygon = convexOrder(cut.map((p) => screen(p)!));
      if (polygon.length < 3) return undefined;
      out.lines.push({ points: polygon, closed: true });
      out.area = polygon;
      out.centre = screen(onSection(section, centre));
      if (handles) {
        handle("move", out.centre);
        for (const f of faces) if (lengths[f.k] >= 0.15 * longest) handle("face", onSection(section, f.at), { index: 2 * f.k + f.side });
        // Corners along the section's normal fall on one another: the first is kept.
        corners.forEach((p, i) => handle("corner", screen(onSection(section, p)), { index: i }));
      }
      return out;
    }

    // A plane.
    const { q, n } = g;
    const j = lens.jac(q);
    if (j === undefined) return undefined;
    const pixelsPerUnit = Math.max(...[0, 1, 2].map((k) => Math.hypot(...screenOf(j, axis(k))))) || 1;
    const size = s.kind === "plane" && s.size !== undefined && s.size > 0 ? s.size : 160 / pixelsPerUnit;
    const turns = s.kind === "plane" && s.turns !== false;
    if (section === undefined) {
      const [e1, e2] = planeFrame(n);
      const h = size / 2;
      const corners = [add(q, add(scale(e1, h), scale(e2, h))), add(q, add(scale(e1, -h), scale(e2, h))), add(q, add(scale(e1, -h), scale(e2, -h))), add(q, add(scale(e1, h), scale(e2, -h)))];
      const points: Vec3[] = [];
      for (let i = 0; i < 4; ++i) for (let t = 0; t < 8; ++t) points.push(add(corners[i], scale(sub(corners[(i + 1) % 4], corners[i]), t / 8)));
      polyline(points, true);
      // Its normal: the side it faces.
      polyline([q, add(q, scale(n, size * 0.15))], false);
      if (out.lines.length === 0) return undefined;
      out.centre = screen(q);
      if (handles) {
        handle("normal", q);
        if (turns && out.centre) handle("ring", out.centre, { ring: LOOK.ring });
      }
      return out;
    }
    const line = planeSection(q, n, section);
    if (line === undefined) return undefined;
    polyline([add(line.at, scale(line.dir, -size / 2)), add(line.at, scale(line.dir, size / 2))], false);
    out.centre = screen(line.at);
    if (handles && out.centre) {
      handle("normal", out.centre);
      if (turns) handle("ring", out.centre, { ring: LOOK.ring2d });
    }
    return out;
  }

  private paint(context: CanvasRenderingContext2D, d: Drawn): void {
    const selected = d.entry.key === this.selectedKey;
    const hovered = this.hover?.key === d.entry.key;
    const colour = selected ? LOOK.accent : hovered ? LOOK.hover : (d.entry.shape.colour ?? LOOK.idle);
    context.lineJoin = "miter";
    context.lineCap = "butt";
    const trace = (points: Vec2[], closed: boolean) => {
      context.beginPath();
      points.forEach(([x, y], i) => (i === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
      if (closed) context.closePath();
    };
    for (const line of d.lines) {
      trace(line.points, line.closed);
      if (selected) {
        context.strokeStyle = LOOK.keyline;
        context.lineWidth = LOOK.line + 2;
        context.stroke();
      }
      context.strokeStyle = colour;
      context.lineWidth = hovered && !selected ? LOOK.line + 0.5 : LOOK.line;
      context.stroke();
    }
    const knob = (x: number, y: number, size: number, fill: string, hollow = false) => {
      const h = size / 2;
      const left = Math.round(x - h) + 0.5;
      const top = Math.round(y - h) + 0.5;
      context.fillStyle = hollow ? LOOK.keyline : fill;
      context.fillRect(left, top, size, size);
      context.lineWidth = 1;
      context.strokeStyle = hollow ? fill : LOOK.keyline;
      context.strokeRect(left, top, size, size);
    };
    if (d.point !== undefined) {
      const fill = selected ? LOOK.accent : hovered ? LOOK.hover : (d.entry.shape.colour ?? LOOK.idle);
      knob(d.point[0], d.point[1], LOOK.knob, fill);
      if (selected) {
        context.lineWidth = 1;
        context.strokeStyle = LOOK.accent;
        context.strokeRect(Math.round(d.point[0] - 7) + 0.5, Math.round(d.point[1] - 7) + 0.5, 14, 14);
      }
    }
    if (d.label !== undefined) {
      context.font = LOOK.font;
      context.textBaseline = "middle";
      context.lineWidth = 3;
      context.strokeStyle = LOOK.keyline;
      const x = d.label.at[0] + 9;
      const y = d.label.at[1] - 7;
      context.strokeText(d.label.text, x, y);
      context.fillStyle = LOOK.text;
      context.fillText(d.label.text, x, y);
    }
    for (const h of d.handles) {
      const hot = this.hover?.key === d.entry.key && this.hover.handle === h;
      const live = this.drag?.entry === d.entry && this.drag.handle.kind === h.kind && this.drag.handle.index === h.index;
      const fill = hot || live ? LOOK.hover : LOOK.accent;
      if (h.kind === "ring") {
        context.beginPath();
        context.arc(h.x, h.y, h.ring!, 0, 2 * Math.PI);
        context.strokeStyle = LOOK.keyline;
        context.lineWidth = LOOK.line + 2;
        context.stroke();
        context.strokeStyle = fill;
        context.lineWidth = hot || live ? LOOK.line + 0.5 : LOOK.line;
        context.stroke();
        continue;
      }
      const size = hot || live ? LOOK.knob + 2 : LOOK.knob;
      knob(h.x, h.y, size, fill, h.kind === "move" || h.kind === "normal");
    }
  }

  // ------------------------------------------------------------ hit tests

  /** What is under the mouse in a panel: a handle, or a shape's line or area. */
  private hit(state: PanelState, x: number, y: number): { drawn: Drawn; handle?: Handle; part: "handle" | "line" | "area" } | undefined {
    const p: Vec2 = [x, y];
    const byOrder = [...state.drawn].sort((a, b) => (a.entry.key === this.selectedKey ? -1 : b.entry.key === this.selectedKey ? 1 : b.entry.order - a.entry.order));
    for (const d of byOrder) {
      let best: Handle | undefined;
      let bestDistance = Infinity;
      for (const h of d.handles) {
        // A ring is taken anywhere within it (the centre's own handle nearer the middle): from inside it
        // tilts the plane like a trackball, from its rim it turns about the line of sight.
        const fromCentre = Math.hypot(x - h.x, y - h.y);
        const distance = h.kind === "ring" ? (fromCentre <= h.ring! ? 8 : fromCentre - h.ring! + 3) : fromCentre;
        if (distance <= REACH && distance < bestDistance) {
          best = h;
          bestDistance = distance;
        }
      }
      if (best !== undefined) return { drawn: d, handle: best, part: "handle" };
      if (d.point !== undefined && Math.hypot(x - d.point[0], y - d.point[1]) <= REACH) return { drawn: d, part: "line" };
      for (const line of d.lines) {
        const n = line.points.length;
        for (let i = 0; i < n - (line.closed ? 0 : 1); ++i) {
          if (segmentDistance(p, line.points[i], line.points[(i + 1) % n]) <= LINE_REACH) return { drawn: d, part: "line" };
        }
      }
      if (d.area !== undefined && insidePolygon(p, d.area)) return { drawn: d, part: "area" };
    }
    return undefined;
  }

  private local(state: PanelState, e: MouseEvent): Vec2 {
    const rect = state.info.element.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private onHover(state: PanelState, e: PointerEvent): void {
    this.pointerPanel = state;
    this.pointerAt = [e.clientX, e.clientY];
    const mouse = this.host.mouse();
    if (mouse !== undefined) this.lastMouse = { panel: state, at: mouse };
    if (this.drag !== undefined) return;
    if (state.drawn.length === 0) {
      this.setHover(undefined, state);
      return;
    }
    const [x, y] = this.local(state, e);
    const hit = this.hit(state, x, y);
    this.setHover(hit && (hit.part !== "area" || hit.drawn.entry.key === this.selectedKey) ? { key: hit.drawn.entry.key, handle: hit.handle } : undefined, state, hit?.handle?.kind ?? (hit ? "shape" : undefined));
  }

  private setHover(hover: { key: string; handle?: Handle } | undefined, state: PanelState, what?: HandleKind | "shape"): void {
    const same = this.hover?.key === hover?.key && this.hover?.handle === hover?.handle;
    this.hover = hover;
    const cursor = what === undefined ? (this.picker ? "crosshair" : undefined) : what === "move" || what === "shape" ? "move" : "grab";
    this.setCursor(state, cursor);
    if (!same) this.redraw();
  }

  private setCursor(state: PanelState, cursor: string | undefined): void {
    if (state.cursor === cursor) return;
    state.cursor = cursor;
    state.info.element.style.cursor = cursor ?? "";
  }

  private updateCursors(): void {
    for (const state of this.panelStates.values()) if (this.hover === undefined) this.setCursor(state, this.picker ? "crosshair" : undefined);
  }

  // ----------------------------------------------------------- dragging

  private onPointerDown(state: PanelState, e: PointerEvent): void {
    this.press = undefined;
    this.swallowClick = false;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || this.drag !== undefined) return;
    const [x, y] = this.local(state, e);
    const hit = state.drawn.length > 0 ? this.hit(state, x, y) : undefined;
    const entry = hit?.drawn.entry;
    const selected = entry !== undefined && entry.key === this.selectedKey;
    // Taken: a handle, the line of a shape (or a point), or inside the selected shape in a 2-D view.
    const take = hit !== undefined && entry !== undefined && editable(entry.shape) && (hit.part === "handle" || hit.part === "line" || (hit.part === "area" && selected));
    if (!take || state.lens === undefined) {
      this.press = { panel: state, x: e.clientX, y: e.clientY, time: performance.now(), select: entry?.key };
      const up = (u: PointerEvent) => {
        window.removeEventListener("pointerup", up, true);
        this.onRelease(u);
      };
      window.addEventListener("pointerup", up, true);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.swallowClick = true;
    const g = this.geometry(entry, state.lens);
    if (g === undefined) return;
    entry.home = state.info.element;
    if (!selected) this.select(entry.key);
    const handle: Handle = hit.handle ?? { kind: entry.shape.kind === "plane" ? "normal" : "move", x, y };
    const centre = hit.drawn.centre ?? [x, y];
    const rect = state.info.element.getBoundingClientRect();
    this.drag = { entry, panel: state, lens: state.lens, handle, start: [x, y], last: [x, y], centre: [centre[0], centre[1]], origin: [rect.left, rect.top], g0: g, g: structuredClone(g), moved: false };
    this.setCursor(state, handle.kind === "ring" ? "grabbing" : handle.kind === "move" ? "move" : "grabbing");
    const move = (m: PointerEvent) => {
      m.stopPropagation();
      this.onDrag(m);
    };
    const end = (u: PointerEvent) => {
      u.stopPropagation();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      this.endDrag();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }

  /** A press not taken, let go: a click selects the shape under it, or clears the selection, or picks a point. */
  private onRelease(e: PointerEvent): void {
    const press = this.press;
    this.press = undefined;
    if (press === undefined) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP || performance.now() - press.time > CLICK_MS) return;
    if (press.select !== undefined) {
      const entry = this.entries.get(press.select);
      if (entry) entry.home = press.panel.info.element;
      this.select(press.select);
      return;
    }
    if (this.picker !== undefined) {
      const at = this.host.mouse();
      if (at !== undefined) {
        const { onPick } = this.picker;
        try {
          onPick(at, press.panel.info.kind);
        } catch (err) {
          console.error(err);
        }
      }
      return;
    }
    this.select(undefined);
  }

  private onDrag(e: PointerEvent): void {
    const drag = this.drag;
    if (drag === undefined) return;
    // Where the panel was when the drag began: Neuroglancer may make its panels again meanwhile (a state written).
    const now: Vec2 = [e.clientX - drag.origin[0], e.clientY - drag.origin[1]];
    const dx = now[0] - drag.last[0];
    const dy = now[1] - drag.last[1];
    if (!drag.moved && Math.hypot(now[0] - drag.start[0], now[1] - drag.start[1]) < 2) return;
    drag.moved = true;
    drag.last = now;
    const next = this.step(drag, now, dx, dy);
    if (next === undefined) return;
    drag.g = next;
    this.tell(drag.entry, this.apply(drag.entry, drag.lens, next), false);
    this.draw();
  }

  /** The geometry after the mouse moved (dx, dy) to `now`. */
  private step(drag: Drag, now: Vec2, dx: number, dy: number): Geometry | undefined {
    const { lens, handle, g, g0 } = drag;
    const anchor = this.anchor(g, handle);
    const j = lens.jac(anchor);
    if (j === undefined) return undefined;
    const planeMove = () => viewPlaneDelta(j, dx, dy);
    switch (g.kind) {
      case "point":
        return { kind: "point", p: add(g.p, planeMove()) };
      case "sphere": {
        if (handle.kind !== "radius" || g0.kind !== "sphere") return { ...g, c: add(g.c, planeMove()) };
        const reach = (now[0] - drag.centre[0]) * handle.dir![0] + (now[1] - drag.centre[1]) * handle.dir![1];
        const ratio = Math.max(1e-3, reach / handle.reach!);
        const k = handle.index! >> 1;
        const uniform = drag.entry.shape.kind === "sphere" && drag.entry.shape.uniform === true;
        const r = g0.r.map((v, i) => (uniform || i === k ? v * ratio : v)) as Vec3;
        return { ...g, r };
      }
      case "box": {
        const lo: Vec3 = [...g.lo];
        const hi: Vec3 = [...g.hi];
        if (handle.kind === "corner") {
          const d = planeMove();
          for (let k = 0; k < 3; ++k) ((handle.index! >> k) & 1 ? hi : lo)[k] += d[k];
        } else if (handle.kind === "face") {
          const k = handle.index! >> 1;
          const t = axisDelta(j, axis(k), dx, dy);
          (handle.index! & 1 ? hi : lo)[k] += t;
        } else {
          const d = planeMove();
          return { kind: "box", lo: add(lo, d), hi: add(hi, d) };
        }
        return { kind: "box", lo, hi };
      }
      case "plane": {
        if (handle.kind === "ring" && g0.kind === "plane") {
          const from: Vec2 = [drag.start[0] - drag.centre[0], drag.start[1] - drag.centre[1]];
          const to: Vec2 = [now[0] - drag.centre[0], now[1] - drag.centre[1]];
          const turn = arcball(from, to, handle.ring!, lens.kind === "2d");
          // The camera's axes in display coordinates: right, up and towards the viewer.
          const right = unit(viewPlaneDelta(j, 1, 0));
          const up = unit(scale(viewPlaneDelta(j, 0, 1), -1));
          let back = unit(cross(right, up));
          // Towards the viewer is where depth falls.
          if (dot(back, [j[6], j[7], j[8]]) > 0) back = scale(back, -1);
          const m: Mat3 = [right[0], up[0], back[0], right[1], up[1], back[1], right[2], up[2], back[2]];
          const local = solve3(m, g0.n);
          if (local === undefined) return undefined;
          const turned = rotate(local, turn.axis, turn.angle);
          const n = unit(add(add(scale(right, turned[0]), scale(up, turned[1])), scale(back, turned[2])));
          return { kind: "plane", q: g.q, n };
        }
        const t = axisDelta(j, g.n, dx, dy);
        return { kind: "plane", q: add(g.q, scale(g.n, t)), n: g.n };
      }
    }
  }

  /** Where a handle is in the world, for the Jacobian there. */
  private anchor(g: Geometry, handle: Handle): Vec3 {
    switch (g.kind) {
      case "point":
        return g.p;
      case "sphere":
        return g.c;
      case "plane":
        return g.q;
      case "box": {
        const centre = scale(add(g.lo, g.hi), 0.5);
        if (handle.kind === "corner") return boxCorners(g.lo, g.hi)[handle.index!];
        if (handle.kind === "face") {
          const at: Vec3 = [...centre];
          const k = handle.index! >> 1;
          at[k] = handle.index! & 1 ? g.hi[k] : g.lo[k];
          return at;
        }
        return centre;
      }
    }
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (drag === undefined) return;
    this.setCursor(drag.panel, undefined);
    if (drag.moved && this.entries.get(drag.entry.key) === drag.entry) this.tell(drag.entry, this.apply(drag.entry, drag.lens, drag.g), true);
    this.draw();
    this.placeCard(true);
  }

  // ---------------------------------------------------------- wheel, keys

  /** Alt+wheel over the selected sphere or box scales it about its centre. */
  private onWheel(state: PanelState, e: WheelEvent): void {
    if (!e.altKey || e.ctrlKey || this.selectedKey === undefined || state.lens === undefined) return;
    const drawn = state.drawn.find((d) => d.entry.key === this.selectedKey);
    const entry = drawn?.entry;
    if (drawn === undefined || entry === undefined || !editable(entry.shape) || (entry.shape.kind !== "sphere" && entry.shape.kind !== "box")) return;
    const [x, y] = this.local(state, e);
    const points = drawn.area ?? drawn.lines.flatMap((l) => l.points);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const inside = drawn.area ? insidePolygon([x, y], drawn.area) : x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys);
    if (!inside) return;
    e.preventDefault();
    e.stopPropagation();
    const g = this.geometry(entry, state.lens);
    if (g === undefined) return;
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const f = Math.exp(-delta * 0.0015);
    let next: Geometry;
    if (g.kind === "sphere") next = { ...g, r: scale(g.r, f) };
    else if (g.kind === "box") {
      const c = scale(add(g.lo, g.hi), 0.5);
      const half = scale(sub(g.hi, g.lo), 0.5 * f);
      next = { kind: "box", lo: sub(c, half), hi: add(c, half) };
    } else return;
    const lens = state.lens;
    this.tell(entry, this.apply(entry, lens, next), false);
    this.draw();
    this.settleSoon(() => {
      if (this.entries.get(entry.key) === entry) this.tell(entry, this.apply(entry, lens, this.geometry(entry, lens) ?? next), true);
    });
  }

  /** Calls `finish` once the wheel has rested a moment (one undo step for a turn of it). */
  private settleSoon(finish: () => void): void {
    if (this.wheelDone !== undefined) clearTimeout(this.wheelDone.timer);
    this.wheelDone = {
      finish,
      timer: setTimeout(() => {
        this.wheelDone = undefined;
        finish();
      }, 350),
    };
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || this.selectedKey === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector(".scrim") !== null) return;
    const active = document.activeElement;
    const inCard = this.card !== undefined && active !== null && this.card.element.contains(active);
    // The keyboard is the views' when nothing has it, or Neuroglancer's panel does.
    const inView = (a: Element) => [...this.panelStates.values()].some((p) => p.info.element.contains(a) || a.contains(p.info.element));
    const free = active === null || active === document.body || (!typing(active) && inView(active));
    if (e.key === "Escape") {
      // Not a menu's or a field's Escape.
      if (!free && !inCard) return;
      e.preventDefault();
      e.stopPropagation();
      this.select(undefined);
      return;
    }
    const arrows: Record<string, Vec2> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = arrows[e.key];
    // The panel under the mouse (Neuroglancer may have made it again since the mouse came in).
    const at = this.pointerAt;
    const state =
      this.pointerPanel?.info.element.isConnected === true
        ? this.pointerPanel
        : at === undefined
          ? undefined
          : [...this.panelStates.values()].find((p) => {
              const r = p.info.element.getBoundingClientRect();
              return p.info.element.isConnected && at[0] >= r.left && at[0] <= r.right && at[1] >= r.top && at[1] <= r.bottom;
            });
    if (dir === undefined || state?.lens === undefined || inCard || typing(active)) return;
    // Nothing else has the keyboard: the page, or Neuroglancer's panel under the mouse.
    if (!free) return;
    const entry = this.entries.get(this.selectedKey);
    if (entry === undefined || !editable(entry.shape)) return;
    const g = this.geometry(entry, state.lens);
    if (g === undefined) return;
    const j = state.lens.jac(this.anchor(g, { kind: "move", x: 0, y: 0 }));
    if (j === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const stepSize = e.shiftKey ? 10 : 1;
    let next: Geometry;
    if (g.kind === "plane") {
      // Along its normal: right and up move it to the side it faces on screen, or forward.
      const [sx, sy] = screenOf(j, g.n);
      const along = Math.hypot(sx, sy) > 1e-9 ? Math.sign(dir[0] * sx + dir[1] * sy) || 1 : dir[0] + -dir[1];
      next = { kind: "plane", q: add(g.q, scale(g.n, along * stepSize)), n: g.n };
    } else {
      // A unit along the displayed axis that goes most nearly that way on screen.
      let best = 0;
      let bestScore = -Infinity;
      let sign = 1;
      for (let k = 0; k < 3; ++k) {
        const [sx, sy] = screenOf(j, axis(k));
        const len = Math.hypot(sx, sy);
        if (len === 0) continue;
        const score = (sx * dir[0] + sy * dir[1]) / len;
        if (Math.abs(score) > bestScore) {
          bestScore = Math.abs(score);
          best = k;
          sign = Math.sign(score) || 1;
        }
      }
      const d = scale(axis(best), sign * stepSize);
      next = g.kind === "point" ? { kind: "point", p: add(g.p, d) } : g.kind === "sphere" ? { ...g, c: add(g.c, d) } : { kind: "box", lo: add(g.lo, d), hi: add(g.hi, d) };
    }
    this.tell(entry, this.apply(entry, state.lens, next), true);
    this.draw();
  }

  // ------------------------------------------------------------ looking

  /** The place the mouse was last over in a view, while still in sight (on a 2-D view's section now); else the views' centre. */
  lookingAt(): number[] {
    const position = this.host.position();
    const last = this.lastMouse;
    if (last === undefined || !last.panel.info.element.isConnected) return position;
    const rect = last.panel.info.element.getBoundingClientRect();
    const lens = this.lens(last.panel.info, rect.width, rect.height);
    if (lens === undefined) return position;
    let d = this.toDisplay(lens, last.at);
    if (lens.section !== undefined) d = onSection(lens.section, d);
    const s = lens.project(d);
    if (s === undefined || s.x < 0 || s.y < 0 || s.x > rect.width || s.y > rect.height) return position;
    const out = position.slice();
    lens.axes.forEach((k, i) => {
      if (k >= 0) out[k] = d[i];
    });
    return out;
  }
}
