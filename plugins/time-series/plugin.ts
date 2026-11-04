/**
 * The time series plugin: the Time series tab, with the time course of the
 * voxel under the mouse in an image with a time axis, pinned voxels and
 * region means beside it, playing through time, and the series saved as
 * CSV.
 *
 * Values are read by a worker (./worker.ts) from the image's OME-Zarr
 * store (a NIfTI opened from this computer is one, read in place).  A
 * CIFTI time series beside a surface opened from this computer is stepped
 * through instead (./surface.ts): its store serves the values at the time
 * point the transport chooses, finds the vertex nearest the mouse, sends a
 * vertex's values at every time point, and a parcel's mean and SD over its
 * vertices.  Where
 * a position is in the image, and which time point the views show, come
 * from the layer's transform (./space.ts), so a moved layer reads where it
 * shows.  Pins are kept in the plugin's state (in the link); their values
 * are read again when the link is opened.
 */
import type { Disposer, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { omeZarrUrl } from "../volume-view/sources.js";
import { type ReadPlan, SeriesClient, type SeriesInfo } from "./client.js";
import { TIME_SERIES_PANEL } from "./manifest.js";
import { Plot, type PlotSeries } from "./plot.js";
import { describePlan, movingPlan } from "./reader.js";
import { type AnnotationJson, regionVoxels, shapeOf } from "./region.js";
import { COLOURS, coordinateOf, formatTime, freeColour, indexAt, nextIndex, percentChange, percentChangeSpread, RATES, seriesCsv, stepIndex, type TimeAxis, timeAxis, timeOf, timesOf, voxelAt, voxelLabel } from "./series.js";
import { LayerMap, type Place, placeOf } from "./space.js";
import { nearestOf, type Parcellation, parcelAt, parcelCourseOf, parcelLabel, parcellationsOf, storeDistance, storePoint, type SurfaceSeries, surfaceAxis, surfaceSeriesOf, VERTEX_REACH_MM, vertexLabel, zarrVectorsStore } from "./surface.js";

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

const NS = "http://www.w3.org/2000/svg";
/** Transport icons, 16 × 16. */
const ICONS: Record<string, string> = {
  first: "M3 3h2v10H3zM13 3v10L6 8z",
  previous: "M12 3v10L5 8zM3 3h2v10H3z",
  play: "M4 2.5v11L13 8z",
  pause: "M4 3h3v10H4zM9 3h3v10H9z",
  next: "M4 3v10l7-5zM11 3h2v10h-2z",
  last: "M3 3v10l7-5zM11 3h2v10h-2z",
};
function icon(name: string): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", ICONS[name]);
  p.setAttribute("fill", "currentColor");
  s.append(p);
  return s;
}

const STYLE = `
.dock-pane.ts-host { padding: 0; height: 100%; }
.ts { display: grid; grid-template-columns: 264px minmax(0, 1fr); height: 100%; min-height: 0; font-size: 12px; }
.ts-side { display: flex; flex-direction: column; gap: 7px; padding: 8px 10px; border-right: 1px solid var(--line); overflow: auto; min-height: 0; }
.ts-side select { min-width: 0; width: 100%; }
.ts-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ts-row select { width: auto; flex: none; min-width: 0; padding-right: 2px; }
.ts-region select { flex: 1; }
.ts-time { font: 12px/1.4 var(--mono); color: var(--text); }
.ts-time .ts-of { color: var(--faint); }
.ts-status { color: var(--faint); min-height: 1.4em; overflow-wrap: anywhere; }
.ts-status.error { color: var(--err); }
.ts-spread { justify-content: space-between; flex-wrap: nowrap; }
.ts-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 6px 10px 4px; }
.ts-head { display: flex; align-items: flex-start; gap: 12px; flex: none; }
.ts-actions { display: flex; align-items: center; gap: 4px 8px; flex: none; }
.ts-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; flex: 1; min-width: 0; min-height: 24px; }
.ts-key { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); white-space: nowrap; }
.ts-key.ts-note { white-space: normal; }
.ts-key button { border: 0; background: transparent; color: var(--faint); cursor: pointer; padding: 0 2px; font-size: 14px; line-height: 1; }
.ts-key button:hover { color: var(--text); }
.ts-swatch { display: inline-block; width: 12px; height: 2px; vertical-align: middle; }
.ts-plot-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.ts-plot { flex: 1; min-height: 0; width: 100%; display: block; }
.ts-plot .ts-grid { stroke: var(--line); stroke-width: 1; }
.ts-plot .ts-axis { stroke: var(--line-strong); stroke-width: 1; }
.ts-plot .ts-tick { fill: var(--faint); font: 10px var(--mono); }
.ts-plot .ts-line { fill: none; stroke-width: 2; stroke-linejoin: round; }
.ts-plot .ts-band { stroke: none; opacity: 0.18; }
.ts-plot .ts-coarse { stroke-dasharray: 5 3; }
.ts-plot .ts-coarse-note { fill: var(--warn); }
.ts-plot .ts-now { stroke: var(--warn); stroke-width: 1.5; }
.ts-plot .ts-cross { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 2; }
.ts-plot .ts-dot { stroke: var(--ink-2); stroke-width: 2; }
.ts-plot .ts-hit { cursor: crosshair; }
.ts-readout { flex: none; color: var(--muted); font: 11px/1.5 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

/** A pinned series: a voxel, the mean over a region drawn in an annotation layer, a surface's vertex, or the mean over a surface's parcel. */
interface Pin {
  id: number;
  /** Its colour, an index into COLOURS. */
  colour: number;
  /** The image layer it was pinned in (for a surface's vertex, the Image menu's entry: the layer's and the series' names). */
  layer: string;
  label: string;
  /** The voxel's index along each image axis (the metadata's order). */
  voxel?: number[];
  region?: { layer: string; annotation: string };
  /** A vertex of a surface: its store, the series (its map's name) and the vertex as the surface file numbers it. */
  vertex?: { store: string; series: string; index: number };
  /** A parcel of a surface: its store, the series, the parcellation (its map's name) and the label's code and name. */
  parcel?: { store: string; series: string; parcellation: string; code: number; name: string };
}

const isParcelPin = (v: unknown): boolean => {
  const p = v as Pin["parcel"];
  return typeof p?.store === "string" && typeof p.series === "string" && typeof p.parcellation === "string" && typeof p.code === "number" && typeof p.name === "string";
};

const isVertexPin = (v: unknown): boolean => {
  const p = v as Pin["vertex"];
  return typeof p?.store === "string" && typeof p.series === "string" && Number.isInteger(p.index) && p.index >= 0;
};

interface Saved {
  layer?: string;
  pins: Pin[];
  /** The time point each surface series shows, by `store|series`: kept in the link, so it opens there again. */
  surfaceTimes?: Record<string, number>;
}

/** A surface series' key in the saved state. */
const surfaceKey = (surface: SurfaceStep) => `${surface.store}|${surface.series.name}`;

function readSaved(value: unknown): Saved {
  const v = (value ?? {}) as Partial<Saved>;
  const pins = Array.isArray(v.pins) ? v.pins.filter((p) => typeof p?.id === "number" && typeof p.layer === "string" && (Array.isArray(p.voxel) || p.region !== undefined || isVertexPin(p.vertex) || isParcelPin(p.parcel))) : [];
  const times = Object.entries(v.surfaceTimes ?? {}).filter((e): e is [string, number] => Number.isInteger(e[1]) && e[1] >= 0);
  return { layer: typeof v.layer === "string" ? v.layer : undefined, pins, ...(times.length ? { surfaceTimes: Object.fromEntries(times) } : {}) };
}

/** A series being read or read. */
interface Read {
  key: string;
  values?: Float32Array;
  /** A parcel's SD across its vertices at each time point. */
  sd?: Float32Array;
  /** The values are a coarse read (what, in words) until the finest replace them. */
  coarse?: string;
  error?: string;
  controller?: AbortController;
}

/** The voxel under the mouse and its series. */
interface Cursor {
  voxel: number[];
  read: Read;
  /** The finest values are read, or being read. */
  fine: boolean;
  /** The quick read (cached finest values, else a coarse read) while it runs. */
  quick?: Promise<void>;
}

/** The vertex under the mouse, on a surface whose series is chosen, and its series. */
interface VertexCursor {
  /** The surface's store and series it is on. */
  store: string;
  series: string;
  vertex: number;
  read: Read;
}

/** How long the mouse rests on a voxel before its finest values are read, when they are slow to read. */
const REST_MS = 400;

/** What can be chosen in the Image menu: an image layer with time, or a time series on a surface layer. */
interface Candidate {
  /** The layer's name for an image; the layer's and the series' for a surface. */
  id: string;
  label: string;
  layer: string;
  surface?: SurfaceStep;
}

/** A surface's time series, stepped through in its store. */
interface SurfaceStep {
  /** The surface's store (its URL, ending in /). */
  store: string;
  series: SurfaceSeries;
}

/** The colour of the series under the mouse: the docks' text colour, apart from the pins'. */
const CURSOR_COLOUR = "#dedede";

class TimeSeries {
  private saved: Saved;
  private readonly client = new SeriesClient();
  /** Image layers with a time dimension, and time series on surface layers. */
  private candidates: Candidate[] = [];
  /** Each local surface store's time series, from its header, once read. */
  private readonly surfaceHeaders = new Map<string, SurfaceSeries[] | "reading">();
  /** The surface series chosen, when one is. */
  private surface: SurfaceStep | undefined;
  /** A time point to show on the surface after the one being sent. */
  private surfaceWanted: number | undefined;
  private surfaceSending = false;
  private info: SeriesInfo | undefined;
  private infoUrl: string | undefined;
  private openError: string | undefined;
  private map: LayerMap | undefined;
  private axis: TimeAxis | undefined;
  private axisNote: string | undefined;
  private current = 0;
  private cursor: Cursor | undefined;
  /** The vertex under the mouse, when a surface's series is chosen. */
  private vertexCursor: VertexCursor | undefined;
  /** Counts the nearest-vertex lookups sent, so an answer to an older one is dropped. */
  private vertexLookups = 0;
  /** Each surface series' parcellations (by `store|series`), once its store has said. */
  private readonly parcellations = new Map<string, Parcellation[] | "reading">();
  /** The parcellation and parcel chosen in the panel (its name, a label's code). */
  private parcellation = "";
  private parcel: number | undefined;
  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
  private restTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pinned = new Map<number, Read>();
  private status = "";
  private statusError = false;
  private playing: ReturnType<typeof setTimeout> | undefined;
  private rate: number;
  private loop: boolean;
  /** Plot each series as its change from its mean, in percent. */
  private change: boolean;
  private region = "";
  private plot: Plot | undefined;
  private update: (() => void) | undefined;
  private updateTime: (() => void) | undefined;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.rate = ctx.settings.get<number>("rate") ?? 2;
    this.loop = ctx.settings.get<boolean>("loop") ?? true;
    this.change = ctx.settings.get<boolean>("change") ?? false;
    this.offs.push(
      ctx.state.onChanged(() => {
        const next = readSaved(ctx.state.get());
        if (JSON.stringify(next) === JSON.stringify(this.saved)) return;
        this.saved = next;
        void this.refresh();
        // An undo (or a link) that changes a surface series' time point shows it.
        const kept = this.surface === undefined ? undefined : next.surfaceTimes?.[surfaceKey(this.surface)];
        if (kept !== undefined && kept !== this.current && this.playing === undefined) void this.showOnSurface(kept);
      }),
      ctx.viewer.onLayersChanged(() => void this.refresh()),
      ctx.viewer.onStateChanged(() => {
        // A layer's source loading (its transform known) can make it an image with time.
        if (this.findCandidates().map((c) => c.id).join("\n") !== this.candidates.map((c) => c.id).join("\n")) {
          void this.refresh();
          return;
        }
        this.placeChanged();
        this.readPins();
      }),
      ctx.viewer.onCursorChanged(() => {
        clearTimeout(this.cursorTimer);
        clearTimeout(this.restTimer);
        this.cursorTimer = setTimeout(() => this.readCursor(), 80);
        this.restTimer = setTimeout(() => this.readCursorFine(), REST_MS);
      }),
      () => clearTimeout(this.cursorTimer),
      () => clearTimeout(this.restTimer),
      () => this.pause(),
      () => this.client.dispose(),
    );
    void this.refresh();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    for (const r of this.pinned.values()) r.controller?.abort();
    this.cursor?.read.controller?.abort();
  }

  private save(patch: Partial<Saved>): void {
    this.saved = { ...this.saved, ...patch };
    this.ctx.state.set(this.saved);
  }

  private setStatus(text: string, error = false): void {
    this.status = text;
    this.statusError = error;
    this.update?.();
  }

  // ------------------------------------------------------------- the image

  private sourceOf(layer: string): string | undefined {
    const s = this.ctx.viewer.layerSpec(layer)?.source;
    const url = typeof s === "string" ? s : typeof (s as { url?: unknown })?.url === "string" ? (s as { url: string }).url : undefined;
    return omeZarrUrl(url);
  }

  /**
   * Image layers that show a time dimension (one in seconds, or named t),
   * then the time series on surfaces opened from this computer (their
   * stores' headers read once, in the background).
   */
  private findCandidates(): Candidate[] {
    const layers = this.ctx.viewer.layers();
    const images: Candidate[] = layers
      .filter((l) => l.type === "image")
      .map((l) => l.name)
      .filter((name) => {
        const t = this.ctx.viewer.layerTransform(name);
        return t !== undefined && t.input.names.some((n, i) => t.input.units[i] === "s" || n.replace(/['^]$/, "") === "t") && this.sourceOf(name) !== undefined;
      })
      .map((name) => ({ id: name, label: name, layer: name }));
    const surfaces: Candidate[] = [];
    for (const l of layers) {
      if (l.type === "image") continue;
      const s = this.ctx.viewer.layerSpec(l.name)?.source;
      const store = zarrVectorsStore(typeof s === "string" ? s : typeof (s as { url?: unknown })?.url === "string" ? (s as { url: string }).url : undefined);
      if (store === undefined || this.ctx.workspace.local.locate(store) === undefined) continue;
      const known = this.surfaceHeaders.get(store);
      if (known === undefined) this.readSurfaceHeader(store);
      if (!Array.isArray(known)) continue;
      for (const series of known) surfaces.push({ id: `${l.name} · ${series.name}`, label: `${l.name}: ${series.name} (${series.source.split("/").pop()})`, layer: l.name, surface: { store, series } });
    }
    return [...images, ...surfaces];
  }

  /** A surface store's time series, from its header; the candidates again once read. */
  private readSurfaceHeader(store: string): void {
    this.surfaceHeaders.set(store, "reading");
    fetch(`${store}headers/surface/zarr.json`)
      .then((r) => (r.ok ? r.json() : undefined))
      .then(
        (json) => this.surfaceHeaders.set(store, surfaceSeriesOf(json)),
        () => this.surfaceHeaders.set(store, []),
      )
      .then(() => void this.refresh());
  }

  /** The candidate chosen: the saved one when it is still there, else the first. */
  private chosen(): Candidate | undefined {
    return this.candidates.find((c) => c.id === this.saved.layer) ?? this.candidates[0];
  }

  /** The layers, the chosen image, and its metadata, after any change to them. */
  private async refresh(): Promise<void> {
    this.candidates = this.findCandidates();
    const chosen = this.chosen();
    const url = chosen === undefined || chosen.surface !== undefined ? undefined : this.sourceOf(chosen.layer);
    const surface = chosen?.surface;
    if (surface?.store !== this.surface?.store || surface?.series.name !== this.surface?.series.name) {
      this.surface = surface;
      this.vertexCursor = undefined;
      if (surface !== undefined) void this.surfaceTime(surface);
    }
    if (url !== this.infoUrl) {
      this.infoUrl = url;
      this.info = undefined;
      this.openError = undefined;
      this.cursor?.read.controller?.abort();
      this.cursor = undefined;
      if (url !== undefined) {
        try {
          const info = await this.client.open(url);
          if (this.infoUrl !== url) return;
          this.info = info;
        } catch (e) {
          if (this.infoUrl !== url) return;
          this.openError = (e as Error).message;
        }
      }
    }
    this.placeChanged();
    this.readPins();
    this.update?.();
  }

  /** The image layer chosen (its name), or a surface's series (the candidate's id). */
  private layer(): string | undefined {
    return this.chosen()?.id;
  }

  private choose(layer: string): void {
    this.save({ layer });
    void this.refresh();
  }

  /** The layer's map and time axis, and the time point shown, after the state changed. */
  private placeChanged(): void {
    if (this.surface !== undefined) {
      // A surface's series: its own time axis, the time point its store serves.
      const before = this.axis;
      this.map = undefined;
      this.axis = surfaceAxis(this.surface.series);
      this.axisNote = undefined;
      if (JSON.stringify(before) !== JSON.stringify(this.axis)) this.drawPlot();
      this.updateTime?.();
      return;
    }
    const layer = this.layer();
    const info = this.info;
    const t = layer === undefined ? undefined : this.ctx.viewer.layerTransform(layer);
    if (info === undefined || t === undefined) {
      this.map = undefined;
      this.axis = undefined;
      this.axisNote = undefined;
      this.updateTime?.();
      return;
    }
    const { space, position } = this.place(layer);
    const map = new LayerMap(t, space);
    const axis = timeAxis(map, info, position);
    const before = this.axis;
    this.map = map;
    this.axis = typeof axis === "string" ? undefined : axis;
    this.axisNote = typeof axis === "string" ? axis : undefined;
    this.current = this.axis === undefined ? 0 : indexAt(map, this.axis, position);
    // The plot's times change only with the axis.
    if (JSON.stringify(before) !== JSON.stringify(this.axis)) this.drawPlot();
    this.updateTime?.();
  }

  /** The global dimensions and the layer's local ones (a local time axis, `t'`), and the position along them. */
  private place(layer = this.layer()): Place {
    return placeOf(this.ctx.viewer.getState(), layer === undefined ? undefined : this.ctx.viewer.localPosition(layer));
  }

  private position(): number[] {
    return this.place().position;
  }

  // ------------------------------------------------------------- reading

  /** Reads a mean time course (the finest level's) into `read`, then redraws. */
  private readInto(read: Read, voxels: Int32Array, what: string): void {
    const url = this.infoUrl;
    if (url === undefined) return;
    const controller = (read.controller = new AbortController());
    let shown = 0;
    this.client
      .mean(url, voxels, {
        signal: controller.signal,
        progress: (done, total) => {
          // A few updates, not one per chunk.
          const pct = Math.floor((100 * done) / total);
          if (total > 4 && pct >= shown + 10) {
            shown = pct;
            this.setStatus(`Reading ${what}: ${pct}%`);
          }
        },
      })
      .then(
        (values) => {
          read.values = values;
          read.coarse = undefined;
          read.error = undefined;
          read.controller = undefined;
          this.setStatus("");
          this.drawPlot();
        },
        (e: Error) => {
          if (controller.signal.aborted) {
            // A newer read took its place: its progress is not news.
            if (this.status.startsWith(`Reading ${what}`)) this.setStatus("");
            return;
          }
          read.controller = undefined;
          read.error = e.message;
          this.setStatus(`Could not read ${what}: ${e.message}`, true);
        },
      );
  }

  /** The mouse's position, ordered as a Place's dimensions (the layer's local ones where it is); undefined when it is not in a view. */
  private cursorPosition(place: Place): number[] | undefined {
    const cursor = this.ctx.viewer.cursor();
    if (!cursor.active) return undefined;
    return place.space.names.map((n, i) => {
      const at = cursor.names.indexOf(n);
      return at === -1 ? place.position[i] : cursor.position[at];
    });
  }

  /** The image voxel under the mouse, if it is over the image. */
  private cursorVoxel(): number[] | undefined {
    const { map, info } = this;
    if (map === undefined || info === undefined) return undefined;
    const position = this.cursorPosition(this.place());
    return position === undefined ? undefined : voxelAt(map, info, position);
  }

  /**
   * The vertex under the mouse, on the surface whose series is chosen: the
   * mouse's position through the inverse of the surface layer's transform
   * to the store's coordinates, the store asked for the vertex nearest it
   * (within VERTEX_REACH_MM), then for that vertex's values at every time
   * point.  Away from the surface, the last vertex stays plotted (so it can
   * be pinned from the panel).
   */
  private async readVertexCursor(): Promise<void> {
    const surface = this.surface;
    const layer = this.chosen()?.layer;
    const t = layer === undefined ? undefined : this.ctx.viewer.layerTransform(layer);
    if (surface === undefined || layer === undefined || t === undefined) return;
    const place = this.place(layer);
    const position = this.cursorPosition(place);
    const point = position === undefined ? undefined : storePoint(new LayerMap(t, place.space), position);
    if (point === undefined) return;
    const lookup = ++this.vertexLookups;
    let found: { vertex: number; distance: number } | undefined;
    try {
      found = nearestOf(await this.ctx.workspace.local.send(surface.store, { series: surface.series.name, nearest: point, within: storeDistance(t, VERTEX_REACH_MM) }));
    } catch (e) {
      if (lookup === this.vertexLookups && this.surface === surface) this.setStatus(`Could not find the vertex under the mouse: ${(e as Error).message}`, true);
      return;
    }
    if (lookup !== this.vertexLookups || this.surface !== surface || found === undefined) return;
    const known = this.vertexCursor;
    if (known !== undefined && known.store === surface.store && known.series === surface.series.name && known.vertex === found.vertex) return;
    const read: Read = { key: `${surface.store}|${surface.series.name}|${found.vertex}` };
    this.vertexCursor = { store: surface.store, series: surface.series.name, vertex: found.vertex, read };
    this.readVertexInto(read, surface.store, surface.series.name, found.vertex, "the vertex under the mouse");
    this.update?.();
  }

  /** Reads a surface vertex's values at every time point from its store into `read`, then redraws. */
  private async readVertexInto(read: Read, store: string, series: string, vertex: number, what: string): Promise<void> {
    try {
      const values = ((await this.ctx.workspace.local.send(store, { series, vertex })) as { values?: unknown } | undefined)?.values;
      if (!(values instanceof Float32Array)) throw new Error("the store sent no values");
      read.values = values;
      // A vertex the file has no column for (the medial wall).
      read.error = values.some((v) => !Number.isNaN(v)) ? undefined : "no values: not in the series";
      this.drawPlot();
    } catch (e) {
      read.error = (e as Error).message;
      this.setStatus(`Could not read ${what}: ${read.error}`, true);
    }
  }

  /**
   * The voxel under the mouse: its time course, unless it is the one
   * shown.  When the finest level's series is slow to read (a long series
   * in large chunks), the mouse moving reads it only if it is in the cache
   * already, else a coarse read (`movingPlan`: a coarser level, or one time
   * chunk in several); the finest is read once the mouse rests.
   */
  private readCursor(): void {
    if (this.surface !== undefined) {
      void this.readVertexCursor();
      return;
    }
    const info = this.info;
    const voxel = this.cursorVoxel();
    if (voxel === undefined || info === undefined) return;
    if (this.cursor !== undefined && this.cursor.voxel.join() === voxel.join()) return;
    this.cursor?.read.controller?.abort();
    const read: Read = { key: voxel.join() };
    const plan = movingPlan(info);
    const cursor: Cursor = { voxel, read, fine: plan === undefined };
    this.cursor = cursor;
    if (plan === undefined) this.readInto(read, Int32Array.from(voxel), "the voxel under the mouse");
    else cursor.quick = this.readQuick(cursor, plan);
    this.update?.();
  }

  /** The finest values if the worker has them, else a coarse read. */
  private async readQuick(cursor: Cursor, plan: ReadPlan): Promise<void> {
    const url = this.infoUrl;
    const info = this.info;
    if (url === undefined || info === undefined) return;
    const { read, voxel } = cursor;
    const controller = (read.controller = new AbortController());
    const { signal } = controller;
    try {
      const cached = await this.client.meanIfCached(url, Int32Array.from(voxel), signal);
      if (signal.aborted) return;
      if (cached !== undefined) {
        cursor.fine = true;
        read.values = cached;
        read.coarse = undefined;
      } else {
        const values = await this.client.mean(url, Int32Array.from(voxel), { signal, plan });
        if (signal.aborted) return;
        read.values = values;
        read.coarse = describePlan(info, plan);
      }
      read.error = undefined;
      read.controller = undefined;
      this.drawPlot();
    } catch (e) {
      if (signal.aborted) return;
      read.controller = undefined;
      read.error = (e as Error).message;
      this.setStatus(`Could not read the voxel under the mouse: ${read.error}`, true);
    }
  }

  /** The mouse at rest: the finest values of the voxel under it, after any coarse read running. */
  private readCursorFine(): void {
    const cursor = this.cursor;
    if (cursor === undefined || cursor.fine) return;
    // Only for the voxel still under the mouse (not the last one before it left the image).
    if (this.cursorVoxel()?.join() !== cursor.voxel.join()) return;
    cursor.fine = true;
    void (cursor.quick ?? Promise.resolve()).finally(() => {
      const done = cursor.read.values !== undefined && cursor.read.coarse === undefined;
      if (this.cursor === cursor && !done) this.readInto(cursor.read, Int32Array.from(cursor.voxel), "the voxel under the mouse");
    });
  }

  /** The voxels a pin averages over, or why there are none. */
  private voxelsOf(pin: Pin): Int32Array | string {
    if (pin.voxel !== undefined) return Int32Array.from(pin.voxel);
    const { map, info } = this;
    if (map === undefined || info === undefined || pin.region === undefined) return "no image";
    const layers = ((this.ctx.viewer.getState() as { layers?: { name: string; annotations?: AnnotationJson[] }[] }).layers ?? []);
    const annotation = layers.find((l) => l.name === pin.region!.layer)?.annotations?.find((a) => a.id === pin.region!.annotation);
    const shape = annotation === undefined ? undefined : shapeOf(annotation);
    const t = this.ctx.viewer.layerTransform(pin.region.layer);
    if (shape === undefined || t === undefined) return "its annotation is gone";
    try {
      const { voxels, count } = regionVoxels(shape, new LayerMap(t, map.space), map, info, this.position());
      return count === 0 ? "no voxel centre is inside it" : voxels;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /** What a pin reads: its voxel, or its region's annotation as it is now (so a region moved is read again). */
  private pinKey(pin: Pin): string {
    if (pin.vertex !== undefined) return `${pin.vertex.store}|${pin.vertex.series}|${pin.vertex.index}`;
    if (pin.parcel !== undefined) return `${pin.parcel.store}|${pin.parcel.series}|${pin.parcel.parcellation}|${pin.parcel.code}`;
    if (pin.voxel !== undefined) return `${this.infoUrl}|${pin.voxel.join()}`;
    const layers = (this.ctx.viewer.getState() as { layers?: { name: string; annotations?: AnnotationJson[] }[] }).layers ?? [];
    const annotation = layers.find((l) => l.name === pin.region?.layer)?.annotations?.find((a) => a.id === pin.region?.annotation);
    return `${this.infoUrl}|${JSON.stringify(annotation === undefined ? null : shapeOf(annotation))}|${JSON.stringify(this.ctx.viewer.layerTransform(pin.region?.layer ?? "")?.matrix)}`;
  }

  /** Reads the pins of the chosen image not read yet, or changed; forgets those removed. */
  private readPins(): void {
    const layer = this.layer();
    const live = new Set<number>();
    let changed = false;
    for (const pin of this.saved.pins) {
      const onSurface = pin.vertex !== undefined || pin.parcel !== undefined;
      if (pin.layer !== layer || (onSurface ? this.surface === undefined : this.map === undefined)) continue;
      live.add(pin.id);
      const key = this.pinKey(pin);
      const known = this.pinned.get(pin.id);
      if (known?.key === key) continue;
      changed = true;
      known?.controller?.abort();
      const read: Read = { key };
      this.pinned.set(pin.id, read);
      if (pin.parcel !== undefined) {
        void this.readParcelInto(read, pin.parcel, pin.label);
        continue;
      }
      if (pin.vertex !== undefined) {
        // A vertex already read under the mouse needs no reading again.
        const under = this.vertexCursor;
        if (under?.read.values !== undefined && `${under.store}|${under.series}|${under.vertex}` === key) Object.assign(read, { values: under.read.values, error: under.read.error });
        else void this.readVertexInto(read, pin.vertex.store, pin.vertex.series, pin.vertex.index, pin.label);
        continue;
      }
      // A pinned voxel already read under the mouse needs no reading again.
      if (pin.voxel !== undefined && this.cursor?.voxel.join() === pin.voxel.join() && this.cursor.read.values !== undefined && this.cursor.read.coarse === undefined) {
        read.values = this.cursor.read.values;
        continue;
      }
      const voxels = this.voxelsOf(pin);
      if (typeof voxels === "string") read.error = voxels;
      else this.readInto(read, voxels, pin.label);
    }
    for (const [id, read] of this.pinned) {
      if (live.has(id)) continue;
      read.controller?.abort();
      this.pinned.delete(id);
      changed = true;
    }
    if (changed) this.drawPlot();
  }

  // ------------------------------------------------------------- pins

  private nextColour(): number | undefined {
    const colour = freeColour(this.saved.pins.filter((p) => p.layer === this.layer()).map((p) => p.colour));
    if (colour === undefined) this.ctx.ui.toast(`${COLOURS.length} pins at most: remove one first.`);
    return colour;
  }

  private addPin(pin: Omit<Pin, "id" | "colour" | "layer">): void {
    const layer = this.layer();
    const colour = this.nextColour();
    if (layer === undefined || colour === undefined) return;
    const id = Math.max(0, ...this.saved.pins.map((p) => p.id)) + 1;
    this.save({ pins: [...this.saved.pins, { ...pin, id, colour, layer }] });
    this.readPins();
    this.update?.();
  }

  /** Pins the voxel under the mouse (else the one at the views' centre). */
  pinCursor(): void {
    const surface = this.surface;
    if (surface !== undefined) {
      // On a surface: the vertex under the mouse (or the last one it was on).
      const under = this.vertexCursor;
      if (under === undefined) {
        this.ctx.ui.toast("Move the mouse onto the surface first.");
        return;
      }
      if (this.saved.pins.some((p) => p.layer === this.layer() && p.vertex?.store === under.store && p.vertex.series === under.series && p.vertex.index === under.vertex)) return;
      this.addPin({ label: vertexLabel(under.vertex), vertex: { store: under.store, series: under.series, index: under.vertex } });
      return;
    }
    const { map, info } = this;
    if (map === undefined || info === undefined) {
      this.ctx.ui.toast("Choose an image with a time axis in the Time series tab first.");
      return;
    }
    const voxel = this.cursor?.voxel ?? voxelAt(map, info, this.position());
    if (voxel === undefined) {
      this.ctx.ui.toast("The mouse is not over the image.");
      return;
    }
    if (this.saved.pins.some((p) => p.layer === this.layer() && p.voxel?.join() === voxel.join())) return;
    this.addPin({ label: voxelLabel(info, voxel), voxel });
  }

  private pinRegion(): void {
    const [layer, id] = JSON.parse(this.region || "[]") as [string?, string?];
    if (layer === undefined || id === undefined) return;
    const option = this.regions().find((r) => r.layer === layer && r.id === id);
    this.addPin({ label: `${option?.label ?? "region"} (mean)`, region: { layer, annotation: id } });
  }

  private removePin(id: number): void {
    this.save({ pins: this.saved.pins.filter((p) => p.id !== id) });
    this.readPins();
    this.update?.();
  }

  /** Boxes and ellipsoids in the scene's annotation layers. */
  private regions(): { layer: string; id: string; label: string }[] {
    const layers = ((this.ctx.viewer.getState() as { layers?: { name: string; annotations?: AnnotationJson[] }[] }).layers ?? []);
    const out: { layer: string; id: string; label: string }[] = [];
    for (const l of layers) {
      if (!Array.isArray(l.annotations)) continue;
      let n = 0;
      for (const a of l.annotations) {
        const shape = shapeOf(a);
        if (shape === undefined) continue;
        n++;
        out.push({ layer: l.name, id: a.id, label: `${l.name}: ${a.description?.trim() || `${shape.type} ${n}`}` });
      }
    }
    return out;
  }

  // ------------------------------------------------------------- time

  /**
   * Shows time point `i` in the views; `quiet` (playing) makes no undo
   * step of it.
   */
  private show(i: number, quiet = false): void {
    if (this.surface !== undefined) {
      void this.showOnSurface(i);
      return;
    }
    const { map, axis } = this;
    if (map === undefined || axis === undefined) return;
    const layer = this.layer();
    const { position, globalRank } = this.place(layer);
    const target = new Array(position.length).fill(NaN);
    target[axis.dim] = coordinateOf(map, axis, position, i);
    // A local time axis (`t'`) is moved in the layer's own position.
    if (axis.dim < globalRank) this.ctx.viewer.setPosition(target.slice(0, globalRank), { quiet });
    else if (layer !== undefined) this.ctx.viewer.setLocalPosition(layer, target.slice(globalRank), { quiet });
  }

  /** The time point a surface's store serves now. */
  private async surfaceTime(surface: SurfaceStep): Promise<void> {
    try {
      const answer = (await this.ctx.workspace.local.send(surface.store, { series: surface.series.name })) as { time?: number };
      if (this.surface !== surface || typeof answer?.time !== "number") return;
      this.current = answer.time;
      this.updateTime?.();
      this.readSurfaceExtras(surface);
      // The time point the link keeps, shown again (a reload starts the store at 0).
      const kept = this.saved.surfaceTimes?.[surfaceKey(surface)];
      if (kept !== undefined && kept !== answer.time) void this.showOnSurface(kept);
    } catch (e) {
      if (this.surface === surface) this.setStatus(`Could not reach ${surface.series.name}: ${(e as Error).message}`, true);
    }
  }

  /** A surface's parcellations: asked of its store once. */
  private readSurfaceExtras(surface: SurfaceStep): void {
    const { store } = surface;
    const series = surface.series.name;
    const key = `${store}|${series}`;
    if (this.parcellations.has(key)) return;
    this.parcellations.set(key, "reading");
    this.ctx.workspace.local.send(store, { series, parcellations: true }).then(
      (answer) => {
        this.parcellations.set(key, parcellationsOf(answer));
        this.update?.();
      },
      () => this.parcellations.set(key, []),
    );
  }

  /** The chosen surface series' parcellations, once read. */
  private surfaceParcellations(): Parcellation[] {
    const surface = this.surface;
    const known = surface === undefined ? undefined : this.parcellations.get(`${surface.store}|${surface.series.name}`);
    return Array.isArray(known) ? known : [];
  }

  /** The parcellation chosen in the panel (the first when none is). */
  private chosenParcellation(): Parcellation | undefined {
    const list = this.surfaceParcellations();
    return list.find((p) => p.name === this.parcellation) ?? list[0];
  }

  /** Pins the mean over a parcel of the chosen surface series' parcellation. */
  private pinParcel(parcellation: Parcellation, code: number): void {
    const surface = this.surface;
    const label = parcellation.labels.find((l) => l.code === code);
    if (surface === undefined || label === undefined) return;
    const same = (p: Pin) => p.layer === this.layer() && p.parcel?.store === surface.store && p.parcel.series === surface.series.name && p.parcel.parcellation === parcellation.name && p.parcel.code === code;
    if (this.saved.pins.some(same)) return;
    this.addPin({ label: parcelLabel(label.name, parcellation.name), parcel: { store: surface.store, series: surface.series.name, parcellation: parcellation.name, code, name: label.name } });
  }

  /** Pins the mean over the parcel the vertex under the mouse (or the last one it was on) is in. */
  pinItsParcel(): void {
    const parcellation = this.chosenParcellation();
    const under = this.vertexCursor;
    if (this.surface === undefined || parcellation === undefined) {
      this.ctx.ui.toast("Choose a surface's time series with a parcellation beside it (an .annot, .label or CIFTI dlabel file) first.");
      return;
    }
    if (under === undefined) {
      this.ctx.ui.toast("Move the mouse onto the surface first.");
      return;
    }
    const label = parcelAt(parcellation, under.vertex);
    if (label === undefined) {
      this.ctx.ui.toast(`${vertexLabel(under.vertex)} has no label in ${parcellation.name}.`);
      return;
    }
    this.parcel = label.code;
    this.pinParcel(parcellation, label.code);
  }

  /** Reads a parcel's mean and SD at every time point from its store into `read`, then redraws. */
  private async readParcelInto(read: Read, parcel: NonNullable<Pin["parcel"]>, what: string): Promise<void> {
    try {
      const course = parcelCourseOf(await this.ctx.workspace.local.send(parcel.store, { series: parcel.series, parcellation: parcel.parcellation, parcel: parcel.code }));
      if (course === undefined) throw new Error("the store sent no values");
      read.values = course.mean;
      read.sd = course.sd;
      read.error = course.vertices > 0 ? undefined : "no values: none of its vertices is in the series";
      this.drawPlot();
    } catch (e) {
      read.error = (e as Error).message;
      this.setStatus(`Could not read ${what}: ${read.error}`, true);
    }
  }

  /**
   * Shows time point `i` on the surface: its store is told to serve it,
   * then the viewer reads the surface's values again.  Steps asked for
   * while one is sent are taken together (the last one is shown).  The
   * views' state does not change, so it makes no undo step.
   */
  private async showOnSurface(i: number): Promise<void> {
    const surface = this.surface;
    if (surface === undefined) return;
    this.surfaceWanted = i;
    if (this.surfaceSending) return;
    this.surfaceSending = true;
    try {
      while (this.surfaceWanted !== undefined && this.surface === surface) {
        const time = this.surfaceWanted;
        this.surfaceWanted = undefined;
        const answer = (await this.ctx.workspace.local.send(surface.store, { series: surface.series.name, time })) as { time: number };
        if (this.surface !== surface) break;
        this.ctx.viewer.reloadData(surface.store);
        this.current = answer.time;
        this.updateTime?.();
        // Kept in the link when it settles: not each frame while playing (each would be a change).
        if (this.playing === undefined) this.keepSurfaceTime();
      }
    } catch (e) {
      this.setStatus(`Could not show time point ${i}: ${(e as Error).message}`, true);
    } finally {
      this.surfaceSending = false;
    }
  }

  private step(delta: number): void {
    if (this.axis !== undefined) this.show(stepIndex(this.current, delta, this.axis.count));
  }

  toggle(): void {
    if (this.playing !== undefined) this.pause();
    else this.play();
  }

  private play(): void {
    const axis = this.axis;
    if (axis === undefined) return;
    // Playing from the last time point starts again.
    if (this.current >= axis.count - 1) this.show(0, true);
    const tick = () => {
      const next = this.axis === undefined ? undefined : nextIndex(this.current, this.axis.count, this.loop);
      if (next === undefined) {
        this.pause();
        return;
      }
      this.show(next, true);
      this.playing = setTimeout(tick, 1000 / this.rate);
    };
    this.playing = setTimeout(tick, 1000 / this.rate);
    this.update?.();
  }

  private pause(): void {
    clearTimeout(this.playing);
    if (this.playing === undefined) return;
    this.playing = undefined;
    this.keepSurfaceTime();
    this.update?.();
  }

  /** Keeps the surface series' time point in the plugin's state (the link). */
  private keepSurfaceTime(): void {
    const surface = this.surface;
    if (surface === undefined) return;
    const key = surfaceKey(surface);
    if (this.saved.surfaceTimes?.[key] === this.current) return;
    this.save({ surfaceTimes: { ...this.saved.surfaceTimes, [key]: this.current } });
  }

  // ------------------------------------------------------------- plot and CSV

  /** The series plotted: the voxel (or a surface's vertex) under the mouse, then the pins. */
  private plotted(): (PlotSeries & { id?: number })[] {
    const out: (PlotSeries & { id?: number })[] = [];
    const info = this.info;
    const read = this.cursor?.read;
    const under = this.surface === undefined ? undefined : this.vertexCursor;
    if (under?.read.values !== undefined && under.read.error === undefined) {
      out.push({ label: `Mouse (${vertexLabel(under.vertex)})`, values: under.read.values, colour: CURSOR_COLOUR });
    } else if (read?.values !== undefined && info !== undefined) {
      out.push({ label: `Mouse (${voxelLabel(info, this.cursor!.voxel)})${read.coarse !== undefined ? " coarse" : ""}`, values: read.values, colour: CURSOR_COLOUR, coarse: read.coarse });
    }
    for (const pin of this.saved.pins) {
      const read = this.pinned.get(pin.id);
      const values = read?.error === undefined ? read?.values : undefined;
      if (pin.layer === this.layer() && values !== undefined) out.push({ id: pin.id, label: pin.label, values, colour: COLOURS[pin.colour], ...(read?.sd !== undefined ? { sd: read.sd } : {}) });
    }
    return out;
  }

  private drawPlot(): void {
    const axis = this.axis;
    const series = axis ? this.plotted() : [];
    this.plot?.set({
      times: axis ? timesOf(axis) : [],
      unit: axis?.unit.label ?? "",
      series: this.change ? series.map((s) => ({ ...s, values: percentChange(s.values), ...(s.sd !== undefined ? { sd: percentChangeSpread(s.values, s.sd) } : {}) })) : series,
      valueUnit: this.change ? "%" : "",
    });
    this.plot?.setCurrent(this.current);
    this.update?.();
  }

  saveCsv(): void {
    const axis = this.axis;
    const series = this.plotted();
    if (axis === undefined || series.length === 0) {
      this.ctx.ui.toast("Nothing is plotted to save.");
      return;
    }
    const name = (this.layer() ?? "image").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "image";
    const a = el("a", { href: URL.createObjectURL(new Blob([seriesCsv(axis, series)], { type: "text/csv" })), download: `${name}_time_series.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  // ------------------------------------------------------------- panel

  /** The surface's parcels: a parcellation, a parcel, and pins of their mean (and SD). */
  private parcelRow(): Node | string {
    const list = this.surfaceParcellations();
    const parcellation = this.chosenParcellation();
    if (parcellation === undefined) return "";
    const labels = [...parcellation.labels].sort((a, b) => a.name.localeCompare(b.name));
    if (!labels.some((l) => l.code === this.parcel)) this.parcel = labels[0]?.code;
    const which =
      list.length > 1
        ? el(
            "select",
            { class: "text-input", "aria-label": "Parcellation", title: "The parcellation", onchange: (e: Event) => ((this.parcellation = (e.target as HTMLSelectElement).value), (this.parcel = undefined), this.update?.()) },
            ...list.map((p) => el("option", { value: p.name, selected: p === parcellation }, p.name)),
          )
        : "";
    const parcel = el(
      "select",
      { class: "text-input", "aria-label": "Parcel", title: `A label of ${parcellation.name} (how many vertices have it)`, onchange: (e: Event) => (this.parcel = Number((e.target as HTMLSelectElement).value)) },
      ...labels.map((l) => el("option", { value: l.code, selected: l.code === this.parcel }, `${l.name} (${l.vertices})`)),
    );
    return el(
      "div",
      { class: "ts-row ts-region" },
      which,
      parcel,
      el("button", { class: "btn outline small", type: "button", title: "Pin the mean (and SD) over the parcel's vertices", onclick: () => this.parcel !== undefined && this.pinParcel(parcellation, this.parcel) }, "Pin mean"),
      el("button", { class: "btn outline small", type: "button", title: "Pin the mean over the parcel of the vertex under the mouse (Alt+Shift+M)", onclick: () => this.pinItsParcel() }, "Its parcel"),
    );
  }

  render(host: HTMLElement): Disposer {
    host.classList.add("ts-host");
    const plot = (this.plot = new Plot((i) => this.show(i)));
    const side = el("div", { class: "ts-side" });
    const legend = el("div", { class: "ts-legend" });
    const actions = el("div", { class: "ts-actions" });
    const time = el("div", { class: "ts-time", "aria-live": "off" });
    host.replaceChildren(el("div", { class: "ts" }, side, el("div", { class: "ts-main" }, el("div", { class: "ts-head" }, legend, actions), plot.element)));

    const button = (name: string, title: string, onclick: () => void, disabled: boolean) =>
      el("button", { class: "btn outline small icon", type: "button", title, "aria-label": title, onclick, disabled }, icon(name));

    this.updateTime = () => {
      const axis = this.axis;
      if (axis === undefined) {
        time.replaceChildren();
        return;
      }
      time.replaceChildren(formatTime(timeOf(axis, this.current), axis.unit.label), el("span", { class: "ts-of" }, `  time point ${this.current} of 0–${axis.count - 1}`));
      plot.setCurrent(this.current);
    };

    const draw = () => {
      const layer = this.layer();
      const axis = this.axis;
      const ready = axis !== undefined;
      const surface = this.surface;
      // An image's voxels or a surface's vertices are plotted and pinned; regions are the images'.
      const plots = ready && (surface !== undefined || this.info !== undefined);
      const regionsToo = plots && surface === undefined;
      const image = el(
        "select",
        { class: "text-input", "aria-label": "Image", title: "The image plotted", onchange: (e: Event) => this.choose((e.target as HTMLSelectElement).value) },
        ...this.candidates.map((c) => el("option", { value: c.id, selected: c.id === layer }, c.label)),
      );
      const rate = el(
        "select",
        { class: "text-input", title: "Time points a second", "aria-label": "Rate", onchange: (e: Event) => ((this.rate = Number((e.target as HTMLSelectElement).value)), this.ctx.settings.set("rate", this.rate)) },
        ...RATES.map((r) => el("option", { value: r, selected: r === this.rate }, `${r}/s`)),
      );
      const loop = el("label", { class: "field check" }, el("input", { type: "checkbox", checked: this.loop, onchange: (e: Event) => ((this.loop = (e.target as HTMLInputElement).checked), this.ctx.settings.set("loop", this.loop)) }), "Loop");
      const regions = this.regions();
      if (!regions.some((r) => JSON.stringify([r.layer, r.id]) === this.region)) this.region = regions.length > 0 ? JSON.stringify([regions[0].layer, regions[0].id]) : "";
      const region = el(
        "select",
        { class: "text-input", "aria-label": "Region", onchange: (e: Event) => (this.region = (e.target as HTMLSelectElement).value) },
        ...regions.map((r) => {
          const value = JSON.stringify([r.layer, r.id]);
          return el("option", { value, selected: value === this.region }, r.label);
        }),
      );
      const note =
        this.candidates.length === 0
          ? "Open an image with a time axis (a 4-D NIfTI, or OME-Zarr with t) to plot its time courses, or a surface with a CIFTI time series beside it to step through and plot its vertices."
          : this.openError !== undefined
            ? `Could not read ${layer}: ${this.openError}`
            : this.axisNote !== undefined
              ? `Time is not shown: ${this.axisNote}.`
              : this.info === undefined && surface === undefined
                ? "Opening…"
                : "";
      side.replaceChildren(
        this.candidates.length > 0 ? image : "",
        el(
          "div",
          { class: "ts-row" },
          button("first", "First time point", () => this.show(0), !ready),
          button("previous", "Previous time point", () => this.step(-1), !ready),
          button(this.playing ? "pause" : "play", this.playing ? "Pause (Alt+Shift+P)" : "Play (Alt+Shift+P)", () => this.toggle(), !ready),
          button("next", "Next time point", () => this.step(1), !ready),
          button("last", "Last time point", () => this.axis && this.show(this.axis.count - 1), !ready),
          rate,
        ),
        el("div", { class: "ts-row ts-spread" }, time, loop),
        regions.length > 0 && regionsToo ? el("div", { class: "ts-row ts-region" }, region, el("button", { class: "btn outline small", type: "button", title: "Pin the mean over the region's voxels", onclick: () => this.pinRegion() }, "Pin mean")) : "",
        surface !== undefined ? this.parcelRow() : "",
        el("div", { class: `ts-status${this.statusError ? " error" : ""}` }, note || this.status),
      );
      // The legend: every series plotted or pinned, pins removable.
      const keys: Node[] = [];
      if (surface !== undefined) {
        const layer = this.chosen()?.layer;
        keys.push(
          el(
            "span",
            { class: "ts-key ts-note" },
            `${layer} shows the time point chosen here as its values ${surface.series.name}. `,
            layer === undefined
              ? null
              : el("button", { class: "btn small", type: "button", onclick: () => this.ctx.viewer.setSurfaceOverlay(layer, surface.series.name) }, `Show ${surface.series.name} as the overlay`),
          ),
        );
        const under = this.vertexCursor;
        if (under === undefined) keys.push(el("span", { class: "ts-key" }, "Move the mouse onto the surface to plot a vertex's time course."));
        else {
          const parcellation = this.chosenParcellation();
          const label = parcellation === undefined ? undefined : parcelAt(parcellation, under.vertex);
          const inParcel = label === undefined ? "" : `, in ${label.name}`;
          keys.push(el("span", { class: "ts-key", title: under.read.error ?? "" }, swatch(CURSOR_COLOUR), `Mouse: ${vertexLabel(under.vertex)}${inParcel}${under.read.error ? ` (${under.read.error})` : under.read.values === undefined ? " …" : ""}`));
        }
      } else if (this.cursor !== undefined && this.info !== undefined) {
        const coarse = this.cursor.read.coarse;
        keys.push(el("span", { class: "ts-key", title: coarse === undefined ? "" : "Read coarsely while the mouse moves; the finest values are read when it rests" }, swatch(CURSOR_COLOUR), `Mouse: ${voxelLabel(this.info, this.cursor.voxel)}${coarse !== undefined ? ` (coarse: ${coarse})` : ""}`));
      } else if (ready) {
        keys.push(el("span", { class: "ts-key" }, "Move the mouse over the image to plot its time course."));
      }
      for (const pin of this.saved.pins) {
        if (pin.layer !== layer) continue;
        const read = this.pinned.get(pin.id);
        keys.push(
          el(
            "span",
            { class: "ts-key", title: read?.error ?? "" },
            swatch(COLOURS[pin.colour]),
            `${pin.label}${read?.error ? ` (${read.error})` : read?.values === undefined ? " …" : ""}`,
            el("button", { type: "button", title: "Remove", "aria-label": `Remove ${pin.label}`, onclick: () => this.removePin(pin.id) }, "×"),
          ),
        );
      }
      legend.replaceChildren(...keys);
      actions.replaceChildren(
        el(
          "label",
          { class: "field check", title: "Plot each series as its change from its own mean, in percent (CSV keeps the values)" },
          el("input", { type: "checkbox", checked: this.change, onchange: (e: Event) => ((this.change = (e.target as HTMLInputElement).checked), this.ctx.settings.set("change", this.change), this.drawPlot()) }),
          "% change",
        ),
        el("button", { class: "btn outline small", type: "button", title: `Pin the ${surface !== undefined ? "vertex" : "voxel"} under the mouse (Alt+P)`, onclick: () => this.pinCursor(), disabled: !plots }, "Pin"),
        el("button", { class: "btn outline small", type: "button", title: "Save the plotted series as CSV", onclick: () => this.saveCsv(), disabled: !plots }, "Save CSV"),
      );
      this.updateTime?.();
    };
    this.update = draw;
    draw();
    this.drawPlot();
    return () => {
      this.update = undefined;
      this.updateTime = undefined;
      plot.dispose();
      this.plot = undefined;
      host.classList.remove("ts-host");
    };
  }
}

function swatch(colour: string): HTMLElement {
  const s = el("span", { class: "ts-swatch" });
  s.style.background = colour;
  return s;
}

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    ctx.subscriptions.push(() => style.remove());
    const series = new TimeSeries(ctx);
    ctx.subscriptions.push(() => series.dispose());
    ctx.commands.register("timeSeries.pin", () => series.pinCursor());
    ctx.commands.register("timeSeries.pinParcel", () => series.pinItsParcel());
    ctx.commands.register("timeSeries.play", () => series.toggle());
    ctx.commands.register("timeSeries.saveCsv", () => series.saveCsv());
    ctx.ui.panel(TIME_SERIES_PANEL, (host) => series.render(host));
  },
};
