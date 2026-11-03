/**
 * The Filters tab's steps as chunkmirage ops: each step a kind and its
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

/** A step as chunkmirage's op spec. */
export function opOf(s: Step): Record<string, unknown> {
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

/** Whether the pipeline's output is a mask or labels (shown as a segmentation), not an image. */
export function makesLabels(steps: Step[]): boolean {
  const last = steps.findLastIndex((s) => s.kind === "threshold");
  return last !== -1 && steps.slice(last + 1).every((s) => s.kind === "morphology");
}
