/**
 * Momentum for the 3-D view, as Luxar's camera has: let go of a rotation
 * while still moving and the view keeps turning, slowing smoothly to a stop
 * (exponential damping).  The rotation is measured from Neuroglancer's own
 * orientation as the drag moves it, so Neuroglancer's mouse bindings stay
 * as they are; any press, wheel or key stops the glide.  Off unless chosen.
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";

type Quat = [number, number, number, number];

export function multiplyQuat(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

export function conjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function normalise(q: Quat): Quat {
  const l = Math.hypot(...q) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** A rotation as an axis times its angle (radians). */
export function toRotationVector(q: Quat): [number, number, number] {
  let [x, y, z, w] = normalise(q);
  if (w < 0) [x, y, z, w] = [-x, -y, -z, -w];
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(s, w);
  return [(x / s) * angle, (y / s) * angle, (z / s) * angle];
}

export function fromRotationVector(v: [number, number, number]): Quat {
  const angle = Math.hypot(...v);
  if (angle < 1e-12) return [0, 0, 0, 1];
  const s = Math.sin(angle / 2) / angle;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(angle / 2)];
}

/** Velocity left after `ms` of damping, at Luxar's rate (a quarter lost per 60 Hz frame). */
export function damped(velocity: number, ms: number): number {
  return velocity * Math.pow(0.75, ms / (1000 / 60));
}

export class Momentum {
  private on = false;
  private samples: { t: number; q: Quat }[] = [];
  private dragging = false;
  private glide: number | undefined;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {}

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (on) this.listen();
    else this.unlisten();
  }

  private orientation(): Quat | undefined {
    const q = (this.ctx.viewer.getState() as { projectionOrientation?: number[] }).projectionOrientation;
    return Array.isArray(q) && q.length === 4 ? (q as Quat) : [0, 0, 0, 1];
  }

  private in3d(event: Event): boolean {
    const target = event.target as Node | null;
    return this.ctx.viewer.panels().some((p) => p.kind === "3d" && target !== null && p.element.contains(target));
  }

  private listen(): void {
    const down = (e: PointerEvent) => {
      this.stop();
      if (!this.in3d(e)) return;
      this.dragging = true;
      this.samples = [];
    };
    const up = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.start();
    };
    const stop = () => this.stop();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("wheel", stop, true);
    window.addEventListener("keydown", stop, true);
    this.offs.push(
      () => window.removeEventListener("pointerdown", down, true),
      () => window.removeEventListener("pointerup", up, true),
      () => window.removeEventListener("wheel", stop, true),
      () => window.removeEventListener("keydown", stop, true),
      this.ctx.viewer.onStateChanged(() => {
        if (!this.dragging) return;
        const q = this.orientation();
        if (q === undefined) return;
        const t = performance.now();
        this.samples.push({ t, q });
        // The last tenth of a second says how fast it was turning when let go.
        while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
      }),
    );
  }

  private unlisten(): void {
    this.stop();
    this.offs.splice(0).forEach((off) => off());
  }

  /** Keeps turning at the speed of the drag's last moments, slowing down. */
  private start(): void {
    const s = this.samples;
    if (s.length < 2) return;
    const first = s[0];
    const last = s[s.length - 1];
    const since = performance.now() - last.t;
    const dt = last.t - first.t;
    // Held still before letting go: no glide.
    if (dt < 8 || since > 60) return;
    const delta = toRotationVector(multiplyQuat(last.q, conjugate(first.q)));
    let velocity: [number, number, number] = [delta[0] / dt, delta[1] / dt, delta[2] / dt];
    if (Math.hypot(...velocity) < 1e-5) return;
    let previous = performance.now();
    const step = () => {
      const now = performance.now();
      const ms = Math.min(now - previous, 50);
      previous = now;
      const q = this.orientation();
      if (q === undefined) return;
      const turn = fromRotationVector([velocity[0] * ms, velocity[1] * ms, velocity[2] * ms]);
      const next = normalise(multiplyQuat(turn, q));
      const factor = damped(1, ms);
      velocity = [velocity[0] * factor, velocity[1] * factor, velocity[2] * factor];
      // Quietly: the glide finishes the drag, one undo step with it.
      this.ctx.viewer.patchState(
        (ng) => {
          ng.projectionOrientation = next;
        },
        { quiet: true },
      );
      if (Math.hypot(...velocity) < 2e-5) {
        this.glide = undefined;
        return;
      }
      this.glide = requestAnimationFrame(step);
    };
    this.glide = requestAnimationFrame(step);
  }

  private stop(): void {
    if (this.glide !== undefined) cancelAnimationFrame(this.glide);
    this.glide = undefined;
  }

  dispose(): void {
    this.unlisten();
  }
}
