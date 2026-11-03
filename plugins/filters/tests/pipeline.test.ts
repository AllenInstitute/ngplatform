/** The Filters tab's steps as chunkmirage ops. */
import { describe, expect, it } from "vitest";
import { FRANGI, makesLabels, MEDIAN, newStep, opOf, opsOf } from "../pipeline.js";

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
});
