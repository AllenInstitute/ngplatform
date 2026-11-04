/**
 * What a promptable segmentation model of the Segment Anything family needs
 * around it, as pure functions (the model itself runs in ./sam_worker.ts):
 *
 * - **The crop**: a square of the section (square in millimetres, so a
 *   section with unequal voxel sides is not stretched) round the prompt,
 *   on the label grid; it may reach past the volume's edge (read as 0).
 * - **The model's image**: the crop resampled (bilinear) to the model's
 *   input size, its values mapped through the layer's window to 0 … 255,
 *   in three equal channels (height × width × 3, as MobileSAM's encoder
 *   takes it).
 * - **Prompt coordinates**: label voxels to the model's pixels (points as
 *   pixel indices, whose centres SAM puts at +0.5; boxes by their edges).
 * - **The mask back on the grid**: the decoder's low-resolution logits
 *   (256², over the model's whole input) sampled bilinearly at each label
 *   voxel's centre in the crop, above 0 selected, within the volume; of
 *   its parts, those holding a wanted click are kept (`keepParts`).
 *
 * The section's axes: `u` and `w` are the two voxel axes other than the
 * section's normal, in order (u across the model's image, w down it).
 */
import type { ImageBlock, Vec3 } from "./kernels.js";
import { component, type Mask } from "./quick_select.js";

/** MobileSAM's (and SAM's) input side, and its decoder's low-resolution mask side. */
export const MODEL_SIZE = 1024;
export const LOW_RES = 256;

/** The section's in-plane voxel axes, across the normal `axis`. */
export function sectionAxes(axis: number): [number, number] {
  return [0, 1, 2].filter((k) => k !== axis) as [number, number];
}

/** A square crop of a section: from voxel `lo` (u, w), `size` voxels along u and w, at `index` along `axis`. */
export interface Crop {
  axis: number;
  index: number;
  lo: [number, number];
  size: [number, number];
}

/**
 * The crop for a prompt whose voxels span `lo` … `hi` (u, w; `hi`
 * exclusive): centred on it, at least `context` voxels (of the finer side)
 * across and `margin` times the prompt's longest side, square in
 * millimetres (`spacing`: the voxel's u and w sides), moved inside the
 * section (`extent` voxels along u and w) where it fits.
 */
export function cropFor(axis: number, index: number, lo: [number, number], hi: [number, number], options: { context: number; margin?: number; spacing: [number, number]; extent: [number, number] }): Crop {
  const { context, spacing, extent } = options;
  const margin = options.margin ?? 1.5;
  const fine = Math.min(spacing[0], spacing[1]);
  const span = Math.max((hi[0] - lo[0]) * spacing[0], (hi[1] - lo[1]) * spacing[1]);
  const side = Math.max(context * fine, margin * span);
  const size = spacing.map((s) => Math.max(1, Math.round(side / s))) as [number, number];
  const start = [0, 1].map((k) => {
    const centre = (lo[k] + hi[k]) / 2;
    let a = Math.round(centre - size[k] / 2);
    if (size[k] <= extent[k]) a = Math.max(0, Math.min(extent[k] - size[k], a));
    return a;
  }) as [number, number];
  return { axis, index, lo: start, size };
}

/** Whether a prompt spanning `lo` … `hi` (u, w) sits well inside `crop` (its middle `inner` part), so its embedding serves it. */
export function cropServes(crop: Crop, lo: [number, number], hi: [number, number], inner = 0.8): boolean {
  for (let k = 0; k < 2; ++k) {
    const pad = (crop.size[k] * (1 - inner)) / 2;
    if (lo[k] < crop.lo[k] + pad || hi[k] > crop.lo[k] + crop.size[k] - pad) return false;
  }
  return true;
}

/** The label voxels a crop reads: a box one section thick (`hi` exclusive). */
export function cropBox(crop: Crop): { lo: Vec3; hi: Vec3 } {
  const [u, w] = sectionAxes(crop.axis);
  const lo = [0, 0, 0] as Vec3;
  const hi = [0, 0, 0] as Vec3;
  lo[crop.axis] = crop.index;
  hi[crop.axis] = crop.index + 1;
  lo[u] = crop.lo[0];
  hi[u] = crop.lo[0] + crop.size[0];
  lo[w] = crop.lo[1];
  hi[w] = crop.lo[1] + crop.size[1];
  return { lo, hi };
}

/** The window an image layer shows its values through: its `normalized` control's range (set, or in its shader); undefined when it has none. */
export function layerWindow(spec: unknown): [number, number] | undefined {
  const s = spec as { shaderControls?: { normalized?: { range?: unknown } | unknown }; shader?: unknown } | undefined;
  const control = s?.shaderControls?.normalized as { range?: unknown } | undefined;
  const range = control?.range;
  if (Array.isArray(range) && range.length === 2 && range.every((v) => typeof v === "number" && Number.isFinite(v)) && range[0] !== range[1]) return [range[0], range[1]];
  if (typeof s?.shader === "string") {
    const m = /#uicontrol\s+invlerp\s+normalized\s*\(([^)]*)\)/.exec(s.shader);
    const r = m && /range\s*=\s*\[\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\]/.exec(m[1]);
    if (r) {
      const a = Number(r[1]);
      const b = Number(r[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return [a, b];
    }
  }
  return undefined;
}

/** A window from the values themselves: their `low` and `high` quantiles (NaN left out). */
export function quantileWindow(values: ArrayLike<number>, low = 0.005, high = 0.995): [number, number] {
  const finite: number[] = [];
  for (let i = 0; i < values.length; ++i) if (Number.isFinite(values[i])) finite.push(values[i]);
  if (finite.length === 0) return [0, 1];
  finite.sort((a, b) => a - b);
  const at = (q: number) => finite[Math.min(finite.length - 1, Math.max(0, Math.round(q * (finite.length - 1))))];
  const a = at(low);
  const b = at(high);
  return b > a ? [a, b] : [a, a + 1];
}

/** An image block's value at section pixel (u, w) of `crop`'s section; NaN outside the block. */
function sectionValue(block: ImageBlock, axis: number, index: number, u: number, w: number): number {
  const [ua, wa] = sectionAxes(axis);
  const p = [0, 0, 0];
  p[axis] = index - block.lo[axis];
  p[ua] = u - block.lo[ua];
  p[wa] = w - block.lo[wa];
  if (p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] >= block.size[0] || p[1] >= block.size[1] || p[2] >= block.size[2]) return NaN;
  return block.data[p[0] + block.size[0] * (p[1] + block.size[1] * p[2])];
}

/**
 * The model's input: `crop` of `block` resampled to `size` × `size`
 * (bilinear, at each pixel's centre), windowed to 0 … 255 (`window` may
 * be reversed, which inverts), as height × width × 3. Values outside the
 * image (NaN) count as 0 before windowing.
 */
export function modelImage(block: ImageBlock, crop: Crop, window: [number, number], size = MODEL_SIZE): Float32Array {
  const [cu, cw] = crop.size;
  // The crop's values, with a ring of edge values round them so bilinear sampling needs no tests.
  const W = cu + 2;
  const H = cw + 2;
  const grid = new Float32Array(W * H);
  for (let j = 0; j < H; ++j) {
    for (let i = 0; i < W; ++i) {
      const u = crop.lo[0] + Math.max(0, Math.min(cu - 1, i - 1));
      const w = crop.lo[1] + Math.max(0, Math.min(cw - 1, j - 1));
      const v = sectionValue(block, crop.axis, crop.index, u, w);
      grid[i + W * j] = v === v ? v : 0;
    }
  }
  const [a, b] = window;
  const scale = 255 / (b - a);
  const out = new Float32Array(size * size * 3);
  const xs = new Float64Array(size);
  const ys = new Float64Array(size);
  for (let p = 0; p < size; ++p) {
    // Pixel p's centre in voxels of the crop (voxel i centred at i), shifted by the ring.
    xs[p] = Math.max(0, Math.min(cu - 1, ((p + 0.5) * cu) / size - 0.5)) + 1;
    ys[p] = Math.max(0, Math.min(cw - 1, ((p + 0.5) * cw) / size - 0.5)) + 1;
  }
  for (let py = 0; py < size; ++py) {
    const y = ys[py];
    const y0 = Math.floor(y);
    const fy = y - y0;
    const r0 = W * y0;
    const r1 = W * Math.min(H - 1, y0 + 1);
    for (let px = 0; px < size; ++px) {
      const x = xs[px];
      const x0 = Math.floor(x);
      const fx = x - x0;
      const x1 = Math.min(W - 1, x0 + 1);
      const v = (1 - fy) * ((1 - fx) * grid[r0 + x0] + fx * grid[r0 + x1]) + fy * ((1 - fx) * grid[r1 + x0] + fx * grid[r1 + x1]);
      const t = Math.max(0, Math.min(255, (v - a) * scale));
      const o = 3 * (px + size * py);
      out[o] = out[o + 1] = out[o + 2] = t;
    }
  }
  return out;
}

/** A label voxel (u, w) of the section as a point in the model's pixels (an index: SAM adds 0.5 for the centre). */
export function pointToModel(crop: Crop, u: number, w: number, size = MODEL_SIZE): [number, number] {
  return [((u - crop.lo[0] + 0.5) * size) / crop.size[0] - 0.5, ((w - crop.lo[1] + 0.5) * size) / crop.size[1] - 0.5];
}

/** A box of label voxels (u, w; `hi` exclusive) as SAM's box corners in the model's pixels: its edges. */
export function boxToModel(crop: Crop, lo: [number, number], hi: [number, number], size = MODEL_SIZE): [number, number, number, number] {
  const x = (u: number) => ((u - crop.lo[0]) * size) / crop.size[0];
  const y = (w: number) => ((w - crop.lo[1]) * size) / crop.size[1];
  return [x(lo[0]), y(lo[1]), x(hi[0]), y(hi[1])];
}

export interface SamPrompt {
  box?: { lo: [number, number]; hi: [number, number] };
  points: { u: number; w: number; positive: boolean }[];
}

/**
 * The decoder's prompt tensors for `prompt` in `crop`: `coords` (n × 2) and
 * `labels` (n): points 1 (wanted) or 0 (not), a box as two points labelled
 * 2 and 3; without a box, a padding point labelled -1 (as SAM's ONNX
 * decoder expects).
 */
export function promptTensors(crop: Crop, prompt: SamPrompt, size = MODEL_SIZE): { coords: Float32Array; labels: Float32Array } {
  const coords: number[] = [];
  const labels: number[] = [];
  for (const p of prompt.points) {
    coords.push(...pointToModel(crop, p.u, p.w, size));
    labels.push(p.positive ? 1 : 0);
  }
  if (prompt.box) {
    const [x0, y0, x1, y1] = boxToModel(crop, prompt.box.lo, prompt.box.hi, size);
    coords.push(x0, y0, x1, y1);
    labels.push(2, 3);
  } else {
    coords.push(0, 0);
    labels.push(-1);
  }
  return { coords: Float32Array.from(coords), labels: Float32Array.from(labels) };
}

/**
 * The decoder's low-resolution logits (`low` × `low`, over the model's
 * whole `size` × `size` input) on the label grid: each voxel of `crop`
 * within the volume (`volume`: its size in voxels) sampled bilinearly at
 * its centre, selected above `threshold`.
 */
export function maskOnGrid(lowRes: Float32Array, crop: Crop, volume: Vec3, options: { size?: number; low?: number; threshold?: number } = {}): Mask {
  const size = options.size ?? MODEL_SIZE;
  const low = options.low ?? LOW_RES;
  const threshold = options.threshold ?? 0;
  const [ua, wa] = sectionAxes(crop.axis);
  const u0 = Math.max(0, crop.lo[0]);
  const w0 = Math.max(0, crop.lo[1]);
  const u1 = Math.min(volume[ua], crop.lo[0] + crop.size[0]);
  const w1 = Math.min(volume[wa], crop.lo[1] + crop.size[1]);
  const nu = Math.max(0, u1 - u0);
  const nw = Math.max(0, w1 - w0);
  const lo = [0, 0, 0] as Vec3;
  const sz = [1, 1, 1] as Vec3;
  lo[crop.axis] = crop.index;
  lo[ua] = u0;
  lo[wa] = w0;
  sz[ua] = nu;
  sz[wa] = nw;
  const data = new Uint8Array(nu * nw);
  // A low-resolution pixel spans size / low input pixels; its centre is at (k + 0.5) of them.
  const at = (v: number, cropLo: number, cropSize: number) => Math.max(0, Math.min(low - 1, (((v - cropLo + 0.5) * size) / cropSize) * (low / size) - 0.5));
  for (let j = 0; j < nw; ++j) {
    const y = at(w0 + j, crop.lo[1], crop.size[1]);
    const y0 = Math.floor(y);
    const y1 = Math.min(low - 1, y0 + 1);
    const fy = y - y0;
    for (let i = 0; i < nu; ++i) {
      const x = at(u0 + i, crop.lo[0], crop.size[0]);
      const x0 = Math.floor(x);
      const x1 = Math.min(low - 1, x0 + 1);
      const fx = x - x0;
      const v = (1 - fy) * ((1 - fx) * lowRes[x0 + low * y0] + fx * lowRes[x1 + low * y0]) + fy * ((1 - fx) * lowRes[x0 + low * y1] + fx * lowRes[x1 + low * y1]);
      // The mask's data is x fastest; with one voxel along the normal, (u, w) is i + nu·j whatever the axis.
      if (v > threshold) data[i + nu * j] = 1;
    }
  }
  return { lo, size: sz, data };
}

/** The bounding box (u, w; `hi` exclusive) of a mask's voxels in its section; undefined when empty. */
export function sectionBounds(mask: Mask, axis: number): { lo: [number, number]; hi: [number, number] } | undefined {
  const [ua, wa] = sectionAxes(axis);
  const nu = mask.size[ua];
  const nw = mask.size[wa];
  let lu = Infinity;
  let lw = Infinity;
  let hu = -Infinity;
  let hw = -Infinity;
  for (let j = 0; j < nw; ++j) {
    for (let i = 0; i < nu; ++i) {
      if (!mask.data[i + nu * j]) continue;
      if (i < lu) lu = i;
      if (i > hu) hu = i;
      if (j < lw) lw = j;
      if (j > hw) hw = j;
    }
  }
  if (hu < 0) return undefined;
  return { lo: [mask.lo[ua] + lu, mask.lo[wa] + lw], hi: [mask.lo[ua] + hu + 1, mask.lo[wa] + hw + 1] };
}

/** Masks (of single sections, say) put together into one mask over their bounding box. */
export function stackMasks(masks: Mask[]): Mask | undefined {
  if (masks.length === 0) return undefined;
  const lo = [0, 1, 2].map((k) => Math.min(...masks.map((m) => m.lo[k]))) as Vec3;
  const hi = [0, 1, 2].map((k) => Math.max(...masks.map((m) => m.lo[k] + m.size[k]))) as Vec3;
  const size = hi.map((v, k) => v - lo[k]) as Vec3;
  const data = new Uint8Array(size[0] * size[1] * size[2]);
  for (const m of masks) {
    let i = 0;
    for (let z = 0; z < m.size[2]; ++z) {
      for (let y = 0; y < m.size[1]; ++y) {
        for (let x = 0; x < m.size[0]; ++x, ++i) {
          if (!m.data[i]) continue;
          data[x + m.lo[0] - lo[0] + size[0] * (y + m.lo[1] - lo[1] + size[1] * (z + m.lo[2] - lo[2]))] = 1;
        }
      }
    }
  }
  return { lo, size, data };
}

/** The connected parts of `mask` (4 neighbours in a section) holding any of `seeds` (label voxels); the mask as it is when none does. */
export function keepParts(mask: Mask, seeds: Vec3[]): Mask {
  const index = (v: Vec3) => v[0] + mask.size[0] * (v[1] + mask.size[1] * v[2]);
  const inside = seeds.map((s) => s.map((v, k) => Math.round(v) - mask.lo[k]) as Vec3).filter((v) => v.every((x, k) => x >= 0 && x < mask.size[k]) && mask.data[index(v)]);
  if (inside.length === 0) return mask;
  const data = new Uint8Array(mask.data.length);
  for (const s of inside) {
    if (data[index(s)]) continue;
    const part = component(mask.data, mask.size, s);
    for (let i = 0; i < part.length; ++i) if (part[i]) data[i] = 1;
  }
  return { lo: mask.lo, size: mask.size, data };
}
