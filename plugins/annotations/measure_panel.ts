/**
 * The Measure card: Neuroglancer's own annotation tools draw (a
 * "measurements" layer is made for them, its tool chosen here), and each
 * line, polyline, box and ellipsoid in the scene's annotation layers is
 * listed with its length, area or volume.  A line profile reads an image's
 * values along a line or polyline, shown as a plot and saved as CSV.
 */
import type { Disposer, Json, PlatformContext } from "@ngplatform/sdk";
import { button, downloadBlob, el, emptyState, field, info, region, select, statusLine } from "@ngplatform/sdk/dom";
import { csv } from "@ngplatform/sdk/format";
import { toVoxel } from "./geometry.js";
import { type Measurement, measureAll, powerOf, samplePath, sampleCount } from "./measure.js";
import { linePlot } from "./plot.js";
import { annotationLayers, imagePlacement, rankOf, space, toGlobalOf } from "./scene.js";
import { fileName, fmt, physical } from "./ui.js";
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
  /** Why the last profile could not be read ("" when it could). */
  private profileError = "";
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

  private useTool(tool: string): void {
    useMeasureTool(this.ctx, tool);
  }

  private currentTool(): string | undefined {
    return measureTool(this.ctx);
  }

  private exportCsv(): void {
    const rows: (string | number)[][] = [["layer", "id", "description", "type", "quantity", "value", "unit", "sides_or_radii_mm"]];
    for (const m of this.measurements()) {
      rows.push([m.layer, m.id, m.description, m.type, m.quantity, m.value, ["mm", "mm2", "mm3"][powerOf(m.quantity) - 1], (m.sides ?? []).map((v) => fmt(v, 6)).join(" ")]);
    }
    downloadBlob(new Blob([csv(rows)], { type: "text/csv" }), "measurements.csv");
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

  /** Stops reading the profile. */
  private cancelProfile(): void {
    this.running?.abort();
  }

  private async runProfile(): Promise<void> {
    const lines = this.measurements().filter((m) => m.type === "line" || m.type === "polyline");
    const m = lines.find((l) => `${l.layer}|${l.id}` === this.line) ?? lines[0];
    const image = this.image || readableImages(this.ctx)[0];
    const store = image && layerStore(this.ctx, image);
    if (m === undefined || !image || store === undefined) return;
    this.running?.abort();
    const controller = (this.running = new AbortController());
    this.profileError = "";
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
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") this.profileError = `Could not read the profile: ${(e as Error).message}`;
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
    downloadBlob(new Blob([csv(rows)], { type: "text/csv" }), `${fileName(p.image)}_profile.csv`);
  }

  // -------------------------------------------------------------- panel

  private update: (() => void) | undefined;

  /**
   * Drawn once: the tools, then the measurements and the profile, each a
   * region drawn again only when what it shows changes (moving about
   * changes the state too).
   */
  render(host: HTMLElement): Disposer {
    const tools = el("div", { class: "segmented" });
    const toolButtons = TOOLS.map(([id, label, title]) => {
      const b = el("button", { type: "button", title, onclick: () => this.useTool(id) }, label) as HTMLButtonElement;
      tools.append(b);
      return [id, b] as const;
    });
    const drawLine = { label: "Draw a line", run: () => this.useTool("annotateLine") };
    const table = region((all: Measurement[]) =>
      all.length === 0
        ? emptyState("Nothing measured yet.", drawLine)
        : [
            el(
              "div",
              { class: "an-table-wrap" },
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
                      el("td", { class: "faint" }, m.layer),
                      el("td", { class: "num" }, physical(m.value, powerOf(m.quantity))),
                    ),
                  ),
                ),
              ),
            ),
            el("div", { class: "row" }, button("Save as CSV", () => this.exportCsv(), "Every measurement in a table")),
          ],
      { class: "stack" },
    );
    const status = statusLine();
    const profile = region(() => this.profileView(), { class: "stack" });
    host.append(
      el(
        "div",
        { class: "stack" },
        el("div", { class: "row" }, tools, info("Pick a tool, then Ctrl+click in a view: twice for a line or a box, the centre then the extent for an ellipsoid, points ending with a double-click for a polyline. Pick the tool again to stop. Click a row to go to it.", "About measuring")),
        table,
        el("h4", { class: "section-title" }, "Line profile"),
        profile,
        status,
      ),
    );
    const draw = () => {
      const tool = this.currentTool();
      const all = this.measurements();
      for (const [id, b] of toolButtons) b.setAttribute("aria-pressed", String(tool === id));
      table.update(all);
      const lines = all.filter((m) => m.type === "line" || m.type === "polyline");
      const images = readableImages(this.ctx);
      if (!lines.some((l) => `${l.layer}|${l.id}` === this.line)) this.line = lines[0] ? `${lines[0].layer}|${lines[0].id}` : "";
      if (!images.includes(this.image)) this.image = images[0] ?? "";
      profile.update([lines.map((l) => [l.layer, l.id, l.description, l.value]), images, this.line, this.image, this.method, this.running !== undefined, this.profile?.values.length, this.profile?.label]);
      if (this.running) status.progress("Reading the profile…");
      else if (this.profileError) status.error(this.profileError, { label: "Retry", run: () => void this.runProfile() });
      else status.clear();
    };
    this.update = draw;
    draw();
    const offs = [this.ctx.viewer.onStateChanged(draw), this.ctx.viewer.onLayersChanged(draw)];
    return () => {
      offs.forEach((off) => off());
      this.update = undefined;
    };
  }

  /** The profile's choices (or what is missing for one), and the profile read. */
  private profileView(): HTMLElement[] {
    const all = this.measurements();
    const lines = all.filter((m) => m.type === "line" || m.type === "polyline");
    const images = readableImages(this.ctx);
    if (lines.length === 0) return [emptyState("No line or polyline to profile.", { label: "Draw a line", run: () => this.useTool("annotateLine") })];
    if (images.length === 0) return [emptyState("No image whose voxels can be read (OME-Zarr, NIfTI or precomputed).", { label: "Open data…", run: () => void this.ctx.commands.invoke("dataset.add") })];
    const go = button("Profile", () => void this.runProfile(), "Read the image's values along the line");
    const p = this.profile;
    const outside = p ? Array.from(p.values).filter((v) => !Number.isFinite(v)).length : 0;
    return [
      el(
        "div",
        { class: "grid-2" },
        field("Line", select(lines.map((l) => [`${l.layer}|${l.id}`, `${l.description || TYPE_NAMES[l.type] + " " + l.id.slice(0, 6)} (${physical(l.value)})`]), this.line, (v) => (this.line = v), "Line")),
        field("Image", select(images.map((n) => [n, n]), this.image, (v) => (this.image = v), "Image")),
        field("Sampling", select([["nearest", "Nearest voxel"], ["linear", "Trilinear"]], this.method, (v) => (this.method = v as "nearest" | "linear"), "Sampling")),
        el("div", { class: "row an-end" }, this.running ? button("Cancel", () => this.cancelProfile(), "Stop reading") : go),
      ),
      ...(p
        ? [
            el("p", { class: "muted" }, `${p.label} through ${p.image}: ${p.values.length} samples${outside ? `, ${outside} outside it` : ""}`),
            linePlot(p.distances, p.values, { x: "mm", y: "value" }),
            el("div", { class: "row" }, button("Save profile as CSV", () => this.exportProfile())),
          ]
        : []),
    ];
  }
}

/**
 * The tool Ctrl+click draws with: the measurements layer's, while it is
 * the selected layer (Neuroglancer draws with the selected layer's tool,
 * so with another layer selected the button picks the tool again rather
 * than turning it off).
 */
export function measureTool(ctx: PlatformContext): string | undefined {
  const ng = ctx.viewer.getState() as { layers?: Json[]; selectedLayer?: { layer?: string } };
  if (ng.selectedLayer?.layer !== LAYER) return undefined;
  const t = (ng.layers ?? []).find((l) => l.name === LAYER)?.tool;
  return typeof t === "string" ? t : undefined;
}

/**
 * Picks a drawing tool in the measurements layer (made when there is
 * none), and selects the layer; the tool picked already is put down.
 * Statistics offers it too, for a box to measure in.
 */
export function useMeasureTool(ctx: PlatformContext, tool: string): void {
  const current = measureTool(ctx);
  ctx.viewer.patchState((ng) => {
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
