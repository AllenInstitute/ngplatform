/**
 * What the panel lets one request ask of the render service, as the service
 * limits it (`runner/ngplatform_render/server.py`), and how the frame loop
 * waits after an error: pure, so they are tested on their own.
 */

/** A frame's side in pixels, samples per pixel, frames a second, crop boxes, and a still's pixels × samples. */
export const LIMITS = {
  minSide: 8,
  maxSide: 8192,
  maxSamples: 4096,
  maxFps: 120,
  maxBoxes: 8,
  stillWork: 8192 * 8192 * 256,
} as const;

/** A whole number within lo..hi (lo for what is not a number). */
export function clampInt(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;
}

/** A movie's side: whole, within the limits, and even (H.264 needs even sides), rounded down. */
export function evenSide(v: number): number {
  const n = clampInt(v, LIMITS.minSide, LIMITS.maxSide);
  return n - (n % 2);
}

export interface MovieSettings {
  fps: number;
  width: number;
  height: number;
  samples: number;
}

/** Movie settings as the service takes them: even sides, whole fps and samples within the limits. */
export function movieSettings<T extends MovieSettings>(m: T): T {
  return { ...m, fps: clampInt(m.fps, 1, LIMITS.maxFps), width: evenSide(m.width), height: evenSide(m.height), samples: clampInt(m.samples, 1, LIMITS.maxSamples) };
}

/** Why a still of this size and samples cannot be made, or undefined when it can. */
export function stillProblem(width: number, height: number, samples: number): string | undefined {
  if (width * height * samples <= LIMITS.stillWork) return undefined;
  return `A ${width} × ${height} still at ${samples} samples is too large: use fewer samples or a smaller size.`;
}

/**
 * The step of a window's sliders over an image's values lo..hi: a thousandth
 * of the range, rounded to 1, 2 or 5 times a power of ten; whole numbers at
 * least 1 for an integer image, any size for a float one (0..1 values).
 */
export function windowStep(lo: number, hi: number, dtype?: string): number {
  const range = hi - lo;
  const float = dtype !== undefined && dtype.startsWith("float");
  if (!(range > 0) || !Number.isFinite(range)) return float ? 0.001 : 1;
  const raw = range / 1000;
  const p = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw * 0.999) ?? raw;
  return float ? nice : Math.max(1, Math.round(nice));
}

/** Waits (ms) after each failed frame poll in a row; after the last, the loop stops and says so. */
export const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/** How long to wait after `failures` failed polls in a row (from 1); undefined: stop. */
export function retryDelay(failures: number): number | undefined {
  return failures >= 1 && failures <= RETRY_MS.length ? RETRY_MS[failures - 1] : undefined;
}
