/**
 * The filters plugin: the Filters panel, which adds an image computed as it
 * is viewed: a pipeline of steps (pipeline.ts) over an image layer, run by
 * chunkmirage's browser engine (the platform's `workspace.computed`).  The
 * new layer's source carries the whole pipeline, so its link works in any
 * browser that can read the image.  With a filtered layer selected, the
 * panel shows its steps, and tuning them updates that layer in place.
 *
 * The panel is built the way every panel is (plugins/README.md, "Building a
 * panel"): cards of the SDK's controls, drawn once and then kept up to date
 * in place, so a change of state never closes a select or takes a value
 * from under the person typing it.
 */
import type { LayerTransform, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { button, card, checkbox, el, emptyState, field, iconButton, numberInput, region, select, slider, statusLine } from "@ngplatform/sdk/dom";
import { FILTERS_PANEL } from "./manifest.js";
import {
  blankSetting,
  CHUNK,
  describe,
  FRANGI,
  LIMITS,
  makesLabels,
  MEDIAN,
  MINIMA,
  newStep,
  opsOf,
  pythonOutput,
  readSteps,
  type SavedFilters,
  type Step,
  STEP_KINDS,
  type StepKind,
  stepsOf,
} from "./pipeline.js";

/** A layer's source as the engine reads it, for comparing: no scheme prefix, pipeline or trailing slash. */
const bareSource = (s: string) =>
  s
    .replace(/\|.*$/, "")
    .replace(/^(zarr3?|zarr2|n5|ome-zarr):\/\//, "")
    .replace(/\/+$/, "");

/** A layer specification's source URL. */
function urlOf(spec: unknown): string | undefined {
  const s = (spec as { source?: unknown } | undefined)?.source;
  return typeof s === "string" ? s : typeof (s as { url?: unknown })?.url === "string" ? (s as { url: string }).url : undefined;
}

/** Whether a layer's source is an image the platform computes (a filtered view, or a warp). */
const computedSource = (source: string | undefined) => source !== undefined && source.includes("/virtual/ngp/");

/**
 * Why an image layer cannot be filtered, from its source's axes (as
 * `layerTransform` gives them); undefined when it can.  chunkmirage filters
 * a 3-D image: it reads the first channel and time point of anything more,
 * and refuses an image without z, y and x.  An axis one voxel long does not
 * count.
 */
export function unfilterable(t: Pick<LayerTransform, "input"> | undefined): string | undefined {
  if (t === undefined) return "still loading";
  const { names, units, bounds } = t.input;
  const extent = (i: number) => (bounds === undefined ? Number.POSITIVE_INFINITY : Math.round(bounds.upper[i] - bounds.lower[i]));
  const spatial = (i: number) => units[i] === "m" || /^[xyz]$/.test(names[i]);
  for (let i = 0; i < names.length; i++) {
    if (spatial(i) || extent(i) <= 1) continue;
    const n = extent(i);
    const known = Number.isFinite(n);
    if (units[i] === "s" || names[i].replace(/['^]$/, "") === "t") return known ? `a time series of ${n}` : "a time series";
    return known ? `${n} channels` : "channels";
  }
  if (names.filter((_, i) => spatial(i) && extent(i) > 1).length < 3) return "2-D";
  return undefined;
}

/**
 * How a filtered layer is first shown, from its steps and the image's
 * layer specification: undefined for Neuroglancer's own default.
 * Smoothing, and Python that returns an image, keep the image's values, so
 * its shader and range; vesselness is 0 to 1; a difference of Gaussians is
 * uint8, 128 where nothing changes.  (Float32 results would otherwise show
 * in the range 0 to 1: white.)  Labels and masks are segmentations.
 */
export function displayOf(steps: Step[], image: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (makesLabels(steps)) return undefined;
  const last = steps.at(-1)?.kind;
  if (last === "frangi") return { shaderControls: { normalized: { range: [0, 0.3] } } };
  if (last === "dog") return { shaderControls: { normalized: { range: [64, 192] } } };
  const smoothing = steps.every((s) => s.kind === "gaussian" || s.kind === "mean" || s.kind === "median");
  const python = last === "python" && pythonOutput(steps.at(-1)!.code) !== "label" && pythonOutput(steps.at(-1)!.code) !== "mask";
  if (!smoothing && !python) return undefined;
  const kept: Record<string, unknown> = {};
  for (const key of ["shader", "shaderControls", "opacity", "blend"]) if (image?.[key] !== undefined) kept[key] = structuredClone(image[key]);
  return kept;
}

/** `name`, or "name 2", "name 3"… : the first not in `taken`. */
export function uniqueName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) if (!taken.includes(`${name} ${n}`)) return `${name} ${n}`;
}

/** The steps a panel shows: settings that sliders set filled in (an older link may have left them empty). */
function filled(steps: Step[]): Step[] {
  return steps.map((s) => {
    const d = newStep(s.kind);
    const or = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
    return { ...s, sigma: or(s.sigma, d.sigma), radius: or(s.radius, d.radius), sigmaLow: or(s.sigmaLow, d.sigmaLow), sigmaHigh: or(s.sigmaHigh, d.sigmaHigh) };
  });
}

class Filters {
  /** The image filtered: the one chosen while it can be, else the first that can. */
  image = "";
  /** The image chosen (here, in the workspace or by a selected filtered layer), kept while it loads or is away. */
  private chosen = "";
  steps: Step[] = [newStep()];
  /** What went wrong with the last Add or Update, until the steps change. */
  private problem = "";
  /** The image layers that can be filtered, and those that cannot with why. */
  private images: string[] = [];
  private skipped: [string, string][] = [];
  /** The filtered layer selected, whose steps the panel shows: Update changes it in place. */
  target: string | undefined;
  /** The layer last seen selected, and a count that drops answers to an older selection. */
  private selected: string | undefined;
  private selection = 0;
  private sync?: () => void;
  /** The steps were set here (edited, read from the workspace or a selected layer): a filtered layer's are not read back over them. */
  private settled = false;
  /** What was last kept in the workspace, as JSON. */
  private kept = "";
  /** Adds and updates under way, for tests to wait on. */
  pending: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: PlatformContext) {
    ctx.subscriptions.push(ctx.viewer.onLayersChanged(() => this.refresh()));
    ctx.subscriptions.push(ctx.workspace.onChanged(() => void this.follow()));
    // The engine's status changes with every chunk: only the status line follows it.
    ctx.subscriptions.push(ctx.workspace.computed.onChanged(() => this.sync?.()));
    // The steps are kept in the workspace (and its link); undo, redo or another link brings others.
    ctx.subscriptions.push(ctx.state.onChanged(() => this.load()));
    this.load();
    this.refresh();
    void this.follow();
  }

  /** The steps kept in the workspace, if they differ from the panel's. */
  private load(): void {
    const saved = this.ctx.state.get<SavedFilters>();
    const json = JSON.stringify(saved ?? null);
    if (json === this.kept) return;
    this.kept = json;
    const steps = readSteps(saved?.steps);
    if (steps === undefined) return;
    this.steps = filled(steps);
    if (typeof saved?.image === "string") this.chosen = saved.image;
    this.pick();
    this.settled = true;
    this.sync?.();
  }

  /** Keeps the panel's image and steps in the workspace (one undo step), after a change. */
  private save(): void {
    this.settled = true;
    const saved: SavedFilters = { image: this.image, steps: this.steps.map((s) => ({ ...s })) };
    // NaN (an empty setting) is kept as null, which JSON can hold.
    const json = JSON.stringify(saved, (_, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v));
    if (json === this.kept) return;
    this.kept = json;
    this.ctx.state.set(JSON.parse(json));
  }

  /** After an edit in the panel: kept, the last problem forgotten, the panel brought up to date. */
  changed(): void {
    this.problem = "";
    this.save();
    this.sync?.();
  }

  /** The image layers, those that can be filtered offered; viewing writes nothing. */
  private refresh(): void {
    const images: string[] = [];
    const skipped: [string, string][] = [];
    for (const l of this.ctx.viewer.layers()) {
      if (l.type !== "image" || this.sourceOf(l.name) === undefined) continue;
      const t = this.ctx.viewer.layerTransform(l.name);
      const why = unfilterable(t);
      if (why === undefined) images.push(l.name);
      // One still loading is offered once it has loaded, not listed meanwhile.
      else if (t !== undefined) skipped.push([l.name, why]);
    }
    this.images = images;
    this.skipped = skipped;
    this.pick();
    if (!this.settled) void this.readBack();
    this.sync?.();
  }

  private pick(): void {
    this.image = this.images.includes(this.chosen) ? this.chosen : (this.images[0] ?? "");
  }

  /** The image layer whose source a filtered pipeline reads. */
  private imageOf(source: string): string | undefined {
    return this.ctx.viewer
      .layers()
      .map((l) => l.name)
      .find((l) => {
        const s = this.sourceOf(l);
        return s !== undefined && !computedSource(s) && bareSource(s) === bareSource(source);
      });
  }

  /** The steps of a filtered layer, and the image it filters; undefined when it is not one this panel makes. */
  private async pipelineOf(layer: string): Promise<{ steps: Step[]; image?: string } | undefined> {
    const source = this.sourceOf(layer);
    if (!computedSource(source)) return undefined;
    const spec = await this.ctx.workspace.computed.pipelineOf(source!).catch(() => undefined);
    const steps = stepsOf(spec?.ops);
    if (spec === undefined || steps === undefined) return undefined;
    return { steps, image: this.imageOf(spec.source) };
  }

  /**
   * With nothing chosen here yet (a link from before the steps were kept),
   * the steps of the newest filtered layer and the image it filters.
   */
  private async readBack(): Promise<void> {
    for (const name of this.ctx.viewer.layers().map((l) => l.name).reverse()) {
      const found = await this.pipelineOf(name);
      if (found === undefined || this.settled) continue;
      this.show(found);
      return;
    }
  }

  /** Shows a filtered layer's steps and image in the panel (written to the workspace only when edited). */
  private show(found: { steps: Step[]; image?: string }): void {
    this.steps = filled(found.steps);
    if (found.image !== undefined) this.chosen = found.image;
    this.pick();
    this.settled = true;
    this.problem = "";
    this.sync?.();
  }

  /** Follows the selected layer: a filtered one becomes the target of Update, its steps shown. */
  private async follow(): Promise<void> {
    const name = this.ctx.workspace.selectedLayer();
    if (name === this.selected) return;
    this.selected = name;
    const asked = ++this.selection;
    const found = name === undefined ? undefined : await this.pipelineOf(name);
    if (asked !== this.selection) return;
    this.target = found === undefined ? undefined : name;
    if (found !== undefined) this.show(found);
    else this.sync?.();
  }

  private sourceOf(layer: string): string | undefined {
    return urlOf(this.ctx.viewer.layerSpec(layer));
  }

  /**
   * Adds the filtered view, or (`into`: a filtered layer) points that layer
   * at the steps instead, as one undo step.  The image and steps are taken
   * when it is asked, so a change made while the source URL is worked out
   * does not name or show the layer from another image.
   */
  run(into?: string): Promise<void> {
    const image = this.image;
    const steps = this.steps.map((s) => ({ ...s }));
    const source = this.sourceOf(image);
    if (source === undefined || steps.length === 0) return this.pending;
    const missing = steps.findIndex((s) => blankSetting(s));
    if (missing !== -1) {
      this.problem = `Step ${missing + 1} has an empty setting.`;
      this.sync?.();
      return this.pending;
    }
    this.save();
    const original = this.ctx.viewer.layerSpec(image) as Record<string, unknown> | undefined;
    this.pending = (async () => {
      try {
        const url = await this.ctx.workspace.computed.url({ source, ops: opsOf(steps), chunk: CHUNK });
        const labels = makesLabels(steps);
        const asked = `${image} (${steps.map(describe).join(", ")})`;
        const look = displayOf(steps, original);
        if (into !== undefined && this.ctx.viewer.layerSpec(into) !== undefined) this.updateLayer(into, url, asked, labels, look);
        else {
          const id = this.ctx.workspace.addDataset({ source: url, name: asked, kind: labels ? "segmentation" : "image" });
          // The name may have been made unique ("… 2"): show the layer just added, not an older one.
          const name = this.ctx.workspace.sceneDatasets().find((d) => d.id === id)?.layers[0]?.name ?? asked;
          if (look !== undefined) this.patchLayer(name, look, true);
        }
        this.problem = "";
      } catch (e) {
        this.problem = `Could not filter ${image}: ${(e as Error).message}`;
      }
      this.sync?.();
    })();
    return this.pending;
  }

  /** Points a filtered layer at another pipeline, renamed and shown for it, as one undo step. */
  private updateLayer(name: string, url: string, asked: string, labels: boolean, look: Record<string, unknown> | undefined): void {
    const taken = this.ctx.viewer
      .layers()
      .map((l) => l.name)
      .filter((n) => n !== name);
    const renamed = uniqueName(asked, taken);
    this.ctx.viewer.patchState((ng) => {
      const state = ng as { layers?: Record<string, unknown>[]; selectedLayer?: { layer?: string } };
      const layer = (state.layers ?? []).find((l) => l.name === name);
      if (layer === undefined) return;
      const source = layer.source;
      layer.source = source !== null && typeof source === "object" && !Array.isArray(source) ? { ...(source as object), url } : url;
      layer.type = labels ? "segmentation" : "image";
      for (const key of ["shader", "shaderControls", "opacity", "blend"]) delete layer[key];
      if (look !== undefined) Object.assign(layer, structuredClone(look));
      layer.name = renamed;
      if (state.selectedLayer?.layer === name) state.selectedLayer.layer = renamed;
    });
    // Still the layer tuned, under its new name.
    this.target = renamed;
    this.selected = renamed;
  }

  private patchLayer(name: string, look: Record<string, unknown>, quiet: boolean): void {
    this.ctx.viewer.patchState(
      (ng) => {
        const layer = ((ng as { layers?: Record<string, unknown>[] }).layers ?? []).find((l) => l.name === name);
        if (layer !== undefined) Object.assign(layer, structuredClone(look));
      },
      { quiet },
    );
  }

  /** A step's card: its filter, a remove button, and its settings, drawn again only when its filter changes. */
  private stepCard(i: number): { element: HTMLElement; sync(): void } {
    const step = () => this.steps[i];
    const badge = el("span");
    const kind = select(STEP_KINDS, step().kind, (v) => ((step().kind = v as StepKind), this.changed()), "Filter");
    const remove = iconButton("close", "Remove this step", () => {
      this.steps.splice(i, 1);
      this.changed();
    });
    const setters: (() => void)[] = [];
    const settings = region((k: StepKind) => {
      setters.length = 0;
      return this.settings(k, step, setters);
    });
    const element = card(`filters.step.${i}`, `Step ${i + 1}`, { open: true, badge }, el("div", { class: "row" }, field("Filter", kind), remove), settings);
    return {
      element,
      sync: () => {
        const s = step();
        badge.textContent = describe(s);
        kind.set(s.kind);
        remove.disabled = this.steps.length === 1;
        settings.update(s.kind);
        setters.forEach((set) => set());
      },
    };
  }

  /** The settings of a step of kind `k`; each control's way to show the step's value goes in `setters`. */
  private settings(k: StepKind, step: () => Step, setters: (() => void)[]): HTMLElement[] {
    const size = (label: string, key: "sigma" | "radius" | "sigmaLow" | "sigmaHigh", min: number, max: number, stepBy: number) => {
      const control = slider(step()[key], { min, max, step: stepBy, unit: "voxels", label, onchange: (v) => ((step()[key] = v), this.changed()) });
      setters.push(() => control.set(step()[key]));
      return field(label, control);
    };
    switch (k) {
      case "gaussian":
        return [size("Sigma", "sigma", MINIMA.sigma, LIMITS.sigma, 0.1)];
      case "dog":
        return [size("Sigma", "sigma", MINIMA.sigma, LIMITS.dogSigma, 0.1)];
      case "mean":
      case "median":
        return [size("Radius", "radius", MINIMA.radius, LIMITS.radius, 1)];
      case "morphology": {
        const operation = select(
          [
            ["open", "Open (removes small objects)"],
            ["close", "Close (fills small gaps)"],
          ],
          step().operation,
          (v) => ((step().operation = v === "close" ? "close" : "open"), this.changed()),
          "Operation",
        );
        setters.push(() => operation.set(step().operation));
        return [field("Operation", operation), size("Radius", "radius", MINIMA.radius, LIMITS.radius, 1)];
      }
      case "frangi": {
        const bright = checkbox("Bright tubes", step().bright, (on) => ((step().bright = on), this.changed()), { info: "Clear it for tubes darker than around them." });
        setters.push(() => bright.set(step().bright));
        return [size("Sigma from", "sigmaLow", MINIMA.frangiSigma, LIMITS.frangiSigma, 0.5), size("Sigma to", "sigmaHigh", MINIMA.frangiSigma, LIMITS.frangiSigma, 0.5), bright];
      }
      case "threshold": {
        const low = numberInput(step().low, (v) => ((step().low = v), this.changed()), { step: "any", "aria-label": "From" });
        // "Below" may be left empty: no upper end.
        const high = numberInput(step().high, () => {}, { step: "any", "aria-label": "Below" });
        high.addEventListener("change", () => {
          const v = high.value.trim() === "" ? Number.NaN : Number(high.value);
          if (high.value.trim() === "" || Number.isFinite(v)) ((step().high = v), this.changed());
        });
        const showHigh = () => {
          if (high.ownerDocument.activeElement === high) return;
          high.value = Number.isFinite(step().high) ? String(step().high) : "";
        };
        showHigh();
        setters.push(() => low.set(step().low), showHigh);
        return [el("div", { class: "grid-2" }, field("From", low, "Image units"), field("Below", high, "Optional"))];
      }
      case "python": {
        const code = el("textarea", { class: "text-input mono", spellcheck: "false", wrap: "off", rows: "10", "aria-label": "Python code" });
        code.value = step().code;
        code.addEventListener("input", () => (step().code = code.value));
        code.addEventListener("change", () => this.changed());
        setters.push(() => {
          if (code.ownerDocument.activeElement !== code && code.value !== step().code) code.value = step().code;
        });
        return [
          field("Python code", code, {
            info: "apply(block) runs on each block (a NumPy array, z, y, x). The first lines say what it needs: #halo 2 (voxels of context on each side) and #output float32 image (a dtype, then image, label or mask).",
          }),
        ];
      }
    }
  }

  render(host: HTMLElement): () => void {
    const status = statusLine();
    const empty = emptyState("No 3-D image to filter.", { label: "Open data…", run: () => void this.ctx.commands.invoke("dataset.add") });
    const image = select([], this.image, (v) => ((this.chosen = this.image = v), this.changed()), "Image");
    let offered = "";
    const skipped = region((rows: [string, string][]) => (rows.length === 0 ? [] : [el("p", { class: "hint" }, `Not offered: ${rows.map(([n, why]) => `${n} (${why})`).join(", ")}.`)]));
    const imageField = field("Image", image);
    const imageCard = card(
      "filters.image",
      "Image",
      { open: true, info: "Sizes are in voxels of the level shown, so a zoomed-out view is a preview of the full-resolution result." },
      imageField,
      skipped,
    );
    // A card per step, added and taken away at the end: each shows the step at its place.
    const steps: { element: HTMLElement; sync(): void }[] = [];
    const stepCards = el("div");
    const editing = el("p", { class: "hint" });
    const addStep = button("Add step", () => {
      this.steps.push(newStep(this.steps.at(-1)?.kind === "threshold" ? "morphology" : "gaussian"));
      this.changed();
    });
    const apply = button("Add filtered view", () => void this.run(this.target), undefined, "btn primary small");
    const addNew = button("Add as a new view", () => void this.run());
    const actions = el("div", { class: "row" }, addStep, apply, addNew);
    host.append(empty, imageCard, stepCards, editing, actions, status);

    const sync = () => {
      const none = this.images.length === 0;
      empty.hidden = none === false;
      // With images that cannot be filtered, the card says why.
      imageCard.hidden = none && this.skipped.length === 0;
      imageField.hidden = none;
      for (const e of [stepCards, editing, actions]) e.hidden = none;
      // The options drawn again only when the images change, so an open select stays open.
      if (this.images.join("\n") !== offered) {
        offered = this.images.join("\n");
        image.replaceChildren(...this.images.map((n) => el("option", { value: n }, n)));
      }
      image.set(this.image);
      skipped.update(this.skipped);
      while (steps.length < this.steps.length) {
        const added = this.stepCard(steps.length);
        steps.push(added);
        stepCards.append(added.element);
      }
      while (steps.length > this.steps.length) steps.pop()!.element.remove();
      steps.forEach((s) => s.sync());
      editing.hidden = none || this.target === undefined;
      editing.textContent = this.target === undefined ? "" : `Tuning “${this.target}”.`;
      apply.textContent = this.target === undefined ? "Add filtered view" : "Update the view";
      addNew.hidden = this.target === undefined;
      const engine = this.ctx.workspace.computed.status();
      if (this.problem) status.error(this.problem);
      else if (engine.failure) status.error(`A chunk failed: ${engine.failure.message}`);
      else if (engine.status) status.progress(engine.status);
      else status.clear();
    };
    this.sync = sync;
    sync();
    return () => {
      this.sync = undefined;
    };
  }
}

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    // The plugin's Python runs from a link without asking.
    ctx.workspace.computed.ownPython(MEDIAN);
    ctx.workspace.computed.ownPython(FRANGI);
    const filters = new Filters(ctx);
    ctx.ui.panel(FILTERS_PANEL, (host) => filters.render(host));
  },
};

export { Filters };
