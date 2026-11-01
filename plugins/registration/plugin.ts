/**
 * Registration: landmark pairs (a fixed point in the global space, a moving
 * point in the moving layer's own) fitted to a transform (./fit.ts), applied
 * as the moving layer's source transform; transform files (./formats.ts).
 *
 * Everything is in millimetres: the layer's transform (Neuroglancer keeps
 * it in multiples of each side's scales) is turned into a physical one
 * (moving mm to global mm) and back.  Landmarks show in two annotation
 * layers, the moving ones where the moving layer now puts them, with a line
 * to their fixed partner.
 */
import type { Json, LayerTransform, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { apply4, describe, fit, type Fit, identity4, invert4, type Mat4, MINIMUM, type Model, multiply4, type Vec3 } from "./fit.js";
import { readTransformFile, writeItk, writeLta, writePlain } from "./formats.js";
import { REGISTRATION_PANEL } from "./manifest.js";

interface Pair {
  id: string;
  /** Global space, mm, in the moving layer's output dimensions' order. */
  fixed?: Vec3;
  /** The moving layer's own space, mm. */
  moving?: Vec3;
  on: boolean;
}

export interface Saved {
  layer?: string;
  model: Model;
  live: boolean;
  pairs: Pair[];
  /** The layer's transform (Neuroglancer's form) before registering, for Reset. */
  base?: number[];
}

export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as Partial<Saved>;
  return {
    layer: typeof s.layer === "string" ? s.layer : undefined,
    model: (["translation", "rigid", "similarity", "affine"] as Model[]).includes(s.model as Model) ? (s.model as Model) : "rigid",
    live: s.live !== false,
    pairs: Array.isArray(s.pairs) ? s.pairs : [],
    base: Array.isArray(s.base) ? s.base : undefined,
  };
}

const FIXED_LAYER = "landmarks (fixed)";
const MOVING_LAYER = "landmarks (moving)";

const mm = (scale: number, unit: string) => (unit === "m" ? scale * 1000 : scale);

/**
 * A transform's matrix as moving mm to global mm (row-major 4 × 4);
 * undefined unless it is 3-D.  Neuroglancer keeps the linear part as a
 * ratio of physical lengths and the translation in multiples of the output
 * scales (its coordinate_transform.ts rescales only the translation when an
 * output scale changes).
 */
export function physical(t: LayerTransform, matrix: ArrayLike<number> = t.matrix): Mat4 | undefined {
  if (t.rank !== 3) return undefined;
  const sout = [0, 1, 2].map((r) => mm(t.output.scales[r], t.output.units[r]));
  const p = identity4();
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) p[4 * r + c] = matrix[4 * c + r];
    p[4 * r + 3] = sout[r] * matrix[12 + r];
  }
  return p;
}

/** A physical matrix back in Neuroglancer's form (column-major). */
export function neuroglancer(t: LayerTransform, p: Mat4): Float64Array {
  const sout = [0, 1, 2].map((r) => mm(t.output.scales[r], t.output.units[r]));
  const m = new Float64Array(16);
  m[15] = 1;
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) m[4 * c + r] = p[4 * r + c];
    m[12 + r] = p[4 * r + 3] / sout[r];
  }
  return m;
}

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));

class Registration {
  private saved: Saved;
  private result: Fit | { error: string } | undefined;
  private panelUpdate: (() => void) | undefined;

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    ctx.subscriptions.push(
      ctx.state.onChanged(() => {
        this.saved = readSaved(ctx.state.get());
        this.refit(false);
        this.panelUpdate?.();
      }),
      ctx.viewer.onLayersChanged(() => this.panelUpdate?.()),
    );
    this.refit(false);
  }

  private save(patch: Partial<Saved>): void {
    this.saved = { ...this.saved, ...patch };
    this.ctx.state.set(this.saved);
  }

  /** Layers that can be moved: 3-D ones, not the landmarks themselves. */
  candidates(): string[] {
    return this.ctx.viewer
      .layers()
      .map((l) => l.name)
      .filter((name) => name !== FIXED_LAYER && name !== MOVING_LAYER && this.ctx.viewer.layerTransform(name)?.rank === 3);
  }

  private layer(): string | undefined {
    const candidates = this.candidates();
    return candidates.find((n) => n === this.saved.layer) ?? undefined;
  }

  /** The mouse's (or else the views' centre's) position, in mm along the moving layer's output dimensions. */
  private here(t: LayerTransform): Vec3 | undefined {
    const ng = this.ctx.viewer.getState() as { dimensions?: Record<string, [number, string]>; position?: number[] };
    const cursor = this.ctx.viewer.cursor();
    const position = cursor.active ? cursor.position : ng.position;
    const dims = Object.entries(ng.dimensions ?? {});
    if (position === undefined) return undefined;
    const out = t.output.names.map((name) => {
      const i = dims.findIndex(([n]) => n === name);
      return i === -1 ? NaN : position[i] * mm(dims[i][1][0], dims[i][1][1]);
    });
    return out.some((v) => !Number.isFinite(v)) ? undefined : (out as Vec3);
  }

  /** Global position of a point in mm along the output dimensions. */
  private toGlobal(t: LayerTransform, p: Vec3): number[] | undefined {
    const ng = this.ctx.viewer.getState() as { dimensions?: Record<string, [number, string]>; position?: number[] };
    const dims = Object.entries(ng.dimensions ?? {});
    const out = dims.map((_, i) => ng.position?.[i] ?? 0);
    for (let r = 0; r < 3; ++r) {
      const i = dims.findIndex(([n]) => n === t.output.names[r]);
      if (i === -1) return undefined;
      out[i] = p[r] / mm(dims[i][1][0], dims[i][1][1]);
    }
    return out;
  }

  mark(role: "fixed" | "moving"): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    if (!name || !t) {
      this.ctx.ui.toast("Choose the moving layer in the Registration tab first.", "error");
      this.ctx.ui.showPanel(REGISTRATION_PANEL);
      return;
    }
    const p = physical(t);
    const at = this.here(t);
    if (p === undefined || at === undefined) {
      this.ctx.ui.toast("This layer's space is not one Registration can work in (it needs x, y and z).", "error");
      return;
    }
    // A moving point is kept in the moving layer's own space.
    const point = role === "fixed" ? at : apply4(invert4(p), at);
    const pairs = [...this.saved.pairs];
    const open = pairs.find((q) => q[role] === undefined);
    if (open !== undefined) open[role] = point;
    else pairs.push({ id: crypto.randomUUID().slice(0, 8), [role]: point, on: true });
    this.save({ pairs, base: this.saved.base ?? Array.from(t.matrix) });
    this.refit(true);
  }

  /** Fits the pairs; with Live (or `apply`), moves the layer. */
  private refit(apply: boolean): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const pairs = this.saved.pairs.filter((q) => q.on && q.fixed && q.moving);
    if (!name || !t) {
      this.result = undefined;
    } else if (pairs.length < MINIMUM[this.saved.model]) {
      this.result = { error: `${this.saved.model} needs ${MINIMUM[this.saved.model]} complete pair${MINIMUM[this.saved.model] === 1 ? "" : "s"}; there ${pairs.length === 1 ? "is" : "are"} ${pairs.length}.` };
    } else {
      try {
        this.result = fit(this.saved.model, pairs.map((q) => q.moving!), pairs.map((q) => q.fixed!));
        if (apply && this.saved.live) this.ctx.viewer.setLayerTransform(name, neuroglancer(t, this.result.matrix));
      } catch (e) {
        this.result = { error: (e as Error).message };
      }
    }
    this.showLandmarks();
    this.panelUpdate?.();
  }

  apply(): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    if (!name || !t || this.result === undefined || "error" in this.result) return;
    if (this.saved.base === undefined) this.save({ base: Array.from(t.matrix) });
    this.ctx.viewer.setLayerTransform(name, neuroglancer(t, this.result.matrix));
    this.showLandmarks();
  }

  reset(): void {
    const name = this.layer();
    if (name && this.saved.base) this.ctx.viewer.setLayerTransform(name, Float64Array.from(this.saved.base));
    this.save({ base: undefined });
    this.showLandmarks();
  }

  /** The landmarks in two annotation layers: fixed ones, and moving ones where the layer now puts them, with lines. */
  private showLandmarks(): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const p = t ? physical(t) : undefined;
    const fixed: Json[] = [];
    const moving: Json[] = [];
    if (t && p) {
      this.saved.pairs.forEach((q, i) => {
        const f = q.fixed && this.toGlobal(t, q.fixed);
        const m = q.moving && this.toGlobal(t, apply4(p, q.moving));
        if (f) fixed.push({ type: "point", id: `f${q.id}`, point: f, description: `${i + 1}` });
        if (m) moving.push({ type: "point", id: `m${q.id}`, point: m, description: `${i + 1}` });
        if (f && m && q.on) moving.push({ type: "line", id: `l${q.id}`, pointA: m, pointB: f });
      });
    }
    const state = this.ctx.viewer.getState() as { layers?: Json[] };
    const current = (n: string) => JSON.stringify((state.layers ?? []).find((l) => l.name === n)?.annotations ?? null);
    const wanted = fixed.length + moving.length > 0;
    if (current(FIXED_LAYER) === JSON.stringify(wanted ? fixed : null) && current(MOVING_LAYER) === JSON.stringify(wanted ? moving : null)) return;
    this.ctx.viewer.patchState((ng) => {
      const layers = ((ng.layers as Json[] | undefined) ?? []).filter((l) => l.name !== FIXED_LAYER && l.name !== MOVING_LAYER);
      if (wanted) {
        layers.push({ type: "annotation", source: "local://annotations", name: FIXED_LAYER, annotationColor: "#ffcc00", annotations: fixed });
        layers.push({ type: "annotation", source: "local://annotations", name: MOVING_LAYER, annotationColor: "#3fd3ff", annotations: moving });
      }
      ng.layers = layers;
    });
  }

  private exportFile(format: "plain" | "itk" | "lta"): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const p = t && physical(t);
    const d = t && physical(t, t.defaultMatrix);
    if (!name || !p || !d) return;
    // Relative to the layer's own placement: moving RAS mm to fixed.
    const r = multiply4(p, invert4(d));
    const [text, extension] = format === "itk" ? [writeItk(r), "txt"] : format === "lta" ? [writeLta(r), "lta"] : [writePlain(r), "txt"];
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: `${name} to fixed.${extension}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async importFile(file: File): Promise<void> {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const d = t && physical(t, t.defaultMatrix);
    if (!name || !t || !d) return;
    try {
      const r = readTransformFile(file.name, await file.text());
      if (this.saved.base === undefined) this.save({ base: Array.from(t.matrix) });
      this.ctx.viewer.setLayerTransform(name, neuroglancer(t, multiply4(r, d)));
      this.ctx.log.info(`Placed ${name} with ${file.name}.`);
      this.showLandmarks();
    } catch (e) {
      this.ctx.ui.toast(`Could not read ${file.name}: ${(e as Error).message}`, "error");
    }
  }

  render(host: HTMLElement): () => void {
    const draw = () => {
      const { saved } = this;
      const candidates = this.candidates();
      const layer = el("select", { class: "text-input", "aria-label": "Moving layer" }) as HTMLSelectElement;
      layer.append(el("option", { value: "" }, "Choose…"));
      for (const n of candidates) layer.append(el("option", { value: n }, n));
      layer.value = this.layer() ?? "";
      layer.addEventListener("change", () => this.save({ layer: layer.value || undefined, base: undefined, pairs: [] }));
      const model = el("select", { class: "text-input", "aria-label": "Model" }) as HTMLSelectElement;
      for (const m of ["translation", "rigid", "similarity", "affine"]) model.append(el("option", { value: m }, `${m[0].toUpperCase()}${m.slice(1)} (${MINIMUM[m as Model]}+ pairs)`));
      model.value = saved.model;
      model.addEventListener("change", () => {
        this.save({ model: model.value as Model });
        this.refit(true);
      });
      const live = el("input", { type: "checkbox" }) as HTMLInputElement;
      live.checked = saved.live;
      live.addEventListener("change", () => this.save({ live: live.checked }));
      const r = this.result;
      const stats =
        r === undefined
          ? ""
          : "error" in r
            ? r.error
            : (() => {
                const { determinant, scales } = describe(r.matrix);
                return `RMS ${fmt(r.rms)} mm, largest ${fmt(r.max)} mm · scales ${scales.map((s) => s.toFixed(3)).join(", ")}${determinant < 0 ? " · mirrored!" : ""}`;
              })();
      const errors = r !== undefined && !("error" in r) ? r.residuals : [];
      let k = 0;
      const rows = saved.pairs.map((q, i) => {
        const on = el("input", { type: "checkbox", title: "Use this pair" }) as HTMLInputElement;
        on.checked = q.on;
        on.addEventListener("change", () => {
          this.save({ pairs: saved.pairs.map((x) => (x.id === q.id ? { ...x, on: on.checked } : x)) });
          this.refit(true);
        });
        const complete = q.on && q.fixed && q.moving;
        const error = complete ? errors[k++] : undefined;
        // In x, y, z order, whatever order the layer keeps its dimensions in.
        const names = (this.layer() && this.ctx.viewer.layerTransform(this.layer()!)?.output.names) || ["x", "y", "z"];
        const order = [0, 1, 2].sort((a, b) => (names[a] ?? "").localeCompare(names[b] ?? ""));
        const v = (p?: Vec3) => (p ? order.map((k) => `${names[k]} ${p[k].toFixed(1)}`).join("  ") : "—");
        return el(
          "tr",
          {},
          el("td", {}, String(i + 1)),
          el("td", {}, on),
          el("td", { class: "mono" }, v(q.fixed)),
          el("td", { class: "mono" }, v(q.moving)),
          el("td", { class: "mono" }, error === undefined ? "" : fmt(error)),
          el(
            "td",
            {},
            el("button", {
              class: "btn icon",
              type: "button",
              title: "Remove",
              onclick: () => {
                this.save({ pairs: saved.pairs.filter((x) => x.id !== q.id) });
                this.refit(true);
              },
            }, "×"),
          ),
        );
      });
      const file = el("input", { type: "file", accept: ".txt,.lta,.mat,.tfm,.xfm", hidden: true }) as HTMLInputElement;
      file.addEventListener("change", () => file.files?.[0] && void this.importFile(file.files[0]));
      const format = el("select", { class: "text-input", "aria-label": "Format" }) as HTMLSelectElement;
      for (const [value, name] of [
        ["plain", "4 × 4 text"],
        ["itk", "ITK / ANTs"],
        ["lta", "FreeSurfer LTA"],
      ])
        format.append(el("option", { value }, name));
      const hasLayer = this.layer() !== undefined;
      host.replaceChildren(
        el(
          "div",
          { class: "rg" },
          el("label", { class: "field" }, el("span", {}, "Moving layer"), candidates.length ? layer : el("span", { class: "note" }, "No 3-D layer to move.")),
          el("p", { class: "note" }, "Point at a feature in the fixed data and press Alt+F; at the same feature in the moving layer, Alt+M. Pairs match in order."),
          el(
            "div",
            { class: "rg-row" },
            el("button", { class: "btn outline small", type: "button", disabled: !hasLayer, onclick: () => this.mark("fixed") }, "Fixed here"),
            el("button", { class: "btn outline small", type: "button", disabled: !hasLayer, onclick: () => this.mark("moving") }, "Moving here"),
          ),
          saved.pairs.length
            ? el("table", { class: "rg-pairs" }, el("thead", {}, el("tr", {}, ...["#", "", "Fixed (mm)", "Moving (mm)", "Error", ""].map((x) => el("th", {}, x)))), el("tbody", {}, ...rows))
            : null,
          el("label", { class: "field" }, el("span", {}, "Model"), model),
          el("label", { class: "field check" }, live, el("span", {}, "Live: move the layer with each pair")),
          el("p", { class: r && "error" in r ? "note error" : "note" }, stats),
          el(
            "div",
            { class: "rg-row" },
            el("button", { class: "btn small", type: "button", disabled: !hasLayer || saved.live, onclick: () => this.apply() }, "Apply"),
            el("button", { class: "btn outline small", type: "button", disabled: saved.base === undefined, onclick: () => this.reset() }, "Reset"),
            el("button", { class: "btn outline small", type: "button", disabled: !saved.pairs.length, onclick: () => this.save({ pairs: [] }) }, "Clear pairs"),
          ),
          el("h3", { class: "section-title" }, "Transform files"),
          el(
            "div",
            { class: "rg-row" },
            el("button", { class: "btn outline small", type: "button", disabled: !hasLayer, onclick: () => file.click() }, "Import…"),
            format,
            el("button", { class: "btn outline small", type: "button", disabled: !hasLayer, onclick: () => this.exportFile(format.value as "plain" | "itk" | "lta") }, "Export"),
            file,
          ),
        ),
      );
    };
    this.panelUpdate = draw;
    draw();
    return () => {
      if (this.panelUpdate === draw) this.panelUpdate = undefined;
    };
  }
}

const STYLE = `
.rg { display: grid; gap: 8px; }
.rg-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rg-pairs { width: 100%; border-collapse: collapse; font-size: 12px; }
.rg-pairs th { text-align: left; color: var(--faint); font-weight: 500; padding: 2px 4px; }
.rg-pairs td { padding: 2px 4px; border-top: 1px solid var(--line); }
.rg-pairs td.mono { font-family: var(--mono); font-size: 11px; }
`;

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = el("style", {}, STYLE);
    document.head.append(style);
    ctx.subscriptions.push(() => style.remove());
    const registration = new Registration(ctx);
    ctx.ui.panel(REGISTRATION_PANEL, (host) => registration.render(host));
    ctx.commands.register("registration.fixedHere", () => registration.mark("fixed"));
    ctx.commands.register("registration.movingHere", () => registration.mark("moving"));
  },
};
