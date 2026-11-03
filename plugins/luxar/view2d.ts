/**
 * A layer drawn in Luxar's style over Neuroglancer's 2-D views: a canvas
 * over the views (the platform's overlay), drawn after each frame of
 * theirs, with each 2-D panel's own camera.
 *
 * A 2-D view shows the lines near its section, as Luxar slices the
 * dimensions it does not show: lines within half the slab's thickness of
 * the section, fading with their distance from it.  A panel's camera is
 * measured through `panels()`' `project` (its map from global positions to
 * pixels and depth is affine), so no more than the SDK gives is needed.
 *
 * Light adds up in a float target over the whole canvas, is tone mapped
 * onto the canvas, and the canvas is blended over the views as light added
 * (CSS `plus-lighter`) for glow, or laid over them for emission and solid.
 */
import type { ViewPanelInfo } from "@ngplatform/sdk";
import { SAMPLES } from "./chunk_build.js";
import { GpuChunks, selectChunks, type Selection } from "./chunks.js";
import { samplesFor } from "./objects.js";
import type { LayerView } from "./layer_view.js";
import { Bloom } from "./bloom.js";
import { type GpuChunk, LightTarget, Renderer } from "./render_gl.js";
import { apply, boxInFrustum, coverage, invertAffine, measurePanel, modelToPanel, multiply, pixelsPerUnit, screenArea, shownShare } from "./view_math.js";

const GPU_BYTES = 512 * 1024 * 1024;
const GPU_SET_BYTES = 384 * 1024 * 1024;

export class View2d {
  private readonly overlay: { element: HTMLElement; dispose(): void };
  private readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private renderer: Renderer | undefined;
  private chunks: GpuChunks | undefined;
  private sets: GpuChunks | undefined;
  private target: LightTarget | undefined;
  private bloom: Bloom | undefined;
  private queued = false;
  private visible = true;
  private readonly offRendered: () => void;
  private readonly offScreenshot: () => void;
  problem: string | undefined;
  selections: Selection[] = [];
  /** What was last drawn, to skip drawing it again. */
  private signature = "";
  private drawnStyle: unknown;
  /** Chunks were left for the next frame. */
  private more = false;

  constructor(private readonly view: LayerView) {
    this.overlay = view.ctx.ui.overlay();
    this.canvas = document.createElement("canvas");
    this.canvas.className = "luxar-canvas";
    this.overlay.element.append(this.canvas);
    this.offRendered = view.ctx.viewer.onRendered(() => this.schedule());
    this.offScreenshot = view.ctx.ui.screenshotOverlay((context, canvas) => this.paint(context, canvas));
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.renderer = this.chunks = this.sets = this.target = this.bloom = undefined;
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
      this.gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: true, stencil: false, preserveDrawingBuffer: true });
      if (this.gl === null) {
        this.problem = "No WebGL2 for the 2-D views.";
        return null;
      }
      this.renderer = new Renderer(this.gl);
      this.target = new LightTarget(this.gl, this.renderer.floatTargets);
      this.chunks = new GpuChunks(this.renderer, this.view.client, GPU_BYTES);
      this.bloom = new Bloom(this.renderer, this.renderer.floatTargets);
    }
    return this.gl;
  }

  /** A 2-D panel's matrices: store coordinates to its clip space, and to mm from its section. */
  private panelMatrices(panel: ViewPanelInfo, globals: { names: string[]; scales: number[]; units: string[]; position: number[] }, width: number, height: number, halfSlab: number) {
    const transform = this.view.transform();
    if (transform === undefined) return undefined;
    const rows = measurePanel((p) => panel.project(p), globals.position);
    if (rows === undefined) return undefined;
    // Millimetres from the section per unit of the view's depth.
    let gradient = 0;
    globals.names.forEach((_, g) => {
      const metres = globals.units[g] === "m" ? globals.scales[g] * 1000 : globals.scales[g];
      gradient += (rows[2][g] / metres) ** 2;
    });
    const mmPerDepth = gradient > 0 ? 1 / Math.sqrt(gradient) : 0;
    const toPanel = modelToPanel(transform, globals.names, rows);
    // Pixels to clip space, and mm from the section to clip depth (the slab spans it).
    const toClip = new Float64Array(16);
    toClip[0] = 2 / width;
    toClip[12] = -1;
    toClip[5] = -2 / height;
    toClip[13] = 1;
    toClip[10] = mmPerDepth > 0 ? (0.999 * mmPerDepth) / halfSlab : 0;
    toClip[15] = 1;
    const modelToClip = multiply(toClip, toPanel);
    const plane: [number, number, number, number] = [toPanel[2] * mmPerDepth, toPanel[6] * mmPerDepth, toPanel[10] * mmPerDepth, toPanel[14] * mmPerDepth];
    const toModel = invertAffine(toPanel);
    const centre = toModel ? apply(toModel, [width / 2, height / 2, 0]) : [0, 0, 0];
    return { modelToClip, plane, centre, slab: mmPerDepth > 0 ? halfSlab : 0 };
  }

  private render(): void {
    const { view } = this;
    const info = view.client.info;
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
    const style = view.style;
    this.canvas.style.mixBlendMode = style.blending === "glow" || style.blending === "glow-through" ? "plus-lighter" : "normal";
    const state = view.ctx.viewer.getState() as { dimensions?: Record<string, [number, string]>; position?: number[] };
    const dims = state.dimensions ?? {};
    const names = Object.keys(dims);
    const globals = { names, scales: names.map((n) => dims[n][0]), units: names.map((n) => dims[n][1]), position: names.map((_, i) => state.position?.[i] ?? 0) };
    const halfSlab = style.slab / 2;
    const layouts = panels.flatMap((panel) => {
      const rect = panel.element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return [];
      const m = this.panelMatrices(panel, globals, rect.width, rect.height, halfSlab);
      return m === undefined ? [] : [{ rect, m }];
    });
    // Neuroglancer draws a frame for many reasons (an image's chunks
    // arriving, say): draw again only when this drawing would change.
    const signature = JSON.stringify([
      width,
      height,
      view.client.arrivals,
      view.client.generation,
      view.client.objects.arrivals,
      view.client.objects.generation,
      view.drawing().version,
      view.held,
      view.budget("2d"),
      info === undefined,
      layouts.map(({ rect, m }) => [rect.left, rect.top, rect.width, rect.height, Array.from(m.modelToClip, (v) => +v.toPrecision(9))]),
    ]);
    if (signature === this.signature && style === this.drawnStyle && !this.more) return;
    this.signature = signature;
    this.drawnStyle = style;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (info === undefined || layouts.length === 0 || this.renderer === undefined) return;
    const solid = style.blending === "solid";
    const renderer = this.renderer;
    const chunks = this.chunks!;
    const target = this.target!;
    if (!solid && !target.bind(width, height, null)) {
      this.problem = "This GPU cannot add light up in a float target here.";
      return;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    if (solid) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
    }
    const selections: Selection[] = [];
    let more = false;
    const want: string[][] = [];
    const budget = view.budget("2d");
    const drawnAll: GpuChunk[] = [];
    const drawing = view.drawing();
    // The chosen objects read whole: the same sets in every panel, each drawing the pieces in its slab.
    let sets: GpuChunk[] = [];
    // The fewest samples of the chosen objects a panel draws, for the panel.
    let fewest = SAMPLES;
    if (drawing.sets !== undefined) {
      this.sets ??= new GpuChunks(renderer, view.client.objects, GPU_SET_BYTES);
      const taken = this.sets.take(view.client.objects.drawn(), drawing.sets);
      sets = taken.chunks;
      more ||= taken.more;
    }
    layouts.forEach(({ rect, m }) => {
      let drawn: GpuChunk[] = [];
      let share = 1;
      if (drawing.chunks !== undefined) {
        const selection = selectChunks(info, (lo, hi) => boxInFrustum(m.modelToClip, lo, hi), m.centre, budget, (k) => chunks.arrived(k));
        selections.push(selection);
        want.push(selection.want);
        const taken = chunks.take(selection.draw, drawing.chunks);
        more ||= taken.more;
        drawn = taken.chunks;
        drawnAll.push(...drawn);
        // Of the chunks' lines, about the slab's share of their depth show.
        const shape = info.levels[selection.level].chunkShape;
        share = m.slab > 0 ? Math.min(1, (2 * m.slab) / ((shape[0] + shape[1] + shape[2]) / 3)) : 1;
      }
      // Held: reading, while the view of the layer's previous store draws.
      if (view.held || (drawn.length === 0 && sets.length === 0)) return;
      const x = Math.round((rect.left - base.left) * dpr);
      const y = Math.round((base.bottom - rect.bottom) * dpr);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      gl.viewport(x, y, w, h);
      gl.scissor(x, y, w, h);
      const ppu = pixelsPerUnit(m.modelToClip, m.centre, [w, h]);
      const area = screenArea(m.modelToClip, info.bounds.lower, info.bounds.upper, [w, h]);
      const inSlab = (lo: number[], hi: number[]) => boxInFrustum(m.modelToClip, lo, hi);
      // More of the chosen objects' lines near the section than the Detail: a sample of them,
      // whole.  The pieces in the slab are thicker than it (half a level-0 chunk): about the
      // slab's share of their lines show.
      const piece = Math.min(...info.levels[0].chunkShape) / 2;
      const slabShare = m.slab > 0 ? Math.min(1, (2 * m.slab) / piece) : 1;
      const samples = sets.length > 0 ? samplesFor(sets, inSlab, (style.detail * 1e6) / slabShare) : SAMPLES;
      fewest = Math.min(fewest, samples);
      // Of a set's lines, about the slab's share of the set's depth show.
      const setCover = sets.reduce((sum, s) => {
        const extent = (s.upper[0] - s.lower[0] + s.upper[1] - s.lower[1] + s.upper[2] - s.lower[2]) / 3;
        const setShare = m.slab > 0 && extent > 0 ? Math.min(1, (2 * m.slab) / extent) : 1;
        return sum + coverage([s], ppu, 2 * view.halfWidth, area, (setShare * samples) / SAMPLES);
      }, 0);
      const chunkCover = coverage(drawn, ppu, 2 * view.halfWidth, area, share);
      const pass = solid ? "solid" : "accumulate";
      const matrix = Float32Array.from(m.modelToClip);
      for (const [list, cover, cull] of [
        [drawn, chunkCover + setCover, undefined],
        [sets, setCover, inSlab],
      ] as const) {
        if (list.length === 0) continue;
        const uniforms = view.uniforms(matrix, [w, h], cover);
        uniforms.plane = m.plane;
        uniforms.slab = m.slab;
        renderer.draw(list as GpuChunk[], pass, { color: 0 }, uniforms, cull, samples);
      }
    });
    view.reportSamples("2d", fewest);
    gl.disable(gl.SCISSOR_TEST);
    // One list for the reader, the panels' in turn.
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
    view.client.want("2d", merged);
    if (drawnAll.length > 0) view.reportShare("2d", shownShare(drawnAll));
    this.selections = selections;
    if (selections.length > 0) {
      const finest = selections.reduce((a, b) => (a.level <= b.level ? a : b));
      view.reportLevel("2d", { ...finest, complete: selections.every((s) => s.complete) });
    }
    if (!solid) {
      const emission = style.blending === "emission";
      // Bloom over the whole canvas (a panel's glow may reach a little into the next).
      const bloom = style.bloom > 0 ? this.bloom!.run(target.texture!, width, height, emission) : undefined;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.enable(gl.BLEND);
      if (emission) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFunc(gl.ONE, gl.ONE);
      renderer.composite(target.texture!, { color: 0 }, { toneMap: view.toneIndex, emission, origin: [0, 0], bloom: bloom && { textures: bloom, amount: style.bloom } });
      gl.disable(gl.BLEND);
    }
    this.more = more;
    if (more) this.schedule();
  }

  /** Paints the canvas into a screenshot of Neuroglancer's canvas, blended as it is on screen. */
  paint(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    if (!this.visible || this.gl === null) return;
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvas.width / Math.max(1, canvasRect.width);
    const base = this.overlay.element.getBoundingClientRect();
    context.save();
    context.globalCompositeOperation = this.canvas.style.mixBlendMode === "plus-lighter" ? "lighter" : "source-over";
    context.drawImage(this.canvas, (base.left - canvasRect.left) * scale, (base.top - canvasRect.top) * scale, base.width * scale, base.height * scale);
    context.restore();
  }

  dispose(): void {
    this.offScreenshot();
    this.offRendered();
    this.chunks?.clear();
    this.sets?.clear();
    this.target?.release();
    this.bloom?.release();
    this.renderer?.dispose();
    this.overlay.dispose();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
