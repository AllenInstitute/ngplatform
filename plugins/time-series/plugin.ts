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
 * point the transport chooses, finds the vertex nearest the mouse (within
 * three median edge lengths), sends a vertex's values at every time point,
 * and a parcel's mean and SD over its vertices.  Where
 * a position is in the image, and which time point the views show, come
 * from the layer's transform (./space.ts), so a moved layer reads where it
 * shows.  Pins are kept in the plugin's state (in the link); their values
 * are read again when the link is opened.
 */
import type { Disposer, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { button, checkbox, downloadBlob, el, emptyState, field, icon, iconButton, region, safeFileName, type Settable, type Slider, select, slider, statusLine } from "@ngplatform/sdk/dom";
import { omeZarrUrl } from "../volume-view/sources.js";
import { type ReadPlan, SeriesClient, type SeriesInfo } from "./client.js";
import { TIME_SERIES_PANEL } from "./manifest.js";
import { Plot, type PlotSeries, swatch } from "./plot.js";
import { describePlan, movingPlan } from "./reader.js";
import { type AnnotationJson, regionVoxels, shapeOf } from "./region.js";
import { COLOURS, coordinateOf, formatTime, freeColour, indexAt, nextIndex, percentChange, percentChangeSpread, RATES, seriesCsv, stepIndex, type TimeAxis, timeAxis, timeOf, timesOf, voxelAt, voxelLabel } from "./series.js";
import { LayerMap, type Place, placeOf } from "./space.js";
import { nearestOf, type Parcellation, parcelAt, parcelCourseOf, parcelLabel, parcellationsOf, storePoint, type SurfaceSeries, surfaceAxis, surfaceSeriesOf, vertexLabel, vertexReach, zarrVectorsStore } from "./surface.js";

const STYLE = `
.dock-pane.ts-host { padding: 0; height: 100%; }
.ts { display: grid; grid-template-columns: 264px minmax(0, 1fr); height: 100%; min-height: 0; font-size: var(--fs-body); }
.ts[hidden] { display: none; }
.ts-empty { padding: var(--sp-5); }
.ts-side { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4) var(--sp-5); border-right: 1px solid var(--line); overflow: auto; min-height: 0; }
.ts-side select { min-width: 0; width: 100%; }
.ts-side .row select { width: auto; flex: none; }
.ts-side .row.ts-fill select { flex: 1; width: auto; }
.ts-of { color: var(--faint); margin-left: var(--sp-3); }
.ts-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: var(--sp-3) var(--sp-5) var(--sp-2); }
.ts-head { display: flex; align-items: flex-start; gap: var(--sp-5); flex: none; }
.ts-legend { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-5); align-items: center; flex: 1; min-width: 0; min-height: 24px; }
.ts-key { display: inline-flex; align-items: center; gap: var(--sp-3); color: var(--muted); white-space: nowrap; }
.ts-swatch { display: inline-block; width: 12px; height: 2px; vertical-align: middle; color: var(--text); flex: none; }
.ts-plot-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.ts-plot { flex: 1; min-height: 0; width: 100%; display: block; color: var(--text); }
.ts-plot .ts-grid { stroke: var(--line); stroke-width: 1; }
.ts-plot .ts-axis { stroke: var(--line-strong); stroke-width: 1; }
.ts-plot .ts-tick { fill: var(--faint); font: var(--fs-caption) var(--mono); }
.ts-plot .ts-line { fill: none; stroke-width: 2; stroke-linejoin: round; }
.ts-plot .ts-band { stroke: none; opacity: 0.18; }
.ts-plot .ts-coarse { stroke-dasharray: 5 3; }
.ts-plot .ts-coarse-note { fill: var(--warn); }
.ts-plot .ts-now { stroke: var(--warn); stroke-width: 1.5; }
.ts-plot .ts-cross { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 2; }
.ts-plot .ts-dot { stroke: var(--ink-2); stroke-width: 2; }
.ts-plot .ts-hit { cursor: crosshair; }
.ts-readout { flex: none; color: var(--muted); font: var(--fs-caption)/1.5 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

/** The colour of the series under the mouse: the text colour (--text, set on the plot and the swatches), apart from the pins'. */
const CURSOR_COLOUR = "currentColor";

/** What the panel asks of the time series worker (a stand-in in the tests). */
export type SeriesSource = Pick<SeriesClient, "open" | "mean" | "meanIfCached" | "dispose">;

/** An image layer as the Image menu sees it: whether it shows a time axis (undefined while it loads) and whether its source can be read. */
export interface ImageLayer {
  name: string;
  time: boolean | undefined;
  readable: boolean;
}

/**
 * Why image layers are not in the Image menu, in a line: those with a
 * time axis in a format the panel cannot read (precomputed, N5, a remote
 * NIfTI), then, with `noTime`, those with no time axis.  Layers still
 * loading are left out.
 */
export function notRead(images: ImageLayer[], noTime = true): string {
  const parts = images.filter((i) => i.time === true && !i.readable).map((i) => `“${i.name}”: its format isn't readable here`);
  const none = noTime ? images.filter((i) => i.time === false).map((i) => `“${i.name}”`) : [];
  if (none.length > 0) parts.push(`${none.join(", ")} ${none.length === 1 ? "has" : "have"} no time axis`);
  return parts.join("; ");
}

export class TimeSeries {
  private saved: Saved;
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
  /** Each surface store's median edge length (store units), once it has said. */
  private readonly spacings = new Map<string, number>();
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
  /** What Retry does after the error in the status, if anything. */
  private statusRetry: (() => void) | undefined;
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

  constructor(
    private readonly ctx: PlatformContext,
    private readonly client: SeriesSource = new SeriesClient(),
  ) {
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

  /** Progress, or an error (with what Retry does), in the status line; "" clears it. */
  private setStatus(text: string, error = false, retry?: () => void): void {
    this.status = text;
    this.statusError = error;
    this.statusRetry = error ? retry : undefined;
    this.update?.();
  }

  // ------------------------------------------------------------- the image

  private sourceOf(layer: string): string | undefined {
    const spec = this.ctx.viewer.layerSpec(layer)?.source;
    // A source is a string, {url}, or a list of either (the first is the image's).
    const s = Array.isArray(spec) ? spec[0] : spec;
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
    const images: Candidate[] = this.imageLayers()
      .filter((i) => i.time === true && i.readable)
      .map(({ name }) => ({ id: name, label: name, layer: name }));
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

  /** The image layers: whether each shows a time dimension (one in seconds, or named t) and whether the panel can read it. */
  private imageLayers(): ImageLayer[] {
    return this.ctx.viewer
      .layers()
      .filter((l) => l.type === "image")
      .map(({ name }) => {
        const t = this.ctx.viewer.layerTransform(name);
        const time = t === undefined ? undefined : t.input.names.some((n, i) => t.input.units[i] === "s" || n.replace(/['^]$/, "") === "t");
        return { name, time, readable: this.sourceOf(name) !== undefined };
      });
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

  /** Opens the chosen image again (Retry after it could not be read). */
  private reopen(): void {
    this.infoUrl = undefined;
    this.setStatus("");
    void this.refresh();
  }

  /** Reads again the series that could not be read: the pins and the voxel or vertex under the mouse. */
  private retryReads(): void {
    for (const [id, read] of this.pinned) if (read.error !== undefined) this.pinned.delete(id);
    if (this.cursor?.read.error !== undefined) this.cursor = undefined;
    if (this.vertexCursor?.read.error !== undefined) this.vertexCursor = undefined;
    this.setStatus("");
    this.readPins();
    this.readCursor();
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
          this.setStatus(`Could not read ${what}: ${e.message}`, true, () => this.retryReads());
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
   * (within three of the surface's median edge lengths, `vertexReach`),
   * then for that vertex's values at every time
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
      found = nearestOf(await this.ctx.workspace.local.send(surface.store, { series: surface.series.name, nearest: point, within: vertexReach(this.spacings.get(surface.store), t) }));
    } catch (e) {
      if (lookup === this.vertexLookups && this.surface === surface) this.setStatus(`Could not find the vertex under the mouse: ${(e as Error).message}`, true, () => this.retryReads());
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
      this.setStatus(`Could not read ${what}: ${read.error}`, true, () => this.retryReads());
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
      this.setStatus(`Could not read the voxel under the mouse: ${read.error}`, true, () => this.retryReads());
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
      this.ctx.ui.toast("Choose an image with a time axis in the Time series panel first.");
      return;
    }
    // The voxel under the mouse now (the plotted one is read a moment after the mouse moves).
    const voxel = this.cursorVoxel() ?? this.cursor?.voxel ?? voxelAt(map, info, this.position());
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
      if (this.surface === surface) this.setStatus(`Could not reach ${surface.series.name}: ${(e as Error).message}`, true, () => (this.setStatus(""), void this.surfaceTime(surface)));
    }
  }

  /** How far apart a surface's vertices are, and its parcellations: asked of its store once. */
  private readSurfaceExtras(surface: SurfaceStep): void {
    const { store } = surface;
    const series = surface.series.name;
    if (!this.spacings.has(store)) {
      this.ctx.workspace.local.send(store, { series, spacing: true }).then(
        (answer) => {
          const edge = (answer as { medianEdge?: unknown } | undefined)?.medianEdge;
          if (typeof edge === "number" && edge > 0) this.spacings.set(store, edge);
        },
        () => undefined,
      );
    }
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
      this.setStatus(`Could not read ${what}: ${read.error}`, true, () => this.retryReads());
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
      this.setStatus(`Could not show time point ${i}: ${(e as Error).message}`, true, () => (this.setStatus(""), void this.showOnSurface(i)));
    } finally {
      this.surfaceSending = false;
    }
    // Another surface chosen meanwhile: its wanted time point was not sent by this loop.
    const wanted = this.surfaceWanted;
    if (wanted !== undefined && this.surface !== undefined && this.surface !== surface) void this.showOnSurface(wanted);
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
    const name = safeFileName(this.layer() ?? "image", "image");
    downloadBlob(new Blob([seriesCsv(axis, series)], { type: "text/csv" }), `${name}_time_series.csv`);
  }

  // ------------------------------------------------------------- panel

  /**
   * Draws the panel once into `host` and keeps it up to date in place
   * (plugins/README.md, "Building a panel"): the controls are set from the
   * state with `set()`, and the legend and the empty state are `region()`s,
   * so a read, a step or playing never closes an open select.  While a
   * series plays only the time readout, the slider and the plot's marker
   * change (`updateTime`).
   */
  render(host: HTMLElement): Disposer {
    const ctx = this.ctx;
    const hostClass = host.className;
    host.className = `${hostClass} ts-host`.trim();
    const plot = (this.plot = new Plot((i) => this.show(i)));
    const status = statusLine();

    // Nothing to plot: the empty state alone, and why the images there are not offered.
    const empty = region((key: { why: string }) => [
      emptyState("No image with a time axis.", { label: "Open data…", run: () => void ctx.commands.invoke("dataset.add") }),
      key.why ? el("p", { class: "hint" }, key.why) : null,
    ], { class: "ts-empty" });

    // ---- the image, its time, and playing
    const image = select([], "", (v) => this.choose(v), "Image");
    const skipped = region((why: string) => (why ? el("p", { class: "hint" }, why) : null));
    const overlay = button("", () => {
      const layer = this.chosen()?.layer;
      if (layer !== undefined && this.surface !== undefined) ctx.viewer.setSurfaceOverlay(layer, this.surface.series.name);
    });
    const first = iconButton("first", "First time point", () => this.show(0));
    const previous = iconButton("previous", "Previous time point", () => this.step(-1));
    const play = iconButton("play", "Play (Alt+Shift+P)", () => this.toggle());
    const next = iconButton("next", "Next time point", () => this.step(1));
    const last = iconButton("last", "Last time point", () => this.axis && this.show(this.axis.count - 1));
    const rate = select(
      RATES.map((r): [string, string] => [String(r), `${r}/s`]),
      String(this.rate),
      (v) => {
        this.rate = Number(v);
        ctx.settings.set("rate", this.rate);
      },
      "Rate",
    );
    // The slider shows a time point as it is dragged (no undo step) and makes the one let go on a step;
    // drawn again only when the number of time points changes.
    let time: Slider | undefined;
    const timeBox = region((count: number) => {
      time = slider(this.current, { min: 0, max: Math.max(0, count - 1), label: "Time point", disabled: count === 0, oninput: (i) => this.show(i, true), onchange: (i) => this.show(i) });
      return time;
    });
    const readout = el("span", { class: "readout", "aria-live": "off" });
    const loop = checkbox("Loop", this.loop, (on) => {
      this.loop = on;
      ctx.settings.set("loop", on);
    });

    // ---- regions of an image, parcels of a surface
    const regionChoice = select([], "", (v) => (this.region = v), "Region");
    const pinRegion = button("Pin mean", () => this.pinRegion());
    const regions = el("div", { class: "row ts-fill" }, regionChoice, pinRegion);
    const parcellationChoice = select([], "", (v) => {
      this.parcellation = v;
      this.parcel = undefined;
      sync();
    }, "Parcellation");
    const parcelChoice = select([], "", (v) => (this.parcel = Number(v)), "Parcel");
    const pinParcel = button("Pin mean", () => {
      const parcellation = this.chosenParcellation();
      if (parcellation !== undefined && this.parcel !== undefined) this.pinParcel(parcellation, this.parcel);
    });
    const itsParcel = button("Its parcel", () => this.pinItsParcel(), "Alt+Shift+M");
    const parcels = el("div", { class: "stack" }, parcellationChoice, el("div", { class: "row ts-fill" }, parcelChoice, pinParcel, itsParcel));

    const side = el(
      "div",
      { class: "ts-side" },
      field("Image", image, { info: "Move the mouse over the image, or onto a surface, to plot the time course under it. Images with time: a 4-D NIfTI, an OME-Zarr image with a t axis; surfaces: a GIFTI surface opened from this computer with a CIFTI time series (.dtseries.nii) beside it." }),
      skipped,
      overlay,
      el("div", { class: "row" }, first, previous, play, next, last, rate),
      timeBox,
      el("div", { class: "row" }, readout, el("span", { class: "spacer" }), loop),
      regions,
      parcels,
      status,
    );

    // ---- the legend, and what to do with the series plotted
    const legend = region((keys: { colour: string; text: string; pin?: number }[]) =>
      keys.map((k) =>
        el(
          "span",
          { class: "ts-key" },
          swatch(k.colour),
          k.text,
          k.pin === undefined ? null : iconButton("close", `Remove ${k.text}`, () => this.removePin(k.pin!)),
        ),
      ),
      { class: "ts-legend" },
    );
    const change = checkbox(
      "% change",
      this.change,
      (on) => {
        this.change = on;
        ctx.settings.set("change", on);
        this.drawPlot();
      },
      { info: "Each series as its change from its own mean, in percent. Save CSV keeps the values as read." },
    );
    const pin = button("Pin", () => this.pinCursor(), "Alt+P");
    const csv = button("Save CSV", () => this.saveCsv());
    const main = el("div", { class: "ts-main" }, el("div", { class: "ts-head" }, legend, el("div", { class: "row" }, change, pin, csv)), plot.element);
    const body = el("div", { class: "ts" }, side, main);
    host.replaceChildren(body, empty);

    let playing: boolean | undefined;
    /** The play button as play or pause: changed only when playing starts or stops. */
    const showPlaying = () => {
      const now = this.playing !== undefined;
      if (now === playing) return;
      playing = now;
      const label = now ? "Pause (Alt+Shift+P)" : "Play (Alt+Shift+P)";
      play.replaceChildren(icon(now ? "pause" : "play"));
      play.setAttribute("title", label);
      play.setAttribute("aria-label", label);
    };

    // The time shown: the readout, the slider and the plot's marker, nothing else.
    this.updateTime = () => {
      const axis = this.axis;
      if (axis === undefined) {
        readout.replaceChildren();
        return;
      }
      readout.replaceChildren(formatTime(timeOf(axis, this.current), axis.unit.label), " ", el("span", { class: "ts-of" }, `time point ${this.current} of 0–${axis.count - 1}`));
      time?.set(this.current);
      plot.setCurrent(this.current);
    };

    let shownStatus = "";
    /** Brings the panel up to date with the state, the image and the series read. */
    const sync = () => {
      const layer = this.layer();
      const axis = this.axis;
      const ready = axis !== undefined;
      const surface = this.surface;
      // An image's voxels or a surface's vertices are plotted and pinned; regions are the images'.
      const plots = ready && (surface !== undefined || this.info !== undefined);
      const none = this.candidates.length === 0;
      const images = this.imageLayers();
      body.hidden = none;
      empty.hidden = !none;
      empty.update({ why: none ? notRead(images) : "" });
      if (none) return;

      setOptions(image, this.candidates.map((c): [string, string] => [c.id, c.label]), layer ?? "");
      skipped.update(notRead(images, false));
      overlay.hidden = surface === undefined;
      if (surface !== undefined) overlay.textContent = `Show ${surface.series.name} as the overlay`;

      for (const b of [first, previous, play, next, last]) b.disabled = !ready;
      rate.set(String(this.rate));
      timeBox.update(axis?.count ?? 0);
      loop.set(this.loop);

      const regionList = surface === undefined && plots ? this.regions() : [];
      if (!regionList.some((r) => JSON.stringify([r.layer, r.id]) === this.region)) this.region = regionList.length > 0 ? JSON.stringify([regionList[0].layer, regionList[0].id]) : "";
      regions.hidden = regionList.length === 0;
      setOptions(regionChoice, regionList.map((r): [string, string] => [JSON.stringify([r.layer, r.id]), r.label]), this.region);

      const parcellation = surface === undefined ? undefined : this.chosenParcellation();
      parcels.hidden = parcellation === undefined;
      if (parcellation !== undefined) {
        const list = this.surfaceParcellations();
        parcellationChoice.hidden = list.length < 2;
        setOptions(parcellationChoice, list.map((p): [string, string] => [p.name, p.name]), parcellation.name);
        const labels = [...parcellation.labels].sort((a, b) => a.name.localeCompare(b.name));
        if (!labels.some((l) => l.code === this.parcel)) this.parcel = labels[0]?.code;
        setOptions(parcelChoice, labels.map((l): [string, string] => [String(l.code), `${l.name} (${l.vertices})`]), String(this.parcel ?? ""));
      }

      // The status: why the image cannot be plotted, else progress and errors from reading.
      const [text, kind, retry] =
        this.openError !== undefined
          ? [`Could not read ${layer}: ${this.openError}`, "error", () => this.reopen()]
          : this.axisNote !== undefined
            ? [`Time is not shown: ${this.axisNote}.`, "error", undefined]
            : this.info === undefined && surface === undefined
              ? ["Opening…", "progress", undefined]
              : [this.status, this.statusError ? "error" : "progress", this.statusRetry];
      // Set only when it changes, so its Retry button is not made again under the pointer.
      const key = `${kind}|${text}|${retry !== undefined}`;
      if (key !== shownStatus) {
        shownStatus = key;
        if (!text) status.clear();
        else if (kind === "error") status.error(text, retry && { label: "Retry", run: retry });
        else status.progress(text);
      }

      legend.update(this.legendKeys());
      change.set(this.change);
      pin.disabled = csv.disabled = !plots;
      showPlaying();
      this.updateTime?.();
    };
    this.update = sync;
    sync();
    this.drawPlot();
    return () => {
      if (this.update === sync) this.update = undefined;
      this.updateTime = undefined;
      plot.dispose();
      this.plot = undefined;
      host.className = hostClass;
    };
  }

  /** The legend's keys: the series under the mouse, then the pins (removable). */
  private legendKeys(): { colour: string; text: string; pin?: number }[] {
    const keys: { colour: string; text: string; pin?: number }[] = [];
    const under = this.surface === undefined ? undefined : this.vertexCursor;
    if (under !== undefined) {
      const parcellation = this.chosenParcellation();
      const label = parcellation === undefined ? undefined : parcelAt(parcellation, under.vertex);
      const inParcel = label === undefined ? "" : `, in ${label.name}`;
      keys.push({ colour: CURSOR_COLOUR, text: `Mouse: ${vertexLabel(under.vertex)}${inParcel}${under.read.error ? ` (${under.read.error})` : under.read.values === undefined ? " …" : ""}` });
    } else if (this.surface === undefined && this.cursor !== undefined && this.info !== undefined) {
      const coarse = this.cursor.read.coarse;
      keys.push({ colour: CURSOR_COLOUR, text: `Mouse: ${voxelLabel(this.info, this.cursor.voxel)}${coarse !== undefined ? ` (coarse: ${coarse})` : ""}` });
    }
    const layer = this.layer();
    for (const pin of this.saved.pins) {
      if (pin.layer !== layer) continue;
      const read = this.pinned.get(pin.id);
      keys.push({ colour: COLOURS[pin.colour], text: `${pin.label}${read?.error ? ` (${read.error})` : read?.values === undefined ? " …" : ""}`, pin: pin.id });
    }
    return keys;
  }
}

/** A select's options, replaced only when they change (so an open select stays open), and its value. */
function setOptions(s: Settable<HTMLSelectElement, string>, options: [string, string][], value: string): void {
  const key = JSON.stringify(options);
  if (s.getAttribute("data-options") !== key) {
    s.setAttribute("data-options", key);
    s.replaceChildren(...options.map(([v, text]) => el("option", { value: v }, text)));
    s.value = value;
  }
  s.set(value);
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
