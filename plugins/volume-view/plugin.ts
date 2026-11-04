/**
 * Volume rendering in Neuroglancer's 3-D view: an image layer (OME-Zarr)
 * drawn as a solid, its octant facing the camera cut away at the position so
 * the sections show inside it.  "Volume", beside "Sections" in the 3-D
 * panel, switches it on and off; the Volume tab chooses the image, the
 * detail and the tissue threshold.  The drawing is ./solid.ts; the image's
 * levels are read by ./volume_worker.ts.
 */
import type { Disposer, LayerInfo, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { el } from "@ngplatform/sdk/dom";
import { mmText } from "@ngplatform/sdk/format";
import { VOLUME_PANEL } from "./manifest.js";
import { invert, multiply } from "./ome.js";
import { displayOfRas, SolidDrawer } from "./solid.js";
import { fineSections, layoutType, type SectionPlan } from "./sections.js";
import { storeOf } from "./sources.js";

export { omeZarrUrl, storeOf } from "./sources.js";
import { type LevelInfo, type Region, VolumeClient } from "./volume_client.js";

/**
 * Levels up to this many voxels a side are drawn whole; larger ones as
 * bricks over the finest that fits, or (where the GPU cannot hold the
 * bricks) as a box this many voxels a side around the position.
 */
const WHOLE = 384;
const BOX = 256;

export interface Saved {
  on: boolean;
  /** The image layer drawn; the first image it can read when unset or gone. */
  layer?: string;
  /**
   * The solid's voxel size, mm: the finest level at least this coarse (with
   * bricks, the finest level they are drawn from); 0 follows the 3-D view.
   */
  solid: number;
  /** Tissue threshold, 0..1 of difference from the background. */
  threshold: number;
  cut: boolean;
  /**
   * The cut's faces from sections of their own (the finest level within a
   * budget, following the 3-D zoom); off, from the 2-D views' sections.
   */
  fine: boolean;
}

export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as Partial<Saved>;
  return {
    on: s.on === true,
    layer: typeof s.layer === "string" ? s.layer : undefined,
    solid: typeof s.solid === "number" ? s.solid : 0,
    threshold: typeof s.threshold === "number" ? s.threshold : 0.2,
    cut: s.cut !== false,
    fine: s.fine !== false,
  };
}

class VolumeRendering {
  private saved: Saved;
  private readonly drawer = new SolidDrawer();
  private client: VolumeClient | undefined;
  private handle: { redraw(): void; dispose(): void } | undefined;
  private handleLayer: string | undefined;
  private levels: LevelInfo[] = [];
  private store: string | undefined;
  /** An image that failed to open, not asked for again until then. */
  private failed: { url: string; until: number } | undefined;
  private disposed = false;
  private loaded: string | undefined;
  private loading: AbortController | undefined;
  private status = "";
  private readonly toggle: { set(value: boolean): void; dispose(): void };
  private panelUpdate: (() => void) | undefined;
  private readonly offs: Disposer[] = [];
  /** Bricks of the finer levels are drawn (until the GPU cannot hold them: then a box of one level). */
  private bricks = true;
  private brickNoted: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.drawer.onProblem = () => this.setStatus(this.drawer.problem ?? "");
    this.drawer.onBricks = () => {
      if (this.drawer.bricksFailed !== undefined && this.bricks) {
        this.bricks = false;
        this.loaded = undefined;
        this.update();
        return;
      }
      this.handle?.redraw();
      // The panel's count of bricks, now and then.
      this.brickNoted ??= setTimeout(() => {
        this.brickNoted = undefined;
        this.panelUpdate?.();
      }, 500);
    };
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
      ctx.viewer.onStateChanged(() => {
        // A box around the position follows it, and automatic detail the
        // zoom, a moment after they stop (looked at then: reading the view's
        // state on every change would slow a heavy scene).
        if (!this.saved.on) return;
        clearTimeout(this.follow);
        this.follow = setTimeout(() => {
          const zoomed = this.saved.solid === 0 && this.autoFor !== this.autoVoxel();
          // Fine sections follow the 3-D zoom, and notice Sections switched on.
          if (this.region !== undefined || zoomed || this.saved.fine) this.update();
        }, 400);
      }),
      () => clearTimeout(this.follow),
      () => clearTimeout(this.brickNoted),
    );
    this.update();
  }

  private follow: ReturnType<typeof setTimeout> | undefined;

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

  /** Image layers this can draw: OME-Zarr and precomputed images. */
  candidates(): LayerInfo[] {
    return this.ctx.viewer.layers().filter((l) => l.type === "image" && storeOf(l.sources[0]) !== undefined);
  }

  private target(): LayerInfo | undefined {
    const candidates = this.candidates();
    return candidates.find((l) => l.name === this.saved.layer) ?? candidates[0];
  }

  /**
   * The finest level at least `solid` coarse (a large one is drawn as a box
   * around the position).  Automatic (`solid` 0): the finest whose box, or
   * whole image, spans three quarters of the 3-D view's height.  (With
   * bricks, automatic is the finest level, and the bricks follow the view.)
   */
  private chooseLevel(): LevelInfo | undefined {
    const wanted = (this.saved.solid > 0 ? this.saved.solid : this.autoVoxel()) * 0.95;
    return this.levels.find((l) => l.voxelSize >= wanted) ?? this.levels[this.levels.length - 1];
  }

  /** For automatic detail: the voxel size (mm) at which a box spans most of the 3-D view. */
  private autoVoxel(): number {
    const state = this.ctx.viewer.getState() as { projectionScale?: number; dimensions?: Record<string, [number, string]> };
    const scales = Object.values(state.dimensions ?? {})
      .filter(([, unit]) => unit === "m")
      .map(([scale]) => scale);
    if (state.projectionScale === undefined || scales.length === 0) return 1;
    // The view's height: projectionScale canonical voxels, the smallest display scale each.
    const height = state.projectionScale * Math.min(...scales) * 1000;
    return (0.75 * height) / BOX;
  }

  private autoFor: number | undefined;

  /** The position, in a level's voxels; undefined when the view's axes are not x, y and z. */
  private positionIn(level: LevelInfo): number[] | undefined {
    const state = this.ctx.viewer.getState() as { position?: number[]; dimensions?: Record<string, [number, string]> };
    const dims = state.dimensions;
    if (state.position === undefined || dims === undefined) return undefined;
    const names = Object.keys(dims);
    const toDisplay = displayOfRas({ names, scales: names.map((n) => dims[n][0]), units: names.map((n) => dims[n][1]) } as never);
    if (toDisplay === undefined) return undefined;
    const toVoxel = invert(multiply(toDisplay, level.voxelToRas));
    const p = state.position;
    return [0, 1, 2].map((r) => toVoxel[4 * r] * p[0] + toVoxel[4 * r + 1] * p[1] + toVoxel[4 * r + 2] * p[2] + toVoxel[4 * r + 3]);
  }

  private region: Region | undefined;

  /**
   * The box of a large level to draw: kept while the position stays in its
   * middle half, else centred on the position again.
   */
  private regionFor(level: LevelInfo): Region | undefined {
    if (Math.max(...level.size) <= WHOLE) return undefined;
    const at = this.positionIn(level) ?? level.size.map((s) => s / 2);
    const old = this.region;
    if (old !== undefined && this.regionLevel === level.path && [0, 1, 2].every((k) => Math.abs(at[k] - (old.lo[k] + old.hi[k]) / 2) <= BOX / 4)) return old;
    const lo = [0, 1, 2].map((k) => Math.max(0, Math.min(level.size[k] - BOX, Math.round(at[k] - BOX / 2)))) as [number, number, number];
    const hi = [0, 1, 2].map((k) => Math.min(level.size[k], lo[k] + BOX)) as [number, number, number];
    return { lo, hi };
  }

  private regionLevel: string | undefined;

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
      // Nothing drawn: reads stop and the bricks (and their GPU memory) go; a load cut short is made again when switched on.
      if (this.loading !== undefined) {
        this.loading.abort();
        this.loading = undefined;
        this.loaded = undefined;
      }
      this.drawer.setBricks(undefined);
      this.fineSections(undefined);
      this.handle?.dispose();
      this.handle = undefined;
      this.handleLayer = undefined;
      if (saved.on) {
        const message = "Add an OME-Zarr or precomputed image to render it.";
        if (this.status !== message) this.ctx.ui.toast(message);
        this.setStatus(message);
      } else this.setStatus("");
      this.panelUpdate?.();
      return;
    }
    if (!layoutType(this.ctx.viewer.getState().layout).match(/3d|4panel/)) {
      this.ctx.viewer.patchState((ng) => {
        ng.layout = "xy-3d";
      });
    }
    const url = storeOf(target.sources[0])!;
    if (url !== this.store && !(url === this.failed?.url && Date.now() < this.failed.until)) {
      // The last image's reads stop, so they cannot land after this one's.
      this.loading?.abort();
      this.loading = undefined;
      this.store = url;
      this.levels = [];
      this.loaded = undefined;
      this.contextLoaded = undefined;
      this.region = undefined;
      void this.open(url);
    } else if (this.levels.length > 0 && this.bricks) {
      this.autoFor = this.autoVoxel();
      const whole = this.wholeLevel();
      const key = `${url}|${whole.path}|`;
      if (key !== this.loaded) {
        this.region = undefined;
        void this.load(whole, key, undefined);
      }
    } else if (this.levels.length > 0) {
      this.autoFor = this.autoVoxel();
      const level = this.chooseLevel();
      if (level !== undefined) {
        const region = this.regionFor(level);
        const key = `${url}|${level.path}|${region?.lo.join(",") ?? ""}`;
        if (key !== this.loaded) {
          this.region = region;
          this.regionLevel = level.path;
          void this.load(level, key, region);
        }
      }
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
    this.offerBricks();
    this.fineSections(this.levels.length > 0 ? this.fineSectionPlan() : undefined);
    this.handle?.redraw();
    this.panelUpdate?.();
  }

  /**
   * With bricks, the level drawn whole: a chosen level when it fits whole
   * (then without bricks), else the finest that fits.
   */
  private wholeLevel(): LevelInfo {
    const context = this.contextLevel()!;
    const chosen = this.saved.solid > 0 ? this.chooseLevel() : undefined;
    return chosen !== undefined && this.levels.indexOf(chosen) > this.levels.indexOf(context) ? chosen : context;
  }

  /**
   * Bricks of the levels finer than the whole one, down to the chosen level
   * (automatic: the finest), once the whole one is drawn.
   */
  private offerBricks(): void {
    const client = this.client;
    if (!this.bricks || !this.saved.on || this.levels.length === 0 || client === undefined) {
      this.drawer.setBricks(undefined);
      return;
    }
    const whole = this.wholeLevel();
    const at = this.levels.indexOf(whole);
    const finest = this.saved.solid > 0 ? this.levels.indexOf(this.chooseLevel()!) : 0;
    const ready = this.contextLoaded === `${this.store}|${whole.path}|` && finest < at;
    this.drawer.setBricks(
      ready
        ? {
            key: `${this.store}|${whole.path}`,
            levels: this.levels.slice(0, at).map((l, index) => ({ index, size: l.size, voxelToRas: l.voxelToRas })),
            finest,
            load: (level, region, signal) => client.volume(level, undefined, signal, region).then((v) => v.data),
          }
        : undefined,
    );
  }

  /** What the bricks hold, for the panel. */
  private brickNote(): string | undefined {
    const s = this.drawer.brickStatus();
    if (s === undefined || s.levels.length === 0) return undefined;
    const sizes = s.levels.map((i) => this.levels[i].voxelSize);
    const range = sizes.length > 1 ? `${mmText(Math.min(...sizes))} to ${mmText(Math.max(...sizes))}` : mmText(sizes[0]);
    return `Bricks of ${range} near the camera and the cut: ${s.held} of ${s.slots} held${s.loading > 0 ? `, ${s.loading} loading` : ""}.`;
  }

  /**
   * Sections of the plugin's own on the cut's faces: Neuroglancer's 3-D view
   * draws the 2-D views' sections there, at the 2-D views' zoom and only as
   * far as they reach (and only the xy one in the xy-3d layout).  Three
   * cross-sections of the layout's own (Neuroglancer's `crossSections`),
   * following the position and orientation, at the finest level that a
   * budget of pixels allows around the position and that the 3-D zoom can
   * show, load and draw instead, as Neuroglancer draws any section: every
   * layer, its shader, its levels.
   */
  private fineSectionPlan(): SectionPlan | undefined {
    if (!this.saved.fine) return undefined;
    const state = this.ctx.viewer.getState() as { dimensions?: Record<string, [number, string]>; projectionScale?: number };
    const dims = state.dimensions;
    if (dims === undefined) return undefined;
    const metres = Object.values(dims).filter(([, unit]) => unit === "m").map(([scale]) => scale);
    if (metres.length === 0) return undefined;
    const panel = this.ctx.viewer.panels().find((p) => p.kind === "3d");
    const finest = this.levels[0];
    const extent = Math.max(...finest.size) * finest.voxelSize;
    return {
      finestMm: finest.voxelSize,
      extentMm: extent,
      canonicalMetres: Math.min(...metres),
      projectionScale: state.projectionScale,
      panelPixels: panel ? Math.max(panel.element.clientWidth, panel.element.clientHeight) : 800,
    };
  }

  /** The layout's cross-sections now, so a change is written only when it differs. */
  private sectionsKey: string | undefined;
  private hidSlices = false;

  private fineSections(plan: SectionPlan | undefined): void {
    const state = this.ctx.viewer.getState() as { layout?: unknown; showSlices?: boolean };
    const wanted = plan === undefined ? undefined : fineSections(plan);
    const key = JSON.stringify(wanted ?? null);
    const layout = state.layout;
    const current = typeof layout === "object" && layout !== null ? (layout as { crossSections?: unknown }).crossSections : undefined;
    if (wanted !== undefined && state.showSlices !== false && this.sectionsKey !== undefined) {
      // Sections switched back on in the 3-D view: the 2-D views' sections, not ours.
      this.saved = { ...this.saved, fine: false };
      this.ctx.state.set(this.saved);
      this.fineSections(undefined);
      this.panelUpdate?.();
      return;
    }
    // Our sections in a state from a link: Sections was hidden for them, to give back.
    if (current !== undefined && Object.prototype.hasOwnProperty.call(current, "volume-xy") && state.showSlices === false) this.hidSlices = true;
    if (wanted === undefined && current === undefined && !this.hidSlices) {
      this.sectionsKey = undefined;
      return;
    }
    if (key === this.sectionsKey && (wanted === undefined) === (current === undefined)) return;
    this.sectionsKey = wanted === undefined ? undefined : key;
    this.ctx.viewer.patchState(
      (ng) => {
        const type = layoutType(ng.layout);
        ng.layout = wanted === undefined ? type : { type, crossSections: wanted };
        if (wanted !== undefined && ng.showSlices !== false) {
          // Neuroglancer's own sections would lie on ours.
          ng.showSlices = false;
          this.hidSlices = true;
        } else if (wanted === undefined && this.hidSlices) {
          delete ng.showSlices;
          this.hidSlices = false;
        }
      },
      { quiet: true },
    );
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
      if (this.store !== url) return;
      this.setStatus(`Could not open the image: ${(e as Error).message}. Trying again in a few seconds.`);
      // Opened again on a later update (a network blip need not stick), at most every few seconds.
      this.store = undefined;
      this.failed = { url, until: Date.now() + 5000 };
      setTimeout(() => {
        if (!this.disposed) this.update();
      }, 5100);
    }
  }

  /** The whole image the solid shows when the chosen level is drawn as a box: the finest level small enough to hold whole. */
  private contextLevel(): LevelInfo | undefined {
    return this.levels.find((l) => Math.max(...l.size) <= WHOLE) ?? this.levels[this.levels.length - 1];
  }

  /** The level (or a box of it) the solid shows, as keyed; and the whole coarse level under a box. */
  private contextLoaded: string | undefined;

  /**
   * Loads what the solid shows: a level whole; or, for a box of a large
   * level, the whole image from a coarse level first (once) and the box
   * as the detail drawn inside it.
   */
  private async load(level: LevelInfo, key: string, region: Region | undefined): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    this.loading?.abort();
    const controller = (this.loading = new AbortController());
    this.loaded = key;
    const started = performance.now();
    const read = async (l: LevelInfo, box: Region | undefined, what: string) => {
      const label = mmText(l.voxelSize);
      this.setStatus(`Loading ${what} (${label})…`);
      const { data, size } = await client.volume(this.levels.indexOf(l), (done, total) => this.setStatus(`Loading ${what} (${label}): ${done} of ${total} chunks`), controller.signal, box);
      // A box's voxel 0 is the level's voxel `lo`.
      const voxelToRas = new Float64Array(l.voxelToRas);
      if (box !== undefined) for (let r = 0; r < 3; ++r) voxelToRas[4 * r + 3] += [0, 1, 2].reduce((sum, c) => sum + l.voxelToRas[4 * r + c] * box.lo[c], 0);
      return { data, size, voxelToRas };
    };
    try {
      if (region === undefined) {
        const v = await read(level, undefined, "the solid");
        if (controller.signal.aborted) return;
        this.drawer.setVolume(v.data, v.size, v.voxelToRas, level.voxelSize);
        this.drawer.setDetail(undefined);
        this.contextLoaded = key;
        this.offerBricks();
        this.handle?.redraw();
        this.setStatus(`Solid at ${mmText(level.voxelSize)} (${v.size.join(" × ")} voxels), in ${((performance.now() - started) / 1000).toFixed(1)} s`);
        return;
      }
      const context = this.contextLevel()!;
      const contextKey = `${this.store}|${context.path}|`;
      if (this.contextLoaded !== contextKey) {
        const v = await read(context, undefined, "the whole image");
        if (controller.signal.aborted) return;
        this.drawer.setVolume(v.data, v.size, v.voxelToRas, context.voxelSize);
        this.drawer.setDetail(undefined);
        this.contextLoaded = contextKey;
        this.handle?.redraw();
      }
      const box = await read(level, region, "a box around the position");
      if (controller.signal.aborted) return;
      this.drawer.setDetail(box.data, box.size, box.voxelToRas);
      this.handle?.redraw();
      this.setStatus(`Solid at ${mmText(context.voxelSize)}, with ${mmText(level.voxelSize)} in a box around the position (${box.size.join(" × ")} voxels), in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    } catch (e) {
      if (controller.signal.aborted) return;
      this.loaded = undefined;
      this.setStatus(`Could not load the solid: ${(e as Error).message}`);
    } finally {
      if (this.loading === controller) this.loading = undefined;
    }
  }

  // ------------------------------------------------------------- panel

  render(host: HTMLElement): Disposer {
    const draw = () => {
      const { saved } = this;
      const candidates = this.candidates();
      const target = this.target();
      const on = el("input", { type: "checkbox", "aria-label": "Volume rendering" }) as HTMLInputElement;
      on.checked = saved.on;
      on.addEventListener("change", () => this.set({ on: on.checked }));
      const layer = el("select", { class: "text-input", "aria-label": "Image" }) as HTMLSelectElement;
      for (const c of candidates) layer.append(el("option", { value: c.name }, c.name));
      if (target) layer.value = target.name;
      layer.disabled = candidates.length < 2;
      layer.addEventListener("change", () => this.set({ layer: layer.value }));
      const detail = el("select", { class: "text-input", "aria-label": "Detail" }) as HTMLSelectElement;
      const chosen = this.chooseLevel();
      const bricks = this.bricks;
      detail.append(el("option", { value: "0" }, `Automatic${bricks ? " (finer near the camera)" : saved.solid === 0 && chosen ? ` (${mmText(chosen.voxelSize)})` : ""}`));
      for (const l of this.levels) {
        const big = Math.max(...l.size) > WHOLE;
        detail.append(el("option", { value: String(l.voxelSize) }, `${mmText(l.voxelSize)} · ${!big ? l.size.join(" × ") : bricks ? "bricks" : `a ${BOX}³ box`}`));
      }
      detail.value = saved.solid === 0 || chosen === undefined ? "0" : String(chosen.voxelSize);
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
      const brickNote = this.brickNote();
      const fine = el("input", { type: "checkbox" }) as HTMLInputElement;
      fine.checked = saved.fine;
      fine.addEventListener("change", () => this.set({ fine: fine.checked }));
      host.replaceChildren(
        el(
          "div",
          { class: "vv-panel" },
          el("label", { class: "vv-row", title: "Draws the image as a solid in the 3-D view, cut open at the position. Also Volume beside Sections in the 3-D view." }, el("span", { class: "vv-label" }, "Volume rendering"), on),
          el("label", { class: "field" }, el("span", {}, "Image"), candidates.length ? layer : el("span", { class: "note" }, "Add an OME-Zarr or precomputed image to render it.")),
          el("label", { class: "field" }, el("span", {}, "Detail"), detail),
          el("label", { class: "field" }, el("span", {}, "Tissue threshold"), el("div", { class: "vv-row" }, threshold, thresholdValue)),
          el("label", { class: "field check", title: "Cuts away the octant facing the camera" }, cut, el("span", {}, "Cut open at the position")),
          el(
            "label",
            { class: "field check", title: "Sections of their own on the cut's faces, as fine as the 3-D zoom shows (up to the finest level, within 2048 pixels a side around the position). Off: the 2-D views' sections, at their zoom (Sections in the 3-D view)." },
            fine,
            el("span", {}, "Fine sections on the cut"),
          ),
          this.status ? el("p", { class: "note" }, this.status) : null,
          this.bricks ? null : el("p", { class: "note" }, `No bricks on this GPU (${this.drawer.bricksFailed}): finer levels are drawn as a box around the position.`),
          saved.on && brickNote !== undefined ? el("p", { class: "note" }, brickNote) : null,
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
    this.disposed = true;
    this.offs.forEach((off) => off());
    // The 3-D view's section background comes back with the plugin off.
    this.sectionBackground(false);
    this.fineSections(undefined);
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
