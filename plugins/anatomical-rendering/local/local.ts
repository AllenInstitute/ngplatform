/**
 * The path tracer in the page, on this computer's GPU through WebGPU: for
 * a computer with a GPU of its own and no render service.  It reads one
 * level of the image (8-bit, through the volume view's reader), holds it
 * as a 3-D texture and renders the same views, with the same presets and
 * parameters, as the service's CUDA kernels (./pathtrace.wgsl).
 */
import presetsJson from "../../../runner/ngplatform_render/presets/brain.json";
import organPresetsJson from "../../../runner/ngplatform_render/presets/hipct-organs.json";
import generalPresetsJson from "../../../runner/ngplatform_render/presets/general.json";
import params from "../../../runner/ngplatform_render/params.json";
import { storeHttpUrl } from "../../volume-view/sources.js";
import { VolumeClient } from "../../volume-view/volume_client.js";
import type { ViewSpec } from "../client.js";
import shaderSource from "./pathtrace.wgsl?raw";

// WebGPU's types are not in this TypeScript's DOM library (and @webgpu/types is not installed): loose ones here.
/* eslint-disable @typescript-eslint/no-explicit-any */
type GPU = any;
type GPUAdapter = any;
type GPUDevice = any;
type GPUComputePipeline = any;
type GPUBindGroupLayout = any;
type GPUBindGroup = any;
type GPUTexture = any;
type GPUSampler = any;
type GPUBuffer = any;
const webgpu = globalThis as any;
const GPUBufferUsage = new Proxy({}, { get: (_t, k) => webgpu.GPUBufferUsage[k] }) as Record<string, number>;
const GPUTextureUsage = new Proxy({}, { get: (_t, k) => webgpu.GPUTextureUsage[k] }) as Record<string, number>;
const GPUShaderStage = new Proxy({}, { get: (_t, k) => webgpu.GPUShaderStage[k] }) as Record<string, number>;
const GPUMapMode = new Proxy({}, { get: (_t, k) => webgpu.GPUMapMode[k] }) as Record<string, number>;

export const TF_SIZE = 1024;
const BRICK = 4;

export const OFFSETS: Record<string, number> = {};
export const NPARAMS = (() => {
  let o = 0;
  for (const f of params.fields) {
    OFFSETS[f.name] = o;
    o += f.size;
  }
  return o;
})();

export interface PresetStop {
  value: number;
  color: number[];
  opacity: number;
}
export interface LocalPreset {
  name: string;
  domain: string;
  stops: PresetStop[];
  density: number;
  shade_mix?: number;
  gradient_scale?: number;
  roughness?: number;
  specular?: number;
  surface_inset?: number;
  phase_g?: number;
  albedo?: number;
  exposure?: number;
  light_scale?: number;
  environment?: { top?: number[]; horizon?: number[]; bottom?: number[]; scale?: number };
  modality?: string;
}

/** Every preset the host has: the brain set and the HiP-CT organs (window presets, matched to each scan's histogram). */
export const PRESETS: LocalPreset[] = [...(presetsJson as LocalPreset[]), ...(organPresetsJson as unknown as LocalPreset[]), ...(generalPresetsJson as LocalPreset[])];
const ENV = { top: [0.85, 0.9, 1.0], horizon: [0.55, 0.55, 0.6], bottom: [0.12, 0.11, 0.1], scale: 0.6 };

/** Data values (0..255 here) at percentiles of the tissue: the values above the background's low peak. */
export function tissuePercentiles(data: Uint8Array): Map<number, number> {
  const h = new Float64Array(256);
  for (let i = 0; i < data.length; ++i) h[data[i]]++;
  let peak = 0;
  for (let i = 1; i < 25; ++i) if (h[i] > h[peak]) peak = i;
  let bg = peak;
  while (bg + 1 < 256 && h[bg + 1] <= h[bg]) bg++;
  const t = Float64Array.from(h);
  for (let i = 0; i <= bg; ++i) t[i] = 0;
  let total = t.reduce((a, b) => a + b, 0);
  const use = total > 0 ? t : h;
  if (total === 0) total = h.reduce((a, b) => a + b, 0);
  const out = new Map<number, number>();
  const ps = [0.5, 1, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 98, 99, 99.5, 99.9];
  let acc = 0;
  let k = 0;
  for (let i = 0; i < 256 && k < ps.length; ++i) {
    acc += use[i];
    while (k < ps.length && acc / total >= ps[k] / 100) out.set(ps[k++], i);
  }
  while (k < ps.length) out.set(ps[k++], 255);
  out.set(0, bg + 1);
  return out;
}

/**
 * A window (0..255 here) over the tissue of a specimen in a mounting medium, as the host guesses
 * it (volumes.guess_window): the medium is the commonest value in a ring about the scan's axis,
 * and the window runs from just past it, on the side holding more of what lies inside the ring,
 * to as far again as the tissue's commonest value (which is then at its middle).
 */
export function guessWindow(data: Uint8Array, nx: number, ny: number, nz: number): [number, number] | undefined {
  if (Math.min(nx, ny, nz) < 8) return undefined;
  const ring = new Float64Array(256);
  const inside = new Float64Array(256);
  for (let y = 0; y < ny; y += 2) {
    for (let x = 0; x < nx; x += 2) {
      const r = Math.hypot((y - (ny - 1) / 2) / (ny / 2), (x - (nx - 1) / 2) / (nx / 2));
      if (r >= 0.9) continue;
      const inRing = r > 0.75;
      for (let z = 0; z < nz; z += 2) {
        const v = data[(z * ny + y) * nx + x];
        inside[v]++;
        if (inRing) ring[v]++;
      }
    }
  }
  ring[0] = 0;
  inside[0] = 0;
  const hs = ring.map((_, i) => {
    let a = 0;
    for (let k = i - 2; k <= i + 2; ++k) if (k >= 0 && k < 256) a += ring[k];
    return a / 5;
  });
  let m = 0;
  for (let i = 1; i < 256; ++i) if (hs[i] > hs[m]) m = i;
  if (hs[m] === 0) return undefined;
  let j0 = m;
  while (j0 > 0 && hs[j0] > 0.2 * hs[m]) j0--;
  let j1 = m;
  while (j1 < 255 && hs[j1] > 0.2 * hs[m]) j1++;
  const w = Math.max(m - j0, j1 - m, 1);
  let above = 0;
  let below = 0;
  for (let i = m + w; i < 256; ++i) above += inside[i];
  for (let i = 0; i < m - w; ++i) below += inside[i];
  // Bins from the window's edge to the tissue's commonest value: the largest peak clear of the edge (the
  // medium's tail falls away from it), smoothed over a 40th of the values' range, or else the 99th percentile.
  const middle = (x: Float64Array): number => {
    let last = -1;
    for (let i = 0; i < x.length; ++i) if (x[i] > 0) last = i;
    if (last < 0) return 1;
    const k = Math.max(5, Math.floor((last + 1) / 40)) | 1;
    const hs = new Float64Array(x.length);
    for (let i = 0; i < x.length; ++i) {
      let a = 0;
      for (let j = i - (k >> 1); j <= i + (k >> 1); ++j) if (j >= 0 && j < x.length) a += x[j];
      hs[i] = a / k;
    }
    const top = Math.max(...hs);
    let best = -1;
    let low = Infinity;
    for (let j = 0; j < k - (k >> 1) - 1; ++j) low = Math.min(low, hs[j]);
    for (let i = k; i < hs.length - 1; ++i) {
      low = Math.min(low, hs[i - (k >> 1) - 1]);
      if (hs[i] >= hs[i - 1] && hs[i] > hs[i + 1] && hs[i] > 1.3 * low && hs[i] > 0.05 * top && (best < 0 || hs[i] > hs[best])) best = i;
    }
    if (best < 0) {
      const total = x.reduce((a, b) => a + b, 0);
      let acc = 0;
      best = x.length - 1;
      for (let i = 0; i < x.length; ++i) if ((acc += x[i]) / total >= 0.99) { best = i; break; }
      best = Math.floor(best / 2);
    }
    return Math.max(best, 1);
  };
  if (above >= below && above > 0) return [m + w, m + w + 2 * middle(inside.slice(m + w))];
  if (below > 0) {
    const edge = Math.max(0, m - w);
    return [edge - 2 * middle(inside.slice(0, edge).reverse()), edge];
  }
  return undefined;
}

function interp(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; ++i) if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1] || 1);
  return ys[ys.length - 1];
}

/** The preset's transfer function at TF_SIZE texture values (0..1 = data 0..255). */
export function transferTable(p: LocalPreset, pct: Map<number, number>, window?: [number, number]): Float32Array {
  const keys = [...pct.keys()].sort((a, b) => a - b);
  const w = window ?? [0, 255];
  const toTex = (v: number) =>
    (p.domain === "percentile" ? interp(v, keys, keys.map((k) => pct.get(k)!)) : p.domain === "window" ? w[0] + v * (w[1] - w[0]) : v) / 255;
  const stops = p.stops.map((s) => ({ x: toTex(s.value), c: s.color, a: s.opacity })).sort((a, b) => a.x - b.x);
  const xs = stops.map((s) => s.x);
  const out = new Float32Array(TF_SIZE * 4);
  for (let i = 0; i < TF_SIZE; ++i) {
    const t = i / (TF_SIZE - 1);
    for (let c = 0; c < 3; ++c) out[4 * i + c] = interp(t, xs, stops.map((s) => s.c[c]));
    out[4 * i + 3] = interp(t, xs, stops.map((s) => s.a));
  }
  return out;
}

/**
 * A preset with the view's overrides: a "window" one may carry its window (data values) and the tissue's
 * histogram on the scan it was made on (its values at percentiles 1..99, as stop values); a "data" one's
 * stops are at data values.
 */
export type LevelPreset = LocalPreset & { window?: [number, number] | null; histogram?: number[] | null };

/**
 * The preset's colours and opacities at TF_SIZE values of the level (0..1
 * for 0..255): stops at data values (a preset as the host resolves it, or
 * as tuned) through the reader's window; a "window" preset through its
 * window at data values, else the window guessed here; percentiles of the
 * tissue here.
 */
export function levelTable(preset: LevelPreset, level: Pick<Level8, "range" | "pct" | "window" | "quantiles">): Float32Array {
  const [lo, hi] = level.range;
  const to8 = (v: number) => ((v - lo) / (hi - lo || 1)) * 255;
  const placed = preset.domain === "data" ? preset : levelResolved(preset, level);
  return transferTable({ ...placed, stops: placed.stops.map((s) => ({ ...s, value: to8(s.value) })) }, level.pct);
}

/**
 * The preset with its stops at the image's data values ("data" domain), as
 * the host's `presets.resolved` places them, from the level held here: what
 * the colourmap editor shows and moves.
 */
export function levelResolved(preset: LevelPreset, level: Pick<Level8, "range" | "pct" | "window" | "quantiles">): LevelPreset {
  const [lo, hi] = level.range;
  const from8 = (v: number) => lo + (v / 255) * (hi - lo);
  const keys = [...level.pct.keys()].sort((a, b) => a - b);
  const guess = level.window ?? [0, 255];
  const [w0, w1] = preset.window ?? [from8(guess[0]), from8(guess[1])];
  // Histogram matching (presets._to_texture): the stop's quantile on the preset's scan, then this scan's
  // value there; past either end, the window's scale. Not when the window was set by hand.
  const ref = preset.histogram, mine = level.quantiles;
  const matched = !preset.window && ref && mine && ref.length === mine.length && ref.length > 1 ? { ref, mine } : undefined;
  const at = (v: number): number => {
    if (preset.domain === "percentile") return from8(interp(v, keys, keys.map((k) => level.pct.get(k)!)));
    if (preset.domain !== "window") return v;
    if (matched === undefined) return w0 + v * (w1 - w0);
    const { ref: r, mine: m } = matched;
    if (v <= r[0]) return m[0] + (v - r[0]) * (w1 - w0);
    if (v >= r[r.length - 1]) return m[m.length - 1] + (v - r[r.length - 1]) * (w1 - w0);
    return interp(v, r, m);
  };
  return { ...preset, domain: "data", window: null, histogram: null, stops: preset.stops.map((s) => ({ ...s, value: at(s.value) })) };
}

/**
 * Which side of the mounting medium the tissue is (volumes.window_side): "above" when the window (data)
 * starts nearer the medium's value, the commonest value bar the lowest bin, every 4th voxel.
 */
export function windowSide(data: Uint8Array, size: readonly number[], range: readonly [number, number], window: readonly [number, number]): "above" | "below" {
  const [lo, hi] = range;
  const [nx, ny, nz] = size;
  const bins = new Float64Array(512);
  for (let z = 0; z < nz; z += 4) for (let y = 0; y < ny; y += 4) for (let x = 0, i = (z * ny + y) * nx; x < nx; x += 4, i += 4) {
    const v = lo + ((hi - lo) * data[i]) / 255;
    bins[Math.min(511, Math.max(0, Math.floor(((v - lo) / (hi - lo || 1)) * 512)))]++;
  }
  let k = 1;
  for (let b = 2; b < 512; ++b) if (bins[b] > bins[k]) k = b;
  const m = lo + ((k + 0.5) / 512) * (hi - lo);
  return Math.abs(m - window[0]) <= Math.abs(m - window[1]) ? "above" : "below";
}

/**
 * The tissue's values (data) at percentiles 1..99 (volumes.tissue_quantiles): every 2nd voxel within a
 * ring about the scan's axis, on the tissue's side of the window's edge at the medium, up to three
 * windows past it; undefined with fewer than 1000 such voxels. The level's values are 8-bit, so it counts
 * them in 256 bins and interpolates between ranks as numpy's percentile does.
 */
export function levelQuantiles(data: Uint8Array, size: readonly number[], range: readonly [number, number], window: readonly [number, number]): number[] | undefined {
  const [nx, ny, nz] = size;
  if (Math.min(nx, ny, nz) < 8) return undefined;
  const [lo, hi] = range;
  const [w0, w1] = window;
  const above = windowSide(data, size, range, window) === "above";
  const value = (b: number) => lo + ((hi - lo) * b) / 255;
  const keep = new Uint8Array(256);
  for (let b = 0; b < 256; ++b) {
    const u = (value(b) - w0) / (w1 - w0 || 1);
    keep[b] = (above ? u > 0.1 && u < 3 : u < 0.9 && u > -2) ? 1 : 0;
  }
  const X = Math.ceil(nx / 2), Y = Math.ceil(ny / 2);
  const counts = new Float64Array(256);
  for (let z = 0; z < nz; z += 2) {
    for (let y = 0; y < ny; y += 2) {
      const ry = (y / 2 - (Y - 1) / 2) / (Y / 2);
      for (let x = 0, i = (z * ny + y) * nx; x < nx; x += 2, i += 2) {
        const rx = (x / 2 - (X - 1) / 2) / (X / 2);
        if (Math.hypot(ry, rx) < 0.9 && keep[data[i]]) counts[data[i]]++;
      }
    }
  }
  const n = counts.reduce((a, b) => a + b, 0);
  if (n < 1000) return undefined;
  // The value at a rank (0-based) of the voxels kept, sorted.
  const cum = new Float64Array(256);
  let acc = 0;
  for (let b = 0; b < 256; ++b) cum[b] = acc += counts[b];
  const atRank = (k: number) => {
    let b = 0;
    while (b < 255 && cum[b] <= k) b++;
    return value(b);
  };
  return Array.from({ length: 99 }, (_, i) => {
    const pos = ((i + 1) / 100) * (n - 1);
    const f = Math.floor(pos);
    return atRank(f) + (atRank(Math.min(n - 1, f + 1)) - atRank(f)) * (pos - f);
  });
}

/**
 * The level's values in 256 bins, one per 8-bit value, every 2nd voxel, as the host's histogram for
 * the editor: `lo` and `hi` the bins' outer edges, half a step past the data values read as 0 and 255,
 * so each bin is centred on its value.
 */
export function levelHistogram(level: Pick<Level8, "data" | "size" | "range">): { lo: number; hi: number; counts: number[] } {
  const counts = new Array<number>(256).fill(0);
  const [nx, ny, nz] = level.size;
  for (let z = 0; z < nz; z += 2) for (let y = 0; y < ny; y += 2) for (let x = 0, i = (z * ny + y) * nx; x < nx; x += 2, i += 2) counts[level.data[i]]++;
  const half = (level.range[1] - level.range[0]) / 255 / 2;
  return { lo: level.range[0] - half, hi: level.range[1] + half, counts };
}

// ------------------------------------------------------------------ 4x4 (row-major) helpers
type M = number[];
export const mul = (a: M, b: M): M => {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) for (let k = 0; k < 4; ++k) o[4 * r + c] += a[4 * r + k] * b[4 * k + c];
  return o;
};
export function invert(m: M): M {
  const a = m.slice();
  const inv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let c = 0; c < 4; ++c) {
    let p = c;
    for (let r = c + 1; r < 4; ++r) if (Math.abs(a[4 * r + c]) > Math.abs(a[4 * p + c])) p = r;
    for (let k = 0; k < 4; ++k) {
      [a[4 * c + k], a[4 * p + k]] = [a[4 * p + k], a[4 * c + k]];
      [inv[4 * c + k], inv[4 * p + k]] = [inv[4 * p + k], inv[4 * c + k]];
    }
    const d = a[4 * c + c];
    for (let k = 0; k < 4; ++k) {
      a[4 * c + k] /= d;
      inv[4 * c + k] /= d;
    }
    for (let r = 0; r < 4; ++r) {
      if (r === c) continue;
      const f = a[4 * r + c];
      for (let k = 0; k < 4; ++k) {
        a[4 * r + k] -= f * a[4 * c + k];
        inv[4 * r + k] -= f * inv[4 * c + k];
      }
    }
  }
  return inv;
}
export const rowMajor = (cm: ArrayLike<number>): M => {
  const o = new Array(16);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) o[4 * r + c] = cm[4 * c + r];
  return o;
};

/** Camera right, up and back (world) from a row-major inverse view-projection. */
export function cameraAxes(inv: M): [number[], number[], number[]] {
  const un = (x: number, y: number, z: number) => {
    const p = [0, 1, 2, 3].map((r) => inv[4 * r] * x + inv[4 * r + 1] * y + inv[4 * r + 2] * z + inv[4 * r + 3]);
    return [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
  };
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
  const norm = (a: number[]) => {
    const l = Math.hypot(...a);
    return a.map((v) => v / l);
  };
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c0 = un(0, 0, -1);
  const fwd = norm(sub(un(0, 0, 1), c0));
  let r = sub(un(1, 0, -1), c0);
  r = norm(r.map((v, i) => v - fwd[i] * dot(r, fwd)));
  const u = [r[1] * fwd[2] - r[2] * fwd[1], r[2] * fwd[0] - r[0] * fwd[2], r[0] * fwd[1] - r[1] * fwd[0]];
  return [r, u, fwd.map((v) => -v)];
}

/** One level of the image at 8 bits, as both renderers in this browser hold it. */
export interface Level8 {
  /** x fastest, then y, then z. */
  data: Uint8Array;
  size: [number, number, number];
  /** Voxel to physical (RAS, mm), row-major. */
  voxelToRas: number[];
  /** The data values 0 and 255 stand for (the reader's window). */
  range: [number, number];
  /** Values (0..255) at percentiles of the tissue, and the window guessed over it, for presets in those domains. */
  pct: Map<number, number>;
  window: [number, number] | undefined;
  /** The tissue's values (data) at percentiles 1..99, for matching a window preset's histogram (`levelQuantiles`). */
  quantiles?: number[];
  /** The level's name in the store. */
  path: string;
}

/**
 * The finest level of the image within `budget` voxels and `maxDim` a side (else the coarsest), read at 8 bits.
 * `url` is the store as the host takes it (gs:// and s3:// kept): read here at its http(s) address.
 */
export async function readLevel(client: VolumeClient, url: string, budget: number, maxDim: number, progress?: (msg: string) => void): Promise<Level8> {
  const http = storeHttpUrl(url.endsWith("/") ? url : `${url}/`);
  if (http === undefined) throw new Error(`${url}: this browser reads stores over http(s), gs:// and s3:// only`);
  // All of the image's values read as 0..255, as the host holds them: the densest tissue not cut off.
  const { levels, window: range } = await client.open([http], undefined, { full: true });
  const fits = levels.filter((l) => l.size[0] * l.size[1] * l.size[2] <= budget && Math.max(...l.size) <= maxDim);
  const levelIndex = fits.length ? levels.indexOf(fits[0]) : levels.length - 1;
  const level = levels[levelIndex];
  progress?.(`reading level ${level.path} (${level.size.join(" × ")})`);
  const { data, size } = await client.volume(levelIndex, (d, t) => progress?.(`reading level ${level.path}: ${d}/${t} chunks`));
  const span = range ?? [0, 255];
  const window = guessWindow(data, size[0], size[1], size[2]);
  const from8 = (v: number) => span[0] + (v / 255) * (span[1] - span[0]);
  const quantiles = window && levelQuantiles(data, size, span, [from8(window[0]), from8(window[1])]);
  return { data, size, voxelToRas: Array.from(level.voxelToRas), range: span, pct: tissuePercentiles(data), window, quantiles, path: level.path };
}

export interface LocalFrame {
  bitmap: ImageBitmap;
  /** The camera of the view it is a picture of (inverse view-projection, column-major), and the tag the view was set with. */
  camera: number[];
  tag: string;
  depth?: { width: number; height: number; data: Float32Array; version: number };
  samples: number;
  width: number;
  height: number;
  msPerPass: number;
  version: number;
}

/** Whether this page can render with WebGPU. */
export async function webgpuAdapter(): Promise<GPUAdapter | undefined> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu === undefined) return undefined;
  return (await gpu.requestAdapter({ powerPreference: "high-performance" })) ?? undefined;
}

/**
 * Each brick's least and greatest value (0..1), with a voxel of overlap
 * (a brick of `brick`³ voxels and the voxel around it), as pairs in brick
 * order.  It works through the volume a slab of z at a time and lets the
 * page answer between slabs (about 4 M voxels each); `stop` ends it early.
 */
export async function brickBounds(data: Uint8Array, size: readonly number[], brick: number, stop: () => boolean = () => false): Promise<Float32Array> {
  const [nx, ny, nz] = size;
  const g = [Math.ceil(nx / brick), Math.ceil(ny / brick), Math.ceil(nz / brick)];
  const n = g[0] * g[1] * g[2];
  const b = new Float32Array(n * 2);
  for (let i = 0; i < n; ++i) {
    b[2 * i] = 1;
    b[2 * i + 1] = 0;
  }
  const slab = Math.max(1, Math.floor(4e6 / Math.max(1, nx * ny)));
  for (let z0 = 0; z0 < nz; z0 += slab) {
    if (z0 > 0) await new Promise((r) => setTimeout(r, 0));
    if (stop()) return b;
    for (let z = z0; z < Math.min(nz, z0 + slab); ++z) {
      const bz0 = Math.floor(Math.max(0, z - 1) / brick), bz1 = Math.floor(Math.min(nz - 1, z + 1) / brick);
      for (let y = 0; y < ny; ++y) {
        const by0 = Math.floor(Math.max(0, y - 1) / brick), by1 = Math.floor(Math.min(ny - 1, y + 1) / brick);
        const base = (z * ny + y) * nx;
        for (let x = 0; x < nx; ++x) {
          const v = data[base + x] / 255;
          const bx0 = Math.floor(Math.max(0, x - 1) / brick), bx1 = Math.floor(Math.min(nx - 1, x + 1) / brick);
          for (let bz = bz0; bz <= bz1; ++bz)
            for (let by = by0; by <= by1; ++by)
              for (let bx = bx0; bx <= bx1; ++bx) {
                const i = (bz * g[1] + by) * g[0] + bx;
                if (v < b[2 * i]) b[2 * i] = v;
                if (v > b[2 * i + 1]) b[2 * i + 1] = v;
              }
        }
      }
    }
  }
  return b;
}

export class LocalRenderer {
  onFrame: ((f: LocalFrame) => void) | undefined;
  status = "";
  private device: GPUDevice | undefined;
  private pipelines: Record<string, GPUComputePipeline> = {};
  private layout: GPUBindGroupLayout | undefined;
  private tex: GPUTexture | undefined;
  private sampler: GPUSampler | undefined;
  private bounds: GPUBuffer | undefined;
  private maj: GPUBuffer | undefined;
  private nbricks = 0;
  private grid: [number, number, number] = [1, 1, 1];
  private size: [number, number, number] = [1, 1, 1];
  private voxelToRas: M = [];
  private pct = new Map<number, number>();
  /** The guessed window for "window" presets (0..255); the browser keeps its own, not the page's data values. */
  private window: [number, number] | undefined;
  private params: GPUBuffer | undefined;
  private tf: GPUBuffer | undefined;
  private accum: GPUBuffer | undefined;
  private out: GPUBuffer | undefined;
  private depth: GPUBuffer | undefined;
  private uni: GPUBuffer | undefined;
  private W = 0;
  private H = 0;
  private bind: GPUBindGroup | undefined;
  private view: ViewSpec | undefined;
  private tag = "";
  private appliedView: { camera: number[]; tag: string } = { camera: [], tag: "" };
  private version = 0;
  private applied = -1;
  private samples = 0;
  private frameNo = 0;
  private maxSamples = 256;
  private running = false;
  private disposed = false;
  /** The image is on the GPU and views can be rendered. */
  ready = false;
  private client: VolumeClient | undefined;
  adapterName = "";
  /** The level on the GPU, once loaded. */
  level: Level8 | undefined;

  async load(url: string, budget: number, progress?: (msg: string) => void): Promise<string> {
    const adapter = await webgpuAdapter();
    if (adapter === undefined) throw new Error("This browser has no WebGPU adapter.");
    const info = (adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string; description?: string } }).info;
    this.adapterName = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ") || "WebGPU";
    const lim = adapter.limits;
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: Math.min(lim.maxStorageBufferBindingSize, 1 << 30), maxBufferSize: Math.min(lim.maxBufferSize, 1 << 30) },
    });
    this.device = device;
    this.client?.dispose();
    this.client = new VolumeClient();
    const level = await readLevel(this.client, url, budget, device.limits.maxTextureDimension3D, progress);
    const { data, size } = level;
    this.level = level;
    this.size = size;
    this.voxelToRas = level.voxelToRas;
    this.pct = level.pct;
    this.window = level.window;
    // The texture (rows padded to 256 bytes for the copy).
    const [nx, ny, nz] = size;
    this.tex = device.createTexture({ size: [nx, ny, nz], dimension: "3d", format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const row = Math.ceil(nx / 256) * 256;
    if (row === nx) device.queue.writeTexture({ texture: this.tex }, data, { bytesPerRow: nx, rowsPerImage: ny }, [nx, ny, nz]);
    else {
      const padded = new Uint8Array(row * ny * nz);
      for (let z = 0; z < nz; ++z) for (let y = 0; y < ny; ++y) padded.set(data.subarray((z * ny + y) * nx, (z * ny + y + 1) * nx), (z * ny + y) * row);
      device.queue.writeTexture({ texture: this.tex }, padded, { bytesPerRow: row, rowsPerImage: ny }, [nx, ny, nz]);
    }
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    // Bricks' least and greatest values, with a voxel of overlap: in slabs, so the page goes on answering.
    const g: [number, number, number] = [Math.ceil(nx / BRICK), Math.ceil(ny / BRICK), Math.ceil(nz / BRICK)];
    this.grid = g;
    this.nbricks = g[0] * g[1] * g[2];
    progress?.("finding empty space");
    const b = await brickBounds(data, size, BRICK, () => this.disposed);
    if (this.disposed) throw new Error("closed");
    this.bounds = device.createBuffer({ size: b.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.bounds, 0, b);
    this.maj = device.createBuffer({ size: this.nbricks * 4, usage: GPUBufferUsage.STORAGE });
    this.params = device.createBuffer({ size: NPARAMS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.tf = device.createBuffer({ size: TF_SIZE * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.uni = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.compile(device);
    this.applied = -1;
    this.ready = true;
    return `level ${level.path} (${size.join(" × ")}) on ${this.adapterName}`;
  }

  private compile(device: GPUDevice): void {
    const consts = `const TF_SIZE: u32 = ${TF_SIZE}u;\n` + Object.entries(OFFSETS).map(([k, v]) => `const P_${k}: u32 = ${v}u;`).join("\n") + "\n";
    const module = device.createShaderModule({ code: consts + shaderSource });
    const S = GPUShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: S, texture: { sampleType: "float", viewDimension: "3d" } },
        { binding: 2, visibility: S, sampler: { type: "filtering" } },
        { binding: 3, visibility: S, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: S, buffer: { type: "storage" } },
        { binding: 5, visibility: S, buffer: { type: "storage" } },
        { binding: 6, visibility: S, buffer: { type: "storage" } },
        { binding: 7, visibility: S, buffer: { type: "storage" } },
        { binding: 8, visibility: S, buffer: { type: "read-only-storage" } },
        { binding: 9, visibility: S, buffer: { type: "uniform" } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    for (const entryPoint of ["trace", "firsthit", "majorant", "tonemap"]) {
      this.pipelines[entryPoint] = device.createComputePipeline({ layout, compute: { module, entryPoint } });
    }
  }

  private resize(W: number, H: number): void {
    const device = this.device!;
    if (W === this.W && H === this.H && this.accum) return;
    this.accum?.destroy();
    this.out?.destroy();
    this.depth?.destroy();
    this.W = W;
    this.H = H;
    this.accum = device.createBuffer({ size: W * H * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.out = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.depth = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.bind = device.createBindGroup({
      layout: this.layout!,
      entries: [
        { binding: 0, resource: { buffer: this.params! } },
        { binding: 1, resource: this.tex!.createView({ dimension: "3d" }) },
        { binding: 2, resource: this.sampler! },
        { binding: 3, resource: { buffer: this.tf! } },
        { binding: 4, resource: { buffer: this.maj! } },
        { binding: 5, resource: { buffer: this.accum } },
        { binding: 6, resource: { buffer: this.out } },
        { binding: 7, resource: { buffer: this.depth } },
        { binding: 8, resource: { buffer: this.bounds! } },
        { binding: 9, resource: { buffer: this.uni! } },
      ],
    });
  }

  /** The view to render; `tag` comes back with its frames. */
  setView(view: ViewSpec, tag = ""): void {
    this.view = view;
    this.tag = tag;
    this.version++;
    this.maxSamples = view.max_samples ?? 256;
    if (!this.running) void this.loop();
  }

  /** The parameter block for a view, as the service's `Renderer._pack` makes it. */
  pack(v: ViewSpec, W: number, H: number): { P: Float32Array; preset: LocalPreset } {
    const O = OFFSETS;
    const P = new Float32Array(NPARAMS);
    const inv = rowMajor(v.inv_view_projection);
    const vp = invert(inv);
    const put = (name: string, vals: ArrayLike<number>) => P.set(Array.from(vals), O[name]);
    const cm = (m: M) => {
      const o = new Array(16);
      for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) o[4 * c + r] = m[4 * r + c];
      return o;
    };
    put("INVVP", cm(inv));
    put("VP", cm(vp));
    const wfp = v.world_from_physical ? rowMajor(v.world_from_physical) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const wfv = mul(wfp, this.voxelToRas);
    const vfw = invert(wfv);
    put("VOX_FROM_WORLD", vfw.slice(0, 12));
    put("WORLD_NORMAL", [vfw[0], vfw[4], vfw[8], vfw[1], vfw[5], vfw[9], vfw[2], vfw[6], vfw[10]]);
    put("DIMS", this.size);
    P[O.BRICK] = BRICK;
    put("MGRID", this.grid);
    const name = typeof v.preset === "string" ? v.preset : String((v.preset as { name?: string }).name ?? "");
    const base = (typeof v.preset === "object" ? (v.preset as unknown as LocalPreset) : PRESETS.find((p) => p.name === name)) ?? PRESETS[0];
    const preset: LocalPreset = { ...base, ...(v.overrides ?? {}) } as LocalPreset;
    P[O.DENSITY] = preset.density * (v.unit_mm ?? 1);
    P[O.SHADE_MIX] = preset.shade_mix ?? 0.8;
    P[O.GRAD_SCALE] = preset.gradient_scale ?? 40;
    P[O.ROUGHNESS] = preset.roughness ?? 0.45;
    P[O.SPECULAR] = preset.specular ?? 0.15;
    P[O.PHASE_G] = preset.phase_g ?? 0;
    P[O.ALBEDO] = preset.albedo ?? 0.9;
    P[O.INSET] = preset.surface_inset ?? 0;
    const [right, up, back] = cameraAxes(inv);
    const ld = v.light?.direction ?? [0.4, 0.7, 0.6];
    let L = v.light?.camera_space === false ? ld : [0, 1, 2].map((i) => ld[0] * right[i] + ld[1] * up[i] + ld[2] * back[i]);
    const ln = Math.hypot(...L);
    L = L.map((x) => x / ln);
    put("LIGHT_DIR", L);
    const ls = preset.light_scale ?? 1;
    put("LIGHT_RGB", (v.light?.rgb ?? [3.2, 3.0, 2.8]).map((x) => x * ls));
    const env = { ...ENV, ...(preset.environment ?? {}) };
    put("ENV_TOP", env.top);
    put("ENV_HORIZON", env.horizon);
    put("ENV_BOTTOM", env.bottom);
    put("ENV_UP", up);
    P[O.ENV_SCALE] = env.scale ?? 1;
    put("BG", v.background ?? [0, 0, 0, 0]);
    P[O.EXPOSURE] = preset.exposure ?? 1;
    P[O.MAX_BOUNCES] = v.max_bounces ?? 4;
    const clips = (v.clips ?? []).slice(0, 6);
    P[O.NCLIP] = clips.length;
    clips.forEach((c, i) => P.set(c, O.CLIPS + 4 * i));
    // This browser's renderer takes one box: the first crop that keeps (crops that cut out are the host's).
    const keepBox = v.boxes?.find((b) => b.keep);
    const crop = v.crop_fraction ?? (keepBox ? ([keepBox.lo, keepBox.hi] as [[number, number, number], [number, number, number]]) : undefined);
    put("CROP_LO", crop ? crop[0].map((f, a) => f * this.size[a] - 0.5) : [-1e9, -1e9, -1e9]);
    put("CROP_HI", crop ? crop[1].map((f, a) => f * this.size[a] - 0.5) : [1e9, 1e9, 1e9]);
    P[O.STEP] = 0.5;
    P[O.APERTURE] = v.aperture ?? 0;
    P[O.FOCUS] = v.focus ?? 0;
    P[O.OPAQUE_LIMIT] = 0.5;
    void W;
    void H;
    return { P, preset };
  }

  private async loop(): Promise<void> {
    this.running = true;
    const device = this.device!;
    let lastPublish = 0;
    let depthOut: LocalFrame["depth"];
    try {
      while (!this.disposed) {
        const v = this.view;
        if (v === undefined) break;
        if (this.applied === this.version && this.samples >= this.maxSamples) break;
        const W = Math.max(8, Math.round(v.width * (v.scale ?? 1)));
        const H = Math.max(8, Math.round(v.height * (v.scale ?? 1)));
        if (this.applied !== this.version) {
          const version = this.version;
          this.resize(W, H);
          const { P, preset } = this.pack(v, W, H);
          device.queue.writeBuffer(this.params!, 0, P);
          device.queue.writeBuffer(this.tf!, 0, levelTable(preset, this.level!));
          device.queue.writeBuffer(this.uni!, 0, new Uint32Array([W, H, 0, 0]));
          const enc = device.createCommandEncoder();
          enc.clearBuffer(this.accum!);
          const pass = enc.beginComputePass();
          pass.setBindGroup(0, this.bind!);
          pass.setPipeline(this.pipelines.majorant);
          pass.dispatchWorkgroups(Math.ceil(this.nbricks / 64));
          pass.setPipeline(this.pipelines.firsthit);
          pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
          pass.end();
          const read = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          enc.copyBufferToBuffer(this.depth!, 0, read, 0, W * H * 4);
          device.queue.submit([enc.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          depthOut = { width: W, height: H, data: new Float32Array(read.getMappedRange().slice(0)), version };
          read.unmap();
          read.destroy();
          void pass;
          this.applied = version;
          this.appliedView = { camera: v.inv_view_projection, tag: this.tag };
          this.samples = 0;
          lastPublish = 0;
        }
        const t = performance.now();
        const n = 1;
        for (let i = 0; i < n; ++i) {
          this.frameNo++;
          this.samples++;
          device.queue.writeBuffer(this.uni!, 0, new Uint32Array([W, H, this.frameNo, this.samples]));
          const enc = device.createCommandEncoder();
          const pass = enc.beginComputePass();
          pass.setBindGroup(0, this.bind!);
          pass.setPipeline(this.pipelines.trace);
          pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
          pass.end();
          device.queue.submit([enc.finish()]);
        }
        await device.queue.onSubmittedWorkDone();
        const ms = (performance.now() - t) / n;
        const s = this.samples;
        if ((s & (s - 1)) === 0 || performance.now() - lastPublish > 250 || s >= this.maxSamples) {
          await this.publish(W, H, ms, depthOut);
          lastPublish = performance.now();
        }
      }
    } catch (e) {
      this.status = `WebGPU: ${(e as Error).message}`;
    } finally {
      this.running = false;
    }
  }

  private async publish(W: number, H: number, ms: number, depth: LocalFrame["depth"]): Promise<void> {
    const device = this.device!;
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, this.bind!);
    pass.setPipeline(this.pipelines.tonemap);
    pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    pass.end();
    const read = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(this.out!, 0, read, 0, W * H * 4);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const px = new Uint8ClampedArray(read.getMappedRange().slice(0));
    read.unmap();
    read.destroy();
    const bitmap = await createImageBitmap(new ImageData(px, W, H), { premultiplyAlpha: "none" });
    this.onFrame?.({ bitmap, depth, ...this.appliedView, samples: this.samples, width: W, height: H, msPerPass: ms, version: this.applied });
  }

  dispose(): void {
    this.disposed = true;
    this.client?.dispose();
    this.tex?.destroy();
    this.device?.destroy();
  }
}
