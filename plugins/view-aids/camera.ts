/**
 * The camera as a bookmark keeps it, and moving the views from one camera
 * to another: eased, the orientations turning by slerp, zooms changing by
 * the same factor each moment; at once when the system asks for less
 * motion.  A move is written to the state frame by frame, so it is one
 * undo step, as a drag is; a click, a wheel or a key in the page stops it.
 */
import type { Json, PlatformContext } from "@ngplatform/sdk";
import { easeInOut, type Quat, readQuat, slerp } from "./geometry.js";

/** What a bookmark restores: the state's navigation keys. */
export interface Camera {
  position?: number[];
  projectionOrientation: Quat;
  projectionScale?: number;
  projectionDepth?: number;
  crossSectionOrientation?: Quat;
  crossSectionScale?: number;
  crossSectionDepth?: number;
  /** The panel layout ("4panel-alt", "3d", or a layout object). */
  layout?: unknown;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A camera from state values (a bookmark as saved, or the state's own keys); undefined parts left out. */
export function readCamera(raw: unknown): Camera {
  const r = (raw ?? {}) as Json;
  const position = Array.isArray(r.position) && r.position.every((v) => typeof v === "number") ? (r.position as number[]).slice() : undefined;
  const camera: Camera = { projectionOrientation: readQuat(r.projectionOrientation) };
  if (position) camera.position = position;
  for (const key of ["projectionScale", "projectionDepth", "crossSectionScale", "crossSectionDepth"] as const) {
    const v = num(r[key]);
    if (v !== undefined) camera[key] = v;
  }
  if (Array.isArray(r.crossSectionOrientation)) camera.crossSectionOrientation = readQuat(r.crossSectionOrientation);
  if (r.layout !== undefined && r.layout !== null) camera.layout = r.layout;
  return camera;
}

/** The camera now, read key by key (cheap: no layers written out). */
export function cameraNow(ctx: PlatformContext): Camera {
  const part = (key: string) => (ctx.viewer.statePart ? ctx.viewer.statePart(key) : (ctx.viewer.getState() as Json)[key]);
  const raw: Json = {};
  for (const key of ["position", "projectionOrientation", "projectionScale", "projectionDepth", "crossSectionOrientation", "crossSectionScale", "crossSectionDepth", "layout"]) raw[key] = part(key);
  return readCamera(raw);
}

/** Geometric interpolation for zooms (scales), linear when either is not positive. */
function between(a: number | undefined, b: number | undefined, t: number): number | undefined {
  if (b === undefined) return undefined;
  if (a === undefined) return t >= 1 ? b : undefined;
  return a > 0 && b > 0 ? a * Math.pow(b / a, t) : a + (b - a) * t;
}

/**
 * The camera a fraction `t` (0 to 1, already eased) of the way from `a` to
 * `b`.  What `b` does not say is left as it is; depths and the layout
 * change at the end (they are not cameras' motion).
 */
export function cameraBetween(a: Camera, b: Camera, t: number): Camera {
  const out: Camera = { projectionOrientation: slerp(a.projectionOrientation, b.projectionOrientation, t) };
  if (b.position !== undefined) {
    out.position =
      a.position !== undefined && a.position.length === b.position.length ? a.position.map((v, i) => v + (b.position![i] - v) * t) : t >= 1 ? b.position.slice() : undefined;
    if (out.position === undefined) delete out.position;
  }
  for (const key of ["projectionScale", "crossSectionScale"] as const) {
    const v = between(a[key], b[key], t);
    if (v !== undefined) out[key] = v;
  }
  if (b.crossSectionOrientation !== undefined) out.crossSectionOrientation = slerp(a.crossSectionOrientation ?? [0, 0, 0, 1], b.crossSectionOrientation, t);
  if (t >= 1) {
    if (b.projectionDepth !== undefined) out.projectionDepth = b.projectionDepth;
    if (b.crossSectionDepth !== undefined) out.crossSectionDepth = b.crossSectionDepth;
  }
  return out;
}

/** Writes a camera's parts into a state (the layout only when asked). */
export function writeCamera(ng: Json, camera: Camera, withLayout: boolean): void {
  for (const [key, value] of Object.entries(camera)) {
    if (key === "layout" && !withLayout) continue;
    if (value !== undefined) ng[key] = Array.isArray(value) ? value.slice() : value;
  }
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Moves the views to a camera over `ms` milliseconds (at once with reduced
 * motion), the layout first.  Resolves true when it got there, false when
 * stopped (by `stop()`, a newer move, or the user's click, wheel or key).
 */
export class CameraMover {
  private frame: number | undefined;
  private finish: ((done: boolean) => void) | undefined;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly ctx: PlatformContext) {
    const stop = (e: Event) => {
      // The aids' own controls start moves; anything else the user does stops one.
      if (e.target instanceof Element && e.target.closest(".view-aids-control")) return;
      this.stop();
    };
    for (const type of ["pointerdown", "wheel", "keydown"] as const) {
      window.addEventListener(type, stop, true);
      this.offs.push(() => window.removeEventListener(type, stop, true));
    }
  }

  get moving(): boolean {
    return this.frame !== undefined;
  }

  /** Where a move under way is going; undefined when none is. */
  get target(): Camera | undefined {
    return this.frame !== undefined ? this.goal : undefined;
  }

  private goal: Camera | undefined;

  to(target: Camera, ms: number): Promise<boolean> {
    this.stop();
    this.goal = target;
    const from = cameraNow(this.ctx);
    const layoutChanges = target.layout !== undefined && JSON.stringify(target.layout) !== JSON.stringify(from.layout);
    const write = (camera: Camera, withLayout: boolean) => this.ctx.viewer.patchState((ng) => writeCamera(ng, camera, withLayout));
    if (ms <= 0 || prefersReducedMotion()) {
      write({ ...cameraBetween(from, target, 1), ...(layoutChanges ? { layout: target.layout } : {}) }, layoutChanges);
      return Promise.resolve(true);
    }
    if (layoutChanges) write({ projectionOrientation: from.projectionOrientation, layout: target.layout }, true);
    const start = performance.now();
    return new Promise<boolean>((resolve) => {
      this.finish = resolve;
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / ms);
        write(cameraBetween(from, target, easeInOut(t)), false);
        if (t >= 1) {
          this.frame = undefined;
          this.finish = undefined;
          resolve(true);
          return;
        }
        this.frame = requestAnimationFrame(step);
      };
      this.frame = requestAnimationFrame(step);
    });
  }

  stop(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    const finish = this.finish;
    this.finish = undefined;
    finish?.(false);
  }

  dispose(): void {
    this.stop();
    this.offs.splice(0).forEach((off) => off());
  }
}
