/**
 * Anatomical rendering: an OME-Zarr image path-traced on a GPU, shown in
 * Neuroglancer's 3-D view.  The rendering runs in the render service
 * (`runner/ngplatform_render`), on this computer or on one reached over
 * SSH, through a runner; this module keeps a session open there for the
 * chosen image, sends the view whenever the camera or the look changes
 * (at half size while the camera moves), and draws the frames it sends
 * back as they refine (./draw.ts).
 */
import type { Disposer, Frame3d, JobControl, LayerInfo, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { button, card, checkbox, downloadBlob, el, emptyState, field, iconButton, info, numberInput, region, select, type Settable, type Slider, slider, statusLine, toggle } from "@ngplatform/sdk/dom";
import { type Distance, hostLink, type Link, type MovieInfo, type PresetInfo, refusal, RenderService, ServiceError, type ServiceInfo, serviceText, type SessionInfo, type ViewSpec, type VolumeMeta } from "./client.js";
import { invert4, PictureDrawer } from "./draw.js";
import { dropJob, finished, type JobKind, type JobRecord, jobProgress, jobText, putJob, readJobs } from "./jobs.js";
import { clampInt, evenSide, LIMITS, movieSettings, retryDelay, stillProblem, windowStep } from "./limits.js";
import { parsePly, parseSplat, showSplats, type SplatCamera } from "./splatview.js";
import { ColourmapEditor, type DataStop, histogramHandles, shifted, type Tuning, type WarpPoint, warpInverse } from "./editor.js";
import { LocalRenderer, PRESETS as LOCAL_PRESETS } from "./local/local.js";
import { RENDER_PANEL } from "./manifest.js";
import { anatomicalSides, type AxisSides, axesCheck, clipPlanes, type Cut, displayFromPhysical, LIGHTING, lightDirection, metadataBase, omeZarrSource, orientationLooking, safeHref, unitMm, type ViewButton, viewButtons, viewCutPlane, viewForward, viewKey } from "./view.js";

/** Where Neuroglancer's 3-D camera was when a keyframe was added: to go back to it. */
export interface KeyframeCamera {
  position: number[];
  orientation: number[];
  scale: number;
}

export interface Keyframe {
  time: number;
  view: ViewSpec;
  camera?: KeyframeCamera;
}

/**
 * The keyframes with the one at `i` moved one place earlier (`by` -1) or
 * later (1): the two swap places and keep the times of the places, so the
 * movie passes them in the new order.
 */
export function moveKeyframe(list: readonly Keyframe[], i: number, by: -1 | 1): Keyframe[] {
  const j = i + by;
  if (i < 0 || j < 0 || i >= list.length || j >= list.length) return list.slice();
  const out = list.slice();
  [out[i], out[j]] = [{ ...list[j], time: list[i].time }, { ...list[i], time: list[j].time }];
  return out;
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
  /** The channel and time point rendered (from 0), per image (its OME-Zarr store), for an image with more than one; else the first. */
  volumeAt: Record<string, { channel: number; time: number }>;
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
    volumeAt: Object.fromEntries(
      Object.entries(s.volumeAt && typeof s.volumeAt === "object" ? s.volumeAt : {})
        .filter((e): e is [string, { channel: number; time: number }] => !!e[1] && typeof e[1] === "object")
        .map(([k, v]) => [k, { channel: Math.max(0, Math.round(num(v.channel, 0))), time: Math.max(0, Math.round(num(v.time, 0))) }]),
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
    keyframes: Array.isArray(s.keyframes) ? s.keyframes.filter((k) => k && typeof k.time === "number" && k.view && typeof k.view === "object") : [],
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

/** Label ids as typed (spaces or commas between): the whole numbers among them. */
export function parseIds(text: string): number[] {
  return text.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));
}

/** A text box of label ids; `set` shows ids from the state, unless it is being typed in. */
function idsInput(ids: number[], on: (ids: number[]) => void, label: string): Settable<HTMLInputElement, number[]> {
  const t = el("input", { class: "text-input", type: "text", value: ids.join(", "), placeholder: "label ids", "aria-label": label }) as Settable<HTMLInputElement, number[]>;
  t.onchange = () => on(parseIds(t.value));
  t.set = (v) => {
    if (t.ownerDocument.activeElement !== t && parseIds(t.value).join() !== v.join()) t.value = v.join(", ");
  };
  return t;
}

/** A select whose options follow the scene (images, presets, computers): `update` puts in new options only when they differ, then shows `value`. */
type Choices = Settable<HTMLSelectElement, string> & { update(options: [string, string][], value: string): void };
function choices(onchange: (value: string) => void, label: string): Choices {
  const s = select([], "", onchange, label) as Choices;
  let last = "";
  s.update = (options, value) => {
    const key = JSON.stringify(options);
    if (key !== last) {
      last = key;
      s.replaceChildren(...options.map(([v, text]) => el("option", { value: v }, text)));
      s.value = value;
    }
    s.set(value);
  };
  return s;
}

/** A number box kept within bounds (`fix`): it shows the value as kept. */
function bounded(value: number, fix: (v: number) => number, on: (v: number) => void, attrs: Record<string, string>): Settable<HTMLInputElement, number> {
  const input = numberInput(fix(value), (v) => {
    const kept = fix(v);
    input.value = String(kept);
    on(kept);
  }, attrs);
  return input;
}

/** The plugin's own layout: the colourmap canvas, crop boxes, the movie preview and the splat viewer. */
const STYLE = `
.ar-grow { flex: 1 1 140px; min-width: 0; }
.ar-cut { display: grid; grid-template-columns: 5.5em auto minmax(0, 1fr); align-items: center; gap: var(--sp-3); }
.ar-cut > select { width: auto; }
.ar-editor { display: block; width: 100%; cursor: crosshair; border: 1px solid var(--line-strong); }
.ar-box { display: grid; gap: var(--sp-3); padding-left: var(--sp-4); border-left: 2px solid var(--line-strong); }
.ar-box-axes { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: var(--sp-2) var(--sp-3); }
.ar-box-axes > span { color: var(--muted); font-size: var(--fs-caption); }
.ar-preview { display: grid; gap: var(--sp-3); place-items: center; min-height: 200px; }
.ar-preview > progress { width: 100%; }
.ar-video { width: 100%; max-height: 60vh; background: var(--ink-0); }
.ar-splat { height: min(64vh, 640px); background: var(--ink-0); }
.ar-splat-canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.ar-splat-canvas.grabbing { cursor: grabbing; }
.ar-job { display: flex; align-items: center; gap: var(--sp-3); }
.ar-job > .readout { flex: 1; min-width: 0; }
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
/** The stills, movies and splats asked for, kept in this browser (jobs.ts). */
const JOBS_KEY = "jobs";
/** How often the open panel reads the computer's budget and queue again (ms). */
const INFO_EVERY_MS = 15_000;
const NO_FFMPEG = "Movies need ffmpeg on the render computer.";
const NO_HOST = "No paired computer has the render service: pair one (Settings › Compute), or render in this browser.";

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
  /** The jobs asked for (kept in this browser), and those this page is following now. */
  private jobs: JobRecord[];
  private readonly following = new Set<string>();
  /** Each image's anatomical orientation from its metadata (null: none given, or not readable), by store. */
  private readonly sides = new Map<string, AxisSides | null>();
  private sessionKey = "";
  /** How many channels and time points each image has (by store), as a loaded session said: kept while another session loads. */
  private readonly counts = new Map<string, { channels: number; times: number }>();
  private abort: AbortController | undefined;
  private lastKey = "";
  private lastScale = 1;
  private lastFrame: Frame3d | undefined;
  private lastSpec: ViewSpec | undefined;
  private sending = false;
  /** The last view sent was refused (the GPU busy): Retry sends it again rather than opening the session again. */
  private viewRefused = false;
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
  private local: LocalRenderer | undefined;
  private localKey = "";
  private localText = "";
  private readonly toggle: { set(value: boolean): void; dispose(): void };
  /** Brings the panel up to date (in place); `statusUpdate` only its status line and readouts, as each frame comes. */
  private panelUpdate: (() => void) | undefined;
  private statusUpdate: (() => void) | undefined;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.host = { name: ctx.settings.get<HostSetting>(HOST_KEY)?.name || undefined };
    this.jobs = readJobs(ctx.settings.get(JOBS_KEY));
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
        if (this.connecting === undefined && label !== undefined && (this.serviceInfo === undefined || label !== this.service?.link.label)) void this.connect();
        this.panelUpdate?.();
      }),
      () => clearTimeout(this.settle),
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
    const target = this.target();
    const problem = target === undefined ? "Anatomical rendering needs an OME-Zarr or N5 image in the scene." : this.axesOf(target).problem;
    if (on && problem !== undefined) {
      // Nothing it can read (precomputed EM, meshes, tractograms, a 2-D image): say so rather than switch on to no effect.
      this.toggle.set(false);
      this.panelUpdate?.();
      this.ctx.ui.toast(problem, "error");
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

  /** What the image's axes allow where it renders (view.ts, axesCheck): a problem that stops it, or a note. */
  private axesOf(layer: LayerInfo): { problem?: string; times?: number; channels?: number } {
    return axesCheck(this.ctx.viewer.layerTransform?.(layer.name)?.input, this.saved.where === "browser");
  }

  /**
   * How many channels and time points the image has, on a computer: as the
   * session says once loaded, else as Neuroglancer reads its axes;
   * undefined when it has one of each (nothing to choose).
   */
  private volumeCounts(layer: LayerInfo): { channels: number; times: number } | undefined {
    if (this.saved.where === "browser") return undefined;
    const axes = this.axesOf(layer);
    const src = omeZarrSource(layer.sources[0]);
    const known = src === undefined ? undefined : this.counts.get(src);
    const counts = known ?? { channels: axes.channels ?? 1, times: axes.times ?? 1 };
    return counts.channels > 1 || counts.times > 1 ? counts : undefined;
  }

  /** The channel and time point to render of the image: as chosen, within what it has. */
  private volumeAt(layer: LayerInfo): { channel: number; time: number } {
    const src = omeZarrSource(layer.sources[0]);
    const at = src === undefined ? undefined : this.saved.volumeAt[src];
    const n = this.volumeCounts(layer);
    if (at === undefined || n === undefined) return { channel: 0, time: 0 };
    return { channel: Math.min(at.channel, n.channels - 1), time: Math.min(at.time, n.times - 1) };
  }

  /** Renders another channel or time point of the image: one undo step, and a new session (the computer loads one of each per session). */
  private setVolumeAt(layer: LayerInfo, change: Partial<{ channel: number; time: number }>): void {
    const src = omeZarrSource(layer.sources[0]);
    if (src === undefined) return;
    const next = { ...this.volumeAt(layer), ...change };
    this.save((x) => (x.volumeAt[src] = next));
    this.update();
  }

  /** The buttons that turn the view, by the image's anatomical sides when its metadata gives them, else by axis. */
  private viewButtons(): ViewButton[] {
    const target = this.target();
    const src = target ? omeZarrSource(target.sources[0]) : undefined;
    if (src !== undefined && !this.sides.has(src)) void this.readSides(src);
    return viewButtons(this.lastFrame?.dimensions.names ?? ["x", "y", "z"], src === undefined ? undefined : (this.sides.get(src) ?? undefined));
  }

  /** Reads an image's anatomical orientation from its OME-Zarr metadata (zarr.json, else .zattrs), once per store. */
  private async readSides(src: string): Promise<void> {
    this.sides.set(src, null);
    const base = metadataBase(src);
    if (base === undefined || typeof fetch !== "function") return;
    for (const [file, attrs] of [["zarr.json", (j: { attributes?: unknown }) => j.attributes], [".zattrs", (j: unknown) => j]] as const) {
      try {
        const r = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const sides = anatomicalSides(attrs(await r.json()));
        if (sides === undefined) return;
        this.sides.set(src, sides);
        this.panelUpdate?.();
        return;
      } catch {
        // Not readable from the page: the buttons stay by axis.
      }
    }
  }

  private lookFrom(v: ViewButton): void {
    this.ctx.viewer.patchState((ng) => void ((ng as { projectionOrientation?: number[] }).projectionOrientation = orientationLooking(v.forward, v.up)));
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

  /** Connects so far; the one under way (an answer to an earlier one, another computer chosen meanwhile, is dropped). */
  private connects = 0;
  private connecting: number | undefined;
  /** Why the chosen computer cannot render ("" when it can), shown while rendering on a computer. */
  private connectProblem = "";

  private async connect(): Promise<void> {
    const n = ++this.connects;
    this.connecting = n;
    // The session on the computer used until now goes first (with its GPU memory), through the service it was opened on.
    this.closeSession();
    const link = this.link();
    const service = link === undefined ? undefined : new RenderService(link);
    this.service = service;
    this.serviceInfo = undefined;
    this.problem = "";
    this.connectProblem = "";
    this.statusUpdate?.();
    let info: ServiceInfo | undefined;
    let presets: PresetInfo[] | undefined;
    let problem = "";
    try {
      if (service === undefined) throw new Error(NO_HOST);
      info = await service.info(AbortSignal.timeout(8000));
      presets = await service.presets();
    } catch (e) {
      problem = service === undefined ? NO_HOST : `No render service on ${service.link.label}: ${(e as Error).message}`;
    }
    if (n !== this.connects || this.disposed) return;
    this.connecting = undefined;
    this.serviceInfo = info;
    this.connectProblem = problem;
    if (presets !== undefined) {
      this.presets = presets;
      if (!this.saved.preset && presets.length > 0) this.saved.preset = presets[0].name;
    }
    this.sessionKey = "";
    this.update();
    this.panelUpdate?.();
    if (service !== undefined && info !== undefined) this.resumeJobs(service);
  }

  /** Reads the computer's /info again, quietly (its budget in use and its queue, for the Remote card); an error leaves what was shown. */
  private async refreshInfo(service = this.service): Promise<void> {
    if (service === undefined || service !== this.service || this.serviceInfo === undefined) return;
    try {
      const info = await service.info(AbortSignal.timeout(8000));
      if (service !== this.service || this.serviceInfo === undefined || this.disposed) return;
      this.serviceInfo = info;
      this.panelUpdate?.();
    } catch {
      // Not answering for a moment: the frame loop and Reconnect say so, not this.
    }
  }

  private update(): void {
    const found = this.target();
    const browser = this.saved.where === "browser";
    // An image whose axes it cannot render (2-D; time or channels in this browser) is not opened.
    const target = found !== undefined && this.axesOf(found).problem === undefined ? found : undefined;
    if (!this.saved.on || target === undefined || (!browser && this.serviceInfo === undefined)) {
      this.handle?.dispose();
      this.handle = undefined;
      this.handleLayer = undefined;
      this.drawer.set(undefined);
      if (!this.saved.on || target === undefined) {
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

  /** Where a preset's colours came from: the photographs it lists (with their authors and licences); none in this browser. */
  private references(): { title: string; page?: string; author: string; licence: string }[] {
    if (this.saved.where === "browser") return [];
    const info = this.presets.find((p) => p.name === this.saved.preset);
    const refs = Array.isArray(info?.reference) ? (info!.reference as { title?: string; page?: string; author?: string; licence?: string }[]) : [];
    return refs.map((r) => ({ title: (r.title ?? "a photograph").replace(/^File:/, ""), page: safeHref(r.page), author: r.author ?? "unknown", licence: r.licence ?? "" }));
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
      this.panelUpdate?.();
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

  /** The editor's canvas and its histogram: shown again from the state (not while a point is dragged). */
  private editorUpdate: (() => void) | undefined;

  /** The colourmap editor for the image now (made once, kept). */
  private colourmapEditor(): ColourmapEditor {
    this.editor ??= new ColourmapEditor((stops) => {
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
    return this.editor;
  }

  /** The width of the colourmap's visible range (data values): what Shift moves it by, as a fraction. */
  private mapWidth(): number {
    const vis = this.editedStops()?.base.filter((x) => x.opacity > 0.01) ?? [];
    return vis.length ? vis[vis.length - 1].value - vis[0].value || 1 : 1;
  }

  /** Changes the tuning of the image now; `preview`: shown and rendered while a slider is dragged, not yet saved. */
  private tune(f: (t: Tuning) => void, preview = false): void {
    const cur = this.currentTuning();
    if (!cur) return;
    const edit = (x: Saved) => {
      const n = { ...(x.tunings[cur.src] ?? { shift: 0, scale: 1 }) };
      f(n);
      x.tunings[cur.src] = n;
    };
    if (preview) this.preview(edit);
    else this.save(edit);
    this.editorUpdate?.();
  }

  /** A change previewed while a slider is dragged: the view renders it, nothing is saved (no undo step) until it is let go. */
  private preview(edit: (s: Saved) => void): void {
    edit(this.saved);
    this.handle?.redraw();
  }

  /** A "window" preset's range for this image, on a computer: the store, the image's values and the step; undefined otherwise. */
  private windowRange(): { src: string; lo: number; hi: number; step: number; guess?: [number, number] } | undefined {
    if (this.presetDomain() !== "window" || this.saved.where === "browser") return undefined;
    const target = this.target();
    const src = target ? omeZarrSource(target.sources[0]) : undefined;
    if (src === undefined) return undefined;
    const vol = this.session?.volume as { window?: [number, number] | null; lo?: number; hi?: number; dtype?: string } | undefined;
    const known = vol?.lo !== undefined && vol.hi !== undefined && vol.hi > vol.lo;
    return {
      src,
      lo: known ? vol!.lo! : 0,
      hi: known ? vol!.hi! : 65535,
      step: known ? windowStep(vol!.lo!, vol!.hi!, vol!.dtype) : 1,
      guess: vol?.window ?? undefined,
    };
  }

  private setWindow(src: string, i: 0 | 1, v: number, guess: [number, number] | undefined): void {
    this.save((x) => {
      const cur = x.windows[src] ?? guess ?? [v, v + 1];
      const next: [number, number] = [cur[0], cur[1]];
      next[i] = v;
      if (next[1] > next[0]) x.windows[src] = next;
    });
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
    // The channel and time point: another of either is another session (the computer cannot change them in place).
    const at = this.volumeAt(target);
    const key = JSON.stringify([service.link.base, url, labels, this.saved.budget, this.saved.jar, detailBudget, at.channel, at.time]);
    if (key === this.sessionKey) return;
    this.closeSession();
    this.sessionKey = key;
    const abort = new AbortController();
    this.abort = abort;
    try {
      let info = await service.open({
        url,
        budget: this.saved.budget,
        detail_budget: detailBudget,
        ...(this.saved.jar ? { cylinder: JAR_FRACTION } : {}),
        ...(at.channel ? { channel: at.channel } : {}),
        ...(at.time ? { time: at.time } : {}),
      }, labels ? { url: labels } : undefined);
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
      const v = info.volume as SessionInfo["volume"] & Partial<VolumeMeta>;
      if (info.status === "ready" && v.channels !== undefined && v.times !== undefined && !abort.signal.aborted) {
        this.counts.set(url, { channels: v.channels, times: v.times });
        // More of either than Neuroglancer's axes said, and another chosen before: that one is opened instead.
        const now = this.volumeAt(target);
        if (now.channel !== at.channel || now.time !== at.time) return this.update();
      }
      // Loaded (or failed): the window and the colourmap editor follow the image's values.
      this.panelUpdate?.();
      if (info.status !== "ready" || abort.signal.aborted) return;
      void this.refreshInfo(service);
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
    this.viewRefused = false;
    this.lastKey = "";
    this.lastLook = "";
    this.lastScale = 1;
    this.frameText = "";
    clearTimeout(this.settle);
    this.drawer.set(undefined);
  }

  /** A refused job asked for again. */
  private retryJob(): void {
    const r = this.refused;
    this.refused = undefined;
    this.statusUpdate?.();
    r?.retry();
  }

  /** After an error: connect again when the computer did not answer, send the view again when the computer refused it, else open the session (or the browser's renderer) again. */
  private retry(): void {
    this.problem = "";
    this.reopened = 0;
    if (this.viewRefused && this.session?.status === "ready") {
      this.viewRefused = false;
      this.lastKey = "";
      this.lastLook = "";
      this.handle?.redraw();
    } else if (this.saved.where === "browser") {
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
          // camera moves); drawn flat only from a host that gives no distances.  A frame not drawn lets its bitmap go.
          if (this.drawer.placed() !== undefined) {
            f.bitmap.close?.();
            continue;
          }
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
    if (sid === undefined || (local && !local.ready)) return;
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
        if (this.viewRefused) {
          // A view the computer took after one it refused: the refusal is over.
          this.viewRefused = false;
          this.problem = "";
          this.statusUpdate?.();
        }
        this.views.set(r.version, spec.inv_view_projection);
        for (const k of this.views.keys()) if (k < r.version - 64) this.views.delete(k);
      })
      .catch((e) => {
        if (this.opened?.id !== sid) return;
        // The computer's GPU too busy for a larger view: the session stays, and Retry sends the view again.
        this.viewRefused = refusal(e) !== undefined;
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
  /** Neuroglancer's 3-D camera now: its position, orientation and zoom. */
  private camera(): KeyframeCamera | undefined {
    const ng = this.ctx.viewer.getState() as { position?: unknown; projectionOrientation?: unknown; projectionScale?: unknown } | undefined;
    if (!Array.isArray(ng?.position)) return undefined;
    return {
      position: ng.position.slice() as number[],
      orientation: Array.isArray(ng.projectionOrientation) ? (ng.projectionOrientation.slice() as number[]) : [0, 0, 0, 1],
      scale: typeof ng.projectionScale === "number" ? ng.projectionScale : 256,
    };
  }

  /** A keyframe of the view now (and the look), `at` an index to replace, else added two seconds after the last. */
  private addKeyframe(at?: number): void {
    const spec = this.lastSpec;
    if (spec === undefined) {
      this.ctx.ui.toast("Render a view first: switch Render on and look at the image in 3-D.", "error");
      return;
    }
    const camera = this.camera();
    const frame = { view: { ...spec, scale: 1 }, ...(camera ? { camera } : {}) };
    if (at !== undefined) return this.save((s) => (s.keyframes[at] = { time: s.keyframes[at].time, ...frame }));
    const last = this.saved.keyframes.at(-1)?.time ?? -2;
    this.save((s) => s.keyframes.push({ time: last + 2, ...frame }));
  }

  /** Moves the 3-D view back to where a keyframe was taken. */
  private goToKeyframe(i: number): void {
    const c = this.saved.keyframes[i]?.camera;
    if (c === undefined) {
      this.ctx.ui.toast("This keyframe was made before keyframes kept their camera: replace it to go back to it.", "error");
      return;
    }
    this.ctx.viewer.patchState((ng) => {
      const s = ng as { position?: number[]; projectionOrientation?: number[]; projectionScale?: number };
      s.position = c.position.slice();
      s.projectionOrientation = c.orientation.slice();
      s.projectionScale = c.scale;
    });
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

  /** The view now at the output's size and twice its samples, as a job on the host (progress and cancel in the panel and in Activity); saved as a download. */
  private async saveStill(): Promise<void> {
    const sid = this.session?.status === "ready" ? this.session.id : undefined;
    const service = this.opened?.service;
    const view = this.currentSpec();
    if (sid === undefined || service === undefined || view === undefined) return this.ctx.ui.toast("Render a view on a computer first.", "error");
    if (this.stillRunning) return this.ctx.ui.toast("A still is already rendering.", "error");
    const m = movieSettings(this.saved.movie);
    const samples = Math.min(LIMITS.maxSamples, m.samples * 2);
    const tooLarge = stillProblem(m.width, m.height, samples);
    if (tooLarge) return this.ctx.ui.toast(tooLarge, "error");
    this.stillRunning = true;
    this.panelUpdate?.();
    const name = `Still ${m.width} × ${m.height}, ${samples} samples`;
    try {
      await this.ctx.jobs.run(name, async (job) => {
        const info = await service.still(sid, { view, width: m.width, height: m.height, samples, name: "anatomical-rendering" });
        const done = await this.follow("still", service, info, name, job);
        if (done.status !== "done") throw new Error(done.error ?? done.status);
        downloadBlob(await service.stillFile(info.id), "anatomical-rendering.png");
      });
    } catch (e) {
      this.jobFailed("Still", e, () => void this.saveStill());
    } finally {
      this.stillRunning = false;
      this.panelUpdate?.();
    }
  }

  // ------------------------------------------------------------------ jobs
  /** A job the computer refused for now (its GPU busy, too many waiting, its disk nearly full): said in the status line, with Retry. */
  private refused: { text: string; retry: () => void } | undefined;

  /** A job that failed to start or ended badly: a refusal that may pass goes to the status line with Retry, anything else to a toast. */
  private jobFailed(what: string, e: unknown, retry: () => void): void {
    const r = refusal(e);
    if (r?.retry) {
      this.refused = { text: `${what}: ${r.text}`, retry };
      this.statusUpdate?.();
    } else this.ctx.ui.toast(`${what}: ${(e as Error).message}`, "error");
  }

  /** Records a job in the list kept in this browser, and shows it. */
  private recordJob(job: JobRecord): void {
    this.jobs = putJob(this.jobs, job);
    this.ctx.settings.set(JOBS_KEY, this.jobs);
    this.jobsUpdate?.();
  }

  private jobsUpdate: (() => void) | undefined;

  /**
   * Follows a job on its computer until it stops: its progress in the list
   * (kept in this browser) and in Activity's `job`, whose Cancel cancels it
   * on the computer.  A job the computer no longer knows is "gone".
   */
  private async follow(kind: JobKind, service: RenderService, first: { id: string; status: string; progress: number; message: string; error: string | null; files?: string[]; jobs_ahead?: number; ahead?: number }, name: string, job?: JobControl): Promise<JobRecord> {
    const host = service.link.label ?? "";
    const key = `${kind}:${host}:${first.id}`;
    const record = (i: typeof first): JobRecord => ({
      kind,
      id: first.id,
      host,
      name,
      status: i.status as JobRecord["status"],
      progress: i.progress,
      message: i.message,
      ...(i.error ? { error: i.error } : {}),
      ...(i.files ? { files: i.files } : {}),
      ...(i.status === "queued" && (i.jobs_ahead ?? i.ahead) !== undefined ? { ahead: i.jobs_ahead ?? i.ahead } : {}),
      started: this.jobs.find((j) => j.kind === kind && j.id === first.id && j.host === host)?.started ?? Date.now(),
    });
    let rec = record(first);
    this.recordJob(rec);
    void this.refreshInfo(service);
    this.following.add(key);
    let asked = false;
    try {
      while (!finished(rec.status) && !this.disposed) {
        if (job?.cancelled && !asked) {
          asked = true;
          await this.cancelJob(service, rec);
        }
        job?.progress(rec.progress, jobProgress(rec));
        await sleep(kind === "splat" ? 2000 : kind === "movie" ? 1000 : 500);
        try {
          const was = rec.status;
          rec = record(kind === "still" ? await service.stillInfo(first.id) : kind === "movie" ? await service.movieInfo(first.id) : await service.splatInfo(first.id));
          // A job started or ended: the Remote card's queue and budget change.
          if (rec.status !== was) void this.refreshInfo(service);
        } catch (e) {
          if (!(e instanceof ServiceError && e.status === 404)) throw e;
          rec = { ...rec, status: "gone" };
        }
        this.recordJob(rec);
      }
    } finally {
      this.following.delete(key);
    }
    return rec;
  }

  private cancelJob(service: RenderService, j: Pick<JobRecord, "kind" | "id">): Promise<unknown> {
    const cancel = j.kind === "still" ? service.cancelStill(j.id) : j.kind === "movie" ? service.cancelMovie(j.id) : service.cancelSplat(j.id);
    return cancel.catch(() => undefined);
  }

  /** After a reload (or connecting again): follows the jobs still running on this computer, in Activity too. */
  private resumeJobs(service: RenderService): void {
    const host = service.link.label ?? "";
    for (const j of this.jobs) {
      if (finished(j.status) || j.host !== host || this.following.has(`${j.kind}:${host}:${j.id}`)) continue;
      const title = `${j.kind === "still" ? "Still" : j.kind === "movie" ? "Movie" : "Splat"}: ${j.name}`;
      void this.ctx.jobs
        .run(title, (job) => this.follow(j.kind, service, { ...j, error: j.error ?? null }, j.name, job))
        .catch((e) => this.ctx.log.error(`${title}: ${(e as Error).message}`));
    }
  }

  /** The service a job runs on, when this page is connected to its computer. */
  private serviceFor(j: JobRecord): RenderService | undefined {
    return this.service !== undefined && this.serviceInfo !== undefined && (this.service.link.label ?? "") === j.host ? this.service : undefined;
  }

  /** Saves a finished job's file: the still's PNG, the movie's MP4, the splat. */
  private async download(j: JobRecord): Promise<void> {
    const service = this.serviceFor(j);
    if (service === undefined) return this.ctx.ui.toast(`Connect to ${j.host} first.`, "error");
    try {
      if (j.kind === "still") downloadBlob(await service.stillFile(j.id), "anatomical-rendering.png");
      else if (j.kind === "movie") downloadBlob(await service.movieFile(j.id), `${j.name}.mp4`);
      else downloadBlob(new Blob([await service.splatFile(j.id, "scene.splat")]), "anatomical-rendering.splat");
    } catch (e) {
      if (e instanceof ServiceError && e.status === 404) this.recordJob({ ...j, status: "gone" });
      this.ctx.ui.toast(`${j.name}: ${(e as Error).message}`, "error");
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
   * as a job (its progress in the panel and in Activity) while the view stays live.
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
      const bar = el("progress", { max: "1", value: "0", "aria-label": "Preview" }) as HTMLProgressElement;
      const note = el("span", { class: "muted" }, "Rendering a preview…");
      const stage = el("div", { class: "ar-preview" }, bar, note);
      const go = button(`Render the movie (${m.width}×${m.height}, ${m.samples} samples)`, () => {
        close();
        void this.movieJob(sid, this.movieSpec(extra, false));
      }, undefined, "btn primary");
      body.append(stage, el("div", { class: "row" }, go, info("It renders in the background, its progress in the Movie card and in Activity; the view stays live.", "About rendering the movie")));
      let open = true;
      void (async () => {
        try {
          preview = await service.movie(sid, this.movieSpec(extra, true));
          while (open && (preview.status === "queued" || preview.status === "running")) {
            bar.value = preview.progress;
            note.textContent = preview.status === "queued" || /^waiting/i.test(preview.message)
              ? `Preview ${jobProgress({ status: preview.status, progress: preview.progress, message: preview.message, ahead: preview.jobs_ahead })}`
              : preview.message || "Rendering a preview…";
            await new Promise((r) => setTimeout(r, 400));
            preview = await service.movieInfo(preview.id);
          }
          if (!open) return;
          if (preview.status !== "done") throw new Error(preview.error ?? preview.status);
          url = URL.createObjectURL(await service.movieFile(preview.id));
          if (!open) return;
          stage.replaceChildren(el("video", { src: url, autoplay: true, loop: true, muted: true, playsinline: true, controls: true, class: "ar-video" }));
        } catch (e) {
          if (!open) return;
          // Refused for now (the GPU busy, too many jobs waiting, the disk nearly full): Retry asks again.
          const r = refusal(e);
          stage.replaceChildren(el("p", { class: "empty error" }, r ? r.text : `The preview failed: ${(e as Error).message}`));
          if (r?.retry) stage.append(el("div", { class: "row" }, button("Retry", () => (close(), this.renderMovie(extra)))));
        }
      })();
      return () => {
        open = false;
        if (preview && (preview.status === "queued" || preview.status === "running")) void service.cancelMovie(preview.id).catch(() => undefined);
        if (url) URL.revokeObjectURL(url);
      };
    }, { wide: true });
  }

  /** The movie as a job: progress and cancel in the panel and in Activity; saved as a download when done. */
  private async movieJob(sid: string, spec: Record<string, unknown>): Promise<void> {
    const service = this.service!;
    const name = String(spec.name ?? "movie");
    try {
      await this.ctx.jobs.run(`Movie: ${name}`, async (job) => {
        const info = await service.movie(sid, spec);
        const done = await this.follow("movie", service, info, name, job);
        if (done.status !== "done") throw new Error(done.error ?? done.status);
        downloadBlob(await service.movieFile(info.id), `${name}.mp4`);
      });
    } catch (e) {
      this.jobFailed("Movie", e, () => void this.movieJob(this.session?.status === "ready" ? this.session.id : sid, spec));
    }
  }

  // ------------------------------------------------------------------ splats
  /**
   * Gaussian splats of the view on the host: the view's look (preset, colours, light held where it is,
   * cuts, crops) path-traced from all round it, then fitted; a job in the panel and in Activity while it runs.
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
    const name = `Splat of ${this.saved.layer ?? "the view"}`;
    try {
      const done = await this.ctx.jobs.run(name, async (job) => {
        const info = await service.splat(sid, { view: { ...view, scale: 1 }, views: sp.views, size: sp.size, samples: sp.samples, cover: sp.cover, steps: sp.steps, name: this.saved.layer ?? "view" });
        const rec = await this.follow("splat", service, info, name, job);
        if (rec.status !== "done") throw new Error(rec.error ?? rec.status);
        return rec;
      });
      if (done.files?.includes("scene.splat")) this.ctx.ui.toast(`Splat made: ${done.message}`);
    } catch (e) {
      this.jobFailed("Splat", e, () => void this.makeSplat());
    }
  }

  /** A finished splat, in a sheet over the page. */
  private async viewSplat(j: JobRecord): Promise<void> {
    const service = this.serviceFor(j);
    if (service === undefined) return this.ctx.ui.toast(`Connect to ${j.host} first.`, "error");
    try {
      const [data, cams] = await Promise.all([service.splatFile(j.id, "scene.splat"), service.splatFile(j.id, "cameras.json")]);
      const meta = JSON.parse(new TextDecoder().decode(cams)) as { centre: number[]; frames: { c2w: number[][]; fovy: number }[] };
      const camera: SplatCamera | undefined = meta.frames[0] ? { c2w: meta.frames[0].c2w, fovy: meta.frames[0].fovy, centre: meta.centre } : undefined;
      const save = (file: string, as: string) => () => void service.splatFile(j.id, file).then((b) => downloadBlob(new Blob([b]), as));
      showSplats(this.ctx.ui.sheet, j.name, parseSplat(data), camera, [
        ["Download .splat", save("scene.splat", "anatomical-rendering.splat")],
        ...(j.files?.includes("splat.ply") ? [["Download .ply", save("splat.ply", "anatomical-rendering.ply")] as [string, () => void]] : []),
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
        showSplats(this.ctx.ui.sheet, file.name, file.name.toLowerCase().endsWith(".ply") ? parsePly(data) : parseSplat(data), undefined);
      } catch (e) {
        this.ctx.ui.toast(`Splat file: ${(e as Error).message}`, "error");
      }
    };
    input.click();
  }

  // ------------------------------------------------------------------ panel
  /**
   * What the status line says: an error (with what mends it), else work
   * under way (the image loading); nothing otherwise.  What the panel shows
   * already (the GPU, Render off, the level, samples) is not repeated.
   */
  private status(): { error?: string; action?: "retry" | "pair" | "again"; progress?: string } {
    const host = this.saved.where === "host";
    if (host && this.connectProblem && this.connecting === undefined) return { error: this.connectProblem, action: this.service === undefined ? "pair" : "retry" };
    const s = host ? this.session : undefined;
    if (this.problem) return { error: this.problem, action: "retry" };
    if (s?.status === "failed") return { error: `Failed: ${s.error ?? "unknown error"}`, action: "retry" };
    if (this.refused) return { error: this.refused.text, action: "again" };
    if (!this.saved.on) return {};
    if (host && this.connecting !== undefined) return { progress: `Connecting to ${this.link()?.label ?? "the render computer"}…` };
    if (s?.status === "loading") return { progress: `Loading: ${s.message} (${Math.round(s.progress * 100)}%)` };
    if (!host && this.local && !this.local.ready && this.localText) return { progress: this.localText };
    return {};
  }

  /** What is rendered now, for the Quality card: the level held, and the frame's samples, size and speed. */
  private readout(): string {
    const lines: string[] = [];
    const s = this.session;
    if (this.saved.where === "host" && s?.status === "ready") {
      const v = s.volume as SessionInfo["volume"] & { made?: boolean; from_cache?: boolean };
      lines.push(`${s.message}${v.made ? (v.from_cache ? " (made here, from the cache)" : " (made here by downsampling)") : ""}`);
    }
    if (this.saved.where === "browser" && this.local?.ready) lines.push(this.localText);
    if (this.frameText) lines.push(this.frameText);
    return lines.join("\n");
  }

  private panel(host: HTMLElement): Disposer {
    const ctx = this.ctx;
    const saved = () => this.saved;
    const openData = { label: "Open data…", run: () => void ctx.commands.invoke("dataset.add") };
    const hostOnly: HTMLElement[] = [];
    const onHost = <E extends HTMLElement>(e: E): E => (hostOnly.push(e), e);

    // ---------------------------------------------------------------- head
    const onSwitch = toggle("Render", saved().on, (v) => this.setOn(v));
    const status = statusLine();
    const empty = emptyState("No OME-Zarr or N5 image in this scene.", openData);
    const views = region((buttons: ViewButton[]) => [
      button("Centre", () => this.centreOnTissue()),
      ...buttons.map((v) => el("button", { class: "btn outline small", type: "button", title: `Look from ${v.name}`, "aria-label": `Look from ${v.name}`, onclick: () => this.lookFrom(v) }, v.label)),
      info(
        buttons[0]?.label.startsWith("+")
          ? "Centre moves to the middle of the tissue and zooms to show all of it. The others look from each end of x, y and z: the image's metadata does not give its anatomical orientation (in RAS, +x is right, +y anterior and +z superior)."
          : "Centre moves to the middle of the tissue and zooms to show all of it. The others look from each side of the image, as its metadata names them.",
        "About the view buttons",
      ),
    ], { class: "row" });

    // -------------------------------------------------------------- Remote
    const where = select([["host", "A computer's GPU (CUDA)"], ["browser", "This browser (WebGPU)"]], saved().where, (v) => {
      this.save((x) => (x.where = v as Saved["where"]));
      this.update();
    }, "Where");
    const computer = choices((v) => {
      this.host = { name: v || undefined };
      ctx.settings.set(HOST_KEY, this.host);
      void this.connect();
    }, "Computer");
    const gpu = onHost(el("p", { class: "readout" }));
    const reconnect = button("Reconnect", () => void this.connect());
    const remote = card("anatomical.remote", "Remote", { open: true },
      field("Where", where),
      onHost(field("Computer", computer)),
      gpu,
      onHost(el("div", { class: "row" }, button("Pair a computer…", () => void ctx.commands.invoke(COMPUTE_SETTINGS.command, COMPUTE_SETTINGS.args)), reconnect)),
    );

    // ----------------------------------------------------------- Rendering
    const image = choices((v) => this.save((x) => (x.layer = v)), "Image");
    const imageNote = el("p", { class: "hint" });
    // An image with several channels or time points: which one is rendered (another opens a new session).
    let channelChoice: Settable<HTMLSelectElement, string> | undefined;
    let timeChoice: Slider | undefined;
    const volumePart = region((n: { channels: number; times: number } | undefined) => {
      channelChoice = timeChoice = undefined;
      if (n === undefined) return null;
      const target = () => this.target();
      const at = target() ? this.volumeAt(target()!) : { channel: 0, time: 0 };
      if (n.channels > 1) {
        channelChoice = select(Array.from({ length: n.channels }, (_, i): [string, string] => [String(i), String(i)]), String(at.channel), (v) => {
          const t = target();
          if (t) this.setVolumeAt(t, { channel: Number(v) });
        }, "Channel");
      }
      if (n.times > 1) {
        timeChoice = slider(at.time, { min: 0, max: n.times - 1, step: 1, label: "Time point", onchange: (v) => {
          const t = target();
          if (t) this.setVolumeAt(t, { time: Math.round(v) });
        } });
      }
      return [
        channelChoice && field("Channel", channelChoice, { info: `This image has ${n.channels} channels, numbered from 0: one is rendered at a time.` }),
        timeChoice && field("Time point", timeChoice, { info: `This image has ${n.times} time points, numbered from 0: one is rendered at a time.` }),
      ];
    }, { class: "stack" });
    const preset = choices((v) => this.save((x) => (x.preset = v)), "Preset");
    const references = region((refs: ReturnType<AnatomicalRendering["references"]>) =>
      refs.length === 0
        ? null
        : el("p", { class: "hint" },
            "Colours from ",
            ...refs.flatMap((r, i) => [i ? ", " : "", r.page ? el("a", { href: r.page, target: "_blank", rel: "noopener" }, `photo ${i + 1}`) : `photo ${i + 1}`]),
            " ",
            info(refs.map((r) => `${r.title} (${r.author}${r.licence ? `, ${r.licence}` : ""})`).join("; "), "About the photographs")),
    );
    let windowSliders: [Slider, Slider] | undefined;
    const windowPart = region((w: ReturnType<AnatomicalRendering["windowRange"]>) => {
      windowSliders = undefined;
      if (w === undefined) return null;
      const now = this.saved.windows[w.src] ?? w.guess;
      const end = (i: 0 | 1, label: string) => slider(now ? now[i] : i, { min: w.lo, max: w.hi, step: w.step, label, onchange: (v) => this.setWindow(w.src, i, v, w.guess) });
      windowSliders = [end(0, "Window low"), end(1, "Window high")];
      return field("Window", el("div", { class: "stack" },
        windowSliders[0], windowSliders[1],
        el("div", { class: "row" }, button("Guess", () => this.save((x) => delete x.windows[w.src])))),
        { info: "The image values the preset's colours are spread over, low and high. Guess goes back to the computer's guess: from just past the mounting medium, with the commonest tissue value at the middle." });
    });
    const shift = slider(0, { min: -1, max: 1, step: 0.01, label: "Shift", oninput: (v) => this.tune((n) => (n.shift = v * this.mapWidth()), true), onchange: (v) => this.tune((n) => (n.shift = v * this.mapWidth())) });
    const compress = slider(1, { min: 0.4, max: 2.5, step: 0.01, label: "Compress", oninput: (v) => this.tune((n) => (n.scale = v), true), onchange: (v) => this.tune((n) => (n.scale = v)) });
    const editorPart = region((on: boolean) =>
      on
        ? [
            field("Colourmap", this.colourmapEditor().element, { info: "The image's histogram (grey) under the preset's colours and opacity. Drag a point: left and right moves it, up and down its opacity. Double-click to colour it, Ctrl-click to add one, right-click to remove one. The blue triangles under the histogram slide and warp it under the colours." }),
            field("Shift", shift, { info: "Moves the whole map along the values (a fraction of its width)." }),
            field("Compress", compress, { info: "Narrows (below 1) or widens (above 1) the map about its middle." }),
            el("div", { class: "row" },
              button("Reset", () => {
                const cur = this.currentTuning();
                if (cur) this.save((x) => delete x.tunings[cur.src]);
                this.editorUpdate?.();
              }),
              button("Save as a preset file", () => {
                const p = this.tunedPreset() ?? this.resolved?.preset;
                if (!p) return;
                const name = `${String(p.name ?? "preset")} (tuned)`;
                downloadBlob(new Blob([JSON.stringify([{ ...p, name }], null, 1)], { type: "application/json" }), "preset.json");
              }),
              info("Reset goes back to the preset as it falls on this image. Save as a preset file writes the map as tuned, at this image's values, to load again with Load…", "About the colourmap's buttons")),
          ]
        : null,
    { class: "stack" });
    const density = slider(40, { min: 0, max: 200, label: "Density", unit: "/mm", oninput: (v) => this.preview((x) => (x.density = v)), onchange: (v) => this.save((x) => (x.density = v)) });
    const exposure = slider(1, { min: 0, max: 5, step: 0.05, label: "Exposure", oninput: (v) => this.preview((x) => (x.exposure = v)), onchange: (v) => this.save((x) => (x.exposure = v)) });
    const jar = onHost(checkbox("Hide the jar", false, (v) => {
      this.save((x) => (x.jar = v));
      this.update();
    }, { info: "Renders only a cylinder about the scan's axis, leaving out the jar's wall (HiP-CT organs in their jars)." }));
    const rendering = card("anatomical.rendering", "Rendering", { open: true },
      field("Image", image),
      imageNote,
      volumePart,
      el("div", { class: "row" },
        field("Preset", preset, { info: "A look per modality or organ. Load… reads a preset (or a list of them) from a JSON file: a name, a domain, stops of value, colour and opacity, and the material." }),
        button("Load…", () => this.loadPresetFile())),
      references,
      windowPart,
      editorPart,
      field("Density", density, { info: "How opaque the tissue is: higher gives crisper surfaces, lower more translucent ones." }),
      field("Exposure", exposure),
      jar,
    );

    // ------------------------------------------------------------- Regions
    const regionsEmpty = emptyState("No OME-Zarr segmentation in this scene.", openData);
    const colourBy = checkbox("Colour by region", false, (v) => this.save((x) => (x.regions = v)));
    const segmentation = choices((v) => this.save((x) => (x.labels = v)), "Segmentation");
    const labelMix = slider(0.85, { min: 0, max: 1, step: 0.05, label: "Region colour", oninput: (v) => this.preview((x) => (x.labelMix = v)), onchange: (v) => this.save((x) => (x.labelMix = v)) });
    const hidden = idsInput([], (v) => this.save((x) => (x.hidden = v)), "Hidden regions");
    const keep = idsInput([], (v) => this.save((x) => (x.keep = v)), "Kept whole");
    const regionsBody = el("div", { class: "stack" },
      field("Segmentation", segmentation),
      colourBy,
      field("Region colour", labelMix, { info: "0 keeps the preset's colours; 1 gives each region its own." }),
      field("Hidden regions", hidden, { info: "Label ids left out, with spaces or commas between." }),
      field("Kept whole", keep, { info: "Label ids that stay whole where the crops cut (vessels through a cut brain)." }),
    );
    const regions = card("anatomical.regions", "Regions", {}, regionsEmpty, regionsBody);

    // ------------------------------------------------------------- Quality
    const budget = slider(400, { min: 10, max: 2000, step: 10, unit: "M voxels", label: "Whole volume", onchange: (v) => this.save((x) => (x.budget = Math.max(1, v) * 1e6)) });
    const detail = onHost(checkbox("Finer detail", true, (v) => {
      this.save((x) => (x.detail = v));
      this.update();
    }, { info: "Where the view comes close, the region in view is read at a finer level; shadows and light from outside it stay at the whole volume's." }));
    const detailBudget = slider(200, { min: 10, max: 2000, step: 10, unit: "M voxels", label: "Detail", onchange: (v) => {
      this.save((x) => (x.detailBudget = Math.max(1, v) * 1e6));
      this.update();
    } });
    const detailField = field("Detail", detailBudget, { info: "The voxels the finer region may hold." });
    const denoise = checkbox("Denoise", true, (v) => this.save((x) => (x.denoise = v)), { info: "Smooths the first frames after the view changes (the computer's denoiser)." });
    const samples = slider(512, { min: 16, max: 4096, step: 16, label: "Samples per pixel", onchange: (v) => this.save((x) => (x.maxSamples = Math.max(1, Math.round(v)))) });
    const frameReadout = el("p", { class: "readout" });
    const quality = card("anatomical.quality", "Quality", {},
      field("Whole volume", budget, { info: "One level of the whole image on the GPU: the finest stored level within this, or one made from a finer level." }),
      detail,
      detailField,
      denoise,
      field("Samples per pixel", samples, { info: "Where a still view stops refining." }),
      frameReadout,
    );

    // ------------------------------------------------------------ Lighting
    const lightStyle = choices((v) =>
      this.save((x) => {
        x.lightStyle = v;
        const l = LIGHTING[v];
        if (l) [x.lightMap, x.envScale, x.lightKey] = [l.map, l.envScale, l.key];
      }), "Style");
    lightStyle.update([["", "Custom"], ...Object.entries(LIGHTING).map(([k, l]): [string, string] => [k, l.name])], saved().lightStyle);
    const around = slider(30, { min: -180, max: 180, step: 5, unit: "°", label: "Around", oninput: (v) => this.preview((x) => (x.lightAzimuth = v)), onchange: (v) => this.save((x) => (x.lightAzimuth = v)) });
    const up = slider(40, { min: -90, max: 90, step: 5, unit: "°", label: "Up", oninput: (v) => this.preview((x) => (x.lightElevation = v)), onchange: (v) => this.save((x) => (x.lightElevation = v)) });
    const key = slider(1, { min: 0, max: 4, step: 0.05, label: "Key light", oninput: (v) => this.preview((x) => (x.lightKey = v)), onchange: (v) => this.save((x) => ((x.lightKey = v), (x.lightStyle = ""))) });
    const surroundings = slider(1, { min: 0, max: 3, step: 0.05, label: "Surroundings", oninput: (v) => this.preview((x) => (x.envScale = v)), onchange: (v) => this.save((x) => ((x.envScale = v), (x.lightStyle = ""))) });
    const lightMap = choices((v) => this.save((x) => (x.lightMap = v)), "Light map");
    const mapTurn = slider(0, { min: -180, max: 180, step: 5, unit: "°", label: "Turn the light map", oninput: (v) => this.preview((x) => (x.lightMapRotation = v)), onchange: (v) => this.save((x) => (x.lightMapRotation = v)) });
    const mapPart = el("div", { class: "stack" }, field("Light map", lightMap, { info: "HDR panoramas (CC0, Poly Haven), or the preset's sky colours." }), field("Turn", mapTurn));
    const lighting = card("anatomical.lighting", "Lighting", {},
      onHost(field("Style", lightStyle)),
      field("Around", around, { info: "The key light turns with the camera: 0 lights from the camera, 90 from the right, -90 from the left." }),
      field("Up", up, { info: "90 lights from above, -90 from below." }),
      onHost(field("Key light", key, { info: "The light that makes shadows." })),
      onHost(field("Surroundings", surroundings, { info: "Light from all round: the light map, or the sky colours." })),
      mapPart,
    );

    // --------------------------------------------------------------- Crops
    const toCursor = button("Move to the cursor", () => {
      const o = this.cursorOffsets();
      if (!o) return ctx.ui.toast("Point at the tissue in the 3-D view first.", "error");
      this.save((x) => {
        const names = this.lastFrame!.dimensions.names;
        for (const c of x.cuts) {
          const k = names.indexOf(c.axis);
          if (c.on && k >= 0 && k < 3) c.offset = o.axis[k];
        }
        if (x.viewCut.on) x.viewCut = { ...x.viewCut, offset: o.view, fixed: null };
      });
    });
    const viewCutOn = checkbox("Camera plane", false, (v) =>
      this.save((x) => {
        // Turned on, it starts through the point the cursor was last over.
        const o = v ? this.cursorOffsets() : undefined;
        x.viewCut = { ...x.viewCut, on: v, ...(o ? { offset: o.view, fixed: null } : {}) };
      }), { info: "A clip across the view, keeping what lies beyond it. It turns with the camera; Pin keeps it where it is now (an oblique clip), Follow lets it turn again." });
    const viewOffset = slider(0, { min: -100, max: 100, step: 0.5, unit: "mm", label: "Camera plane offset", unbounded: true, onchange: (v) => this.save((x) => (x.viewCut = { ...x.viewCut, offset: v, fixed: null })) });
    const pin = button("Pin", () => {
      if (this.saved.viewCut.fixed) return this.save((x) => (x.viewCut = { ...x.viewCut, fixed: null }));
      const f = this.lastFrame;
      if (!f) return ctx.ui.toast("Render a view first.", "error");
      this.save((x) => (x.viewCut = { ...x.viewCut, on: true, fixed: viewCutPlane(f.invViewProjection, f.position, x.viewCut.offset, f.dimensions) }));
    });
    const cutControls = saved().cuts.map((c, i) => {
      const on = checkbox(`Across ${c.axis}`, c.on, (v) =>
        this.save((x) => {
          x.cuts[i].on = v;
          // A cut turned on starts through the point the cursor was last over (the axis's display index).
          const o = v ? this.cursorOffsets() : undefined;
          const k = this.lastFrame?.dimensions.names.indexOf(x.cuts[i].axis) ?? -1;
          if (o && k >= 0 && k < 3) x.cuts[i].offset = o.axis[k];
        }));
      const side = select([["-1", "keep −"], ["1", "keep +"]], String(c.keep), (v) => this.save((x) => (x.cuts[i].keep = Number(v) as 1 | -1)), `Side kept across ${c.axis}`);
      const offset = slider(c.offset, { min: -100, max: 100, step: 0.5, unit: "mm", label: `Offset across ${c.axis}`, unbounded: true, onchange: (v) => this.save((x) => (x.cuts[i].offset = v)) });
      return { on, side, offset, row: el("div", { class: "ar-cut" }, on, side, offset) };
    });
    let boxControls: { on: ReturnType<typeof toggle>; name: Settable<HTMLInputElement, string>; keep: Settable<HTMLSelectElement, string>; ends: [Slider, Slider][] }[] = [];
    const boxes = region((count: number) => {
      boxControls = [];
      return Array.from({ length: count }, (_, i) => {
        const b = this.saved.boxes[i];
        const on = toggle(`Box ${i + 1}`, b.on, (v) => this.save((x) => (x.boxes[i].on = v)), { hideLabel: true });
        const name = el("input", { class: "text-input ar-grow", type: "text", value: b.name, "aria-label": `Name of box ${i + 1}` }) as Settable<HTMLInputElement, string>;
        name.onchange = () => this.save((x) => (x.boxes[i].name = name.value));
        name.set = (v) => {
          if (name.ownerDocument.activeElement !== name && name.value !== v) name.value = v;
        };
        const keepIt = select([["keep", "keep inside"], ["cut", "cut out"]], b.keep ? "keep" : "cut", (v) => this.save((x) => (x.boxes[i].keep = v === "keep")), `Box ${i + 1} keeps`);
        const ends = (["x", "y", "z"] as const).map((axis, k): [Slider, Slider] => [
          slider(b.lo[k], { min: 0, max: 1, step: 0.005, label: `Box ${i + 1} low ${axis}`, onchange: (v) => this.save((x) => (x.boxes[i].lo[k] = Math.min(v, x.boxes[i].hi[k] - 0.005))) }),
          slider(b.hi[k], { min: 0, max: 1, step: 0.005, label: `Box ${i + 1} high ${axis}`, onchange: (v) => this.save((x) => (x.boxes[i].hi[k] = Math.max(v, x.boxes[i].lo[k] + 0.005))) }),
        ]);
        boxControls.push({ on, name, keep: keepIt, ends });
        return el("div", { class: "ar-box" },
          el("div", { class: "row" }, on, name, keepIt, iconButton("trash", `Remove box ${i + 1}`, () => this.save((x) => x.boxes.splice(i, 1)))),
          el("div", { class: "ar-box-axes" }, ...ends.flatMap(([lo, hi], k) => [el("span", {}, "xyz"[k]), lo, hi])));
      });
    }, { class: "stack" });
    const addBox = button("Add a box", () => {
      if (this.saved.boxes.length >= LIMITS.maxBoxes) return;
      this.save((x) => x.boxes.push({ name: `Box ${x.boxes.length + 1}`, on: true, keep: true, lo: [0, 0, 0], hi: [1, 1, 1] }));
    });
    const crops = card("anatomical.crops", "Crops", { info: `Clips and boxes. A clip turned on starts through the point the cursor was last over in the 3-D view; Move to the cursor moves the clips that are on there. Boxes (up to ${LIMITS.maxBoxes}) are fractions of the volume along x, y and z; what shows is inside any box that keeps and in none that cuts out.` },
      el("div", { class: "row" }, toCursor),
      viewCutOn,
      el("div", { class: "row" }, el("div", { class: "ar-grow" }, viewOffset), pin),
      el("h4", { class: "section-title" }, "Axis planes"),
      ...cutControls.map((c) => c.row),
      el("h4", { class: "section-title" }, "Boxes"),
      boxes,
      el("div", { class: "row" }, addBox),
    );

    // -------------------------------------------------------------- Output
    const sizeField = (label: string, get: (m: Saved["movie"]) => number, fix: (v: number) => number, set: (m: Saved["movie"], v: number) => void, attrs: Record<string, string>) => {
      const input = bounded(get(saved().movie), fix, (v) => this.save((x) => set(x.movie, v)), { "aria-label": label, ...attrs });
      return { input, field: field(label, input) };
    };
    const width = sizeField("Width", (m) => m.width, evenSide, (m, v) => (m.width = v), { min: "8", max: "8192", step: "2" });
    const height = sizeField("Height", (m) => m.height, evenSide, (m, v) => (m.height = v), { min: "8", max: "8192", step: "2" });
    const outSamples = sizeField("Samples", (m) => m.samples, (v) => clampInt(v, 1, LIMITS.maxSamples), (m, v) => (m.samples = v), { min: "1", max: String(LIMITS.maxSamples) });
    const still = button("Save still (PNG)", () => void this.saveStill());
    const noFfmpeg = el("p", { class: "hint" }, NO_FFMPEG);
    const jobList = (_kind: JobKind) =>
      region((jobs: JobRecord[]) =>
        jobs.map((j) => {
          const service = this.serviceFor(j);
          const actions: HTMLElement[] = [];
          if (!finished(j.status) && service) actions.push(button("Cancel", () => void this.cancelJob(service, j)));
          if (j.status === "done" && j.kind === "splat" && j.files?.includes("scene.splat")) actions.push(button("View", () => void this.viewSplat(j)));
          if (j.status === "done" && (j.kind !== "splat" || j.files?.includes("scene.splat"))) actions.push(button("Download", () => void this.download(j)));
          if (finished(j.status)) actions.push(iconButton("close", `Remove ${j.name} from the list`, () => ((this.jobs = dropJob(this.jobs, j)), ctx.settings.set(JOBS_KEY, this.jobs), this.jobsUpdate?.())));
          return el("li", { class: "ar-job" }, el("span", { class: "readout" }, jobText(j)), ...actions);
        }),
      { class: "list" });
    const stills = jobList("still");
    const output = card("anatomical.output", "Output", { info: "The size and samples of stills and movies. A still is path-traced on the computer to twice the samples, as a job: its progress here and in Activity, and it downloads when done." },
      el("div", { class: "row" }, width.field, height.field, outSamples.field),
      el("div", { class: "row" }, still),
      onHost(noFfmpeg),
      stills,
    );

    // --------------------------------------------------------------- Movie
    let keyframeTimes: Settable<HTMLInputElement, number>[] = [];
    const keyframes = region((count: number) => {
      keyframeTimes = [];
      return Array.from({ length: count }, (_, i) => {
        const time = numberInput(this.saved.keyframes[i].time, (v) => this.save((x) => (x.keyframes[i].time = v)), { step: "0.5", "aria-label": `Time of keyframe ${i + 1}` });
        keyframeTimes.push(time);
        const moveBy = (by: -1 | 1) => () => this.save((x) => (x.keyframes = moveKeyframe(x.keyframes, i, by)));
        return el("li", { class: "row" },
          el("span", { class: "muted" }, `#${i + 1} at`), time, el("span", { class: "muted" }, "s"),
          button("Go to", () => this.goToKeyframe(i)),
          button("Replace", () => this.addKeyframe(i)),
          iconButton("arrow-up", `Move keyframe ${i + 1} earlier`, moveBy(-1), { disabled: i === 0 }),
          iconButton("arrow-down", `Move keyframe ${i + 1} later`, moveBy(1), { disabled: i === count - 1 }),
          iconButton("trash", `Remove keyframe ${i + 1}`, () => this.save((x) => x.keyframes.splice(i, 1))));
      });
    }, { class: "list" });
    const fps = bounded(saved().movie.fps, (v) => clampInt(v, 1, LIMITS.maxFps), (v) => this.save((x) => (x.movie.fps = v)), { min: "1", max: String(LIMITS.maxFps), "aria-label": "Frames a second" });
    const easing = select([["smooth", "slows at keyframes"], ["linear", "steady"]], saved().movie.easing, (v) => this.save((x) => (x.movie.easing = v as "smooth" | "linear")), "Camera");
    const rotAxis = select([["vertical", "the vertical"], ["horizontal", "the horizontal"]], saved().rotation.axis, (v) => this.save((x) => (x.rotation.axis = v as "vertical" | "horizontal")), "About");
    const rotTurn = select([["360", "full turn"], ["180", "half turn"]], String(saved().rotation.degrees), (v) => this.save((x) => (x.rotation.degrees = Number(v))), "Turn");
    const rotStep = bounded(saved().rotation.step, (v) => Math.min(90, Math.max(0.25, v)), (v) => this.save((x) => (x.rotation.step = v)), { step: "1", min: "0.25", max: "90", "aria-label": "Step (degrees)" });
    const movies = jobList("movie");
    const movie = card("anatomical.movie", "Movie", { info: "Add keyframes as you move, set each one's time, then preview: a small, quick version plays in a window, and from there the movie renders in the background at the Output card's size and samples. Go to moves the view back to a keyframe; Replace puts the view now in its place." },
      keyframes,
      el("div", { class: "row" },
        button("Add keyframe", () => this.addKeyframe()),
        field("fps", fps),
        field("Camera", easing)),
      el("div", { class: "row" }, button("Preview movie…", () => this.renderMovie())),
      el("h4", { class: "section-title" }, "Rotation"),
      el("div", { class: "row" }, field("About", rotAxis), field("Turn", rotTurn), field("Step °", rotStep)),
      el("div", { class: "row" }, button("Preview rotation…", () => void this.renderRotation())),
      movies,
    );

    // --------------------------------------------------------------- Splat
    const cannotFit = onHost(el("p", { class: "hint" }));
    const splatField = (label: string, get: (s: Saved["splat"]) => number, lo: number, hi: number, set: (s: Saved["splat"], v: number) => void, help?: string) => {
      const input = bounded(get(saved().splat), (v) => clampInt(v, lo, hi), (v) => this.save((x) => set(x.splat, v)), { min: String(lo), max: String(hi), "aria-label": label });
      return { input, field: field(label, input, help ? { info: help } : undefined) };
    };
    const splatViews = splatField("Views", (p) => p.views, 8, 4096, (p, v) => (p.views = v));
    const splatSize = splatField("Size", (p) => p.size, 64, 4096, (p, v) => (p.size = v), "Pixels along the longer side of each view.");
    const splatSamples = splatField("Samples", (p) => p.samples, 1, 8192, (p, v) => (p.samples = v));
    const splatSteps = splatField("Fit steps", (p) => p.steps, 0, 200000, (p, v) => (p.steps = v), "0 renders the views only.");
    const splatCover = select([["180", "every side"], ["90", "this half"], ["50", "near this side"]], String(saved().splat.cover), (v) => this.save((x) => (x.splat.cover = Number(v))), "From");
    const splats = jobList("splat");
    const splat = card("anatomical.splat", "Splat", { info: "The look now, path-traced from all round and fitted with 3-D Gaussians that any browser, phone or headset draws at full speed." },
      cannotFit,
      el("div", { class: "row" }, splatViews.field, splatSize.field, splatSamples.field, field("From", splatCover), splatSteps.field),
      el("div", { class: "row" },
        button("Make splat", () => void this.makeSplat()),
        button("Open file…", () => this.openSplatFile()),
        info("Make splat runs on the computer that renders. Open file… views a .splat or a 3-D Gaussian splatting .ply from this device.", "About splats")),
      splats,
    );

    host.append(
      el("div", { class: "row" }, onSwitch),
      empty,
      status,
      views,
      remote, rendering, regions, quality, lighting, crops, output, movie, splat,
    );

    // --------------------------------------------------------------- sync
    let lastStatus = "";
    this.statusUpdate = () => {
      const st = this.status();
      const key = JSON.stringify(st);
      if (key !== lastStatus) {
        lastStatus = key;
        if (st.error !== undefined) {
          status.error(st.error, st.action === "pair"
            ? { label: "Pair a computer…", run: () => void ctx.commands.invoke(COMPUTE_SETTINGS.command, COMPUTE_SETTINGS.args) }
            : st.action === "again"
              ? { label: "Retry", run: () => this.retryJob() }
              : { label: "Retry", run: () => this.retry() });
        } else if (st.progress !== undefined) status.progress(st.progress);
        else status.clear();
      }
      const text = this.readout();
      if (frameReadout.textContent !== text) frameReadout.textContent = text;
      frameReadout.hidden = text === "";
    };
    this.jobsUpdate = () => {
      for (const [kind, list] of [["still", stills], ["movie", movies], ["splat", splats]] as const) list.update(this.jobs.filter((j) => j.kind === kind));
    };
    this.editorUpdate = () => {
      const e = this.editedStops();
      const hist = (this.session?.volume as { histogram?: { lo: number; hi: number; counts: number[] } } | undefined)?.histogram;
      if (e && this.editor && !this.editor.dragging) this.editor.set(hist, e.stops, e.warp);
    };
    let wasConnected = true;
    const sync = () => {
      const s = this.saved;
      const imgs = this.images();
      const target = this.target();
      const onHost_ = s.where === "host";
      const axes = target ? this.axesOf(target) : {};
      for (const e of hostOnly) e.hidden = !onHost_;

      // The head: the switch, an empty scene's action, the view buttons.
      onSwitch.set(s.on);
      onSwitch.input.disabled = imgs.length === 0;
      empty.hidden = imgs.length > 0;
      views.update(imgs.length ? this.viewButtons() : []);
      views.hidden = imgs.length === 0;

      // Remote: opened when it needs doing (no computer answers).
      const connected = !onHost_ || this.serviceInfo !== undefined;
      if (!connected && wasConnected && this.connecting === undefined) remote.open = true;
      wasConnected = connected || this.connecting !== undefined;
      where.set(s.where);
      const hosts = this.renderHosts();
      const using = this.link()?.label;
      computer.update(
        [["", `Automatic${!this.host.name && using ? `: ${using}` : ""}`], ...hosts.map((h): [string, string] => [h.name, `${h.name}${h.info?.hostname && h.info.hostname !== h.name ? ` (${h.info.hostname})` : ""}${h.available ? "" : ": not answering"}`])],
        hosts.some((h) => h.name === this.host.name) ? this.host.name! : "",
      );
      const g = this.serviceInfo?.gpu;
      gpu.textContent = this.serviceInfo === undefined ? "" : serviceText(this.serviceInfo);
      gpu.hidden = !onHost_ || g === undefined;
      reconnect.hidden = hosts.length === 0;

      // Rendering.
      rendering.hidden = imgs.length === 0;
      image.update(imgs.map((l) => [l.name, l.name]), target?.name ?? "");
      imageNote.textContent = axes.problem ?? "";
      const counts = target && axes.problem === undefined ? this.volumeCounts(target) : undefined;
      volumePart.update(counts);
      volumePart.hidden = counts === undefined;
      if (target && counts) {
        const at = this.volumeAt(target);
        channelChoice?.set(String(at.channel));
        timeChoice?.set(at.time);
      }
      imageNote.hidden = imageNote.textContent === "";
      imageNote.className = axes.problem !== undefined ? "hint error" : "hint";
      const presetList = s.where === "browser" ? LOCAL_PRESETS.map((p) => ({ name: p.name, modality: p.modality ?? "" })) : this.presets;
      const allPresets = [...presetList, ...s.customPresets.map((p) => ({ name: String(p.name), modality: "from a file" }))];
      preset.update(allPresets.map((p): [string, string] => [p.name, p.modality ? `${p.name} (${p.modality})` : p.name]), s.preset);
      preset.disabled = allPresets.length === 0;
      references.update(this.references());
      const w = this.windowRange();
      windowPart.update(w);
      if (w && windowSliders) {
        const now = s.windows[w.src] ?? w.guess;
        if (now) windowSliders.forEach((sl, i) => sl.set(now[i]));
      }
      // The colourmap editor once the computer has placed the preset on this image's values.
      const tuning = onHost_ && this.session?.status === "ready" ? this.currentTuning() : undefined;
      editorPart.update(tuning !== undefined);
      if (tuning) {
        const width = this.mapWidth();
        shift.set(width ? tuning.tuning.shift / width : 0);
        compress.set(tuning.tuning.scale);
        this.editorUpdate?.();
        void this.resolvePreset();
      }
      density.set(s.density ?? Number(this.presets.find((p) => p.name === s.preset)?.density ?? 40));
      exposure.set(s.exposure);
      jar.set(s.jar);

      // Regions (a computer's renderer only: this browser's has no region colours).
      const segs = this.segmentations();
      regions.hidden = !onHost_ || imgs.length === 0;
      regionsEmpty.hidden = segs.length > 0;
      regionsBody.hidden = segs.length === 0;
      segmentation.update(segs.map((l) => [l.name, l.name]), segs.find((x) => x.name === s.labels)?.name ?? segs[0]?.name ?? "");
      colourBy.set(s.regions);
      labelMix.set(s.labelMix);
      hidden.set(s.hidden);
      keep.set(s.keep);

      // Quality.
      quality.hidden = imgs.length === 0;
      budget.set(s.budget / 1e6);
      detail.set(s.detail);
      detailField.hidden = !onHost_ || !s.detail;
      detailBudget.set(s.detailBudget / 1e6);
      denoise.set(s.denoise);
      samples.set(s.maxSamples);

      // Lighting.
      lighting.hidden = imgs.length === 0;
      lightStyle.set(s.lightStyle);
      around.set(s.lightAzimuth);
      up.set(s.lightElevation);
      key.set(s.lightKey);
      surroundings.set(s.envScale);
      const maps = this.serviceInfo?.lightmaps ?? [];
      mapPart.hidden = !onHost_ || maps.length === 0;
      lightMap.update([["", "Sky colours"], ...maps.map((m): [string, string] => [m, m])], s.lightMap);
      mapTurn.set(s.lightMapRotation);

      // Crops.
      crops.hidden = imgs.length === 0;
      viewCutOn.set(s.viewCut.on);
      viewOffset.set(s.viewCut.offset);
      pin.textContent = s.viewCut.fixed ? "Follow" : "Pin";
      cutControls.forEach((c, i) => {
        c.on.set(s.cuts[i].on);
        c.side.set(String(s.cuts[i].keep));
        c.offset.set(s.cuts[i].offset);
      });
      boxes.update(s.boxes.length);
      boxControls.forEach((c, i) => {
        const b = s.boxes[i];
        c.on.set(b.on);
        c.name.set(b.name);
        c.keep.set(b.keep ? "keep" : "cut");
        c.ends.forEach(([lo, hi], k) => (lo.set(b.lo[k]), hi.set(b.hi[k])));
      });
      addBox.disabled = s.boxes.length >= LIMITS.maxBoxes;

      // Output, Movie and Splat.
      output.hidden = movie.hidden = splat.hidden = imgs.length === 0;
      width.input.set(evenSide(s.movie.width));
      height.input.set(evenSide(s.movie.height));
      outSamples.input.set(clampInt(s.movie.samples, 1, LIMITS.maxSamples));
      still.disabled = this.stillRunning;
      still.textContent = this.stillRunning ? "Rendering still…" : "Save still (PNG)";
      noFfmpeg.hidden = !onHost_ || this.serviceInfo?.ffmpeg !== false;
      keyframes.update(s.keyframes.length);
      keyframeTimes.forEach((t, i) => t.set(s.keyframes[i].time));
      fps.set(clampInt(s.movie.fps, 1, LIMITS.maxFps));
      easing.set(s.movie.easing);
      rotAxis.set(s.rotation.axis);
      rotTurn.set(String(s.rotation.degrees));
      rotStep.set(s.rotation.step);
      const fit = this.serviceInfo?.splats;
      cannotFit.textContent = fit && !fit.ready ? `Views only: this computer cannot fit (${fit.error ?? "no splat Python"}).` : fit?.warning ? `${fit.warning}.` : "";
      cannotFit.hidden = !onHost_ || cannotFit.textContent === "";
      splatViews.input.set(s.splat.views);
      splatSize.input.set(s.splat.size);
      splatSamples.input.set(s.splat.samples);
      splatSteps.input.set(s.splat.steps);
      splatCover.set(String(s.splat.cover));

      this.jobsUpdate?.();
      this.statusUpdate?.();
    };
    this.panelUpdate = sync;
    sync();
    // While the panel is open: the computer's budget and queue now and then, for Remote (not while the page is hidden).
    const infoTimer = setInterval(() => {
      if (this.panelUpdate !== sync) return clearInterval(infoTimer);
      if (this.saved.where === "host" && !document.hidden) void this.refreshInfo();
    }, INFO_EVERY_MS);
    return () => {
      clearInterval(infoTimer);
      this.panelUpdate = undefined;
      this.statusUpdate = undefined;
      this.jobsUpdate = undefined;
      this.editorUpdate = undefined;
    };
  }

  /** Switched off: jobs are no longer followed (they go on on their computer, and are followed again next time). */
  private disposed = false;

  dispose(): void {
    this.disposed = true;
    this.panelUpdate = this.statusUpdate = this.jobsUpdate = this.editorUpdate = undefined;
    this.closeSession();
    this.closeLocal();
    clearTimeout(this.settle);
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
    (document.head ?? document.body).append(style);
    ctx.subscriptions.push(() => style.remove());
    const r = new AnatomicalRendering(ctx);
    ctx.subscriptions.push(() => r.dispose());
  },
};
