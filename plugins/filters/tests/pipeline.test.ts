/** The Filters tab's steps as chunkmirage ops. */
import { describe, expect, it } from "vitest";
import { blankSetting, FRANGI, makesLabels, MEDIAN, newStep, opOf, opsOf } from "../pipeline.js";

const halo = (code: unknown) => Number(/^#halo (\d+)$/m.exec(String(code))?.[1]);

describe("filter steps", () => {
  it("are chunkmirage's ops, or the plugin's Python with its halo set from the size", () => {
    expect(opOf({ ...newStep("gaussian"), sigma: 2 })).toEqual({ op: "gaussian", sigma: 2 });
    expect(opOf({ ...newStep("mean"), radius: 2 })).toEqual({ op: "uniform", size: 5 });
    const median = opOf({ ...newStep("median"), radius: 3 });
    expect(median.op).toBe("python");
    expect(halo(median.code)).toBe(3);
    expect(median.params).toEqual({ radius: 3 });
    expect(String(median.code).replace(/^#halo.*$/m, "")).toBe(MEDIAN.replace(/^#halo.*$/m, ""));
    const frangi = opOf({ ...newStep("frangi"), sigmaLow: 1, sigmaHigh: 4, bright: false });
    expect(halo(frangi.code)).toBe(13);
    expect(frangi.params).toEqual({ sigma_low: 1, sigma_high: 4, bright: false });
    expect(String(frangi.code).replace(/^#halo.*$/m, "")).toBe(FRANGI.replace(/^#halo.*$/m, ""));
    expect(opOf({ ...newStep("threshold"), low: 50 })).toEqual({ op: "threshold", low: 50 });
    expect(opOf({ ...newStep("threshold"), low: 50, high: 90 })).toEqual({ op: "threshold", low: 50, high: 90 });
    expect(opsOf([newStep("gaussian"), { ...newStep("morphology"), operation: "close", radius: 2 }])[1]).toEqual({ op: "morphology", operation: "close", radius: 2 });
  });

  it("make labels when they end in a threshold, cleaned or not", () => {
    expect(makesLabels([newStep("gaussian"), newStep("threshold")])).toBe(true);
    expect(makesLabels([newStep("threshold"), newStep("morphology")])).toBe(true);
    expect(makesLabels([newStep("threshold"), newStep("gaussian")])).toBe(false);
    expect(makesLabels([newStep("median")])).toBe(false);
  });

  it("make labels when a last python step says #output label or mask", () => {
    const python = (code: string) => ({ ...newStep("python"), code });
    expect(makesLabels([python("#halo 1\n#output uint32 label\ndef apply(b):\n    return b\n")])).toBe(true);
    expect(makesLabels([python("#output mask\n")])).toBe(true);
    expect(makesLabels([newStep("threshold"), python("#output float32 image\n")])).toBe(false);
    expect(makesLabels([newStep("threshold"), python("def apply(b):\n    return b\n")])).toBe(true);
    expect(makesLabels([newStep("python")])).toBe(false);
  });

  it("say when a setting a step needs is empty", () => {
    expect(blankSetting({ ...newStep("gaussian"), sigma: Number.NaN })).toBe(true);
    expect(blankSetting({ ...newStep("threshold"), high: Number.NaN })).toBe(false);
    expect(blankSetting({ ...newStep("threshold"), low: Number.NaN })).toBe(true);
    expect(blankSetting({ ...newStep("morphology"), radius: Number.NaN })).toBe(true);
    expect(blankSetting(newStep("frangi"))).toBe(false);
  });
});

describe("a python step", () => {
  it("is chunkmirage's python op with the code as written", () => {
    expect(opOf({ ...newStep("python"), code: "def apply(block):\n    return block\n" })).toEqual({ op: "python", code: "def apply(block):\n    return block\n" });
    expect(String(opOf(newStep("python")).code)).toMatch(/^#halo 0\n#output float32 image\n/);
  });
});
