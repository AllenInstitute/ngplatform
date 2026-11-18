/**
 * MedSAM2 (SAM 2.1 Hiera-tiny at 512 × 512, fine-tuned on medical images;
 * Apache-2.0): a box (or clicks) on one section segmented there, then
 * tracked section by section through the volume, as its PyTorch video
 * predictor does. The model runs as four ONNX graphs (tools/medsam2/:
 * `export_onnx.py` makes them and checks each against PyTorch); this module
 * is the bookkeeping between them, `tools/medsam2/medsam2_onnx.py` line for
 * line (which matches MedSAM2's predictor to a voxel in tens of thousands),
 * and the image and prompt in the model's terms. It runs the graphs through
 * `Graphs`, so the worker (./medsam2_worker.ts) gives it ONNX Runtime and the
 * tests give it stand-ins.
 *
 * A track: `condition` on the prompted section (its features + `no_mem_embed`
 * through the heads: one mask for a box, or the best of three for a single
 * click; an unstable single mask falls back to the best of three), then
 * `begin` a direction and `step` section after section. Each step attends to
 * a memory bank (the prompted section in slot 0, and the up to 6 sections just
 * before in the direction of travel) and up to 16 object pointers (the
 * prompted section's when it is behind, then the sections before, with their
 * signed distances); its mask is the best of three, and its memory is
 * encoded for the steps after. Memory features are kept as bfloat16, as the
 * predictor keeps them.
 */
import { boxToModel, type Crop, modelImage, pointToModel } from "./sam.js";
import type { ImageBlock } from "./kernels.js";

/** The model's input side, its low-resolution masks' side, its feature map's side. */
export const MEDSAM2_SIZE = 512;
export const MEDSAM2_LOW = 128;
const FEAT = 32 * 32;
const MEM_DIM = 64;
const HIDDEN = 256;
const LOW_PIXELS = MEDSAM2_LOW * MEDSAM2_LOW;

/** constants.json, as tools/medsam2/export_onnx.py writes it. */
export interface MedSam2Constants {
  image_size: number;
  num_maskmem: number;
  max_obj_ptrs_in_encoder: number;
  no_obj_score: number;
  stability_delta: number;
  stability_thresh: number;
  pixel_mean: number[];
  pixel_std: number[];
  no_mem_embed: number[];
}

/** A section's image features (the encoder's outputs). */
export interface Features {
  high0: Float32Array; // 32 × 128 × 128
  high1: Float32Array; // 64 × 64 × 64
  vision: Float32Array; // 256 × 32 × 32
  visionPos: Float32Array; // 256 × 32 × 32
}

export interface HeadsOut {
  /** The four masks' low-resolution logits (128 × 128 each): the single mask, then the three. */
  masks: Float32Array;
  ious: Float32Array;
  /** The four object pointers (256 each). */
  ptrs: Float32Array;
  score: number;
}

/** The graphs, as the tracker runs them (the arrays laid out as the ONNX inputs and outputs are). */
export interface Graphs {
  heads(pix: Float32Array, features: Features, coords: Float32Array, labels: Int32Array): Promise<HeadsOut>;
  memoryEncoder(vision: Float32Array, mask: Float32Array, score: number, binarize: boolean): Promise<{ mem: Float32Array; pos: Float32Array }>;
  memoryAttention(features: Features, memFeats: Float32Array, memPos: Float32Array, memSlots: number[], ptrs: Float32Array, ptrDistances: number[], tDiffMax: number): Promise<Float32Array>;
}

/** float32 rounded to bfloat16 (to nearest, ties to even), as float32. */
export function bf16(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  const u = new Uint32Array(x.buffer, x.byteOffset, x.length);
  const o = new Uint32Array(out.buffer);
  for (let i = 0; i < u.length; ++i) {
    const v = u[i];
    o[i] = ((v + 0x7fff + ((v >>> 16) & 1)) & 0xffff0000) >>> 0;
  }
  return out;
}

/** Whether a mask's logits are stable: the share above +delta of those above −delta (SAM 2's dynamic multimask). */
export function stable(logits: Float32Array, delta: number, thresh: number): boolean {
  let inner = 0;
  let outer = 0;
  for (let i = 0; i < logits.length; ++i) {
    if (logits[i] > delta) ++inner;
    if (logits[i] > -delta) ++outer;
  }
  return (outer > 0 ? inner / outer : 1) >= thresh;
}

/** The index of the largest of `values[from …]`. */
function argmax(values: Float32Array, from: number): number {
  let best = from;
  for (let i = from + 1; i < values.length; ++i) if (values[i] > values[best]) best = i;
  return best;
}

/** One section's result: its mask's low-resolution logits (128 × 128), and whether the object is there (score > 0). */
export interface StepResult {
  mask: Float32Array;
  score: number;
}

export class Tracker {
  private cond: { mask: Float32Array; ptr: Float32Array; score: number; vision: Float32Array; mem?: Float32Array } | undefined;
  private memPos: Float32Array | undefined;
  private readonly before = new Map<number, { ptr: Float32Array; mem: Float32Array }>();
  private key = 0;
  private reverse = false;
  private readonly noMemEmbed: Float32Array;

  constructor(
    private readonly graphs: Graphs,
    private readonly c: MedSam2Constants,
    /** Sections along the axis tracked through (the pointers' reach is the lesser of this and 16). */
    readonly numFrames: number,
  ) {
    this.noMemEmbed = Float32Array.from(c.no_mem_embed);
  }

  /** The heads' mask, its pointer: the best of three (a click, or tracking) or the single mask with its fallback (a box). */
  private choose(r: HeadsOut, multimask: boolean): { mask: Float32Array; ptr: Float32Array } {
    const at = (k: number) => r.masks.subarray(k * LOW_PIXELS, (k + 1) * LOW_PIXELS);
    const ptrOf = (k: number) => r.ptrs.slice(k * HIDDEN, (k + 1) * HIDDEN);
    let pick: number;
    let token: number;
    if (multimask) pick = token = argmax(r.ious, 1);
    else {
      pick = stable(at(0), this.c.stability_delta, this.c.stability_thresh) ? 0 : argmax(r.ious, 1);
      token = 0;
    }
    const mask = r.score > 0 ? Float32Array.from(at(pick)) : new Float32Array(LOW_PIXELS).fill(this.c.no_obj_score);
    return { mask, ptr: ptrOf(token) };
  }

  /**
   * The prompted section `key`: its mask from the prompt (`coords` in the model's pixels, `labels` 1 wanted, 0 not,
   * 2 and 3 a box's corners, the box first). Starts the track again.
   */
  async condition(key: number, features: Features, coords: Float32Array, labels: Int32Array): Promise<StepResult> {
    const pix = new Float32Array(HIDDEN * FEAT);
    for (let ch = 0; ch < HIDDEN; ++ch) {
      const add = this.noMemEmbed[ch];
      for (let i = 0; i < FEAT; ++i) pix[ch * FEAT + i] = features.vision[ch * FEAT + i] + add;
    }
    const r = await this.graphs.heads(pix, features, coords, labels);
    // One point alone: the best of three; a box (two corners) or more points: one mask.
    const { mask, ptr } = this.choose(r, labels.length <= 1);
    this.cond = { mask, ptr, score: r.score, vision: Float32Array.from(features.vision) };
    this.before.clear();
    this.key = key;
    return { mask, score: r.score };
  }

  /** Starts tracking from the prompted section, towards higher sections or (`reverse`) lower. */
  async begin(reverse: boolean): Promise<void> {
    const cond = this.cond;
    if (cond === undefined) throw new Error("Nothing to track: segment a section first.");
    if (cond.mem === undefined) {
      // The prompted section's memory: its mask binarized (it came from the user's prompt).
      const m = await this.graphs.memoryEncoder(cond.vision, cond.mask, cond.score, true);
      cond.mem = bf16(m.mem);
      this.memPos = m.pos;
    }
    this.before.clear();
    this.reverse = reverse;
  }

  /** The next section `f` in the direction begun (each in turn): its mask, from the memory of those before. */
  async step(f: number, features: Features): Promise<StepResult> {
    const cond = this.cond;
    if (cond?.mem === undefined || this.memPos === undefined) throw new Error("Begin tracking first.");
    const nmem = this.c.num_maskmem;
    const dir = this.reverse ? -1 : 1;
    // The memory bank: the prompted section in slot 0, then the sections 6 … 1 before this one.
    const mems: Float32Array[] = [cond.mem];
    const slots = [nmem - 1];
    for (let tPos = 1; tPos < nmem; ++tPos) {
      const prev = this.before.get(f - dir * (nmem - tPos));
      if (prev === undefined) continue;
      mems.push(prev.mem);
      slots.push(nmem - tPos - 1);
    }
    // The object pointers: the prompted section's when it is behind, then the sections before, nearest first.
    const maxPtrs = Math.min(this.numFrames, this.c.max_obj_ptrs_in_encoder);
    const ptrs: Float32Array[] = [];
    const distances: number[] = [];
    if (this.reverse ? this.key >= f : this.key <= f) {
      ptrs.push(cond.ptr);
      distances.push((f - this.key) * dir);
    }
    for (let tDiff = 1; tDiff < maxPtrs; ++tDiff) {
      const t = f - dir * tDiff;
      if (t < 0 || t >= this.numFrames) break;
      const prev = this.before.get(t);
      if (prev === undefined) continue;
      ptrs.push(prev.ptr);
      distances.push(tDiff);
    }
    const memFeats = new Float32Array(mems.length * MEM_DIM * FEAT);
    const memPos = new Float32Array(mems.length * MEM_DIM * FEAT);
    mems.forEach((m, i) => {
      memFeats.set(m, i * MEM_DIM * FEAT);
      memPos.set(this.memPos!, i * MEM_DIM * FEAT);
    });
    const ptrArray = new Float32Array(ptrs.length * HIDDEN);
    ptrs.forEach((p, i) => ptrArray.set(p, i * HIDDEN));
    const pix = await this.graphs.memoryAttention(features, memFeats, memPos, slots, ptrArray, distances, maxPtrs - 1);
    // No prompt: a padding point alone, and the best of three.
    const r = await this.graphs.heads(pix, features, new Float32Array(2), Int32Array.of(-1));
    const { mask, ptr } = this.choose(r, true);
    const m = await this.graphs.memoryEncoder(features.vision, mask, r.score, false);
    this.before.set(f, { ptr, mem: bf16(m.mem) });
    return { mask, score: r.score };
  }
}

// ------------------------------------------------------------------ the image and prompt in the model's terms

/** A crop of a section as the encoder takes it: 512 × 512, through `window` to 0 … 255, then MedSAM2's normalisation (3 × 512 × 512). */
export function medsam2Image(block: ImageBlock, crop: Crop, window: [number, number], c: Pick<MedSam2Constants, "pixel_mean" | "pixel_std">): Float32Array {
  const S = MEDSAM2_SIZE;
  const hwc = modelImage(block, crop, window, S);
  const out = new Float32Array(3 * S * S);
  for (let ch = 0; ch < 3; ++ch) {
    const mean = c.pixel_mean[ch];
    const std = c.pixel_std[ch];
    for (let i = 0; i < S * S; ++i) out[ch * S * S + i] = (hwc[3 * i + ch] / 255 - mean) / std;
  }
  return out;
}

/** A prompt in the model's pixels: the box first (its corners, labels 2 and 3), then the points (1 wanted, 0 not). */
export function medsam2Prompt(crop: Crop, prompt: { box?: { lo: [number, number]; hi: [number, number] }; points: { u: number; w: number; positive: boolean }[] }): { coords: Float32Array; labels: Int32Array } {
  const coords: number[] = [];
  const labels: number[] = [];
  if (prompt.box) {
    coords.push(...boxToModel(crop, prompt.box.lo, prompt.box.hi, MEDSAM2_SIZE));
    labels.push(2, 3);
  }
  for (const p of prompt.points) {
    coords.push(...pointToModel(crop, p.u, p.w, MEDSAM2_SIZE));
    labels.push(p.positive ? 1 : 0);
  }
  return { coords: Float32Array.from(coords), labels: Int32Array.from(labels) };
}
