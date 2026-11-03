/**
 * The filters plugin: the Filters tab, which adds an image filtered on the
 * fly as a layer of its own.  The filtered image is a file made in the page
 * holding the image's own bytes under a name that says the filter
 * (`<file>~<filter>.vfilter`); the platform's image worker reads it as the
 * image, filtered chunk by chunk (src/virtual/images/filters.ts).
 */
import type { PlatformContext, PluginModule } from "@ngplatform/sdk";
import { type FilterSpec, filterName } from "@ngplatform/sdk/filters";
import { FILTERS_PANEL } from "./manifest.js";

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

const KINDS: [FilterSpec["kind"], string][] = [
  ["gaussian", "Gaussian"],
  ["mean", "Mean"],
  ["median", "Median"],
  ["frangi", "Frangi vesselness"],
];

const STYLE = `
.fl { display: grid; gap: 10px; padding: 10px 12px; font-size: 12px; }
.fl label { display: grid; gap: 3px; }
.fl-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
`;

class Filters {
  private image = "";
  private kind: FilterSpec["kind"] = "gaussian";
  private radius = 1;
  private sigma = 1;
  private sigmas = "1, 2";
  private c = 50;
  private bright = true;
  private note = "";
  private local: string[] = [];
  private update?: () => void;

  constructor(private readonly ctx: PlatformContext) {
    ctx.subscriptions.push(ctx.viewer.onLayersChanged(() => void this.refresh()));
    void this.refresh();
  }

  /** The image layers read from files on this computer: the ones a filter can be computed over. */
  private async refresh(): Promise<void> {
    const images = this.ctx.viewer.layers().filter((l) => l.type === "image");
    const local: string[] = [];
    for (const l of images) {
      const source = this.sourceOf(l.name);
      if (source !== undefined && !/\.vfilter\//.test(source) && (await this.ctx.workspace.local.sourceFile(source)) !== undefined) local.push(l.name);
    }
    this.local = local;
    if (!local.includes(this.image)) this.image = local[0] ?? "";
    this.update?.();
  }

  private sourceOf(layer: string): string | undefined {
    const s = this.ctx.viewer.layerSpec(layer)?.source;
    return typeof s === "string" ? s : typeof (s as { url?: unknown })?.url === "string" ? (s as { url: string }).url : undefined;
  }

  private spec(): FilterSpec {
    switch (this.kind) {
      case "mean":
      case "median":
        return { kind: this.kind, radius: this.radius };
      case "gaussian":
        return { kind: "gaussian", sigma: this.sigma };
      case "frangi":
        return { kind: "frangi", sigmas: this.sigmas.split(/[ ,]+/).map(Number).filter((s) => s > 0), alpha: 0.5, beta: 0.5, c: this.c, bright: this.bright };
    }
  }

  private async add(): Promise<void> {
    const source = this.sourceOf(this.image);
    const file = source && (await this.ctx.workspace.local.sourceFile(source));
    if (!file) return;
    const spec = this.spec();
    const named = new File([file], `${file.name}~${filterName(spec)}.vfilter`);
    const [found] = await this.ctx.workspace.local.open(named);
    if (found === undefined) {
      this.note = "This image could not be filtered.";
    } else {
      const label = KINDS.find(([k]) => k === spec.kind)?.[1] ?? spec.kind;
      const what = spec.kind === "gaussian" ? `σ ${spec.sigma}` : spec.kind === "frangi" ? `σ ${spec.sigmas.join(", ")}` : `radius ${spec.radius}`;
      this.ctx.workspace.addDataset({ source: found.source, name: `${this.image} (${label.toLowerCase()} ${what})`, kind: "image" });
      this.note = `Added ${this.image}, ${label.toLowerCase()}: computed as you view it.`;
    }
    this.update?.();
  }

  render(host: HTMLElement): () => void {
    const draw = () => {
      const number = (label: string, value: number, set: (v: number) => void, step = "1") =>
        el("label", {}, el("span", {}, label), el("input", { type: "number", value, step, min: "0", onchange: (e: Event) => set(Number((e.target as HTMLInputElement).value)) }));
      const settings =
        this.kind === "gaussian"
          ? [number("Sigma (voxels)", this.sigma, (v) => (this.sigma = v), "0.1")]
          : this.kind === "frangi"
            ? [
                el("label", {}, el("span", {}, "Scales, sigma (voxels)"), el("input", { type: "text", value: this.sigmas, onchange: (e: Event) => (this.sigmas = (e.target as HTMLInputElement).value) })),
                number("Contrast c (image units)", this.c, (v) => (this.c = v)),
                el("label", { class: "field check" }, el("input", { type: "checkbox", checked: this.bright, onchange: (e: Event) => (this.bright = (e.target as HTMLInputElement).checked) }), el("span", {}, "Bright tubes (clear for dark ones)")),
              ]
            : [number("Radius (voxels)", this.radius, (v) => (this.radius = Math.max(1, Math.round(v))))];
      const image = el("select", { onchange: (e: Event) => (this.image = (e.target as HTMLSelectElement).value) }, ...this.local.map((n) => el("option", { value: n, ...(n === this.image ? { selected: "" } : {}) }, n)));
      const kind = el(
        "select",
        { onchange: (e: Event) => ((this.kind = (e.target as HTMLSelectElement).value as FilterSpec["kind"]), draw()) },
        ...KINDS.map(([k, label]) => el("option", { value: k, ...(k === this.kind ? { selected: "" } : {}) }, label)),
      );
      host.replaceChildren(
        el(
          "div",
          { class: "fl" },
          this.local.length === 0
            ? el("p", { class: "note" }, "Open an image from this computer (NIfTI, FreeSurfer, TIFF, NumPy) to filter it.")
            : el("label", {}, el("span", {}, "Image"), image),
          el("label", {}, el("span", {}, "Filter"), kind),
          el("div", { class: "fl-row" }, ...settings),
          el("button", { class: "btn small", type: "button", disabled: this.local.length === 0, onclick: () => void this.add() }, "Add filtered view"),
          this.note ? el("p", { class: "note" }, this.note) : null,
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
    const filters = new Filters(ctx);
    ctx.ui.panel(FILTERS_PANEL, (host) => filters.render(host));
  },
};
