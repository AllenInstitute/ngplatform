import { describe, expect, it } from "vitest";
import { bf16, type Features, type Graphs, type HeadsOut, type MedSam2Constants, medsam2Image, medsam2Prompt, stable, Tracker } from "../medsam2.js";
import type { Crop } from "../sam.js";

const LOW = 128 * 128;
const C: MedSam2Constants = {
  image_size: 512,
  num_maskmem: 7,
  max_obj_ptrs_in_encoder: 16,
  no_obj_score: -1024,
  stability_delta: 0.05,
  stability_thresh: 0.98,
  pixel_mean: [0.485, 0.456, 0.406],
  pixel_std: [0.229, 0.224, 0.225],
  no_mem_embed: Array.from({ length: 256 }, (_, i) => i / 1000),
};
const features = (tag: number): Features => ({
  high0: new Float32Array(32 * 128 * 128),
  high1: new Float32Array(64 * 64 * 64),
  vision: new Float32Array(256 * 1024).fill(tag),
  visionPos: new Float32Array(256 * 1024),
});

/** Stand-in graphs: masks of four constant values (one per output) with given IoUs; each pointer its token's number. */
function fakeGraphs(options: { singleValue?: number; ious?: number[]; score?: number } = {}) {
  const calls: { op: string; slots?: number[]; distances?: number[]; tDiffMax?: number; binarize?: boolean; labels?: number[]; pixFirst?: number }[] = [];
  const graphs: Graphs = {
    async heads(pix, _f, _coords, labels): Promise<HeadsOut> {
      calls.push({ op: "heads", labels: Array.from(labels), pixFirst: pix[0] });
      const masks = new Float32Array(4 * LOW);
      // Mask 0: the single mask (stable when its value is far from 0); 1 … 3: values 1, 2, 3.
      masks.fill(options.singleValue ?? 5, 0, LOW);
      for (let k = 1; k < 4; ++k) masks.fill(k, k * LOW, (k + 1) * LOW);
      const ptrs = new Float32Array(4 * 256);
      for (let k = 0; k < 4; ++k) ptrs.fill(k, k * 256, (k + 1) * 256);
      return { masks, ious: Float32Array.from(options.ious ?? [0.9, 0.1, 0.8, 0.3]), ptrs, score: options.score ?? 1 };
    },
    async memoryEncoder(_v, mask, _score, binarize) {
      calls.push({ op: "memory", binarize });
      return { mem: new Float32Array(64 * 1024).fill(mask[0]), pos: new Float32Array(64 * 1024) };
    },
    async memoryAttention(_f, _mf, _mp, slots, _ptrs, distances, tDiffMax) {
      calls.push({ op: "attention", slots: [...slots], distances: [...distances], tDiffMax });
      return new Float32Array(256 * 1024);
    },
  };
  return { graphs, calls };
}

describe("MedSAM2's tracker (as its video predictor tracks)", () => {
  it("conditions on a box: one mask (stable), the first token's pointer, features plus no_mem_embed", async () => {
    const { graphs, calls } = fakeGraphs();
    const t = new Tracker(graphs, C, 30);
    const r = await t.condition(10, features(2), new Float32Array(4), Int32Array.of(2, 3));
    expect(r.mask[0]).toBe(5);
    expect(calls[0].pixFirst).toBeCloseTo(2 + C.no_mem_embed[0], 6);
  });

  it("falls back from an unstable single mask to the best of three by IoU", async () => {
    const { graphs } = fakeGraphs({ singleValue: 0.01 });
    const t = new Tracker(graphs, C, 30);
    const r = await t.condition(10, features(1), new Float32Array(4), Int32Array.of(2, 3));
    // IoUs of masks 1 … 3: 0.1, 0.8, 0.3: mask 2.
    expect(r.mask[0]).toBe(2);
  });

  it("takes the best of three for a single click", async () => {
    const { graphs } = fakeGraphs();
    const r = await new Tracker(graphs, C, 30).condition(10, features(1), new Float32Array(2), Int32Array.of(1));
    expect(r.mask[0]).toBe(2);
  });

  it("marks a section where the object is gone, and its memory says so", async () => {
    const { graphs } = fakeGraphs({ score: -3 });
    const r = await new Tracker(graphs, C, 30).condition(10, features(1), new Float32Array(4), Int32Array.of(2, 3));
    expect(r.mask.every((v) => v === -1024)).toBe(true);
  });

  it("remembers the prompted section and the six before, and the pointers of up to fifteen before, going forward", async () => {
    const { graphs, calls } = fakeGraphs();
    const t = new Tracker(graphs, C, 30);
    await t.condition(10, features(1), new Float32Array(4), Int32Array.of(2, 3));
    await t.begin(false);
    for (let f = 11; f <= 18; ++f) await t.step(f, features(f));
    const attention = calls.filter((c) => c.op === "attention");
    // First step: the prompted section alone (slot 6), its pointer one away.
    expect(attention[0].slots).toEqual([6]);
    expect(attention[0].distances).toEqual([1]);
    expect(attention[0].tDiffMax).toBe(15);
    // Second: and section 11 in the nearest slot (0).
    expect(attention[1].slots).toEqual([6, 0]);
    expect(attention[1].distances).toEqual([2, 1]);
    // Section 18: sections 12 … 17 in slots 5 … 0; pointers of 17 … 11 (the prompted one first, 8 away).
    expect(attention[7].slots).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(attention[7].distances).toEqual([8, 1, 2, 3, 4, 5, 6, 7]);
    // The prompted section's memory from its mask binarized; the tracked ones' not.
    const memory = calls.filter((c) => c.op === "memory");
    expect(memory[0].binarize).toBe(true);
    expect(memory.slice(1).every((c) => c.binarize === false)).toBe(true);
    // Each step's heads take no prompt (the padding point alone).
    expect(calls.filter((c) => c.op === "heads").slice(1).every((c) => c.labels!.length === 1 && c.labels![0] === -1)).toBe(true);
  });

  it("goes back the same way, the distances positive; fewer sections than 16 shorten the pointers' reach", async () => {
    const { graphs, calls } = fakeGraphs();
    const t = new Tracker(graphs, C, 12);
    await t.condition(10, features(1), new Float32Array(4), Int32Array.of(2, 3));
    await t.begin(true);
    for (let f = 9; f >= 7; --f) await t.step(f, features(f));
    const attention = calls.filter((c) => c.op === "attention");
    expect(attention[2].slots).toEqual([6, 1, 0]);
    expect(attention[2].distances).toEqual([3, 1, 2]);
    expect(attention[2].tDiffMax).toBe(11);
  });

  it("starts each direction afresh from the prompt", async () => {
    const { graphs, calls } = fakeGraphs();
    const t = new Tracker(graphs, C, 30);
    await t.condition(10, features(1), new Float32Array(4), Int32Array.of(2, 3));
    await t.begin(false);
    await t.step(11, features(11));
    await t.begin(true);
    await t.step(9, features(9));
    const attention = calls.filter((c) => c.op === "attention");
    expect(attention[1].slots).toEqual([6]);
    expect(attention[1].distances).toEqual([1]);
  });
});

describe("MedSAM2's numbers", () => {
  it("keeps memory as bfloat16 (to nearest, ties to even)", () => {
    const x = Float32Array.of(1, 1 + 2 ** -8, 1 + 2 ** -7 + 2 ** -8, -3.14159);
    const y = bf16(x);
    expect(y[0]).toBe(1);
    expect(y[1]).toBe(1); // a tie: to even
    expect(y[2]).toBe(1 + 2 ** -6); // a tie: to even (up)
    expect(Math.abs(y[3] - -3.14159)).toBeLessThan(0.02);
  });

  it("calls a mask stable when little lies between −delta and +delta", () => {
    expect(stable(Float32Array.of(1, 1, -1, -1), 0.05, 0.98)).toBe(true);
    expect(stable(Float32Array.of(1, 0.01, -1, -1), 0.05, 0.98)).toBe(false);
    expect(stable(Float32Array.of(-1, -1), 0.05, 0.98)).toBe(true);
  });

  it("puts the box first (corners 2 and 3), then the points, in the model's pixels", () => {
    const crop: Crop = { axis: 2, index: 0, lo: [0, 0], size: [256, 256] };
    const p = medsam2Prompt(crop, { box: { lo: [64, 32], hi: [128, 96] }, points: [{ u: 100, w: 50, positive: false }] });
    expect(Array.from(p.labels)).toEqual([2, 3, 0]);
    expect(Array.from(p.coords.slice(0, 4))).toEqual([128, 64, 256, 192]);
    expect(p.coords[4]).toBeCloseTo(((100 + 0.5) * 512) / 256 - 0.5, 5);
  });

  it("normalises the image as MedSAM2 does: through the window to 0 … 1, then each channel's mean and spread", () => {
    const block = { lo: [0, 0, 0] as [number, number, number], size: [4, 4, 1] as [number, number, number], data: new Float32Array(16).fill(50) };
    const crop: Crop = { axis: 2, index: 0, lo: [0, 0], size: [4, 4] };
    const img = medsam2Image(block, crop, [0, 100], C);
    expect(img.length).toBe(3 * 512 * 512);
    for (let ch = 0; ch < 3; ++ch) expect(img[ch * 512 * 512 + 1000]).toBeCloseTo((0.5 - C.pixel_mean[ch]) / C.pixel_std[ch], 5);
  });
});
