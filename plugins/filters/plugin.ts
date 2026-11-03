/**
 * The filters plugin: the Filters tab, which adds an image computed as it is
 * viewed: a pipeline of steps (pipeline.ts) over any image layer, run by
 * chunkmirage's browser engine (the platform's `workspace.computed`).  The
 * new layer's source carries the whole pipeline, so its link works in any
 * browser that can read the image.
 */
import type { PlatformContext, PluginModule } from "@ngplatform/sdk";
import { FILTERS_PANEL } from "./manifest.js";
import { describe, FRANGI, makesLabels, MEDIAN, newStep, opsOf, type Step, STEP_KINDS, type StepKind } from "./pipeline.js";

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const STYLE = `
.fl { display: grid; gap: 10px; padding: 10px 12px; font-size: 12px; }
.fl label { display: grid; gap: 3px; }
.fl-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.fl-step { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--border, #3334); border-radius: 6px; }
.fl-step-head { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: end; }
.fl-actions { display: flex; gap: 8px; flex-wrap: wrap; }
`;

/** Output chunks: 64 voxels a side. */
const CHUNK = [64, 64, 64];

class Filters {
  private image = "";
  private steps: Step[] = [newStep()];
  private note = "";
  private images: string[] = [];
  private update?: () => void;

  constructor(private readonly ctx: PlatformContext) {
    ctx.subscriptions.push(ctx.viewer.onLayersChanged(() => this.refresh()));
    ctx.subscriptions.push(ctx.workspace.computed.onChanged(() => this.update?.()));
    this.refresh();
  }

  /** The image layers: any can be filtered. */
  private refresh(): void {
    this.images = this.ctx.viewer
      .layers()
      .filter((l) => l.type === "image" && this.sourceOf(l.name) !== undefined)
      .map((l) => l.name);
    if (!this.images.includes(this.image)) this.image = this.images[0] ?? "";
    this.update?.();
  }

  private sourceOf(layer: string): string | undefined {
    const s = this.ctx.viewer.layerSpec(layer)?.source;
    return typeof s === "string" ? s : typeof (s as { url?: unknown })?.url === "string" ? (s as { url: string }).url : undefined;
  }

  private async add(): Promise<void> {
    const source = this.sourceOf(this.image);
    if (source === undefined || this.steps.length === 0) return;
    try {
      const url = await this.ctx.workspace.computed.url({ source, ops: opsOf(this.steps), chunk: CHUNK });
      const labels = makesLabels(this.steps);
      const name = `${this.image} (${this.steps.map(describe).join(", ")})`;
      this.ctx.workspace.addDataset({ source: url, name, kind: labels ? "segmentation" : "image" });
      this.display(name);
      this.note = `Added ${this.image}, filtered: computed as you view it.`;
    } catch (e) {
      this.note = `This image could not be filtered: ${(e as Error).message}`;
    }
    this.update?.();
  }

  /**
   * The new layer shown as the image is: smoothing keeps its values, so its
   * shader and range; vesselness is 0 to 1.  (The result is float32, whose
   * default range would show the image white.)
   */
  private display(name: string): void {
    const kinds = new Set(this.steps.map((s) => s.kind));
    const original = this.ctx.viewer.layerSpec(this.image) as Record<string, unknown> | undefined;
    const smoothing = [...kinds].every((k) => k === "gaussian" || k === "mean" || k === "median");
    const frangi = this.steps.at(-1)?.kind === "frangi";
    if (!smoothing && !frangi) return;
    this.ctx.viewer.patchState(
      (ng) => {
        const layer = ((ng as { layers?: Record<string, unknown>[] }).layers ?? []).find((l) => l.name === name);
        if (layer === undefined) return;
        if (frangi) layer.shaderControls = { normalized: { range: [0, 0.3] } };
        else for (const key of ["shader", "shaderControls", "opacity", "blend"]) if (original?.[key] !== undefined) layer[key] = structuredClone(original[key]);
      },
      { quiet: true },
    );
  }

  private stepView(step: Step, index: number, draw: () => void): HTMLElement {
    const number = (label: string, value: number, set: (v: number) => void, step = "1", min = "0") =>
      el(
        "label",
        {},
        el("span", {}, label),
        el("input", { type: "number", value: Number.isFinite(value) ? value : "", step, min, onchange: (e: Event) => set((e.target as HTMLInputElement).value === "" ? Number.NaN : Number((e.target as HTMLInputElement).value)) }),
      );
    const s = step;
    const settings: HTMLElement[] =
      s.kind === "gaussian" || s.kind === "dog"
        ? [number("Sigma (voxels)", s.sigma, (v) => (s.sigma = v), "0.1")]
        : s.kind === "frangi"
          ? [
              number("Sigma from (voxels)", s.sigmaLow, (v) => (s.sigmaLow = v), "0.5", "0.5"),
              number("Sigma to (voxels)", s.sigmaHigh, (v) => (s.sigmaHigh = v), "0.5", "0.5"),
              el("label", { class: "field check" }, el("input", { type: "checkbox", checked: s.bright, onchange: (e: Event) => (s.bright = (e.target as HTMLInputElement).checked) }), el("span", {}, "Bright tubes (clear for dark ones)")),
            ]
          : s.kind === "threshold"
            ? [number("From (image units)", s.low, (v) => (s.low = v), "any", ""), number("Below (empty: no limit)", s.high, (v) => (s.high = v), "any", "")]
            : s.kind === "morphology"
              ? [
                  el(
                    "label",
                    {},
                    el("span", {}, "Operation"),
                    el(
                      "select",
                      { onchange: (e: Event) => (s.operation = (e.target as HTMLSelectElement).value as Step["operation"]) },
                      ...(["open", "close"] as const).map((o) => el("option", { value: o, ...(o === s.operation ? { selected: "" } : {}) }, o === "open" ? "Open (removes small objects)" : "Close (fills small gaps)")),
                    ),
                  ),
                  number("Radius (voxels)", s.radius, (v) => (s.radius = Math.max(1, Math.round(v))), "1", "1"),
                ]
              : [number("Radius (voxels)", s.radius, (v) => (s.radius = Math.max(1, Math.round(v))), "1", "1")];
    const kind = el(
      "select",
      {
        onchange: (e: Event) => {
          s.kind = (e.target as HTMLSelectElement).value as StepKind;
          draw();
        },
      },
      ...STEP_KINDS.map(([k, label]) => el("option", { value: k, ...(k === s.kind ? { selected: "" } : {}) }, label)),
    );
    const remove = el(
      "button",
      {
        class: "btn small",
        type: "button",
        title: "Remove this step",
        disabled: this.steps.length === 1,
        onclick: () => {
          this.steps.splice(index, 1);
          draw();
        },
      },
      "Remove",
    );
    return el("div", { class: "fl-step" }, el("div", { class: "fl-step-head" }, el("label", {}, el("span", {}, `Step ${index + 1}`), kind), remove), el("div", { class: "fl-row" }, ...settings));
  }

  render(host: HTMLElement): () => void {
    const draw = () => {
      const image = el("select", { onchange: (e: Event) => (this.image = (e.target as HTMLSelectElement).value) }, ...this.images.map((n) => el("option", { value: n, ...(n === this.image ? { selected: "" } : {}) }, n)));
      const status = this.ctx.workspace.computed.status();
      host.replaceChildren(
        el(
          "div",
          { class: "fl" },
          this.images.length === 0 ? el("p", { class: "note" }, "Add an image to filter it.") : el("label", {}, el("span", {}, "Image"), image),
          ...this.steps.map((s, i) => this.stepView(s, i, draw)),
          el(
            "div",
            { class: "fl-actions" },
            el(
              "button",
              {
                class: "btn small",
                type: "button",
                onclick: () => {
                  this.steps.push(newStep(this.steps.at(-1)?.kind === "threshold" ? "morphology" : "gaussian"));
                  draw();
                },
              },
              "Add step",
            ),
            el("button", { class: "btn small primary", type: "button", disabled: this.images.length === 0, onclick: () => void this.add() }, "Add filtered view"),
          ),
          this.note ? el("p", { class: "note" }, this.note) : null,
          status.status ? el("p", { class: "note" }, status.status) : null,
          status.computed + status.failed > 0 ? el("p", { class: "note" }, `Chunks computed ${status.computed}, dropped ${status.dropped}, failed ${status.failed}.`) : null,
          status.failure ? el("p", { class: "note" }, `Last failure: ${status.failure.message}`) : null,
        ),
      );
    };
    this.update = draw;
    draw();
    return () => (this.update = undefined);
  }
}

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    ctx.subscriptions.push(() => style.remove());
    // The plugin's Python runs from a link without asking.
    ctx.workspace.computed.ownPython(MEDIAN);
    ctx.workspace.computed.ownPython(FRANGI);
    const filters = new Filters(ctx);
    ctx.ui.panel(FILTERS_PANEL, (host) => filters.render(host));
  },
};
