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
import { button, card, clear, downloadBlob, el, field, numberInput, select } from "@ngplatform/sdk/dom";
import { type Distance, hostLink, type Link, type MovieInfo, type PresetInfo, RenderService, ServiceError, type ServiceInfo, type SessionInfo, type SplatInfo, type ViewSpec } from "./client.js";
import { invert4, PictureDrawer } from "./draw.js";
import { clampInt, evenSide, LIMITS, movieSettings, retryDelay, stillProblem, windowStep } from "./limits.js";
import { openSplatWindow, parsePly, parseSplat, type SplatCamera } from "./splatview.js";
import { ColourmapEditor, type DataStop, histogramHandles, shifted, type Tuning, type WarpPoint, warpInverse } from "./editor.js";
import { LocalRenderer, PRESETS as LOCAL_PRESETS } from "./local/local.js";
import { RENDER_PANEL } from "./manifest.js";
import { ANATOMICAL_VIEWS, clipPlanes, type Cut, displayFromPhysical, LIGHTING, lightDirection, omeZarrSource, orientationLooking, unitMm, viewCutPlane, viewForward, viewKey } from "./view.js";

export interface Keyframe {
  time: number;
  view: ViewSpec;
}

export interface Crop {
  name: string;
  on: boolean;
  /** True keeps the inside; false cuts it out. */
  keep: boolean;
  lo: [number, number, number];
  hi: [number, number, number];
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
  /** For "window" presets: the data values at the window's ends, per image (its OME-Zarr store); else the host's guess. */
  windows: Record<string, [number, number]>;
  /** The colourmap tuned for an image (its OME-Zarr store): stops edited over its histogram (data values), shift and compression. */
  tunings: Record<string, Tuning>;
  lightAzimuth: number;
  lightElevation: number;
  /** A light map on the host ("" for the preset's sky colours) and its turn in degrees. */
  lightMap: string;
  lightMapRotation: number;
  /** A lighting style (LIGHTING), or "" for the light map as set; and the light map's and the key light's strength. */
  lightStyle: string;
  envScale: number;
  lightKey: number;
  /** A cut facing the camera, `offset` mm past the position, following the view; or `fixed` where it was left (a display plane). */
  viewCut: { on: boolean; offset: number; fixed: number[] | null };
  cuts: Cut[];
  regions: boolean;
  labelMix: number;
  keep: number[];
  hidden: number[];
  /** Voxels the GPU holds of the whole volume (one level). */
  budget: number;
  /** Finer detail where the view looks: a finer level's region beside the whole volume (on a host), and its voxels. */
  detail: boolean;
  detailBudget: number;
  /** Hide the jar: render only a cylinder about the scan's axis (an organ scanned by HiP-CT in its jar), on the host. */
  jar: boolean;
  maxSamples: number;
  /** Smooth the first frames after the view changes (the host's denoiser). */
  denoise: boolean;
  keyframes: Keyframe[];
  /** Crops: boxes (fractions of the volume along x, y, z), each keeping its inside or cutting it out; what shows is inside any that keeps and in none that cuts out. */
  boxes: Crop[];
  /** Presets loaded from files (as the service takes them). */
  customPresets: Record<string, unknown>[];
  rotation: { axis: "vertical" | "horizontal"; degrees: number; step: number };
  movie: { fps: number; width: number; height: number; samples: number; easing: "smooth" | "linear" };
  /** Gaussian splats: views path-traced from all round (`cover` degrees about the view's direction; 180: every side), their size (the longer side) and samples, and the fit's steps (0: the views only). */
  splat: { views: number; size: number; samples: number; cover: number; steps: number };
}

/** What "Hide the jar" keeps: a cylinder of this fraction of the scan's half width (a HiP-CT jar's wall is at about 0.95). */
const JAR_FRACTION = 0.9;

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
    windows: Object.fromEntries(
      Object.entries(s.windows && typeof s.windows === "object" ? s.windows : {}).filter(
        (e): e is [string, [number, number]] => Array.isArray(e[1]) && e[1].length === 2 && e[1].every((x) => typeof x === "number" && Number.isFinite(x)) && e[1][1] > e[1][0],
      ),
    ),
    tunings: Object.fromEntries(
      Object.entries(s.tunings && typeof s.tunings === "object" ? s.tunings : {})
        .filter((e): e is [string, Tuning] => !!e[1] && typeof e[1] === "object")
        .map(([k, t]) => [k, {
          shift: num(t.shift, 0),
          scale: num(t.scale, 1),
          stops: Array.isArray(t.stops) ? t.stops.filter((x) => x && typeof x.value === "number") : undefined,
          warp: Array.isArray(t.warp) ? t.warp.filter((p) => p && Number.isFinite(p.from) && Number.isFinite(p.to)) : undefined,
        }]),
    ),
    lightAzimuth: num(s.lightAzimuth, 30),
    lightElevation: num(s.lightElevation, 40),
    lightMap: typeof s.lightMap === "string" ? s.lightMap : "",
    lightMapRotation: num(s.lightMapRotation, 0),
    lightStyle: typeof s.lightStyle === "string" ? s.lightStyle : "",
    envScale: num(s.envScale, 1),
    lightKey: num(s.lightKey, 1),
    viewCut: {
      on: s.viewCut?.on === true,
      offset: num(s.viewCut?.offset, 0),
      fixed: Array.isArray(s.viewCut?.fixed) && s.viewCut!.fixed.length === 4 ? s.viewCut!.fixed : null,
    },
    cuts,
    regions: s.regions === true,
    labelMix: num(s.labelMix, 0.85),
    keep: Array.isArray(s.keep) ? s.keep.filter((x) => typeof x === "number") : [],
    hidden: Array.isArray(s.hidden) ? s.hidden.filter((x) => typeof x === "number") : [],
    budget: num(s.budget, 4e8),
    detail: s.detail !== false,
    detailBudget: num(s.detailBudget, 2e8),
    jar: s.jar === true,
    maxSamples: num(s.maxSamples, 512),
    denoise: s.denoise !== false,
    keyframes: Array.isArray(s.keyframes) ? s.keyframes : [],
    boxes: Array.isArray(s.boxes)
      ? s.boxes.filter((b) => b && Array.isArray(b.lo) && Array.isArray(b.hi)).map((b, i) => ({ name: String(b.name ?? `Crop ${i + 1}`), on: b.on !== false, keep: b.keep !== false, lo: b.lo, hi: b.hi }))
      : (s as { box?: { on?: boolean; lo?: [number, number, number]; hi?: [number, number, number] } }).box?.on
        ? [{ name: "Crop 1", on: true, keep: true, lo: (s as { box: { lo?: [number, number, number] } }).box.lo ?? [0, 0, 0], hi: (s as { box: { hi?: [number, number, number] } }).box.hi ?? [1, 1, 1] }]
        : [],
    customPresets: Array.isArray(s.customPresets) ? s.customPresets.filter((p) => p && typeof (p as { name?: unknown }).name === "string") : [],
    rotation: { axis: "vertical", degrees: 360, step: 2, ...(s.rotation ?? {}) },
    movie: { fps: 25, width: 1280, height: 720, samples: 128, easing: "smooth", ...(s.movie ?? {}) },
    splat: { views: 256, size: 1024, samples: 512, cover: 180, steps: 30000, ...(s.splat ?? {}) },
  };
}

/** The platform's command that opens Settings at its computers (pairing, SSH). */
const COMPUTE_SETTINGS = { command: "settings.open", args: { section: "compute" } };

/** A text box of label ids (spaces or commas between). */
function idsInput(ids: number[], on: (ids: number[]) => void): HTMLInputElement {
  const t = el("input", { class: "text-input", type: "text", value: ids.join(", "), placeholder: "label ids" }) as HTMLInputElement;
  t.onchange = () => on(t.value.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n)));
  return t;
}

const STYLE = `
.ar { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 8px 10px; font-size: 12px; }
.ar .card-body { min-width: 0; }
.ar .card-body > * { max-width: 100%; }
.ar-head { display: flex; gap: 10px; align-items: center; min-height: 26px; }
.ar-on { display: flex; gap: 6px; align-items: center; cursor: pointer; }
.ar-status { flex: 1; min-width: 0; color: var(--muted); font: 11px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-status.error { color: var(--err, #e5484d); white-space: normal; }
.ar-views { display: flex; gap: 3px; flex-wrap: wrap; }
.ar .card-body > * + * { margin-top: 6px; }
.ar .card-body h4 { margin: 10px 0 2px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.ar-row { display: flex; gap: 6px; align-items: end; flex-wrap: wrap; }
.ar-row > .field { flex: 1; min-width: 70px; }
.ar-tick { display: flex; gap: 6px; align-items: center; }
.ar-small { font-size: 11px; margin: 0; }
.ar-preview { display: grid; gap: 6px; place-items: center; min-height: 200px; }
.ar-video { width: 100%; max-height: 60vh; background: #000; border-radius: 4px; }
`;

/** A wait that ends early when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  });
}

/** How long the camera is still before the full-size view is rendered. */
const SETTLE_MS = 200;
/** Camera changes closer together than this are one motion (momentum, keys held), not jumps. */
const TURNING_MS = 120;

/** Where a camera is: its eye (display coordinates; none for an orthographic one) and the direction it looks. */
function eyeOf(inv: ArrayLike<number>): { eye?: number[]; forward: number[] } {
  const w = inv[11];
  const forward = viewForward(inv);
  return { eye: Math.abs(w) < 1e-12 ? undefined : [inv[8] / w, inv[9] / w, inv[10] / w], forward };
}

/**
 * Whether the camera now has gone far from the one a picture was rendered
 * from: turned more than 20° about the position, twice as near or far, or
 * the position near the picture's edge.  Then the picture, kept in space,
 * shows too little of the view (its back, its edge) and a new one is
 * wanted even while the camera moves.
 */
export function farFrom(picture: ArrayLike<number>, frame: Pick<Frame3d, "invViewProjection" | "position">): boolean {
  const a = eyeOf(picture), b = eyeOf(frame.invViewProjection);
  const dot = a.forward[0] * b.forward[0] + a.forward[1] * b.forward[1] + a.forward[2] * b.forward[2];
  if (dot < Math.cos((20 * Math.PI) / 180)) return true;
  const p = frame.position;
  if (a.eye && b.eye) {
    const da = Math.hypot(a.eye[0] - p[0], a.eye[1] - p[1], a.eye[2] - p[2]), db = Math.hypot(b.eye[0] - p[0], b.eye[1] - p[1], b.eye[2] - p[2]);
    if (db < da / 2 || db > da * 2) return true;
  }
  // The position as the picture's camera saw it.
  const vp = invert4(picture);
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12], y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13], w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  return !(w > 0) || Math.abs(x / w) > 0.8 || Math.abs(y / w) > 0.8;
}

/** Which paired computer (Settings › Compute, ctx.hosts) renders, kept per browser: none named for Compute's choice. */
interface HostSetting {
  name?: string;
}

const HOST_KEY = "host";
const NO_FFMPEG = "Movies need ffmpeg on the render computer.";
const NO_HOST = "No paired computer has the render service: pair one (Settings › Compute), or render in this browser";

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
  /** The session open on a host, and the service it was opened through (closed through it, whatever computer is chosen next). */
  private opened: { service: RenderService; id: string } | undefined;
  /** Sessions opened again since the last frame, after the host forgot one (it closes those left idle). */
  private reopened = 0;
  private stillRunning = false;
  private sessionKey = "";
  private abort: AbortController | undefined;
  private lastKey = "";
  private lastScale = 1;
  private lastFrame: Frame3d | undefined;
  private lastSpec: ViewSpec | undefined;
  private sending = false;
  /** The view being sent, until the host answers with its version. */
  private pendingView: Promise<void> | undefined;
  private queued: ViewSpec | undefined;
  /** The look (preset, light, cuts…) of the view last sent: a change to it renders at once, moving or not. */
  private lastLook = "";
  /** The camera of the last frame, when it last changed, and whether it was changing frame after frame. */
  private lastCamera = "";
  private cameraChanged = 0;
  private turning = false;
  private settle: ReturnType<typeof setTimeout> | undefined;
  private depth: { version: number; width: number; height: number; data: Float32Array } | undefined;
  private distance: Distance | undefined;
  /** The camera (inverse view-projection, column-major) of each view sent, by the version the host gave it. */
  private views = new Map<number, number[]>();
  private lastCursor: number[] | undefined;

  /** Offsets (mm from the position) that put the cuts through the last point the cursor was over; undefined when there is none. */
  private cursorOffsets(): { axis: number[]; view: number } | undefined {
    const f = this.lastFrame, c = this.lastCursor;
    if (!f || !c) return undefined;
    const mm = unitMm(f.dimensions);
    const d = [0, 1, 2].map((i) => c[i] - f.position[i]);
    const fw = viewForward(f.invViewProjection);
    return { axis: d.map((x) => Math.round(x * mm * 10) / 10), view: Math.round((fw[0] * d[0] + fw[1] * d[1] + fw[2] * d[2]) * mm * 10) / 10 };
  }
  private frameText = "";
  private problem = "";
  private movie: MovieInfo | undefined;
  private splat: SplatInfo | undefined;
  private local: LocalRenderer | undefined;
  private localKey = "";
  private localText = "";
  private readonly toggle: { set(value: boolean): void; dispose(): void };
  private panelUpdate: (() => void) | undefined;
  private statusUpdate: (() => void) | undefined;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.host = { name: ctx.settings.get<HostSetting>(HOST_KEY)?.name || undefined };
    this.drawer.onFrame = (frame) => this.onFrame(frame);
    this.drawer.onFading = () => this.handle?.redraw();
    this.toggle = ctx.ui.viewToggle({ label: "Render", title: "Path-traced rendering (Anatomical rendering)", value: this.saved.on, onChange: (v) => this.setOn(v) });
    this.offs.push(
      ctx.viewer.onLayersChanged(() => this.update()),
      ctx.viewer.onCursorChanged(() => {
        // The last point the cursor was over (in the 3-D view, on the rendered tissue): where a cut starts.
        const c = ctx.viewer.cursor();
        if (c.active && c.position.length >= 3 && c.position.slice(0, 3).every(Number.isFinite)) this.lastCursor = c.position.slice(0, 3);
      }),
      ctx.state.onChanged(() => {
        this.saved = readSaved(ctx.state.get());
        this.update();
      }),
      ctx.commands.register("anatomicalRendering.toggle", () => this.setOn(!this.saved.on)),
      ctx.ui.panel(RENDER_PANEL, (el) => this.panel(el)),
      this.listen("pagehide", () => this.closeSession(true)),
      this.listen("pageshow", (e) => (e as PageTransitionEvent).persisted && this.update()),
      ctx.hosts.onChanged(() => {
        // A computer with the render service paired or come up, or another chosen in Compute.
        const label = this.link()?.label;
        if (!this.connecting && label !== undefined && (this.serviceInfo === undefined || label !== this.service?.link.label)) void this.connect();
        this.panelUpdate?.();
      }),
    );
    void this.connect();
    // For measuring (the drawer's stats) from the console or a test.
    try {
      if (localStorage.getItem("ngplatform.debug")) (window as unknown as { anatomicalRendering: unknown }).anatomicalRendering = this;
    } catch {
      // No storage: no debugging handle.
    }
  }

  private listen(type: string, on: (e: Event) => void): Disposer {
    window.addEventListener(type, on);
    return () => window.removeEventListener(type, on);
  }

  // ------------------------------------------------------------------ state
  private save(edit: (s: Saved) => void): void {
    edit(this.saved);
    this.ctx.state.set({ ...this.saved });
    this.handle?.redraw();
  }

  private setOn(on: boolean): void {
    if (on && this.images().length === 0) {
      // Nothing it can read (precomputed EM, meshes, tractograms): say so rather than switch on to no effect.
      this.toggle.set(false);
      this.ctx.ui.toast("Anatomical rendering needs an OME-Zarr or N5 image in the scene.", "error");
      return;
    }
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
  /** Paired hosts whose runner runs the render service. */
  private renderHosts() {
    return this.ctx.hosts.list().filter((h) => h.info?.services?.render !== undefined);
  }

  /** The chosen computer, else the one Compute picks with the render service ready; undefined when none is paired. */
  private link(): Link | undefined {
    const h = (this.host.name ? this.ctx.hosts.get(this.host.name) : undefined) ?? this.ctx.hosts.pick({ service: "render" });
    return h === undefined ? undefined : hostLink(h.name, h.address, (path, init) => h.fetch(path, init));
  }

  private connecting = false;

  private async connect(): Promise<void> {
    this.connecting = true;
    // The session on the computer used until now goes first (with its GPU memory), through the service it was opened on.
    this.closeSession();
    const link = this.link();
    this.service = link === undefined ? undefined : new RenderService(link);
    this.serviceInfo = undefined;
    this.problem = "";
    try {
      if (this.service === undefined) throw new Error(NO_HOST);
      this.serviceInfo = await this.service.info(AbortSignal.timeout(8000));
      this.presets = await this.service.presets();
      if (!this.saved.preset && this.presets.length > 0) this.saved.preset = this.presets[0].name;
    } catch (e) {
      this.problem = this.service === undefined ? NO_HOST : `No render service on ${this.service.link.label}: ${(e as Error).message}`;
    }
    this.connecting = false;
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

  /** The chosen preset's domain ("percentile", "data" or "window"), as far as the page knows it. */
  private presetDomain(): string | undefined {
    const s = this.saved;
    const custom = s.customPresets.find((p) => p.name === s.preset) as { domain?: unknown } | undefined;
    const d = custom?.domain ?? (s.where === "browser" ? LOCAL_PRESETS.find((p) => p.name === s.preset)?.domain : this.presets.find((p) => p.name === s.preset)?.domain);
    return typeof d === "string" ? d : undefined;
  }

  /** Where a preset's colours came from: the photographs it lists (with their authors and licences). */
  private referenceNote(): HTMLElement | "" {
    const info = this.presets.find((p) => p.name === this.saved.preset);
    const refs = Array.isArray(info?.reference) ? (info!.reference as { title?: string; page?: string; author?: string; licence?: string }[]) : [];
    if (this.saved.where === "browser" || refs.length === 0) return "";
    // The credit, one line: the photographs' names, authors and licences in its tooltip.
    return el(
      "p",
      { class: "muted ar-small", title: refs.map((r) => `${(r.title ?? "a photograph").replace(/^File:/, "")} (${r.author ?? "unknown"}, ${r.licence ?? ""})`).join("\n") },
      "Colours from ",
      ...refs.flatMap((r, i) => [i ? ", " : "", el("a", { href: r.page ?? "#", target: "_blank", rel: "noopener" }, `photo ${i + 1}`)]),
    );
  }

  /** The chosen preset at this image's data values, as the host resolves it (its window, histogram matching): what the editor shows. */
  private resolved: { key: string; preset: Record<string, unknown> } | undefined;
  private editor: ColourmapEditor | undefined;

  private presetRequest(): { key: string; preset: string | Record<string, unknown>; overrides: Record<string, unknown> } | undefined {
    const s = this.saved;
    const src = this.target() ? omeZarrSource(this.target()!.sources[0]) : undefined;
    if (this.session?.status !== "ready" || src === undefined) return undefined;
    const preset = (s.customPresets.find((p) => p.name === s.preset) as Record<string, unknown> | undefined) ?? (s.preset || "HiP-CT brain");
    const overrides: Record<string, unknown> = s.windows[src] && this.presetDomain() === "window" ? { window: s.windows[src] } : {};
    return { key: JSON.stringify([this.session.id, preset, overrides]), preset, overrides };
  }

  /** Ask the host where the chosen preset's stops fall on this image (when that may have changed). */
  private async resolvePreset(): Promise<void> {
    const r = this.presetRequest();
    if (r === undefined || this.resolved?.key === r.key || !this.service) return;
    try {
      const preset = await this.service.resolve(this.session!.id, r.preset, r.overrides);
      this.resolved = { key: r.key, preset };
      this.editorUpdate?.();
      this.lastKey = "";
      this.handle?.redraw();
    } catch {
      // An older host without /resolve: no editor.
    }
  }

  private currentTuning(): { src: string; tuning: Tuning } | undefined {
    const src = this.target() ? omeZarrSource(this.target()!.sources[0]) : undefined;
    if (src === undefined) return undefined;
    return { src, tuning: this.saved.tunings[src] ?? { shift: 0, scale: 1 } };
  }

  /** The stops the editor shows (on the colourmap's axis: as tuned for this image, or as resolved, then shifted and
   * compressed), the histogram's warp, and the stops at the image's values (through the warp): what is sent. */
  private editedStops(): { stops: DataStop[]; base: DataStop[]; centre: number; warp: WarpPoint[]; data: DataStop[] } | undefined {
    const r = this.presetRequest();
    if (!this.resolved || r === undefined || this.resolved.key !== r.key) return undefined;
    const base = (this.resolved.preset.stops as DataStop[]) ?? [];
    const t = this.currentTuning()?.tuning;
    const stops = t?.stops ?? base;
    const vis = base.filter((x) => x.opacity > 0.01);
    const centre = vis.length ? (vis[0].value + vis[vis.length - 1].value) / 2 : 0;
    const shown = shifted(stops, t?.shift ?? 0, t?.scale ?? 1, centre);
    let warp = t?.warp;
    if (!warp) {
      // Not warped yet: handles at the histogram's quantiles over the map's visible range, each where it is.
      const hist = (this.session?.volume as { histogram?: { lo: number; hi: number; counts: number[] } } | undefined)?.histogram;
      warp = hist && vis.length ? histogramHandles(hist, vis[0].value, vis[vis.length - 1].value).map((v) => ({ from: v, to: v })) : [];
    }
    return { stops: shown, base: stops, centre, warp, data: shown.map((x) => ({ ...x, value: warpInverse(x.value, warp) })) };
  }

  /** The preset as tuned for this image (whole, at data values), when it is tuned; else undefined. */
  private tunedPreset(): Record<string, unknown> | undefined {
    const t = this.currentTuning()?.tuning;
    if (!t || (!t.stops && t.shift === 0 && t.scale === 1 && !(t.warp ?? []).some((p) => p.to !== p.from))) return undefined;
    const e = this.editedStops();
    if (!e || !this.resolved) return undefined;
    // Without what only describes it (photographs, measured colours): it goes with every view.
    const { reference: _r, measured: _m, histogram: _h, design_scan: _d, ...rest } = this.resolved.preset;
    return { ...rest, stops: e.data, domain: "data", window: null, histogram: null };
  }

  private editorUpdate: (() => void) | undefined;

  /** The colourmap over the image's histogram, with its control points; shift and compression; per image. */
  private editorField(): HTMLElement | "" {
    if (this.saved.where !== "host") return "";
    const cur = this.currentTuning();
    if (!cur) return "";
    if (!this.editor) {
      this.editor = new ColourmapEditor((stops) => {
        // Edits are kept unshifted, so shift and compression stay apart from them.
        const c = this.currentTuning();
        if (!c) return;
        const e = this.editedStops();
        const scale = c.tuning.scale || 1;
        const unshifted = stops.map((x) => ({ ...x, value: (e ? e.centre : 0) + (x.value - c.tuning.shift - (e ? e.centre : 0)) / scale }));
        this.save((x) => (x.tunings[c.src] = { ...c.tuning, stops: unshifted }));
      }, (warp) => {
        // The histogram slid or warped under the map.
        const c = this.currentTuning();
        if (c) this.save((x) => (x.tunings[c.src] = { ...c.tuning, warp }));
      });
    }
    const hist = (this.session?.volume as { histogram?: { lo: number; hi: number; counts: number[] } } | undefined)?.histogram;
    this.editorUpdate = () => {
      const e = this.editedStops();
      if (e && !this.editor!.dragging) this.editor!.set(hist, e.stops, e.warp);
    };
    this.editorUpdate();
    void this.resolvePreset();
    const t = cur.tuning;
    const width = (() => {
      const e = this.editedStops();
      const vis = e?.base.filter((x) => x.opacity > 0.01) ?? [];
      return vis.length ? vis[vis.length - 1].value - vis[0].value : 1;
    })();
    const set = (f: (t: Tuning) => void) => {
      this.save((x) => {
        const n = { ...(x.tunings[cur.src] ?? { shift: 0, scale: 1 }) };
        f(n);
        x.tunings[cur.src] = n;
      });
      this.editorUpdate?.();
    };
    const slider = (value: number, min: number, max: number, step: number, on: (v: number) => void, title: string) => {
      const r = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), style: "width: 130px", title }) as HTMLInputElement;
      r.oninput = () => on(Number(r.value));
      return r;
    };
    return el(
      "div",
      { style: "margin: 6px 0" },
      el("div", { class: "muted ar-small", style: "margin-bottom: 3px", title: "Drag a point: left-right moves it, up-down its opacity. Double-click colours it, Ctrl-click adds one, right-click removes one. The blue triangles under the histogram slide and warp it under the colours." }, "Colourmap ⓘ"),
      this.editor.element,
      el(
        "div",
        { style: "display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 4px" },
        el("label", {}, "Shift ", slider(width ? t.shift / width : 0, -1, 1, 0.01, (v) => set((n) => (n.shift = v * width)), "Move the whole map along the values (a fraction of its width)")),
        el("label", {}, "Compress ", slider(t.scale, 0.4, 2.5, 0.01, (v) => set((n) => (n.scale = v)), "Narrow (below 1) or widen (above 1) the map about its middle")),
        button("Reset", () => {
          this.save((x) => delete x.tunings[cur.src]);
          this.editorUpdate?.();
        }, "Back to the preset as it falls on this image"),
        button("Save as a preset file", () => {
          const p = this.tunedPreset() ?? this.resolved?.preset;
          if (!p) return;
          const name = `${String(p.name ?? "preset")} (tuned)`;
          downloadBlob(new Blob([JSON.stringify([{ ...p, name }], null, 1)], { type: "application/json" }), "preset.json");
        }, "The map as tuned, at this image's values (load it with Load a preset file…)"),
      ),
    );
  }

  /** A crop: on, its name, keep or cut out, remove; its box's low and high along x, y and z (fractions of the volume). */
  private cropRow(b: Crop, i: number, render: () => void): HTMLElement {
    const on = el("input", { type: "checkbox" }) as HTMLInputElement;
    on.checked = b.on;
    on.onchange = () => this.save((x) => (x.boxes[i].on = on.checked));
    const name = el("input", { type: "text", value: b.name, style: "width: 90px" }) as HTMLInputElement;
    name.onchange = () => this.save((x) => (x.boxes[i].name = name.value));
    const axis = (k: number, label: string) =>
      el("div", { style: "display: flex; gap: 4px; align-items: center" },
        el("span", { style: "width: 12px" }, label),
        this.slider(b.lo[k], 0, 1, 0.005, (v) => this.save((x) => (x.boxes[i].lo[k] = Math.min(v, x.boxes[i].hi[k] - 0.005))), `Low ${label}`),
        this.slider(b.hi[k], 0, 1, 0.005, (v) => this.save((x) => (x.boxes[i].hi[k] = Math.max(v, x.boxes[i].lo[k] + 0.005))), `High ${label}`));
    return el("div", { style: "border-left: 3px solid #4a7; padding-left: 6px; margin: 4px 0" },
      el("div", { style: "display: flex; gap: 6px; align-items: center" },
        on, name,
        select([["keep", "keep inside"], ["cut", "cut out"]], b.keep ? "keep" : "cut", (v) => this.save((x) => (x.boxes[i].keep = v === "keep"))),
        button("Remove", () => {
          this.save((x) => x.boxes.splice(i, 1));
          render();
        })),
      axis(0, "x"), axis(1, "y"), axis(2, "z"));
  }

  /** A slider and its number, kept together; `live` false: the slider applies when let go (a change that reopens the session). */
  private sliderNum(value: number, min: number, max: number, step: number, on: (v: number) => void, opts: { live?: boolean; title?: string; width?: string } = {}): HTMLElement {
    const r = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), style: `width: ${opts.width ?? "120px"}`, title: opts.title ?? "" }) as HTMLInputElement;
    const n = numberInput(value, (v) => {
      r.value = String(v);
      on(v);
    }, { step: String(step), style: "width: 64px", title: opts.title ?? "" });
    const apply = () => {
      n.value = r.value;
      on(Number(r.value));
    };
    if (opts.live === false) {
      r.oninput = () => (n.value = r.value);
      r.onchange = apply;
    } else {
      r.oninput = apply;
    }
    return el("div", { style: "display: flex; gap: 6px; align-items: center" }, r, n);
  }

  private slider(value: number, min: number, max: number, step: number, on: (v: number) => void, title: string): HTMLInputElement {
    const r = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), style: "width: 110px", title }) as HTMLInputElement;
    r.oninput = () => on(Number(r.value));
    return r;
  }

  /** A "window" preset's control: the data values at its ends for this image, the host's guess until set. */
  private windowField(): HTMLElement | "" {
    if (this.presetDomain() !== "window") return "";
    if (this.saved.where === "browser") return "";
    const target = this.target();
    const src = target ? omeZarrSource(target.sources[0]) : undefined;
    if (src === undefined) return "";
    const vol = this.session?.volume as { window?: [number, number] | null; lo?: number; hi?: number; dtype?: string } | undefined;
    const guess = vol?.window ?? undefined;
    const w = this.saved.windows[src] ?? guess;
    const set = (i: 0 | 1, v: number) =>
      this.save((x) => {
        const cur = x.windows[src] ?? guess ?? [v, v + 1];
        const next: [number, number] = [cur[0], cur[1]];
        next[i] = v;
        if (next[1] > next[0]) x.windows[src] = next;
      });
    const step = vol && vol.hi !== undefined && vol.lo !== undefined ? String(windowStep(vol.lo, vol.hi, vol.dtype)) : "1";
    return field(
      "Window (low, high)",
      el(
        "div",
        { style: "display: flex; gap: 6px; align-items: center" },
        this.sliderNum(w ? w[0] : 0, vol?.lo ?? 0, vol?.hi ?? 65535, Number(step), (v) => set(0, v), { title: "Low end", width: "90px" }),
        this.sliderNum(w ? w[1] : 1, vol?.lo ?? 0, vol?.hi ?? 65535, Number(step), (v) => set(1, v), { title: "High end", width: "90px" }),
        button("Guess", () => this.save((x) => delete x.windows[src]), "Back to the host's guess: from just past the mounting medium, with the commonest tissue value at the middle"),
      ),
    );
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
    const detailBudget = this.saved.detail ? this.saved.detailBudget : 0;
    const key = JSON.stringify([service.link.base, url, labels, this.saved.budget, this.saved.jar, detailBudget]);
    if (key === this.sessionKey) return;
    this.closeSession();
    this.sessionKey = key;
    const abort = new AbortController();
    this.abort = abort;
    try {
      let info = await service.open({ url, budget: this.saved.budget, detail_budget: detailBudget, ...(this.saved.jar ? { cylinder: JAR_FRACTION } : {}) }, labels ? { url: labels } : undefined);
      if (abort.signal.aborted) {
        // Another image (or detail) was asked for while this one was opening: it is not wanted.
        void service.close(info.id).catch(() => undefined);
        return;
      }
      this.opened = { service, id: info.id };
      this.session = info;
      while (info.status === "loading" && !abort.signal.aborted) {
        this.statusUpdate?.();
        await new Promise((r) => setTimeout(r, 400));
        info = await service.session(info.id);
        if (abort.signal.aborted) break;
        this.session = info;
      }
      this.statusUpdate?.();
      if (info.status !== "ready" || abort.signal.aborted) return;
      await this.resolvePreset();
      this.lastKey = "";
      this.handle?.redraw();
      void this.frameLoop(service, info.id, abort.signal);
    } catch (e) {
      if (abort.signal.aborted) return;
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
      this.localText = "";
      this.problem = `This browser cannot render it: ${(e as Error).message}`;
    }
    this.statusUpdate?.();
  }

  private closeLocal(): void {
    this.local?.dispose();
    this.local = undefined;
    this.localKey = "";
    this.localText = "";
  }

  /** Closes the session on its host (`keepalive`: as the page closes) and forgets what belonged to it. */
  private closeSession(keepalive = false): void {
    this.abort?.abort();
    this.abort = undefined;
    const o = this.opened;
    if (o) void o.service.close(o.id, keepalive).catch(() => undefined);
    this.opened = undefined;
    this.session = undefined;
    this.sessionKey = "";
    // A new session numbers its views from 0 again: no camera, distances or view of this one may place its frames.
    this.views.clear();
    this.distance = undefined;
    this.depth = undefined;
    this.queued = undefined;
    this.lastKey = "";
    this.lastLook = "";
    this.lastScale = 1;
    this.frameText = "";
    clearTimeout(this.settle);
    this.drawer.set(undefined);
  }

  /** After an error: connect again when the computer did not answer, else open the session (or the browser's renderer) again. */
  private retry(): void {
    this.problem = "";
    this.reopened = 0;
    if (this.saved.where === "browser") {
      this.closeLocal();
      this.update();
    } else if (this.serviceInfo === undefined) {
      void this.connect();
    } else {
      this.closeSession();
      this.update();
    }
    this.statusUpdate?.();
  }

  /** The host no longer knows the session (closed when idle, or the service started again): opened again once, then left to Retry. */
  private sessionLost(): void {
    if (this.reopened >= 1) {
      this.problem = "The render computer closed the session.";
      this.statusUpdate?.();
      return;
    }
    this.reopened += 1;
    this.opened = undefined;
    this.closeSession();
    this.update();
  }

  /** The session failed on the host (out of GPU memory): its error shown, and nothing more asked of it. */
  private async sessionFailed(service: RenderService, id: string, message: string): Promise<void> {
    const info = await service.session(id).catch(() => undefined);
    if (this.opened?.id !== id) return;
    if (info?.status === "failed") this.session = info;
    else this.problem = message;
    this.drawer.set(undefined);
    this.handle?.redraw();
    this.statusUpdate?.();
  }

  private async frameLoop(service: RenderService, id: string, signal: AbortSignal): Promise<void> {
    let after = 0;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const f = await service.frame(id, after, signal, this.distance?.version ?? -1);
        if (failures > 0) {
          failures = 0;
          this.problem = "";
          this.statusUpdate?.();
        }
        if (f === undefined) continue;
        this.reopened = 0;
        // A frame came: an error from before (a view not sent, a poll that failed) is over.
        this.problem = "";
        after = f.number;
        if (f.distance !== undefined) this.distance = f.distance;
        // A frame may come before the answer to the view it was rendered from: wait for that answer.
        let cam = this.views.get(f.version);
        if (cam === undefined && this.pendingView !== undefined) {
          await this.pendingView;
          cam = this.views.get(f.version);
        }
        if (cam !== undefined && this.distance?.version !== f.version) {
          const dist = await service.distance(id).catch(() => undefined);
          if (dist !== undefined) this.distance = dist;
        }
        // With the camera it was rendered from and each pixel's distance, the frame is a surface in space:
        // it turns and zooms with the view, not only when the next frame comes.
        const view = cam && this.distance && this.distance.version === f.version ? { invViewProjection: cam, distance: this.distance } : undefined;
        if (view === undefined) {
          // Not placed in space: never in place of a picture that is (it would stick to the screen as the
          // camera moves); drawn flat only from a host that gives no distances.
          if (this.drawer.placed() !== undefined) continue;
          if (this.depth === undefined || this.depth.version !== f.version) {
            const d = await service.depth(id);
            if (d !== undefined) this.depth = d;
          }
        }
        this.drawer.set({ bitmap: f.bitmap, alpha: f.alpha ? { width: f.width, height: f.height, data: f.alpha } : undefined, depth: view ? undefined : this.depth, view });
        this.frameText = `${f.samples} samples, ${f.width}×${f.height}, ${f.msPerPass.toFixed(0)} ms a pass${f.detail ? `\nDetail: ${f.detail}` : ""}`;
        this.handle?.redraw();
        this.statusUpdate?.();
      } catch (e) {
        if (signal.aborted) return;
        const status = e instanceof ServiceError ? e.status : 0;
        if (status === 404) return this.sessionLost();
        if (status === 410) return void this.sessionFailed(service, id, (e as Error).message);
        // Anything else (the computer not answering): asked again less and less often, then given up and said so.
        const wait = retryDelay(++failures);
        this.problem = wait === undefined
          ? `Lost touch with ${service.link.label ?? "the render computer"}: ${(e as Error).message}`
          : `${(e as Error).message} (trying again in ${Math.round(wait / 1000)} s)`;
        this.statusUpdate?.();
        if (wait === undefined) return;
        await sleep(wait, signal);
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
    const overrides: Record<string, number | number[]> = { exposure: s.exposure };
    if (s.density !== undefined) overrides.density = s.density;
    const src = this.target() ? omeZarrSource(this.target()!.sources[0]) : undefined;
    if (src !== undefined && s.windows[src] && this.presetDomain() === "window") overrides.window = s.windows[src];
    const tuned = this.tunedPreset();
    return {
      inv_view_projection: Array.from(frame.invViewProjection),
      width: frame.width,
      height: frame.height,
      scale,
      world_from_physical: wfp,
      orbit_center: Array.from(frame.position),
      unit_mm: unitMm(frame.dimensions),
      preset: tuned ?? (s.customPresets.find((p) => p.name === s.preset) as Record<string, unknown> | undefined) ?? (s.preset || "HiP-CT brain"),
      overrides: tuned ? { exposure: s.exposure, ...(s.density !== undefined ? { density: s.density } : {}) } : overrides,
      boxes: s.boxes.filter((b) => b.on).map((b) => ({ lo: b.lo, hi: b.hi, keep: b.keep })),
      light: { direction: lightDirection(s.lightAzimuth, s.lightElevation), camera_space: true, rgb: [3.2 * s.lightKey, 3.0 * s.lightKey, 2.8 * s.lightKey] },
      environment: s.lightMap ? { map: s.lightMap, rotation: s.lightMapRotation, scale: s.envScale } : { scale: s.envScale },
      clips: [
        ...clipPlanes(s.cuts, frame.position, frame.dimensions),
        ...(s.viewCut.on ? [s.viewCut.fixed ?? viewCutPlane(frame.invViewProjection, frame.position, s.viewCut.offset, frame.dimensions)] : []),
      ] as [number, number, number, number][],
      labels: s.regions ? { show: true, mix: s.labelMix, keep: s.keep, hidden: s.hidden } : { show: false },
      background: [0, 0, 0, 0],
      max_samples: s.maxSamples,
      denoise: s.denoise,
      frame_format: "jpeg",
    };
  }

  private onFrame(frame: Frame3d): void {
    this.lastFrame = frame;
    const local = this.saved.where === "browser" ? this.local : undefined;
    const sid = local ? "local" : this.session?.status === "ready" ? this.session.id : undefined;
    if (sid === undefined || (local && !this.localText.startsWith("level"))) return;
    const look = JSON.stringify([this.saved.boxes, this.saved.customPresets.length, this.saved.preset, this.saved.density, this.saved.exposure, this.saved.windows, this.saved.tunings, this.resolved?.key, this.saved.lightAzimuth, this.saved.lightElevation, this.saved.lightMap, this.saved.lightMapRotation, this.saved.lightStyle, this.saved.envScale, this.saved.lightKey, this.saved.viewCut, this.saved.cuts, this.saved.regions, this.saved.labelMix, this.saved.keep, this.saved.hidden, this.saved.maxSamples, this.saved.denoise, frame.position]);
    const camera = viewKey(frame.invViewProjection, frame.width, frame.height);
    // Moving: Neuroglancer's drag or wheel, or the camera changing frame after frame without them (the
    // 3-D view's momentum after a drag, keys held down); a single jump (a view button) is not.
    const now = performance.now();
    if (camera !== this.lastCamera) {
      this.turning = now - this.cameraChanged < TURNING_MS;
      this.lastCamera = camera;
      this.cameraChanged = now;
    }
    const moving = frame.moving || (this.turning && now - this.cameraChanged < TURNING_MS);
    const key = camera + look;
    const scale = moving ? 0.5 : 1;
    if (key === this.lastKey && !(this.lastScale < 1 && !moving)) return;
    const sameLook = look === this.lastLook;
    this.lastKey = key;
    this.lastLook = look;
    this.lastScale = scale;
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
      }, SETTLE_MS);
    }
    // While the camera moves, the picture shown stays in space (a surface drawn with the camera now) and
    // nothing is rendered until it stops; only a view gone far from the picture's gets a quick half-size one.
    const placed = this.drawer.placed();
    if (moving && sameLook && placed !== undefined && !farFrom(placed, frame)) return;
    const spec = this.viewSpec(frame, scale);
    if (spec === undefined) return;
    if (scale === 1) this.lastSpec = spec;
    this.send(sid, spec);
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
    this.pendingView = this.opened!.service.setView(sid, spec)
      .then((r) => {
        if (this.opened?.id !== sid) return;
        this.views.set(r.version, spec.inv_view_projection);
        for (const k of this.views.keys()) if (k < r.version - 64) this.views.delete(k);
      })
      .catch((e) => {
        if (this.opened?.id !== sid) return;
        this.problem = (e as Error).message;
        this.statusUpdate?.();
      })
      .finally(() => {
        this.sending = false;
        this.pendingView = undefined;
        const q = this.queued;
        this.queued = undefined;
        // A view queued since is for the session open now (closing one drops what was queued for it).
        const now = this.session?.status === "ready" ? this.session.id : undefined;
        if (q !== undefined && now !== undefined) this.send(now, q);
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

  /** The view now, full size, for a still, a rotation or a keyframe. */
  private currentSpec(): ViewSpec | undefined {
    const f = this.lastFrame;
    return f ? this.viewSpec(f, 1) : this.lastSpec;
  }

  /** Moves the view to the middle of the tissue and zooms to show all of it. */
  private centreOnTissue(): void {
    const box = (this.session?.volume as { tissue_mm?: [number[], number[]] | null } | undefined)?.tissue_mm;
    const f = this.lastFrame;
    if (!box || f === undefined) {
      this.ctx.ui.toast("Render first: the tissue's box comes with the rendered image.", "error");
      return;
    }
    const m = displayFromPhysical(f.dimensions);
    if (m === undefined) return;
    const toDisplay = (p: number[]) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    const a = toDisplay(box[0]), b = toDisplay(box[1]);
    const centre = a.map((v, i) => (v + b[i]) / 2);
    const size = Math.max(...a.map((v, i) => Math.abs(b[i] - v)));
    this.ctx.viewer.patchState((ng) => {
      const s = ng as { position?: number[]; projectionScale?: number };
      const pos = Array.isArray(s.position) ? s.position.slice() : [0, 0, 0];
      for (let i = 0; i < 3; ++i) pos[i] = centre[i];
      s.position = pos;
      s.projectionScale = size * 1.4;
    });
  }

  /** The view now at the output's size and twice its samples, as a job on the host (progress and cancelling in Activity); saved as a download. */
  private async saveStill(): Promise<void> {
    const sid = this.session?.status === "ready" ? this.session.id : undefined;
    const service = this.opened?.service;
    const view = this.currentSpec();
    if (sid === undefined || service === undefined || view === undefined) return this.ctx.ui.toast("Render a view on a computer first.", "error");
    if (this.stillRunning) return this.ctx.ui.toast("A still is already rendering: see Activity.", "error");
    const m = movieSettings(this.saved.movie);
    const samples = Math.min(LIMITS.maxSamples, m.samples * 2);
    const tooLarge = stillProblem(m.width, m.height, samples);
    if (tooLarge) return this.ctx.ui.toast(tooLarge, "error");
    this.stillRunning = true;
    this.panelUpdate?.();
    try {
      await this.ctx.jobs.run(`Still: ${m.width} × ${m.height}, ${samples} samples`, async (job) => {
        let info = await service.still(sid, { view, width: m.width, height: m.height, samples, name: "anatomical-rendering" });
        while (info.status === "queued" || info.status === "running") {
          if (job.cancelled) await service.cancelStill(info.id).catch(() => undefined);
          job.progress(info.progress, info.message);
          await sleep(500);
          info = await service.stillInfo(info.id);
        }
        if (info.status !== "done") throw new Error(info.error ?? info.status);
        downloadBlob(await service.stillFile(info.id), "anatomical-rendering.png");
      });
    } catch (e) {
      this.ctx.ui.toast(`Still: ${(e as Error).message}`, "error");
    } finally {
      this.stillRunning = false;
      this.panelUpdate?.();
    }
  }

  private async renderRotation(): Promise<void> {
    const view = this.currentSpec();
    if (view === undefined) return;
    const r = this.saved.rotation;
    this.renderMovie({ keyframes: [{ time: 0, view: { ...view, scale: 1 } }], rotation: r, name: `rotation-${r.axis}-${r.degrees}` });
  }

  private loadPresetFile(): void {
    const input = el("input", { type: "file", accept: ".json,application/json" }) as HTMLInputElement;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const list = (Array.isArray(data) ? data : [data]).filter((p) => p && typeof p.name === "string" && Array.isArray(p.stops));
        if (list.length === 0) throw new Error("no preset in it (a preset has a name and stops)");
        this.save((x) => {
          const names = new Set(list.map((p: { name: string }) => p.name));
          x.customPresets = [...x.customPresets.filter((p) => !names.has(p.name as string)), ...list];
          x.preset = list[0].name;
        });
        this.panelUpdate?.();
      } catch (e) {
        this.ctx.ui.toast(`Preset file: ${(e as Error).message}`, "error");
      }
    };
    input.click();
  }

  /** The movie's request: the keyframes (or `extra`'s, a rotation), at the movie's size and samples, or `small` for a preview. */
  private movieSpec(extra: Record<string, unknown> | undefined, small: boolean): Record<string, unknown> {
    const m = movieSettings(this.saved.movie);
    const spec: Record<string, unknown> = { keyframes: this.saved.keyframes, fps: m.fps, width: m.width, height: m.height, samples: m.samples, easing: m.easing, name: "anatomical-rendering", ...(extra ?? {}) };
    if (!small) return spec;
    // A quick look: about 384 pixels on the longer side, few samples, fewer frames.
    const k = 384 / Math.max(m.width, m.height, 1);
    const even = (v: number) => Math.max(16, 2 * Math.round((v * Math.min(1, k)) / 2));
    const rotation = extra?.rotation as { step?: number } | undefined;
    return {
      ...spec,
      width: even(m.width),
      height: even(m.height),
      samples: Math.min(8, m.samples),
      fps: Math.min(12, m.fps),
      crf: 30,
      name: "preview",
      ...(rotation ? { rotation: { ...rotation, step: Math.max(6, (rotation.step ?? 2) * 3) } } : {}),
    };
  }

  /**
   * A movie (the keyframes', or `extra`'s rotation): first a small, quick
   * preview in a window, played over and over; from there, the movie itself
   * as a job (its progress in the Jobs tab) while the view stays live.
   */
  private renderMovie(extra?: Record<string, unknown>): void {
    const sid = this.session?.id;
    const service = this.service;
    if (sid === undefined || service === undefined) return this.ctx.ui.toast("Connect to a computer and switch Render on first.", "error");
    if (extra === undefined && this.saved.keyframes.length < 2) return this.ctx.ui.toast("Add two keyframes or more first.", "error");
    if (this.serviceInfo?.ffmpeg === false) return this.ctx.ui.toast(NO_FFMPEG, "error");
    const m = movieSettings(this.saved.movie);
    let preview: MovieInfo | undefined;
    let url: string | undefined;
    this.ctx.ui.sheet("Movie preview", (body, close) => {
      const bar = el("progress", { max: "1", value: "0", style: "width: 100%" }) as HTMLProgressElement;
      const note = el("span", { class: "muted ar-small" }, "Rendering a preview…");
      const stage = el("div", { class: "ar-preview" }, bar, note);
      const go = button(`Render the movie (${m.width}×${m.height}, ${m.samples} samples)`, () => {
        close();
        void this.movieJob(sid, this.movieSpec(extra, false));
      }, "In the background: its progress is in Jobs; the view stays live", "btn primary");
      body.append(stage, el("div", { class: "ar-row" }, go));
      let open = true;
      void (async () => {
        try {
          preview = await service.movie(sid, this.movieSpec(extra, true));
          while (open && (preview.status === "queued" || preview.status === "running")) {
            bar.value = preview.progress;
            note.textContent = preview.message || "Rendering a preview…";
            await new Promise((r) => setTimeout(r, 400));
            preview = await service.movieInfo(preview.id);
          }
          if (!open) return;
          if (preview.status !== "done") throw new Error(preview.error ?? preview.status);
          url = URL.createObjectURL(await service.movieFile(preview.id));
          if (!open) return;
          stage.replaceChildren(el("video", { src: url, autoplay: true, loop: true, muted: true, playsinline: true, controls: true, class: "ar-video" }));
        } catch (e) {
          if (open) stage.replaceChildren(el("p", { class: "note error" }, `The preview failed: ${(e as Error).message}`));
        }
      })();
      return () => {
        open = false;
        if (preview && (preview.status === "queued" || preview.status === "running")) void service.cancelMovie(preview.id).catch(() => undefined);
        if (url) URL.revokeObjectURL(url);
      };
    }, { wide: true });
  }

  /** The movie as a job: progress and cancelling in the Jobs tab; saved as a download when done. */
  private async movieJob(sid: string, spec: Record<string, unknown>): Promise<void> {
    const service = this.service!;
    const name = String(spec.name ?? "movie");
    try {
      await this.ctx.jobs.run(`Movie: ${name}`, async (job) => {
        let info = await service.movie(sid, spec);
        this.movie = info;
        this.panelUpdate?.();
        while (info.status === "queued" || info.status === "running") {
          if (job.cancelled) await service.cancelMovie(info.id).catch(() => undefined);
          job.progress(info.progress, info.message);
          await new Promise((r) => setTimeout(r, 1000));
          info = await service.movieInfo(info.id);
          this.movie = info;
          this.statusUpdate?.();
        }
        this.panelUpdate?.();
        if (info.status !== "done") throw new Error(info.error ?? info.status);
        downloadBlob(await service.movieFile(info.id), `${name}.mp4`);
      });
    } catch (e) {
      this.ctx.ui.toast(`Movie: ${(e as Error).message}`, "error");
    }
  }

  // ------------------------------------------------------------------ splats
  /**
   * Gaussian splats of the view on the host: the view's look (preset, colours, light held where it is,
   * cuts, crops) path-traced from all round it, then fitted; a job in the Jobs tab while it runs.
   */
  private async makeSplat(): Promise<void> {
    const sid = this.session?.id;
    const view = this.currentSpec();
    if (sid === undefined || view === undefined || this.service === undefined) {
      this.ctx.ui.toast("Render a view on a computer first: the splat is made from it.", "error");
      return;
    }
    const sp = this.saved.splat;
    const fit = this.serviceInfo?.splats;
    if (sp.steps > 0 && fit && !fit.ready) {
      const ok = await this.ctx.ui.confirm(`This computer cannot fit splats (${fit.error ?? "no splat Python"}). Render the ${sp.views} views only? They can be fitted later on a computer that can.`);
      if (!ok) return;
    }
    const service = this.service;
    const name = this.saved.layer ?? "view";
    try {
      await this.ctx.jobs.run(`Splat of ${name}`, async (job) => {
        let info = await service.splat(sid, { view: { ...view, scale: 1 }, views: sp.views, size: sp.size, samples: sp.samples, cover: sp.cover, steps: sp.steps, name });
        this.splat = info;
        this.panelUpdate?.();
        while (info.status === "queued" || info.status === "running") {
          await new Promise((r) => setTimeout(r, 2000));
          if (job.cancelled) await service.cancelSplat(info.id).catch(() => undefined);
          info = await service.splatInfo(info.id);
          this.splat = info;
          job.progress(info.progress, info.message);
          this.statusUpdate?.();
        }
        this.panelUpdate?.();
        if (info.status !== "done") throw new Error(info.error ?? info.status);
      });
      if (this.splat?.files.includes("scene.splat")) this.ctx.ui.toast(`Splat made: ${this.splat.message}`);
    } catch (e) {
      this.ctx.ui.toast(`Splat: ${(e as Error).message}`, "error");
    }
  }

  /** The splat made last, in a window over the page. */
  private async viewSplat(): Promise<void> {
    const info = this.splat;
    const service = this.service;
    if (!info || !service || !info.files.includes("scene.splat")) return;
    try {
      const [data, cams] = await Promise.all([service.splatFile(info.id, "scene.splat"), service.splatFile(info.id, "cameras.json")]);
      const meta = JSON.parse(new TextDecoder().decode(cams)) as { centre: number[]; frames: { c2w: number[][]; fovy: number }[] };
      const camera: SplatCamera | undefined = meta.frames[0] ? { c2w: meta.frames[0].c2w, fovy: meta.frames[0].fovy, centre: meta.centre } : undefined;
      const save = (file: string, as: string) => () => void service.splatFile(info.id, file).then((b) => downloadBlob(new Blob([b]), as));
      openSplatWindow(`Splat of ${this.saved.layer ?? "the view"}`, parseSplat(data), camera, [
        ["Download .splat", save("scene.splat", "anatomical-rendering.splat")],
        ...(info.files.includes("splat.ply") ? [["Download .ply", save("splat.ply", "anatomical-rendering.ply")] as [string, () => void]] : []),
      ]);
    } catch (e) {
      this.ctx.ui.toast(`Splat: ${(e as Error).message}`, "error");
    }
  }

  /** A `.splat` or `.ply` splat file from this device, in the viewer. */
  private openSplatFile(): void {
    const input = el("input", { type: "file", accept: ".splat,.ply" }) as HTMLInputElement;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = await file.arrayBuffer();
        openSplatWindow(file.name, file.name.toLowerCase().endsWith(".ply") ? parsePly(data) : parseSplat(data), undefined);
      } catch (e) {
        this.ctx.ui.toast(`Splat file: ${(e as Error).message}`, "error");
      }
    };
    input.click();
  }

  // ------------------------------------------------------------------ panel
  /** The status lines (all in the tooltip), and the error to show in place of the last line when there is one. */
  private status(): { lines: string[]; error?: string } {
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
    if (this.splat) parts.push(`Splat: ${this.splat.status} ${Math.round(this.splat.progress * 100)}% ${this.splat.message}${this.splat.error ? ` (${this.splat.error})` : ""}`);
    if (this.problem) parts.push(this.problem);
    const failed = this.saved.where === "host" && s?.status === "failed" ? `Failed: ${s.error ?? "unknown error"}` : "";
    return { lines: parts, error: this.problem || failed || undefined };
  }

  private panel(host: HTMLElement): Disposer {
    const statusEl = el("span", { class: "ar-status" });
    const retry = button("Retry", () => this.retry(), "Connect again and reopen the image");
    this.statusUpdate = () => {
      const { lines, error } = this.status();
      const shown = lines.flatMap((l) => l.split("\n")).filter(Boolean);
      statusEl.textContent = error ?? shown.at(-1) ?? (this.saved.on ? "" : "off");
      statusEl.title = shown.join("\n");
      statusEl.classList.toggle("error", error !== undefined);
      retry.hidden = error === undefined || !this.saved.on;
    };
    const render = () => {
      const s = this.saved;
      const imgs = this.images();
      const segs = this.segmentations();
      const presetList = s.where === "browser" ? LOCAL_PRESETS.map((p) => ({ name: p.name, modality: p.modality ?? "", density: p.density })) : this.presets;
      const allPresets = [...presetList, ...s.customPresets.map((p) => ({ name: String(p.name), modality: "from a file", density: Number(p.density ?? 40) }))];
      const presetOptions: [string, string][] = allPresets.map((p) => [p.name, p.modality ? `${p.name} (${p.modality})` : p.name]);
      const cutRow = (i: number) => {
        const c = s.cuts[i];
        const on = el("input", { type: "checkbox" }) as HTMLInputElement;
        on.checked = c.on;
        on.onchange = () =>
          this.save((x) => {
            x.cuts[i].on = on.checked;
            // A cut turned on starts through the point the cursor was last over (the axis's display index i).
            const o = on.checked ? this.cursorOffsets() : undefined;
            const k = this.lastFrame?.dimensions.names.indexOf(x.cuts[i].axis) ?? -1;
            if (o && k >= 0 && k < 3) x.cuts[i].offset = o.axis[k];
          });
        return el(
          "div",
          { style: "display: flex; gap: 6px; align-items: center" },
          on,
          el("span", { style: "width: 1.2em" }, c.axis),
          select([["-1", "keep −"], ["1", "keep +"]], String(c.keep), (v) => this.save((x) => (x.cuts[i].keep = Number(v) as 1 | -1))),
          (() => {
            const r = el("input", { type: "range", min: "-100", max: "100", step: "0.5", value: String(c.offset), style: "width: 90px", title: "Offset from the position (mm)" }) as HTMLInputElement;
            r.onchange = () => this.save((x) => (x.cuts[i].offset = Number(r.value)));
            return r;
          })(),
          numberInput(c.offset, (v) => this.save((x) => (x.cuts[i].offset = v)), { step: "1", style: "width: 56px", title: "Offset from the position (mm)" }),
        );
      };
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
      const hosts = this.renderHosts();
      const using = this.link()?.label;
      const hostChoice = select(
        [["", `Automatic${!this.host.name && using ? `: ${using}` : ""}`], ...hosts.map((h): [string, string] => [h.name, `${h.name}${h.info?.hostname && h.info.hostname !== h.name ? ` (${h.info.hostname})` : ""}${h.available ? "" : ": not answering"}`])],
        hosts.some((h) => h.name === this.host.name) ? this.host.name! : "",
        (v) => {
          this.host = { name: v || undefined };
          this.ctx.settings.set(HOST_KEY, this.host);
          void this.connect();
          render();
        },
      );
      const check = (checked: boolean, on: (v: boolean) => void, attrs: Record<string, unknown> = {}) => {
        const cb = el("input", { type: "checkbox", ...attrs }) as HTMLInputElement;
        cb.checked = checked;
        cb.onchange = () => on(cb.checked);
        return cb;
      };
      const tick = (label: string, checked: boolean, on: (v: boolean) => void, title?: string) => el("label", { class: "ar-tick", title }, check(checked, on), label);
      /** A number field that keeps its value within bounds (`fix`), and shows the value as kept. */
      const bounded = (value: number, fix: (v: number) => number, on: (v: number) => void, attrs: Record<string, string>) => {
        const input: HTMLInputElement = numberInput(fix(value), (v) => {
          const kept = fix(v);
          input.value = String(kept);
          on(kept);
        }, attrs);
        return input;
      };
      const tip = (label: string, control: Node, title?: string) => {
        const e = field(label, control);
        if (title) e.title = title;
        return e;
      };
      const host_ = s.where === "host";
      const connected = host_ ? this.serviceInfo !== undefined : true;
      const pair = button("Pair a computer…", () => void this.ctx.commands.invoke(COMPUTE_SETTINGS.command, COMPUTE_SETTINGS.args), "Pair this computer's runner, or another over SSH");
      const g = host_ ? this.serviceInfo?.gpu : undefined;
      const onSwitch = check(s.on, (v) => this.setOn(v), { class: "switch", disabled: imgs.length === 0, "aria-label": "Render" });
      clear(
        host,
        el(
          "div",
          { class: "ar" },
          el("div", { class: "ar-head" }, el("label", { class: "ar-on" }, onSwitch, el("b", {}, "Render")), statusEl, retry),
          imgs.length === 0 ? el("p", { class: "muted" }, "Needs an OME-Zarr or N5 image in the scene.") : "",
          el(
            "div",
            { class: "ar-views" },
            button("Centre", () => this.centreOnTissue(), "Move the position to the middle of the tissue and zoom to show all of it"),
            ...ANATOMICAL_VIEWS.map((v) => button(v.name[0], () => this.ctx.viewer.patchState((ng) => void ((ng as { projectionOrientation?: number[] }).projectionOrientation = orientationLooking(v.forward, v.up))), `Look from ${v.name.toLowerCase()}`)),
          ),
          this.section("remote", "Remote", !connected, false,
            tip("Where", select([["host", "A computer's GPU (CUDA)"], ["browser", "This browser (WebGPU)"]], s.where, (v) => {
              this.save((x) => (x.where = v as Saved["where"]));
              this.update();
              render();
            })),
            host_ ? tip("Computer", hostChoice) : "",
            host_ && g ? el("p", { class: "muted ar-small" }, g.backend === "cuda" ? `${g.name}, ${Math.round((g.free_mb ?? 0) / 1024)} of ${Math.round((g.total_mb ?? 0) / 1024)} GB free` : `No GPU: ${g.error ?? ""}`) : "",
            host_ ? el("div", { class: "ar-row" }, pair, hosts.length ? button("Reconnect", () => void this.connect()) : "") : "",
          ),
          this.section("rendering", "Rendering", false, true,
            tip("Image", imgs.length ? select(imgs.map((l) => [l.name, l.name]), this.target()?.name ?? "", (v) => this.save((x) => (x.layer = v))) : el("span", { class: "muted" }, "none")),
            el("div", { class: "ar-row" },
              tip("Preset", presetOptions.length ? select(presetOptions, s.preset, (v) => this.save((x) => (x.preset = v))) : el("span", { class: "muted" }, "connect first")),
              button("File…", () => this.loadPresetFile(), "Load a JSON preset (or a list of them): name, domain, stops of value, colour and opacity, and material")),
            this.referenceNote(),
            this.windowField(),
            this.editorField(),
            tip("Density (per mm)", this.sliderNum(s.density ?? Number(this.presets.find((p) => p.name === s.preset)?.density ?? 40), 0, 200, 1, (v) => this.save((x) => (x.density = v))), "How opaque the tissue is: higher, crisper surfaces; lower, more translucent"),
            tip("Exposure", this.sliderNum(s.exposure, 0, 5, 0.05, (v) => this.save((x) => (x.exposure = v)))),
            host_ ? tick("Hide the jar", s.jar, (v) => {
              this.save((x) => (x.jar = v));
              this.update();
            }, "Render only a cylinder about the scan's axis, leaving out the jar's wall (HiP-CT organs in their jars)") : "",
            el("h4", {}, "Regions"),
            segs.length
              ? el("div", {},
                  el("div", { class: "ar-row" }, tick("Colour by", s.regions, (v) => this.save((x) => (x.regions = v))), select(segs.map((l) => [l.name, l.name]), segs.find((x) => x.name === s.labels)?.name ?? segs[0].name, (v) => this.save((x) => (x.labels = v)), "Segmentation")),
                  tip("Region colour", this.sliderNum(s.labelMix, 0, 1, 0.05, (v) => this.save((x) => (x.labelMix = v))), "0: the preset's colours, 1: the regions'"),
                  tip("Hidden regions", idsInput(s.hidden, (v) => this.save((x) => (x.hidden = v))), "Label ids left out"),
                  tip("Kept through crops", idsInput(s.keep, (v) => this.save((x) => (x.keep = v))), "Label ids that stay whole where the crops cut"))
              : el("p", { class: "muted ar-small" }, "No OME-Zarr segmentation in the scene."),
            el("h4", {}, "Quality"),
            tip("Whole volume (M voxels)", this.sliderNum(s.budget / 1e6, 10, 2000, 10, (v) => this.save((x) => (x.budget = Math.max(1, v) * 1e6)), { live: false }), "One level of the whole image on the GPU: the finest stored level within this, or one made from a finer level"),
            host_ ? tick("Finer detail where you zoom", s.detail, (v) => {
              this.save((x) => (x.detail = v));
              this.update();
            }, "The region in view is read at a finer level; shadows and light from outside it stay at the whole volume's") : "",
            host_ && s.detail ? tip("Detail (M voxels)", this.sliderNum(s.detailBudget / 1e6, 10, 2000, 10, (v) => {
              this.save((x) => (x.detailBudget = Math.max(1, v) * 1e6));
              this.update();
            }, { live: false })) : "",
            tick("Denoise the first frames", s.denoise, (v) => this.save((x) => (x.denoise = v))),
            tip("Samples per pixel", this.sliderNum(s.maxSamples, 16, 4096, 16, (v) => this.save((x) => (x.maxSamples = Math.max(1, Math.round(v))))), "Where a still view stops refining"),
          ),
          this.section("lighting", "Lighting", false, false,
            host_ ? tip("Style", select([["", "Custom"], ...Object.entries(LIGHTING).map(([k, l]): [string, string] => [k, l.name])], s.lightStyle, (v) =>
              this.save((x) => {
                x.lightStyle = v;
                const l = LIGHTING[v];
                if (l) [x.lightMap, x.envScale, x.lightKey] = [l.map, l.envScale, l.key];
              }))) : "",
            tip("Around", this.slider(s.lightAzimuth, -180, 180, 5, (v) => this.save((x) => (x.lightAzimuth = v)), "0 from the camera, 90 from the right, -90 from the left"), "The key light turns with the camera"),
            tip("Up", this.slider(s.lightElevation, -90, 90, 5, (v) => this.save((x) => (x.lightElevation = v)), "90 from above, -90 from below")),
            host_ ? tip("Key light", this.slider(s.lightKey, 0, 4, 0.05, (v) => this.save((x) => ((x.lightKey = v), (x.lightStyle = ""))), "The light that makes shadows")) : "",
            host_ ? tip("Surroundings", this.slider(s.envScale, 0, 3, 0.05, (v) => this.save((x) => ((x.envScale = v), (x.lightStyle = ""))), "Light from all round: the light map, or the sky colours")) : "",
            host_ && (this.serviceInfo?.lightmaps?.length ?? 0) > 0
              ? el("div", { class: "ar-row" },
                  tip("Light map", select([["", "Sky colours"], ...this.serviceInfo!.lightmaps!.map((m): [string, string] => [m, m])], s.lightMap, (v) => this.save((x) => (x.lightMap = v))), "HDR panoramas (CC0, Poly Haven)"),
                  this.sliderNum(s.lightMapRotation, -180, 180, 5, (v) => this.save((x) => (x.lightMapRotation = v)), { title: "Turn the light map (degrees)", width: "80px" }))
              : "",
          ),
          this.section("crops", "Crops", false, false,
            el("div", { class: "ar-row" },
              button("Move to the cursor", () => {
                const o = this.cursorOffsets();
                if (!o) return;
                this.save((x) => {
                  const names = this.lastFrame!.dimensions.names;
                  for (const c of x.cuts) {
                    const k = names.indexOf(c.axis);
                    if (c.on && k >= 0 && k < 3) c.offset = o.axis[k];
                  }
                  if (x.viewCut.on) x.viewCut = { ...x.viewCut, offset: o.view, fixed: null };
                });
                render();
              }, this.lastCursor ? "Move the clips that are on through the point the cursor was last over in the 3-D view" : "Point at the tissue in the 3-D view first")),
            el("h4", {}, "Camera plane"),
            el("div", { class: "ar-row" },
              check(s.viewCut.on, (v) =>
                this.save((x) => {
                  // Turned on, it starts through the point the cursor was last over.
                  const o = v ? this.cursorOffsets() : undefined;
                  x.viewCut = { ...x.viewCut, on: v, ...(o ? { offset: o.view, fixed: null } : {}) };
                }), { title: "Clip across the view, keeping what lies beyond it" }),
              this.slider(s.viewCut.offset, -100, 100, 0.5, (v) => this.save((x) => (x.viewCut = { ...x.viewCut, offset: v, fixed: null })), "Past the position (mm): positive clips deeper"),
              numberInput(s.viewCut.offset, (v) => this.save((x) => (x.viewCut = { ...x.viewCut, offset: v, fixed: null })), { step: "1", style: "width: 56px", title: "Past the position (mm)" }),
              s.viewCut.fixed
                ? button("Follow", () => this.save((x) => (x.viewCut = { ...x.viewCut, fixed: null })), "The clip turns with the camera again")
                : button("Pin", () => {
                    const f = this.lastFrame;
                    if (!f) return;
                    this.save((x) => (x.viewCut = { ...x.viewCut, on: true, fixed: viewCutPlane(f.invViewProjection, f.position, x.viewCut.offset, f.dimensions) }));
                  }, "Keep the clip where it is now as you turn the view")),
            el("h4", {}, "Axis planes"),
            cutRow(0), cutRow(1), cutRow(2),
            el("h4", {}, "Boxes"),
            ...s.boxes.map((b, i) => this.cropRow(b, i, render)),
            (() => {
              const add = button("Add a box", () => {
                if (this.saved.boxes.length >= LIMITS.maxBoxes) return;
                this.save((x) => x.boxes.push({ name: `Box ${x.boxes.length + 1}`, on: true, keep: true, lo: [0, 0, 0], hi: [1, 1, 1] }));
                render();
              }, s.boxes.length >= LIMITS.maxBoxes ? `Up to ${LIMITS.maxBoxes} boxes` : `Fractions of the volume; each keeps its inside or cuts it out (up to ${LIMITS.maxBoxes})`);
              add.disabled = s.boxes.length >= LIMITS.maxBoxes;
              return add;
            })(),
          ),
          this.section("output", "Output", false, false,
            el("div", { class: "ar-row" },
              tip("Width", bounded(s.movie.width, evenSide, (v) => this.save((x) => (x.movie.width = v)), { style: "width: 70px", min: "8", max: "8192", step: "2" })),
              tip("Height", bounded(s.movie.height, evenSide, (v) => this.save((x) => (x.movie.height = v)), { style: "width: 70px", min: "8", max: "8192", step: "2" })),
              tip("Samples", bounded(s.movie.samples, (v) => clampInt(v, 1, LIMITS.maxSamples), (v) => this.save((x) => (x.movie.samples = v)), { style: "width: 60px", min: "1", max: String(LIMITS.maxSamples) }))),
            el("div", { class: "ar-row" }, (() => {
              const b = button(this.stillRunning ? "Rendering still…" : "Save still (PNG)", () => void this.saveStill(), "The view now at this size, path-traced to twice the samples; its progress is in Activity");
              b.disabled = this.stillRunning;
              return b;
            })()),
            host_ && this.serviceInfo?.ffmpeg === false ? el("p", { class: "note ar-small" }, NO_FFMPEG) : "",
            el("h4", {}, "Movie"),
            ...keyframeRows,
            el("div", { class: "ar-row" },
              button("Add keyframe", () => this.addKeyframe(), "The view now"),
              tip("fps", bounded(s.movie.fps, (v) => clampInt(v, 1, LIMITS.maxFps), (v) => this.save((x) => (x.movie.fps = v)), { style: "width: 50px", min: "1", max: String(LIMITS.maxFps) })),
              tip("Camera", select([["smooth", "slows at keyframes"], ["linear", "steady"]], s.movie.easing, (v) => this.save((x) => (x.movie.easing = v as "smooth" | "linear"))))),
            el("div", { class: "ar-row" },
              button("Preview movie…", () => this.renderMovie(), "A quick, small preview first; the movie itself renders from there, in the background"),
              movie?.status === "running" ? button("Cancel", () => void this.service?.cancelMovie(movie.id)) : "",
              movie?.status === "done" ? button("Download", () => void this.service!.movieFile(movie.id).then((b) => downloadBlob(b, "anatomical-rendering.mp4"))) : ""),
            el("h4", {}, "Rotation"),
            el("div", { class: "ar-row" },
              select([["vertical", "about the vertical"], ["horizontal", "about the horizontal"]], s.rotation.axis, (v) => this.save((x) => (x.rotation.axis = v as "vertical" | "horizontal"))),
              select([["360", "full turn"], ["180", "half turn"]], String(s.rotation.degrees), (v) => this.save((x) => (x.rotation.degrees = Number(v)))),
              tip("Step °", bounded(s.rotation.step, (v) => Math.min(90, Math.max(0.25, v)), (v) => this.save((x) => (x.rotation.step = v)), { step: "1", min: "0.25", max: "90", style: "width: 50px" })),
              button("Preview rotation…", () => void this.renderRotation(), "A turn about the position from the view now: a quick preview first")),
            el("h4", { title: "The look now, path-traced from all round and fitted with 3-D Gaussians that any browser, phone or headset draws at full speed" }, "Splat"),
            host_ && this.serviceInfo?.splats && !this.serviceInfo.splats.ready ? el("p", { class: "muted ar-small" }, `Views only: this computer cannot fit (${this.serviceInfo.splats.error ?? "no splat Python"}).`) : "",
            el("div", { class: "ar-row" },
              tip("Views", bounded(s.splat.views, (v) => clampInt(v, 8, 4096), (v) => this.save((x) => (x.splat.views = v)), { style: "width: 60px", min: "8", max: "4096" })),
              tip("Size", bounded(s.splat.size, (v) => clampInt(v, 64, 4096), (v) => this.save((x) => (x.splat.size = v)), { style: "width: 60px", min: "64", max: "4096", title: "Pixels along the longer side of each view" })),
              tip("Samples", bounded(s.splat.samples, (v) => clampInt(v, 1, 8192), (v) => this.save((x) => (x.splat.samples = v)), { style: "width: 60px", min: "1", max: "8192" })),
              tip("From", select([["180", "every side"], ["90", "this half"], ["50", "near this side"]], String(s.splat.cover), (v) => this.save((x) => (x.splat.cover = Number(v))))),
              tip("Fit steps", bounded(s.splat.steps, (v) => clampInt(v, 0, 200000), (v) => this.save((x) => (x.splat.steps = v)), { style: "width: 70px", min: "0", max: "200000", title: "0: render the views only" }))),
            el("div", { class: "ar-row" },
              button("Make splat", () => void this.makeSplat(), "Runs on the computer that renders; it shows in Jobs"),
              this.splat?.files.includes("scene.splat") ? button("View", () => void this.viewSplat()) : "",
              button("Open file…", () => this.openSplatFile(), "A .splat or 3-D Gaussian splatting .ply from this device")),
          ),
        ),
      );
      this.statusUpdate?.();
    };
    // Rebuilt after the event that changed the state has finished (a field's change comes with its blur).
    let pending = false;
    let alive = true;
    this.panelUpdate = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        if (alive) render();
      }, 0);
    };
    render();
    return () => {
      alive = false;
      this.panelUpdate = undefined;
      this.statusUpdate = undefined;
    };
  }

  /** A section of the panel: a card whose open state is kept in this browser; `attention` opens it whatever was kept. */
  private section(id: string, title: string, attention: boolean, open: boolean, ...children: (Node | string)[]): HTMLElement {
    return card(`anatomical.${id}`, title, { open, attention }, ...children);
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
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    ctx.subscriptions.push(() => style.remove());
    const r = new AnatomicalRendering(ctx);
    ctx.subscriptions.push(() => r.dispose());
  },
};
