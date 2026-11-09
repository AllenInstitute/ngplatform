/**
 * The Filters panel's steps as chunkmirage ops: each step a kind and its
 * settings, made into the op specs of a pipeline (`opsOf`).  Gaussian, mean
 * (chunkmirage's `uniform`), difference of Gaussians, threshold and
 * morphology are chunkmirage's own ops; median and Frangi's vesselness are
 * `python` ops whose code is the plugin's (`MEDIAN`, `FRANGI`), their
 * settings sliders (`params`) and their #halo set from them.  Sizes are in
 * voxels of the level computed: a coarse level is a preview.
 */

export type StepKind = "gaussian" | "mean" | "median" | "dog" | "frangi" | "threshold" | "morphology" | "python";

export interface Step {
  kind: StepKind;
  /** Gaussian and difference of Gaussians: sigma, voxels. */
  sigma: number;
  /** Mean, median and morphology: radius, voxels. */
  radius: number;
  /** Frangi: the scales' sigma, voxels, from and to. */
  sigmaLow: number;
  sigmaHigh: number;
  /** Frangi: tubes brighter than around them (or darker). */
  bright: boolean;
  /** Threshold: from (inclusive) and below (exclusive; NaN for none), in the image's units. */
  low: number;
  high: number;
  /** Morphology: open or close. */
  operation: "open" | "close";
  /** Python of one's own: chunkmirage's python op (apply(block) on each block, its #halo and #output lines). */
  code: string;
}

export const STEP_KINDS: [StepKind, string][] = [
  ["gaussian", "Gaussian"],
  ["mean", "Mean"],
  ["median", "Median"],
  ["dog", "Difference of Gaussians"],
  ["frangi", "Frangi vesselness"],
  ["threshold", "Threshold"],
  ["morphology", "Morphology (open, close)"],
  ["python", "Python (your own)"],
];

/** A python step's code to start from: chunkmirage's directives, and a block passed through. */
export const PYTHON_START = `#halo 0
#output float32 image
# apply gets each block (a NumPy array, z, y, x) with #halo voxels of context
# on each side, and returns the block computed. numpy is np; scipy and
# scikit-image can be imported.
def apply(block):
    return block.astype(np.float32)
`;

/** Output chunks: 64 voxels a side. */
export const CHUNK = [64, 64, 64];

/**
 * The largest settings, so that no step reads more than half a chunk
 * (32 voxels) of context on each side of each 64-voxel chunk: a halo of 32
 * already reads 8 times the chunk.  Gaussian reads ceil(3 sigma), difference
 * of Gaussians ceil(4.8 sigma) (its wider blur is 1.6 sigma), mean and
 * median the radius (and 1), morphology 2 radius + 1, Frangi 3 sigma + 1.
 */
export const LIMITS = { sigma: 10, dogSigma: 6, radius: 15, frangiSigma: 10 } as const;

/** The smallest: a sigma of 0.1 (Frangi's 0.5, as its code has it), a radius of 1. */
export const MINIMA = { sigma: 0.1, radius: 1, frangiSigma: 0.5 } as const;

const within = (v: number, min: number, max: number) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : v);

/** A step with its sizes kept within LIMITS (an empty setting, NaN, stays empty). */
export function bounded(s: Step): Step {
  return {
    ...s,
    sigma: within(s.sigma, MINIMA.sigma, s.kind === "dog" ? LIMITS.dogSigma : LIMITS.sigma),
    radius: within(Number.isFinite(s.radius) ? Math.round(s.radius) : s.radius, MINIMA.radius, LIMITS.radius),
    sigmaLow: within(s.sigmaLow, MINIMA.frangiSigma, LIMITS.frangiSigma),
    sigmaHigh: within(s.sigmaHigh, MINIMA.frangiSigma, LIMITS.frangiSigma),
  };
}

export function newStep(kind: StepKind = "gaussian"): Step {
  return { kind, sigma: 1, radius: 1, sigmaLow: 1, sigmaHigh: 3, bright: true, low: 100, high: Number.NaN, operation: "open", code: PYTHON_START };
}

export const MEDIAN = `#halo 1
#output float32 image
#uicontrol int radius slider(min=1, max=16, default=1)
# The median over a cube of (2 radius + 1) voxels a side.
import numpy as np
from scipy.ndimage import median_filter

def apply(block, radius):
    return median_filter(block.astype(np.float32), size=2 * radius + 1, mode="nearest")
`;

export const FRANGI = `#halo 9
#output float32 image
#uicontrol float sigma_low slider(min=0.5, max=16, default=1)
#uicontrol float sigma_high slider(min=0.5, max=16, default=3)
#uicontrol bool bright checkbox(default=true)
# Frangi's vesselness, over five scales from sigma_low to sigma_high (voxels): how much
# each voxel looks like part of a tube brighter (or darker) than around it, 0 to 1.
import numpy as np
from skimage.filters import frangi

def apply(block, sigma_low, sigma_high, bright):
    sigmas = np.linspace(min(sigma_low, sigma_high), max(sigma_low, sigma_high), 5)
    return frangi(block.astype(np.float32), sigmas=sigmas, black_ridges=not bright).astype(np.float32)
`;

const withHalo = (code: string, halo: number) => code.replace(/^#halo[ \d]*$/m, `#halo ${Math.max(0, Math.ceil(halo))}`);

/** A step as chunkmirage's op spec, its sizes within LIMITS. */
export function opOf(step: Step): Record<string, unknown> {
  const s = bounded(step);
  switch (s.kind) {
    case "gaussian":
      return { op: "gaussian", sigma: s.sigma };
    case "mean":
      return { op: "uniform", size: 2 * Math.max(1, Math.round(s.radius)) + 1 };
    case "median": {
      const radius = Math.max(1, Math.round(s.radius));
      return { op: "python", code: withHalo(MEDIAN, radius), params: { radius } };
    }
    case "dog":
      return { op: "dog", sigma: s.sigma };
    case "frangi": {
      const high = Math.max(s.sigmaLow, s.sigmaHigh);
      return { op: "python", code: withHalo(FRANGI, 3 * high + 1), params: { sigma_low: s.sigmaLow, sigma_high: s.sigmaHigh, bright: s.bright } };
    }
    case "threshold":
      return { op: "threshold", low: s.low, ...(Number.isFinite(s.high) ? { high: s.high } : {}) };
    case "morphology":
      return { op: "morphology", operation: s.operation, radius: Math.max(1, Math.round(s.radius)) };
    case "python":
      return { op: "python", code: s.code };
  }
}

export function opsOf(steps: Step[]): Record<string, unknown>[] {
  return steps.map(opOf);
}

/** A step in a few words, for the layer's name. */
export function describe(s: Step): string {
  switch (s.kind) {
    case "gaussian":
      return `gaussian σ ${s.sigma}`;
    case "dog":
      return `DoG σ ${s.sigma}`;
    case "mean":
    case "median":
      return `${s.kind} r ${s.radius}`;
    case "frangi":
      return `frangi σ ${s.sigmaLow}–${s.sigmaHigh}`;
    case "threshold":
      return Number.isFinite(s.high) ? `${s.low} ≤ v < ${s.high}` : `≥ ${s.low}`;
    case "morphology":
      return `${s.operation} r ${s.radius}`;
    case "python":
      return "python";
  }
}

/** What a python step's `#output` line says it returns: an image, labels or a mask (undefined: not said). */
export function pythonOutput(code: string): "image" | "label" | "mask" | undefined {
  const line = /^#output\b(.*)$/m.exec(code)?.[1] ?? "";
  return (/\b(image|label|mask)\b/.exec(line)?.[1] as "image" | "label" | "mask" | undefined) ?? undefined;
}

/**
 * Whether the pipeline's output is a mask or labels (shown as a segmentation), not an image:
 * a threshold followed only by morphology, or a last python step whose #output says label or mask.
 */
export function makesLabels(steps: Step[]): boolean {
  const lastStep = steps.at(-1);
  if (lastStep?.kind === "python") {
    const out = pythonOutput(lastStep.code);
    if (out !== undefined) return out !== "image";
  }
  const last = steps.findLastIndex((s) => s.kind === "threshold");
  // After it, morphology, or python that does not say what it returns (chunkmirage: the input's kind).
  return last !== -1 && steps.slice(last + 1).every((s) => s.kind === "morphology" || (s.kind === "python" && pythonOutput(s.code) === undefined));
}

/** Whether a step has a setting left empty that it needs (a threshold's "below" may be empty). */
export function blankSetting(s: Step): boolean {
  const needed: number[] =
    s.kind === "gaussian" || s.kind === "dog"
      ? [s.sigma]
      : s.kind === "frangi"
        ? [s.sigmaLow, s.sigmaHigh]
        : s.kind === "threshold"
          ? [s.low]
          : s.kind === "python"
            ? []
            : [s.radius];
  return needed.some((v) => !Number.isFinite(v));
}

const sameCode = (a: unknown, b: string) => String(a ?? "").replace(/^#halo[ \d]*$/m, "#halo") === b.replace(/^#halo[ \d]*$/m, "#halo");

/** A number read back (from ops or saved steps, where NaN was written as null), or `fallback`. */
const numberOr = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/**
 * The steps that make `ops` (the inverse of `opsOf`), so a filtered layer's
 * pipeline can be edited again; undefined when an op is not one a step makes.
 */
export function stepsOf(ops: Record<string, unknown>[] | undefined): Step[] | undefined {
  if (!Array.isArray(ops) || ops.length === 0) return undefined;
  const steps: Step[] = [];
  for (const op of ops) {
    const params = (op.params ?? {}) as Record<string, unknown>;
    switch (op.op) {
      case "gaussian":
      case "dog":
        steps.push({ ...newStep(op.op), sigma: numberOr(op.sigma, 1) });
        break;
      case "uniform":
        steps.push({ ...newStep("mean"), radius: Math.max(1, Math.round((numberOr(op.size, 3) - 1) / 2)) });
        break;
      case "threshold":
        steps.push({ ...newStep("threshold"), low: numberOr(op.low, 100), high: numberOr(op.high, Number.NaN) });
        break;
      case "morphology":
        steps.push({ ...newStep("morphology"), operation: op.operation === "close" ? "close" : "open", radius: numberOr(op.radius, 1) });
        break;
      case "python":
        if (sameCode(op.code, MEDIAN)) steps.push({ ...newStep("median"), radius: numberOr(params.radius, 1) });
        else if (sameCode(op.code, FRANGI)) steps.push({ ...newStep("frangi"), sigmaLow: numberOr(params.sigma_low, 1), sigmaHigh: numberOr(params.sigma_high, 3), bright: params.bright !== false });
        else steps.push({ ...newStep("python"), code: String(op.code ?? "") });
        break;
      default:
        return undefined;
    }
  }
  return steps.map(bounded);
}

/** The Filters panel as kept in the workspace (and its link): the image chosen and the steps. */
export interface SavedFilters {
  image?: string;
  steps?: Partial<Record<keyof Step, unknown>>[];
}

/** Steps kept in the workspace, read back (each setting checked, a missing one the default). */
export function readSteps(saved: SavedFilters["steps"]): Step[] | undefined {
  if (!Array.isArray(saved) || saved.length === 0) return undefined;
  return saved.map((s): Step => {
    const kind = STEP_KINDS.some(([k]) => k === s.kind) ? (s.kind as StepKind) : "gaussian";
    const d = newStep(kind);
    // An emptied setting was kept as null: empty again (NaN); a missing one is the default.
    const num = (v: unknown, fallback: number) => (v === null ? Number.NaN : numberOr(v, fallback));
    return bounded({
      kind,
      sigma: num(s.sigma, d.sigma),
      radius: num(s.radius, d.radius),
      sigmaLow: num(s.sigmaLow, d.sigmaLow),
      sigmaHigh: num(s.sigmaHigh, d.sigmaHigh),
      bright: typeof s.bright === "boolean" ? s.bright : d.bright,
      low: num(s.low, d.low),
      high: num(s.high, Number.NaN),
      operation: s.operation === "close" ? "close" : "open",
      code: typeof s.code === "string" ? s.code : d.code,
    });
  });
}
