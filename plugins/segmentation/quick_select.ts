/**
 * Quick select: a box drawn or a point clicked in a view, turned into a
 * mask, as WebKnossos's quick select does (by threshold, or by a model such
 * as Segment Anything).  A method takes the image's values around the
 * prompt, on the label volume's grid, and returns a mask on that grid; the
 * Segmentation section paints it as one stroke.
 *
 * The built-in method thresholds (Otsu's threshold in a box; a tolerance
 * around the value clicked) and keeps the connected part.  Other plugins
 * add methods (a model served elsewhere, say) through the
 * `segmentation.quickSelect` service:
 *
 *     const qs = await ctx.services.get<QuickSelectService>("segmentation.quickSelect");
 *     ctx.subscriptions.push(qs.register({ id: "sam", title: "Segment Anything", prompts: ["box", "point"], run: async (request, signal) => … }));
 */
import { blockValue, type ImageBlock, type Vec3 } from "./kernels.js";

export type Prompt = { kind: "box"; lo: Vec3; hi: Vec3 } | { kind: "point"; at: Vec3 };

export interface QuickSelectRequest {
  prompt: Prompt;
  /** The image's values around the prompt, on the label grid (the box, or the region a point may grow into). */
  image: ImageBlock;
  /** The section's normal axis (0, 1, 2) when the prompt is in a 2-D view; the mask then lies in that section. */
  axis?: number;
  /** For point prompts: how far from the clicked value counts as the same, as a fraction of the image's range in the block. */
  tolerance: number;
}

/** A mask on the label grid: `size` voxels from `lo`, x fastest; 1 is selected. */
export interface Mask {
  lo: Vec3;
  size: Vec3;
  data: Uint8Array;
}

export interface QuickSelectMethod {
  id: string;
  title: string;
  description?: string;
  /** Which prompts it takes. */
  prompts: ("box" | "point")[];
  run(request: QuickSelectRequest, signal: AbortSignal): Promise<Mask>;
}

export interface QuickSelectService {
  register(method: QuickSelectMethod): () => void;
  methods(): QuickSelectMethod[];
}

/** Otsu's threshold of values (NaN left out), over `bins` bins. */
export function otsu(values: ArrayLike<number>, bins = 256): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; ++i) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return lo;
  const hist = new Float64Array(bins);
  let n = 0;
  for (let i = 0; i < values.length; ++i) {
    const v = values[i];
    if (v !== v) continue;
    hist[Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins))]++;
    ++n;
  }
  let sum = 0;
  for (let b = 0; b < bins; ++b) sum += b * hist[b];
  let w0 = 0;
  let sum0 = 0;
  let best = 0;
  let at = 0;
  for (let b = 0; b < bins - 1; ++b) {
    w0 += hist[b];
    sum0 += b * hist[b];
    const w1 = n - w0;
    if (w0 === 0 || w1 === 0) continue;
    const between = w0 * w1 * (sum0 / w0 - (sum - sum0) / w1) ** 2;
    if (between > best) {
      best = between;
      at = b;
    }
  }
  return lo + ((at + 1) / bins) * (hi - lo);
}

/** The connected part (6 neighbours, or 4 in a section) of `selected` containing `seed`; empty when the seed is not selected. */
export function component(selected: Uint8Array, size: Vec3, seed: Vec3): Uint8Array {
  const out = new Uint8Array(selected.length);
  const index = (x: number, y: number, z: number) => x + size[0] * (y + size[1] * z);
  const s = seed.map((v, k) => Math.max(0, Math.min(size[k] - 1, Math.round(v)))) as Vec3;
  if (!selected[index(...s)]) return out;
  const stack = [index(...s)];
  out[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % size[0];
    const y = Math.floor(i / size[0]) % size[1];
    const z = Math.floor(i / (size[0] * size[1]));
    for (const [dx, dy, dz] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]) {
      const X = x + dx;
      const Y = y + dy;
      const Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= size[0] || Y >= size[1] || Z >= size[2]) continue;
      const j = index(X, Y, Z);
      if (out[j] || !selected[j]) continue;
      out[j] = 1;
      stack.push(j);
    }
  }
  return out;
}

/** The built-in method: thresholds, then the connected part at the prompt's middle. */
export const THRESHOLD_SELECT: QuickSelectMethod = {
  id: "threshold",
  title: "Threshold",
  description: "A box: Otsu's threshold inside it, the side its middle is on. A click: values within the tolerance of the one clicked.",
  prompts: ["box", "point"],
  async run(request) {
    const { image, prompt } = request;
    const { lo, size, data } = image;
    const selected = new Uint8Array(data.length);
    let seed: Vec3;
    if (prompt.kind === "box") {
      const t = otsu(data);
      seed = prompt.lo.map((v, k) => Math.floor((v + prompt.hi[k] - 1) / 2) - lo[k]) as Vec3;
      // The side of the threshold the box's middle is on.
      const middle = blockValue(image, seed[0] + lo[0], seed[1] + lo[1], seed[2] + lo[2]);
      const bright = middle >= t;
      for (let i = 0; i < data.length; ++i) selected[i] = data[i] === data[i] && data[i] >= t === bright ? 1 : 0;
    } else {
      seed = prompt.at.map((v, k) => Math.round(v) - lo[k]) as Vec3;
      const v0 = blockValue(image, prompt.at[0], prompt.at[1], prompt.at[2]);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < data.length; ++i) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
      }
      const t = request.tolerance * (max - min);
      for (let i = 0; i < data.length; ++i) selected[i] = Math.abs(data[i] - v0) <= t ? 1 : 0;
    }
    return { lo, size, data: component(selected, size, seed) };
  },
};

/** The methods there are, the built-in one first. */
export class QuickSelectRegistry implements QuickSelectService {
  private list: QuickSelectMethod[] = [THRESHOLD_SELECT];
  private readonly listeners = new Set<() => void>();

  register(method: QuickSelectMethod): () => void {
    this.list = [...this.list.filter((m) => m.id !== method.id), method];
    this.listeners.forEach((l) => l());
    return () => {
      this.list = this.list.filter((m) => m !== method);
      this.listeners.forEach((l) => l());
    };
  }

  methods(): QuickSelectMethod[] {
    return this.list;
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
