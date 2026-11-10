/** The Filters panel's steps as chunkmirage ops. */
import { describe, expect, it } from "vitest";
import { blankSetting, bounded, CHUNK, FRANGI, LIMITS, makesLabels, MEDIAN, newStep, opOf, opsOf, readSteps, type Step, stepsOf } from "../pipeline.js";

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

describe("steps read back", () => {
  const every: Step[] = [
    { ...newStep("gaussian"), sigma: 2.5 },
    { ...newStep("mean"), radius: 2 },
    { ...newStep("median"), radius: 3 },
    { ...newStep("dog"), sigma: 1.5 },
    { ...newStep("frangi"), sigmaLow: 1, sigmaHigh: 4, bright: false },
    { ...newStep("threshold"), low: 50, high: 90 },
    { ...newStep("threshold"), low: 7 },
    { ...newStep("morphology"), operation: "close", radius: 2 },
    { ...newStep("python"), code: "#halo 1\ndef apply(block):\n    return block\n" },
  ];

  it("from a filtered layer's ops, which they make again", () => {
    const steps = stepsOf(opsOf(every))!;
    expect(steps.map((s) => s.kind)).toEqual(every.map((s) => s.kind));
    expect(opsOf(steps)).toEqual(opsOf(every));
    expect(stepsOf([{ op: "resample" }])).toBeUndefined();
    expect(stepsOf([])).toBeUndefined();
  });

  it("from the workspace, an emptied setting empty again", () => {
    const json = JSON.parse(JSON.stringify(every.map((s) => ({ ...s })), (_, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)));
    const steps = readSteps(json)!;
    expect(opsOf(steps)).toEqual(opsOf(every));
    expect(Number.isNaN(steps[6].high)).toBe(true);
    const emptied = readSteps([{ kind: "gaussian", sigma: null }, { kind: "nonsense" }])!;
    expect(Number.isNaN(emptied[0].sigma)).toBe(true);
    expect(blankSetting(emptied[0])).toBe(true);
    expect(emptied[1].kind).toBe("gaussian");
    expect(readSteps(undefined)).toBeUndefined();
  });
});

describe("the sizes", () => {
  /** The context each op reads on each side, as chunkmirage works it out. */
  const reads = (op: Record<string, unknown>): number => {
    switch (op.op) {
      case "gaussian":
        return Math.ceil(3 * Number(op.sigma));
      case "dog":
        return Math.ceil(3 * 1.6 * Number(op.sigma));
      case "uniform":
        return Math.floor(Number(op.size) / 2) + 1;
      case "morphology":
        return 2 * Number(op.radius) + 1;
      default:
        return halo(op.code);
    }
  };

  it("read at most half a chunk around each chunk, at their largest", () => {
    const largest: Step[] = [
      { ...newStep("gaussian"), sigma: LIMITS.sigma },
      { ...newStep("dog"), sigma: LIMITS.dogSigma },
      { ...newStep("mean"), radius: LIMITS.radius },
      { ...newStep("median"), radius: LIMITS.radius },
      { ...newStep("morphology"), radius: LIMITS.radius },
      { ...newStep("frangi"), sigmaLow: LIMITS.frangiSigma, sigmaHigh: LIMITS.frangiSigma },
    ];
    for (const op of opsOf(largest)) expect(reads(op)).toBeLessThanOrEqual(CHUNK[0] / 2);
  });

  it("are kept within their limits, whether typed, kept in the workspace or read from a link", () => {
    expect(opOf({ ...newStep("gaussian"), sigma: 400 })).toEqual({ op: "gaussian", sigma: LIMITS.sigma });
    expect(opOf({ ...newStep("dog"), sigma: 400 })).toEqual({ op: "dog", sigma: LIMITS.dogSigma });
    expect(halo(opOf({ ...newStep("frangi"), sigmaLow: 1, sigmaHigh: 1e6 }).code)).toBe(3 * LIMITS.frangiSigma + 1);
    expect(halo(opOf({ ...newStep("median"), radius: 1e6 }).code)).toBe(LIMITS.radius);
    expect(readSteps([{ kind: "morphology", radius: 99 }])![0].radius).toBe(LIMITS.radius);
    expect(stepsOf([{ op: "gaussian", sigma: 1e4 }])![0].sigma).toBe(LIMITS.sigma);
    expect(stepsOf([{ op: "uniform", size: 401 }])![0].radius).toBe(LIMITS.radius);
    expect(bounded({ ...newStep("gaussian"), sigma: 0 }).sigma).toBe(0.1);
    // An emptied setting stays empty, for the panel to ask for.
    expect(Number.isNaN(bounded({ ...newStep("gaussian"), sigma: Number.NaN }).sigma)).toBe(true);
  });
});
