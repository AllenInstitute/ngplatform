/**
 * The volume view: in place of Neuroglancer's 3-D panel, a solid brain
 * from an OME-Zarr pyramid, the octant facing the camera cut away at the
 * viewer's position, its faces showing sections from finer levels, and the
 * visible track groups drawn through the cut.
 *
 * The solid is one coarse level (the whole of it, a few megabytes); the
 * sections are resampled in a worker from finer levels, coarse first, as the
 * cut moves.  Neuroglancer's 2-D views stay beside it, and moving the
 * position there moves the cut.
 */
import type { Disposer, Json, PlatformContext, PluginModule } from "@ngplatform/sdk";
import type { TrackGroupsService } from "../track-filtering/plugin.js";
import { VOLUME_PANEL } from "./manifest.js";
import { rasBounds } from "./ome.js";
import { type Camera, type Options, VolumeRenderer } from "./renderer.js";
import { type LevelInfo, VolumeClient } from "./volume_client.js";

const BIGBRAIN = "https://ftp.bigbrainproject.org/bigbrain-ftp/BigBrainRelease.2015/OME_Zarr/";
/** TemplateFlow's copy has no CORS headers, so the site serves a converted one. */
const MNI2009A = "https://andrew-keenlyside.github.io/ngplatform/data/MNI152NLin2009aAsym_T1w_brain.ome.zarr/";

/** Volumes offered by name. */
export const PRESETS: { id: string; title: string; stores: string[]; space?: string; threshold?: number; credit: string }[] = [
  {
    id: "bigbrain-mni",
    title: "BigBrain, in MNI ICBM152 2009b (linear)",
    // Each resolution is its own store; the first given wins where two have one.
    stores: [`${BIGBRAIN}1000um/`, `${BIGBRAIN}400um/`, `${BIGBRAIN}200um/`, `${BIGBRAIN}100um/`],
    space: "MNI152NLin2009bAsym",
    credit:
      "BigBrain (Amunts et al., Science 2013), CC BY-NC-SA 4.0, bigbrainproject.org. OME-Zarr conversion and linear MNI placement by A. Keenlyside (2026). Structure after Open the Mind (C. Sam, BigBrain Hackathon 2026).",
  },
  {
    id: "mni152-2009a",
    title: "MNI ICBM152 2009a template (T1w, brain), 1 mm",
    // The space HCP-1065 and DSI Studio's ICBM152 atlases are in.
    stores: [MNI2009A],
    // Above CSF, below grey matter: the surface is the cortex's.
    threshold: 0.35,
    credit:
      "ICBM 152 Nonlinear Asymmetric 2009a (Fonov et al., NeuroImage 2011). Copyright (C) 1993-2004 Louis Collins, McConnell Brain Imaging Centre, Montreal Neurological Institute, McGill University. From TemplateFlow; masked to the brain and converted to OME-Zarr for this view.",
  },
];

export interface Saved {
  on: boolean;
  preset?: string;
  stores: string[];
  space?: string;
  /** The solid's voxel size, mm: the finest level at least this coarse. */
  solid: number;
  /** The finest sections' voxel size, mm. */
  finest: number;
  /** Tissue threshold, 0..1 of difference from the background. */
  threshold: number;
  cut: boolean;
  sections: boolean;
  tracts: boolean;
  /** Neuroglancer's layout before the view took its 3-D panel. */
  layout?: unknown;
}

export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as Partial<Saved>;
  const preset = PRESETS.find((p) => p.id === s.preset);
  return {
    on: s.on === true,
    preset: s.preset,
    stores: Array.isArray(s.stores) && s.stores.length > 0 ? s.stores.map(String) : (preset?.stores ?? []),
    space: s.space ?? preset?.space,
    solid: typeof s.solid === "number" ? s.solid : 0.4,
    finest: typeof s.finest === "number" ? s.finest : 0.2,
    threshold: typeof s.threshold === "number" ? s.threshold : (preset?.threshold ?? 0.08),
    cut: s.cut !== false,
    sections: s.sections !== false,
    tracts: s.tracts !== false,
    layout: s.layout,
  };
}

/** Neuroglancer's layout without its 3-D panel. */
export function twoDimensional(layout: unknown): unknown {
  const map: Record<string, string> = { "xy-3d": "xy", "xz-3d": "xz", "yz-3d": "yz", "3d": "xy", "4panel": "xy", "4panel-alt": "xy" };
  return typeof layout === "string" ? (map[layout] ?? layout) : layout === undefined ? "xy" : layout;
}

function hexColour(hex: string): [number, number, number] {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1];
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

const STYLE = `
.vv-host { position: absolute; inset: 0; background: #000; overflow: hidden; }
.vv-host canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.vv-host canvas:active { cursor: grabbing; }
.vv-head { position: absolute; top: 6px; left: 8px; right: 6px; display: flex; align-items: flex-start; gap: 8px; pointer-events: none; }
.vv-bar { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; flex-shrink: 0; max-width: 100%; pointer-events: auto; }
.vv-bar button { height: 24px; padding: 0 8px; border-radius: 0; border: 1px solid #3d3d3d; background: rgba(12,12,12,0.85); color: #ddd; font: 12px/1 var(--ui, sans-serif); cursor: pointer; }
.vv-bar button[aria-pressed="true"] { border-color: #8a8a8a; color: #fff; background: rgba(60,60,60,0.85); }
.vv-status { position: absolute; left: 8px; bottom: 6px; right: 8px; font: 11px/1.4 var(--mono, monospace); color: #9a9a9a; pointer-events: none; text-shadow: 0 0 3px #000; }
.vv-title { flex: 1; min-width: 0; padding-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12px/1 var(--ui, sans-serif); color: #d0d0d0; text-shadow: 0 0 3px #000; }
.vv-panel { display: grid; gap: 10px; }
.vv-panel .row { display: flex; align-items: center; gap: 8px; }
.vv-panel select, .vv-panel textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--line); border-radius: 0; background: var(--ink-0); color: var(--text); font: 12px/1.3 var(--ui); padding: 4px; }
.vv-panel textarea { font: 11px/1.4 var(--mono); min-height: 64px; resize: vertical; }
.vv-panel label.check { display: flex; gap: 8px; align-items: center; font-size: 12px; }
.vv-credit { font-size: 11px; color: var(--faint); margin: 0; }
`;

class VolumeView {
  private saved: Saved;
  private writing = false;
  private client: VolumeClient | undefined;
  private renderer: VolumeRenderer | undefined;
  private levels: LevelInfo[] = [];
  private solid: LevelInfo | undefined;
  private camera: Camera | undefined;
  private cut: [number, number, number] | undefined;
  private unmount: Disposer | undefined;
  private host: HTMLElement | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private statusLine: HTMLElement | undefined;
  private titleLine: HTMLElement | undefined;
  private status = "";
  private opened = "";
  private openToken = 0;
  private dirty = false;
  private interacting = 0;
  private sharpTimer: ReturnType<typeof setTimeout> | undefined;
  private planeTimer: ReturnType<typeof setTimeout> | undefined;
  private planeController: AbortController | undefined;
  private tracts: TrackGroupsService | undefined;
  private tractKeys = new Map<string, string>();
  private tractController: AbortController | undefined;
  private panelHost: HTMLElement | undefined;
  private toggles: (() => void)[] = [];
  private planesKey = "";
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.offs.push(
      ctx.state.onChanged(() => {
        if (this.writing) return;
        this.saved = readSaved(ctx.state.get());
        this.apply();
      }),
      ctx.viewer.onStateChanged(() => this.followPosition()),
    );
    void ctx.services.get<TrackGroupsService>("trackFiltering.groups").then((service) => {
      this.tracts = service;
      this.offs.push(service.onChanged(() => this.updateTracts()));
      this.updateTracts();
    });
    this.apply();
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.hide();
  }

  // -------------------------------------------------------------- state

  private save(patch: Partial<Saved>): void {
    this.saved = { ...this.saved, ...patch };
    this.writing = true;
    try {
      this.ctx.state.set(this.saved);
    } finally {
      this.writing = false;
    }
    this.apply();
  }

  toggle(): void {
    if (this.saved.on) {
      this.save({ on: false });
    } else {
      const stores = this.saved.stores.length > 0 ? {} : { preset: PRESETS[0].id, stores: PRESETS[0].stores, space: PRESETS[0].space };
      this.save({ on: true, ...stores });
    }
  }

  resetCamera(): void {
    this.camera = undefined;
    this.ensureCamera();
    this.request();
  }

  /** Makes the view match the saved state. */
  private apply(): void {
    if (this.saved.on) this.show();
    else this.hide();
    const key = JSON.stringify([this.saved.stores, this.saved.space]);
    if (this.saved.on && key !== this.opened && this.saved.stores.length > 0) {
      this.opened = key;
      void this.openVolume();
    } else if (this.saved.on && this.solid !== undefined && this.solid !== this.chooseSolid()) {
      void this.loadSolid();
    }
    // Sections again only when what they show changed.
    const planes = JSON.stringify([this.saved.cut, this.saved.sections, this.saved.finest, this.saved.solid, this.saved.stores]);
    if (planes !== this.planesKey) {
      this.planesKey = planes;
      this.requestPlanes();
    }
    this.updateTracts();
    this.renderPanel();
    for (const update of this.toggles) update();
    this.request();
  }

  // --------------------------------------------------------------- view

  private show(): void {
    if (this.unmount !== undefined) return;
    // Neuroglancer keeps its 2-D views; the 3-D panel is this one.
    const layout = this.ctx.viewer.getState().layout;
    const flat = twoDimensional(layout);
    if (JSON.stringify(flat) !== JSON.stringify(layout)) {
      this.saved = { ...this.saved, layout };
      this.writing = true;
      try {
        this.ctx.state.set(this.saved);
      } finally {
        this.writing = false;
      }
      this.ctx.viewer.patchState((ng) => {
        ng.layout = flat as Json[string];
      });
    }
    this.unmount = this.ctx.ui.view((host) => this.mount(host));
  }

  private hide(): void {
    if (this.unmount === undefined) return;
    const unmount = this.unmount;
    this.unmount = undefined;
    unmount();
    if (this.saved.layout !== undefined) {
      const layout = this.saved.layout;
      const current = this.ctx.viewer.getState().layout;
      if (JSON.stringify(current) === JSON.stringify(twoDimensional(layout))) {
        this.ctx.viewer.patchState((ng) => {
          ng.layout = layout as Json[string];
        });
      }
    }
  }

  private mount(host: HTMLElement): Disposer {
    const root = el("div", { class: "vv-host" });
    const canvas = el("canvas", { "aria-label": "Volume view" });
    this.titleLine = el("div", { class: "vv-title" });
    this.statusLine = el("div", { class: "vv-status" });
    const toggle = (label: string, key: "cut" | "sections" | "tracts", title: string) => {
      const b = el("button", { type: "button", title, "aria-pressed": String(this.saved[key]), onclick: () => this.save({ [key]: !this.saved[key] }) }, label);
      this.toggles.push(() => b.setAttribute("aria-pressed", String(this.saved[key])));
      return b;
    };
    const bar = el(
      "div",
      { class: "vv-bar" },
      toggle("Cut", "cut", "Cut away the octant facing you at the current position"),
      toggle("Sections", "sections", "Show full-resolution sections on the cut faces"),
      toggle("Tracts", "tracts", "Show the visible track groups"),
      el("button", { type: "button", title: "Reset the camera", onclick: () => this.resetCamera() }, "Reset"),
      el("button", { type: "button", title: "Back to Neuroglancer's 3-D panel", onclick: () => this.save({ on: false }) }, "×"),
    );
    root.append(canvas, el("div", { class: "vv-head" }, this.titleLine, bar), this.statusLine);
    host.append(root);
    this.host = root;
    this.canvas = canvas;
    try {
      this.renderer = new VolumeRenderer(canvas);
    } catch (e) {
      this.setStatus(`Cannot draw: ${(e as Error).message}`);
    }
    // Volume and tracts already loaded go to the new renderer.
    this.tractKeys.clear();
    if (this.solidData !== undefined && this.renderer !== undefined) {
      const { data, size, level } = this.solidData;
      this.renderer.setVolume(data, size, level.voxelToRas, level.voxelSize);
    }
    const resize = new ResizeObserver(() => this.resize());
    resize.observe(root);
    const offInput = this.bindInput(canvas);
    this.resize();
    this.updateTracts();
    this.requestPlanes(true);
    return () => {
      resize.disconnect();
      offInput();
      this.planeController?.abort();
      this.tractController?.abort();
      this.renderer?.dispose();
      this.renderer = undefined;
      this.toggles = [];
      this.canvas = undefined;
      this.host = undefined;
      root.remove();
    };
  }

  private resize(): void {
    const canvas = this.canvas;
    if (canvas === undefined) return;
    // Device pixels, up to 1.5 per CSS pixel: plenty for a ray-marched view.
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    this.request();
  }

  private bindInput(canvas: HTMLCanvasElement): Disposer {
    let last: { x: number; y: number; pan: boolean } | undefined;
    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button !== 0 };
      this.interacting++;
    };
    const move = (e: PointerEvent) => {
      if (last === undefined || this.camera === undefined) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last.x = e.clientX;
      last.y = e.clientY;
      const c = this.camera;
      if (last.pan) {
        // Along the view's right and up directions.
        const right = [-Math.sin(c.yaw), Math.cos(c.yaw), 0];
        const up = [-Math.sin(c.pitch) * Math.cos(c.yaw), -Math.sin(c.pitch) * Math.sin(c.yaw), Math.cos(c.pitch)];
        const k = (c.distance * 0.0012 * 600) / Math.max(200, canvas.clientHeight);
        c.target = c.target.map((v, i) => v - right[i] * dx * k + up[i] * dy * k) as [number, number, number];
      } else {
        c.yaw -= dx * 0.008;
        c.pitch = Math.max(-1.55, Math.min(1.55, c.pitch + dy * 0.008));
      }
      this.request();
    };
    const up = (e: PointerEvent) => {
      if (last === undefined) return;
      last = undefined;
      canvas.releasePointerCapture(e.pointerId);
      this.interacting = Math.max(0, this.interacting - 1);
      this.request();
    };
    const wheel = (e: WheelEvent) => {
      if (this.camera === undefined) return;
      e.preventDefault();
      this.camera.distance = Math.max(10, Math.min(2000, this.camera.distance * Math.exp(e.deltaY * 0.0012)));
      this.interacting++;
      this.request();
      setTimeout(() => {
        this.interacting = Math.max(0, this.interacting - 1);
        this.request();
      }, 120);
    };
    const menu = (e: Event) => e.preventDefault();
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("contextmenu", menu);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("contextmenu", menu);
    };
  }

  /** Draws on the next frame: quickly while the view moves, then sharply. */
  private request(): void {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => {
      this.dirty = false;
      this.draw(this.interacting > 0 ? 0.5 : 1);
      if (this.interacting > 0) {
        if (this.sharpTimer !== undefined) clearTimeout(this.sharpTimer);
        this.sharpTimer = setTimeout(() => this.request(), 160);
      }
    });
  }

  private draw(scale: number): void {
    const renderer = this.renderer;
    if (renderer === undefined || this.canvas === undefined) return;
    this.ensureCamera();
    const camera = this.camera;
    if (camera === undefined) {
      renderer.render({ target: [0, 0, 0], distance: 400, yaw: 0.8, pitch: 0.4 }, this.options(), scale);
      return;
    }
    const before = performance.now();
    renderer.render(camera, this.options(), scale);
    // A slow machine draws at lower resolution while moving anyway.
    void before;
    if (this.titleLine) {
      this.titleLine.textContent = this.title;
      this.titleLine.title = this.title;
    }
    if (this.statusLine) this.statusLine.textContent = this.status;
  }

  private options(): Options {
    return { cut: this.saved.cut ? this.cut : undefined, sections: this.saved.sections, tracts: this.saved.tracts, threshold: this.saved.threshold };
  }

  private ensureCamera(): void {
    if (this.camera !== undefined) return;
    const bounds = this.renderer?.bounds();
    if (bounds === undefined) return;
    const centre = bounds.lo.map((v, k) => (v + bounds.hi[k]) / 2) as [number, number, number];
    const extent = Math.max(...bounds.hi.map((v, k) => v - bounds.lo[k]));
    // From the right, in front and above, so the removed octant faces the camera.
    this.camera = { target: centre, distance: extent * 2.0, yaw: 0.75, pitch: 0.42 };
  }

  private title = "";

  private setStatus(text: string): void {
    this.status = text;
    if (this.statusLine) this.statusLine.textContent = text;
    this.renderPanelStatus();
  }

  // ------------------------------------------------------------- volume

  private solidData: { data: Uint8Array; size: [number, number, number]; level: LevelInfo } | undefined;

  private async openVolume(): Promise<void> {
    const token = ++this.openToken;
    this.client?.dispose();
    this.client = new VolumeClient();
    this.levels = [];
    this.solid = undefined;
    this.solidData = undefined;
    this.renderer?.clearPlanes();
    this.setStatus("Opening the volume…");
    try {
      const opened = await this.client.open(this.saved.stores, this.saved.space);
      if (token !== this.openToken) return;
      this.levels = opened.levels;
      this.title = opened.name;
      if (this.levels.length === 0) throw new Error("the stores hold no image levels");
      this.setStatus(`${this.levels.length} levels, ${this.levels.map((l) => `${Math.round(l.voxelSize * 1000)} µm`).join(", ")}`);
      this.renderPanel();
      await this.loadSolid();
    } catch (e) {
      if (token === this.openToken) this.setStatus(`Could not open the volume: ${(e as Error).message}`);
    }
  }

  /** The finest level at least as coarse as the solid setting. */
  private chooseSolid(): LevelInfo | undefined {
    const wanted = this.saved.solid * 0.95;
    return this.levels.find((l) => l.voxelSize >= wanted) ?? this.levels[this.levels.length - 1];
  }

  private async loadSolid(): Promise<void> {
    const level = this.chooseSolid();
    const client = this.client;
    if (level === undefined || client === undefined) return;
    this.solid = level;
    const index = this.levels.indexOf(level);
    const started = performance.now();
    const label = `${Math.round(level.voxelSize * 1000)} µm`;
    this.setStatus(`Loading the solid (${label})…`);
    const { data, size } = await client.volume(index, (done, total) => this.setStatus(`Loading the solid (${label}): ${done} of ${total} chunks`));
    if (this.solid !== level || this.client !== client) return;
    this.solidData = { data, size, level };
    this.renderer?.setVolume(data, size, level.voxelToRas, level.voxelSize);
    this.setStatus(`Solid ${label} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    this.followPosition(true);
    this.requestPlanes(true);
    this.request();
  }

  // ------------------------------------------------------------ the cut

  /** The viewer's position, in RAS millimetres. */
  private position(): [number, number, number] | undefined {
    const ng = this.ctx.viewer.getState();
    const position = ng.position as number[] | undefined;
    if (!Array.isArray(position) || position.length < 3) return undefined;
    const dims = (ng.dimensions ?? {}) as Record<string, [number, string]>;
    const names = Object.keys(dims);
    const out: number[] = [0, 0, 0];
    for (const [k, axis] of ["x", "y", "z"].entries()) {
      const i = names.indexOf(axis);
      const index = i >= 0 ? i : k;
      const [scale, unit] = dims[axis] ?? [1e-3, "m"];
      out[k] = (position[index] ?? 0) * (unit === "m" ? scale * 1000 : 1);
    }
    return out as [number, number, number];
  }

  private followPosition(force = false): void {
    const p = this.position();
    if (p === undefined) return;
    if (!force && this.cut !== undefined && p.every((v, k) => Math.abs(v - this.cut![k]) < 1e-3)) return;
    this.cut = p;
    this.requestPlanes();
    this.request();
  }

  /** Sections on the cut, coarse to fine, after the cut has stayed put a moment. */
  private requestPlanes(now = false): void {
    if (this.planeTimer !== undefined) clearTimeout(this.planeTimer);
    this.planeTimer = setTimeout(() => void this.loadPlanes(), now ? 0 : 220);
  }

  private async loadPlanes(): Promise<void> {
    this.planeTimer = undefined;
    const renderer = this.renderer;
    const client = this.client;
    const cut = this.cut;
    const solid = this.solid;
    this.planeController?.abort();
    if (renderer === undefined || client === undefined || cut === undefined || solid === undefined || !this.saved.cut || !this.saved.sections) return;
    const controller = new AbortController();
    this.planeController = controller;
    const bounds = rasBounds(solid, solid.shape);
    // From the solid's level to the finest wanted, coarse first.
    const ladder = this.levels.filter((l) => l.voxelSize <= solid.voxelSize * 1.05 && l.voxelSize >= this.saved.finest * 0.95).reverse();
    const started = performance.now();
    try {
      for (const [step, level] of ladder.entries()) {
        const index = this.levels.indexOf(level);
        const label = `${Math.round(level.voxelSize * 1000)} µm`;
        const progress = [0, 0, 0];
        const totals = [0, 0, 0];
        const report = () => this.setStatus(`Sections at ${label}: ${progress.reduce((a, b) => a + b, 0)} of ${totals.reduce((a, b) => a + b, 0)} chunks`);
        await Promise.all(
          [0, 1, 2].map(async (axis) => {
            const [u, v] = [0, 1, 2].filter((k) => k !== axis);
            const rect: [number, number, number, number] = [bounds.lo[u], bounds.hi[u], bounds.lo[v], bounds.hi[v]];
            const result = await client.plane(
              { level: index, axis, value: cut[axis], rect, texel: level.voxelSize },
              {
                signal: controller.signal,
                progress: (done, total) => {
                  progress[axis] = done;
                  totals[axis] = total;
                  report();
                },
                // Partial images only for the first (coarsest) level: a finer one replaces a whole one.
                partial: step === 0 ? (m) => (renderer.setPlane(axis, m.data, m.width, m.height, rect, cut[axis]), this.request()) : undefined,
              },
            );
            if (controller.signal.aborted || this.renderer !== renderer) return;
            renderer.setPlane(axis, result.data, result.width, result.height, rect, cut[axis]);
            this.request();
          }),
        );
      }
      this.setStatus(`Sections at ${Math.round((ladder[ladder.length - 1]?.voxelSize ?? 0) * 1000)} µm in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    } catch (e) {
      if (!controller.signal.aborted) this.setStatus(`Sections: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------- tracts

  private updateTracts(): void {
    const renderer = this.renderer;
    const service = this.tracts;
    if (renderer === undefined || service === undefined) return;
    const wanted = service.list().filter((g) => g.visible && g.exact && g.count > 0);
    const keep = new Set(wanted.map((g) => g.id));
    for (const id of renderer.tractIds()) {
      if (!keep.has(id)) {
        renderer.removeTracts(id);
        this.tractKeys.delete(id);
      }
    }
    for (const group of wanted) {
      const key = `${group.version}`;
      renderer.setTractColour(group.id, hexColour(group.colour));
      if (this.tractKeys.get(group.id) === key) continue;
      this.tractKeys.set(group.id, key);
      // About 1.5 M points a group: a laptop's GPU draws several at once.
      service.curves(group.id, 1_500_000).then(
        (c) => {
          if (this.renderer !== renderer || this.tractKeys.get(group.id) !== key) return;
          renderer.setTracts(group.id, c.positions, c.offsets, hexColour(group.colour));
          this.request();
        },
        (e) => {
          if (this.tractKeys.get(group.id) === key) this.tractKeys.delete(group.id);
          // Given up (the group's dataset closed, or the scene changed), not failed.
          if ((e as DOMException).name === "AbortError") return;
          this.ctx.log.error(`${group.name}: tracts not drawn: ${(e as Error).message}`);
        },
      );
    }
    this.request();
  }

  // -------------------------------------------------------------- panel

  private panelStatus: HTMLElement | undefined;

  render(host: HTMLElement): Disposer {
    this.panelHost = host;
    this.renderPanel();
    return () => {
      this.panelHost = undefined;
      this.panelStatus = undefined;
    };
  }

  /**
   * The solid's level and the finest sections', from the levels the volume
   * has (their voxel sizes in the view's space), or nominal sizes before it
   * is open.
   */
  private levelSelects(select: (label: string, value: number, options: [number, string][], onChange: (v: number) => void) => HTMLElement): HTMLElement[] {
    const s = this.saved;
    const mm = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} mm`;
    if (this.levels.length === 0) {
      return [
        select("Solid", s.solid, [[1, "about 1 mm (lightest)"], [0.4, "about 0.4 mm"]], (v) => this.save({ solid: v })),
        select("Sections down to", s.finest, [[0.4, "about 0.4 mm"], [0.2, "about 0.2 mm"], [0.1, "about 0.1 mm"]], (v) => this.save({ finest: v })),
      ];
    }
    const solid = this.chooseSolid();
    // The solid is held whole on the GPU: levels up to about 64 M voxels.
    const solids = this.levels.filter((l) => l.size[0] * l.size[1] * l.size[2] <= 64e6);
    const finest = this.levels.find((l) => l.voxelSize >= s.finest * 0.95) ?? this.levels[this.levels.length - 1];
    return [
      select("Solid", solid?.voxelSize ?? s.solid, solids.map((l) => [l.voxelSize, `${mm(l.voxelSize)}${l === solids[solids.length - 1] ? " (lightest)" : ""}`]), (v) => this.save({ solid: v })),
      select(
        "Sections down to",
        finest.voxelSize,
        this.levels
          .filter((l) => solid === undefined || l.voxelSize <= solid.voxelSize * 1.05)
          .map((l, i) => [l.voxelSize, `${mm(l.voxelSize)}${i === 0 ? " (finest; the most to download)" : ""}`]),
        (v) => this.save({ finest: v }),
      ),
    ];
  }

  private renderPanelStatus(): void {
    if (this.panelStatus) this.panelStatus.textContent = this.status;
  }

  private renderPanel(): void {
    const host = this.panelHost;
    if (host === undefined) return;
    const s = this.saved;
    const on = el("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Volume view on" }) as HTMLInputElement;
    on.checked = s.on;
    on.addEventListener("change", () => this.toggle());
    const preset = el("select", { "aria-label": "Volume" }) as HTMLSelectElement;
    for (const p of PRESETS) preset.append(el("option", { value: p.id }, p.title));
    preset.append(el("option", { value: "" }, "Other OME-Zarr stores…"));
    preset.value = s.preset ?? (s.stores.length > 0 ? "" : PRESETS[0].id);
    const stores = el("textarea", { "aria-label": "OME-Zarr stores, one per line", spellcheck: "false", hidden: preset.value !== "" }) as HTMLTextAreaElement;
    stores.value = s.stores.join("\n");
    const space = el("input", { class: "text-input", "aria-label": "Coordinate system", placeholder: "coordinate system (e.g. MNI152NLin2009bAsym)", value: s.space ?? "", hidden: preset.value !== "" }) as HTMLInputElement;
    preset.addEventListener("change", () => {
      const p = PRESETS.find((x) => x.id === preset.value);
      if (p) this.save({ preset: p.id, stores: p.stores, space: p.space, threshold: p.threshold ?? 0.08 });
      else {
        stores.hidden = false;
        space.hidden = false;
      }
    });
    const applyCustom = () => this.save({ preset: undefined, stores: stores.value.split(/\s+/).filter(Boolean), space: space.value.trim() || undefined });
    stores.addEventListener("change", applyCustom);
    space.addEventListener("change", applyCustom);
    const select = (label: string, value: number, options: [number, string][], onChange: (v: number) => void) => {
      const sel = el("select", { "aria-label": label }) as HTMLSelectElement;
      for (const [v, t] of options) sel.append(el("option", { value: String(v) }, t));
      sel.value = String(value);
      sel.addEventListener("change", () => onChange(Number(sel.value)));
      return el("label", { class: "field" }, el("span", {}, label), sel);
    };
    const threshold = el("input", { type: "range", min: "0.02", max: "0.6", step: "0.01", value: String(s.threshold), "aria-label": "Tissue threshold" }) as HTMLInputElement;
    threshold.addEventListener("input", () => {
      this.saved = { ...this.saved, threshold: Number(threshold.value) };
      this.request();
    });
    threshold.addEventListener("change", () => this.save({ threshold: Number(threshold.value) }));
    const check = (label: string, key: "cut" | "sections" | "tracts") => {
      const box = el("input", { type: "checkbox" }) as HTMLInputElement;
      box.checked = s[key];
      box.addEventListener("change", () => this.save({ [key]: box.checked }));
      return el("label", { class: "check" }, box, label);
    };
    this.panelStatus = el("p", { class: "note" }, this.status);
    const credit = PRESETS.find((p) => p.id === s.preset)?.credit;
    host.replaceChildren(
      el(
        "div",
        { class: "vv-panel" },
        el("div", { class: "row" }, el("h3", { class: "section-title", style: "margin:0;flex:1" }, "Volume view"), el("label", { class: "switch-label", title: "In place of Neuroglancer's 3-D panel" }, on)),
        el(
          "p",
          { class: "note first" },
          "A solid brain in place of the 3-D panel, cut open at the current position (move it in the 2-D views), with sections on the cut and the visible track groups. Drag to turn, shift-drag to move, scroll to zoom.",
        ),
        el("label", { class: "field" }, el("span", {}, "Volume"), preset),
        stores,
        space,
        ...this.levelSelects(select),
        el("label", { class: "field" }, el("span", {}, "Surface"), threshold),
        check("Cut away the octant facing the camera", "cut"),
        check("Sections on the cut faces", "sections"),
        check("Track groups", "tracts"),
        this.panelStatus,
        credit ? el("p", { class: "vv-credit" }, credit) : null,
      ),
    );
  }
}

export const plugin: PluginModule = {
  activate(ctx) {
    const style = el("style", {}, STYLE);
    document.head.append(style);
    ctx.subscriptions.push(() => style.remove());
    const view = new VolumeView(ctx);
    ctx.subscriptions.push(() => view.dispose());
    ctx.ui.panel(VOLUME_PANEL, (host) => view.render(host));
    ctx.commands.register("volumeView.toggle", () => view.toggle());
    ctx.commands.register("volumeView.resetCamera", () => view.resetCamera());
  },
};
