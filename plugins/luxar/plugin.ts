/**
 * Luxar rendering: chosen Zarr Vectors layers drawn the way the Luxar
 * viewer draws lines and points, inside Neuroglancer's own views.
 *
 * Each layer with it on gets a LayerView (./layer_view.ts): its own reading
 * worker, a drawer in the 3-D view and a canvas over the 2-D views.
 * Neuroglancer's own drawing of the layer is hidden while it is on
 * (`hideLayerDrawing`: a Zarr Vectors layer's segments shown as a temporary
 * set naming no object, which Neuroglancer neither draws nor reads chunks
 * for; an image's opacity 0), never saved: the same link opened without
 * this plugin shows the layer as Neuroglancer draws it.  What the layer
 * shows (its chosen segments, or another plugin's temporary set, such as a
 * track-filtering group's) is still known (`visibleSegments`), and drawn.
 */
import type { Disposer, LayerInfo, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { storeUrlOfSource } from "neuroglancer-zarr-vectors/source-url";
import { Momentum } from "./camera.js";
import { storeOf } from "../volume-view/sources.js";
import { LayerView } from "./layer_view.js";
import { SplatView } from "./splat_view.js";
import { drawnSources } from "./sources.js";
import { LUXAR_PANEL } from "./manifest.js";
import {
  BLENDING_LABELS,
  COLORMAP_LABELS,
  COLOUR_LABELS,
  DEFAULT_STYLE,
  type LayerStyle,
  readSaved,
  readStyle,
  type Saved,
  TONE_LABELS,
} from "./style.js";

/** At most this long a layer's view of its previous store keeps drawing while the new one reads. */
const OUTGOING_MS = 30_000;

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (k === "value") (e as HTMLInputElement).value = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/** The image a layer reads, when it is an image this plugin can draw as splats. */
export function imageOfLayer(layer: LayerInfo): string | undefined {
  return layer.type === "image" ? storeOf(layer.sources[0]) : undefined;
}

/**
 * The store a layer draws, when it is a Zarr Vectors layer this plugin can
 * draw: its first source that draws anything (`spec`, the layer's
 * specification, says which draw nothing: a track-filtering group with a
 * store of its own keeps the dataset's source beside it, drawing nothing).
 */
export function storeOfLayer(layer: LayerInfo, spec?: { source?: unknown }): string | undefined {
  if (layer.type !== "segmentation" && layer.type !== "auto") return undefined;
  for (const source of drawnSources(layer.sources, spec)) {
    const url = storeUrlOfSource(source);
    if (url !== undefined) return url;
  }
  return undefined;
}

class Luxar {
  private saved: Saved;
  private readonly views = new Map<string, LayerView | SplatView>();
  /** A layer's view of the store it drew before, drawing until its new store's view is ready (see sync). */
  private readonly outgoing = new Map<string, { view: LayerView; timer: ReturnType<typeof setTimeout> }>();
  /** Layers whose own drawing is hidden while this plugin draws them. */
  private readonly drawingHidden = new Set<string>();
  private panelUpdate: (() => void) | undefined;
  private statusUpdate: (() => void) | undefined;
  /** The layer whose settings the panel shows. */
  private editing: string | undefined;
  private readonly momentum: Momentum;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.momentum = new Momentum(ctx);
    this.offs.push(
      ctx.state.onChanged(() => {
        const next = readSaved(ctx.state.get());
        if (JSON.stringify(next) === JSON.stringify(this.saved)) return;
        this.saved = next;
        this.sync();
        this.panelUpdate?.();
      }),
      ctx.viewer.onLayersChanged(() => {
        this.sync();
        this.panelUpdate?.();
      }),
      ctx.workspace.onChanged(() => this.panelUpdate?.()),
    );
    this.sync();
  }

  candidates(): LayerInfo[] {
    return this.ctx.viewer.layers().filter((l) => this.storeOf(l) !== undefined || imageOfLayer(l) !== undefined);
  }

  private storeOf(layer: LayerInfo): string | undefined {
    return storeOfLayer(layer, this.ctx.viewer.layerSpec(layer.name) as { source?: unknown } | undefined);
  }

  private write(saved: Saved): void {
    this.saved = saved;
    this.ctx.state.set(saved);
    this.sync();
    this.panelUpdate?.();
  }

  /** A layer's style as saved, or the default for a layer not yet drawn (an image: grey splats that absorb, so tissue looks solid). */
  styleOf(name: string): LayerStyle {
    const saved = this.saved.layers[name];
    if (saved !== undefined) return saved;
    const layer = this.ctx.viewer.layers().find((l) => l.name === name);
    if (layer !== undefined && imageOfLayer(layer) !== undefined) return { ...DEFAULT_STYLE, on: false, blending: "emission", colourBy: "attribute", colormap: "grey", absorption: 0.3 };
    // A layer whose segments have colours of their own (a track-filtering group's colour, colours chosen
    // for segments) is drawn in them.
    const spec = this.ctx.viewer.layerSpec(name) as { segmentDefaultColor?: unknown; segmentColors?: unknown } | undefined;
    const coloured = spec?.segmentDefaultColor !== undefined || (typeof spec?.segmentColors === "object" && spec.segmentColors !== null && Object.keys(spec.segmentColors).length > 0);
    return { ...DEFAULT_STYLE, on: false, ...(coloured ? { colourBy: "segment" as const } : {}) };
  }

  setStyle(name: string, patch: Partial<LayerStyle>, save = true): void {
    const style = readStyle({ ...this.styleOf(name), ...patch });
    if (save) this.write({ ...this.saved, layers: { ...this.saved.layers, [name]: style } });
    else {
      // While a slider moves: drawn at once, saved when it is let go.
      this.saved = { ...this.saved, layers: { ...this.saved.layers, [name]: style } };
      this.views.get(name)?.setStyle(style);
    }
  }

  toggle(name: string): void {
    const style = this.styleOf(name);
    this.setStyle(name, { on: !style.on });
    this.editing = name;
  }

  /**
   * Hands a layer's drawing over from its view of the store it drew before
   * to the view of its new one, once that one has all it wants to draw, or
   * after OUTGOING_MS whatever it has.  When the one before drew the chosen
   * objects whole, by id, it stays until the new one has read all it
   * wants, and stays for good over a store with fewer objects than it drew
   * (a big track-filtering group's preview store, a sample of its
   * streamlines): that one waits for the next.
   */
  private handOver(name: string): void {
    const out = this.outgoing.get(name);
    if (out === undefined) return;
    const view = this.views.get(name);
    // A track-filtering group's first store of its own may be a sample of its streamlines (a big
    // group's preview): while the store before showed more of them whole, it stays.
    // Nor, while the store before drew the chosen objects whole, to a store still reading:
    // what is drawn is right meanwhile, and only slower to come by chunks.
    const before = out.view.objectsShown;
    const after = view instanceof LayerView ? view.client.info?.levels[0]?.objects : undefined;
    if (view instanceof LayerView && view.held && before !== undefined && (!view.ready || (after !== undefined && after < before))) {
      clearTimeout(out.timer);
      out.timer = setTimeout(() => this.handOver(name), OUTGOING_MS);
      return;
    }
    this.finishHandOver(name);
  }

  private finishHandOver(name: string): void {
    const out = this.outgoing.get(name);
    if (out === undefined) return;
    this.outgoing.delete(name);
    clearTimeout(out.timer);
    out.view.dispose();
    const view = this.views.get(name);
    if (view instanceof LayerView && view.held) {
      view.held = false;
      view.redraw();
    }
  }

  /** Makes the layer views match the state and the scene's layers. */
  private sync(): void {
    const layers = new Map(this.ctx.viewer.layers().map((l) => [l.name, l]));
    for (const [name, view] of this.views) {
      const layer = layers.get(name);
      const style = this.saved.layers[name];
      const store = layer && (this.storeOf(layer) ?? imageOfLayer(layer));
      if (layer === undefined || style === undefined || !style.on || store !== view.storeUrl) {
        this.views.delete(name);
        // The layer now reads another store (a track-filtering group's own, made after its
        // streamlines were shown by id): what was drawn stays until the new store's view has
        // read what it wants, so the layer does not go blank in between.
        if (view instanceof LayerView && !view.held && style?.on && layer?.visible && store !== undefined && this.storeOf(layer) !== undefined) {
          this.finishHandOver(name);
          view.freeze();
          // While Neuroglancer made the layer afresh it may have seemed hidden for a moment.
          view.setVisible(true);
          this.outgoing.set(name, { view, timer: setTimeout(() => this.handOver(name), OUTGOING_MS) });
        } else view.dispose();
      }
    }
    // A view kept for a layer no longer drawn here goes.
    for (const name of [...this.outgoing.keys()]) {
      const style = this.saved.layers[name];
      if (!layers.has(name) || style === undefined || !style.on) this.finishHandOver(name);
    }
    for (const [name, style] of Object.entries(this.saved.layers)) {
      const layer = layers.get(name);
      if (layer === undefined || !style.on) continue;
      const store = this.storeOf(layer);
      const image = store === undefined ? imageOfLayer(layer) : undefined;
      if (store === undefined && image === undefined) continue;
      let view = this.views.get(name);
      if (view === undefined) {
        // An image is drawn as splats made from its voxels; a Zarr Vectors layer as lines and points.
        if (image !== undefined) {
          view = new SplatView(this.ctx, name, image, style);
          view.onStatus = () => this.statusUpdate?.();
        } else {
          const lines = new LayerView(this.ctx, name, store!, style);
          // Held (reading, not drawing) while the view of the store before it still draws.
          lines.held = this.outgoing.has(name);
          lines.onStatus = () => {
            if (lines.held && lines.ready && this.views.get(name) === lines) this.handOver(name);
            this.statusUpdate?.();
          };
          view = lines;
        }
        this.views.set(name, view);
      } else if (view.style !== style) view.setStyle(style);
      view.setVisible(layer.visible);
      const out = this.outgoing.get(name);
      if (out !== undefined) {
        if (out.view.style !== style) out.view.setStyle(style);
        out.view.setVisible(layer.visible);
      }
    }
    // A layer is drawn either by Neuroglancer or here, not both: its own
    // drawing is hidden (not in the link) while ours is on; asked each time,
    // as a layer still loading may not take it yet, and a layer made afresh
    // shows again (the engine does nothing when it is hidden already).
    for (const name of [...this.drawingHidden]) {
      if (this.views.has(name)) continue;
      this.drawingHidden.delete(name);
      if (layers.has(name)) this.ctx.viewer.hideLayerDrawing(name, false);
    }
    for (const name of this.views.keys()) {
      this.drawingHidden.add(name);
      this.ctx.viewer.hideLayerDrawing(name, true);
    }
    // Splats add light to the 2-D views: on black, as the image they stand for is drawn.
    const splats = [...this.views.values()].some((v) => v instanceof SplatView);
    this.ctx.viewer.setTemporaryBackground(splats ? [0, 0, 0] : undefined);
    this.momentum.set(this.saved.momentum);
  }

  // ------------------------------------------------------------- panel

  render(host: HTMLElement): Disposer {
    const draw = () => {
      const candidates = this.candidates();
      if (this.editing === undefined || !candidates.some((c) => c.name === this.editing)) {
        const selected = this.ctx.workspace.selectedLayer();
        this.editing = candidates.find((c) => c.name === selected)?.name ?? candidates.find((c) => this.saved.layers[c.name]?.on)?.name ?? candidates[0]?.name;
      }
      const list = el("div", { class: "lx-layers" });
      for (const layer of candidates) {
        const on = el("input", { type: "checkbox", "aria-label": `Luxar rendering of ${layer.name}` }) as HTMLInputElement;
        on.checked = this.styleOf(layer.name).on;
        on.addEventListener("change", () => {
          this.editing = layer.name;
          this.setStyle(layer.name, { on: on.checked });
        });
        const row = el(
          "div",
          { class: `lx-layer${layer.name === this.editing ? " lx-editing" : ""}` },
          on,
          el("button", { class: "lx-name", type: "button", title: "Show this layer's settings", onclick: () => ((this.editing = layer.name), draw()) }, layer.name),
        );
        list.append(row);
      }
      const status = el("p", { class: "note lx-status" });
      const updateStatus = () => {
        const view = this.editing === undefined ? undefined : this.views.get(this.editing);
        // While the view of the layer's previous store still draws, both say how they are.
        const out = this.editing === undefined ? undefined : this.outgoing.get(this.editing);
        status.textContent = view === undefined ? "" : out !== undefined ? `${out.view.status()} — its new store, not drawn until read: ${view.status()}` : view.status();
      };
      this.statusUpdate = updateStatus;
      updateStatus();
      host.replaceChildren(
        el(
          "div",
          { class: "lx-panel" },
          el("p", { class: "note" }, "Draws a Zarr Vectors layer the way Luxar does, in these views: light added up and tone mapped, smooth lines with mitred joins. Tick a layer; the others stay as they are."),
          candidates.length ? list : el("p", { class: "note" }, "No Zarr Vectors layer in this scene (a store, or a .trk, .tck, .trx or SWC file opened in place)."),
          this.editing ? this.settings(this.editing) : null,
          status,
          el(
            "label",
            { class: "field check" },
            this.checkbox(this.saved.momentum, (v) => this.write({ ...this.saved, momentum: v })),
            el("span", {}, "Momentum when rotating the 3-D view (Luxar's camera feel)"),
          ),
        ),
      );
    };
    this.panelUpdate = draw;
    draw();
    return () => {
      if (this.panelUpdate === draw) this.panelUpdate = undefined;
      this.statusUpdate = undefined;
    };
  }

  private checkbox(value: boolean, change: (v: boolean) => void): HTMLInputElement {
    const input = el("input", { type: "checkbox" }) as HTMLInputElement;
    input.checked = value;
    input.addEventListener("change", () => change(input.checked));
    return input;
  }

  private select<T extends string>(label: string, value: T, options: [T, string][], change: (v: T) => void): HTMLElement {
    const select = el("select", { class: "text-input", "aria-label": label }) as HTMLSelectElement;
    for (const [v, text] of options) select.append(el("option", { value: v }, text));
    select.value = value;
    select.addEventListener("change", () => change(select.value as T));
    return el("label", { class: "field" }, el("span", {}, label), select);
  }

  /** A slider that draws as it moves and saves when let go. */
  private slider(name: string, label: string, key: "width" | "exposure" | "sharpness" | "absorption" | "slab" | "detail" | "bloom", min: number, max: number, step: number, format: (v: number) => string): HTMLElement {
    const style = this.styleOf(name);
    const input = el("input", { type: "range", min, max, step, value: style[key], "aria-label": label }) as HTMLInputElement;
    const shown = el("span", { class: "lx-value" }, format(style[key]));
    input.addEventListener("input", () => {
      shown.textContent = format(Number(input.value));
      this.setStyle(name, { [key]: Number(input.value) }, false);
    });
    input.addEventListener("change", () => this.setStyle(name, { [key]: Number(input.value) }));
    return el("label", { class: "field" }, el("span", {}, label), el("div", { class: "lx-row" }, input, shown));
  }

  /** Bloom: how much of the bright light glows around it, 0 off. */
  private bloomSlider(name: string): HTMLElement {
    return this.slider(name, "Bloom (glow around bright light)", "bloom", 0, 3, 0.05, (v) => (v === 0 ? "off" : v.toFixed(2)));
  }

  /** An image's settings: splats coloured by intensity or one colour, brightness, tone map, detail. */
  private splatSettings(name: string): HTMLElement {
    const style = this.styleOf(name);
    const set = (patch: Partial<LayerStyle>) => this.setStyle(name, patch);
    const solid = style.colourBy === "solid";
    const parts: Child[] = [
      el("h3", { class: "lx-heading" }, `Settings: ${name}`),
      el("p", { class: "note" }, "Drawn as Gaussian splats made from its voxels as they are read, each level of the image giving its own: in the 3-D view, and cut by each section in the 2-D views, in place of Neuroglancer's drawing of it."),
      this.select("Blending", style.blending === "emission" ? "emission" : "glow", [["emission", "Emission and absorption (looks solid)"], ["glow", "Glow (light added up)"]] as ["emission" | "glow", string][], (blending) => set({ blending })),
      this.select("Colour", solid ? "solid" : "attribute", [["attribute", "By intensity, through a colormap"], ["solid", "One colour"]] as ["attribute" | "solid", string][], (v) => set({ colourBy: v })),
    ];
    if (solid) {
      const colour = el("input", { type: "color", value: style.colour, "aria-label": "Colour" }) as HTMLInputElement;
      colour.addEventListener("input", () => this.setStyle(name, { colour: colour.value }, false));
      colour.addEventListener("change", () => set({ colour: colour.value }));
      parts.push(el("label", { class: "field" }, el("span", {}, "Colour"), colour));
    } else parts.push(this.select("Colormap", style.colormap, COLORMAP_LABELS, (colormap) => set({ colormap })));
    parts.push(
      this.slider(name, "Brightness (stops)", "exposure", -8, 8, 0.25, (v) => (v > 0 ? `+${v}` : `${v}`)),
      ...(style.blending === "emission" ? [this.slider(name, "Absorption", "absorption", 0, 8, 0.05, (v) => v.toFixed(2))] : []),
      this.select("Tone map", style.toneMap, TONE_LABELS, (toneMap) => set({ toneMap })),
      this.bloomSlider(name),
      this.slider(name, "Detail (splats per view)", "detail", 0.25, 12, 0.25, (v) => `${v} M`),
    );
    if (!style.on) parts.push(el("p", { class: "note" }, "Tick the layer above to draw it this way."));
    return el("div", { class: "lx-settings" }, ...parts);
  }

  private settings(name: string): HTMLElement {
    const style = this.styleOf(name);
    const layer = this.ctx.viewer.layers().find((l) => l.name === name);
    if (layer !== undefined && imageOfLayer(layer) !== undefined) return this.splatSettings(name);
    const found = this.views.get(name);
    const view = found instanceof LayerView ? found : undefined;
    const info = view?.client.info;
    const set = (patch: Partial<LayerStyle>) => this.setStyle(name, patch);
    const attributes = info?.attributes ?? [];
    const parts: Child[] = [
      el("h3", { class: "lx-heading" }, `Settings: ${name}`),
      this.select("Blending", style.blending, BLENDING_LABELS, (blending) => set({ blending })),
      this.select("Colour", style.colourBy, COLOUR_LABELS, (colourBy) => set({ colourBy, attribute: colourBy === "attribute" ? (style.attribute ?? attributes[0]?.id) : style.attribute })),
    ];
    if (style.colourBy === "attribute") {
      if (attributes.length === 0) parts.push(el("p", { class: "note" }, info ? "This store has no vertex attributes." : "The store's attributes show once it is open."));
      else
        parts.push(
          this.select(
            "Attribute",
            (style.attribute ?? attributes[0].id) as string,
            attributes.map((a) => [a.id, a.name] as [string, string]),
            (attribute) => set({ attribute, range: undefined }),
          ),
        );
      parts.push(this.select("Colormap", style.colormap, COLORMAP_LABELS, (colormap) => set({ colormap })));
      const range = style.range ?? view?.client.valueRange;
      const lo = el("input", { type: "number", class: "text-input", step: "any", value: range ? +range[0].toPrecision(4) : "", "aria-label": "Range from" }) as HTMLInputElement;
      const hi = el("input", { type: "number", class: "text-input", step: "any", value: range ? +range[1].toPrecision(4) : "", "aria-label": "Range to" }) as HTMLInputElement;
      const apply = () => {
        const a = Number(lo.value);
        const b = Number(hi.value);
        if (lo.value !== "" && hi.value !== "" && Number.isFinite(a) && Number.isFinite(b) && a !== b) set({ range: [a, b] });
      };
      lo.addEventListener("change", apply);
      hi.addEventListener("change", apply);
      parts.push(
        el(
          "div",
          { class: "field" },
          el("span", {}, style.range ? "Range" : "Range (from what has loaded)"),
          el("div", { class: "lx-row" }, lo, hi, style.range ? el("button", { type: "button", class: "lx-small", onclick: () => set({ range: undefined }) }, "Auto") : null),
        ),
      );
    }
    if (style.colourBy === "solid") {
      const colour = el("input", { type: "color", value: style.colour, "aria-label": "Colour" }) as HTMLInputElement;
      colour.addEventListener("input", () => this.setStyle(name, { colour: colour.value }, false));
      colour.addEventListener("change", () => set({ colour: colour.value }));
      parts.push(el("label", { class: "field" }, el("span", {}, "Line colour"), colour));
    }
    const points = info?.primitive === "points";
    const mesh = info?.primitive === "triangles";
    if (mesh) parts.push(el("p", { class: "note" }, "A mesh: lit surfaces in the 3-D view (direction colours by the surface's normal), and in the 2-D views the outline where the section cuts it."));
    parts.push(
      points
        ? this.slider(name, "Point size (pixels)", "width", 0.5, 12, 0.25, (v) => `${3 * v} px`)
        : this.slider(name, mesh ? "Outline width in 2-D (pixels)" : "Width (pixels)", "width", 0.5, 12, 0.25, (v) => `${v} px`),
      this.slider(name, "Brightness (stops)", "exposure", -8, 8, 0.25, (v) => (v > 0 ? `+${v}` : `${v}`)),
      this.slider(name, "Sharpness", "sharpness", 0, 1, 0.05, (v) => v.toFixed(2)),
    );
    if (style.blending === "emission") parts.push(this.slider(name, "Absorption", "absorption", 0, 8, 0.05, (v) => v.toFixed(2)));
    if (style.blending !== "solid") parts.push(this.select("Tone map", style.toneMap, TONE_LABELS, (toneMap) => set({ toneMap })), this.bloomSlider(name));
    parts.push(
      this.slider(name, "2-D slab (thickness shown around a section)", "slab", 0.5, 40, 0.5, (v) => `${v} mm`),
      this.slider(name, "Detail (vertices per view)", "detail", 0.25, 12, 0.25, (v) => `${v} M`),
      el("label", { class: "field check" }, this.checkbox(style.autoBrightness, (autoBrightness) => set({ autoBrightness })), el("span", {}, "Automatic brightness (dimmer lines where they crowd the view)")),
    );
    if (!style.on) parts.push(el("p", { class: "note" }, "Tick the layer above to draw it this way."));
    return el("div", { class: "lx-settings" }, ...parts);
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    for (const name of [...this.outgoing.keys()]) this.finishHandOver(name);
    for (const view of this.views.values()) view.dispose();
    const splats = [...this.views.values()].some((v) => v instanceof SplatView);
    for (const name of this.drawingHidden) this.ctx.viewer.hideLayerDrawing(name, false);
    if (splats) this.ctx.viewer.setTemporaryBackground(undefined);
    this.drawingHidden.clear();
    this.views.clear();
    this.momentum.dispose();
  }
}

const STYLE = `
.lx-panel { display: grid; gap: 10px; }
.lx-layers { display: grid; gap: 2px; }
.lx-layer { display: flex; align-items: center; gap: 8px; padding: 2px 4px; border-radius: 4px; }
.lx-layer.lx-editing { background: var(--hover, rgba(255,255,255,0.06)); }
.lx-name { all: unset; cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.lx-settings { display: grid; gap: 10px; }
.lx-heading { font-size: 12px; font-weight: 600; margin: 6px 0 0; }
.lx-row { display: flex; align-items: center; gap: 8px; }
.lx-row input[type="range"] { flex: 1; min-width: 0; }
.lx-row input[type="number"] { flex: 1; min-width: 0; }
.lx-value { font-size: 11px; color: var(--muted); min-width: 44px; text-align: right; }
.lx-small { font-size: 11px; }
.luxar-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
`;

let instance: Luxar | undefined;

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = el("style", {}, STYLE);
    document.head.append(style);
    const own = (instance = new Luxar(ctx));
    ctx.subscriptions.push(() => style.remove());
    ctx.subscriptions.push(() => {
      own.dispose();
      if (instance === own) instance = undefined;
    });
    ctx.ui.panel(LUXAR_PANEL, (host) => own.render(host));
    ctx.commands.register("luxar.toggle", () => {
      const name = ctx.workspace.selectedLayer();
      const layer = name === undefined ? undefined : own.candidates().find((l) => l.name === name);
      if (layer === undefined) {
        ctx.ui.toast("Select a Zarr Vectors layer first.");
        return;
      }
      own.toggle(layer.name);
    });
    ctx.commands.register("luxar.show", () => ctx.ui.showPanel(LUXAR_PANEL));
  },
};
