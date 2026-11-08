/**
 * Anatomical rendering: an OME-Zarr image path-traced on a GPU, shown in
 * Neuroglancer's 3-D view.  The rendering runs in the render service
 * (`runner/ngplatform_render`), on this computer or on one reached over
 * SSH, through a runner; this module keeps a session open there for the
 * chosen image, sends the view whenever the camera or the look changes
 * (at half size while the camera moves), and draws the frames it sends
 * back as they refine (./draw.ts).
 */
import type { Disposer, Frame3d, LayerInfo, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { button, clear, downloadBlob, el, field, numberInput, select } from "@ngplatform/sdk/dom";
import { type Link, linkOf, type MovieInfo, type PresetInfo, RenderService, type ServiceInfo, type SessionInfo, type ViewSpec } from "./client.js";
import { PictureDrawer } from "./draw.js";
import { LocalRenderer, PRESETS as LOCAL_PRESETS } from "./local/local.js";
import { RENDER_PANEL } from "./manifest.js";
import { clipPlanes, type Cut, displayFromPhysical, lightDirection, omeZarrSource, unitMm, viewKey } from "./view.js";

export interface Keyframe {
  time: number;
  view: ViewSpec;
}

export interface Saved {
  on: boolean;
  /** Where frames are rendered: the render service on a host (CUDA), or this browser (WebGPU). */
  where: "host" | "browser";
  layer?: string;
  labels?: string;
  preset: string;
  density?: number;
  exposure: number;
  lightAzimuth: number;
  lightElevation: number;
  cuts: Cut[];
  regions: boolean;
  labelMix: number;
  keep: number[];
  hidden: number[];
  /** Voxels the GPU holds. */
  budget: number;
  maxSamples: number;
  keyframes: Keyframe[];
  movie: { fps: number; width: number; height: number; samples: number };
}

const DEFAULT_CUTS: Cut[] = [
  { axis: "x", keep: -1, offset: 0, on: false },
  { axis: "y", keep: -1, offset: 0, on: false },
  { axis: "z", keep: -1, offset: 0, on: false },
];

export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as Partial<Saved>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const cuts = Array.isArray(s.cuts) && s.cuts.length === 3 ? s.cuts.map((c, i) => ({ ...DEFAULT_CUTS[i], ...c })) : DEFAULT_CUTS.map((c) => ({ ...c }));
  return {
    on: s.on === true,
    where: s.where === "browser" ? "browser" : "host",
    layer: typeof s.layer === "string" ? s.layer : undefined,
    labels: typeof s.labels === "string" ? s.labels : undefined,
    preset: typeof s.preset === "string" ? s.preset : "",
    density: typeof s.density === "number" ? s.density : undefined,
    exposure: num(s.exposure, 1),
    lightAzimuth: num(s.lightAzimuth, 30),
    lightElevation: num(s.lightElevation, 40),
    cuts,
    regions: s.regions === true,
    labelMix: num(s.labelMix, 0.85),
    keep: Array.isArray(s.keep) ? s.keep.filter((x) => typeof x === "number") : [],
    hidden: Array.isArray(s.hidden) ? s.hidden.filter((x) => typeof x === "number") : [],
    budget: num(s.budget, 4e8),
    maxSamples: num(s.maxSamples, 512),
    keyframes: Array.isArray(s.keyframes) ? s.keyframes : [],
    movie: { fps: 25, width: 1280, height: 720, samples: 128, ...(s.movie ?? {}) },
  };
}

/** Where the render service is, kept per browser (not in the link: it holds a token). */
interface HostSetting {
  address: string;
  token: string;
  viaRunner: boolean;
}

const HOST_KEY = "host";

/** A pairing link (`…#runner=<address>&token=<token>`) or an address alone. */
export function parseHostText(text: string): Partial<HostSetting> {
  const t = text.trim();
  const hash = t.includes("#") ? t.slice(t.indexOf("#") + 1) : "";
  if (hash.includes("runner=")) {
    const p = new URLSearchParams(hash);
    return { address: p.get("runner") ?? "", token: p.get("token") ?? "", viaRunner: true };
  }
  return { address: t };
}

class AnatomicalRendering {
  private saved: Saved;
  private host: HostSetting;
  private readonly drawer = new PictureDrawer();
  private handle: { redraw(): void; dispose(): void } | undefined;
  private handleLayer: string | undefined;
  private service: RenderService | undefined;
  private serviceInfo: ServiceInfo | undefined;
  private presets: PresetInfo[] = [];
  private session: SessionInfo | undefined;
  private sessionKey = "";
  private abort: AbortController | undefined;
  private lastKey = "";
  private lastScale = 1;
  private lastFrame: Frame3d | undefined;
  private lastSpec: ViewSpec | undefined;
  private sending = false;
  private queued: ViewSpec | undefined;
  private settle: ReturnType<typeof setTimeout> | undefined;
  private depth: { version: number; width: number; height: number; data: Float32Array } | undefined;
  private frameText = "";
  private problem = "";
  private movie: MovieInfo | undefined;
  private local: LocalRenderer | undefined;
  private localKey = "";
  private localText = "";
  private readonly toggle: { set(value: boolean): void; dispose(): void };
  private panelUpdate: (() => void) | undefined;
  private statusUpdate: (() => void) | undefined;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.host = { address: "http://127.0.0.1:8765", token: "", viaRunner: true, ...(ctx.settings.get<HostSetting>(HOST_KEY) ?? {}) };
    this.drawer.onFrame = (frame) => this.onFrame(frame);
    this.toggle = ctx.ui.viewToggle({ label: "Render", title: "Path-traced rendering (Anatomical rendering)", value: this.saved.on, onChange: (v) => this.setOn(v) });
    this.offs.push(
      ctx.viewer.onLayersChanged(() => this.update()),
      ctx.state.onChanged(() => {
        this.saved = readSaved(ctx.state.get());
        this.update();
      }),
      ctx.commands.register("anatomicalRendering.toggle", () => this.setOn(!this.saved.on)),
      ctx.ui.panel(RENDER_PANEL, (el) => this.panel(el)),
    );
    void this.connect();
  }

  // ------------------------------------------------------------------ state
  private save(edit: (s: Saved) => void): void {
    edit(this.saved);
    this.ctx.state.set({ ...this.saved });
    this.handle?.redraw();
  }

  private setOn(on: boolean): void {
    this.save((s) => (s.on = on));
    this.toggle.set(on);
    if (on) this.ensure3d();
    this.update();
  }

  private ensure3d(): void {
    const layout = JSON.stringify(this.ctx.viewer.getState().layout ?? "");
    if (!/3d|4panel/.test(layout)) this.ctx.viewer.patchState((ng) => void ((ng as { layout?: unknown }).layout = "xy-3d"));
  }

  private images(): LayerInfo[] {
    return this.ctx.viewer.layers().filter((l) => l.type === "image" && omeZarrSource(l.sources[0]) !== undefined);
  }

  private segmentations(): LayerInfo[] {
    return this.ctx.viewer.layers().filter((l) => l.type === "segmentation" && omeZarrSource(l.sources[0]) !== undefined);
  }

  private target(): LayerInfo | undefined {
    const imgs = this.images();
    return imgs.find((l) => l.name === this.saved.layer) ?? imgs[0];
  }

  // ------------------------------------------------------------------ service
  private link(): Link {
    return linkOf(this.host.address, this.host.token, this.host.viaRunner);
  }

  private async connect(): Promise<void> {
    this.service = new RenderService(this.link());
    this.serviceInfo = undefined;
    this.problem = "";
    try {
      this.serviceInfo = await this.service.info(AbortSignal.timeout(8000));
      this.presets = await this.service.presets();
      if (!this.saved.preset && this.presets.length > 0) this.saved.preset = this.presets[0].name;
    } catch (e) {
      this.problem = `No render service at ${this.link().base}: ${(e as Error).message}`;
    }
    this.sessionKey = "";
    this.update();
    this.panelUpdate?.();
  }

  private update(): void {
    const target = this.target();
    const browser = this.saved.where === "browser";
    if (!this.saved.on || target === undefined || (!browser && this.serviceInfo === undefined)) {
      this.handle?.dispose();
      this.handle = undefined;
      this.handleLayer = undefined;
      this.drawer.set(undefined);
      if (!this.saved.on) {
        this.closeSession();
        this.closeLocal();
      }
      this.panelUpdate?.();
      return;
    }
    if (this.handleLayer !== target.name) {
      this.handle?.dispose();
      this.handleLayer = target.name;
      this.handle = this.ctx.viewer.draw3d(target.name, {
        draw: (frame) => this.drawer.draw(frame),
        isReady: () => this.drawer.isReady(),
        dispose: () => undefined,
      });
    }
    if (browser) {
      this.closeSession();
      void this.ensureLocal(target);
    } else {
      this.closeLocal();
      void this.ensureSession(target);
    }
    this.handle?.redraw();
    this.panelUpdate?.();
  }

  private labelsSource(): string | undefined {
    if (!this.saved.regions) return undefined;
    const segs = this.segmentations();
    const l = segs.find((s) => s.name === this.saved.labels) ?? segs[0];
    return l ? omeZarrSource(l.sources[0]) : undefined;
  }

  private async ensureSession(target: LayerInfo): Promise<void> {
    const service = this.service!;
    const url = omeZarrSource(target.sources[0])!;
    const labels = this.labelsSource();
    const key = JSON.stringify([service.link.base, url, labels, this.saved.budget]);
    if (key === this.sessionKey) return;
    this.closeSession();
    this.sessionKey = key;
    const abort = new AbortController();
    this.abort = abort;
    try {
      let info = await service.open({ url, budget: this.saved.budget }, labels ? { url: labels } : undefined);
      this.session = info;
      while (info.status === "loading" && !abort.signal.aborted) {
        this.statusUpdate?.();
        await new Promise((r) => setTimeout(r, 400));
        info = await service.session(info.id);
        this.session = info;
      }
      this.statusUpdate?.();
      if (info.status !== "ready" || abort.signal.aborted) return;
      this.lastKey = "";
      this.handle?.redraw();
      void this.frameLoop(info.id, abort.signal);
    } catch (e) {
      this.problem = (e as Error).message;
      this.statusUpdate?.();
    }
  }

  private async ensureLocal(target: LayerInfo): Promise<void> {
    const url = omeZarrSource(target.sources[0])!;
    const key = JSON.stringify([url, this.saved.budget]);
    if (key === this.localKey) return;
    this.closeLocal();
    this.localKey = key;
    const r = new LocalRenderer();
    this.local = r;
    r.onFrame = (f) => {
      if (this.local !== r) return;
      this.drawer.set({ bitmap: f.bitmap, depth: f.depth });
      this.frameText = `${f.samples} samples, ${f.width}×${f.height}, ${f.msPerPass.toFixed(0)} ms a pass (this browser)`;
      this.handle?.redraw();
      this.statusUpdate?.();
    };
    try {
      this.localText = "Loading in this browser…";
      this.statusUpdate?.();
      this.localText = await r.load(url, Math.min(this.saved.budget, 64e6), (msg) => {
        this.localText = msg;
        this.statusUpdate?.();
      });
      this.lastKey = "";
      this.handle?.redraw();
    } catch (e) {
      this.localText = `This browser cannot render it: ${(e as Error).message}`;
    }
    this.statusUpdate?.();
  }

  private closeLocal(): void {
    this.local?.dispose();
    this.local = undefined;
    this.localKey = "";
    this.localText = "";
  }

  private closeSession(): void {
    this.abort?.abort();
    this.abort = undefined;
    const s = this.session;
    if (s && this.service) void this.service.close(s.id).catch(() => undefined);
    this.session = undefined;
    this.sessionKey = "";
    this.depth = undefined;
    this.drawer.set(undefined);
  }

  private async frameLoop(id: string, signal: AbortSignal): Promise<void> {
    const service = this.service!;
    let after = 0;
    while (!signal.aborted) {
      try {
        const f = await service.frame(id, after, signal);
        if (f === undefined) continue;
        after = f.number;
        if (this.depth === undefined || this.depth.version !== f.version) {
          const d = await service.depth(id);
          if (d !== undefined) this.depth = d;
        }
        this.drawer.set({ bitmap: f.bitmap, depth: this.depth });
        this.frameText = `${f.samples} samples, ${f.width}×${f.height}, ${f.msPerPass.toFixed(0)} ms a pass`;
        this.handle?.redraw();
        this.statusUpdate?.();
      } catch (e) {
        if (signal.aborted) return;
        this.problem = (e as Error).message;
        this.statusUpdate?.();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // ------------------------------------------------------------------ views
  private viewSpec(frame: Frame3d, scale: number): ViewSpec | undefined {
    const wfp = displayFromPhysical(frame.dimensions);
    if (wfp === undefined) {
      this.problem = `The 3-D view shows ${frame.dimensions.names.join(", ")}; rendering needs x, y and z.`;
      return undefined;
    }
    const s = this.saved;
    const overrides: Record<string, number> = { exposure: s.exposure };
    if (s.density !== undefined) overrides.density = s.density;
    return {
      inv_view_projection: Array.from(frame.invViewProjection),
      width: frame.width,
      height: frame.height,
      scale,
      world_from_physical: wfp,
      unit_mm: unitMm(frame.dimensions),
      preset: s.preset || "HiP-CT brain",
      overrides,
      light: { direction: lightDirection(s.lightAzimuth, s.lightElevation), camera_space: true },
      clips: clipPlanes(s.cuts, frame.position, frame.dimensions),
      labels: s.regions ? { show: true, mix: s.labelMix, keep: s.keep, hidden: s.hidden } : { show: false },
      background: [0, 0, 0, 0],
      max_samples: s.maxSamples,
    };
  }

  private onFrame(frame: Frame3d): void {
    this.lastFrame = frame;
    const local = this.saved.where === "browser" ? this.local : undefined;
    const sid = local ? "local" : this.session?.status === "ready" ? this.session.id : undefined;
    if (sid === undefined || (local && !this.localText.startsWith("level"))) return;
    const look = JSON.stringify([this.saved.preset, this.saved.density, this.saved.exposure, this.saved.lightAzimuth, this.saved.lightElevation, this.saved.cuts, this.saved.regions, this.saved.labelMix, this.saved.keep, this.saved.hidden, this.saved.maxSamples, frame.position]);
    const key = viewKey(frame.invViewProjection, frame.width, frame.height) + look;
    const scale = frame.moving ? 0.5 : 1;
    if (key === this.lastKey && !(this.lastScale < 1 && !frame.moving)) return;
    this.lastKey = key;
    this.lastScale = scale;
    const spec = this.viewSpec(frame, scale);
    if (spec === undefined) return;
    if (scale === 1) this.lastSpec = spec;
    this.send(sid, spec);
    clearTimeout(this.settle);
    if (scale < 1) {
      // The camera stopped when no frame comes for a moment: the full-size view then.
      this.settle = setTimeout(() => {
        const f = this.lastFrame;
        if (f === undefined || this.lastScale === 1) return;
        const full = this.viewSpec(f, 1);
        if (full === undefined) return;
        this.lastScale = 1;
        this.lastSpec = full;
        this.send(sid, full);
      }, 250);
    }
  }

  /** One request at a time; the latest view waits for it. */
  private send(sid: string, spec: ViewSpec): void {
    if (sid === "local") {
      this.local?.setView(spec);
      return;
    }
    if (this.sending) {
      this.queued = spec;
      return;
    }
    this.sending = true;
    void this.service!.setView(sid, spec)
      .catch((e) => {
        this.problem = (e as Error).message;
        this.statusUpdate?.();
      })
      .finally(() => {
        this.sending = false;
        const q = this.queued;
        this.queued = undefined;
        if (q !== undefined) this.send(sid, q);
      });
  }

  // ------------------------------------------------------------------ movies
  private addKeyframe(): void {
    const spec = this.lastSpec;
    if (spec === undefined) {
      this.ctx.ui.toast("Render a view first: switch Render on and look at the image in 3-D.", "error");
      return;
    }
    const last = this.saved.keyframes.at(-1)?.time ?? -2;
    this.save((s) => s.keyframes.push({ time: last + 2, view: { ...spec, scale: 1 } }));
    this.panelUpdate?.();
  }

  private async renderMovie(): Promise<void> {
    const sid = this.session?.id;
    if (sid === undefined || this.saved.keyframes.length < 1) return;
    const m = this.saved.movie;
    try {
      let info = await this.service!.movie(sid, { keyframes: this.saved.keyframes, fps: m.fps, width: m.width, height: m.height, samples: m.samples, name: "anatomical-rendering" });
      this.movie = info;
      this.panelUpdate?.();
      while (info.status === "queued" || info.status === "running") {
        await new Promise((r) => setTimeout(r, 1000));
        info = await this.service!.movieInfo(info.id);
        this.movie = info;
        this.statusUpdate?.();
      }
      this.panelUpdate?.();
    } catch (e) {
      this.ctx.ui.toast(`Movie: ${(e as Error).message}`, "error");
    }
  }

  // ------------------------------------------------------------------ panel
  private status(): string {
    const parts: string[] = [];
    const g = this.saved.where === "host" ? this.serviceInfo?.gpu : undefined;
    if (g) parts.push(g.backend === "cuda" ? `GPU: ${g.name} (${Math.round((g.free_mb ?? 0) / 1024)} of ${Math.round((g.total_mb ?? 0) / 1024)} GB free)` : `No GPU: ${g.error ?? ""}`);
    const s = this.session;
    if (s) {
      if (s.status === "loading") parts.push(`Loading: ${s.message} (${Math.round(s.progress * 100)}%)`);
      else if (s.status === "failed") parts.push(`Failed: ${s.error}`);
      else {
        const v = s.volume as SessionInfo["volume"] & { level?: string; made?: boolean; from_cache?: boolean };
        parts.push(`${s.message}${v.made ? (v.from_cache ? " (made here, from the cache)" : " (made here by downsampling)") : ""}`);
      }
    }
    if (this.saved.where === "browser" && this.localText) parts.push(this.localText);
    if (this.frameText) parts.push(this.frameText);
    if (this.movie) parts.push(`Movie: ${this.movie.status} ${Math.round(this.movie.progress * 100)}% ${this.movie.message}${this.movie.error ? ` (${this.movie.error})` : ""}`);
    if (this.problem) parts.push(this.problem);
    return parts.join("\n");
  }

  private panel(host: HTMLElement): Disposer {
    const statusEl = el("pre", { class: "muted", style: "white-space: pre-wrap; font-size: 11px; margin: 6px 0" });
    this.statusUpdate = () => void (statusEl.textContent = this.status());
    const render = () => {
      const s = this.saved;
      const imgs = this.images();
      const segs = this.segmentations();
      const presetList = s.where === "browser" ? LOCAL_PRESETS.map((p) => ({ name: p.name, modality: p.modality ?? "", density: p.density })) : this.presets;
      const presetOptions: [string, string][] = presetList.map((p) => [p.name, p.modality ? `${p.name} (${p.modality})` : p.name]);
      const hostText = el("input", { type: "text", value: this.host.address, style: "width: 100%", title: "The runner's address (or a pairing link), e.g. http://localhost:7000 at the end of an SSH tunnel" }) as HTMLInputElement;
      const tokenText = el("input", { type: "password", value: this.host.token, style: "width: 100%", placeholder: "pairing token" }) as HTMLInputElement;
      const via = el("input", { type: "checkbox" }) as HTMLInputElement;
      via.checked = this.host.viaRunner;
      const applyHost = () => {
        const parsed = parseHostText(hostText.value);
        this.host = { address: parsed.address ?? hostText.value, token: parsed.token ?? tokenText.value, viaRunner: parsed.viaRunner ?? via.checked };
        this.ctx.settings.set(HOST_KEY, this.host);
        void this.connect();
      };
      const cutRow = (i: number) => {
        const c = s.cuts[i];
        const on = el("input", { type: "checkbox" }) as HTMLInputElement;
        on.checked = c.on;
        on.onchange = () => this.save((x) => (x.cuts[i].on = on.checked));
        return el(
          "div",
          { style: "display: flex; gap: 6px; align-items: center" },
          on,
          el("span", {}, `Cut across ${c.axis}`),
          select([["-1", "keep −"], ["1", "keep +"]], String(c.keep), (v) => this.save((x) => (x.cuts[i].keep = Number(v) as 1 | -1))),
          numberInput(c.offset, (v) => this.save((x) => (x.cuts[i].offset = v)), { step: "1", style: "width: 70px", title: "Offset from the position (display units)" }),
        );
      };
      const regions = el("input", { type: "checkbox" }) as HTMLInputElement;
      regions.checked = s.regions;
      regions.onchange = () => this.save((x) => (x.regions = regions.checked));
      const ids = (text: string) => text.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));
      const keyframeRows = s.keyframes.map((k, i) =>
        el(
          "div",
          { style: "display: flex; gap: 6px; align-items: center" },
          el("span", {}, `#${i + 1} at`),
          numberInput(k.time, (v) => this.save((x) => (x.keyframes[i].time = v)), { step: "0.5", style: "width: 60px" }),
          el("span", {}, "s"),
          button("Remove", () => {
            this.save((x) => x.keyframes.splice(i, 1));
            render();
          }),
        ),
      );
      const movie = this.movie;
      clear(
        host,
        el("h3", {}, "Anatomical rendering"),
        el("p", { class: "muted" }, "Path-traced views of an OME-Zarr image, rendered on a GPU through a runner (this computer, or another over SSH)."),
        field("Host", hostText, "The runner's address, or paste its pairing link"),
        field("Token", tokenText),
        el("label", { style: "display: flex; gap: 6px; align-items: center" }, via, "Through a runner (/svc/render)"),
        button("Connect", applyHost),
        el("hr"),
        field("Where", select([["host", "On the host (CUDA, through the runner)"], ["browser", "In this browser (WebGPU)"]], s.where, (v) => {
          this.save((x) => (x.where = v as Saved["where"]));
          this.update();
          render();
        })),
        el("label", { style: "display: flex; gap: 6px; align-items: center" }, (() => {
          const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
          cb.checked = s.on;
          cb.onchange = () => this.setOn(cb.checked);
          return cb;
        })(), el("b", {}, "Render")),
        field("Image", imgs.length ? select(imgs.map((l) => [l.name, l.name]), this.target()?.name ?? "", (v) => this.save((x) => (x.layer = v))) : el("span", { class: "muted" }, "No OME-Zarr image in the scene")),
        field("Preset", presetOptions.length ? select(presetOptions, s.preset, (v) => this.save((x) => (x.preset = v))) : el("span", { class: "muted" }, "(connect first)")),
        field("Density (per mm)", numberInput(s.density ?? Number(this.presets.find((p) => p.name === s.preset)?.density ?? 40), (v) => this.save((x) => (x.density = v)), { step: "1", min: "0" })),
        field("Exposure", numberInput(s.exposure, (v) => this.save((x) => (x.exposure = v)), { step: "0.1", min: "0" })),
        field("Light (azimuth, elevation °)", el("div", { style: "display: flex; gap: 6px" },
          numberInput(s.lightAzimuth, (v) => this.save((x) => (x.lightAzimuth = v)), { step: "10", style: "width: 70px" }),
          numberInput(s.lightElevation, (v) => this.save((x) => (x.lightElevation = v)), { step: "10", style: "width: 70px" }))),
        el("h4", {}, "Cuts (through the position)"),
        cutRow(0), cutRow(1), cutRow(2),
        el("h4", {}, "Regions"),
        el("label", { style: "display: flex; gap: 6px; align-items: center" }, regions, "Colour by a segmentation's regions"),
        segs.length ? field("Segmentation", select(segs.map((l) => [l.name, l.name]), segs.find((x) => x.name === s.labels)?.name ?? segs[0].name, (v) => this.save((x) => (x.labels = v)))) : el("p", { class: "muted" }, "No OME-Zarr segmentation in the scene."),
        field("Region colour", numberInput(s.labelMix, (v) => this.save((x) => (x.labelMix = v)), { step: "0.05", min: "0", max: "1" }), "0: the preset's colours, 1: the regions'"),
        field("Hidden regions", (() => {
          const t = el("input", { type: "text", value: s.hidden.join(", "), placeholder: "label ids" }) as HTMLInputElement;
          t.onchange = () => this.save((x) => (x.hidden = ids(t.value)));
          return t;
        })()),
        field("Kept through cuts", (() => {
          const t = el("input", { type: "text", value: s.keep.join(", "), placeholder: "label ids" }) as HTMLInputElement;
          t.onchange = () => this.save((x) => (x.keep = ids(t.value)));
          return t;
        })()),
        el("h4", {}, "Quality"),
        field("Detail (million voxels on the GPU)", numberInput(s.budget / 1e6, (v) => this.save((x) => (x.budget = Math.max(1, v) * 1e6)), { step: "50", min: "1" })),
        field("Samples per pixel", numberInput(s.maxSamples, (v) => this.save((x) => (x.maxSamples = Math.max(1, Math.round(v)))), { step: "64", min: "1" })),
        el("h4", {}, "Movie"),
        ...keyframeRows,
        button("Add keyframe from the view", () => this.addKeyframe()),
        el("div", { style: "display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px" },
          field("fps", numberInput(s.movie.fps, (v) => this.save((x) => (x.movie.fps = v)), { style: "width: 50px" })),
          field("width", numberInput(s.movie.width, (v) => this.save((x) => (x.movie.width = v)), { style: "width: 70px" })),
          field("height", numberInput(s.movie.height, (v) => this.save((x) => (x.movie.height = v)), { style: "width: 70px" })),
          field("samples", numberInput(s.movie.samples, (v) => this.save((x) => (x.movie.samples = v)), { style: "width: 60px" }))),
        el("div", { style: "display: flex; gap: 6px" },
          button("Render movie on the host", () => void this.renderMovie()),
          movie?.status === "running" ? button("Cancel", () => void this.service?.cancelMovie(movie.id)) : "",
          movie?.status === "done" ? button("Download", () => void this.service!.movieFile(movie.id).then((b) => downloadBlob(b, "anatomical-rendering.mp4"))) : ""),
        statusEl,
      );
      this.statusUpdate?.();
    };
    this.panelUpdate = render;
    render();
    return () => {
      this.panelUpdate = undefined;
      this.statusUpdate = undefined;
    };
  }

  dispose(): void {
    this.closeSession();
    this.handle?.dispose();
    this.drawer.dispose();
    this.toggle.dispose();
    for (const off of this.offs) off();
  }
}

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const r = new AnatomicalRendering(ctx);
    ctx.subscriptions.push(() => r.dispose());
  },
};
