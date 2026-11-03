/**
 * An image's splats in the 2-D views, in place of Neuroglancer's own
 * drawing of the image (hidden while Luxar draws it: the plugin's
 * `hideLayerDrawing`): each splat cut by the view's section, so a section
 * shows the Gaussians through it (their peak there, their shape in the
 * plane), drawn on a canvas over the views as Luxar's lines are
 * (./view2d.ts).
 *
 * Blocks are chosen per view as the 3-D view chooses them (./chunks.ts), in
 * level 0's voxels, but only those within a slab around the section; the
 * splats come from the same worker and blocks as the 3-D view's
 * (./splat_view.ts), uploaded to this canvas's own context.  Light is added
 * in a float target and tone mapped; the canvas adds it to the views below
 * (lines and other layers still show).
 */
import type { ViewPanelInfo } from "@ngplatform/sdk";
import { selectChunks, type Selection } from "./chunks.js";
import { LightTarget, Renderer } from "./render_gl.js";
import { type GpuSplats, SplatRenderer } from "./splat_gl.js";
import type { SplatView } from "./splat_view.js";
import { CELL } from "./splat_worker.js";
import { COLORMAP_INDEX, rgbOf, TONE_INDEX } from "./style.js";
import { apply, boxInFrustum, type Globals, invertAffine, measurePanel, multiply, rasToPanel, sectionPlane } from "./view_math.js";

/** GPU memory for the 2-D views' splats. */
const GPU_BYTES = 256 * 1024 * 1024;
/**
 * In a section, each cell's Gaussian (moment-matched: σ² = CELL² / 12 voxels²)
 * drawn this much wider in area, its total kept, so neighbouring cells,
 * CELL voxels apart, overlap smoothly (σ about half the spacing).
 */
const WIDEN = 3;
/**
 * Light so that cells of one colour, side by side, add up to that colour:
 * 1 / (2π σ² / CELL²), and 1.4 more as measured (the SRB template's section
 * came out 0.72 of Neuroglancer's drawing of it, evenly from dark to bright:
 * cells are not all full, and those below the worker's threshold are left out).
 */
const SECTION_GAIN = (12 / (2 * Math.PI)) * 1.4;

/** Row-major to column-major. */
const columnMajor = (m: ArrayLike<number>) => Float32Array.from({ length: 16 }, (_, i) => m[4 * (i % 4) + Math.floor(i / 4)]);

export class SplatView2d {
  private readonly overlay: { element: HTMLElement; dispose(): void };
  private readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private renderer: SplatRenderer | undefined;
  private composite: Renderer | undefined;
  private target: LightTarget | undefined;
  private readonly gpu = new Map<string, { splats: GpuSplats; used: number }>();
  private gpuBytes = 0;
  private frame = 0;
  private visible = true;
  private queued = false;
  private readonly offRendered: () => void;
  private readonly offScreenshot: () => void;
  selections: Selection[] = [];
  problem: string | undefined;

  constructor(private readonly view: SplatView) {
    this.overlay = view.ctx.ui.overlay();
    this.canvas = document.createElement("canvas");
    this.canvas.className = "luxar-canvas";
    this.canvas.style.mixBlendMode = "plus-lighter";
    this.overlay.element.append(this.canvas);
    this.offRendered = view.ctx.viewer.onRendered(() => this.schedule());
    this.offScreenshot = view.ctx.ui.screenshotOverlay((context, canvas) => this.paint(context, canvas));
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.renderer = this.composite = this.target = undefined;
      this.gpu.clear();
      this.gpuBytes = 0;
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.gl = null;
      this.schedule();
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.display = visible ? "" : "none";
    this.schedule();
  }

  schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      try {
        this.render();
      } catch (e) {
        this.problem = `2-D views: ${(e as Error).message}`;
      }
    });
  }

  private context(): WebGL2RenderingContext | null {
    if (this.gl === null) {
      this.gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
      if (this.gl === null) {
        this.problem = "No WebGL2 for the 2-D views.";
        return null;
      }
      this.renderer = new SplatRenderer(this.gl);
      this.composite = new Renderer(this.gl);
      this.target = new LightTarget(this.gl, this.composite.floatTargets);
    }
    return this.gl;
  }

  private render(): void {
    const { view } = this;
    const info = view.info;
    const panels = this.visible ? view.ctx.viewer.panels().filter((p) => p.kind === "2d") : [];
    const gl = panels.length > 0 && info !== undefined ? this.context() : this.gl;
    if (gl === null) return;
    const base = this.overlay.element.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(base.width * dpr));
    const height = Math.max(1, Math.round(base.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (info === undefined || panels.length === 0 || this.renderer === undefined) {
      view.want("2d", []);
      return;
    }
    const state = view.ctx.viewer.getState() as { dimensions?: Record<string, [number, string]>; position?: number[] };
    const dims = state.dimensions ?? {};
    const names = Object.keys(dims);
    const globals: Globals = { names, scales: names.map((n) => dims[n][0]), units: names.map((n) => dims[n][1]), position: names.map((_, i) => state.position?.[i] ?? 0) };
    const style = view.style;
    const voxelToRas = columnMajor(info.levels[0].voxelToRas);
    const store = view.storeInfo(info);
    // The slab blocks are read for: wide enough for a cell's Gaussian either side.
    const halfSlab = Math.max(style.slab / 2, 2 * CELL * info.levels[0].voxelSize);
    const target = this.target!;
    if (!target.bind(width, height, null)) {
      this.problem = "This GPU cannot add light up in a float target here.";
      return;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    ++this.frame;
    const selections: Selection[] = [];
    const want: string[][] = [];
    for (const panel of panels) {
      const drawn = this.drawPanel(panel, globals, base, dpr, store, voxelToRas, halfSlab);
      if (drawn === undefined) continue;
      selections.push(drawn);
      want.push(drawn.want);
    }
    gl.disable(gl.SCISSOR_TEST);
    // One list for the worker, the views' in turn.
    const merged: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; want.some((l) => i < l.length); ++i) {
      for (const l of want) {
        const k = l[i];
        if (k !== undefined && !seen.has(k)) {
          seen.add(k);
          merged.push(k);
        }
      }
    }
    view.want("2d", merged);
    this.selections = selections;
    this.evict();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    // Clamped, not tone mapped: a section shows the image's own values, as Neuroglancer's drawing would.
    this.composite!.composite(target.texture!, { color: 0 }, { toneMap: TONE_INDEX.clamp, emission: false, origin: [0, 0] });
    gl.disable(gl.BLEND);
  }

  /** One view's splats: its blocks chosen and drawn into the light target. */
  private drawPanel(panel: ViewPanelInfo, globals: Globals, base: DOMRect, dpr: number, store: ReturnType<SplatView["storeInfo"]>, voxelToRas: Float32Array, halfSlab: number): Selection | undefined {
    const gl = this.gl!;
    const view = this.view;
    const info = view.info!;
    const rect = panel.element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return undefined;
    const rows = measurePanel((p) => panel.project(p), globals.position);
    if (rows === undefined) return undefined;
    const toPanel = rasToPanel(globals, rows);
    const plane = sectionPlane(toPanel);
    if (plane === undefined) return undefined;
    // Pixels to clip space; for choosing blocks, mm from the section to clip depth too.
    const toClip = (depth: boolean) => {
      const m = new Float64Array(16);
      m[0] = 2 / rect.width;
      m[12] = -1;
      m[5] = -2 / rect.height;
      m[13] = 1;
      m[15] = 1;
      if (depth) {
        const n = Math.hypot(toPanel[2], toPanel[6], toPanel[10]);
        m[10] = 0.999 / (n * halfSlab);
      }
      return m;
    };
    const rasToClip = multiply(toClip(false), toPanel);
    const voxelToSlab = multiply(multiply(toClip(true), toPanel), voxelToRas);
    const toVoxel = invertAffine(multiply(toPanel, voxelToRas));
    const centre = toVoxel ? apply(toVoxel, [rect.width / 2, rect.height / 2, 0]).slice(0, 3) : info.levels[0].size.map((s) => s / 2);
    const selection = selectChunks(store, (lo, hi) => boxInFrustum(voxelToSlab, lo, hi), centre, view.style.detail * 1e6, (k) => view.arrived(k));
    const byLevel = new Map<number, GpuSplats[]>();
    for (const key of selection.draw) {
      const gpu = this.upload(key);
      if (gpu === undefined) continue;
      const level = Number(key.split("|")[0]);
      byLevel.set(level, [...(byLevel.get(level) ?? []), gpu]);
    }
    const x = Math.round((rect.left - base.left) * dpr);
    const y = Math.round((base.bottom - rect.bottom) * dpr);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    gl.viewport(x, y, w, h);
    gl.scissor(x, y, w, h);
    const style = view.style;
    for (const splats of byLevel.values()) {
      this.renderer!.draw(splats, {
        modelToClip: Float32Array.from(rasToClip),
        viewport: [w, h],
        gain: 2 ** style.exposure * SECTION_GAIN,
        widen: WIDEN,
        absorption: 0,
        colormap: COLORMAP_INDEX[style.colormap],
        colour: style.colourBy === "solid" ? rgbOf(style.colour) : undefined,
        plane,
      });
    }
    return selection;
  }

  /** A block's splats on this canvas's GPU, uploaded from the view's data the first time. */
  private upload(key: string): GpuSplats | undefined {
    const known = this.gpu.get(key);
    if (known !== undefined) {
      known.used = this.frame;
      return known.splats;
    }
    const data = this.view.blockData(key);
    if (data === undefined || this.renderer === undefined) return undefined;
    const splats = this.renderer.upload(data.centres, data.covariances, data.weights);
    this.gpu.set(key, { splats, used: this.frame });
    this.gpuBytes += splats.bytes;
    return splats;
  }

  private evict(): void {
    if (this.gpuBytes <= GPU_BYTES) return;
    const old = [...this.gpu.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, b] of old) {
      if (this.gpuBytes <= GPU_BYTES * 0.8 || b.used === this.frame) break;
      this.renderer!.release(b.splats);
      this.gpuBytes -= b.splats.bytes;
      this.gpu.delete(key);
    }
  }

  /** Paints the canvas into a screenshot of Neuroglancer's canvas, added as it is on screen. */
  paint(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    if (!this.visible || this.gl === null) return;
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvas.width / Math.max(1, canvasRect.width);
    const base = this.overlay.element.getBoundingClientRect();
    context.save();
    context.globalCompositeOperation = "lighter";
    context.drawImage(this.canvas, (base.left - canvasRect.left) * scale, (base.top - canvasRect.top) * scale, base.width * scale, base.height * scale);
    context.restore();
  }

  dispose(): void {
    this.offScreenshot();
    this.offRendered();
    for (const b of this.gpu.values()) this.renderer?.release(b.splats);
    this.gpu.clear();
    this.target?.release();
    this.renderer?.dispose();
    this.composite?.dispose();
    this.overlay.dispose();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
