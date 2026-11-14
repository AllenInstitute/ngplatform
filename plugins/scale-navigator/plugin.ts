/**
 * The scale navigator: moving between image layers that nest in space (a
 * HiP-CT overview and its zooms).  A breadcrumb and the pyramid level in
 * the status line (./status.ts), a box in the views where each finer layer
 * lies (ctx.views), commands to step coarser and finer.  Everything is
 * read from the layers as they are in the scene (ViewerApi.layerBounds and
 * renderedLevel); the logic is pure, in ./hierarchy.ts.
 */
import type { Disposer, Json, PlatformContext, PluginModule, ViewShapeHandle } from "@ngplatform/sdk";
import { chainAt, coarser, current, estimateLevel, finer, framing, lengthText, nested, voxelOf, type Volume } from "./hierarchy.js";
import { Breadcrumb, LevelChip, type LevelShown } from "./status.js";
import { STYLE } from "./style.js";

/** A zoom box smaller than this on screen (px across) is not drawn. */
const MIN_BOX = 12;

interface Saved {
  boxes: boolean;
}

function readSaved(raw: unknown): Saved {
  const r = (raw ?? {}) as Partial<Saved>;
  return { boxes: r.boxes !== false };
}

/** The global dimensions' names and scales, in the coordinate space's order (the state's `dimensions`). */
function dimensionsOf(raw: unknown): { names: string[]; scales: number[] } {
  const names: string[] = [];
  const scales: number[] = [];
  if (raw !== null && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      names.push(name);
      scales.push(Array.isArray(value) && typeof value[0] === "number" ? value[0] : NaN);
    }
  }
  return { names, scales };
}

class ScaleNavigator {
  private saved: Saved;
  private volumes: Volume[] = [];
  private levels = new Map<string, number[]>();
  private readonly style = document.createElement("style");
  private readonly crumbs: Breadcrumb;
  private readonly chip = new LevelChip();
  private crumbItem: Disposer | undefined;
  private chipItem: Disposer | undefined;
  private readonly boxes = new Map<string, ViewShapeHandle>();
  private readonly toggle: { set(v: boolean): void; dispose(): void };
  private queued = false;
  private chain: Volume[] = [];
  private readonly offs: Disposer[] = [];
  private resize: ResizeObserver | undefined;

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.style.textContent = STYLE;
    document.head.append(this.style);
    this.crumbs = new Breadcrumb((name) => this.frame(name));
    this.toggle = ctx.ui.viewToggle({
      label: "Zoom boxes",
      title: "Boxes where finer image layers lie inside coarser ones; click one to frame it (Scale navigator)",
      value: this.saved.boxes,
      order: 20,
      onChange: (v) => this.write({ boxes: v }),
    });
    const schedule = () => this.schedule();
    this.offs.push(
      ctx.viewer.onLayersChanged(schedule),
      ctx.viewer.onStateChanged(schedule),
      ctx.workspace.onChanged(schedule),
      ctx.state.onChanged(() => {
        this.saved = readSaved(ctx.state.get());
        this.toggle.set(this.saved.boxes);
        this.schedule();
      }),
      // What Neuroglancer draws changes with each frame (a level loads): the chip follows.
      ctx.viewer.onRendered(() => this.showLevel()),
    );
    const onResize = () => this.crumbs.fit();
    window.addEventListener("resize", onResize);
    this.offs.push(() => window.removeEventListener("resize", onResize));
    const { commands } = ctx;
    this.offs.push(
      commands.register("scaleNavigator.coarser", () => this.step(-1)),
      commands.register("scaleNavigator.finer", () => this.step(1)),
      commands.register("scaleNavigator.frame", () => {
        const name = ctx.workspace.selectedLayer();
        if (name !== undefined && this.volumes.some((v) => v.name === name)) this.frame(name);
        else ctx.ui.toast("Select an image layer to frame it.");
      }),
      commands.register("scaleNavigator.boxes", () => this.write({ boxes: !this.saved.boxes })),
    );
    this.schedule();
  }

  dispose(): void {
    this.offs.splice(0).forEach((off) => off());
    this.resize?.disconnect();
    this.crumbItem?.();
    this.chipItem?.();
    for (const box of this.boxes.values()) box.dispose();
    this.boxes.clear();
    this.toggle.dispose();
    this.style.remove();
  }

  private write(patch: Partial<Saved>): void {
    this.saved = { ...this.saved, ...patch };
    this.ctx.state.set(this.saved);
    this.toggle.set(this.saved.boxes);
    this.schedule();
  }

  private part(key: string): unknown {
    const viewer = this.ctx.viewer;
    return viewer.statePart ? viewer.statePart(key) : (viewer.getState() as Json)[key];
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.refresh();
    });
  }

  // -------------------------------------------------------------- reading

  /** The image layers with their boxes, in the layer list's order. */
  private read(): Volume[] {
    const viewer = this.ctx.viewer;
    if (viewer.layerBounds === undefined) return [];
    const { scales } = dimensionsOf(this.part("dimensions"));
    const out: Volume[] = [];
    // Each layer's levels, kept while it is there: a layout without sections (the 3-D view alone,
    // volume rendering) reads none, and the chip goes on from those last read.
    const names = new Set(viewer.layers().map((l) => l.name));
    for (const name of [...this.levels.keys()]) if (!names.has(name)) this.levels.delete(name);
    for (const layer of viewer.layers()) {
      if (layer.type !== "image") continue;
      const b = viewer.layerBounds(layer.name);
      if (b === undefined || !Number.isFinite(voxelOf(b))) continue;
      if (b.levels.length > 0) {
        this.levels.set(
          layer.name,
          b.levels.map((l) => l.voxelSize),
        );
      }
      out.push({ name: layer.name, lower: b.lower, upper: b.upper, voxelSize: b.voxelSize, step: b.voxelSize.map((v, g) => v / scales[g]), visible: layer.visible });
    }
    return out;
  }

  private position(): number[] {
    const p = this.part("position");
    return Array.isArray(p) ? p.map(Number) : [];
  }

  private refresh(): void {
    this.volumes = this.read();
    this.chain = chainAt(this.volumes, this.position());
    this.showChain();
    this.showBoxes();
    this.showLevel();
  }

  // ----------------------------------------------------------- the status line

  private showChain(): void {
    const chain = this.chain;
    if (chain.length === 0) {
      this.crumbItem?.();
      this.crumbItem = undefined;
      return;
    }
    const here = current(chain, this.ctx.workspace.selectedLayer());
    this.crumbs.set(chain.map((v) => ({ name: v.name, voxel: voxelOf(v), current: v === here, visible: v.visible })));
    if (this.crumbItem === undefined) {
      this.crumbItem = this.ctx.ui.statusItem(this.crumbs.element, { order: 50, label: "Scale" });
      // The line's width changes with the window and the left column: fit again then.
      if (this.resize === undefined && typeof ResizeObserver === "function") {
        const line = this.crumbs.element.closest(".dock-head") ?? this.crumbs.element.parentElement?.parentElement;
        if (line) {
          this.resize = new ResizeObserver(() => this.crumbs.fit());
          this.resize.observe(line);
        }
      }
    }
    this.crumbs.fit();
  }

  /** The layer whose level the chip shows: the selected image layer, else the finest shown in the chain. */
  private levelLayer(): Volume | undefined {
    const selected = this.ctx.workspace.selectedLayer();
    return this.volumes.find((v) => v.name === selected) ?? [...this.chain].reverse().find((v) => v.visible);
  }

  /** The chip, in every layout while an image layer is there: its level, or a dash while its levels are not known yet. */
  private showLevel(): void {
    const layer = this.levelLayer();
    if (layer === undefined) {
      this.chipItem?.();
      this.chipItem = undefined;
      return;
    }
    const shown = this.level();
    if (shown === undefined) this.chip.unknown(layer.name);
    else this.chip.set(shown);
    this.chipItem ??= this.ctx.ui.statusItem(this.chip.element, { order: 51, label: "Pyramid level" });
  }

  private level(): LevelShown | undefined {
    const layer = this.levelLayer();
    if (layer === undefined) return undefined;
    const rendered = this.ctx.viewer.renderedLevel?.(layer.name);
    if (rendered !== undefined && rendered.drawn !== undefined) {
      const loading = rendered.wanted !== undefined && rendered.wanted < rendered.drawn ? rendered.wanted : undefined;
      return { index: rendered.drawn, count: rendered.levels.length, voxel: rendered.levels[rendered.drawn], estimated: false, loading, layer: layer.name };
    }
    // Not drawn in a section now: the level Neuroglancer would choose at this zoom.
    const levels = rendered?.levels.length ? rendered.levels : (this.levels.get(layer.name) ?? []);
    const pixelSize = rendered?.pixelSize ?? this.pixelSize();
    const index = estimateLevel(levels, pixelSize, rendered?.renderScaleTarget ?? 1);
    if (index === undefined) return undefined;
    return { index, count: levels.length, voxel: levels[index], estimated: true, layer: layer.name };
  }

  /** A screen pixel in the cross-sections, metres: their zoom times the canonical voxel (the smallest displayed scale). */
  private pixelSize(): number {
    const zoom = Number(this.part("crossSectionScale"));
    const { scales } = dimensionsOf(this.part("dimensions"));
    const shown = this.display().map((d) => scales[d]).filter((s) => s > 0);
    return shown.length === 0 ? NaN : zoom * Math.min(...shown);
  }

  /** The displayed global dimensions (indices): the state's `displayDimensions`, else the first three. */
  private display(): number[] {
    const { names } = dimensionsOf(this.part("dimensions"));
    const raw = this.part("displayDimensions");
    const chosen = Array.isArray(raw) ? raw.map((n) => names.indexOf(String(n))).filter((i) => i !== -1) : [];
    return chosen.length > 0 ? chosen : names.slice(0, 3).map((_, i) => i);
  }

  // ------------------------------------------------------------ zoom boxes

  private showBoxes(): void {
    const wanted = new Map<string, { lower: number[]; upper: number[]; caption: { text: string; value: string } }>();
    if (this.saved.boxes) {
      for (const { volume, within } of nested(this.volumes)) {
        // Over a coarser layer that is shown: where the zoom lies in what is on screen.
        if (!within.some((w) => w.visible)) continue;
        const { value, unit } = lengthText(voxelOf(volume));
        const finite = (x: number) => (Number.isFinite(x) ? x : 0);
        wanted.set(volume.name, { lower: volume.lower.map(finite), upper: volume.upper.map(finite), caption: { text: volume.name, value: `${value}\u2009${unit}` } });
      }
    }
    for (const [name, box] of this.boxes) {
      if (wanted.has(name)) continue;
      box.dispose();
      this.boxes.delete(name);
    }
    for (const [name, spec] of wanted) {
      const box = this.boxes.get(name);
      if (box !== undefined) {
        box.update(spec);
        continue;
      }
      this.boxes.set(
        name,
        this.ctx.views.add({
          id: `zoom:${name}`,
          kind: "box",
          ...spec,
          label: name,
          editable: false,
          minSize: MIN_BOX,
          onClick: () => this.frame(name),
        }),
      );
    }
  }

  // --------------------------------------------------------------- moving

  /** Frames a layer: the views centred on it, zoomed to fit it; it is shown and selected. */
  private frame(name: string): void {
    const volume = this.volumes.find((v) => v.name === name);
    if (volume === undefined) return;
    const { scales } = dimensionsOf(this.part("dimensions"));
    const panels = this.ctx.viewer.panels();
    const sides = (panels.some((p) => p.kind === "2d") ? panels.filter((p) => p.kind === "2d") : panels).map((p) => {
      const r = p.element.getBoundingClientRect();
      return Math.min(r.width, r.height);
    });
    const pixels = sides.length > 0 ? Math.max(160, Math.min(...sides)) : 400;
    const f = framing(volume, scales, this.display(), pixels);
    if (f === undefined) return;
    const position = this.position();
    const next = position.map((x, g) => (Number.isFinite(f.position[g]) ? f.position[g] : x));
    this.ctx.viewer.patchState((ng) => {
      ng.position = next;
      ng.crossSectionScale = f.crossSectionScale;
      ng.projectionScale = f.projectionScale;
    });
    if (!volume.visible) this.ctx.viewer.setLayerVisible(name, true);
    this.ctx.workspace.selectLayer(name);
  }

  /** Frames the next coarser (-1) or finer (1) layer at the position. */
  private step(direction: -1 | 1): void {
    this.volumes = this.read();
    const position = this.position();
    this.chain = chainAt(this.volumes, position);
    const here = current(this.chain, this.ctx.workspace.selectedLayer()) ?? this.volumes.find((v) => v.name === this.ctx.workspace.selectedLayer());
    const to = direction < 0 ? coarser(this.volumes, this.chain, here) : finer(this.volumes, this.chain, here, position);
    if (to === undefined) {
      this.ctx.ui.toast(direction < 0 ? "No coarser layer holds this place." : "No finer layer lies here.");
      return;
    }
    this.frame(to.name);
  }
}

let instance: ScaleNavigator | undefined;

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    instance = new ScaleNavigator(ctx);
  },
  deactivate() {
    instance?.dispose();
    instance = undefined;
  },
};
