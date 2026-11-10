/**
 * Momentum for the 3-D view: let go of a drag that was turning it and it
 * keeps turning, slowing down smoothly, as Luxar's and most 3-D viewers'
 * cameras do; a touch or click stops it.  Neuroglancer turns the view as the
 * pointer moves and stops dead on release, which feels stiff with a finger
 * on a touch screen.
 *
 * Measured from the 3-D orientation itself while a pointer is down (so
 * whichever binding turns the view, it works), as the rotation per
 * millisecond over the last few events before release; then that rotation,
 * decaying, applied once a frame.  Not when the system asks for less
 * motion: then the view stops where it is let go.
 */
import { quat } from "neuroglancer/unstable/util/geom.js";

interface Orientation {
  orientation: quat;
  changed: { add(listener: () => void): () => void; dispatch(): void };
}

/** How quickly the turning dies away (ms for it to fall to about a third). */
const DECAY_MS = 320;
/** Only the motion of the last moments before release counts. */
const WINDOW_MS = 90;
/** Slower than this (radians a millisecond) it stops. */
const STOP = 0.00004;

/** Whether the system asks for less motion (Reduce motion, Show animations off). */
export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

export function addMomentum(host: HTMLElement, orientation: Orientation, enabled: () => boolean): () => void {
  let down = false;
  let applying = false;
  let samples: { t: number; q: quat }[] = [];
  let frame: number | undefined;

  const stop = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };

  const onChanged = () => {
    if (!down || applying) return;
    const now = performance.now();
    samples.push({ t: now, q: quat.clone(orientation.orientation) });
    samples = samples.filter((s) => now - s.t <= WINDOW_MS * 2);
  };

  const onDown = () => {
    stop();
    down = true;
    samples = [{ t: performance.now(), q: quat.clone(orientation.orientation) }];
  };

  const onUp = () => {
    if (!down) return;
    down = false;
    const now = performance.now();
    const recent = samples.filter((s) => now - s.t <= WINDOW_MS);
    if (!enabled() || prefersReducedMotion() || recent.length < 2 || now - recent[recent.length - 1].t > 50) return;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return;
    // The turn from first to last, in the world's frame: last = delta · first.
    const delta = quat.multiply(quat.create(), last.q, quat.invert(quat.create(), first.q));
    quat.normalize(delta, delta);
    const axis = new Float32Array(3) as unknown as Parameters<typeof quat.getAxisAngle>[0];
    let angle = quat.getAxisAngle(axis, delta);
    if (angle > Math.PI) angle -= 2 * Math.PI;
    let speed = angle / dt;
    if (Math.abs(speed) < STOP * 4) return;
    let previous = now;
    const step = (t: number) => {
      const elapsed = Math.min(64, t - previous);
      previous = t;
      speed *= Math.exp(-elapsed / DECAY_MS);
      if (Math.abs(speed) < STOP || down) {
        frame = undefined;
        return;
      }
      const turn = quat.setAxisAngle(quat.create(), axis, speed * elapsed);
      applying = true;
      quat.multiply(orientation.orientation, turn, orientation.orientation);
      quat.normalize(orientation.orientation, orientation.orientation);
      orientation.changed.dispatch();
      applying = false;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  const offChanged = orientation.changed.add(onChanged);
  host.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("pointerup", onUp, { capture: true });
  window.addEventListener("pointercancel", onUp, { capture: true });
  host.addEventListener("wheel", stop, { capture: true, passive: true });
  return () => {
    stop();
    offChanged();
    host.removeEventListener("pointerdown", onDown, { capture: true });
    window.removeEventListener("pointerup", onUp, { capture: true });
    window.removeEventListener("pointercancel", onUp, { capture: true });
    host.removeEventListener("wheel", stop, { capture: true });
  };
}
