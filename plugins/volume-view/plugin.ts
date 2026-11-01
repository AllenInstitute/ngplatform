/**
 * Volume rendering in Neuroglancer's 3-D view: an image layer (OME-Zarr)
 * drawn as a solid, its octant facing the camera cut away at the position so
 * the sections show inside it.  "Volume", beside "Sections" in the 3-D
 * panel, switches it on and off; the Volume tab chooses the image, the
 * detail and the tissue threshold.  The drawing is ./solid.ts; the image's
 * levels are read by ./volume_worker.ts.
 */
import type { Disposer, LayerInfo, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { VOLUME_PANEL } from "./manifest.js";
import { SolidDrawer } from "./solid.js";
import { type LevelInfo, VolumeClient } from "./volume_client.js";

export interface Saved {
  on: boolean;
  /** The image layer drawn; the first OME-Zarr image when unset or gone. */
  layer?: string;
  /** The solid's voxel size, mm: the finest level at least this coarse. */
  solid: number;
  /** Tissue threshold, 0..1 of difference from the background. */
  threshold: number;
  cut: boolean;
}

export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as Partial<Saved>;
  return {
    on: s.on === true,
    layer: typeof s.layer === "string" ? s.layer : undefined,
    solid: typeof s.solid === "number" ? s.solid : 1,
    threshold: typeof s.threshold === "number" ? s.threshold : 0.2,
    cut: s.cut !== false,
  };
}

/** The OME-Zarr store an image layer's source names, as an http(s) URL; undefined for other formats. */
export function omeZarrUrl(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  let url = source.trim();
  const scheme = /^(zarr2?|zarr3):\/\//i.exec(url);
  const pipe = /\|zarr[23]?:?[^|]*$/i.exec(url);
  if (scheme === null && pipe === null && !/\.ome\.zarr\/?$/i.test(url)) return undefined;
  if (scheme) url = url.slice(scheme[0].length);
  if (pipe) url = url.slice(0, pipe.index);
  url = url.replace(/^gs:\/\/([^/]+)\//, "https://storage.googleapis.com/$1/").replace(/^s3:\/\/([^/]+)\//, "https://$1.s3.amazonaws.com/");
  if (!/^https?:\/\//.test(url) && !url.startsWith("/")) return undefined;
  return url.endsWith("/") ? url : `${url}/`;
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

const mm = (v: number) => (v >= 1 ? `${+v.toFixed(2)} mm` : `${Math.round(v * 1000)} µm`);

class VolumeRendering {
  private saved: Saved;
  private readonly drawer = new SolidDrawer();
  private client: VolumeClient | undefined;
  private handle: { redraw(): void; dispose(): void } | undefined;
  private handleLayer: string | undefined;
  private levels: LevelInfo[] = [];
  private store: string | undefined;
  private loaded: string | undefined;
  private loading: AbortController | undefined;
  private status = "";
  private readonly toggle: { set(value: boolean): void; dispose(): void };
  private panelUpdate: (() => void) | undefined;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.drawer.onProblem = () => this.setStatus(this.drawer.problem ?? "");
    this.toggle = ctx.ui.viewToggle({
      label: "Volume",
      title: "Draw an image as a solid, cut open at the position (the Volume tab has its settings)",
      value: this.saved.on,
      onChange: (on) => this.set({ on }),
    });
    this.offs.push(
      ctx.state.onChanged(() => {
        const next = readSaved(ctx.state.get());
        if (JSON.stringify(next) === JSON.stringify(this.saved)) return;
        this.saved = next;
        this.toggle.set(next.on);
        this.update();
      }),
      ctx.viewer.onLayersChanged(() => this.update()),
    );
    this.update();
  }

  private set(patch: Partial<Saved>): void {
    this.saved = { ...this.saved, ...patch };
    this.ctx.state.set(this.saved);
    if (patch.on !== undefined) this.toggle.set(patch.on);
    this.update();
  }

  private setStatus(text: string): void {
    this.status = text;
    this.panelUpdate?.();
  }

  /** Image layers this can draw: OME-Zarr images. */
  candidates(): LayerInfo[] {
    return this.ctx.viewer.layers().filter((l) => l.type === "image" && omeZarrUrl(l.sources[0]) !== undefined);
  }

  private target(): LayerInfo | undefined {
    const candidates = this.candidates();
    return candidates.find((l) => l.name === this.saved.layer) ?? candidates[0];
  }

  private chooseLevel(): LevelInfo | undefined {
    const wanted = this.saved.solid * 0.95;
    // The finest level at least `solid` coarse, and at most 384 voxels on a side.
    const fits = (l: LevelInfo) => Math.max(...l.size) <= 384;
    return this.levels.find((l) => l.voxelSize >= wanted && fits(l)) ?? this.levels.find(fits) ?? this.levels[this.levels.length - 1];
  }

  private updating = false;

  private update(): void {
    // Attaching to a layer changes the layers, which calls this again.
    if (this.updating) return;
    this.updating = true;
    try {
      this.updateNow();
    } finally {
      this.updating = false;
    }
  }

  private updateNow(): void {
    const { saved } = this;
    this.drawer.options = { threshold: saved.threshold, cut: saved.cut };
    const target = saved.on ? this.target() : undefined;
    this.sectionBackground(saved.on && target !== undefined);
    if (!saved.on || target === undefined) {
      this.handle?.dispose();
      this.handle = undefined;
      this.handleLayer = undefined;
      if (saved.on) this.setStatus("No OME-Zarr image in this scene to draw. Add one (zarr://…) as a dataset.");
      else this.setStatus("");
      this.panelUpdate?.();
      return;
    }
    if (!this.ctx.viewer.getState().layout?.toString().match(/3d|4panel/)) {
      this.ctx.viewer.patchState((ng) => {
        ng.layout = "xy-3d";
      });
    }
    const url = omeZarrUrl(target.sources[0])!;
    if (url !== this.store) {
      this.store = url;
      this.levels = [];
      this.loaded = undefined;
      void this.open(url);
    } else if (this.levels.length > 0) {
      const level = this.chooseLevel();
      const key = level && `${url}|${level.path}`;
      if (level !== undefined && key !== this.loaded) void this.load(level, key!);
    }
    if (this.handleLayer !== target.name) {
      this.handle?.dispose();
      this.handleLayer = target.name;
      // The drawer stays; only its tie to a layer changes.
      this.handle = this.ctx.viewer.draw3d(target.name, {
        draw: (frame) => this.drawer.draw(frame),
        isReady: () => this.drawer.isReady(),
        sectionClip: (frame) => this.drawer.sectionClip(frame),
      });
    }
    this.handle?.redraw();
    this.panelUpdate?.();
  }

  private hidBackground = false;

  /**
   * While the solid is drawn, the sections' background (outside the data)
   * is left out of the 3-D view, so the planes do not hide the solid around
   * the brain; put back as it was afterwards.
   */
  private sectionBackground(solid: boolean): void {
    const state = this.ctx.viewer.getState();
    if (solid && state.hideCrossSectionBackground3D !== true) {
      this.hidBackground = true;
      this.ctx.viewer.patchState((ng) => {
        ng.hideCrossSectionBackground3D = true;
      });
    } else if (!solid && this.hidBackground) {
      this.hidBackground = false;
      this.ctx.viewer.patchState((ng) => {
        delete ng.hideCrossSectionBackground3D;
      });
    }
  }

  private async open(url: string): Promise<void> {
    this.client ??= new VolumeClient();
    this.setStatus("Opening the image…");
    try {
      const opened = await this.client.open([url], undefined);
      if (this.store !== url) return;
      this.levels = opened.levels;
      if (this.levels.length === 0) throw new Error("it has no image levels");
      this.update();
    } catch (e) {
      if (this.store === url) this.setStatus(`Could not open the image: ${(e as Error).message}`);
    }
  }

  private async load(level: LevelInfo, key: string): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    this.loading?.abort();
    const controller = (this.loading = new AbortController());
    this.loaded = key;
    const index = this.levels.indexOf(level);
    const label = mm(level.voxelSize);
    const started = performance.now();
    this.setStatus(`Loading the solid (${label})…`);
    try {
      const { data, size } = await client.volume(index, (done, total) => this.setStatus(`Loading the solid (${label}): ${done} of ${total} chunks`), controller.signal);
      if (controller.signal.aborted) return;
      this.drawer.setVolume(data, size, level.voxelToRas, level.voxelSize);
      this.handle?.redraw();
      this.setStatus(`Solid at ${label} (${size.join(" × ")} voxels), in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    } catch (e) {
      if (controller.signal.aborted) return;
      this.loaded = undefined;
      this.setStatus(`Could not load the solid: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------- panel

  render(host: HTMLElement): Disposer {
    const draw = () => {
      const { saved } = this;
      const candidates = this.candidates();
      const target = this.target();
      const on = el("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Volume rendering" }) as HTMLInputElement;
      on.checked = saved.on;
      on.addEventListener("change", () => this.set({ on: on.checked }));
      const layer = el("select", { class: "text-input", "aria-label": "Image" }) as HTMLSelectElement;
      for (const c of candidates) layer.append(el("option", { value: c.name }, c.name));
      if (target) layer.value = target.name;
      layer.disabled = candidates.length < 2;
      layer.addEventListener("change", () => this.set({ layer: layer.value }));
      const detail = el("select", { class: "text-input", "aria-label": "Detail" }) as HTMLSelectElement;
      const chosen = this.chooseLevel();
      for (const l of this.levels) {
        const big = Math.max(...l.size) > 384;
        detail.append(el("option", { value: String(l.voxelSize), disabled: big }, `${mm(l.voxelSize)} · ${l.size.join(" × ")}${big ? " (too large)" : ""}`));
      }
      if (chosen) detail.value = String(chosen.voxelSize);
      detail.disabled = this.levels.length === 0;
      detail.addEventListener("change", () => this.set({ solid: Number(detail.value) }));
      const threshold = el("input", { type: "range", min: "0.01", max: "0.9", step: "0.01", value: String(saved.threshold), "aria-label": "Tissue threshold" }) as HTMLInputElement;
      const thresholdValue = el("span", { class: "type" }, saved.threshold.toFixed(2));
      threshold.addEventListener("input", () => {
        thresholdValue.textContent = Number(threshold.value).toFixed(2);
        this.drawer.options = { ...this.drawer.options, threshold: Number(threshold.value) };
        this.handle?.redraw();
      });
      threshold.addEventListener("change", () => this.set({ threshold: Number(threshold.value) }));
      const cut = el("input", { type: "checkbox" }) as HTMLInputElement;
      cut.checked = saved.cut;
      cut.addEventListener("change", () => this.set({ cut: cut.checked }));
      host.replaceChildren(
        el(
          "div",
          { class: "vv-panel" },
          el("label", { class: "vv-row" }, el("span", { class: "vv-label" }, "Volume rendering"), on),
          el("p", { class: "note" }, "Draws an image as a solid in the 3-D view, cut open at the position. Also switched with “Volume” beside “Sections” there."),
          el("label", { class: "field" }, el("span", {}, "Image"), candidates.length ? layer : el("span", { class: "note" }, "No OME-Zarr image in this scene.")),
          el("label", { class: "field" }, el("span", {}, "Detail"), detail),
          el("label", { class: "field" }, el("span", {}, "Tissue threshold"), el("div", { class: "vv-row" }, threshold, thresholdValue)),
          el("label", { class: "field check" }, cut, el("span", {}, "Cut away the octant facing the camera")),
          this.status ? el("p", { class: "note" }, this.status) : null,
        ),
      );
    };
    this.panelUpdate = draw;
    draw();
    return () => {
      if (this.panelUpdate === draw) this.panelUpdate = undefined;
    };
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.loading?.abort();
    this.handle?.dispose();
    this.toggle.dispose();
    this.drawer.dispose();
    this.client?.dispose();
  }
}

const STYLE = `
.vv-panel { display: grid; gap: 10px; }
.vv-row { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.vv-row input[type="range"] { flex: 1; }
.vv-label { font-weight: 600; }
`;

let instance: VolumeRendering | undefined;

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = el("style", {}, STYLE);
    document.head.append(style);
    instance = new VolumeRendering(ctx);
    const own = instance;
    ctx.subscriptions.push(() => style.remove());
    ctx.subscriptions.push(() => {
      own.dispose();
      if (instance === own) instance = undefined;
    });
    ctx.ui.panel(VOLUME_PANEL, (host) => own.render(host));
    ctx.commands.register("volumeView.toggle", () => {
      const saved = readSaved(ctx.state.get());
      ctx.state.set({ ...saved, on: !saved.on });
    });
  },
};
