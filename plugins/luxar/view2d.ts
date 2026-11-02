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
import { GpuChunks, selectChunks, type Selection } from "./chunks.js";
import type { LayerView } from "./layer_view.js";
import { LightTarget, Renderer } from "./render_gl.js";
import { apply, boxInFrustum, coverage, invertAffine, measurePanel, modelToPanel, multiply, pixelsPerUnit } from "./view_math.js";

const GPU_BYTES = 512 * 1024 * 1024;

export class View2d {
  private readonly overlay: { element: HTMLElement; dispose(): void };
  private readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private renderer: Renderer | undefined;
  private chunks: GpuChunks | undefined;
  private target: LightTarget | undefined;
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
      this.renderer = this.chunks = this.target = undefined;
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
    layouts.forEach(({ rect, m }) => {
      const selection = selectChunks(info, (lo, hi) => boxInFrustum(m.modelToClip, lo, hi), m.centre, style.detail * 1e6, (k) => chunks.arrived(k));
      selections.push(selection);
      want.push(selection.want);
      const taken = chunks.take(selection.draw);
      more ||= taken.more;
      if (taken.chunks.length === 0) return;
      const x = Math.round((rect.left - base.left) * dpr);
      const y = Math.round((base.bottom - rect.bottom) * dpr);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      gl.viewport(x, y, w, h);
      gl.scissor(x, y, w, h);
      // Of the chunks' lines, about the slab's share of their depth show.
      const shape = info.levels[selection.level].chunkShape;
      const share = m.slab > 0 ? Math.min(1, (2 * m.slab) / ((shape[0] + shape[1] + shape[2]) / 3)) : 1;
      const cover = coverage(taken.chunks, pixelsPerUnit(m.modelToClip, m.centre, [w, h]), 2 * view.halfWidth, w * h, share);
      const uniforms = view.uniforms(Float32Array.from(m.modelToClip), [w, h], cover);
      uniforms.plane = m.plane;
      uniforms.slab = m.slab;
      renderer.draw(taken.chunks, solid ? "solid" : "accumulate", { color: 0 }, uniforms);
    });
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
    this.selections = selections;
    if (selections.length > 0) {
      const finest = selections.reduce((a, b) => (a.level <= b.level ? a : b));
      view.reportLevel("2d", { ...finest, complete: selections.every((s) => s.complete) });
    }
    if (!solid) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      const emission = style.blending === "emission";
      gl.enable(gl.BLEND);
      if (emission) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFunc(gl.ONE, gl.ONE);
      renderer.composite(target.texture!, { color: 0 }, { toneMap: view.toneIndex, emission, origin: [0, 0] });
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
    this.target?.release();
    this.renderer?.dispose();
    this.overlay.dispose();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
