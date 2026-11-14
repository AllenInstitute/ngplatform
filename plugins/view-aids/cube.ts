/**
 * The orientation cube: a small cube in the 3-D view's top right, turned
 * as the view is, its faces lettered by the data's sides (R/L, A/P, S/I,
 * else ±x, ±y, ±z), each letter turned by quarters to read upright.  Under the pointer a face, an edge or a corner lights
 * up; a click turns the view to look at it.  Below it, Realign (to the
 * nearest standard view) and Bookmark.
 */
import { el, iconButton } from "@ngplatform/sdk/dom";
import { type Axes, letterBasis, pickCube, type Quat, targetLetters, targetWords, toView, type Vec3, visibleFaces, zoneOnFace } from "./geometry.js";

/** The cube's picture, CSS pixels square, and its half-size in it. */
export const CUBE_SIZE = 64;
const HALF = 18;

/** The direction colours (DESIGN.md dec-x, dec-y, dec-z), by display axis. */
const AXIS_COLOURS = ["#e0574b", "#5cb46c", "#4f88dc"];
/** Faces in the grey steps: lighter as they face the viewer. */
const FACE_GREYS: [number, string][] = [
  [0.8, "#333"],
  [0.45, "#292929"],
  [0, "#1f1f1f"],
];

export interface CubeActions {
  pick(target: Vec3): void;
  realign(): void;
  bookmark(): void;
}

export class OrientationCube {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private q: Quat = [0, 0, 0, 1];
  private axes: Axes | undefined;
  private hover: Vec3 | undefined;
  private drawn = "";

  constructor(private readonly actions: CubeActions) {
    this.canvas = el("canvas", { class: "view-aids-cube-canvas", role: "img", "aria-label": "Orientation cube" }) as HTMLCanvasElement;
    this.canvas.style.width = `${CUBE_SIZE}px`;
    this.canvas.style.height = `${CUBE_SIZE}px`;
    this.element = el(
      "div",
      { class: "view-aids-cube view-aids-control" },
      this.canvas,
      el(
        "div",
        { class: "view-aids-cube-buttons" },
        iconButton("realign", "Realign: turn to the nearest standard view", () => actions.realign()),
        iconButton("bookmark", "Bookmark this view", () => actions.bookmark()),
      ),
    );
    this.canvas.addEventListener("pointermove", (e) => this.setHover(this.pick(e)));
    this.canvas.addEventListener("pointerleave", () => this.setHover(undefined));
    // Neither Neuroglancer nor a camera move in progress should take these.
    this.canvas.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.canvas.addEventListener("click", (e) => {
      const target = this.pick(e);
      if (target !== undefined) this.actions.pick(target);
    });
  }

  /** Shows the view's orientation (drawn again only when it or the axes changed). */
  update(q: Quat, axes: Axes): void {
    this.q = q;
    this.axes = axes;
    this.draw();
  }

  private pick(e: MouseEvent): Vec3 | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left - rect.width / 2) / HALF;
    const sy = (e.clientY - rect.top - rect.height / 2) / HALF;
    return pickCube(this.q, sx, sy);
  }

  private setHover(target: Vec3 | undefined): void {
    if (JSON.stringify(target) === JSON.stringify(this.hover)) return;
    this.hover = target;
    this.canvas.style.cursor = target === undefined ? "" : "pointer";
    this.canvas.title = target === undefined || this.axes === undefined ? "" : `Look from ${targetWords(target, this.axes)} (${targetLetters(target, this.axes)})`;
    this.draw();
  }

  private draw(): void {
    const axes = this.axes;
    if (axes === undefined) return;
    const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
    const key = JSON.stringify([this.q.map((v) => v.toFixed(5)), axes.ends, this.hover, dpr]);
    if (key === this.drawn) return;
    this.drawn = key;
    const size = Math.round(CUBE_SIZE * dpr);
    if (this.canvas.width !== size) {
      this.canvas.width = size;
      this.canvas.height = size;
    }
    const context = this.canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, size, size);
    const c = CUBE_SIZE / 2;
    // Display coordinates (the cube spans −1..1) to the picture's CSS pixels.
    const at = (p: Vec3): [number, number] => {
      const v = toView(this.q, p);
      return [c + v[0] * HALF, c + v[1] * HALF];
    };
    const path = (points: Vec3[]) => {
      context.beginPath();
      points.forEach((p, i) => (i === 0 ? context.moveTo(...at(p)) : context.lineTo(...at(p))));
      context.closePath();
    };
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.lineJoin = "round";
    const faces = visibleFaces(this.q);
    for (const face of faces) {
      path(face.corners);
      context.fillStyle = FACE_GREYS.find(([min]) => face.facing >= min)![1];
      context.fill();
      const zone = this.hover && zoneOnFace(face.normal, this.hover);
      if (zone) {
        path(zone);
        context.fillStyle = "rgba(208, 208, 208, 0.45)";
        context.fill();
      }
    }
    // Letters, written on the faces, turned by quarters to read as upright as they can.
    for (const face of faces) {
      if (face.facing < 0.2) continue;
      const k = face.normal.findIndex((v) => v !== 0);
      const letter = axes.ends[k][face.normal[k] > 0 ? 0 : 1];
      const { right, down } = letterBasis(face.normal, axes);
      const r0 = toView(this.q, right);
      const d0 = toView(this.q, down);
      const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
      const [r, d] = ([
        [r0, d0],
        [d0, neg(r0)],
        [neg(r0), neg(d0)],
        [neg(d0), r0],
      ] as [Vec3, Vec3][]).reduce((best, next) => (next[1][1] > best[1][1] + 1e-6 ? next : best));
      const [ox, oy] = at(face.normal);
      context.save();
      context.setTransform(dpr * r[0], dpr * r[1], dpr * d[0], dpr * d[1], dpr * ox, dpr * oy);
      context.globalAlpha = Math.min(1, (face.facing - 0.2) / 0.3);
      context.fillStyle = "#e6e6e6";
      context.font = `600 ${letter.length > 2 ? 11 : 13}px "Source Sans 3", system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(letter, 0, 0.5);
      context.restore();
    }
    // Edges in the direction colours: an edge along x in dec-x, and so on.
    context.lineWidth = 1.5;
    for (const face of faces) {
      const corners = face.corners;
      for (let i = 0; i < 4; ++i) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        const axis = [0, 1, 2].find((j) => a[j] !== b[j])!;
        context.strokeStyle = AXIS_COLOURS[axis];
        context.beginPath();
        context.moveTo(...at(a));
        context.lineTo(...at(b));
        context.stroke();
      }
    }
  }
}
