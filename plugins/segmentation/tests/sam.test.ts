/**
 * Quick select's model method, around the model: the crop round a prompt,
 * the layer's window, the model's image (resampled, windowed), prompt
 * coordinates in the model's pixels, the decoder's mask back on the label
 * grid, and the masks spread over sections put together.
 */
import { describe, expect, it } from "vitest";
import type { ImageBlock, Vec3 } from "../kernels.js";
import { maskCount } from "../preview.js";
import { QuickSelectRegistry } from "../quick_select.js";
import { boxToModel, cropBox, cropFor, cropServes, keepParts, layerWindow, LOW_RES, maskOnGrid, MODEL_SIZE, modelImage, pointToModel, promptTensors, quantileWindow, sectionAxes, sectionBounds, stackMasks, type Crop } from "../sam.js";
import { MOBILE_SAM, MODEL_BYTES, ORT_URL, SamModel, samMethod } from "../sam_model.js";

/** A block of one section across `axis` at `index`, `nu` × `nw` voxels from (u0, w0), valued by `f(u, w)`. */
function sectionBlock(axis: number, index: number, u0: number, w0: number, nu: number, nw: number, f: (u: number, w: number) => number): ImageBlock {
  const [ua, wa] = sectionAxes(axis);
  const lo = [0, 0, 0] as Vec3;
  const size = [1, 1, 1] as Vec3;
  lo[axis] = index;
  lo[ua] = u0;
  lo[wa] = w0;
  size[ua] = nu;
  size[wa] = nw;
  const data = new Float32Array(nu * nw);
  for (let j = 0; j < nw; ++j) for (let i = 0; i < nu; ++i) data[i + nu * j] = f(u0 + i, w0 + j);
  return { lo, size, data };
}

describe("the crop round a prompt", () => {
  const options = { context: 64, spacing: [1, 1] as [number, number], extent: [1000, 1000] as [number, number] };

  it("is centred on a click, the context across", () => {
    const c = cropFor(2, 7, [500, 300], [501, 301], options);
    expect(c).toEqual({ axis: 2, index: 7, lo: [469, 269], size: [64, 64] });
  });

  it("grows with a box: its longest side times the margin", () => {
    const c = cropFor(2, 0, [100, 100], [200, 140], options);
    expect(c.size).toEqual([150, 150]);
    expect(c.lo).toEqual([75, 45]);
  });

  it("is square in millimetres when the voxel's sides differ", () => {
    const c = cropFor(1, 0, [50, 50], [51, 51], { ...options, spacing: [0.5, 2] });
    // 64 of the finer side (0.5 mm) is 32 mm: 64 voxels along u, 16 along w.
    expect(c.size).toEqual([64, 16]);
  });

  it("moves inside the section where it fits, and reaches past it where it does not", () => {
    expect(cropFor(2, 0, [3, 990], [4, 991], options).lo).toEqual([0, 1000 - 64]);
    const big = cropFor(2, 0, [10, 10], [11, 11], { ...options, extent: [40, 40] });
    expect(big.size).toEqual([64, 64]);
    expect(big.lo).toEqual([-21, -21]);
  });

  it("serves a later prompt that sits well inside it", () => {
    const c: Crop = { axis: 2, index: 0, lo: [0, 0], size: [100, 100] };
    expect(cropServes(c, [40, 40], [60, 60])).toBe(true);
    expect(cropServes(c, [5, 40], [6, 41])).toBe(false);
    expect(cropServes(c, [40, 40], [96, 60])).toBe(false);
  });

  it("reads one section of label voxels, whatever the axis", () => {
    expect(cropBox({ axis: 2, index: 5, lo: [10, 20], size: [30, 40] })).toEqual({ lo: [10, 20, 5], hi: [40, 60, 6] });
    expect(cropBox({ axis: 1, index: 5, lo: [10, 20], size: [30, 40] })).toEqual({ lo: [10, 5, 20], hi: [40, 6, 60] });
    expect(cropBox({ axis: 0, index: 5, lo: [10, 20], size: [30, 40] })).toEqual({ lo: [5, 10, 20], hi: [6, 40, 60] });
  });
});

describe("the window", () => {
  it("is the layer's normalized range, set or in its shader", () => {
    expect(layerWindow({ shaderControls: { normalized: { range: [10, 90] } } })).toEqual([10, 90]);
    expect(layerWindow({ shader: "#uicontrol invlerp normalized(range=[0, 255])\nvoid main() { emitGrayscale(normalized()); }" })).toEqual([0, 255]);
    expect(layerWindow({ shader: "#uicontrol invlerp normalized(range=[1e3, -5], window=[0, 2000])" })).toEqual([1000, -5]);
    // The control's range wins over the shader's default.
    expect(layerWindow({ shader: "#uicontrol invlerp normalized(range=[0, 255])", shaderControls: { normalized: { range: [3, 4] } } })).toEqual([3, 4]);
    expect(layerWindow({ shader: "void main() {}" })).toBeUndefined();
    expect(layerWindow(undefined)).toBeUndefined();
  });

  it("falls back to the values' quantiles", () => {
    const values = Float32Array.from({ length: 1001 }, (_, i) => i);
    expect(quantileWindow(values, 0.01, 0.99)).toEqual([10, 990]);
    expect(quantileWindow([NaN, 5, 5])).toEqual([5, 6]);
  });
});

describe("the model's image", () => {
  it("is the crop resampled to the input size, windowed to 0 … 255, three equal channels", () => {
    // A gradient along u (0 … 15), constant along w.
    const block = sectionBlock(2, 3, 0, 0, 16, 16, (u) => u);
    const crop: Crop = { axis: 2, index: 3, lo: [0, 0], size: [16, 16] };
    const img = modelImage(block, crop, [0, 15], 64);
    expect(img.length).toBe(64 * 64 * 3);
    const at = (x: number, y: number, c = 0) => img[3 * (x + 64 * y) + c];
    // x follows u: dark on the left, bright on the right; rows alike; channels alike.
    expect(at(0, 0)).toBe(0);
    expect(at(63, 0)).toBe(255);
    expect(at(10, 5)).toBeCloseTo(at(10, 50));
    expect(at(30, 7, 1)).toBe(at(30, 7, 0));
    expect(at(30, 7, 2)).toBe(at(30, 7, 0));
    // Pixel 31's centre is at u = (31.5 · 16 / 64) − 0.5 = 7.375: bilinear between 7 and 8.
    expect(at(31, 0)).toBeCloseTo((7.375 / 15) * 255, 3);
  });

  it("puts w down the image, clamps to the window, and reads outside the image as 0", () => {
    const block = sectionBlock(0, 1, 0, 0, 8, 8, (_u, w) => (w >= 4 ? 100 : 50));
    // The crop reaches 8 voxels past the block along w: those read as 0.
    const crop: Crop = { axis: 0, index: 1, lo: [0, 0], size: [8, 16] };
    const img = modelImage(block, crop, [50, 100], 16);
    const at = (x: number, y: number) => img[3 * (x + 16 * y)];
    expect(at(3, 0)).toBe(0);
    expect(at(3, 7)).toBe(255);
    expect(at(3, 15)).toBe(0);
    // A reversed window inverts.
    const inverted = modelImage(block, crop, [100, 50], 16);
    expect(inverted[3 * (3 + 16 * 7)]).toBe(0);
    expect(inverted[3 * (3 + 16 * 0)]).toBe(255);
  });
});

describe("prompts in the model's pixels", () => {
  const crop: Crop = { axis: 2, index: 0, lo: [100, 200], size: [256, 128] };

  it("maps a voxel to the pixel under its centre (SAM adds the half pixel)", () => {
    const [x, y] = pointToModel(crop, 100, 200);
    expect(x).toBeCloseTo(0.5 * 4 - 0.5);
    expect(y).toBeCloseTo(0.5 * 8 - 0.5);
    // The middle voxel's centre is the image's middle (less the half pixel SAM adds back).
    const [mx, my] = pointToModel({ ...crop, size: [255, 127] }, 100 + 127, 200 + 63);
    expect(mx + 0.5).toBeCloseTo(MODEL_SIZE / 2);
    expect(my + 0.5).toBeCloseTo(MODEL_SIZE / 2);
  });

  it("maps a box by its edges", () => {
    expect(boxToModel(crop, [100, 200], [356, 328])).toEqual([0, 0, MODEL_SIZE, MODEL_SIZE]);
    expect(boxToModel(crop, [164, 232], [228, 264])).toEqual([256, 256, 512, 512]);
  });

  it("labels points 1 and 0, a box 2 and 3, and pads a prompt without a box", () => {
    const t = promptTensors(crop, { points: [{ u: 150, w: 250, positive: true }, { u: 160, w: 250, positive: false }] });
    expect(Array.from(t.labels)).toEqual([1, 0, -1]);
    expect(t.coords.length).toBe(6);
    expect(Array.from(t.coords.slice(4))).toEqual([0, 0]);
    const b = promptTensors(crop, { box: { lo: [100, 200], hi: [356, 328] }, points: [{ u: 150, w: 250, positive: false }] });
    expect(Array.from(b.labels)).toEqual([0, 2, 3]);
    expect(Array.from(b.coords.slice(2))).toEqual([0, 0, MODEL_SIZE, MODEL_SIZE]);
  });
});

describe("the mask back on the label grid", () => {
  /** Low-resolution logits: positive inside low-res pixels [x0, x1) × [y0, y1). */
  const logits = (x0: number, x1: number, y0: number, y1: number) => {
    const l = new Float32Array(LOW_RES * LOW_RES).fill(-10);
    for (let y = y0; y < y1; ++y) for (let x = x0; x < x1; ++x) l[x + LOW_RES * y] = 10;
    return l;
  };

  it("selects the voxels under the logits above 0, in the crop's section", () => {
    // The crop's 64 voxels span the 256 low-res pixels: 4 a voxel. Low-res [64, 128) × [128, 192) is voxels [16, 32) × [32, 48).
    const crop: Crop = { axis: 2, index: 9, lo: [100, 200], size: [64, 64] };
    const mask = maskOnGrid(logits(64, 128, 128, 192), crop, [1000, 1000, 20]);
    expect(mask.lo).toEqual([100, 200, 9]);
    expect(mask.size).toEqual([64, 64, 1]);
    expect(maskCount(mask)).toBe(16 * 16);
    expect(sectionBounds(mask, 2)).toEqual({ lo: [116, 232], hi: [132, 248] });
  });

  it("keeps within the volume, and lays the section out for any axis", () => {
    // A crop reaching 32 voxels past the volume on each side, everything selected.
    const crop: Crop = { axis: 0, index: 2, lo: [-32, -32], size: [128, 128] };
    const mask = maskOnGrid(logits(0, LOW_RES, 0, LOW_RES), crop, [5, 50, 64]);
    expect(mask.lo).toEqual([2, 0, 0]);
    expect(mask.size).toEqual([1, 50, 64]);
    expect(maskCount(mask)).toBe(50 * 64);
    const one = maskOnGrid(logits(0, 128, 0, LOW_RES), { axis: 1, index: 3, lo: [0, 0], size: [16, 8] }, [16, 10, 8]);
    expect(one.size).toEqual([16, 1, 8]);
    // The left half along u (x here), every w (z).
    expect(sectionBounds(one, 1)).toEqual({ lo: [0, 0], hi: [8, 8] });
  });

  it("round-trips: a disc in the image comes back where it was, from the prompt's point", () => {
    // A bright disc of radius 10 voxels at (140, 230); its centre as a point, and the logits that would select it.
    const crop = cropFor(2, 0, [140, 230], [141, 231], { context: 64, spacing: [1, 1], extent: [500, 500] });
    const [px, py] = pointToModel(crop, 140, 230);
    const l = new Float32Array(LOW_RES * LOW_RES);
    const per = LOW_RES / MODEL_SIZE;
    for (let y = 0; y < LOW_RES; ++y) for (let x = 0; x < LOW_RES; ++x) l[x + LOW_RES * y] = 10 * MODEL_SIZE / crop.size[0] * per - Math.hypot((x + 0.5) / per - (px + 0.5), (y + 0.5) / per - (py + 0.5)) * per;
    const mask = maskOnGrid(l, crop, [500, 500, 1]);
    const b = sectionBounds(mask, 2)!;
    expect(b.lo[0] + b.hi[0]).toBeCloseTo(2 * 140 + 1, 0);
    expect(b.lo[1] + b.hi[1]).toBeCloseTo(2 * 230 + 1, 0);
    expect(Math.abs(maskCount(mask) - Math.PI * 100)).toBeLessThan(20);
  });
});

describe("the parts kept", () => {
  it("keeps the parts holding a wanted click, or all when none does", () => {
    // Two parts in a 6 × 1 section: [1, 1, 0, 0, 1, 1].
    const mask = { lo: [10, 0, 3] as Vec3, size: [6, 1, 1] as Vec3, data: Uint8Array.from([1, 1, 0, 0, 1, 1]) };
    expect(Array.from(keepParts(mask, [[11, 0, 3]]).data)).toEqual([1, 1, 0, 0, 0, 0]);
    expect(Array.from(keepParts(mask, [[10, 0, 3], [15, 0, 3]]).data)).toEqual([1, 1, 0, 0, 1, 1]);
    expect(keepParts(mask, [[12, 0, 3]])).toBe(mask);
    expect(keepParts(mask, [])).toBe(mask);
  });
});

describe("spreading over sections", () => {
  it("puts single-section masks together over their box", () => {
    const a = { lo: [10, 10, 4] as Vec3, size: [2, 2, 1] as Vec3, data: Uint8Array.from([1, 1, 1, 0]) };
    const b = { lo: [11, 11, 5] as Vec3, size: [2, 1, 1] as Vec3, data: Uint8Array.from([1, 1]) };
    const m = stackMasks([a, b])!;
    expect(m.lo).toEqual([10, 10, 4]);
    expect(m.size).toEqual([3, 2, 2]);
    expect(maskCount(m)).toBe(5);
    expect(m.data[1 + 3 * (1 + 2 * 1)]).toBe(1);
    expect(stackMasks([])).toBeUndefined();
    expect(sectionBounds({ lo: [0, 0, 0], size: [2, 2, 1], data: new Uint8Array(4) }, 2)).toBeUndefined();
  });
});

describe("the method", () => {
  it("is in the registry after the threshold, takes boxes and clicks, refines, and names its model and licence", () => {
    const registry = new QuickSelectRegistry();
    const off = registry.register(samMethod(new SamModel()));
    expect(registry.methods().map((m) => m.title)).toEqual(["Threshold", "AI (MobileSAM)"]);
    const m = registry.methods()[1];
    expect(m.prompts).toEqual(["box", "point"]);
    expect(m.refines).toBe(true);
    expect(m.description).toContain("Apache-2.0");
    expect(MOBILE_SAM.licence).toBe("Apache-2.0");
    // Pinned files and runtime, under 100 MB.
    expect(MOBILE_SAM.encoder.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    expect(ORT_URL).toContain("onnxruntime-web@1.30.0");
    expect(MODEL_BYTES).toBeLessThan(100e6);
    off();
    expect(registry.methods().length).toBe(1);
  });
});
