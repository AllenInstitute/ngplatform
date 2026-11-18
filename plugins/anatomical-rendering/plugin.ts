/**
 * Anatomical rendering: an OME-Zarr image path-traced on a GPU, shown in
 * Neuroglancer's 3-D view.  The rendering runs in the render service
 * (`runner/ngplatform_render`), on this computer or on one reached over
 * SSH, through a runner; this module keeps a session open there for the
 * chosen image, sends the view whenever the camera or the look changes
 * (at half size while the camera moves), and draws the frames it sends
 * back as they refine (./draw.ts).
 */
import type { Disposer, Frame3d, JobControl, LayerInfo, PlatformContext, PluginModule, ViewShape, ViewShapeHandle } from "@ngplatform/sdk";
import { button, card, checkbox, downloadBlob, el, emptyState, field, iconButton, info, numberInput, region, select, type Settable, type Slider, slider, statusLine, toggle } from "@ngplatform/sdk/dom";
import { type ColourByLook, colormapSamples, layerColourLook, lookAttributes } from "@ngplatform/sdk/colour_by";
import { type Distance, hostLink, type Link, type MovieInfo, type ObjectsSpec, type PresetInfo, refusal, RenderService, ServiceError, type ServiceInfo, serviceText, type SessionInfo, type ViewSpec, type VolumeMeta } from "./client.js";
import { invert4, PictureDrawer } from "./draw.js";
import { dropJob, finished, type JobKind, type JobRecord, jobProgress, jobText, putJob, readJobs } from "./jobs.js";
import { clampInt, evenSide, LIMITS, movieSettings, retryDelay, stillProblem, windowStep } from "./limits.js";
import { parsePly, parseSplat, showSplats, type SplatCamera } from "./splatview.js";
import { cropToDisplay, cutOffset, cutShape, displayToCrop, levelAxes, planeFromShape, planeShape } from "./handles.js";
import { ColourmapEditor, type DataStop, histogramHandles, shifted, type Tuning, type WarpPoint, warpInverse } from "./editor.js";
import { LIVE_VOXELS, type LiveLook, LiveVolume, type LivePreset, MAX_CLIPS, MAX_VOLUMES } from "./live.js";
import { placementMm } from "../luxar/view_math.js";
import { cameraAxes, type Level8, type LevelPreset, levelHistogram, invert, levelResolved, LocalRenderer, mul, PRESETS as LOCAL_PRESETS, rowMajor } from "./local/local.js";
import { RENDER_PANEL } from "./manifest.js";
import { allocateLevels, GEOMETRY_BUDGET, type GeometryRead, groupColours, readGeometry } from "./points.js";
import { layerGeometry } from "./geometry/from_read.js";
import { lodChunks } from "./geometry/lod.js";
import type { BuiltChunk } from "../luxar/chunk_build.js";
import { type Block, buildBlockAsync, packSurfaces } from "./geometry/surfaces.js";
import { DEFAULT_SURFACE, GEO_LAYERS, GEO_MAX, geoBytes, type SurfaceMaterial } from "./geometry/live_geometry.js";
import { storeUrlOfSource } from "neuroglancer-zarr-vectors/source-url";
import { meshSourceOf } from "@ngplatform/sdk/sources";
import { meshStoreUrl, parseMeshStoreUrl } from "../luxar/mesh_layers.js";
import { axesCheck, type CameraPlane, clipPlanes, type Cut, displayFromPhysical, LIGHTING, lightDirection, omeZarrSource, sceneDirection, sceneAngles, renderSource, planeClip, planeFromView, safeHref, unitMm, viewForward, viewKey } from "./view.js";

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
  /** A layer's own box: fractions of its volume along its axes. A box for all layers: millimetres (`mm`), else (from before) fractions of the first image rendered. */
  lo: [number, number, number];
  hi: [number, number, number];
  mm?: boolean;
}

/** Crops and cuts: a layer's own, or those for all layers rendered. */
export interface CropSet {
  cuts: Cut[];
  planes: CameraPlane[];
  boxes: Crop[];
}

/** An image layer's own look: whether it is rendered, its preset and density (else the defaults below), and its own crops and cuts. */
export interface LayerLook {
  on?: boolean;
  preset?: string;
  density?: number;
  /** Points' and lines' size in this browser: times their natural radius. */
  size?: number;
  /** A geometry layer's surfaces' material in this browser (else DEFAULT_SURFACE's). */
  surface?: Partial<SurfaceMaterial>;
  cuts?: Cut[];
  planes?: CameraPlane[];
  boxes?: Crop[];
}

/** Whose crops: a layer's own (its name), or all layers' (null). */
export type CropScope = string | null;

/** A crop's or cut's shape in the views: `box2`, a layer's own; `boxall2`, all layers'. */
function shapeId(kind: "box" | "plane", scope: CropScope, i: number): string {
  return `${kind}${scope === null ? "all" : ""}${i}`;
}

/** The crops and cuts of a scope, to read. */
export function cropsOf(s: Pick<Saved, "cuts" | "planes" | "boxes" | "looks">, scope: CropScope): CropSet {
  if (scope === null) return s;
  const look = s.looks[scope];
  return { cuts: look?.cuts ?? DEFAULT_CUTS, planes: look?.planes ?? [], boxes: look?.boxes ?? [] };
}

/**
 * Edits the crops and cuts of a scope, as new objects: the state saved before (an undo step) keeps its own.
 */
export function editCrops(s: Saved, scope: CropScope, edit: (c: CropSet) => void): void {
  const from = cropsOf(s, scope);
  const c: CropSet = {
    cuts: from.cuts.map((q) => ({ ...q })),
    planes: from.planes.map((q) => ({ ...q, point: [...q.point] as CameraPlane["point"], normal: [...q.normal] as CameraPlane["normal"] })),
    boxes: from.boxes.map((q) => ({ ...q, lo: [...q.lo] as Crop["lo"], hi: [...q.hi] as Crop["hi"] })),
  };
  edit(c);
  if (scope === null) [s.cuts, s.planes, s.boxes] = [c.cuts, c.planes, c.boxes];
  else s.looks = { ...s.looks, [scope]: { ...s.looks[scope], ...c } };
}

/** A box's corners through a placed level (voxels → millimetres, row-major, and its size): fractions to millimetres, as the box about them. */
export function fractionsToMm(b: { lo: readonly number[]; hi: readonly number[] }, at: { m: readonly number[]; size: readonly number[] }): { lo: [number, number, number]; hi: [number, number, number] } {
  return boxThrough(b, (f) => f.map((x, a) => x * at.size[a] - 0.5), at.m, (v) => v);
}

/** Millimetres to fractions of a placed level, as the box about the corners. */
export function mmToFractions(b: { lo: readonly number[]; hi: readonly number[] }, at: { m: readonly number[]; size: readonly number[] }): { lo: [number, number, number]; hi: [number, number, number] } {
  return boxThrough(b, (v) => v, invert(at.m as number[]), (v) => v.map((x, a) => (x + 0.5) / at.size[a]));
}

function boxThrough(b: { lo: readonly number[]; hi: readonly number[] }, pre: (p: number[]) => number[], m: readonly number[], post: (p: number[]) => number[]) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; ++c) {
    const p = pre([0, 1, 2].map((a) => ((c >> a) & 1 ? b.hi[a] : b.lo[a])));
    const q = post([0, 1, 2].map((r) => m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3]));
    for (let a = 0; a < 3; ++a) [lo[a], hi[a]] = [Math.min(lo[a], q[a]), Math.max(hi[a], q[a])];
  }
  return { lo: lo as [number, number, number], hi: hi as [number, number, number] };
}

export interface Saved {
  on: boolean;
  /** Where frames are rendered: the render service on a host (CUDA), or this browser (WebGPU). */
  where: "host" | "browser";
  /** The image whose look the panel shows (Settings for). */
  layer?: string;
  labels?: string;
  /** The preset and density of an image that has none of its own (`looks`). */
  preset: string;
  density?: number;
  /** Each image layer's own look, by layer name: rendered or not, its preset and density, its own crops and cuts. */
  looks: Record<string, LayerLook>;
  exposure: number;
  /** For "window" presets: the data values at the window's ends, per image (its OME-Zarr store); else the host's guess. */
  windows: Record<string, [number, number]>;
  /** The channel and time point rendered (from 0), per image (its OME-Zarr store), for an image with more than one; else the first. */
  volumeAt: Record<string, { channel: number; time: number }>;
  /** The colourmap tuned for an image (its OME-Zarr store): stops edited over its histogram (data values), shift and compression. */
  tunings: Record<string, Tuning>;
  /** Where the key light comes from: in front of the camera, behind the object as the camera sees it (both turning with it), or a direction fixed in the scene. */
  lightFrom: "front" | "back" | "scene";
  /** The key light's direction: around and up from the camera's (front, back), or around z from x and up toward z (scene), in degrees. */
  lightAzimuth: number;
  lightElevation: number;
  /** A light map on the host ("" for the preset's sky colours) and its turn in degrees. */
  lightMap: string;
  lightMapRotation: number;
  /** A lighting style (LIGHTING), or "" for the light map as set; and the light map's and the key light's strength. */
  lightStyle: string;
  envScale: number;
  lightKey: number;
  /** Cuts across the view, each fixed where it was set (`CameraPlane`), for all layers rendered (each layer's own: `looks`). */
  planes: CameraPlane[];
  /** Planes across x, y and z, for all layers rendered. */
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
  /** The voxels of the image this browser holds and draws as the object (the finest level within them). */
  objectVoxels: number;
  /** The primitives (triangles, spheres, tubes) this browser reads across the geometry layers it traces. */
  geometryBudget: number;
  /** Show the path-traced picture of the view when the camera rests, over the object (else the object alone; the host renders stills, movies and splats). */
  restPicture: boolean;
  keyframes: Keyframe[];
  /** Crops for all layers rendered: boxes each keeping its inside or cutting it out; what shows is inside any that keeps and in none that cuts out. */
  boxes: Crop[];
  /** Presets loaded from files (as the service takes them). */
  customPresets: Record<string, unknown>[];
  rotation: { axis: "vertical" | "horizontal"; degrees: number; step: number };
  movie: { fps: number; width: number; height: number; samples: number; easing: "smooth" | "linear" };
  /**
   * Objects (on a render computer): a segmentation layer's chosen segments drawn as their meshes, and the image
   * within them at full resolution where `budget` voxels allow. `surface`: how much the surfaces show (0 clear,
   * 1 opaque); `image`: the image within them is drawn; `mix`: how much the segment's colour tints it.
   */
  objects: { on: boolean; layer: string; surface: number; image: boolean; mix: number; budget: number; lod: number; inside: "mesh" | "labels" };
  /** Gaussian splats: views path-traced from all round (`cover` degrees about the view's direction; 180: every side), their size (the longer side) and samples, and the fit's steps (0: the views only). */
  splat: { views: number; size: number; samples: number; cover: number; steps: number };
}

/** A Zarr Vectors layer's store (`…|zarr-vectors:`, `zarr-vectors://…`), as the render computer reads it; else undefined. */
export function zarrVectorsStore(source: string | undefined): string | undefined {
  const s = source?.trim() ?? "";
  const m = /^zarr-vectors:\/\/(.+)$/i.exec(s) ?? /^(.+?)\|zarr-vectors:?\s*$/i.exec(s);
  return m ? m[1].replace(/\|.*$/, "") : undefined;
}

/** A volume that names no image: a Zarr Vectors layer's objects alone, the store after it (the render computer's OBJECTS_ONLY). */
export const OBJECTS_ONLY = "objects:";

/** The most segments drawn as objects at once (the render computer takes up to 64). */
const MAX_OBJECTS = 64;

/** What "Hide the jar" keeps: a cylinder of this fraction of the scan's half width (a HiP-CT jar's wall is at about 0.95). */
const JAR_FRACTION = 0.9;

const DEFAULT_CUTS: Cut[] = [
  { axis: "x", keep: -1, offset: 0, on: false },
  { axis: "y", keep: -1, offset: 0, on: false },
  { axis: "z", keep: -1, offset: 0, on: false },
];

/**
 * The camera planes saved; from a state of before, its one cut facing the camera: fixed where it was
 * pinned, and one that turned with the camera set from the next frame's view (a zero normal until then).
 */
function readCuts(v: unknown): Cut[] {
  return Array.isArray(v) && v.length === 3 ? v.map((c, i) => ({ ...DEFAULT_CUTS[i], ...(c as Partial<Cut>) })) : DEFAULT_CUTS.map((c) => ({ ...c }));
}

function readBoxes(v: unknown): Crop[] {
  const tri = (x: unknown): x is [number, number, number] => Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === "number" && Number.isFinite(n));
  return Array.isArray(v)
    ? (v as Partial<Crop>[]).filter((b) => b && tri(b.lo) && tri(b.hi)).map((b, i) => ({ name: String(b.name ?? `Crop ${i + 1}`), on: b.on !== false, keep: b.keep !== false, lo: b.lo!, hi: b.hi!, ...(b.mm === true ? { mm: true } : {}) }))
    : [];
}

/** A lighting style of before as one of now. */
function readLightStyle(v: unknown): string {
  if (v === "hard") return "strong";
  return typeof v === "string" && v in LIGHTING ? v : "";
}

function readPlanes(s: Partial<Saved> & { viewCut?: { on?: boolean; offset?: number; fixed?: number[] | null } }): CameraPlane[] {
  const vec = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
  if (Array.isArray(s.planes)) {
    return s.planes
      .filter((p) => p && vec(p.normal) && vec(p.point))
      .map((p, i) => ({ name: String(p.name ?? `Plane ${i + 1}`), on: p.on !== false, normal: p.normal, point: p.point, offset: Number.isFinite(p.offset) ? p.offset : 0 }));
  }
  const v = s.viewCut;
  if (!v?.on) return [];
  const f = v.fixed;
  if (Array.isArray(f) && f.length === 4) return [{ name: "Plane 1", on: true, normal: [f[0], f[1], f[2]], point: [-f[3] * f[0], -f[3] * f[1], -f[3] * f[2]], offset: 0 }];
  return [{ name: "Plane 1", on: true, normal: [0, 0, 0], point: [0, 0, 0], offset: typeof v.offset === "number" ? v.offset : 0 }];
}

export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as Partial<Saved>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const cuts = readCuts(s.cuts);
  return {
    on: s.on === true,
    // This browser (WebGPU, and the object drawn on this computer's GPU) unless a render computer was chosen in Remote.
    where: s.where === "host" ? "host" : "browser",
    layer: typeof s.layer === "string" ? s.layer : undefined,
    labels: typeof s.labels === "string" ? s.labels : undefined,
    preset: typeof s.preset === "string" ? s.preset : "",
    density: typeof s.density === "number" ? s.density : undefined,
    looks: Object.fromEntries(
      Object.entries(s.looks && typeof s.looks === "object" ? s.looks : {})
        .filter((e): e is [string, LayerLook] => !!e[1] && typeof e[1] === "object")
        .map(([k, v]) => [k, {
          ...(typeof v.on === "boolean" ? { on: v.on } : {}),
          ...(typeof v.preset === "string" && v.preset ? { preset: v.preset } : {}),
          ...(typeof v.density === "number" && Number.isFinite(v.density) ? { density: v.density } : {}),
          ...(typeof v.size === "number" && Number.isFinite(v.size) && v.size > 0 ? { size: v.size } : {}),
          ...(v.surface && typeof v.surface === "object" ? { surface: readSurface(v.surface) } : {}),
          ...(Array.isArray(v.cuts) ? { cuts: readCuts(v.cuts) } : {}),
          ...(Array.isArray(v.planes) ? { planes: readPlanes({ planes: v.planes }) } : {}),
          ...(Array.isArray(v.boxes) ? { boxes: readBoxes(v.boxes) } : {}),
        }]),
    ),
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
    lightFrom: s.lightFrom === "back" || s.lightFrom === "scene" ? s.lightFrom : "front",
    lightAzimuth: num(s.lightAzimuth, 30),
    lightElevation: num(s.lightElevation, 40),
    lightMap: typeof s.lightMap === "string" ? s.lightMap : "",
    lightMapRotation: num(s.lightMapRotation, 0),
    lightStyle: readLightStyle(s.lightStyle),
    envScale: num(s.envScale, 1),
    lightKey: num(s.lightKey, 1),
    planes: readPlanes(s),
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
    restPicture: s.restPicture === true,
    objectVoxels: num(s.objectVoxels, LIVE_VOXELS),
    geometryBudget: Math.min(Math.max(num(s.geometryBudget, GEOMETRY_BUDGET), 0.25e6), GEO_MAX),
    keyframes: Array.isArray(s.keyframes) ? s.keyframes.filter((k) => k && typeof k.time === "number" && k.view && typeof k.view === "object") : [],
    boxes: Array.isArray(s.boxes)
      ? readBoxes(s.boxes)
      : (s as { box?: { on?: boolean; lo?: [number, number, number]; hi?: [number, number, number] } }).box?.on
        ? [{ name: "Crop 1", on: true, keep: true, lo: (s as { box: { lo?: [number, number, number] } }).box.lo ?? [0, 0, 0], hi: (s as { box: { hi?: [number, number, number] } }).box.hi ?? [1, 1, 1] }]
        : [],
    customPresets: Array.isArray(s.customPresets) ? s.customPresets.filter((p) => p && typeof (p as { name?: unknown }).name === "string") : [],
    rotation: { axis: "vertical", degrees: 360, step: 2, ...(s.rotation ?? {}) },
    movie: { fps: 25, width: 1280, height: 720, samples: 128, easing: "smooth", ...(s.movie ?? {}) },
    splat: { views: 256, size: 1024, samples: 512, cover: 180, steps: 30000, ...(s.splat ?? {}) },
    objects: { on: false, layer: "", surface: 0.3, image: true, mix: 0, budget: 3e8, lod: 1, inside: "mesh", ...(s.objects ?? {}) },
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
/** A select drawn again only when its options change: [value, text], or [value, text, group] in groups, in their first order. */
type Choices = Settable<HTMLSelectElement, string> & { update(options: [string, string, string?][], value: string): void };
function choices(onchange: (value: string) => void, label: string): Choices {
  const s = select([], "", onchange, label) as Choices;
  let last = "";
  s.update = (options, value) => {
    const key = JSON.stringify(options);
    if (key !== last) {
      last = key;
      const option = ([v, text]: [string, string, string?]) => el("option", { value: v }, text);
      const groups = [...new Set(options.map((o) => o[2]))];
      s.replaceChildren(
        ...(groups.some((g) => g !== undefined)
          ? groups.map((g) => el("optgroup", { label: g ?? "" }, ...options.filter((o) => o[2] === g).map(option)))
          : options.map(option)),
      );
      s.value = value;
    }
    s.set(value);
  };
  return s;
}

/** The Preset box's options: General (any scan), HiP-CT organs, by modality, from a file; within a group, the name without its prefix. */
export function presetChoices(list: { name: string; modality: string }[]): [string, string, string][] {
  const GROUPS: [string, string][] = [["General: ", "General"], ["HiP-CT organ: ", "HiP-CT organs"]];
  const ORDER = ["General", "HiP-CT organs", "By modality", "From a file"];
  const one = (p: { name: string; modality: string }): [string, string, string] => {
    const g = GROUPS.find(([prefix]) => p.name.startsWith(prefix));
    if (g !== undefined) {
      const rest = p.name.slice(g[0].length);
      return [p.name, rest.charAt(0).toUpperCase() + rest.slice(1), g[1]];
    }
    return [p.name, p.modality && p.modality !== "from a file" ? `${p.name} (${p.modality})` : p.name, p.modality === "from a file" ? "From a file" : "By modality"];
  };
  return list.map(one).sort((a, b) => ORDER.indexOf(a[2]) - ORDER.indexOf(b[2]));
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
.ar-cut > .ar-all { grid-column: 3; justify-self: end; }
.ar-all[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.ar-cut > select { width: auto; }
.ar-editor-box { display: grid; gap: var(--sp-2); min-width: 0; }
.ar-editor { display: block; width: 100%; height: 176px; cursor: grab; border: 1px solid var(--line-strong); touch-action: none; }
.ar-editor:focus-visible { outline: 1px solid var(--line-focus); outline-offset: 1px; }
.ar-editor-hint { color: var(--faint); font-size: var(--fs-caption); line-height: 1.35; }
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

/** A tuning that changes the map (stops edited, shifted, compressed or the histogram warped). */
export function isTuned(t: Tuning | undefined): t is Tuning {
  return t !== undefined && (t.stops !== undefined || t.shift !== 0 || t.scale !== 1 || (t.warp ?? []).some((p) => p.to !== p.from));
}

/**
 * The stops a tuning makes of a preset placed on an image's values (`resolved`): as the editor shows them (on the
 * colourmap's axis: as tuned, or as resolved, then shifted and compressed), the histogram's warp, and the stops at
 * the image's values (through the warp): what is rendered.
 */
export function tuneStops(resolved: DataStop[], t: Tuning | undefined, hist: { lo: number; hi: number; counts: number[] } | undefined): { stops: DataStop[]; base: DataStop[]; centre: number; warp: WarpPoint[]; data: DataStop[] } {
  const stops = t?.stops ?? resolved;
  const vis = resolved.filter((x) => x.opacity > 0.01);
  const centre = vis.length ? (vis[0].value + vis[vis.length - 1].value) / 2 : 0;
  const shown = shifted(stops, t?.shift ?? 0, t?.scale ?? 1, centre);
  // Not warped yet: handles at the histogram's quantiles over the map's visible range, each where it is.
  const warp = t?.warp ?? (hist && vis.length ? histogramHandles(hist, vis[0].value, vis[vis.length - 1].value).map((v) => ({ from: v, to: v })) : []);
  return { stops: shown, base: stops, centre, warp, data: shown.map((x) => ({ ...x, value: warpInverse(x.value, warp) })) };
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
  private queued: { spec: ViewSpec; look: string } | undefined;
  /** The look (preset, light, cuts…) of the view last sent: a change to it renders at once, moving or not. */
  private lastLook = "";
  /** The camera of the last frame, when it last changed, and whether it was changing frame after frame. */
  private lastCamera = "";
  private cameraChanged = 0;
  private turning = false;
  private settle: ReturnType<typeof setTimeout> | undefined;
  private depth: { version: number; width: number; height: number; data: Float32Array } | undefined;
  private distance: Distance | undefined;
  /** The camera (inverse view-projection, column-major) and look of each view sent, by the version the host gave it. */
  private views = new Map<number, { camera: number[]; look: string }>();
  /** The image as an object in the 3-D view, drawn with each frame's camera. */
  private readonly live = new LiveVolume();
  private levelShown: Level8 | undefined;
  private lastCursor: number[] | undefined;
  /** Crops and cuts as shapes with handles in the views, by id (`box0`, `plane0`, `cut0`), and what each was made from. */
  private readonly shapes = new Map<string, { handle: ViewShapeHandle; key: string }>();
  /** Sets the selected crop's or cut's card in place, as it is dragged. */
  private cardSync: (() => void) | undefined;

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
  /** Why this browser's WebGPU path tracer could not start (the object is drawn without it). */
  private noWebGpu = "";
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
    this.drawer.live = this.live;
    this.live.look = (frame) => this.liveLook(frame);
    this.live.onChange = () => {
      this.handle?.redraw();
      this.statusUpdate?.();
      // A level read (or let go): the colourmap editor can show the edited image's histogram.
      const edited = this.edited();
      const src = edited ? this.sourceOf(edited) : undefined;
      const level = src !== undefined ? this.live.levelOf(src) : undefined;
      if (level !== this.levelShown) {
        this.levelShown = level;
        this.panelUpdate?.();
      }
    };
    this.live.onRedraw = () => this.handle?.redraw();
    this.toggle = ctx.ui.viewToggle({ label: "Render", title: "Path-traced rendering (Anatomical rendering)", value: this.saved.on, onChange: (v) => this.setOn(v) });
    this.offs.push(
      ctx.viewer.onLayersChanged(() => this.update()),
      // The Zarr Vectors layer drawn recoloured (its Colour by, or its low and high dragged): the render follows,
      // a new session when it reads another attribute.
      ctx.viewer.onStateChanged(() => {
        const generation = ctx.viewer.layersGeneration?.();
        if (generation !== undefined && generation === this.lookGeneration) return;
        this.lookGeneration = generation;
        // Every Zarr Vectors layer drawn (its points here, or the objects layer on a render computer).
        const layers = [...this.vectorLayers().filter((l) => this.isOn(l)), ...(this.saved.objects.on && this.objectsLayer() ? [this.objectsLayer()!] : [])];
        // (A segmentation's chosen segments: their meshes are read again.)
        const look = JSON.stringify([
          ...layers.filter((l) => zarrVectorsStore(l.sources[0]) !== undefined).map((l) => [l.name, this.lookOf(l) ?? null]),
          ...this.vectorLayers().filter((l) => this.isOn(l)).map((l) => [l.name, this.meshStoreOf(l) ?? null]),
        ]);
        if (look === this.lastLayerLook) return;
        this.lastLayerLook = look;
        this.update();
      }),
      ctx.workspace.onChanged(() => this.followSelection()),
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
      () => this.live.close(),
    );
    void this.connect();
    // The image selected already: its controls are the ones shown.
    this.followSelection();
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
    // On with no image switched on (the 3-D view's Render, the command): the image selected is.
    const selected = this.edited();
    if (on && this.renderedLayers().length === 0 && selected !== undefined && (this.isImage(selected) || this.isVectors(selected))) {
      this.saved.looks = { ...this.saved.looks, [selected.name]: { ...this.saved.looks[selected.name], on: true } };
    }
    const target = this.target();
    const problem = target === undefined
      ? this.images().length > 0
        ? "No image is switched on for rendering: select one in Layers and switch Render on."
        : "Anatomical rendering needs an OME-Zarr, N5 or precomputed image in the scene."
      : this.axesOf(target).problem;
    if (on && problem !== undefined) {
      // Nothing it can read (meshes, tractograms, a 2-D image): say so rather than switch on to no effect.
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
    return this.ctx.viewer.layers().filter((l) => l.type === "image" && renderSource(l.sources[0]) !== undefined);
  }

  private segmentations(): LayerInfo[] {
    return this.ctx.viewer.layers().filter((l) => l.type === "segmentation" && omeZarrSource(l.sources[0]) !== undefined);
  }

  private lookGeneration: number | undefined;
  private lastLayerLook = "";

  /**
   * The image rendered first: the one whose settings are shown when it is rendered, else the first rendered. The
   * crops are fractions of it, and a render computer renders it alone.
   */
  private target(): LayerInfo | undefined {
    if (this.saved.where === "browser") return this.renderedLayers()[0];
    // On a render computer: the first image; a Zarr Vectors layer alone (its geometry) while switched on.
    if (this.images().length === 0) {
      const v = this.vectorsAlone();
      return v !== undefined && this.isOn(v) ? v : undefined;
    }
    return this.renderedLayers()[0];
  }

  /**
   * Geometry layers: Zarr Vectors layers (points, lines, surfaces) and precomputed segmentations (their chosen
   * segments' meshes). This browser draws their points and surfaces; a render computer their geometry as objects.
   */
  private vectorLayers(): LayerInfo[] {
    return this.ctx.viewer.layers().filter((l) => this.isVectors(l));
  }

  private isVectors(layer: LayerInfo): boolean {
    if (zarrVectorsStore(layer.sources[0]) !== undefined) return true;
    const volume = layer.type === "segmentation" ? meshSourceOf(layer.sources[0])?.volume : undefined;
    return volume !== undefined && !volume.startsWith("graphene+");
  }

  /** The layers with a Render switch: the images, then the Zarr Vectors layers. */
  private switchable(): LayerInfo[] {
    return [...this.images(), ...this.vectorLayers()];
  }

  /**
   * The image whose controls the panel shows (its Render switch, preset, window, colourmap, density): the one
   * selected in the Layers panel, else the last image selected, else the one rendered first, else the first.
   * Not saved: it follows the selection, as a layer's own settings in Layers do.
   */
  private editing: string | undefined;
  private edited(): LayerInfo | undefined {
    const imgs = this.switchable();
    return imgs.find((l) => l.name === this.editing) ?? imgs.find((l) => l.name === this.saved.layer) ?? this.images()[0] ?? this.vectorsAlone() ?? imgs[0];
  }

  /** Whether a layer is one of the images (by name: the viewer gives new objects for its layers each time). */
  private isImage(layer: LayerInfo): boolean {
    return this.images().some((l) => l.name === layer.name);
  }

  /** Whether an image is rendered: as its own Render switch says; for a scene of before, the one image it named. */
  private isOn(layer: LayerInfo): boolean {
    const own = this.saved.looks[layer.name]?.on;
    if (own !== undefined) return own;
    return layer.name === this.defaultLayer()?.name;
  }

  /**
   * The layer rendered when none has been switched: the one the scene named, else the first shown in the views (an
   * image, else a segmentation's meshes or a Zarr Vectors layer: not a hidden image before them), else the first image.
   */
  private defaultLayer(): LayerInfo | undefined {
    const named = this.saved.layer !== undefined ? this.switchable().find((l) => l.name === this.saved.layer) : undefined;
    if (named !== undefined) return named;
    const drawable = (l: LayerInfo) => !this.isVectors(l) || this.meshStoreOf(l) !== undefined || zarrVectorsStore(l.sources[0]) !== undefined;
    return this.switchable().find((l) => l.visible && drawable(l)) ?? this.images()[0] ?? this.vectorsAlone();
  }

  /**
   * The images rendered together as one volume, at most MAX_VOLUMES: the image the scene named first (the crops are
   * fractions of it, so selecting another layer does not move them), then the others in the order of the layers.
   */
  private renderedLayers(): LayerInfo[] {
    // In this browser a Zarr Vectors layer's points are drawn with the images; a render computer draws them as objects.
    // (A segmentation with no segment chosen has nothing to draw.)
    const on = (this.saved.where === "browser" ? this.switchable() : this.images()).filter((l) => this.isOn(l) && (!this.isVectors(l) || this.sourceOf(l) !== undefined));
    const first = on.find((l) => l.name === this.saved.layer);
    return (first ? [first, ...on.filter((l) => l !== first)] : on).slice(0, MAX_VOLUMES);
  }

  /** Switches one image's rendering on or off (its own Render switch): one undo step; the first switched on is the one the crops are of. */
  private setLayerOn(layer: LayerInfo, on: boolean): void {
    const problem = this.axesOf(layer).problem;
    if (on && problem !== undefined) {
      this.ctx.ui.toast(problem, "error");
      this.panelUpdate?.();
      return;
    }
    this.save((x) => {
      // Each image's switch written as it stands (a scene of before renders its one named image by default), so
      // changing which image comes first changes no other image's.
      const looks = { ...x.looks };
      for (const l of this.switchable()) if (looks[l.name]?.on === undefined) looks[l.name] = { ...looks[l.name], on: this.isOn(l) };
      looks[layer.name] = { ...looks[layer.name], on };
      x.looks = looks;
      const still = this.switchable().filter((l) => looks[l.name]?.on === true);
      // The image the crops are of: kept while it is rendered, else this one (switched on) or the first left.
      if (!still.some((l) => l.name === x.layer)) x.layer = on ? layer.name : still[0]?.name ?? x.layer;
      x.on = still.length > 0;
    });
    this.toggle.set(this.saved.on);
    if (on) this.ensure3d();
    this.update();
  }

  /** An image's preset: its own, else the default. */
  private presetName(layer = this.edited()): string {
    return (layer && this.saved.looks[layer.name]?.preset) || this.saved.preset;
  }

  /** An image's density: its own, else the default (undefined: the preset's). */
  private densityOf(layer = this.edited()): number | undefined {
    return (layer && this.saved.looks[layer.name]?.density) ?? this.saved.density;
  }

  /** Changes an image's own look; `preview`: rendered while a slider is dragged, saved when let go. */
  private setLook(layer: LayerInfo, change: LayerLook, preview = false): void {
    const edit = (x: Saved) => void (x.looks = { ...x.looks, [layer.name]: { ...x.looks[layer.name], ...change } });
    if (preview) this.preview(edit);
    else this.save(edit);
  }

  /** The image selected in the Layers panel becomes the one whose settings are shown (not an undo step). */
  private lastSelected: string | undefined;
  private followSelection(): void {
    const name = this.ctx.workspace.selectedLayer();
    if (name === this.lastSelected) return;
    this.lastSelected = name;
    if (name === undefined || name === this.editing || !this.switchable().some((l) => l.name === name)) return;
    this.editing = name;
    this.update();
  }

  /** Where a layer's own transform moves its image from where the image's metadata puts it (mm, column-major); undefined: nowhere. */
  private placementOf(layer: LayerInfo): Float64Array | undefined {
    try {
      return placementMm(this.ctx.viewer.layerTransform?.(layer.name));
    } catch {
      // A transform it cannot read: the image where its metadata puts it.
      return undefined;
    }
  }

  /**
   * A Zarr Vectors layer rendered alone, when the scene has no image (points,
   * lines or a surface by themselves, on a render computer): its geometry is
   * what the render holds, in an empty volume about it.
   */
  private vectorsAlone(): LayerInfo | undefined {
    if (this.images().length > 0) return undefined;
    const layers = this.objectLayers().filter((l) => zarrVectorsStore(l.sources[0]) !== undefined);
    return layers.find((l) => l.name === this.saved.objects.layer) ?? layers[0];
  }

  /** What a layer renders: an image's store, or a Zarr Vectors layer's objects alone (OBJECTS_ONLY and its store). */
  private sourceOf(layer: LayerInfo): string | undefined {
    // A segmentation's chosen segments' meshes (drawn here as surfaces): their mesh store.
    const meshes = this.meshStoreOf(layer);
    if (meshes !== undefined) return `${OBJECTS_ONLY}${meshes}`;
    const store = renderSource(layer.sources[0]) === undefined ? zarrVectorsStore(layer.sources[0]) : undefined;
    return store !== undefined ? `${OBJECTS_ONLY}${store}` : renderSource(layer.sources[0]);
  }

  /** The most segments whose meshes are drawn here. */
  private static readonly MESH_SEGMENTS = 64;

  /** A precomputed segmentation layer with segments chosen: the mesh store of the first MESH_SEGMENTS (Luxar's reader); else undefined. */
  private meshStoreOf(layer: LayerInfo): string | undefined {
    if (layer.type !== "segmentation" || zarrVectorsStore(layer.sources[0]) !== undefined) return undefined;
    const volume = meshSourceOf(layer.sources[0])?.volume;
    if (volume === undefined || volume.startsWith("graphene+")) return undefined;
    const shown = this.ctx.viewer.visibleSegments(layer.name);
    if (shown === undefined || shown.all || shown.size === 0) return undefined;
    return meshStoreUrl(volume, Array.from(shown.ids()).slice(0, AnatomicalRendering.MESH_SEGMENTS));
  }

  /** A layer's Colour by look (its Display tab's Vertex colour), as its state has it now. */
  private lookOf(layer: LayerInfo): ColourByLook | undefined {
    return this.ctx.viewer.colourLook?.(layer.name) ?? layerColourLook(this.ctx.viewer.layerSpec?.(layer.name));
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
    const src = this.sourceOf(layer);
    const known = src === undefined ? undefined : this.counts.get(src);
    const counts = known ?? { channels: axes.channels ?? 1, times: axes.times ?? 1 };
    return counts.channels > 1 || counts.times > 1 ? counts : undefined;
  }

  /** The channel and time point to render of the image: as chosen, within what it has. */
  private volumeAt(layer: LayerInfo): { channel: number; time: number } {
    const src = this.sourceOf(layer);
    const at = src === undefined ? undefined : this.saved.volumeAt[src];
    const n = this.volumeCounts(layer);
    if (at === undefined || n === undefined) return { channel: 0, time: 0 };
    return { channel: Math.min(at.channel, n.channels - 1), time: Math.min(at.time, n.times - 1) };
  }

  /** Renders another channel or time point of the image: one undo step, and a new session (the computer loads one of each per session). */
  private setVolumeAt(layer: LayerInfo, change: Partial<{ channel: number; time: number }>): void {
    const src = this.sourceOf(layer);
    if (src === undefined) return;
    const next = { ...this.volumeAt(layer), ...change };
    this.save((x) => (x.volumeAt[src] = next));
    this.update();
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
    this.watchObjects();
    const found = this.target();
    const browser = this.saved.where === "browser";
    // Geometry traced here: Neuroglancer's own drawing of each layer hidden once the object shows it (it then reads nothing).
    const drawnPoints = this.saved.on && browser
      ? this.renderedLayers().filter((l) => this.isVectors(l) && this.surfaceLayout?.layers.some((x) => x.name === l.name) === true && this.live.heldSurfaces !== undefined)
      : [];
    this.hidePointsDrawing(new Set(drawnPoints.map((l) => l.name)));
    // An image whose axes it cannot render (2-D; time or channels in this browser) is not opened.
    const target = found !== undefined && this.axesOf(found).problem === undefined ? found : undefined;
    if (!this.saved.on || target === undefined || (!browser && this.serviceInfo === undefined)) {
      this.syncShapes();
      this.handle?.dispose();
      this.handle = undefined;
      this.handleLayer = undefined;
      this.drawer.set(undefined);
      if (!this.saved.on || target === undefined) {
        this.closeSession();
        this.closeLocal();
        this.live.close();
        this.surfaceLayout = undefined;
        this.surfacesWanted = "";
      }
      this.panelUpdate?.();
      return;
    }
    // Drawn in the 3-D view with a layer Neuroglancer draws: a hidden layer's drawing (and so the render) is skipped.
    const host = [target, ...this.renderedLayers()].find((l) => l.visible) ?? this.ctx.viewer.layers().find((l) => l.visible) ?? target;
    if (this.handleLayer !== host.name) {
      this.handle?.dispose();
      this.handleLayer = host.name;
      this.handle = this.ctx.viewer.draw3d(host.name, {
        draw: (frame) => this.drawer.draw(frame),
        isReady: () => this.drawer.isReady(),
        dispose: () => undefined,
      });
    }
    if (browser) {
      this.closeSession();
      // Several images, or a Zarr Vectors layer's points (a volume of small spheres): drawn together as one volume,
      // each read here (this browser's path tracer takes one image).
      // (A segmentation with no segment chosen has nothing to draw.)
      const layers = this.renderedLayers().filter((l) => this.axesOf(l).problem === undefined && this.sourceOf(l) !== undefined);
      const clouds = layers.filter((l) => this.isVectors(l));
      for (const name of [...this.points.keys()]) if (!clouds.some((l) => l.name === name)) this.points.delete(name);
      this.rebuildSurfaces(clouds);
      const images = layers.filter((l) => !this.isVectors(l));
      if (images.length === 1 && clouds.length > 0) {
        // One image and geometry: the image as the object and in WebGPU's picture at rest, the geometry traced in both.
        void this.ensureLocal(images[0]);
        for (const l of clouds) this.ensurePoints(l, clouds.length);
      } else if (layers.length > 1 || clouds.length > 0) {
        this.closeLocal();
        // The images read as volumes; the geometry layers traced as surfaces.
        void this.live.open(layers.filter((l) => !this.isVectors(l)).map((l) => this.sourceOf(l)!), this.saved.objectVoxels);
        for (const l of clouds) this.ensurePoints(l, clouds.length);
      } else void this.ensureLocal(target);
    } else {
      this.closeLocal();
      void this.ensureSession(target);
      // The live image reads the image in this browser too: one it could render here (one channel and time point).
      // Not while objects are drawn: the computer's picture of them is what the view shows.
      if (this.objectsSpec() !== undefined) this.live.close();
      else if (axesCheck(this.ctx.viewer.layerTransform?.(target.name)?.input, true).problem === undefined) void this.live.open(this.sourceOf(target)!, this.saved.objectVoxels);
      else this.live.close();
    }
    this.handle?.redraw();
    this.panelUpdate?.();
  }

  /** The layers whose own drawing is hidden while their points are drawn here. */
  private pointsHidden = new Set<string>();

  private hidePointsDrawing(names: Set<string>): void {
    for (const name of this.pointsHidden) if (!names.has(name)) this.ctx.viewer.hideLayerDrawing(name, false);
    for (const name of names) if (!this.pointsHidden.has(name)) this.ctx.viewer.hideLayerDrawing(name, true);
    this.pointsHidden = new Set(names);
  }

  /** Geometry layers read in this browser, by layer: their parts (a segment's mesh each, or the layer whole). */
  private readonly points = new Map<string, PointsEntry>();
  /** The surfaces traced now: each layer's objects (from `offset`), their segments or colours. */
  private surfaceLayout: { key: string; layers: { name: string; offset: number; objectCount: number; ids?: bigint[]; colours?: Float32Array; groups?: { group: number; stored?: number }[]; serials: number[] }[] } | undefined;
  private surfacesWanted = "";
  /** A still made in this browser reads the geometry at this budget meanwhile (as a render computer's stills read finer). */
  private stillBudget: number | undefined;
  /** Parts are read one at a time (a reader each, one after another). */
  private reading: Promise<void> = Promise.resolve();

  /**
   * Reads a geometry layer for the path tracer, in parts: a segmentation's chosen segments' meshes each its own (so
   * choosing another reads only it), a Zarr Vectors layer whole. Each part at the finest level within its share of
   * the budget (`layers`: how many layers share it; a layer's share split between its segments).
   */
  private ensurePoints(layer: LayerInfo, layers: number): void {
    const look = this.lookOf(layer);
    // (A still made here reads finer: stillBudget.)
    const budget = (this.stillBudget ?? this.saved.geometryBudget) / Math.max(1, Math.min(layers, GEO_LAYERS));
    let entry = this.points.get(layer.name);
    if (entry === undefined) {
      entry = { parts: new Map(), wanted: [], text: "Object: reading the geometry" };
      this.points.set(layer.name, entry);
    }
    entry.placement = this.placementOf(layer);
    entry.look = look;
    const meshes = parseMeshStoreUrl(this.meshStoreOf(layer) ?? "");
    // Each part: its store, and what it is read for (a mesh's level within its share; a store's colours and budget).
    const wanted: { key: string; store: string; readFor: (part: Part) => string; budget: number; look: ColourByLook | undefined; level?: number; chunks?: string[] }[] = [];
    if (meshes !== undefined) {
      // At first an equal share each; once every segment's levels are known, levels shared out between them
      // (allocateLevels, two triangles a vertex), the segments that can come finer read again.
      const share = budget / Math.max(1, meshes.ids.length);
      const known = meshes.ids.map((id) => entry!.parts.get(String(id))?.read);
      const levels = known.every((r) => r !== undefined) ? allocateLevels(known as GeometryRead[], budget / 2) : undefined;
      meshes.ids.forEach((id, i) => {
        // A mesh's key: the level it reads (its key once read: the level it read); with its levels shared out and
        // the camera at rest, its chunks by distance within that level's vertices (geometry/lod.ts).
        const level = levels?.[i];
        const r = known[i];
        const eye = r && level !== undefined ? this.eyeInStore(r, entry!.placement) : undefined;
        const chunks = r && eye && level !== undefined ? lodChunks(r.levels, r.bounds.lower, r.bounds.upper, eye, r.levels[level].vertexCount ?? Infinity) : undefined;
        const readFor = () => (chunks ? `lod ${chunks.length} ${hashText(chunks.join(","))}` : level !== undefined ? String(level) : r ? String(r.level) : `share ${share}`);
        wanted.push({ key: String(id), store: meshStoreUrl(meshes.volume, [id]), readFor, budget: share, look: undefined, level, chunks });
      });
    } else {
      const store = storeUrlOfSource(layer.sources[0] ?? "") ?? zarrVectorsStore(layer.sources[0])!;
      // Read again for another attribute (the groups' or their colours'); not for the groups shown or how coloured.
      const g = look?.by === "group" ? look.group : undefined;
      const readFor = () => JSON.stringify([store, g ? [g.attribute, g.colours === "stored" ? (g.colorAttribute ?? null) : null] : null, budget]);
      wanted.push({ key: "", store, readFor, budget, look });
    }
    entry.wanted = wanted.map((w) => w.key);
    for (const k of [...entry.parts.keys()]) if (!entry.wanted.includes(k)) entry.parts.delete(k);
    for (const w of wanted) {
      let part = entry.parts.get(w.key);
      if (part === undefined) {
        part = { readKey: "", wantKey: "" };
        entry.parts.set(w.key, part);
      }
      const want = w.readFor(part);
      if (part.readKey === want || part.wantKey === want) continue;
      part.wantKey = want;
      this.readPart(layer.name, entry, part, w.store, w.look, w.budget, meshes !== undefined, w.level, w.chunks);
    }
    this.statusUpdate?.();
  }

  /** Reads one part (after the parts before it), unless it is no longer wanted by then. */
  private readPart(name: string, entry: PointsEntry, part: Part, store: string, look: ColourByLook | undefined, budget: number, mesh: boolean, level?: number, chunks?: string[]): void {
    const key = part.wantKey;
    const stale = () => this.points.get(name) !== entry || ![...entry.parts.values()].includes(part) || part.wantKey !== key;
    this.problem = "";
    this.reading = this.reading.then(async () => {
      if (stale()) return;
      const say = (text: string) => {
        if (stale()) return;
        entry.text = `Object: ${text}`;
        this.statusUpdate?.();
      };
      try {
        // A mesh's chunks kept from read to read: another choice of them reads only those it lacks.
        if (mesh) part.cache ??= new Map();
        const read = await readGeometry(store, look, budget, say, stale, level, chunks && part.cache ? { keys: chunks, cache: part.cache } : undefined);
        if (stale()) return;
        part.read = read;
        // A mesh's key is the level it read; a store's, what it was read for.
        part.readKey = mesh && !key.startsWith("lod ") ? String(read.level) : key;
        part.wantKey = part.readKey;
        part.failed = false;
        const done = [...entry.parts.values()].filter((p) => p.read).length;
        entry.text = `Object: level ${read.level}${entry.wanted.length > 1 ? `, ${done} of ${entry.wanted.length} segments read` : `, ${read.count.toLocaleString()} ${read.kind === "meshes" ? "triangles" : read.kind === "lines" ? "segments" : "points"}`}`;
        this.update();
      } catch (e) {
        if (stale() || (e as Error).message === "stale") return;
        part.failed = true;
        part.wantKey = "";
        this.problem = `The geometry of ${name} could not be read: ${(e as Error).message}`;
        this.statusUpdate?.();
      }
    });
  }

  /** The camera where geometry was last chosen by distance (world); a rest far enough from it chooses again. */
  private lodEye: number[] | undefined;

  /** The camera at rest (`frame`) far enough from where meshes' chunks were chosen: choose them again. */
  private lodCheck(frame: Frame3d): void {
    const e = Array.from({ length: 4 }, (_, r) => frame.invViewProjection[8 + r]);
    if (Math.abs(e[3]) < 1e-12) return;
    const eye = [e[0] / e[3], e[1] / e[3], e[2] / e[3]];
    const at = Math.hypot(...eye.map((v, k) => v - frame.position[k]));
    if (this.lodEye !== undefined && Math.hypot(...eye.map((v, k) => v - this.lodEye![k])) < 0.2 * at) return;
    if (![...this.points.values()].some((p) => p.wanted.length > 1 || [...p.parts.values()].some((x) => x.read?.kind === "meshes"))) return;
    this.lodEye = eye;
    this.update();
  }

  /** The camera (lodEye) in a read's store coordinates, as its layer places it. */
  private eyeInStore(read: GeometryRead, placement: ArrayLike<number> | undefined): number[] | undefined {
    const eye = this.lodEye;
    const wfp = this.lastSpec?.world_from_physical;
    if (eye === undefined) return undefined;
    const fromWorld = invert(mul(wfp ? rowMajor(wfp) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], toMmOf(read, placement)));
    return [0, 1, 2].map((r) => fromWorld[4 * r] * eye[0] + fromWorld[4 * r + 1] * eye[1] + fromWorld[4 * r + 2] * eye[2] + fromWorld[4 * r + 3]);
  }

  /** A geometry layer's kind, as read. */
  private geometryKind(name: string): GeometryRead["kind"] | undefined {
    return [...(this.points.get(name)?.parts.values() ?? [])].find((p) => p.read)?.read?.kind;
  }

  /**
   * The surfaces traced: the parts of the layers drawn (`layers`, in order, at most GEO_LAYERS), each built into its
   * own block (in a worker) when it is read, sized or placed anew; the blocks packed under one tree once every part
   * wanted has one, the surfaces drawn before kept until then. None when no geometry is drawn.
   */
  private rebuildSurfaces(layers: LayerInfo[]): void {
    const drawn: { l: LayerInfo; parts: Part[] }[] = [];
    let ready = true;
    for (const l of layers) {
      const e = this.points.get(l.name);
      if (e === undefined || drawn.length >= GEO_LAYERS) continue;
      const size = this.saved.looks[l.name]?.size ?? 1;
      const parts: Part[] = [];
      for (const k of e.wanted) {
        const part = e.parts.get(k);
        if (part === undefined || part.failed) continue;
        if (part.read) this.buildPart(l.name, e, part, size);
        if (part.done === undefined) ready = false;
        parts.push(part);
      }
      drawn.push({ l, parts });
    }
    if (!ready) return;
    const key = JSON.stringify(drawn.map((x) => [x.l.name, x.parts.map((p) => p.done!.serial)]));
    if (key === this.surfacesWanted) return;
    this.surfacesWanted = key;
    const blocks = drawn.flatMap((x) => x.parts.map((p) => p.done!));
    if (blocks.length === 0) {
      this.surfaceLayout = undefined;
      this.live.putSurfaces(undefined);
      return;
    }
    const total = blocks.reduce((n, b) => n + b.block.n, 0);
    if (total > GEO_MAX) {
      this.problem = `Too much geometry to trace here: ${total.toLocaleString()} primitives (at most ${GEO_MAX.toLocaleString()}).`;
      this.statusUpdate?.();
      return;
    }
    // Each layer's objects after the layers' before; each part's after its layer's parts' before.
    const placed: { block: Block; objectBase: number }[] = [];
    let base = 0;
    const layout = drawn.map(({ l, parts }) => {
      const offset = base;
      const ids: bigint[] = [];
      const colours: number[] = [];
      const groups: { group: number; stored?: number }[] = [];
      let byId = true, byGroup = true;
      for (const p of parts) {
        const d = p.done!;
        placed.push({ block: d.block, objectBase: base });
        base += d.block.objectCount;
        if (d.ids) ids.push(...d.ids);
        else byId = false;
        if (d.groups) groups.push(...d.groups);
        else byGroup = false;
        if (d.colours) colours.push(...d.colours);
      }
      return { name: l.name, offset, objectCount: base - offset, ...(byId ? { ids } : { colours: new Float32Array(colours) }), ...(byGroup && !byId ? { groups } : {}), serials: parts.map((p) => p.done!.serial) };
    });
    const started = performance.now();
    const s = packSurfaces(placed, base);
    const ms = Math.round(performance.now() - started);
    this.surfaceLayout = { key, layers: layout };
    const mb = Math.round(geoBytes(s) / 1e6);
    this.live.putSurfaces(s, `Surfaces: ${total.toLocaleString()} primitives, ${base.toLocaleString()} object${base === 1 ? "" : "s"} in ${blocks.length} block${blocks.length === 1 ? "" : "s"} (${mb} MB; joined in ${ms} ms)`);
    this.update();
  }

  /** A part's primitives (at `size`, placed as its layer is) and their block, built in the background when they change. */
  private buildPart(name: string, entry: PointsEntry, part: Part, size: number): void {
    const read = part.read!;
    const key = JSON.stringify([part.readKey, read.level, size, entry.placement ? Array.from(entry.placement) : null]);
    if (part.building === key || part.done?.key === key) return;
    part.building = key;
    const g = layerGeometry(read, toMmOf(read, entry.placement), entry.look, size, (id) => this.ctx.viewer.segmentColour(name, id));
    if (entry.wanted.length <= 1) entry.text = `Object: level ${read.level}, ${g.text}`;
    void buildBlockAsync({ primitives: g.prims, objectCount: g.objectCount }).then(
      (block) => {
        if (part.building !== key) return;
        part.building = undefined;
        part.done = { key, block, serial: ++geometrySerial, ...(g.ids ? { ids: g.ids } : {}), ...(g.colours ? { colours: g.colours } : {}), ...(g.groups ? { groups: g.groups } : {}) };
        this.update();
      },
      (e: Error) => {
        if (part.building !== key) return;
        part.building = undefined;
        part.failed = true;
        this.problem = `The surfaces could not be built: ${e.message}`;
        this.statusUpdate?.();
      },
    );
  }

  /** The surfaces' look for a frame: each object's colour (its segment's) and layer, each layer's cuts, its segments' picks. */
  private surfacesLook(frame: Frame3d): LiveLook["geometry"] {
    const layout = this.surfaceLayout;
    const s = this.live.heldSurfaces;
    if (layout === undefined || s === undefined) return undefined;
    const colours = new Float32Array(4 * s.objectCount);
    const keyParts: unknown[] = [];
    const picks: { base: number; first: number; count: number }[] = [];
    const layers = layout.layers.map((x, li) => {
      const layer = this.ctx.viewer.layers().find((l) => l.name === x.name);
      // Grouped points and lines: their groups as the layer's Vertex colour has them now (those not shown hidden).
      const look = x.groups && layer ? groupColours(this.lookOf(layer)) : undefined;
      for (let i = 0; i < x.objectCount; ++i) {
        // A mesh's segments as the layer colours them now; points' and lines' groups likewise; else as coloured.
        const g = x.groups?.[i];
        const c = x.ids ? (this.ctx.viewer.segmentColour(x.name, x.ids[i]) ?? [0.8, 0.8, 0.8]) : look && g ? look.colour(g.group, g.stored) : x.colours!.subarray(3 * i, 3 * i + 3);
        const shown = layer !== undefined && (look === undefined || g === undefined || look.shows(g.group));
        colours.set([c[0], c[1], c[2], shown ? li + 1 : 0], 4 * (x.offset + i));
      }
      keyParts.push(x.ids || x.groups ? Array.from(colours.subarray(4 * x.offset, 4 * (x.offset + x.objectCount))) : [x.serials, layer !== undefined]);
      // Segments picked as Neuroglancer's meshes are: under the mouse, and selected by a double-click.
      picks.push({ base: x.ids && layer ? (frame.registerPicks?.(x.name, x.ids) ?? 0) : 0, first: x.offset, count: x.objectCount });
      const { clips } = layer ? this.cropsFor(layer, frame) : { clips: [] };
      return { clips, crop: null, material: this.surfaceOf(x.name) };
    });
    return { colours, key: JSON.stringify([layout.key, keyParts]), layers, exposure: this.saved.exposure, picks };
  }

  /** A geometry layer's surfaces' material: its own, else the default's. */
  private surfaceOf(name: string): SurfaceMaterial {
    return { ...DEFAULT_SURFACE, ...(this.saved.looks[name]?.surface ?? {}) };
  }

  /** The layers that can be objects: precomputed segmentations (their chosen segments) and Zarr Vectors stores (their geometry). */
  private objectLayers(): LayerInfo[] {
    return this.ctx.viewer.layers().filter((l) => zarrVectorsStore(l.sources[0]) !== undefined || (l.type === "segmentation" && /^precomputed:\/\//i.test(l.sources[0]?.trim() ?? "")));
  }

  /** The layer whose objects are drawn: the one named, else the first. */
  private objectsLayer(): LayerInfo | undefined {
    const layers = this.objectLayers();
    return layers.find((l) => l.name === this.saved.objects.layer) ?? layers[0];
  }

  /** The objects a session is opened with: the objects layer's chosen segments (the first 64), on a render computer; else undefined. */
  private objectsSpec(): ObjectsSpec | undefined {
    const o = this.saved.objects;
    // A Zarr Vectors layer alone (no image) is always drawn: it is the scene.
    const alone = this.vectorsAlone();
    if ((!o.on && alone === undefined) || this.saved.where !== "host") return undefined;
    const layer = alone ?? this.objectsLayer();
    const store = layer ? zarrVectorsStore(layer.sources[0]) : undefined;
    if (store !== undefined) {
      // The attributes the layer is coloured by, read with its geometry (another attribute opens the session again).
      const attributes = lookAttributes(this.lookOf(layer!));
      return { url: store, store: "zarr-vectors", vertices: Math.round(o.budget / 75), ...(attributes.length > 0 ? { attributes } : {}) };
    }
    const url = layer ? renderSource(layer.sources[0]) : undefined;
    if (layer === undefined || url === undefined || !url.startsWith("precomputed://")) return undefined;
    const seen = this.ctx.viewer.visibleSegments(layer.name);
    if (seen === undefined || seen.all || seen.size === 0) return undefined;
    const ids = Array.from(seen.ids().slice(0, MAX_OBJECTS), (x) => x.toString()).sort();
    return { url, ids, lod: o.lod, budget: o.budget, inside: o.inside };
  }

  /** How the objects are drawn in a view: shown, surfaces, the image within them, its tint, and each segment's colour as Neuroglancer colours it. */
  private objectsView(): ViewSpec["objects"] {
    const spec = this.objectsSpec();
    const layer = this.vectorsAlone() ?? this.objectsLayer();
    if (spec === undefined || layer === undefined) return { show: false };
    const o = this.saved.objects;
    if (spec.store === "zarr-vectors") {
      // Coloured as the layer is: by a group (the groups not chosen hidden) or an attribute through its map and window.
      const look = this.lookOf(layer);
      const colour = look?.by === "group" && look.group !== undefined
        ? { by: "group", group: look.group }
        : look?.by === "attribute" && look.attribute !== undefined
          ? { by: "attribute", attribute: look.attribute, lut: colormapSamples(look.colormap ?? "viridis", 32) ?? colormapSamples("viridis", 32), low: look.low ?? look.range?.[0], high: look.high ?? look.range?.[1], hideOutside: look.hideOutside === true }
          : undefined;
      return { show: true, surface: 1, image: false, mix: 0, ...(colour !== undefined ? { colour } : {}) };
    }
    const colors = Object.fromEntries((spec.ids ?? []).map((id): [string, [number, number, number]] => [id, this.ctx.viewer.segmentColour(layer.name, BigInt(id)) ?? [0.85, 0.6, 0.45]]));
    return { show: true, surface: o.surface, image: o.image, mix: o.mix, colors };
  }

  /** Follows the objects layer's chosen segments: another choice opens the session again with them. */
  private objectsWatch: { layer: string; off: () => void } | undefined;
  private watchObjects(): void {
    const name = this.saved.objects.on ? this.objectsLayer()?.name : undefined;
    if (name === this.objectsWatch?.layer) return;
    this.objectsWatch?.off();
    this.objectsWatch = name === undefined ? undefined : { layer: name, off: this.ctx.viewer.onSegmentsChanged(name, () => this.update()) };
  }

  /** The chosen preset's domain ("percentile", "data" or "window"), as far as the page knows it. */
  private presetDomain(layer = this.edited()): string | undefined {
    const s = this.saved;
    const name = this.presetName(layer);
    const custom = s.customPresets.find((p) => p.name === name) as { domain?: unknown } | undefined;
    const d = custom?.domain ?? (s.where === "browser" ? LOCAL_PRESETS.find((p) => p.name === name)?.domain : this.presets.find((p) => p.name === name)?.domain);
    return typeof d === "string" ? d : undefined;
  }

  /** Where a preset's colours came from: the photographs it lists (with their authors and licences). */
  private references(): { title: string; page?: string; author: string; licence: string }[] {
    const list = (this.saved.where === "browser" ? LOCAL_PRESETS : this.presets) as unknown as Record<string, unknown>[];
    const name = this.presetName();
    const info = list.find((p) => p.name === name);
    const refs = Array.isArray(info?.reference) ? (info!.reference as { title?: string; page?: string; author?: string; licence?: string }[]) : [];
    return refs.map((r) => ({ title: (r.title ?? "a photograph").replace(/^File:/, ""), page: safeHref(r.page), author: r.author ?? "unknown", licence: r.licence ?? "" }));
  }

  /**
   * The chosen preset at this image's data values (its window, percentiles or histogram matching placed):
   * what the editor shows. On a computer, as the host resolves it; in this browser, from the level held here.
   */
  private resolved: { key: string; preset: Record<string, unknown> } | undefined;
  private editor: ColourmapEditor | undefined;

  private presetRequest(): { key: string; preset: string | Record<string, unknown>; overrides: Record<string, unknown> } | undefined {
    const s = this.saved;
    const edited = this.edited();
    const src = edited ? this.sourceOf(edited) : undefined;
    const browser = s.where === "browser";
    const level = src !== undefined ? this.live.levelOf(src) : undefined;
    // On a computer, the session is the first image's: its editor is for that one only.
    if (src === undefined || (browser ? level === undefined : this.session?.status !== "ready" || edited?.name !== this.target()?.name)) return undefined;
    const name = this.presetName(edited);
    const preset = (s.customPresets.find((p) => p.name === name) as Record<string, unknown> | undefined) ?? (name || "HiP-CT brain");
    const overrides: Record<string, unknown> = s.windows[src] && this.presetDomain() === "window" ? { window: s.windows[src] } : {};
    const on = browser ? ["browser", src, level!.path] : [this.session!.id];
    return { key: JSON.stringify([...on, preset, overrides]), preset, overrides };
  }

  /** Places the chosen preset's stops on this image's values (when that may have changed): the host does, or this browser from its level. */
  private async resolvePreset(): Promise<void> {
    const r = this.presetRequest();
    if (r === undefined || this.resolved?.key === r.key) return;
    const edited = this.edited();
    const level = edited ? this.live.levelOf(this.sourceOf(edited) ?? "") : undefined;
    if (this.saved.where === "browser" && level !== undefined) {
      const base = typeof r.preset === "object" ? r.preset : (LOCAL_PRESETS.find((p) => p.name === r.preset) ?? LOCAL_PRESETS[0]);
      this.resolved = { key: r.key, preset: levelResolved({ ...base, ...r.overrides } as unknown as LevelPreset, level) as unknown as Record<string, unknown> };
      this.panelUpdate?.();
      this.lastKey = "";
      this.handle?.redraw();
      return;
    }
    if (!this.service) return;
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
    const edited = this.edited();
    const src = edited ? this.sourceOf(edited) : undefined;
    if (src === undefined) return undefined;
    return { src, tuning: this.saved.tunings[src] ?? { shift: 0, scale: 1 } };
  }

  /** The stops the editor shows (on the colourmap's axis: as tuned for this image, or as resolved, then shifted and
   * compressed), the histogram's warp, and the stops at the image's values (through the warp): what is sent. */
  private editedStops(): { stops: DataStop[]; base: DataStop[]; centre: number; warp: WarpPoint[]; data: DataStop[] } | undefined {
    const r = this.presetRequest();
    if (!this.resolved || r === undefined || this.resolved.key !== r.key) return undefined;
    return tuneStops((this.resolved.preset.stops as DataStop[]) ?? [], this.currentTuning()?.tuning, this.histogram());
  }

  /** The preset as tuned for this image (whole, at data values), when it is tuned; else undefined. */
  private tunedPreset(): Record<string, unknown> | undefined {
    if (!isTuned(this.currentTuning()?.tuning)) return undefined;
    const e = this.editedStops();
    if (!e || !this.resolved) return undefined;
    // Without what only describes it (photographs, measured colours): it goes with every view.
    const { reference: _r, measured: _m, histogram: _h, design_scan: _d, ...rest } = this.resolved.preset;
    return { ...rest, stops: e.data, domain: "data", window: null, histogram: null };
  }

  /** The image's histogram for the editor: the host's, or in this browser the level held here's. */
  private histogram(): { lo: number; hi: number; counts: number[] } | undefined {
    if (this.saved.where !== "browser") return (this.session?.volume as { histogram?: { lo: number; hi: number; counts: number[] } } | undefined)?.histogram;
    const edited = this.edited();
    const level = edited ? this.live.levelOf(this.sourceOf(edited) ?? "") : undefined;
    return level === undefined ? undefined : this.histogramOf(level);
  }

  /** A level's histogram, worked out once. */
  private readonly histograms = new WeakMap<Level8, { lo: number; hi: number; counts: number[] }>();
  private histogramOf(level: Level8): { lo: number; hi: number; counts: number[] } {
    let h = this.histograms.get(level);
    if (h === undefined) this.histograms.set(level, (h = levelHistogram(level)));
    return h;
  }

  /** The editor's canvas and its histogram: shown again from the state (not while a point is dragged). */
  private editorUpdate: (() => void) | undefined;

  /** The colourmap editor for the image now (made once, kept). */
  private colourmapEditor(): ColourmapEditor {
    // Each change shown and rendered while it is made, kept (one undo step) once it is done.
    this.editor ??= new ColourmapEditor({
      // Edits are kept unshifted, so shift and compression stay apart from them.
      stops: (base, final) => this.tune((n) => (n.stops = base), !final),
      map: (shift, scale, final) => this.tune((n) => Object.assign(n, { shift, scale }), !final),
      warp: (warp, final) => this.tune((n) => (n.warp = warp), !final),
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
    this.syncShapes();
  }

  // ------------------------------------------------- crops and cuts in the views

  /**
   * A point in display coordinates (the 3-D view's dimensions) in global ones, the other dimensions at
   * the position; or a direction (`vector`), 0 along the others.
   */
  private toGlobal(d: ArrayLike<number>, names: readonly string[], vector = false): number[] {
    const ng = this.ctx.viewer.getState() as { dimensions?: Record<string, unknown>; position?: number[] };
    const global = Object.keys(ng.dimensions ?? {});
    const out = vector ? global.map(() => 0) : (ng.position ?? []).slice();
    names.forEach((n, i) => {
      const k = global.indexOf(n);
      if (k >= 0 && i < 3) out[k] = d[i];
    });
    return out;
  }

  private toDisplay(g: ArrayLike<number>, names: readonly string[]): [number, number, number] {
    const ng = this.ctx.viewer.getState() as { dimensions?: Record<string, unknown> };
    const global = Object.keys(ng.dimensions ?? {});
    return [0, 1, 2].map((i) => g[global.indexOf(names[i])] ?? 0) as [number, number, number];
  }

  /** The image whose crops the panel and the views show (its own, beside all layers'): the one selected, else the first rendered. */
  private cropLayer(): LayerInfo | undefined {
    const e = this.edited();
    return e !== undefined && this.isImage(e) ? e : this.target();
  }

  /** The scope of the crops a new one is added to: the image's own (all layers' when there is none). */
  private ownScope(): CropScope {
    return this.cropLayer()?.name ?? null;
  }

  /** The planes or boxes the panel and the views show: the image's own, then all layers'. */
  private cropRows(kind: "planes" | "boxes"): { scope: CropScope; i: number }[] {
    const own = this.ownScope();
    const rows: { scope: CropScope; i: number }[] = [];
    if (own !== null) cropsOf(this.saved, own)[kind].forEach((_, i) => rows.push({ scope: own, i }));
    this.saved[kind].forEach((_, i) => rows.push({ scope: null, i }));
    return rows;
  }

  /** An axis plane's scope: all layers' while that is on, else the image's own. */
  private cutScope(i: number): CropScope {
    return this.saved.cuts[i]?.on ? null : this.ownScope();
  }

  /** A box set from fractions of the image shown: its own as they are, all layers' as millimetres; undefined until its level is read. */
  private boxFrom(scope: CropScope, f: { lo: number[]; hi: number[] }): Pick<Crop, "lo" | "hi" | "mm"> | undefined {
    const clamp = (v: number[]) => v.map((x) => Math.min(1, Math.max(0, x))) as [number, number, number];
    if (scope !== null) return { lo: clamp(f.lo), hi: clamp(f.hi) };
    const at = this.placedLevel(this.cropLayer());
    if (at === undefined) return undefined;
    return { ...fractionsToMm(f, at), mm: true };
  }

  /** A box as fractions of the image shown (for its sliders and handles); undefined until the levels are read. */
  private boxShown(scope: CropScope, b: Crop): { lo: number[]; hi: number[] } | undefined {
    const layer = this.cropLayer();
    return layer ? this.boxIn(b, scope, layer) : scope === null ? b : undefined;
  }

  /** Sets a box's ends from fractions of the image shown (a slider, a handle, a card). */
  private setBox(scope: CropScope, i: number, f: { lo: number[]; hi: number[] }, done: boolean): void {
    const patch = this.boxFrom(scope, f);
    if (patch === undefined) return;
    const change = (x: Saved) => editCrops(x, scope, (c) => void (c.boxes[i] = { ...c.boxes[i], ...patch }));
    if (done) this.save(change);
    else this.preview(change);
  }

  /** Moves a camera plane or box between the image's own and all layers' (each layer rendered is then cut by it). */
  private shareItem(kind: "planes" | "boxes", scope: CropScope, i: number): void {
    const own = this.ownScope();
    if (own === null) return;
    const item = cropsOf(this.saved, scope)[kind][i];
    if (item === undefined) return;
    let moved: CameraPlane | Crop = { ...item };
    if (kind === "boxes") {
      const b = item as Crop;
      const f = scope === null ? this.boxShown(null, b) : b;
      const patch = f && this.boxFrom(scope === null ? own : null, f);
      if (patch === undefined) return void this.ctx.ui.toast("The image is still being read: try again in a moment.", "error");
      const { mm: _mm, ...rest } = b;
      moved = { ...rest, ...patch };
    }
    this.save((x) => {
      editCrops(x, scope, (c) => void c[kind].splice(i, 1));
      editCrops(x, scope === null ? own : null, (c) => void (c[kind] as (CameraPlane | Crop)[]).push(moved));
    });
  }

  /** Moves an axis plane between the image's own and all layers' (each layer's own across that axis turned off). */
  private shareCut(i: number, all: boolean): void {
    const own = this.ownScope();
    if (own === null) return;
    this.save((x) => {
      if (all) {
        const c = cropsOf(x, own).cuts[i];
        editCrops(x, null, (s) => void (s.cuts[i] = { ...c, on: true }));
        for (const name of Object.keys(x.looks)) if (x.looks[name].cuts?.[i]?.on) editCrops(x, name, (s) => void (s.cuts[i].on = false));
      } else {
        const c = x.cuts[i];
        editCrops(x, own, (s) => void (s.cuts[i] = { ...c }));
        editCrops(x, null, (s) => void (s.cuts[i].on = false));
      }
    });
  }

  /** A layer's held level's voxel axes in display coordinates, and its size; undefined without a level, or with turned axes. */
  private levelFrame(frame: Frame3d, layer = this.cropLayer()): { axes: NonNullable<ReturnType<typeof levelAxes>>; size: [number, number, number] } | undefined {
    const src = layer ? this.sourceOf(layer) : undefined;
    const level = src !== undefined ? this.live.levelOf(src) : this.live.heldLevel;
    const d = displayFromPhysical(frame.dimensions);
    const first = layer;
    const placement = first ? this.placementOf(first) : undefined;
    const axes = level && d && levelAxes(d, placement ? mul(rowMajor(placement), level.voxelToRas) : level.voxelToRas);
    return axes && level ? { axes, size: level.size } : undefined;
  }

  /** The tissue's centre in display coordinates: the held level's middle, else the host's tissue box's, else undefined. */
  private tissueCentre(frame: Frame3d): number[] | undefined {
    const held = this.levelFrame(frame);
    if (held !== undefined) {
      const box = cropToDisplay({ lo: [0, 0, 0], hi: [1, 1, 1] }, held.size, held.axes);
      return box.lower.map((v, i) => (v + box.upper[i]) / 2);
    }
    const tissue = (this.session?.volume as { tissue_mm?: [number[], number[]] | null } | undefined)?.tissue_mm;
    const m = displayFromPhysical(frame.dimensions);
    if (!tissue || m === undefined) return undefined;
    const toDisplay = (p: number[]) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    const a = toDisplay(tissue[0]);
    const b = toDisplay(tissue[1]);
    return a.map((v, i) => (v + b[i]) / 2);
  }

  /**
   * Puts the crops and cuts that are on in the views as shapes with handles
   * (while rendering, once the 3-D view has drawn): a box's corners and
   * faces, a camera plane's centre (along its normal) and ring (turning
   * it), an axis plane's centre.  Dragging one writes what its sliders do.
   */
  private syncShapes(): void {
    const frame = this.lastFrame;
    const want = new Map<string, { shape: ViewShape; key: string }>();
    if (this.saved.on && this.handle !== undefined && frame !== undefined) {
      const names = frame.dimensions.names;
      const mm = unitMm(frame.dimensions);
      const held = this.levelFrame(frame);
      // The volume's longest side: how large a plane is drawn.
      const whole = held && cropToDisplay({ lo: [0, 0, 0], hi: [1, 1, 1] }, held.size, held.axes);
      const size = whole ? Math.max(...whole.upper.map((v, i) => v - whole.lower[i])) : undefined;
      const g = (d: ArrayLike<number>) => this.toGlobal(d, names);
      const dsp = (v: ArrayLike<number>) => this.toDisplay(v, names);
      if (held !== undefined) {
        for (const { scope, i } of this.cropRows("boxes")) {
          const b = cropsOf(this.saved, scope).boxes[i];
          const f = b.on ? this.boxShown(scope, b) : undefined;
          if (f === undefined) continue;
          const box = cropToDisplay(f, held.size, held.axes);
          const id = shapeId("box", scope, i);
          want.set(id, {
            key: JSON.stringify(["box", f, held.size, held.axes, names, b.name]),
            shape: {
              id,
              kind: "box",
              label: scope === null ? `${b.name} (all layers)` : b.name,
              lower: g(box.lower),
              upper: g(box.upper),
              card: (host) => this.boxCard(host, scope, i),
              onChange: ({ lower, upper }, done) => this.setBox(scope, i, displayToCrop(dsp(lower), dsp(upper), held.size, held.axes), done),
            },
          });
        }
      }
      for (const { scope, i } of this.cropRows("planes")) {
        const p = cropsOf(this.saved, scope).planes[i];
        if (!p.on || p.normal.every((v) => v === 0)) continue;
        const at = planeShape(p, mm);
        const id = shapeId("plane", scope, i);
        want.set(id, {
          key: JSON.stringify(["plane", p, size, names, mm]),
          shape: {
            id,
            kind: "plane",
            label: scope === null ? `${p.name} (all layers)` : p.name,
            point: g(at.point),
            normal: this.toGlobal(at.normal, names, true),
            ...(size !== undefined ? { size } : {}),
            card: (host) => this.planeCard(host, scope, i),
            onChange: ({ point, normal }, done) => {
              const change = (x: Saved) => editCrops(x, scope, (c) => void (c.planes[i] = planeFromShape(c.planes[i], dsp(point), dsp(normal), mm)));
              if (done) this.save(change);
              else this.preview(change);
            },
          },
        });
      }
      [0, 1, 2].forEach((i) => {
        const scope = this.cutScope(i);
        const c = cropsOf(this.saved, scope).cuts[i];
        const k = names.indexOf(c.axis);
        if (!c.on || k < 0 || k > 2) return;
        const at = cutShape(c, k, frame.position, mm);
        const normal = [0, 0, 0];
        normal[k] = c.keep;
        want.set(`cut${i}`, {
          key: JSON.stringify(["cut", c, scope === null, size, names, mm, Array.from(frame.position)]),
          shape: {
            id: `cut${i}`,
            kind: "plane",
            label: scope === null ? `Across ${c.axis} (all layers)` : `Across ${c.axis}`,
            point: g(at.point),
            normal: this.toGlobal(normal, names, true),
            turns: false,
            ...(size !== undefined ? { size } : {}),
            card: (host) => this.cutCard(host, i),
            onChange: ({ point }, done) => {
              const offset = Math.round(cutOffset(dsp(point), k, this.lastFrame?.position ?? frame.position, mm) * 100) / 100;
              const change = (x: Saved) => editCrops(x, scope, (s) => void (s.cuts[i] = { ...s.cuts[i], offset }));
              if (done) this.save(change);
              else this.preview(change);
            },
          },
        });
      });
    }
    for (const [id, { handle }] of this.shapes) {
      if (want.has(id)) continue;
      handle.dispose();
      this.shapes.delete(id);
    }
    for (const [id, { shape, key }] of want) {
      const had = this.shapes.get(id);
      if (had?.key === key) continue;
      if (had !== undefined) {
        had.handle.update(shape);
        had.key = key;
      } else this.shapes.set(id, { handle: this.ctx.views.add(shape), key });
    }
    this.cardSync?.();
  }

  /** A card's number box that sets itself from the state as it changes (a drag). */
  private cardNumber(label: string, get: () => number | undefined, set: (v: number) => void, updates: (() => void)[], attrs: Record<string, string> = {}): HTMLElement[] {
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const input = numberInput(round(get() ?? 0), set, { "aria-label": label, ...attrs });
    updates.push(() => {
      const v = get();
      if (v !== undefined) input.set(round(v));
    });
    return [el("span", { class: "muted" }, label), input];
  }

  private cardDone(updates: (() => void)[]): Disposer {
    const sync = () => updates.forEach((u) => u());
    this.cardSync = sync;
    return () => {
      if (this.cardSync === sync) this.cardSync = undefined;
    };
  }

  /** The All layers switch beside a crop or cut: pressed while it cuts every image rendered. */
  private allButton(pressed: boolean, what: string, onclick: () => void): HTMLButtonElement {
    const b = el("button", {
      class: "btn outline small ar-all",
      type: "button",
      "aria-pressed": String(pressed),
      title: pressed ? `${what} cuts every image rendered: press to keep it for this image alone` : `${what} cuts this image alone: press to cut every image rendered`,
      onclick,
    }, "All layers");
    b.disabled = this.ownScope() === null;
    return b;
  }

  /** A crop box's card: keeps or cuts out, its ends as fractions of the volume, all layers or this one, remove. */
  private boxCard(host: HTMLElement, scope: CropScope, i: number): Disposer {
    const updates: (() => void)[] = [];
    const b = () => cropsOf(this.saved, scope).boxes[i];
    const f = () => {
      const q = b();
      return q ? this.boxShown(scope, q) : undefined;
    };
    const keep = select([["keep", "Keeps its inside"], ["cut", "Cuts its inside out"]], b()?.keep === false ? "cut" : "keep", (v) => this.save((x) => editCrops(x, scope, (c) => void (c.boxes[i].keep = v === "keep"))), "What the box does");
    updates.push(() => keep.set(b()?.keep === false ? "cut" : "keep"));
    const end = (which: "lo" | "hi", k: number) => (v: number) => {
      const q = f();
      if (q === undefined) return;
      const lo = [...q.lo], hi = [...q.hi];
      if (which === "lo") lo[k] = Math.max(0, Math.min(v, hi[k] - 0.005));
      else hi[k] = Math.min(1, Math.max(v, lo[k] + 0.005));
      this.setBox(scope, i, { lo, hi }, true);
    };
    const values = (["x", "y", "z"] as const).flatMap((axis, k) => [
      ...this.cardNumber(`${axis} from`, () => f()?.lo[k], end("lo", k), updates, { step: "0.005", min: "0", max: "1" }),
      ...this.cardNumber("to", () => f()?.hi[k], end("hi", k), updates, { step: "0.005", min: "0", max: "1" }),
    ]);
    host.append(
      keep,
      el("div", { class: "view-card-grid" }, ...values),
      el("p", { class: "hint" }, scope === null ? `Fractions of ${this.cropLayer()?.name ?? "the image"}; it cuts every image rendered.` : "Fractions of the volume along its axes."),
      el("div", { class: "row" },
        this.allButton(scope === null, "This box", () => this.shareItem("boxes", scope, i)),
        el("span", { class: "spacer" }),
        button("Remove", () => this.save((x) => editCrops(x, scope, (c) => void c.boxes.splice(i, 1))), "Remove this box", "btn small danger")),
    );
    return this.cardDone(updates);
  }

  /** A camera plane's card: its offset in mm, set again from the view, all layers or this one, remove. */
  private planeCard(host: HTMLElement, scope: CropScope, i: number): Disposer {
    const updates: (() => void)[] = [];
    const offset = this.cardNumber("Offset (mm)", () => cropsOf(this.saved, scope).planes[i]?.offset, (v) => this.save((x) => editCrops(x, scope, (c) => void (c.planes[i].offset = v))), updates, { step: "0.5" });
    host.append(
      el("div", { class: "view-card-grid" }, ...offset),
      el("p", { class: "hint" }, "Drag its centre along its normal; drag the ring to turn it."),
      el(
        "div",
        { class: "row" },
        button("Face the camera", () => this.setPlaneToView(scope, i), "Set it across the view as it is now"),
        this.allButton(scope === null, "This plane", () => this.shareItem("planes", scope, i)),
        el("span", { class: "spacer" }),
        button("Remove", () => this.save((x) => editCrops(x, scope, (c) => void c.planes.splice(i, 1))), "Remove this plane", "btn small danger"),
      ),
    );
    return this.cardDone(updates);
  }

  /** An axis plane's card: the side it keeps, its offset in mm, all layers or this one, off. */
  private cutCard(host: HTMLElement, i: number): Disposer {
    const updates: (() => void)[] = [];
    const c = () => cropsOf(this.saved, this.cutScope(i)).cuts[i];
    const edit = (f: (q: Cut) => void) => this.save((x) => editCrops(x, this.cutScope(i), (s) => f(s.cuts[i])));
    const side = select([["-1", "Keeps the − side"], ["1", "Keeps the + side"]], String(c()?.keep ?? -1), (v) => edit((q) => (q.keep = Number(v) as 1 | -1)), "Side kept");
    updates.push(() => side.set(String(c()?.keep ?? -1)));
    const offset = this.cardNumber("Offset (mm)", () => c()?.offset, (v) => edit((q) => (q.offset = v)), updates, { step: "0.5" });
    host.append(
      side,
      el("div", { class: "view-card-grid" }, ...offset),
      el("div", { class: "row" },
        this.allButton(this.cutScope(i) === null, "This plane", () => this.shareCut(i, this.cutScope(i) !== null)),
        el("span", { class: "spacer" }),
        button("Turn off", () => edit((q) => (q.on = false)), "Turn this axis plane off")),
    );
    return this.cardDone(updates);
  }

  /** A "window" preset's range for this image: the store, the image's values and the step; undefined otherwise. */
  private windowRange(): { src: string; lo: number; hi: number; step: number; guess?: [number, number] } | undefined {
    if (this.presetDomain() !== "window") return undefined;
    const edited = this.edited();
    const src = edited ? this.sourceOf(edited) : undefined;
    if (src === undefined) return undefined;
    if (this.saved.where === "browser") {
      // The level held here: its values' range, and the window guessed over them.
      const level = this.live.levelOf(src);
      if (level === undefined) return undefined;
      const [lo, hi] = level.range;
      const g = level.window;
      return { src, lo, hi, step: windowStep(lo, hi), guess: g ? [lo + (g[0] / 255) * (hi - lo), lo + (g[1] / 255) * (hi - lo)] : undefined };
    }
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

  /** Sets one end of the image's window; `preview`: rendered while its slider is dragged, saved when let go. */
  private setWindow(src: string, i: 0 | 1, v: number, guess: [number, number] | undefined, preview = false): void {
    const edit = (x: Saved) => {
      const cur = x.windows[src] ?? guess ?? [v, v + 1];
      const next: [number, number] = [cur[0], cur[1]];
      next[i] = v;
      // A new object, so the state saved before (an undo step) keeps its window.
      if (next[1] > next[0]) x.windows = { ...x.windows, [src]: next };
    };
    if (preview) this.preview(edit);
    else this.save(edit);
  }

  private labelsSource(): string | undefined {
    if (!this.saved.regions) return undefined;
    const segs = this.segmentations();
    const l = segs.find((s) => s.name === this.saved.labels) ?? segs[0];
    return l ? omeZarrSource(l.sources[0]) : undefined;
  }

  private async ensureSession(target: LayerInfo): Promise<void> {
    const service = this.service!;
    const url = this.sourceOf(target)!;
    const labels = this.labelsSource();
    const detailBudget = this.saved.detail ? this.saved.detailBudget : 0;
    // The channel and time point: another of either is another session (the computer cannot change them in place).
    const at = this.volumeAt(target);
    const objects = this.objectsSpec();
    const alone = url.startsWith(OBJECTS_ONLY);
    const key = JSON.stringify([service.link.base, url, labels, this.saved.budget, this.saved.jar, detailBudget, at.channel, at.time, objects ?? null]);
    if (key === this.sessionKey) return;
    this.closeSession();
    this.sessionKey = key;
    const abort = new AbortController();
    this.abort = abort;
    try {
      let info = await service.open({
        url,
        budget: this.saved.budget,
        detail_budget: alone ? 0 : detailBudget,
        ...(this.saved.jar && !alone ? { cylinder: JAR_FRACTION } : {}),
        ...(at.channel ? { channel: at.channel } : {}),
        ...(at.time ? { time: at.time } : {}),
      }, labels ? { url: labels } : undefined, objects);
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
    const url = this.sourceOf(target)!;
    const key = JSON.stringify([url, this.saved.objectVoxels]);
    if (key === this.localKey) return;
    this.closeLocal();
    this.localKey = key;
    const r = new LocalRenderer();
    this.local = r;
    r.onFrame = (f) => {
      if (this.local !== r) return;
      this.drawer.set({ bitmap: f.bitmap, depth: f.depth, camera: f.camera, look: f.tag });
      this.frameText = `${f.samples} samples, ${f.width}×${f.height}, ${f.msPerPass.toFixed(0)} ms a pass (this browser)`;
      this.handle?.redraw();
      this.statusUpdate?.();
    };
    try {
      this.localText = "Loading in this browser…";
      this.statusUpdate?.();
      this.localText = await r.load(url, this.saved.objectVoxels, (msg) => {
        this.localText = msg;
        this.statusUpdate?.();
      });
      if (r.level !== undefined) this.live.setLevel(r.level, url);
      this.lastKey = "";
      this.handle?.redraw();
    } catch (e) {
      this.localText = "";
      // The object needs no WebGPU (it reads the image itself and draws with WebGL): without it only the
      // path-traced picture at rest is missing, which is an error only when that is asked for.
      this.noWebGpu = (e as Error).message;
      if (this.saved.restPicture) this.problem = `This browser cannot path-trace the picture at rest: ${this.noWebGpu}`;
      void this.live.open(url, this.saved.objectVoxels);
    }
    this.statusUpdate?.();
  }

  private closeLocal(): void {
    this.local?.dispose();
    this.local = undefined;
    this.localKey = "";
    this.localText = "";
    this.noWebGpu = "";
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
        let sent = this.views.get(f.version);
        if (sent === undefined && this.pendingView !== undefined) {
          await this.pendingView;
          sent = this.views.get(f.version);
        }
        const cam = sent?.camera;
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
        this.drawer.set({ bitmap: f.bitmap, alpha: f.alpha ? { width: f.width, height: f.height, data: f.alpha } : undefined, depth: view ? undefined : this.depth, view, camera: cam, look: sent?.look });
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
    const first = this.target();
    const density = this.densityOf(first);
    const name = this.presetName(first);
    const overrides: Record<string, number | number[]> = { exposure: s.exposure };
    if (density !== undefined) overrides.density = density;
    const src = first ? this.sourceOf(first) : undefined;
    if (src !== undefined && s.windows[src] && this.presetDomain(first) === "window") overrides.window = s.windows[src];
    const tuned = first !== undefined && first.name === this.edited()?.name ? this.tunedPreset() : undefined;
    return {
      inv_view_projection: Array.from(frame.invViewProjection),
      width: frame.width,
      height: frame.height,
      scale,
      world_from_physical: wfp,
      orbit_center: Array.from(frame.position),
      unit_mm: unitMm(frame.dimensions),
      preset: tuned ?? (s.customPresets.find((p) => p.name === name) as Record<string, unknown> | undefined) ?? (name || "HiP-CT brain"),
      overrides: tuned ? { exposure: s.exposure, ...(density !== undefined ? { density } : {}) } : overrides,
      // The first image's crops and cuts: its own and all layers'.
      boxes: first ? this.cropsFor(first, frame).boxes : [],
      light: this.lightSpec(),
      environment: s.lightMap ? { map: s.lightMap, rotation: s.lightMapRotation, scale: s.envScale } : { scale: s.envScale },
      clips: first ? this.cropsFor(first, frame).clips : [],
      labels: s.regions ? { show: true, mix: s.labelMix, keep: s.keep, hidden: s.hidden } : { show: false },
      objects: this.objectsView(),
      background: [0, 0, 0, 0],
      max_samples: s.maxSamples,
      denoise: s.denoise,
      frame_format: "jpeg",
    };
  }

  private onFrame(frame: Frame3d): void {
    this.lastFrame = frame;
    this.syncShapes();
    const look = JSON.stringify([this.objectsView(), this.saved.boxes, this.saved.customPresets.length, this.saved.preset, this.saved.density, this.saved.looks, this.renderedLayers().map((l) => l.name), this.saved.exposure, this.saved.windows, this.saved.tunings, this.resolved?.key, this.saved.lightFrom, this.saved.lightAzimuth, this.saved.lightElevation, this.saved.lightMap, this.saved.lightMapRotation, this.saved.lightStyle, this.saved.envScale, this.saved.lightKey, this.saved.planes, this.saved.cuts, this.saved.regions, this.saved.labelMix, this.saved.keep, this.saved.hidden, this.saved.maxSamples, this.saved.denoise, frame.position]);
    this.drawer.look = look;
    this.drawer.pictureAtRest = this.saved.restPicture;
    // A camera plane of before that turned with the view: fixed now, as the view is.
    if (this.saved.planes.some((p) => p.normal.every((x) => x === 0))) {
      this.save((x) => (x.planes = x.planes.map((p) => (p.normal.every((v) => v === 0) ? { ...planeFromView(frame.invViewProjection, frame.position, p.name), on: p.on, offset: p.offset } : p))));
    }
    const local = this.saved.where === "browser" ? this.local : undefined;
    // Meshes' detail by distance: chosen again where the camera comes to rest far from where it was chosen.
    if (this.saved.where === "browser" && !frame.moving) this.lodCheck(frame);
    // The scene's surfaces in WebGPU's picture too, as this frame draws them (no picks: that is not a drawing); its
    // picture made again only when they change.
    if (local?.ready) local.setSurfaces(this.live.heldSurfaces, this.surfacesLook({ ...frame, registerPicks: undefined }));
    if (this.saved.where === "browser" && local === undefined && this.live.ready()) {
      // Several images drawn as one: the object is all the view shows.
      const spec = this.viewSpec(frame, 1);
      if (spec !== undefined) this.lastSpec = spec;
      return;
    }
    const sid = local ? "local" : this.session?.status === "ready" ? this.session.id : undefined;
    if (sid === undefined || (local && !local.ready)) return;
    if (this.live.ready() && !this.saved.restPicture) {
      // The object is all the view shows: views go to the host only for stills, movies and splats.
      const spec = this.viewSpec(frame, 1);
      if (spec !== undefined) this.lastSpec = spec;
      return;
    }
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
        this.send(sid, full, this.lastLook);
      }, SETTLE_MS);
    }
    // While the camera moves, the live image follows it and nothing is rendered until it stops. Without
    // one, the picture shown stays in space (a surface drawn with the camera now); only a view gone far
    // from the picture's gets a quick half-size one.
    const placed = this.drawer.placed();
    if (moving && (this.live.ready() || (sameLook && placed !== undefined && !farFrom(placed, frame)))) return;
    const spec = this.viewSpec(frame, scale);
    if (spec === undefined) return;
    if (scale === 1) this.lastSpec = spec;
    this.send(sid, spec, look);
  }

  /** The key light: from the camera (in front, or behind the object as the camera sees it), turning with it; or fixed in the scene. */
  private lightSpec(): NonNullable<ViewSpec["light"]> {
    const s = this.saved;
    const rgb: [number, number, number] = [3.2 * s.lightKey, 3.0 * s.lightKey, 2.8 * s.lightKey];
    if (s.lightFrom === "scene") return { direction: sceneDirection(s.lightAzimuth, s.lightElevation), camera_space: false, rgb };
    const d = lightDirection(s.lightAzimuth, s.lightElevation);
    return { direction: s.lightFrom === "back" ? [d[0], d[1], -d[2]] : d, camera_space: true, rgb };
  }

  /** The key light from the camera now, fixed in the scene where it is (Light from › Scene). */
  private fixLight(): void {
    const f = this.lastFrame;
    if (f === undefined) return void this.ctx.ui.toast("Look at the image in the 3-D view first.", "error");
    const d = this.lightSpec().direction;
    const [right, up, back] = cameraAxes(rowMajor(f.invViewProjection));
    const w = [0, 1, 2].map((i) => d[0] * right[i] + d[1] * up[i] + d[2] * back[i]);
    const a = sceneAngles(w);
    this.save((x) => ([x.lightFrom, x.lightAzimuth, x.lightElevation] = ["scene", a.around, a.up]));
  }

  // ------------------------------------------------------- crops of each layer

  /** A layer's level held here, placed: voxels to millimetres (row-major) and its size; undefined until it is read. */
  private placedLevel(layer: LayerInfo | undefined): { m: number[]; size: number[] } | undefined {
    const src = layer ? this.sourceOf(layer) : undefined;
    const level = src !== undefined ? this.live.levelOf(src) : undefined;
    if (level === undefined) return undefined;
    const p = this.placementOf(layer!);
    return { m: p ? mul(rowMajor(p), level.voxelToRas) : level.voxelToRas, size: level.size };
  }

  /** A box's millimetres: one for all layers as it is, else (from before) from the first image's fractions; undefined until that is read. */
  private boxMm(b: Crop): { lo: number[]; hi: number[] } | undefined {
    if (b.mm) return b;
    const at = this.placedLevel(this.target());
    return at && fractionsToMm(b, at);
  }

  /** A box as fractions of a layer's volume: its own as they are, else through millimetres; undefined until the levels are read. */
  private boxIn(b: Crop, scope: CropScope, layer: LayerInfo): { lo: number[]; hi: number[] } | undefined {
    if (scope !== null || (!b.mm && layer.name === this.target()?.name)) return b;
    const mm = this.boxMm(b);
    const at = this.placedLevel(layer);
    return mm && at ? mmToFractions(mm, at) : undefined;
  }

  /**
   * What cuts a layer: its own crops and cuts and all layers' (the boxes as fractions of its volume), the crop the
   * boxes that keep make (the box about them, null for none) and its cuts as planes (at most MAX_CLIPS).
   */
  private cropsFor(layer: LayerInfo, frame: Frame3d): { boxes: { lo: number[]; hi: number[]; keep: boolean }[]; crop: [number[], number[]] | null; clips: [number, number, number, number][] } {
    const own = cropsOf(this.saved, layer.name);
    const all = cropsOf(this.saved, null);
    const boxes: { lo: number[]; hi: number[]; keep: boolean }[] = [];
    for (const [scope, set] of [[layer.name, own], [null, all]] as const) {
      for (const b of set.boxes) {
        if (!b.on) continue;
        const f = this.boxIn(b, scope, layer);
        if (f) boxes.push({ lo: f.lo, hi: f.hi, keep: b.keep });
      }
    }
    const keep = boxes.filter((b) => b.keep);
    const crop: [number[], number[]] | null = keep.length
      ? [[0, 1, 2].map((a) => Math.min(...keep.map((b) => b.lo[a]))), [0, 1, 2].map((a) => Math.max(...keep.map((b) => b.hi[a])))]
      : null;
    const planes = [...all.planes, ...own.planes].filter((p) => p.on && p.normal.some((x) => x !== 0));
    const clips = [
      ...clipPlanes([...all.cuts, ...own.cuts], frame.position, frame.dimensions),
      ...planes.map((p) => planeClip(p, frame.dimensions)),
    ].slice(0, MAX_CLIPS) as [number, number, number, number][];
    return { boxes, crop, clips };
  }

  /**
   * The live image's look for a frame: the view the path tracer would be sent, and its preset whole, at
   * the image's data values as the host resolved it when it has (so the two agree), else as named.
   */
  private liveLook(frame: Frame3d): LiveLook | undefined {
    const view = this.viewSpec(frame, 1);
    if (view === undefined) return undefined;
    const first = this.target();
    if (this.saved.where !== "browser") {
      // On a computer: the first image alone, as the computer renders it.
      const r = this.presetRequest();
      const resolved = r !== undefined && this.resolved?.key === r.key ? this.resolved.preset : undefined;
      const named = (name: string) => this.presets.find((p) => p.name === name) ?? LOCAL_PRESETS.find((p) => p.name === name);
      const base = typeof view.preset === "object" ? view.preset : (resolved ?? named(view.preset));
      const preset = { ...(base ?? LOCAL_PRESETS[0]), ...(view.overrides ?? {}) } as unknown as LivePreset;
      const url = first ? this.sourceOf(first) : undefined;
      return Array.isArray(preset.stops) && url !== undefined ? { view, volumes: [{ url, preset, placement: this.placementOf(first!) }], ...this.liveLight() } : undefined;
    }
    const volumes: LiveLook["volumes"] = [];
    // The images switched on (geometry layers are traced as surfaces).
    for (const layer of this.renderedLayers()) {
      // (Geometry layers are traced as surfaces: surfacesLook.)
      if (this.isVectors(layer)) continue;
      const url = this.sourceOf(layer);
      const preset = url !== undefined ? this.layerPreset(layer, url) : undefined;
      if (url === undefined || preset === undefined) continue;
      // Each its own crops and cuts (and all layers'): where one is cut away, the others are still there.
      const { crop, clips } = this.cropsFor(layer, frame);
      volumes.push({ url, preset, placement: this.placementOf(layer), crop, clips });
    }
    const geometry = this.surfacesLook(frame);
    return volumes.length > 0 || geometry !== undefined ? { view, volumes, geometry, ...this.liveLight() } : undefined;
  }

  /** The surroundings as the lighting style has them (else the preset's), at the strength set; whether the light turns with the camera. */
  private liveLight(): Pick<LiveLook, "env" | "lightFollows"> {
    const s = this.saved;
    const style = LIGHTING[s.lightStyle];
    return { env: { ...(style?.env ?? {}), scale: s.envScale }, lightFollows: s.lightFrom !== "scene" };
  }

  /** Presets placed on a level's values, by what they were placed from: placing one reads the level's percentiles. */
  private readonly placed = new Map<string, LevelPreset>();

  /**
   * An image's look in this browser, whole: its preset (its own, else the default) placed on its level's values,
   * with its window, tuned as its colourmap was, at its density and the exposure. Undefined until its level is read.
   */
  private layerPreset(layer: LayerInfo, src: string): LivePreset | undefined {
    const level = this.live.levelOf(src);
    if (level === undefined) return undefined;
    const s = this.saved;
    const name = this.presetName(layer) || "HiP-CT brain";
    const custom = s.customPresets.find((p) => p.name === name) as unknown as LevelPreset | undefined;
    const base = custom ?? LOCAL_PRESETS.find((p) => p.name === name) ?? LOCAL_PRESETS[0];
    const overrides = s.windows[src] && base.domain === "window" ? { window: s.windows[src] } : {};
    const key = JSON.stringify([src, level.path, level.size, name, overrides, custom ?? null]);
    let resolved = this.placed.get(key);
    if (resolved === undefined) {
      if (this.placed.size > 32) this.placed.clear();
      resolved = levelResolved({ ...base, ...overrides } as LevelPreset, level);
      this.placed.set(key, resolved);
    }
    const t = s.tunings[src];
    const tuned: LevelPreset = isTuned(t) ? { ...resolved, stops: tuneStops(resolved.stops as DataStop[], t, this.histogramOf(level)).data, domain: "data", window: null, histogram: null } : resolved;
    const density = this.densityOf(layer);
    return { ...tuned, exposure: s.exposure, ...(density !== undefined ? { density } : {}) } as LivePreset;
  }

  /** One request at a time; the latest view waits for it. `look`: what the picture of it is drawn for. */
  private send(sid: string, spec: ViewSpec, look: string): void {
    if (sid === "local") {
      this.local?.setView(spec, look);
      return;
    }
    if (this.sending) {
      this.queued = { spec, look };
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
        this.views.set(r.version, { camera: spec.inv_view_projection, look });
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
        if (q !== undefined && now !== undefined) this.send(now, q.spec, q.look);
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

  /** A camera plane through the point the cursor was last over (else the view's position), across the view now. */
  private planeHere(name: string): CameraPlane | undefined {
    const f = this.lastFrame;
    if (f === undefined) {
      this.ctx.ui.toast("Look at the image in the 3-D view first.", "error");
      return undefined;
    }
    return planeFromView(f.invViewProjection, this.lastCursor ?? f.position, name);
  }

  /** A new camera plane of the image's own, through the tissue's centre, facing the camera, selected so its handles can move it at once. */
  private addPlane(): void {
    const scope = this.ownScope();
    const list = cropsOf(this.saved, scope).planes;
    const names = new Set(list.map((p) => p.name));
    let k = list.length + 1;
    while (names.has(`Plane ${k}`)) k++;
    const f = this.lastFrame;
    const centre = f && this.tissueCentre(f);
    const p = f && centre ? planeFromView(f.invViewProjection, centre, `Plane ${k}`) : this.planeHere(`Plane ${k}`);
    if (p === undefined || list.length >= LIMITS.maxClips) return;
    this.save((x) => editCrops(x, scope, (c) => void c.planes.push(p)));
    this.syncShapes();
    this.ctx.views.select(shapeId("plane", scope, list.length));
  }

  /** Sets a camera plane again, from the view now. */
  private setPlaneToView(scope: CropScope, i: number): void {
    const was = cropsOf(this.saved, scope).planes[i];
    const p = was && this.planeHere(was.name);
    if (p !== undefined) this.save((x) => editCrops(x, scope, (c) => void (c.planes[i] = { ...p, on: was.on })));
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

  /** Every geometry part wanted is read and built as asked, and the surfaces packed from them. */
  private geometrySettled(): boolean {
    for (const e of this.points.values()) {
      for (const k of e.wanted) {
        const p = e.parts.get(k);
        if (p === undefined || p.failed) continue;
        if (p.wantKey !== p.readKey || p.building !== undefined || p.done === undefined) return false;
      }
    }
    return true;
  }

  /**
   * A still of the view made in this browser: the geometry read at four times its budget (at most what can be
   * traced), then the view path-traced at the output's size and twice its samples, as a job; saved as a PNG.
   */
  private async saveStillHere(): Promise<void> {
    const frame = this.lastFrame;
    if (frame === undefined || !this.live.ready()) return this.ctx.ui.toast("Nothing is drawn here yet.", "error");
    if (this.stillRunning) return this.ctx.ui.toast("A still is already rendering.", "error");
    const m = movieSettings(this.saved.movie);
    const samples = Math.min(LIMITS.maxSamples, m.samples * 2);
    const tooLarge = stillProblem(m.width, m.height, samples);
    if (tooLarge) return this.ctx.ui.toast(tooLarge, "error");
    this.stillRunning = true;
    this.panelUpdate?.();
    const name = `Still ${m.width} × ${m.height}, ${samples} samples (this browser)`;
    try {
      await this.ctx.jobs.run(name, async (job) => {
        if (this.renderedLayers().some((l) => this.isVectors(l)) && this.saved.geometryBudget < GEO_MAX) {
          this.stillBudget = Math.min(GEO_MAX, 4 * this.saved.geometryBudget);
          this.update();
          job.progress(undefined, "reading the geometry finer");
          // (A frame first: the parts asked for again.)
          await sleep(300);
          while (!this.geometrySettled()) {
            if (job.cancelled) throw new Error("cancelled");
            await sleep(300);
          }
        }
        // The camera now, at the still's shape (its height's view kept).
        const a = frame.width / frame.height / (m.width / m.height);
        const viewProjection = Float32Array.from(frame.viewProjection, (x, i) => (i % 4 === 0 ? x * a : x));
        const invViewProjection = Float32Array.from(frame.invViewProjection, (x, i) => (i < 4 ? x / a : x));
        const image = await this.live.still({ invViewProjection, viewProjection, width: m.width, height: m.height, samples }, (f) => {
          if (job.cancelled) this.live.cancelStill();
          job.progress(f, f < 0.2 ? "holding the light" : "path-tracing");
        });
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext("2d")!.putImageData(new ImageData(image.rgba, image.width, image.height), 0, 0);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
        if (blob === null) throw new Error("the picture could not be saved");
        downloadBlob(blob, "anatomical-rendering.png");
      });
    } catch (e) {
      if ((e as Error).message !== "cancelled") this.jobFailed("Still", e, () => void this.saveStillHere());
    } finally {
      this.stillRunning = false;
      if (this.stillBudget !== undefined) {
        this.stillBudget = undefined;
        this.update();
      }
      this.panelUpdate?.();
    }
  }

  /** The view now, full size, for a still, a rotation or a keyframe. */
  private currentSpec(): ViewSpec | undefined {
    const f = this.lastFrame;
    return f ? this.viewSpec(f, 1) : this.lastSpec;
  }

  /** The view now at the output's size and twice its samples, as a job on the host (progress and cancel in the panel and in Activity); saved as a download. */
  private async saveStill(): Promise<void> {
    if (this.saved.where === "browser") return this.saveStillHere();
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
          const edited = this.edited();
          if (edited !== undefined) x.looks = { ...x.looks, [edited.name]: { ...x.looks[edited.name], preset: list[0].name } };
          else x.preset = list[0].name;
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
    const reading = host ? undefined : [...this.points.values()].find((e) => e.wanted.some((k) => { const p = e.parts.get(k); return p !== undefined && !p.failed && p.done === undefined; }));
    if (reading !== undefined) return { progress: reading.text.replace(/^Object: /, "") };
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
    if (this.saved.where === "browser" && this.local !== undefined && !this.local.ready && this.noWebGpu) lines.push(`No WebGPU here (${this.noWebGpu}): the object is drawn and path-traced with WebGL.`);
    if (this.live.text) lines.push(this.live.text);
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
    // Says what it is: Render on, or Render off.
    // The selected image's own: Render on adds it to the volume rendered, Render off takes it out.
    const layerOn = () => {
      const l = this.edited();
      return l !== undefined && this.saved.on && this.isOn(l);
    };
    const onSwitch = toggle(layerOn() ? "Render on" : "Render off", layerOn(), (v) => {
      const l = this.edited();
      if (l !== undefined && (this.isImage(l) || this.isVectors(l))) this.setLayerOn(l, v);
      else this.setOn(v);
      onSwitch.set(layerOn());
      switchWords(layerOn());
    });
    const switchWords = (on: boolean) => {
      // The switch is its label: its words are its one span.
      const words = onSwitch.querySelector("span");
      if (words && words.textContent !== (on ? "Render on" : "Render off")) words.textContent = on ? "Render on" : "Render off";
    };
    const status = statusLine();
    const empty = emptyState("No OME-Zarr or N5 image in this scene.", openData);

    // -------------------------------------------------------------- Remote
    const where = select([["browser", "This browser (WebGPU)"], ["host", "A render computer's GPU (CUDA)"]], saved().where, (v) => {
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
    // Last: this browser (WebGPU) renders unless a render computer is chosen here.
    const remote = card("anatomical.remote", "Remote", {},
      field("Where", where),
      onHost(field("Computer", computer)),
      gpu,
      onHost(el("div", { class: "row" }, button("Pair a computer…", () => void ctx.commands.invoke(COMPUTE_SETTINGS.command, COMPUTE_SETTINGS.args)), reconnect)),
    );

    // ----------------------------------------------------------- Rendering
    const layersNote = el("p", { class: "hint" });
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
    const preset = choices((v) => {
      const l = this.edited();
      if (l !== undefined && this.isImage(l)) this.setLook(l, { preset: v });
      else this.save((x) => (x.preset = v));
    }, "Preset");
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
      const end = (i: 0 | 1, label: string) => slider(now ? now[i] : i, { min: w.lo, max: w.hi, step: w.step, label, oninput: (v) => this.setWindow(w.src, i, v, w.guess, true), onchange: (v) => this.setWindow(w.src, i, v, w.guess) });
      windowSliders = [end(0, "Window low"), end(1, "Window high")];
      return field("Window", el("div", { class: "stack" },
        windowSliders[0], windowSliders[1],
        el("div", { class: "row" }, button("Guess", () => this.save((x) => delete x.windows[w.src])))),
        { info: "The image values the preset's colours are spread over, low and high. Guess goes back to the computer's guess: from just past the mounting medium, with the commonest tissue value at the middle." });
    });
    const shift = slider(0, { min: -1, max: 1, step: 0.01, label: "Shift", oninput: (v) => this.tune((n) => (n.shift = v * this.mapWidth()), true), onchange: (v) => this.tune((n) => (n.shift = v * this.mapWidth())) });
    const compress = slider(1, { min: 0.2, max: 4, step: 0.01, label: "Compress", oninput: (v) => this.tune((n) => (n.scale = v), true), onchange: (v) => this.tune((n) => (n.scale = v)) });
    const editorPart = region((on: boolean) =>
      on
        ? [
            field("Colourmap", this.colourmapEditor().element, { info: "The image's histogram (grey bars, log counts) with the opacity curve over it; under it, the image's own grey values, black to white; then the colourmap as a bar (a checker where it is clear). Drag the bar to move the map, an end of the bar to compress or stretch it; drag the histogram to slide it under the map, Shift-drag to compress it (the wheel does either once the editor has been clicked); its blue triangles warp it. A point: drag it (left and right moves it, up and down its opacity), double-click to colour it, Ctrl-click to add one, right-click to remove one. Ctrl-wheel zooms the view; double-click on empty space fits it to the map or the whole histogram." }),
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
    const setDensity = (v: number, preview: boolean) => {
      const l = this.edited();
      if (l !== undefined && this.isImage(l)) this.setLook(l, { density: v }, preview);
      else if (preview) this.preview((x) => (x.density = v));
      else this.save((x) => (x.density = v));
    };
    const density = slider(40, { min: 0, max: 200, label: "Density", unit: "/mm", oninput: (v) => setDensity(v, true), onchange: (v) => setDensity(v, false) });
    const exposure = slider(1, { min: 0, max: 5, step: 0.05, label: "Exposure", oninput: (v) => this.preview((x) => (x.exposure = v)), onchange: (v) => this.save((x) => (x.exposure = v)) });
    const jar = onHost(checkbox("Hide the jar", false, (v) => {
      this.save((x) => (x.jar = v));
      this.update();
    }, { info: "Renders only a cylinder about the scan's axis, leaving out the jar's wall (HiP-CT organs in their jars)." }));
    // A Zarr Vectors layer alone has no image to choose, nor its density.
    // Whose settings follow: the image selected in the Layers panel.
    const editingNote = el("p", { class: "hint" });
    const densityField = field("Density", density, { info: "How opaque the tissue is: higher gives crisper surfaces, lower more translucent ones." });
    // Points' and lines' size here: times their natural radius (a quarter of the points' spacing; a sixth of a segment).
    const setSize = (v: number) => {
      const l = this.edited();
      if (l === undefined) return;
      this.setLook(l, { size: v });
      this.update();
    };
    const geometrySize = slider(1, { min: 0.1, max: 5, step: 0.05, label: "Size", unit: "×", onchange: setSize });
    const geometrySizeField = field("Size", geometrySize, { info: "Spheres' and tubes' radius, times their natural one: a quarter of the points' mean spacing, a sixth of a segment's length, or the store's own radii." });
    // A geometry layer's surfaces' material here: redrawn, not built again.
    const setSurface = (k: keyof SurfaceMaterial, v: number, preview: boolean) => {
      const l = this.edited();
      if (l !== undefined) this.setLook(l, { surface: { ...this.saved.looks[l.name]?.surface, [k]: v } }, preview);
    };
    const surfaceSlider = (k: keyof SurfaceMaterial, label: string, max: number, min = 0) =>
      slider(DEFAULT_SURFACE[k], { min, max, step: 0.01, label, oninput: (v) => setSurface(k, v, true), onchange: (v) => setSurface(k, v, false) });
    const surfaceSliders = {
      opacity: surfaceSlider("opacity", "Opacity", 1),
      roughness: surfaceSlider("roughness", "Roughness", 1, 0.02),
      specular: surfaceSlider("specular", "Specular", 1),
      emission: surfaceSlider("emission", "Emission", 5),
    };
    const surfacePart = el("div", { class: "stack" },
      field("Opacity", surfaceSliders.opacity, { info: "How much of the light the surfaces stop: below 1 they are see-through, blended over what is behind them. Lower takes longer to path-trace, as the light goes on through." }),
      field("Roughness", surfaceSliders.roughness, { info: "How broad their highlights are: low is polished, high is matte." }),
      field("Specular", surfaceSliders.specular, { info: "The share of the light reflected as a highlight rather than in their colour." }),
      field("Emission", surfaceSliders.emission, { info: "Light they give off in their own colour, as if lit from within (the key light is 1)." }),
    );
    const presetRow = el("div", { class: "row" },
      field("Preset", preset, { info: "A look per modality or organ. Load… reads a preset (or a list of them) from a JSON file: a name, a domain, stops of value, colour and opacity, and the material." }),
      button("Load…", () => this.loadPresetFile()));
    const rendering = card("anatomical.rendering", "Rendering", { open: true },
      imageNote,
      volumePart,
      presetRow,
      references,
      windowPart,
      editorPart,
      densityField,
      geometrySizeField,
      surfacePart,
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

    // ------------------------------------------------------------- Objects
    const objectsEmpty = emptyState("No precomputed segmentation or Zarr Vectors layer in this scene.", openData);
    const objectsOn = toggle("Draw objects", false, (v) => {
      this.save((x) => (x.objects = { ...x.objects, on: v }));
      this.update();
    }, { info: "The segmentation's chosen segments drawn as their meshes, and the image within them at full resolution where the budget allows (no box round them: only what lies inside). On the render computer." });
    const objectsLayer = choices((v) => {
      this.save((x) => (x.objects = { ...x.objects, layer: v }));
      this.update();
    }, "Objects from");
    const objectsLook = (edit: (o: Saved["objects"]) => void) => (x: Saved) => {
      x.objects = { ...x.objects };
      edit(x.objects);
    };
    const objectSurface = slider(0.3, { min: 0, max: 1, step: 0.05, label: "Surfaces", oninput: (v) => this.preview(objectsLook((o) => (o.surface = v))), onchange: (v) => this.save(objectsLook((o) => (o.surface = v))) });
    const objectImage = checkbox("Image within", true, (v) => this.save(objectsLook((o) => (o.image = v))), { info: "The image inside the objects, path-traced as the volume is; off, the surfaces alone." });
    const objectMix = slider(0, { min: 0, max: 1, step: 0.05, label: "Segment colour", oninput: (v) => this.preview(objectsLook((o) => (o.mix = v))), onchange: (v) => this.save(objectsLook((o) => (o.mix = v))) });
    const objectBudget = slider(300, { min: 10, max: 4000, step: 10, unit: "M voxels", label: "Image within", onchange: (v) => {
      this.save(objectsLook((o) => (o.budget = Math.max(1, v) * 1e6)));
      this.update();
    } });
    const objectInside = select([["mesh", "the meshes"], ["labels", "the labels"]], "mesh", (v) => {
      this.save(objectsLook((o) => (o.inside = v === "labels" ? "labels" : "mesh")));
      this.update();
    }, "Inside by");
    const objectsNote = el("p", { class: "hint" });
    const surfaceField = field("Surfaces", objectSurface, { info: "0: clear (the image within them alone); 1: opaque." });
    const insideField = field("Inside by", objectInside, { info: "What a voxel is inside: the segments' meshes, or the segmentation's own labels (exact to its voxels; the meshes are simplified from it)." });
    const objectsBody = el("div", { class: "stack" },
      objectsOn,
      field("Objects from", objectsLayer, { info: "A segmentation with meshes: its chosen segments (up to 64) are the objects." }),
      surfaceField,
      objectImage,
      field("Segment colour", objectMix, { info: "How much each segment's colour tints the image within it." }),
      field("Image within", objectBudget, { info: "The voxels the image within the objects may take on the GPU: the finest stored level within this." }),
      insideField,
      objectsNote,
    );
    const objectsCard = card("anatomical.objects", "Objects", {}, objectsEmpty, objectsBody);

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
    const objectVoxels = slider(64, { min: 8, max: 512, step: 8, unit: "M voxels", label: "Object", onchange: (v) => {
      this.save((x) => (x.objectVoxels = Math.max(1, v) * 1e6));
      this.update();
    } });
    const geometryBudget = slider(GEOMETRY_BUDGET / 1e6, { min: 0.25, max: GEO_MAX / 1e6, step: 0.25, unit: "M", label: "Geometry", onchange: (v) => {
      this.save((x) => (x.geometryBudget = Math.min(Math.max(v, 0.25), GEO_MAX / 1e6) * 1e6));
      this.update();
    } });
    const geometryField = field("Geometry", geometryBudget, { info: "The triangles, spheres and tubes this browser reads and traces, shared by the geometry layers drawn: each layer at its finest level within its share. More is finer, and takes longer to read and build and more GPU memory (about 55 MB a million)." });
    const restPicture = checkbox("Path-traced picture when still", false, (v) => {
      this.lastKey = "";
      this.save((x) => (x.restPicture = v));
    }, { info: "Over the object, the path-traced picture of the view (at the image's full detail) once the camera rests. Off, the view shows the object alone, and the render computer renders only stills, movies and splats." });
    const samples = slider(512, { min: 16, max: 4096, step: 16, label: "Samples per pixel", onchange: (v) => this.save((x) => (x.maxSamples = Math.max(1, Math.round(v)))) });
    const frameReadout = el("p", { class: "readout" });
    const quality = card("anatomical.quality", "Quality", {},
      field("Whole volume", budget, { info: "One level of the whole image on the GPU: the finest stored level within this, or one made from a finer level." }),
      detail,
      detailField,
      denoise,
      field("Object", objectVoxels, { info: "The voxels of the image this browser holds and draws as the object in the 3-D view: the finest level within this. More is sharper, and takes longer to read and more of this computer's GPU memory." }),
      geometryField,
      restPicture,
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
    lightStyle.update([...Object.entries(LIGHTING).map(([k, l]): [string, string] => [k, l.name]), ["", "Custom"]], saved().lightStyle);
    const styleInfo = el("p", { class: "hint" });
    const lightFrom = choices((v) => this.save((x) => (x.lightFrom = v as Saved["lightFrom"])), "Light from");
    lightFrom.update([["front", "Front (from the camera)"], ["back", "Back (behind the object)"], ["scene", "A direction in the scene"]], saved().lightFrom);
    const around = slider(30, { min: -180, max: 180, step: 5, unit: "°", label: "Around", oninput: (v) => this.preview((x) => (x.lightAzimuth = v)), onchange: (v) => this.save((x) => (x.lightAzimuth = v)) });
    const up = slider(40, { min: -90, max: 90, step: 5, unit: "°", label: "Up", oninput: (v) => this.preview((x) => (x.lightElevation = v)), onchange: (v) => this.save((x) => (x.lightElevation = v)) });
    // Fields whose names say what the angles are about (the camera, or the scene's axes).
    const aroundName = el("span", {}, "Around");
    const upName = el("span", {}, "Up");
    const aroundField = el("label", { class: "field" }, aroundName, around);
    const upField = el("label", { class: "field" }, upName, up);
    const fix = button("Fix it in the scene", () => this.fixLight(), "Keep the light where it is now as the camera turns");
    const key = slider(1, { min: 0, max: 4, step: 0.05, label: "Key light", oninput: (v) => this.preview((x) => (x.lightKey = v)), onchange: (v) => this.save((x) => ((x.lightKey = v), (x.lightStyle = ""))) });
    const surroundings = slider(1, { min: 0, max: 3, step: 0.05, label: "Surroundings", oninput: (v) => this.preview((x) => (x.envScale = v)), onchange: (v) => this.save((x) => ((x.envScale = v), (x.lightStyle = ""))) });
    const lightMap = choices((v) => this.save((x) => (x.lightMap = v)), "Light map");
    const mapTurn = slider(0, { min: -180, max: 180, step: 5, unit: "°", label: "Turn the light map", oninput: (v) => this.preview((x) => (x.lightMapRotation = v)), onchange: (v) => this.save((x) => (x.lightMapRotation = v)) });
    const mapPart = el("div", { class: "stack" }, field("Light map", lightMap, { info: "HDR panoramas (CC0, Poly Haven), or the preset's sky colours." }), field("Turn", mapTurn));
    const lighting = card("anatomical.lighting", "Lighting", {},
      field("Style", lightStyle, { info: "Soft: even light from all round. Strong: one hard key light, deep shadows. Studio: a key light under a bright ceiling over a dark floor. Moving Key light or Surroundings makes it Custom." }),
      styleInfo,
      field("Light from", lightFrom, { info: "Front: the key light comes from the camera's side and turns with it. Back: from behind the object as the camera sees it (a rim of light), turning with the camera. A direction in the scene: fixed to the object as the camera turns." }),
      aroundField,
      upField,
      el("div", { class: "row" }, fix),
      field("Key light", key, { info: "The light that makes shadows." }),
      field("Surroundings", surroundings, { info: "Light from all round: the style's colours, or the light map on a render computer." }),
      mapPart,
    );

    // --------------------------------------------------------------- Crops
    // The image selected's own crops and cuts, and all layers' (each with All layers pressed): each image rendered is
    // cut by its own and all layers', so where one is cut away the others are still there.
    const toCursor = button("Move to the cursor", () => {
      const o = this.cursorOffsets();
      if (!o) return ctx.ui.toast("Point at the tissue in the 3-D view first.", "error");
      const names = this.lastFrame!.dimensions.names;
      const cursor = this.lastCursor;
      this.save((x) => {
        for (const scope of new Set([this.ownScope(), null])) {
          editCrops(x, scope, (c) => {
            for (const q of c.cuts) {
              const k = names.indexOf(q.axis);
              if (q.on && k >= 0 && k < 3) q.offset = o.axis[k];
            }
            for (const p of c.planes) {
              if (!p.on || !cursor) continue;
              p.point = [cursor[0], cursor[1], cursor[2]];
              p.offset = 0;
            }
          });
        }
      });
    });
    const cropsNote = el("p", { class: "hint" });
    // Camera planes: each a cut across the view as it was when set, fixed there; set again from the view now.
    type Row = { scope: CropScope; i: number };
    let planeControls: (Row & { on: ReturnType<typeof toggle>; name: Settable<HTMLInputElement, string>; offset: Slider })[] = [];
    const planes = region((rows: Row[]) => {
      planeControls = [];
      return rows.map(({ scope, i }, n) => {
        const p = cropsOf(this.saved, scope).planes[i];
        const edit = (f: (q: CameraPlane) => void) => (x: Saved) => editCrops(x, scope, (c) => f(c.planes[i]));
        const on = toggle(`Plane ${n + 1}`, p.on, (v) => this.save(edit((q) => (q.on = v))), { hideLabel: true });
        const name = el("input", { class: "text-input ar-grow", type: "text", value: p.name, "aria-label": `Name of plane ${n + 1}` }) as Settable<HTMLInputElement, string>;
        name.onchange = () => this.save(edit((q) => (q.name = name.value)));
        name.set = (v) => {
          if (name.ownerDocument.activeElement !== name && name.value !== v) name.value = v;
        };
        const offset = slider(p.offset, { min: -100, max: 100, step: 0.5, unit: "mm", label: `Plane ${n + 1} offset`, unbounded: true, oninput: (v) => this.preview(edit((q) => (q.offset = v))), onchange: (v) => this.save(edit((q) => (q.offset = v))) });
        planeControls.push({ scope, i, on, name, offset });
        return el("div", { class: "ar-box" },
          el("div", { class: "row" }, on, name,
            iconButton("camera", `Set plane ${n + 1} to the view now`, () => this.setPlaneToView(scope, i)),
            iconButton("trash", `Remove plane ${n + 1}`, () => this.save((x) => editCrops(x, scope, (c) => void c.planes.splice(i, 1))))),
          el("div", { class: "row" }, field("Offset", offset, { info: "Along the plane's own direction (away from the camera when it was set), from where it was set." }), this.allButton(scope === null, `Plane ${n + 1}`, () => this.shareItem("planes", scope, i))));
      });
    }, { class: "stack" });
    const addPlane = button("Add a camera plane", () => this.addPlane());
    const clipNote = el("p", { class: "hint" }, `At most ${MAX_CLIPS} cuts apply to an image at once (its own camera and axis planes and all layers' that are on): the first ones.`);
    const cutControls = saved().cuts.map((c0, i) => {
      const edit = (f: (q: Cut) => void) => (x: Saved) => editCrops(x, this.cutScope(i), (s) => f(s.cuts[i]));
      const on = checkbox(`Across ${c0.axis}`, false, (v) =>
        this.save(edit((q) => {
          q.on = v;
          // A cut turned on starts through the point the cursor was last over (the axis's display index).
          const o = v ? this.cursorOffsets() : undefined;
          const k = this.lastFrame?.dimensions.names.indexOf(q.axis) ?? -1;
          if (o && k >= 0 && k < 3) q.offset = o.axis[k];
        })));
      const side = select([["-1", "keep −"], ["1", "keep +"]], String(c0.keep), (v) => this.save(edit((q) => (q.keep = Number(v) as 1 | -1))), `Side kept across ${c0.axis}`);
      const offset = slider(c0.offset, { min: -100, max: 100, step: 0.5, unit: "mm", label: `Offset across ${c0.axis}`, unbounded: true, oninput: (v) => this.preview(edit((q) => (q.offset = v))), onchange: (v) => this.save(edit((q) => (q.offset = v))) });
      const all = this.allButton(false, `The plane across ${c0.axis}`, () => this.shareCut(i, this.cutScope(i) !== null));
      return { on, side, offset, all, row: el("div", { class: "ar-cut" }, on, side, offset, all) };
    });
    let boxControls: (Row & { on: ReturnType<typeof toggle>; name: Settable<HTMLInputElement, string>; keep: Settable<HTMLSelectElement, string>; ends: [Slider, Slider][] })[] = [];
    const boxes = region((rows: Row[]) => {
      boxControls = [];
      return rows.map(({ scope, i }, n) => {
        const b = cropsOf(this.saved, scope).boxes[i];
        const f = this.boxShown(scope, b) ?? { lo: [0, 0, 0], hi: [1, 1, 1] };
        const edit = (g: (q: Crop) => void) => (x: Saved) => editCrops(x, scope, (c) => g(c.boxes[i]));
        const on = toggle(`Box ${n + 1}`, b.on, (v) => this.save(edit((q) => (q.on = v))), { hideLabel: true });
        const name = el("input", { class: "text-input ar-grow", type: "text", value: b.name, "aria-label": `Name of box ${n + 1}` }) as Settable<HTMLInputElement, string>;
        name.onchange = () => this.save(edit((q) => (q.name = name.value)));
        name.set = (v) => {
          if (name.ownerDocument.activeElement !== name && name.value !== v) name.value = v;
        };
        const keepIt = select([["keep", "keep inside"], ["cut", "cut out"]], b.keep ? "keep" : "cut", (v) => this.save(edit((q) => (q.keep = v === "keep"))), `Box ${n + 1} keeps`);
        // One end of the box along an axis (fractions of the image shown), kept 0.005 from the other.
        const boxEnd = (end: "lo" | "hi", k: number, v: number, done: boolean) => {
          const q = cropsOf(this.saved, scope).boxes[i];
          const now = q && this.boxShown(scope, q);
          if (now === undefined) return;
          const lo = [...now.lo], hi = [...now.hi];
          if (end === "lo") lo[k] = Math.min(v, hi[k] - 0.005);
          else hi[k] = Math.max(v, lo[k] + 0.005);
          this.setBox(scope, i, { lo, hi }, done);
        };
        const ends = (["x", "y", "z"] as const).map((axis, k): [Slider, Slider] => [
          slider(f.lo[k], { min: 0, max: 1, step: 0.005, label: `Box ${n + 1} low ${axis}`, oninput: (v) => boxEnd("lo", k, v, false), onchange: (v) => boxEnd("lo", k, v, true) }),
          slider(f.hi[k], { min: 0, max: 1, step: 0.005, label: `Box ${n + 1} high ${axis}`, oninput: (v) => boxEnd("hi", k, v, false), onchange: (v) => boxEnd("hi", k, v, true) }),
        ]);
        boxControls.push({ scope, i, on, name, keep: keepIt, ends });
        return el("div", { class: "ar-box" },
          el("div", { class: "row" }, on, name, keepIt, iconButton("trash", `Remove box ${n + 1}`, () => this.save((x) => editCrops(x, scope, (c) => void c.boxes.splice(i, 1))))),
          el("div", { class: "ar-box-axes" }, ...ends.flatMap(([lo, hi], k) => [el("span", {}, "xyz"[k]), lo, hi])),
          el("div", { class: "row" }, el("span", { class: "spacer" }), this.allButton(scope === null, `Box ${n + 1}`, () => this.shareItem("boxes", scope, i))));
      });
    }, { class: "stack" });
    const addBox = button("Add a box", () => {
      const scope = this.ownScope();
      const list = cropsOf(this.saved, scope).boxes;
      if (list.length >= LIMITS.maxBoxes) return;
      this.save((x) => editCrops(x, scope, (c) => void c.boxes.push({ name: `Box ${c.boxes.length + 1}`, on: true, keep: true, lo: [0, 0, 0], hi: [1, 1, 1] })));
      // Selected, so its handles show at once (when the image's level is held here to place it).
      this.syncShapes();
      this.ctx.views.select(shapeId("box", scope, list.length));
    });
    const crops = card("anatomical.crops", "Crops", { info: `The image selected in Layers: its own camera planes, axis planes and boxes, and those for all layers (All layers pressed), which cut every image rendered. Each image is cut by its own and all layers': where one is cut away, the others are still there. A camera plane is a cut across the view as it is when the plane is added, through the point the cursor was last over in the 3-D view, keeping what lies beyond; it stays fixed as the camera moves, and the camera button sets it again from the view then. An axis plane turned on starts through the point the cursor was last over; Move to the cursor moves the planes that are on there. Boxes (up to ${LIMITS.maxBoxes}) are fractions of the volume along x, y and z; what shows is inside any box that keeps and in none that cuts out.` },
      cropsNote,
      el("div", { class: "row" }, toCursor),
      el("h4", { class: "section-title" }, "Camera planes"),
      planes,
      el("div", { class: "row" }, addPlane),
      clipNote,
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
    const output = card("anatomical.output", "Output", { info: "The size and samples of stills and movies. A still is path-traced to twice the samples, as a job: its progress here and in Activity, and it downloads when done. On a computer, by its renderer; in this browser, by this browser's, the geometry read at four times its budget for it (Quality › Geometry)." },
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
      el("div", { class: "row" }, onSwitch, info(`Each image is rendered by its own switch: select it in Layers, and its Render switch, preset, window, colourmap and density show here. The images switched on are rendered together as one volume (up to ${MAX_VOLUMES}), each placed by its layer's transform; where they overlap, the finest shows. On a render computer, only the first is rendered.`, "About rendering per image")),
      editingNote,
      layersNote,
      empty,
      status,
      rendering, regions, objectsCard, quality, lighting, crops, output, movie, splat, remote,
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
      const cur = this.currentTuning();
      if (cur) {
        const width = this.mapWidth();
        shift.set(width ? cur.tuning.shift / width : 0);
        compress.set(cur.tuning.scale);
      }
      if (e && cur && this.editor && !this.editor.dragging) {
        // The view refitted for another image or preset only.
        this.editor.set(this.histogram(), { base: e.base, centre: e.centre, shift: cur.tuning.shift, scale: cur.tuning.scale }, e.warp, `${cur.src} ${this.resolved?.key ?? ""}`);
      }
    };
    let wasConnected = true;
    const sync = () => {
      const s = this.saved;
      const imgs = this.images();
      const target = this.target();
      // A Zarr Vectors layer alone (no image): its geometry is the scene, on a render computer.
      const aloneScene = this.vectorsAlone() !== undefined;
      const scene = imgs.length > 0 || this.vectorLayers().length > 0;
      // The layer selected is a Zarr Vectors layer: it has no image settings (its points are coloured as the layer colours them).
      const edited = this.edited();
      const alone = edited !== undefined && this.isVectors(edited);
      const onHost_ = s.where === "host";
      const axes = target ? this.axesOf(target) : {};
      for (const e of hostOnly) e.hidden = !onHost_;

      // The head: the switch, an empty scene's action, the view buttons.
      onSwitch.set(layerOn());
      switchWords(layerOn());
      onSwitch.input.disabled = !scene;
      empty.hidden = scene;

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
      rendering.hidden = !scene;
      const rendered = this.renderedLayers();
      const over = imgs.filter((l) => this.isOn(l)).length - rendered.length;
      layersNote.textContent = imgs.length > 0 && rendered.length === 0
        ? "No image is rendered: select one in Layers and switch Render on."
        : over > 0 ? `Only ${MAX_VOLUMES} images are rendered at once: ${over} more ${over === 1 ? "is" : "are"} switched on.`
        : onHost_ && rendered.length > 1 ? `A render computer renders ${rendered[0].name} alone; the others are drawn in this browser's object.`
        : "";
      layersNote.hidden = layersNote.textContent === "";
      const others = rendered.filter((l) => l.name !== edited?.name).length;
      editingNote.textContent = edited
        ? `${edited.name}${others === 0 ? "" : this.isOn(edited) ? `, rendered with ${others} other image${others === 1 ? "" : "s"}` : `; ${others} other image${others === 1 ? " is" : "s are"} rendered`}. Select another image in Layers for its own settings.`
        : "";
      editingNote.hidden = editingNote.textContent === "";
      const editedAxes = edited ? this.axesOf(edited) : {};
      imageNote.textContent = editedAxes.problem ?? axes.problem ?? "";
      const counts = target && axes.problem === undefined ? this.volumeCounts(target) : undefined;
      volumePart.update(counts);
      volumePart.hidden = counts === undefined;
      if (target && counts) {
        const at = this.volumeAt(target);
        channelChoice?.set(String(at.channel));
        timeChoice?.set(at.time);
      }
      imageNote.hidden = imageNote.textContent === "";
      imageNote.className = imageNote.textContent ? "hint error" : "hint";
      const presetList = s.where === "browser" ? LOCAL_PRESETS.map((p) => ({ name: p.name, modality: p.modality ?? "" })) : this.presets;
      const allPresets = [...presetList, ...s.customPresets.map((p) => ({ name: String(p.name), modality: "from a file" }))];
      // No preset chosen yet is the default one, shown as such. Grouped: the general looks, the organs, the rest
      // by modality, those from files.
      preset.update(presetChoices(allPresets), this.presetName(edited) || "HiP-CT brain");
      preset.disabled = allPresets.length === 0;
      references.update(this.references());
      const w = alone ? undefined : this.windowRange();
      windowPart.update(w);
      if (w && windowSliders) {
        const now = s.windows[w.src] ?? w.guess;
        if (now) windowSliders.forEach((sl, i) => sl.set(now[i]));
      }
      // The colourmap editor once the preset is placed on this image's values: by the computer, or here from the level held.
      const editedSrc = edited ? this.sourceOf(edited) : undefined;
      const placeable = onHost_ ? this.session?.status === "ready" && edited?.name === target?.name : editedSrc !== undefined && this.live.levelOf(editedSrc) !== undefined;
      const tuning = placeable && !alone ? this.currentTuning() : undefined;
      editorPart.update(tuning !== undefined);
      if (tuning) {
        this.editorUpdate?.();
        void this.resolvePreset();
      }
      const presetNow = this.presetName(edited);
      density.set(this.densityOf(edited) ?? Number((onHost_ ? this.presets : LOCAL_PRESETS).find((p) => p.name === presetNow)?.density ?? 40));
      exposure.set(s.exposure);
      jar.set(s.jar);

      // Regions (a computer's renderer only: this browser's has no region colours).
      const segs = this.segmentations();
      regions.hidden = !onHost_ || imgs.length === 0;
      jar.hidden = !onHost_ || alone;
      densityField.hidden = alone;
      // Points and lines drawn here: their size.
      const kind = edited ? this.geometryKind(edited.name) : undefined;
      geometrySizeField.hidden = !(alone && !onHost_ && (kind === "points" || kind === "lines"));
      if (edited) geometrySize.set(this.saved.looks[edited.name]?.size ?? 1);
      // Any geometry traced here (meshes too): its surfaces' material.
      surfacePart.hidden = !(alone && !onHost_ && kind !== undefined);
      if (edited) {
        const m = this.surfaceOf(edited.name);
        for (const k of Object.keys(surfaceSliders) as (keyof SurfaceMaterial)[]) surfaceSliders[k].set(m[k]);
      }
      // Geometry drawn here has no preset: it is coloured as the layer colours it.
      presetRow.hidden = alone && this.saved.where === "browser";
      regionsEmpty.hidden = segs.length > 0;
      regionsBody.hidden = segs.length === 0;
      segmentation.update(segs.map((l) => [l.name, l.name]), segs.find((x) => x.name === s.labels)?.name ?? segs[0]?.name ?? "");
      colourBy.set(s.regions);
      labelMix.set(s.labelMix);
      hidden.set(s.hidden);
      keep.set(s.keep);

      // Objects (a computer's renderer only).
      const objSegs = this.objectLayers();
      objectsCard.hidden = !onHost_ || !scene;
      objectsOn.hidden = aloneScene;
      objectsEmpty.hidden = objSegs.length > 0;
      objectsBody.hidden = objSegs.length === 0;
      objectsOn.set(s.objects.on);
      objectsLayer.update(objSegs.map((l) => [l.name, l.name]), this.objectsLayer()?.name ?? "");
      objectSurface.set(s.objects.surface);
      objectImage.set(s.objects.image);
      objectMix.set(s.objects.mix);
      objectBudget.set(s.objects.budget / 1e6);
      objectInside.set(s.objects.inside);
      const seen = s.objects.on && this.objectsLayer() ? this.ctx.viewer.visibleSegments(this.objectsLayer()!.name) : undefined;
      const om = this.session?.objects;
      const zvLayer = this.objectsLayer() ? zarrVectorsStore(this.objectsLayer()!.sources[0]) !== undefined : false;
      // A store's surfaces are solid and hold no image: no Surfaces, Inside by or Image within.
      surfaceField.hidden = zvLayer;
      insideField.hidden = zvLayer;
      objectImage.hidden = zvLayer;
      objectsNote.textContent = aloneScene ? (om ? `The store's ${String((om as Record<string, unknown>).kind ?? "geometry")} (level ${String((om as Record<string, unknown>).level ?? "?")}) alone: the scene has no image. Coloured as the layer is (its Display tab, Vertex colour).` : "The store's geometry alone (the scene has no image): read when the computer opens it.")
        : !s.objects.on ? ""
        : zvLayer ? (om ? `The store's ${String((om as Record<string, unknown>).kind ?? "geometry")} (level ${String((om as Record<string, unknown>).level ?? "?")}) as solid surfaces in the volume.` : "The store's geometry, as solid surfaces in the volume: read when the computer opens it.")
        : seen === undefined || seen.all || seen.size === 0 ? "Choose segments in the layer: they are the objects."
        : om ? `${om.ids.length} segment${om.ids.length === 1 ? "" : "s"}, ${(om.triangles / 1e6).toFixed(1)} M triangles; the image within at ${om.level} (${(om.inside_voxels / 1e6).toFixed(0)} M voxels inside, ${om.bricks} bricks)${seen.size > MAX_OBJECTS ? `; the first ${MAX_OBJECTS} of ${seen.size}` : ""}.`
        : `${Math.min(seen.size, MAX_OBJECTS)} segment${seen.size === 1 ? "" : "s"}${seen.size > MAX_OBJECTS ? ` (the first ${MAX_OBJECTS} of ${seen.size})` : ""}: read when the computer opens them.`;

      // Quality.
      quality.hidden = !scene;
      budget.set(s.budget / 1e6);
      detail.set(s.detail);
      detailField.hidden = !onHost_ || !s.detail;
      detailBudget.set(s.detailBudget / 1e6);
      denoise.set(s.denoise);
      restPicture.set(s.restPicture);
      objectVoxels.set(s.objectVoxels / 1e6);
      geometryBudget.set(s.geometryBudget / 1e6);
      geometryField.hidden = onHost_ || !this.renderedLayers().some((l) => this.isVectors(l));
      samples.set(s.maxSamples);

      // Lighting.
      lighting.hidden = !scene;
      lightStyle.set(s.lightStyle);
      styleInfo.textContent = LIGHTING[s.lightStyle]?.info ?? "Key light and surroundings as set.";
      lightFrom.set(s.lightFrom);
      around.set(s.lightAzimuth);
      up.set(s.lightElevation);
      const inScene = s.lightFrom === "scene";
      aroundName.textContent = inScene ? "Around z" : "Around";
      upName.textContent = inScene ? "Toward z" : "Up";
      around.title = inScene ? "Degrees around the scene's z axis, from +x toward +y" : "0 lights from straight ahead, 90 from the right, -90 from the left";
      up.title = inScene ? "90 lights from +z, -90 from -z" : "90 lights from above, -90 from below";
      fix.hidden = inScene;
      key.set(s.lightKey);
      surroundings.set(s.envScale);
      const maps = this.serviceInfo?.lightmaps ?? [];
      mapPart.hidden = !onHost_ || maps.length === 0;
      lightMap.update([["", "Sky colours"], ...maps.map((m): [string, string] => [m, m])], s.lightMap);
      mapTurn.set(s.lightMapRotation);

      // Crops.
      crops.hidden = !scene;
      const cropName = this.cropLayer()?.name;
      cropsNote.textContent = cropName ? `${cropName}'s own crops and cuts, and those for all layers.` : "Crops and cuts for all layers.";
      const ownScope = this.ownScope();
      const planeRows = this.cropRows("planes");
      planes.update(planeRows);
      planeControls.forEach((c) => {
        const p = cropsOf(s, c.scope).planes[c.i];
        if (p === undefined) return;
        c.on.set(p.on);
        c.name.set(p.name);
        c.offset.set(p.offset);
      });
      addPlane.disabled = cropsOf(s, ownScope).planes.length >= LIMITS.maxClips;
      const counted = (set: CropSet) => set.planes.filter((p) => p.on).length + set.cuts.filter((c) => c.on).length;
      clipNote.hidden = counted(s) + (ownScope !== null ? counted(cropsOf(s, ownScope)) : 0) <= MAX_CLIPS;
      cutControls.forEach((c, i) => {
        const scope = this.cutScope(i);
        const q = cropsOf(s, scope).cuts[i];
        c.on.set(q.on);
        c.side.set(String(q.keep));
        c.offset.set(q.offset);
        c.all.setAttribute("aria-pressed", String(scope === null));
        c.all.disabled = ownScope === null;
      });
      const boxRows = this.cropRows("boxes");
      boxes.update(boxRows);
      boxControls.forEach((c) => {
        const b = cropsOf(s, c.scope).boxes[c.i];
        if (b === undefined) return;
        const f = this.boxShown(c.scope, b);
        c.on.set(b.on);
        c.name.set(b.name);
        c.keep.set(b.keep ? "keep" : "cut");
        if (f) c.ends.forEach(([lo, hi], k) => (lo.set(f.lo[k]), hi.set(f.hi[k])));
      });
      addBox.disabled = cropsOf(s, ownScope).boxes.length >= LIMITS.maxBoxes;

      // Output, Movie and Splat.
      output.hidden = movie.hidden = splat.hidden = !scene;
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
    this.hidePointsDrawing(new Set());
    this.objectsWatch?.off();
    this.panelUpdate = this.statusUpdate = this.jobsUpdate = this.editorUpdate = undefined;
    this.closeSession();
    this.closeLocal();
    clearTimeout(this.settle);
    this.handle?.dispose();
    for (const { handle } of this.shapes.values()) handle.dispose();
    this.shapes.clear();
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

/** A geometry layer read for this browser's renderer: its parts (by segment, or "" for the layer whole), those wanted in order. */
interface PointsEntry {
  parts: Map<string, Part>;
  wanted: string[];
  /** Where the layer is placed and how it is coloured now (its parts are built so). */
  placement?: ArrayLike<number>;
  look?: ColourByLook;
  text: string;
}

/** A part of a geometry layer: what it was read for and is wanted for, what it read, and its block once built. */
interface Part {
  readKey: string;
  wantKey: string;
  read?: GeometryRead;
  failed?: boolean;
  /** A mesh's chunks read, kept for its next choice of them (detail by distance). */
  cache?: Map<string, BuiltChunk | null>;
  /** The block being built (its key), and the last built: its primitives' objects' segments or colours. */
  building?: string;
  done?: { key: string; block: Block; serial: number; ids?: bigint[]; colours?: Float32Array; groups?: { group: number; stored?: number }[] };
}

let geometrySerial = 0;

/** A short hash of a text (a choice of chunks, as a key). */
function hashText(t: string): string {
  let h = 5381;
  for (let i = 0; i < t.length; ++i) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** A saved surface material's fields that are numbers in range. */
function readSurface(v: Record<string, unknown>): Partial<SurfaceMaterial> {
  const out: Partial<SurfaceMaterial> = {};
  const ranges: Record<keyof SurfaceMaterial, [number, number]> = { opacity: [0, 1], roughness: [0.02, 1], specular: [0, 1], emission: [0, 10] };
  for (const [k, [lo, hi]] of Object.entries(ranges) as [keyof SurfaceMaterial, [number, number]][]) {
    const x = v[k];
    if (typeof x === "number" && Number.isFinite(x)) out[k] = Math.min(Math.max(x, lo), hi);
  }
  return out;
}

/** Store coordinates to physical millimetres, placed by `placement` (column-major; undefined: where they are). */
function toMmOf(read: GeometryRead, placement: ArrayLike<number> | undefined): number[] {
  const scale = [read.mm[0], 0, 0, 0, 0, read.mm[1], 0, 0, 0, 0, read.mm[2], 0, 0, 0, 0, 1];
  return placement ? mul(rowMajor(placement), scale) : scale;
}
