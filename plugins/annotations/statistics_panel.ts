/**
 * The Statistics section, as Freeview's label statistics: for an image and
 * a region (a box or ellipsoid annotation, a label of a label volume drawn
 * in the Segmentation tab, or a label of a segmentation layer), the voxel
 * count, volume, mean, SD, minimum, maximum and median of the image inside.  The image is read at its finest level whose
 * box around the region fits the memory chosen (as Registration's save
 * chooses a level); each result is a row of a table, saved as CSV.
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import { apply, between, invertOr, multiply, voxelVolume } from "./geometry.js";
import type { AnnotationJson } from "./measure.js";
import { annotationFromGlobal, annotationLayers, imagePlacement, rankOf, toGlobalOf } from "./scene.js";
import type { LabelVolumes } from "../segmentation/editor.js";
import { corners, levelWithin, type Region, type Summary, voxelBox } from "./statistics.js";
import { button, csv, download, el, field, fmt, numberInput, physical, select } from "./ui.js";
import { layerStore, readableImages, type Voxels } from "./voxels.js";

interface Row extends Summary {
  image: string;
  region: string;
  level: number;
  voxelSize: number;
  volume: number;
}

const BUDGETS: [string, string][] = [
  ["64", "64 MB"],
  ["256", "256 MB"],
  ["1024", "1 GB"],
];

export class Statistics {
  private rows: Row[] = [];
  private image = "";
  private region = "";
  /** The label asked for in a segmentation layer (not one drawn here). */
  private segValue = 1;
  private budget = "256";
  private note = "";
  private running: AbortController | undefined;
  private update: (() => void) | undefined;
  /** Label volumes drawn in the Segmentation plugin (none while it is off). */
  private volumes: LabelVolumes = { sessions: [] };

  constructor(
    private readonly ctx: PlatformContext,
    private readonly voxels: Voxels,
  ) {
    void ctx.services.get<LabelVolumes>("segmentation.labelVolumes").then((volumes) => {
      this.volumes = volumes;
      this.update?.();
    });
  }

  dispose(): void {
    this.running?.abort();
  }

  /** Regions to choose from: [key, title]. */
  private regions(): [string, string][] {
    const out: [string, string][] = [];
    for (const layer of annotationLayers(this.ctx)) {
      for (const a of layer.annotations) {
        if (a.type !== "axis_aligned_bounding_box" && a.type !== "ellipsoid") continue;
        out.push([`a|${layer.name}|${a.id}`, `${a.type === "ellipsoid" ? "Ellipsoid" : "Box"} ${a.description || a.id.slice(0, 6)} (${layer.name})`]);
      }
    }
    for (const s of this.volumes.sessions) {
      for (const value of [...s.counts.keys()].sort((a, b) => a - b)) {
        out.push([`l|${s.fileName}|${value}`, `Label ${value}${s.labels.get(value)?.name ? ` ${s.labels.get(value)!.name}` : ""} (${s.layer})`]);
      }
    }
    // Other segmentations whose voxels can be read (an atlas in NIfTI, say): a label chosen by number.
    const drawn = new Set(this.volumes.sessions.map((s) => s.layer));
    for (const layer of readableImages(this.ctx, ["segmentation"])) {
      if (!drawn.has(layer)) out.push([`s|${layer}|`, `A label of ${layer}`]);
    }
    return out;
  }

  private async compute(): Promise<void> {
    const image = this.image;
    const store = layerStore(this.ctx, image);
    const [kind, owner, id] = this.region.split("|");
    if (store === undefined || !owner) return;
    this.running?.abort();
    const controller = (this.running = new AbortController());
    const maxVoxels = (Number(this.budget) * 2 ** 20) / (kind === "s" ? 8 : 4);
    this.setNote("Reading…");
    try {
      const levels = await this.voxels.levels(store);
      const placements = levels.map((l) => imagePlacement(this.ctx, image, l));
      if (placements[0] === undefined) throw new Error(`${image} is not placed in 3-D here`);
      let title = "";
      // For each level: the region's test in its voxels, and the box of voxels it reaches.
      let regionAt: (level: number) => { region: Region; box: { lo: number[]; hi: number[] } | undefined };
      if (kind === "a") {
        const a = annotationLayers(this.ctx).find((l) => l.name === owner)?.annotations.find((x) => x.id === id);
        if (a === undefined) throw new Error("the annotation is gone");
        if (rankOf(a) !== 3) throw new Error("only 3-D annotation layers are measured");
        const fromGlobal = annotationFromGlobal(this.ctx, owner, placements[0].dims);
        if (fromGlobal === undefined) throw new Error(`${owner} and ${image} are not in the same three dimensions`);
        title = `${a.type === "ellipsoid" ? "Ellipsoid" : "Box"} ${a.description || a.id.slice(0, 6)} (${owner})`;
        regionAt = (level) => {
          const affine = multiply(fromGlobal, placements[level]!.voxelToGlobal);
          const toVoxel = invertOr(affine)!;
          const { lo, hi } = extent(a);
          return {
            region: a.type === "ellipsoid" ? { kind: "ellipsoid", affine: Array.from(affine), centre: a.center!, radii: a.radii!.map(Math.abs) } : { kind: "box", affine: Array.from(affine), lo: a.pointA!, hi: a.pointB! },
            box: voxelBox(corners(lo, hi), toVoxel, levels[level].size),
          };
        };
      } else if (kind === "s") {
        const segStore = layerStore(this.ctx, owner);
        if (segStore === undefined) throw new Error(`${owner}'s voxels cannot be read`);
        const segLevels = await this.voxels.levels(segStore);
        const value = this.segValue;
        title = `Label ${value} (${owner})`;
        regionAt = (level) => {
          // The segmentation's level nearest the image's in voxel size.
          let sl = 0;
          segLevels.forEach((l, i) => {
            if (Math.abs(Math.log(l.voxelSize / levels[level].voxelSize)) < Math.abs(Math.log(segLevels[sl].voxelSize / levels[level].voxelSize))) sl = i;
          });
          const segPlaced = imagePlacement(this.ctx, owner, segLevels[sl]);
          const affine = segPlaced && between(placements[level]!, segPlaced);
          if (affine === undefined) throw new Error(`${owner} and ${image} are not in the same three dimensions`);
          // All of the segmentation that overlaps the image.
          const toImage = invertOr(affine)!;
          const edges = corners([-0.5, -0.5, -0.5], segLevels[sl].size.map((n) => n - 0.5)).map((p) => apply(toImage, p));
          return {
            region: { kind: "segmentation", affine: Array.from(affine), store: segStore, level: sl, value },
            box: voxelBox(edges, Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), levels[level].size),
          };
        };
      } else {
        const session = this.volumes.sessions.find((s) => s.fileName === owner);
        const value = Number(id);
        const placed = session?.placement();
        if (session === undefined || placed === undefined) throw new Error("the label volume is gone");
        const box = session.volume.paintedBox(value);
        if (box === undefined) throw new Error(`label ${value} is not painted`);
        const labels = session.volume.dense(box);
        title = `Label ${value}${session.labels.get(value)?.name ? ` ${session.labels.get(value)!.name}` : ""} (${session.layer})`;
        regionAt = (level) => {
          const affine = between(placements[level]!, placed);
          if (affine === undefined) throw new Error(`${session.layer} and ${image} are not in the same three dimensions`);
          // The label box's corners (voxel edges) in the image's voxels.
          const toImage = invertOr(affine)!;
          const lo = box.lo.map((v) => v - 0.5);
          const hi = box.hi.map((v) => v - 0.5);
          return {
            region: { kind: "label", affine: Array.from(affine), labels, origin: box.lo, size: [0, 1, 2].map((k) => box.hi[k] - box.lo[k]), value },
            box: voxelBox(corners(lo, hi).map((p) => apply(toImage, p)), Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), levels[level].size),
          };
        };
      }
      const voxelsOf = (b: { lo: number[]; hi: number[] } | undefined) => (b ? (b.hi[0] - b.lo[0]) * (b.hi[1] - b.lo[1]) * (b.hi[2] - b.lo[2]) : 0);
      const level = levelWithin(levels.length, (l) => (placements[l] ? voxelsOf(regionAt(l).box) : Infinity), maxVoxels);
      const { region, box } = regionAt(level);
      if (box === undefined) throw new Error(`the region is outside ${image}`);
      if (voxelsOf(box) > maxVoxels) throw new Error(`even the coarsest level needs ${Math.round((voxelsOf(box) * 4) / 2 ** 20)} MB: allow more memory`);
      const summary = await this.voxels.stats(store, level, box, region, (done, total) => this.setNote(`Reading: ${Math.round((100 * done) / total)}%`), controller.signal);
      const volume = summary.count * voxelVolume(placements[level]!.voxelToMm);
      this.rows.push({ image, region: title, level, voxelSize: levels[level].voxelSize, volume, ...summary });
      this.setNote(level > 0 ? `Read level ${level} (${physical(levels[level].voxelSize)} voxels), the finest that fits ${this.budget} MB.` : "");
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") this.setNote(`Could not compute: ${(e as Error).message}`);
    } finally {
      if (this.running === controller) this.running = undefined;
      this.update?.();
    }
  }

  private setNote(text: string): void {
    this.note = text;
    this.update?.();
  }

  private exportCsv(): void {
    const head = ["image", "region", "level", "voxel_size_mm", "voxels", "volume_mm3", "mean", "sd", "min", "max", "median"];
    const rows = this.rows.map((r) => [r.image, r.region, r.level, r.voxelSize, r.count, r.volume, r.mean, r.sd, r.min, r.max, r.median]);
    download(new Blob([csv([head, ...rows])], { type: "text/csv" }), "label_statistics.csv");
  }

  render(host: HTMLElement): Disposer {
    let shown = "";
    const draw = (force = false) => {
      const images = readableImages(this.ctx);
      const regions = this.regions();
      const key = JSON.stringify([images, regions, this.rows.length, this.note, this.running !== undefined]);
      if (key === shown && !force) return;
      shown = key;
      if (!images.includes(this.image)) this.image = images[0] ?? "";
      if (!regions.some(([k]) => k === this.region)) this.region = regions[0]?.[0] ?? "";
      const go = button(this.running ? "Reading…" : "Compute", () => void this.compute(), "Statistics of the image in the region", "btn primary small");
      go.disabled = !this.image || !this.region || this.running !== undefined;
      // One card a result: the dock is narrow for eight columns.
      const table = this.rows.length
        ? el(
            "div",
            { class: "an-results" },
            ...this.rows.map((r) =>
              el(
                "div",
                { class: "an-result" },
                el("div", { class: "an-result-head" }, el("span", {}, r.region), el("span", { class: "an-faint" }, `${r.image} · level ${r.level}, ${physical(r.voxelSize)}`)),
                el(
                  "dl",
                  { class: "an-facts" },
                  ...([
                    ["Voxels", r.count.toLocaleString()],
                    ["Volume", physical(r.volume, 3)],
                    ["Median", fmt(r.median)],
                    ["Mean", fmt(r.mean)],
                    ["SD", fmt(r.sd)],
                    ["Range", `${fmt(r.min)} – ${fmt(r.max)}`],
                  ] as [string, string][]).flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]),
                ),
              ),
            ),
          )
        : null;
      host.replaceChildren(
        images.length === 0
          ? el("p", { class: "empty" }, "Add an image whose voxels can be read (OME-Zarr, NIfTI or precomputed).")
          : regions.length === 0
            ? el("p", { class: "empty" }, "Draw a box or an ellipsoid (Measure), or paint a label (Segmentation tab), for a region.")
            : el(
                "div",
                { class: "an-grid2" },
                field("Image", select(images.map((n) => [n, n]), this.image, (v) => (this.image = v), "Image")),
                field("Region", select(regions, this.region, (v) => {
                  this.region = v;
                  draw(true);
                }, "Region")),
                this.region.startsWith("s|") ? field("Label", numberInput(this.segValue, (v) => (this.segValue = Math.round(v)), { step: 1, "aria-label": "Label value" }), "Its number in the segmentation") : "",
                field("Memory", select(BUDGETS, this.budget, (v) => (this.budget = v), "Memory"), "The finest level that fits is read"),
                el("div", { class: "an-end" }, go),
              ),
        table ?? "",
        this.note ? el("p", { class: "an-hint" }, this.note) : "",
        this.rows.length
          ? el(
              "div",
              { class: "an-row" },
              button("Save as CSV", () => this.exportCsv()),
              button("Clear", () => {
                this.rows = [];
                draw(true);
              }),
            )
          : "",
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

/** An annotation's box in its own coordinates. */
function extent(a: AnnotationJson): { lo: number[]; hi: number[] } {
  if (a.type === "ellipsoid") return { lo: a.center!.map((c, k) => c - Math.abs(a.radii![k])), hi: a.center!.map((c, k) => c + Math.abs(a.radii![k])) };
  return { lo: a.pointA!, hi: a.pointB! };
}
