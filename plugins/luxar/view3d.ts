/**
 * A layer drawn in Luxar's style in Neuroglancer's 3-D view, through
 * `draw3d`: in Neuroglancer's own frame, with its camera and depth.
 *
 * Light is added up in a float target that shares Neuroglancer's depth
 * buffer, so lines behind what was drawn before them (a solid, a mesh) are
 * hidden, then tone mapped onto the view.  The lines' cores then write
 * depth (and Neuroglancer's depth output, which the pointer's 3-D position
 * reads), so the sections Neuroglancer draws afterwards do not paint over
 * lines in front of them, and do hide lines behind them.  "Solid" draws
 * straight into the view, depth-tested like any opaque layer.
 */
import type { Drawer3d, Frame3d } from "@ngplatform/sdk";
import { SAMPLES } from "./chunk_build.js";
import { GpuChunks, selectChunks, type Selection } from "./chunks.js";
import { samplesFor } from "./objects.js";
import type { LayerView } from "./layer_view.js";
import { Bloom } from "./bloom.js";
import { DepthTarget, type DrawUniforms, type GpuChunk, LightTarget, type Outputs, type Pass, Renderer } from "./render_gl.js";
import { apply, boxInFrustum, coverage, eyeOf, invertAffine, modelTo, multiply, pixelsPerUnit, screenArea, shownShare } from "./view_math.js";

/** GPU memory for one layer's chunks in the 3-D view. */
const GPU_BYTES = 768 * 1024 * 1024;
/** GPU memory for its chosen objects read whole. */
const GPU_SET_BYTES = 512 * 1024 * 1024;

interface SavedState {
  framebuffer: WebGLFramebuffer | null;
  viewport: Int32Array;
  blend: boolean;
  depthTest: boolean;
  depthMask: boolean;
  depthFunc: number;
  stencil: boolean;
  scissor: boolean;
  drawBuffers: number[];
}

export class View3d implements Drawer3d {
  private renderer: Renderer | undefined;
  private chunks: GpuChunks | undefined;
  private sets: GpuChunks | undefined;
  private target: LightTarget | undefined;
  private nearest: DepthTarget | undefined;
  private bloom: Bloom | undefined;
  private broken = false;
  selection: Selection | undefined;
  /** Why it draws nothing, for the panel. */
  problem: string | undefined;

  constructor(private readonly view: LayerView) {}

  isReady(): boolean {
    return (this.selection === undefined || this.selection.complete) && this.view.objectsReady;
  }

  private save(gl: WebGL2RenderingContext): SavedState {
    const drawBuffers: number[] = [];
    for (let i = 0; i < 4; ++i) drawBuffers.push(gl.getParameter(gl.DRAW_BUFFER0 + i) as number);
    while (drawBuffers.length > 1 && drawBuffers[drawBuffers.length - 1] === gl.NONE) drawBuffers.pop();
    return {
      framebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      viewport: gl.getParameter(gl.VIEWPORT),
      blend: gl.isEnabled(gl.BLEND),
      depthTest: gl.isEnabled(gl.DEPTH_TEST),
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
      depthFunc: gl.getParameter(gl.DEPTH_FUNC),
      stencil: gl.isEnabled(gl.STENCIL_TEST),
      scissor: gl.isEnabled(gl.SCISSOR_TEST),
      drawBuffers,
    };
  }

  private restore(gl: WebGL2RenderingContext, s: SavedState): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffer);
    gl.drawBuffers(s.drawBuffers);
    gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]);
    if (s.blend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
    if (s.depthTest) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(s.depthMask);
    gl.depthFunc(s.depthFunc);
    if (s.stencil) gl.enable(gl.STENCIL_TEST);
    else gl.disable(gl.STENCIL_TEST);
    if (s.scissor) gl.enable(gl.SCISSOR_TEST);
    else gl.disable(gl.SCISSOR_TEST);
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.activeTexture(gl.TEXTURE0);
  }

  draw(frame: Frame3d): void {
    const { gl } = frame;
    const { view } = this;
    if (this.renderer?.gl !== gl) {
      this.dispose();
      this.renderer = new Renderer(gl);
      this.target = new LightTarget(gl, this.renderer.floatTargets);
      this.nearest = new DepthTarget(gl);
      this.bloom = new Bloom(this.renderer, this.renderer.floatTargets);
    }
    const info = view.client.info;
    const transform = view.transform();
    if (info === undefined || transform === undefined) return;
    const toDisplay = modelTo(transform, frame.dimensions.names);
    if (toDisplay === undefined) {
      this.problem = `The 3-D view shows ${frame.dimensions.names.join(", ")}, which this layer does not have.`;
      return;
    }
    this.problem = undefined;
    this.chunks ??= new GpuChunks(this.renderer, view.client, GPU_BYTES);
    this.sets ??= new GpuChunks(this.renderer, view.client.objects, GPU_SET_BYTES);
    const chunks = this.chunks;
    const modelToClip = multiply(frame.viewProjection, toDisplay);
    const toModel = invertAffine(toDisplay);
    const centre = toModel ? apply(toModel, frame.position) : [0, 0, 0];
    const style = view.style;
    const drawing = view.drawing();
    let drawn: GpuChunk[] = [];
    let more = false;
    if (drawing.chunks !== undefined) {
      const selection = selectChunks(info, (lo, hi) => boxInFrustum(modelToClip, lo, hi), centre, view.budget("3d"), (k) => chunks.arrived(k));
      this.selection = selection;
      view.client.want("3d", selection.want);
      ({ chunks: drawn, more } = chunks.take(selection.draw, drawing.chunks));
      view.reportLevel("3d", selection);
      if (drawn.length > 0) view.reportShare("3d", shownShare(drawn));
    } else {
      this.selection = undefined;
      view.client.want("3d", []);
    }
    // The chosen objects read whole.
    let sets: GpuChunk[] = [];
    if (drawing.sets !== undefined) {
      const taken = this.sets.take(view.client.objects.drawn(), drawing.sets);
      sets = taken.chunks;
      more ||= taken.more;
    }
    if (more) view.redraw();
    // Held: reading, while the view of the layer's previous store draws.
    if (view.held || (drawn.length === 0 && sets.length === 0)) return;

    const saved = this.save(gl);
    const size: [number, number] = [saved.viewport[2], saved.viewport[3]];
    // Over the part of the view the data can cover, not the whole view: a small brain in a large view is as dense as a large one.
    const ppu = pixelsPerUnit(modelToClip, centre, size);
    const area = screenArea(modelToClip, info.bounds.lower, info.bounds.upper, size);
    const inView = (lo: number[], hi: number[]) => boxInFrustum(modelToClip, lo, hi);
    // More of the chosen objects' lines in view than the Detail: a sample of them, whole.
    const samples = samplesFor(sets, inView, style.detail * 1e6);
    view.reportSamples("3d", sets.length > 0 ? samples : SAMPLES);
    const setCover = coverage(sets, ppu, 2 * view.halfWidth, area, samples / SAMPLES, true);
    const chunkCover = coverage(drawn, ppu, 2 * view.halfWidth, area, 1, true);
    const matrix = Float32Array.from(modelToClip);
    // The chosen objects read whole are dimmed only by their own cover; the chunks (with any faint others) by all.
    const chunkUniforms = view.uniforms(matrix, size, chunkCover + setCover);
    const setUniforms = view.uniforms(matrix, size, setCover);
    // A mesh is lit from the eye.
    chunkUniforms.eye = setUniforms.eye = eyeOf(modelToClip);
    const renderer = this.renderer;
    const drawAll = (pass: Pass, outputs: Outputs, patch: Partial<DrawUniforms> = {}) => {
      if (drawn.length > 0) renderer.draw(drawn, pass, outputs, { ...chunkUniforms, ...patch });
      if (sets.length > 0) renderer.draw(sets, pass, outputs, { ...setUniforms, ...patch }, inView, samples);
    };
    try {
      if (style.blending === "solid" || this.broken) {
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        drawAll("solid", frame.outputs);
        return;
      }
      const depthBuffer = (gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME) ??
        null) as WebGLRenderbuffer | null;
      const [, , width, height] = saved.viewport;
      // Add the light up.
      if (!this.target!.bind(width, height, depthBuffer)) {
        this.broken = true;
        this.problem = "This GPU cannot add light up in a float target here; drawing solid lines instead.";
        return;
      }
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.STENCIL_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.depthMask(false);
      const through = style.blending === "glow-through";
      if (through) gl.disable(gl.DEPTH_TEST);
      else {
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
      }
      drawAll("accumulate", { color: 0 });

      // The nearest line at each pixel, for the depth written below.
      const nearest = this.nearest!;
      if (nearest.bind(width, height)) {
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        drawAll("depth", { color: 0 }, { depthCut: 0.05, depthNear: false });
      }

      // Bloom: the bright light blurred, added by the composite.
      const emission = style.blending === "emission";
      const bloom = style.bloom > 0 ? this.bloom!.run(this.target!.texture!, width, height, emission) : undefined;

      // Tone map it onto the view: colour only.
      gl.enable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);
      gl.viewport(saved.viewport[0], saved.viewport[1], width, height);
      const only = (location: number | undefined) => saved.drawBuffers.map((b, i) => (i === location ? b : gl.NONE));
      gl.drawBuffers(only(frame.outputs.color));
      gl.disable(gl.DEPTH_TEST);
      if (emission) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      renderer.composite(this.target!.texture!, frame.outputs, {
        toneMap: view.toneIndex,
        emission,
        origin: [saved.viewport[0], saved.viewport[1]],
        bloom: bloom && { textures: bloom, amount: style.bloom },
      });

      // Where the lines show, the nearest one's depth goes into
      // Neuroglancer's depth buffer and depth output (with an empty pick
      // id): the sections it draws next then neither paint over lines in
      // front of them nor show through lines behind them.  Faint glow
      // writes none, so a section behind it is not blacked out.
      if (nearest.texture !== undefined) {
        gl.drawBuffers(saved.drawBuffers.map((b, i) => (i === frame.outputs.color ? gl.NONE : b)));
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);
        if (saved.stencil) gl.enable(gl.STENCIL_TEST);
        renderer.composite(this.target!.texture!, frame.outputs, {
          toneMap: view.toneIndex,
          emission,
          origin: [saved.viewport[0], saved.viewport[1]],
          depth: { texture: nearest.texture, cut: 0.15, near: through },
        });
      }
    } finally {
      this.restore(gl, saved);
    }
  }

  dispose(): void {
    this.chunks?.clear();
    this.sets?.clear();
    this.sets = undefined;
    this.target?.release();
    this.nearest?.release();
    this.nearest = undefined;
    this.bloom?.release();
    this.bloom = undefined;
    this.renderer?.dispose();
    this.chunks = undefined;
    this.target = undefined;
    this.renderer = undefined;
  }
}
