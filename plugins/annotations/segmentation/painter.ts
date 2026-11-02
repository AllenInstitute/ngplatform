/**
 * Drawing in the views with the mouse.  While on, the left button in a
 * view belongs to the drawing tool (Neuroglancer does not see it), and
 * everything else stays Neuroglancer's: the wheel moves through sections,
 * keys work, and holding Space gives the left button back to move the view.
 *
 * In a 2-D view the point under the pointer is found from the view's own
 * projection (exact, at once); in the 3-D view it is Neuroglancer's picked
 * point (on a surface or a section).  A ring shows the brush's size in
 * 2-D views, and a dragged box is drawn for quick select.
 */
import type { Disposer, PlatformContext, ViewPanelInfo } from "@ngplatform/sdk";
import { unprojector } from "../geometry.js";

export interface ViewPoint {
  kind: "2d" | "3d";
  /** The global position under the pointer. */
  global: number[];
  /** Pixels from the view's top left. */
  x: number;
  y: number;
  /** For 2-D views: depth through the section per unit of each global dimension, and pixels per unit in its plane. */
  depthPerUnit?: Map<number, number>;
  pixelsPerUnit?: Map<number, number>;
}

export interface PainterHandler {
  down(p: ViewPoint, e: MouseEvent): void;
  drag(p: ViewPoint, e: MouseEvent): void;
  up(): void;
  /** The brush ring's radius in pixels at a point of a 2-D view; undefined for no ring. */
  ring(p: ViewPoint): number | undefined;
  /** Dragging draws a box (quick select) rather than a stroke. */
  boxDrag(): boolean;
}

export class Painter {
  private on = false;
  private space = false;
  private dragging: ViewPanelInfo | undefined;
  private readonly overlay: { element: HTMLElement; dispose(): void };
  private readonly ringElement: HTMLElement;
  private readonly boxElement: HTMLElement;
  private boxStart: [number, number] | undefined;
  private readonly offs: Disposer[] = [];

  constructor(
    private readonly ctx: PlatformContext,
    private readonly handler: PainterHandler,
  ) {
    this.overlay = ctx.ui.overlay();
    this.ringElement = document.createElement("div");
    this.ringElement.className = "an-ring";
    this.boxElement = document.createElement("div");
    this.boxElement.className = "an-box";
    this.overlay.element.append(this.ringElement, this.boxElement);
    const listen = <K extends keyof WindowEventMap>(target: Window | Document, type: K, f: (e: WindowEventMap[K]) => void) => {
      target.addEventListener(type, f as EventListener, true);
      this.offs.push(() => target.removeEventListener(type, f as EventListener, true));
    };
    listen(document, "mousedown", (e) => this.onDown(e));
    listen(window, "mousemove", (e) => this.onMove(e));
    listen(window, "mouseup", () => this.onUp());
    // Clicks after a stroke would select segments in Neuroglancer.
    for (const type of ["click", "dblclick"] as const) {
      listen(document, type, (e) => {
        if (this.on && !this.space && e.button === 0 && this.panelAt(e) !== undefined) {
          e.stopPropagation();
          e.preventDefault();
        }
      });
    }
    listen(window, "keydown", (e) => {
      if (e.key === " " && !isTyping(e.target)) {
        this.space = true;
        this.ringElement.hidden = true;
      }
    });
    listen(window, "keyup", (e) => {
      if (e.key === " ") this.space = false;
    });
    this.hide();
  }

  get active(): boolean {
    return this.on;
  }

  set active(on: boolean) {
    this.on = on;
    if (!on) {
      this.onUp();
      this.hide();
    }
    this.overlay.element.classList.toggle("an-drawing", on);
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.overlay.dispose();
  }

  private hide(): void {
    this.ringElement.hidden = true;
    this.boxElement.hidden = true;
  }

  /** The view under the pointer, if the event is over one. */
  private panelAt(e: MouseEvent): ViewPanelInfo | undefined {
    for (const panel of this.ctx.viewer.panels()) {
      const r = panel.element.getBoundingClientRect();
      if (e.clientX < r.left || e.clientY < r.top || e.clientX > r.right || e.clientY > r.bottom) continue;
      // Over the view itself, or what is drawn over it; not over its corner buttons.
      const target = e.target as Element | null;
      if (target === null || target === panel.element || target === panel.element.querySelector("canvas") || this.overlay.element.contains(target) || target.closest?.(".view-overlay")) return panel;
      if (panel.element.contains(target) && !target.closest("button, input, select, label")) return panel;
    }
    return undefined;
  }

  private point(panel: ViewPanelInfo, e: MouseEvent): ViewPoint | undefined {
    const r = panel.element.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (panel.kind === "3d") {
      const cursor = this.ctx.viewer.cursor();
      return cursor.active ? { kind: "3d", global: cursor.position, x, y } : undefined;
    }
    const position = (this.ctx.viewer.getState() as { position?: number[] }).position;
    if (position === undefined) return undefined;
    const u = unprojector(panel.project, position);
    if (u === undefined) return undefined;
    return {
      kind: "2d",
      global: u.at(x, y),
      x,
      y,
      depthPerUnit: new Map(u.dims.map((d, i) => [d, u.depthPerUnit[i]])),
      pixelsPerUnit: new Map(u.dims.map((d, i) => [d, u.pixelsPerUnit[i]])),
    };
  }

  private onDown(e: MouseEvent): void {
    if (!this.on || this.space || e.button !== 0 || e.ctrlKey || e.metaKey) return;
    const panel = this.panelAt(e);
    if (panel === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const p = this.point(panel, e);
    if (p === undefined) return;
    this.dragging = panel;
    if (this.handler.boxDrag() && panel.kind === "2d") {
      this.boxStart = [e.clientX, e.clientY];
      this.drawBox(e.clientX, e.clientY);
    }
    this.handler.down(p, e);
  }

  private onMove(e: MouseEvent): void {
    if (!this.on) return;
    const panel = this.dragging ?? this.panelAt(e);
    if (panel === undefined || this.space) {
      this.ringElement.hidden = true;
      return;
    }
    const p = this.point(panel, e);
    if (p === undefined) return;
    if (this.dragging !== undefined) {
      if (this.boxStart !== undefined) this.drawBox(e.clientX, e.clientY);
      this.handler.drag(p, e);
    }
    const radius = panel.kind === "2d" ? this.handler.ring(p) : undefined;
    if (radius === undefined || this.boxStart !== undefined) {
      this.ringElement.hidden = true;
      return;
    }
    const base = this.overlay.element.getBoundingClientRect();
    const s = this.ringElement.style;
    s.left = `${e.clientX - base.left}px`;
    s.top = `${e.clientY - base.top}px`;
    s.width = s.height = `${Math.max(2, 2 * radius)}px`;
    this.ringElement.hidden = false;
  }

  private drawBox(x: number, y: number): void {
    const [x0, y0] = this.boxStart!;
    const base = this.overlay.element.getBoundingClientRect();
    const s = this.boxElement.style;
    s.left = `${Math.min(x, x0) - base.left}px`;
    s.top = `${Math.min(y, y0) - base.top}px`;
    s.width = `${Math.abs(x - x0)}px`;
    s.height = `${Math.abs(y - y0)}px`;
    this.boxElement.hidden = false;
  }

  private onUp(): void {
    if (this.dragging === undefined) return;
    this.dragging = undefined;
    this.boxStart = undefined;
    this.boxElement.hidden = true;
    this.handler.up();
  }
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target as HTMLElement | null)?.isContentEditable === true;
}
