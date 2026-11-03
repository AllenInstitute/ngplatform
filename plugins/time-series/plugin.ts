/**
 * The time series plugin: the Time series tab, with the time course of the
 * voxel under the mouse in an image with a time axis, pinned voxels and
 * region means beside it, playing through time, and the series saved as
 * CSV.
 *
 * Values are read by a worker (./worker.ts) from the image's OME-Zarr
 * store (a NIfTI opened from this computer is one, read in place).  Where
 * a position is in the image, and which time point the views show, come
 * from the layer's transform (./space.ts), so a moved layer reads where it
 * shows.  Pins are kept in the plugin's state (in the link); their values
 * are read again when the link is opened.
 */
import type { Disposer, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { omeZarrUrl } from "../volume-view/sources.js";
import { SeriesClient, type SeriesInfo } from "./client.js";
import { TIME_SERIES_PANEL } from "./manifest.js";
import { Plot, type PlotSeries } from "./plot.js";
import { type AnnotationJson, regionVoxels, shapeOf } from "./region.js";
import {
  COLOURS,
  coordinateOf,
  formatTime,
  freeColour,
  indexAt,
  nextIndex,
  RATES,
  seriesCsv,
  stepIndex,
  type TimeAxis,
  timeAxis,
  timeOf,
  timesOf,
  voxelAt,
  voxelLabel,
} from "./series.js";
import { globalSpace, LayerMap } from "./space.js";

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
.ts-actions { display: flex; gap: 4px; flex: none; }
.ts-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; flex: 1; min-width: 0; min-height: 24px; }
.ts-key { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); white-space: nowrap; }
.ts-key button { border: 0; background: transparent; color: var(--faint); cursor: pointer; padding: 0 2px; font-size: 14px; line-height: 1; }
.ts-key button:hover { color: var(--text); }
.ts-swatch { display: inline-block; width: 12px; height: 2px; vertical-align: middle; }
.ts-plot-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.ts-plot { flex: 1; min-height: 0; width: 100%; display: block; }
.ts-plot .ts-grid { stroke: var(--line); stroke-width: 1; }
.ts-plot .ts-axis { stroke: var(--line-strong); stroke-width: 1; }
.ts-plot .ts-tick { fill: var(--faint); font: 10px var(--mono); }
.ts-plot .ts-line { fill: none; stroke-width: 2; stroke-linejoin: round; }
.ts-plot .ts-now { stroke: var(--warn); stroke-width: 1.5; }
.ts-plot .ts-cross { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 2; }
.ts-plot .ts-dot { stroke: var(--ink-2); stroke-width: 2; }
.ts-plot .ts-hit { cursor: crosshair; }
.ts-readout { flex: none; color: var(--muted); font: 11px/1.5 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

/** A pinned series: a voxel, or the mean over a region drawn in an annotation layer. */
interface Pin {
  id: number;
  /** Its colour, an index into COLOURS. */
  colour: number;
  /** The image layer it was pinned in. */
  layer: string;
  label: string;
  /** The voxel's index along each image axis (the metadata's order). */
  voxel?: number[];
  region?: { layer: string; annotation: string };
}

interface Saved {
  layer?: string;
  pins: Pin[];
}

function readSaved(value: unknown): Saved {
  const v = (value ?? {}) as Partial<Saved>;
  const pins = Array.isArray(v.pins) ? v.pins.filter((p) => typeof p?.id === "number" && typeof p.layer === "string" && (Array.isArray(p.voxel) || p.region !== undefined)) : [];
  return { layer: typeof v.layer === "string" ? v.layer : undefined, pins };
}

/** A series being read or read. */
interface Read {
  key: string;
  values?: Float32Array;
  error?: string;
  controller?: AbortController;
}

/** The colour of the series under the mouse: the docks' text colour, apart from the pins'. */
const CURSOR_COLOUR = "#dedede";

class TimeSeries {
  private saved: Saved;
  private readonly client = new SeriesClient();
  /** Image layers with a time dimension. */
  private candidates: string[] = [];
  private info: SeriesInfo | undefined;
  private infoUrl: string | undefined;
  private openError: string | undefined;
  private map: LayerMap | undefined;
  private axis: TimeAxis | undefined;
  private axisNote: string | undefined;
  private current = 0;
  private cursor: { voxel: number[]; read: Read } | undefined;
  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pinned = new Map<number, Read>();
  private status = "";
  private statusError = false;
  private playing: ReturnType<typeof setTimeout> | undefined;
  private rate: number;
  private loop: boolean;
  private region = "";
  private plot: Plot | undefined;
  private update: (() => void) | undefined;
  private updateTime: (() => void) | undefined;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.rate = ctx.settings.get<number>("rate") ?? 2;
    this.loop = ctx.settings.get<boolean>("loop") ?? true;
    this.offs.push(
      ctx.state.onChanged(() => {
        const next = readSaved(ctx.state.get());
        if (JSON.stringify(next) === JSON.stringify(this.saved)) return;
        this.saved = next;
        void this.refresh();
      }),
      ctx.viewer.onLayersChanged(() => void this.refresh()),
      ctx.viewer.onStateChanged(() => {
        this.placeChanged();
        this.readPins();
      }),
      ctx.viewer.onCursorChanged(() => {
        clearTimeout(this.cursorTimer);
        this.cursorTimer = setTimeout(() => this.readCursor(), 80);
      }),
      () => clearTimeout(this.cursorTimer),
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

  /** Image layers that show a time dimension (one in seconds, or named t). */
  private findCandidates(): string[] {
    return this.ctx.viewer
      .layers()
      .filter((l) => l.type === "image")
      .map((l) => l.name)
      .filter((name) => {
        const t = this.ctx.viewer.layerTransform(name);
        return t !== undefined && t.input.names.some((n, i) => t.input.units[i] === "s" || n.replace(/['^]$/, "") === "t") && this.sourceOf(name) !== undefined;
      });
  }

  /** The layers, the chosen image, and its metadata, after any change to them. */
  private async refresh(): Promise<void> {
    this.candidates = this.findCandidates();
    const layer = this.layer();
    const url = layer === undefined ? undefined : this.sourceOf(layer);
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

  /** The image layer chosen: the saved one when it is still there, else the first with time. */
  private layer(): string | undefined {
    return this.saved.layer !== undefined && this.candidates.includes(this.saved.layer) ? this.saved.layer : this.candidates[0];
  }

  private choose(layer: string): void {
    this.save({ layer });
    void this.refresh();
  }

  /** The layer's map and time axis, and the time point shown, after the state changed. */
  private placeChanged(): void {
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
    const ng = this.ctx.viewer.getState() as { position?: number[] };
    const space = globalSpace(ng);
    const position = ng.position ?? space.names.map(() => 0);
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

  private position(): number[] {
    const ng = this.ctx.viewer.getState() as { position?: number[] };
    return ng.position ?? [];
  }

  // ------------------------------------------------------------- reading

  /** Reads a mean time course into `read`, then redraws. */
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
          read.error = undefined;
          read.controller = undefined;
          this.setStatus("");
          this.drawPlot();
        },
        (e: Error) => {
          if (controller.signal.aborted) return;
          read.controller = undefined;
          read.error = e.message;
          this.setStatus(`Could not read ${what}: ${e.message}`, true);
        },
      );
  }

  /** The voxel under the mouse: its time course, unless it is the one shown. */
  private readCursor(): void {
    const cursor = this.ctx.viewer.cursor();
    const { map, info } = this;
    if (!cursor.active || map === undefined || info === undefined) return;
    // The mouse's position, ordered as the state's dimensions.
    const names = globalSpace(this.ctx.viewer.getState()).names;
    const position = names.map((n) => cursor.position[cursor.names.indexOf(n)] ?? NaN);
    const voxel = voxelAt(map, info, position);
    if (voxel === undefined) return;
    if (this.cursor !== undefined && this.cursor.voxel.join() === voxel.join()) return;
    this.cursor?.read.controller?.abort();
    const read: Read = { key: voxel.join() };
    this.cursor = { voxel, read };
    this.readInto(read, Int32Array.from(voxel), "the voxel under the mouse");
    this.update?.();
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
      if (pin.layer !== layer || this.map === undefined) continue;
      live.add(pin.id);
      const key = this.pinKey(pin);
      const known = this.pinned.get(pin.id);
      if (known?.key === key) continue;
      changed = true;
      known?.controller?.abort();
      const read: Read = { key };
      this.pinned.set(pin.id, read);
      // A pinned voxel already read under the mouse needs no reading again.
      if (pin.voxel !== undefined && this.cursor?.voxel.join() === pin.voxel.join() && this.cursor.read.values !== undefined) {
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

  /** Shows time point `i` in the views. */
  private show(i: number): void {
    const { map, axis } = this;
    if (map === undefined || axis === undefined) return;
    const position = this.position();
    const target = new Array(position.length).fill(NaN);
    target[axis.dim] = coordinateOf(map, axis, position, i);
    this.ctx.viewer.setPosition(target);
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
    if (this.current >= axis.count - 1) this.show(0);
    const tick = () => {
      const next = this.axis === undefined ? undefined : nextIndex(this.current, this.axis.count, this.loop);
      if (next === undefined) {
        this.pause();
        return;
      }
      this.show(next);
      this.playing = setTimeout(tick, 1000 / this.rate);
    };
    this.playing = setTimeout(tick, 1000 / this.rate);
    this.update?.();
  }

  private pause(): void {
    clearTimeout(this.playing);
    if (this.playing === undefined) return;
    this.playing = undefined;
    this.update?.();
  }

  // ------------------------------------------------------------- plot and CSV

  /** The series plotted: the voxel under the mouse, then the pins. */
  private plotted(): (PlotSeries & { id?: number })[] {
    const out: (PlotSeries & { id?: number })[] = [];
    const info = this.info;
    if (this.cursor?.read.values !== undefined && info !== undefined) out.push({ label: `Mouse (${voxelLabel(info, this.cursor.voxel)})`, values: this.cursor.read.values, colour: CURSOR_COLOUR });
    for (const pin of this.saved.pins) {
      const values = this.pinned.get(pin.id)?.values;
      if (pin.layer === this.layer() && values !== undefined) out.push({ id: pin.id, label: pin.label, values, colour: COLOURS[pin.colour] });
    }
    return out;
  }

  private drawPlot(): void {
    const axis = this.axis;
    this.plot?.set({ times: axis ? timesOf(axis) : [], unit: axis?.unit.label ?? "", series: axis ? this.plotted() : [] });
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
      const image = el(
        "select",
        { class: "text-input", "aria-label": "Image", title: "The image plotted", onchange: (e: Event) => this.choose((e.target as HTMLSelectElement).value) },
        ...this.candidates.map((n) => el("option", { value: n, selected: n === layer }, n)),
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
          ? "Open an image with a time axis (a 4-D NIfTI, or OME-Zarr with t) to plot its time courses."
          : this.openError !== undefined
            ? `Could not read ${layer}: ${this.openError}`
            : this.axisNote !== undefined
              ? `Time is not shown: ${this.axisNote}.`
              : this.info === undefined
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
        regions.length > 0 && ready ? el("div", { class: "ts-row ts-region" }, region, el("button", { class: "btn outline small", type: "button", title: "Pin the mean over the region's voxels", onclick: () => this.pinRegion() }, "Pin mean")) : "",
        el("div", { class: `ts-status${this.statusError ? " error" : ""}` }, note || this.status),
      );
      // The legend: every series plotted or pinned, pins removable.
      const keys: Node[] = [];
      if (this.cursor !== undefined && this.info !== undefined) {
        keys.push(el("span", { class: "ts-key" }, swatch(CURSOR_COLOUR), `Mouse: ${voxelLabel(this.info, this.cursor.voxel)}`));
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
        el("button", { class: "btn outline small", type: "button", title: "Pin the voxel under the mouse (Alt+P)", onclick: () => this.pinCursor(), disabled: !ready }, "Pin"),
        el("button", { class: "btn outline small", type: "button", title: "Save the plotted series as CSV", onclick: () => this.saveCsv(), disabled: !ready }, "Save CSV"),
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
    ctx.commands.register("timeSeries.play", () => series.toggle());
    ctx.commands.register("timeSeries.saveCsv", () => series.saveCsv());
    ctx.ui.panel(TIME_SERIES_PANEL, (host) => series.render(host));
  },
};
