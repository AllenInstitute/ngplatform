/**
 * Saving in blocks: the same OME-Zarr chunks, level by level, as resampling
 * the whole image at once and halving it (nearest and trilinear exactly,
 * cubic within rounding of the prefilter's margin).
 */
import { describe, expect, it } from "vitest";
import { saveInBlocks, saveInSlabs } from "../blocks.js";
import { identity4, type Mat4 } from "../fit.js";
import { manualMatrix, identityManual } from "../manual.js";
import { omeZarrFiles, resample, type Volume } from "../volume_io.js";

const gunzip = async (b: Uint8Array) => new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

function image(size: [number, number, number], type: "float32" | "uint16"): Volume {
  const data = type === "float32" ? new Float32Array(size[0] * size[1] * size[2]) : new Uint16Array(size[0] * size[1] * size[2]);
  for (let z = 0, i = 0; z < size[2]; ++z) for (let y = 0; y < size[1]; ++y) for (let x = 0; x < size[0]; ++x, ++i) data[i] = 1000 + 400 * Math.sin(x / 9) * Math.cos(y / 7) + 3 * z;
  return { data, size, type, voxelToRas: Float64Array.from([-0.5, 0, 0, 60, 0, 0.5, 0, -10, 0, 0, 0.5, -5, 0, 0, 0, 1]) };
}

async function both(source: Volume, move: Mat4, method: "nearest" | "linear" | "cubic", label = false) {
  const grid = { size: source.size, voxelToRas: source.voxelToRas };
  const whole = await omeZarrFiles({ ...source, data: resample(source, grid, move, label ? "nearest" : method) }, "x", { label });
  const blocks = new Map<string, Uint8Array>();
  const read = async (lo: number[], hi: number[]) => {
    const out = new Float32Array((hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]));
    let at = 0;
    for (let z = lo[2]; z < hi[2]; ++z) for (let y = lo[1]; y < hi[1]; ++y) for (let x = lo[0]; x < hi[0]; ++x) out[at++] = source.data[x + source.size[0] * (y + source.size[1] * z)];
    return out;
  };
  await saveInBlocks({ ...source, read }, grid, move, { method, label, name: "x", description: "" }, async (files) => files.forEach(([k, v]) => blocks.set(k, v)), () => {}, new AbortController().signal);
  return { whole, blocks };
}

async function compare(whole: Map<string, Uint8Array>, blocks: Map<string, Uint8Array>, type: "float32" | "uint16", tolerance: number) {
  const chunkKeys = (m: Map<string, Uint8Array>) => [...m.keys()].filter((k) => k.includes("/c/")).sort();
  expect(chunkKeys(blocks)).toEqual(chunkKeys(whole));
  expect([...blocks.keys()].filter((k) => k.endsWith("zarr.json")).sort()).toEqual([...whole.keys()].filter((k) => k.endsWith("zarr.json")).sort());
  let worst = 0;
  for (const key of chunkKeys(whole)) {
    const a = await gunzip(whole.get(key)!);
    const b = await gunzip(blocks.get(key)!);
    const [x, y] = type === "float32" ? [new Float32Array(a.buffer), new Float32Array(b.buffer)] : [new Uint16Array(a.buffer), new Uint16Array(b.buffer)];
    for (let i = 0; i < x.length; ++i) worst = Math.max(worst, Math.abs(x[i] - y[i]));
  }
  expect(worst).toBeLessThanOrEqual(tolerance);
}

describe("saving in blocks", () => {
  const turned = manualMatrix({ ...identityManual(), rotate: [7, -4, 11], translate: [3.3, -2.1, 1.7] }, [0, 0, 0]);
  it("matches the whole image resampled at once (trilinear and nearest, across several blocks)", async () => {
    const source = image([300, 70, 270], "uint16");
    for (const method of ["linear", "nearest"] as const) {
      const { whole, blocks } = await both(source, turned, method);
      await compare(whole, blocks, "uint16", 0);
    }
  }, 60_000);

  it("matches it for cubic within the prefilter's margin, and keeps labels' values", async () => {
    const source = image([280, 40, 60], "float32");
    const { whole, blocks } = await both(source, turned, "cubic");
    await compare(whole, blocks, "float32", 1e-3);
    const labels = await both(image([270, 30, 30], "uint16"), identity4(), "nearest", true);
    await compare(labels.whole, labels.blocks, "uint16", 0);
  }, 60_000);
});

describe("saving NIfTI and MGH in slabs", () => {
  const turned = manualMatrix({ ...identityManual(), rotate: [9, 3, -6], translate: [1.3, -2.2, 0.7] }, [0, 0, 0]);
  const source = image([290, 40, 30], "uint16");
  const read = async (lo: number[], hi: number[]) => {
    const out = new Float32Array((hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]));
    let at = 0;
    for (let z = lo[2]; z < hi[2]; ++z) for (let y = lo[1]; y < hi[1]; ++y) for (let x = lo[0]; x < hi[0]; ++x) out[at++] = source.data[x + source.size[0] * (y + source.size[1] * z)];
    return out;
  };
  const grid = { size: source.size, voxelToRas: source.voxelToRas };

  for (const format of ["nii", "mgh"] as const) {
    it(`writes the same ${format} file as the whole image at once, slab by slab`, async () => {
      const { niftiFile, mghFile } = await import("../volume_io.js");
      const whole = { ...source, data: resample(source, grid, turned, "linear") };
      const want = format === "nii" ? niftiFile(whole, { window: [100, 900], description: "d" }) : mghFile(whole);
      const parts: Uint8Array[] = [];
      // Slabs of 5 planes, and tiles across x (290 > 256): every seam is crossed.
      await saveInSlabs({ ...source, read }, grid, turned, { method: "linear", label: false, format, description: "d", window: [100, 900], slabVoxels: 290 * 40 * 5 }, async (b) => void parts.push(b.slice()), () => {}, new AbortController().signal);
      const got = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      parts.reduce((o, p) => (got.set(p, o), o + p.length), 0);
      expect(got.length).toBe(want.length);
      expect(got.every((v, i) => v === want[i])).toBe(true);
    });
  }
});
