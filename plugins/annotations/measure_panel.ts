/**
 * The Measure section: Neuroglancer's own annotation tools draw (a
 * "measurements" layer is made for them, its tool chosen here), and each
 * line, polyline, box and ellipsoid in the scene's annotation layers is
 * listed with its length, area or volume.  A line profile reads an image's
 * values along a line or polyline, shown as a plot and saved as CSV.
 */
import type { Disposer, Json, PlatformContext } from "@ngplatform/sdk";
import { toVoxel } from "./geometry.js";
import { type Measurement, measureAll, powerOf, samplePath, sampleCount } from "./measure.js";
import { linePlot } from "./plot.js";
import { annotationLayers, imagePlacement, rankOf, space, toGlobalOf } from "./scene.js";
import { button, csv, download, el, fileName, fmt, physical, select } from "./ui.js";
import { layerStore, readableImages, type Voxels } from "./voxels.js";

const LAYER = "measurements";

const TOOLS: [string, string, string][] = [
  ["annotateLine", "Line", "Click twice in a view: a length"],
  ["annotatePolyline", "Polyline", "Click points, double-click to finish: a length along them"],
  ["annotateBoundingBox", "Box", "Click two corners in a section: an area (a volume if the corners are in different sections)"],
  ["annotateSphere", "Ellipsoid", "Click the centre, then the extent: an area in a section"],
];

const TYPE_NAMES: Record<string, string> = { line: "Line", polyline: "Polyline", axis_aligned_bounding_box: "Box", ellipsoid: "Ellipsoid" };

interface Profile {
  label: string;
  image: string;
  level: number;
  voxelSize: number;
  distances: number[];
  values: Float64Array;
  positions: number[][];
  voxels: number[][];
}

export class Measure {
  private profile: Profile | undefined;
  private profileNote = "";
  private running: AbortController | undefined;
  /** Choices for the profile, this visit. */
  private line = "";
  private image = "";
  private method: "nearest" | "linear" = "nearest";

  constructor(
    private readonly ctx: PlatformContext,
    private readonly voxels: Voxels,
  ) {
    ctx.commands.register("annotations.exportMeasurements", () => this.exportCsv());
  }

  dispose(): void {
    this.running?.abort();
  }

  measurements(): Measurement[] {
    return measureAll(annotationLayers(this.ctx), (layer, rank) => toGlobalOf(this.ctx, layer, rank), space(this.ctx));
  }

  /** Picks a drawing tool in the measurements layer (made when there is none), and selects the layer. */
  private useTool(tool: string): void {
    const current = this.currentTool();
    this.ctx.viewer.patchState((ng) => {
      const layers = ((ng.layers as Json[] | undefined) ?? []).slice();
      let layer = layers.find((l) => l.name === LAYER);
      if (layer === undefined) {
        layer = { type: "annotation", source: "local://annotations", name: LAYER, annotationColor: "#ffd166", annotations: [] };
        layers.push(layer);
      }
      if (current === tool) delete layer.tool;
      else layer.tool = tool;
      ng.layers = layers;
      ng.selectedLayer = { ...((ng.selectedLayer as Json | undefined) ?? {}), layer: LAYER };
    });
  }

  /**
   * The tool Ctrl+click draws with: the measurements layer's, while it is
   * the selected layer (Neuroglancer draws with the selected layer's tool,
   * so with another layer selected the button picks the tool again rather
   * than turning it off).
   */
  private currentTool(): string | undefined {
    const ng = this.ctx.viewer.getState() as { layers?: Json[]; selectedLayer?: { layer?: string } };
    if (ng.selectedLayer?.layer !== LAYER) return undefined;
    const t = (ng.layers ?? []).find((l) => l.name === LAYER)?.tool;
    return typeof t === "string" ? t : undefined;
  }

  private exportCsv(): void {
    const rows: (string | number)[][] = [["layer", "id", "description", "type", "quantity", "value", "unit", "sides_or_radii_mm"]];
    for (const m of this.measurements()) {
      rows.push([m.layer, m.id, m.description, m.type, m.quantity, m.value, ["mm", "mm2", "mm3"][powerOf(m.quantity) - 1], (m.sides ?? []).map((v) => fmt(v, 6)).join(" ")]);
    }
    download(new Blob([csv(rows)], { type: "text/csv" }), "measurements.csv");
  }

  /** Moves the views to an annotation. */
  private goTo(m: Measurement): void {
    const layer = annotationLayers(this.ctx).find((l) => l.name === m.layer);
    const a = layer?.annotations.find((x) => x.id === m.id);
    if (a === undefined) return;
    const toGlobal = toGlobalOf(this.ctx, m.layer, rankOf(a));
    const points = a.points ?? (a.pointA && a.pointB ? [a.pointA, a.pointB] : a.center ? [a.center] : []);
    if (points.length === 0) return;
    const g = points.map(toGlobal);
    this.ctx.viewer.setPosition(g[0].map((_, i) => g.reduce((s, p) => s + p[i], 0) / g.length));
  }

  // ------------------------------------------------------------ profile

  private async runProfile(): Promise<void> {
    const lines = this.measurements().filter((m) => m.type === "line" || m.type === "polyline");
    const m = lines.find((l) => `${l.layer}|${l.id}` === this.line) ?? lines[0];
    const image = this.image || readableImages(this.ctx)[0];
    const store = image && layerStore(this.ctx, image);
    if (m === undefined || !image || store === undefined) return;
    this.running?.abort();
    const controller = (this.running = new AbortController());
    this.profileNote = "Reading…";
    this.update?.();
    try {
      const a = annotationLayers(this.ctx).find((l) => l.name === m.layer)?.annotations.find((x) => x.id === m.id);
      if (a === undefined) throw new Error("the line is gone");
      const toGlobal = toGlobalOf(this.ctx, m.layer, rankOf(a));
      const path = (a.points ?? [a.pointA!, a.pointB!]).map(toGlobal);
      // The scene's position fills dimensions the annotation does not have.
      const position = ((this.ctx.viewer.getState() as { position?: number[] }).position ?? []) as number[];
      const full = path.map((p) => p.map((v, i) => (Number.isFinite(v) ? v : (position[i] ?? 0))));
      const levels = await this.voxels.levels(store);
      const level = 0;
      const placed = imagePlacement(this.ctx, image, levels[level]);
      if (placed === undefined) throw new Error(`${image} is not placed in 3-D here`);
      const n = sampleCount(m.value, levels[level].voxelSize / (this.method === "linear" ? 2 : 1));
      const { positions, distances } = samplePath(full, n, space(this.ctx));
      const voxels = positions.map((p) => toVoxel(placed, p));
      const values = await this.voxels.points(store, level, Float64Array.from(voxels.flat()), this.method, controller.signal);
      this.profile = { label: m.description || `${TYPE_NAMES[m.type]} ${m.id.slice(0, 6)}`, image, level, voxelSize: levels[level].voxelSize, distances, values, positions, voxels };
      const outside = Array.from(values).filter((v) => !Number.isFinite(v)).length;
      this.profileNote = `${values.length} samples of ${image}${outside ? `; ${outside} outside it` : ""}.`;
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") this.profileNote = `Could not read the profile: ${(e as Error).message}`;
    } finally {
      if (this.running === controller) this.running = undefined;
      this.update?.();
    }
  }

  private exportProfile(): void {
    const p = this.profile;
    if (p === undefined) return;
    const names = space(this.ctx).names;
    const rows: (string | number)[][] = [["distance_mm", ...names.map((n) => `global_${n}`), "voxel_x", "voxel_y", "voxel_z", "value"]];
    p.distances.forEach((d, i) => rows.push([d, ...p.positions[i], ...p.voxels[i].map((v) => Number(v.toFixed(3))), p.values[i]]));
    download(new Blob([csv(rows)], { type: "text/csv" }), `${fileName(p.image)}_profile.csv`);
  }

  // -------------------------------------------------------------- panel

  private update: (() => void) | undefined;

  render(host: HTMLElement): Disposer {
    const tools = el("div", { class: "segmented an-tools" });
    const toolButtons = TOOLS.map(([id, label, title]) => {
      const b = el("button", { type: "button", title, onclick: () => this.useTool(id) }, label) as HTMLButtonElement;
      tools.append(b);
      return [id, b] as const;
    });
    const table = el("div", { class: "an-table-wrap" });
    const profile = el("div", { class: "an-profile" });
    host.append(
      el("div", { class: "an-row" }, tools),
      el("p", { class: "an-hint", title: "Twice for a line or box; the centre then the extent for an ellipsoid; points ending with a double-click for a polyline. Pick the tool again to stop." }, "Pick a tool, then Ctrl+click in a view. Click a row to go to it."),
      table,
      el("div", { class: "an-row" }, button("Save as CSV", () => this.exportCsv(), "Every measurement in a table")),
      el("h4", { class: "an-sub" }, "Line profile"),
      profile,
    );
    let shown = "";
    const draw = (force = false) => {
      const tool = this.currentTool();
      const all = this.measurements();
      const images = readableImages(this.ctx);
      // Moving about changes the state too: redraw only when what is shown changes.
      const key = JSON.stringify([tool, all, images, this.line, this.image, this.method, this.running !== undefined, this.profileNote, this.profile?.values.length]);
      if (key === shown && !force) return;
      shown = key;
      for (const [id, b] of toolButtons) b.setAttribute("aria-pressed", String(tool === id));
      if (all.length === 0) {
        table.replaceChildren(el("p", { class: "empty" }, "Nothing measured yet."));
      } else {
        table.replaceChildren(
          el(
            "table",
            { class: "an-table" },
            el("thead", {}, el("tr", {}, el("th", {}, "Annotation"), el("th", {}, "Layer"), el("th", { class: "num" }, "Size"))),
            el(
              "tbody",
              {},
              ...all.map((m) =>
                el(
                  "tr",
                  { class: "an-click", title: `${TYPE_NAMES[m.type]}${m.sides ? `: ${m.sides.map((s) => physical(s)).join(" × ")}` : ""}`, onclick: () => this.goTo(m) },
                  el("td", {}, m.description || `${TYPE_NAMES[m.type]} ${m.id.slice(0, 6)}`),
                  el("td", { class: "an-faint" }, m.layer),
                  el("td", { class: "num" }, physical(m.value, powerOf(m.quantity))),
                ),
              ),
            ),
          ),
        );
      }
      // The profile's choices.
      const lines = all.filter((m) => m.type === "line" || m.type === "polyline");
      if (!lines.some((l) => `${l.layer}|${l.id}` === this.line)) this.line = lines[0] ? `${lines[0].layer}|${lines[0].id}` : "";
      if (!images.includes(this.image)) this.image = images[0] ?? "";
      const lineSelect = select(lines.map((l) => [`${l.layer}|${l.id}`, `${l.description || TYPE_NAMES[l.type] + " " + l.id.slice(0, 6)} (${physical(l.value)})`]), this.line, (v) => (this.line = v), "Line");
      const imageSelect = select(images.map((n) => [n, n]), this.image, (v) => (this.image = v), "Image");
      const methodSelect = select([["nearest", "Nearest voxel"], ["linear", "Trilinear"]], this.method, (v) => (this.method = v as "nearest" | "linear"), "Sampling");
      const go = button(this.running ? "Reading…" : "Profile", () => void this.runProfile(), "Read the image's values along the line");
      go.disabled = lines.length === 0 || images.length === 0 || this.running !== undefined;
      const p = this.profile;
      profile.replaceChildren(
        lines.length === 0 || images.length === 0
          ? el("p", { class: "empty" }, lines.length === 0 ? "Draw a line or polyline to profile." : "No image whose voxels can be read (OME-Zarr, NIfTI or precomputed).")
          : el("div", { class: "an-grid2" }, lineSelect, imageSelect, methodSelect, go),
        p ? el("p", { class: "an-caption" }, `${p.label} through ${p.image}`) : "",
        p ? linePlot(p.distances, p.values, { x: "mm", y: "value" }) : "",
        this.profileNote ? el("p", { class: "an-hint" }, this.profileNote) : "",
        p ? el("div", { class: "an-row" }, button("Save profile as CSV", () => this.exportProfile())) : "",
      );
    };
    this.update = () => draw(true);
    draw();
    const offs = [this.ctx.viewer.onStateChanged(() => draw()), this.ctx.viewer.onLayersChanged(() => draw())];
    return () => {
      offs.forEach((off) => off());
      this.update = undefined;
    };
  }
}
