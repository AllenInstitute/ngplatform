/**
 * A label volume being drawn: the volume in the page, the segmentation
 * layer that shows it (served from the page as an OME-Zarr store), its
 * strokes' history, its labels' names and colours, and the image whose
 * values limit the tools (by default the one whose grid it was made on).
 *
 * After a stroke the layer's data is read again: Neuroglancer drops the
 * chunks it holds from the store and asks for those on screen, which the
 * page answers from memory at once.  Strokes are told a few times a second
 * while they last, and once when they end.
 */
import type { PlatformContext } from "@ngplatform/sdk";
import { between, type Placement, placement } from "../geometry.js";
import { space } from "../scene.js";
import type { ImageLevel, Voxels } from "../voxels.js";
import { History } from "./history.js";
import type { ImageBlock, Vec3 } from "./kernels.js";
import { CHUNK, LabelVolume } from "./label_volume.js";
import { LABEL_STORE_EXTENSION, serveInPage } from "./store_format.js";

/** Distinct colours for labels 1, 2, 3, … (then round again). */
export const PALETTE = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000", "#aaffc3"];

export const colourOf = (value: number) => PALETTE[(value - 1) % PALETTE.length];

export interface Reference {
  layer: string;
  store: string;
  level: number;
  levels: ImageLevel[];
}

let sessions = 0;

export class Session {
  readonly history = new History();
  /** Names and colours of labels, by value. */
  readonly labels = new Map<number, { name: string; colour: string }>();
  layer = "";
  source = "";
  /** The store's http(s) URL, which Neuroglancer's chunk sources name. */
  url = "";
  reference: Reference | undefined;
  /** Voxels of each label (counted a little after strokes stop). */
  counts = new Map<number, number>();
  /** Strokes since the last save. */
  unsaved = 0;
  private readonly unserve: () => void;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRefresh = 0;
  private readonly blocks = new Map<string, Promise<Float32Array>>();
  private blockGeneration = 0;

  private constructor(
    private readonly ctx: PlatformContext,
    private readonly voxels: Voxels,
    readonly volume: LabelVolume,
    readonly fileName: string,
  ) {
    this.unserve = serveInPage(fileName, volume);
  }

  /** Makes the session and shows its layer (named `name`) in the scene. */
  static async open(ctx: PlatformContext, voxels: Voxels, volume: LabelVolume, name: string): Promise<Session> {
    const fileName = `labels-${Date.now().toString(36)}-${++sessions}${LABEL_STORE_EXTENSION}`;
    const session = new Session(ctx, voxels, volume, fileName);
    try {
      const [found] = await ctx.workspace.local.open(new File([], fileName));
      if (found === undefined) throw new Error("local data did not take the label volume");
      session.source = found.source;
      session.url = found.source.replace(/^zarr3:\/\//, "");
      const before = new Set(ctx.viewer.layers().map((l) => l.name));
      // The volume alone: its bounds' outline (a yellow box round the whole grid) is no help when drawing.
      const source = { url: found.source, subsources: { default: true, bounds: false }, enableDefaultSubsources: false };
      ctx.workspace.addDataset({ source, name, kind: "segmentation" });
      session.layer = ctx.viewer.layers().find((l) => !before.has(l.name) && l.sources.some((s) => s.includes(fileName)))?.name ?? name;
    } catch (e) {
      session.unserve();
      throw e;
    }
    return session;
  }

  get name(): string {
    return this.layer;
  }

  /** Where the label volume's voxels are in the global space (once its layer has loaded). */
  placement(): Placement | undefined {
    return placement(this.ctx.viewer.layerTransform(this.layer), this.volume.voxelToRas, space(this.ctx));
  }

  /** The reference level's voxels from the label volume's, when both are placed. */
  referenceAffine(): Float64Array | undefined {
    const r = this.reference;
    const own = this.placement();
    if (r === undefined || own === undefined) return undefined;
    const theirs = placement(this.ctx.viewer.layerTransform(r.layer), r.levels[r.level].voxelToRas, space(this.ctx));
    return theirs && between(own, theirs);
  }

  /** Sets the reference image; its level is the one nearest the label volume's voxel size. */
  setReference(reference: Reference | undefined): void {
    this.reference = reference;
    this.blocks.clear();
    ++this.blockGeneration;
  }

  // ---------------------------------------------------- the image's values

  /**
   * The reference image's values over a box of label voxels, read in blocks
   * of a chunk (kept, a few hundred at most); undefined without a reference.
   */
  async imageBlock(lo: Vec3, hi: Vec3, signal?: AbortSignal): Promise<ImageBlock | undefined> {
    const r = this.reference;
    const affine = this.referenceAffine();
    if (r === undefined || affine === undefined) return undefined;
    const clampedLo = lo.map((v) => Math.max(0, v)) as Vec3;
    const clampedHi = hi.map((v, k) => Math.min(this.volume.size[k], v)) as Vec3;
    const size = clampedHi.map((v, k) => Math.max(0, v - clampedLo[k])) as Vec3;
    const out = new Float32Array(size[0] * size[1] * size[2]).fill(NaN);
    const first = clampedLo.map((v) => Math.floor(v / CHUNK));
    const last = clampedHi.map((v) => Math.ceil(v / CHUNK) - 1);
    const jobs: Promise<void>[] = [];
    for (let cz = first[2]; cz <= last[2]; ++cz) {
      for (let cy = first[1]; cy <= last[1]; ++cy) {
        for (let cx = first[0]; cx <= last[0]; ++cx) {
          jobs.push(
            this.chunkBlock(cx, cy, cz, affine, signal).then((data) => {
              const origin = [cx * CHUNK, cy * CHUNK, cz * CHUNK];
              const from = [0, 1, 2].map((k) => Math.max(origin[k], clampedLo[k]));
              const to = [0, 1, 2].map((k) => Math.min(origin[k] + CHUNK, clampedHi[k]));
              for (let z = from[2]; z < to[2]; ++z) {
                for (let y = from[1]; y < to[1]; ++y) {
                  const src = from[0] - origin[0] + CHUNK * (y - origin[1] + CHUNK * (z - origin[2]));
                  const dst = from[0] - clampedLo[0] + size[0] * (y - clampedLo[1] + size[1] * (z - clampedLo[2]));
                  out.set(data.subarray(src, src + to[0] - from[0]), dst);
                }
              }
            }),
          );
        }
      }
    }
    await Promise.all(jobs);
    return { lo: clampedLo, size, data: out };
  }

  /** One chunk's worth of the image's values (a 64³ block on the label grid). */
  private chunkBlock(cx: number, cy: number, cz: number, affine: Float64Array, signal?: AbortSignal): Promise<Float32Array> {
    const r = this.reference!;
    const key = `${cx}/${cy}/${cz}`;
    let p = this.blocks.get(key);
    if (p === undefined) {
      p = this.voxels.block(r.store, r.level, [cx * CHUNK, cy * CHUNK, cz * CHUNK], [CHUNK, CHUNK, CHUNK], affine, signal);
      this.blocks.set(key, p);
      const generation = this.blockGeneration;
      p.catch(() => {
        if (generation === this.blockGeneration) this.blocks.delete(key);
      });
      // About 256 MB of blocks at most: the oldest go.
      while (this.blocks.size > 256) this.blocks.delete(this.blocks.keys().next().value!);
    }
    return p;
  }

  /** The image's values in one section (or any box), read as one block rather than chunk by chunk: for a fill. */
  async imageBox(lo: Vec3, hi: Vec3, signal?: AbortSignal): Promise<ImageBlock | undefined> {
    const r = this.reference;
    const affine = this.referenceAffine();
    if (r === undefined || affine === undefined) return undefined;
    const a = lo.map((v) => Math.max(0, v)) as Vec3;
    const b = hi.map((v, k) => Math.min(this.volume.size[k], v)) as Vec3;
    const size = b.map((v, k) => Math.max(0, v - a[k])) as Vec3;
    const data = await this.voxels.block(r.store, r.level, a, size, affine, signal);
    return { lo: a, size, data };
  }

  // ---------------------------------------------------- showing changes

  /** Has the layer read its data again: now, or (while drawing) at most a few times a second. */
  refresh(soon = false): void {
    const wait = soon ? Math.max(0, 120 - (performance.now() - this.lastRefresh)) : 0;
    if (this.refreshTimer !== undefined) {
      if (soon) return;
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.lastRefresh = performance.now();
      this.ctx.viewer.reloadData(this.url);
    }, wait);
  }

  /** The label's colour, picked from the palette the first time. */
  colour(value: number): string {
    return this.labels.get(value)?.colour ?? colourOf(value);
  }

  /** Gives the layer the labels' colours (Neuroglancer otherwise picks its own). */
  applyColours(values: number[]): void {
    const wanted: Record<string, string> = {};
    for (const v of values) if (v > 0) wanted[String(v)] = this.colour(v);
    this.ctx.viewer.patchState(
      (ng) => {
        const layer = ((ng.layers as Record<string, unknown>[] | undefined) ?? []).find((l) => l.name === this.layer);
        if (layer === undefined) return;
        const current = (layer.segmentColors as Record<string, string> | undefined) ?? {};
        if (Object.entries(wanted).every(([k, c]) => current[k] === c)) return;
        layer.segmentColors = { ...current, ...wanted };
      },
      { quiet: true },
    );
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.unserve();
    this.ctx.workspace.local.close(this.source);
  }
}
