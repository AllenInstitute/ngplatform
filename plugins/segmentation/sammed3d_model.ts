/**
 * Quick select's 3-D method, "AI 3-D (SAM-Med3D)": clicks (or a box) in any
 * 2-D view segmented in 3-D at once by SAM-Med3D-turbo (Apache-2.0), run in
 * this page in a worker (./sammed3d_worker.ts), with ONNX Runtime Web from
 * jsDelivr.
 *
 * - The model's files (an encoder and a decoder, float16 weights, about
 *   200 MB; manifest.json lists them) come from `sammed3dBase()`: localStorage
 *   `ngplatform.sammed3d.url` when set, else `models/sammed3d/` beside the app
 *   (`npm run dev` serves the repository's models/). tools/sammed3d/ makes them.
 * - A box (or else the first click) places a cube of 128 voxels round its
 *   middle in the world's axes, at the model's 1.5 mm (coarser for a large
 *   box), read from the image's level nearest that, normalised, and encoded
 *   once. Its mask comes back as 3-D on the label grid.
 * - The model was trained on crops centred on the structure: it does well only
 *   when the cube's centre is within about 10 mm of the structure's (on AMOS,
 *   Dice 0.92 for a kidney so centred, 0.08 centred 20 mm off). So the box goes
 *   on a slice through the middle of the structure, the click near its middle
 *   (tools/sammed3d/README.md has the measurements).
 * - Later clicks in the cube (in any section: Shift or Alt for what is not
 *   wanted) refine it: the decoder alone, with the last mask fed back.
 */
import type { Vec3 } from "./kernels.js";
import type { Mask, QuickSelectMethod, QuickSelectRequest } from "./quick_select.js";
import { type Cube, cubeAt, maskOnLabels, modelVolume, pointInCube, SAMMED3D_SIZE, SAMMED3D_SPACING, spacingFor, upsampleMask } from "./sammed3d.js";
import type { SamMed3dReply, SamMed3dRequest } from "./sammed3d_worker.js";
import { HostedModel, modelBase } from "./hosted_model.js";

export const SAMMED3D = {
  id: "sammed3d",
  name: "SAM-Med3D",
  licence: "Apache-2.0",
  home: "https://github.com/uni-medical/SAM-Med3D",
  /** The files' size with float16 weights (tools/sammed3d/), until the manifest says. */
  bytes: 205_000_000,
};

export function sammed3dBase(): string {
  return modelBase("ngplatform.sammed3d.url", "models/sammed3d/");
}

export class SamMed3dModel extends HostedModel<SamMed3dRequest, SamMed3dReply> {
  /** The cube encoded last, and how many clicks its last mask came from. */
  private cube: { key: string; image: string; cube: Cube; clicks: number } | undefined;

  constructor() {
    super(SAMMED3D.name, SAMMED3D.licence, SAMMED3D.bytes);
  }

  base(): string {
    return sammed3dBase();
  }

  protected startWorker(): Worker {
    return new Worker(new URL("./sammed3d_worker.ts", import.meta.url), { type: "module", name: "SAM-Med3D" });
  }

  protected onStopped(): void {
    this.cube = undefined;
  }

  async segment(request: QuickSelectRequest, signal: AbortSignal): Promise<Mask> {
    const { grid, source } = request;
    if (grid === undefined || source === undefined) throw new Error("SAM-Med3D needs the image's values: choose an image under “Image values”.");
    const given = request.prompts ?? (request.prompt.kind === "box" ? { box: { lo: request.prompt.lo, hi: request.prompt.hi }, points: [] } : { points: [{ at: request.prompt.at, positive: true }] });
    // The model was trained on crops centred on the structure, and segments well only when the cube's centre is
    // within about a tenth of the cube of the structure's: a box's middle (on its slice), else the first click.
    // Its points: the clicks, else the box's middle.
    const placed = cubePrompts(given, source.spacing);
    if (placed === undefined) throw new Error("Click on what is wanted first (or draw a box round it).");
    const { centre, spacing } = placed;
    await this.ready(request.progress, signal);

    // The cube: the last one when the prompts place it there (more clicks refine its mask), else a new one.
    const cube = cubeAt(centre, grid.labelToRas, spacing, grid.levels);
    const key = `${source.key}|${centre.join(",")}|${spacing}`;
    let held = this.cube;
    if (held === undefined || held.key !== key || !(await this.call({ op: "has", key })).has) {
      request.progress?.(`Reading ${SAMMED3D_SIZE}³ voxels of ${spacing.toFixed(1)} mm round the prompt…`);
      const values = await grid.read(cube.level, cube.gridToLabel, [SAMMED3D_SIZE, SAMMED3D_SIZE, SAMMED3D_SIZE], signal);
      if (values === undefined) throw new Error("Could not read the image there.");
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      request.progress?.("Computing the volume's features…");
      const image = modelVolume(values);
      const r = await this.call({ op: "encode", key, image }, [image.buffer]);
      this.encodeMs = r.ms;
      held = this.cube = { key, image: source.key, cube, clicks: 0 };
    }
    // Clicks outside the cube are not the model's to see.
    const clicks = placed.points.map((c) => ({ g: pointInCube(held!.cube, c.at), positive: c.positive })).filter((c) => c.g.every((v) => v >= 0 && v <= SAMMED3D_SIZE - 1));
    if (!clicks.some((c) => c.positive)) throw new Error("The click is outside the region segmented: start again there.");
    request.progress?.("Computing the mask…");
    const points = new Float32Array(clicks.length * 3);
    clicks.forEach((c, i) => points.set(c.g, 3 * i));
    const labels = Int32Array.from(clicks, (c) => (c.positive ? 1 : 0));
    const r = await this.call({ op: "decode", key, points, labels, refine: held.clicks > 0 && clicks.length > held.clicks });
    this.decodeMs = r.ms;
    held.clicks = clicks.length;
    this.changed();
    return maskOnLabels(upsampleMask(r.mask!), held.cube, source.size);
  }
}

type Prompts = NonNullable<QuickSelectRequest["prompts"]>;

/**
 * Where the cube goes for these prompts (label voxels; spacing in mm) and the points the model is given: a box
 * centres it (its extent sets the spacing) and its middle is the point unless there are clicks; else the first
 * click wanted centres it. Undefined when nothing wanted is given.
 */
export function cubePrompts(prompts: Prompts, voxelMm: ArrayLike<number>): { centre: Vec3; spacing: number; points: { at: Vec3; positive: boolean }[] } | undefined {
  const points = prompts.points.map((p) => ({ at: p.at, positive: p.positive }));
  if (prompts.box) {
    const { lo, hi } = prompts.box;
    const centre = lo.map((v, k) => (v + hi[k] - 1) / 2) as Vec3;
    const extentMm = Math.max(...[0, 1, 2].map((k) => (hi[k] - lo[k]) * voxelMm[k]));
    return { centre, spacing: spacingFor(extentMm), points: points.some((p) => p.positive) ? points : [{ at: centre, positive: true }, ...points] };
  }
  const first = points.find((p) => p.positive);
  return first === undefined ? undefined : { centre: first.at, spacing: SAMMED3D_SPACING, points };
}

/** The method, for the quick-select registry. */
export function sammed3dMethod(model: SamMed3dModel): QuickSelectMethod {
  return {
    id: SAMMED3D.id,
    title: `AI 3-D (${SAMMED3D.name})`,
    description: `${SAMMED3D.name} (${SAMMED3D.licence}), run in this page: a box round the structure, on a slice through its middle (or a click near its middle), segments it in 3-D at once, in a 19 cm cube centred there at 1.5 mm; more clicks in any section refine it (Shift or Alt: not wanted). About ${(SAMMED3D.bytes / 1e6).toFixed(0)} MB, downloaded on first use and kept in this browser.`,
    prompts: ["point", "box"],
    refines: true,
    ai: true,
    volumetric: true,
    run: (request, signal) => model.segment(request, signal),
  };
}
