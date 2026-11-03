/**
 * An image layer drawn as Gaussian splats in the 3-D view, made from its
 * voxels as they are read (./splats.ts, ./splat_worker.ts): no file is
 * written, and each level of the image's pyramid (a file read in place
 * included) gives its own splats.
 *
 * Levels of detail as for lines (./chunks.ts): the view reads the finest
 * level whose blocks in view hold about the Detail budget of splats, nearest
 * the view's centre first, the coarsest level's blocks first so something
 * shows at once, and coarser blocks standing in until finer ones arrive.
 * Blocks are chosen in level 0's voxels; splats are drawn in RAS
 * millimetres, placed in the view as the volume view places images.
 *
 * Light (and, for emission and absorption, optical depth) is added up in a
 * float target sharing Neuroglancer's depth buffer (so a solid or mesh in
 * front hides splats behind it) and tone mapped onto the view, as the
 * lines' is.
 */
import type { Disposer, Frame3d, PlatformContext } from "@ngplatform/sdk";
import { displayOfRas } from "../volume-view/solid.js";
import { selectChunks, type Selection } from "./chunks.js";
import type { StoreInfo } from "./luxar_worker.js";
import { LightTarget, Renderer } from "./render_gl.js";
import { type GpuSplats, SplatRenderer } from "./splat_gl.js";
import { BLOCK, CELL, type SplatImageInfo } from "./splat_worker.js";
import { COLORMAP_INDEX, type LayerStyle, rgbOf, TONE_INDEX } from "./style.js";
import { apply, boxInFrustum, invertAffine, multiply } from "./view_math.js";

/** GPU memory for one image's splats. */
const GPU_BYTES = 512 * 1024 * 1024;
/** Optical depth of a full-intensity splat of level 0 at Absorption 1 (a coarser level's, by its voxel size). */
const SPLAT_DEPTH = 0.5;
/** In glow, light per splat as a share of that. */
const GLOW = 0.3;
/** Of a level's cells, about this share is taken to hold tissue, for the budget. */
const FILL = 0.3;

/** Row-major (as the volume view keeps matrices) to column-major. */
const columnMajor = (m: ArrayLike<number>) => Float32Array.from({ length: 16 }, (_, i) => m[4 * (i % 4) + Math.floor(i / 4)]);

export class SplatView {
  private readonly worker: Worker;
  info: SplatImageInfo | undefined;
  private error: string | undefined;
  private readonly blocks = new Map<string, { gpu?: GpuSplats; data?: { centres: Float32Array; covariances: Float32Array; weights: Float32Array }; used: number }>();
  private readonly empty = new Set<string>();
  private wanted: string[] = [];
  private renderer: SplatRenderer | undefined;
  private composite: Renderer | undefined;
  private target: LightTarget | undefined;
  private gl: WebGL2RenderingContext | undefined;
  private gpuBytes = 0;
  private frame = 0;
  private selection: Selection | undefined;
  private problem: string | undefined;
  private readonly handle: { redraw(): void; dispose(): void };
  private readonly offs: Disposer[] = [];
  onStatus: (() => void) | undefined;

  constructor(
    readonly ctx: PlatformContext,
    readonly name: string,
    readonly storeUrl: string,
    public style: LayerStyle,
  ) {
    this.worker = new Worker(new URL("./splat_worker.ts", import.meta.url), { type: "module", name: "luxar splats" });
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "opened") this.info = msg.info;
      else if (msg.type === "splats") this.blocks.set(msg.key, { data: msg, used: this.frame });
      else if (msg.type === "empty") this.empty.add(msg.key);
      else if (msg.type === "error") this.error = msg.message;
      this.handle.redraw();
      this.onStatus?.();
    };
    this.worker.postMessage({ type: "open", store: storeUrl });
    this.handle = ctx.viewer.draw3d(name, {
      draw: (frame) => this.draw(frame),
      isReady: () => this.selection === undefined || this.selection.complete,
      afterSections: true,
      dispose: () => this.release(),
    });
  }

  setStyle(style: LayerStyle): void {
    this.style = style;
    this.handle.redraw();
  }

  setVisible(_visible: boolean): void {}

  /** The image's levels as the lines' chunk choice takes them: blocks in level 0's voxels, splats as vertices. */
  private storeInfo(info: SplatImageInfo): StoreInfo {
    const base = info.levels[0];
    const edge = (m: number[], k: number) => Math.hypot(m[k], m[4 + k], m[8 + k]);
    return {
      bounds: { lower: [0, 0, 0], upper: base.size.slice() },
      levels: info.levels.map((l, index) => ({
        index,
        chunkShape: [0, 1, 2].map((k) => BLOCK * (edge(l.voxelToRas, k) / edge(base.voxelToRas, k))),
        vertexCount: Math.round(l.size.reduce((n, s) => n * Math.ceil(s / CELL), 1) * FILL),
      })),
    } as unknown as StoreInfo;
  }

  private release(): void {
    for (const b of this.blocks.values()) if (b.gpu) this.renderer?.release(b.gpu);
    for (const b of this.blocks.values()) b.gpu = undefined;
    this.gpuBytes = 0;
    this.target?.release();
    this.renderer?.dispose();
    this.composite?.dispose();
    this.renderer = this.composite = this.target = undefined;
    this.gl = undefined;
  }

  private draw(frame: Frame3d): void {
    const { gl } = frame;
    const info = this.info;
    if (info === undefined) return;
    if (this.gl !== gl) {
      this.release();
      this.gl = gl;
      this.renderer = new SplatRenderer(gl);
      this.composite = new Renderer(gl);
      this.target = new LightTarget(gl, this.composite.floatTargets);
    }
    const toDisplay = displayOfRas(frame.dimensions);
    if (toDisplay === undefined) {
      this.problem = `The 3-D view shows ${frame.dimensions.names.join(", ")}; splats need x, y and z.`;
      return;
    }
    this.problem = undefined;
    ++this.frame;
    const rasToClip = multiply(frame.viewProjection, columnMajor(toDisplay));
    const voxelToClip = multiply(rasToClip, columnMajor(info.levels[0].voxelToRas));
    const toVoxel = invertAffine(multiply(columnMajor(toDisplay), columnMajor(info.levels[0].voxelToRas)));
    const centre = toVoxel ? apply(toVoxel, frame.position).slice(0, 3) : info.levels[0].size.map((s) => s / 2);
    const store = this.storeInfo(info);
    const arrived = (key: string) => this.blocks.has(key) || this.empty.has(key);
    const selection = selectChunks(store, (lo, hi) => boxInFrustum(voxelToClip, lo, hi), centre, this.style.detail * 1e6, arrived);
    this.selection = selection;
    const wanted = selection.want.filter((k) => !arrived(k));
    if (wanted.join() !== this.wanted.join()) {
      this.wanted = wanted;
      this.worker.postMessage({ type: "want", keys: wanted });
    }
    // By level: a coarser level's splats are larger and fewer along a ray,
    // so each is scaled by its voxels' size against level 0's (coarse blocks
    // standing in for fine ones look about as they will).
    const drawn = new Map<number, GpuSplats[]>();
    for (const key of selection.draw) {
      const b = this.blocks.get(key);
      if (b === undefined) continue;
      b.used = this.frame;
      if (b.gpu === undefined && b.data !== undefined) {
        b.gpu = this.renderer!.upload(b.data.centres, b.data.covariances, b.data.weights);
        this.gpuBytes += b.gpu.bytes;
      }
      if (b.gpu) {
        const level = Number(key.split("|")[0]);
        drawn.set(level, [...(drawn.get(level) ?? []), b.gpu]);
      }
    }
    this.evict();
    this.onStatus?.();
    if (drawn.size === 0) return;

    const saved = {
      framebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
      viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
      drawBuffers: [0, 1, 2, 3].map((i) => gl.getParameter(gl.DRAW_BUFFER0 + i) as number),
      blend: gl.isEnabled(gl.BLEND),
      depthTest: gl.isEnabled(gl.DEPTH_TEST),
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
      depthFunc: gl.getParameter(gl.DEPTH_FUNC) as number,
      stencil: gl.isEnabled(gl.STENCIL_TEST),
    };
    while (saved.drawBuffers.length > 1 && saved.drawBuffers[saved.drawBuffers.length - 1] === gl.NONE) saved.drawBuffers.pop();
    const [x, y, width, height] = saved.viewport;
    try {
      const depth = (gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME) ?? null) as WebGLRenderbuffer | null;
      if (!this.target!.bind(width, height, depth)) {
        this.problem = "This GPU cannot add light up in a float target here.";
        return;
      }
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.STENCIL_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.depthMask(false);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      const style = this.style;
      const emission = style.blending === "emission";
      for (const [level, splats] of drawn) {
        this.renderer!.draw(splats, {
          modelToClip: Float32Array.from(rasToClip),
          viewport: [width, height],
          // Emission and absorption: a splat's light is its colour times its optical depth, so where they
          // pile up the composite's (1 - e^-τ) shows the colour, not a blow-out; glow adds light alone.
          gain: 2 ** style.exposure * SPLAT_DEPTH * (info.levels[level].voxelSize / info.levels[0].voxelSize) * (emission ? Math.max(style.absorption, 0.05) : GLOW),
          absorption: emission ? style.absorption * SPLAT_DEPTH * (info.levels[level].voxelSize / info.levels[0].voxelSize) : 0,
          colormap: COLORMAP_INDEX[style.colormap],
          colour: style.colourBy === "solid" ? rgbOf(style.colour) : undefined,
        });
      }
      // Tone mapped onto the view's colour only.
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);
      gl.viewport(x, y, width, height);
      gl.drawBuffers(saved.drawBuffers.map((b, i) => (i === frame.outputs.color ? b : gl.NONE)));
      gl.disable(gl.DEPTH_TEST);
      if (emission) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.composite!.composite(this.target!.texture!, frame.outputs, { toneMap: TONE_INDEX[style.toneMap], emission, origin: [x, y] });
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);
      gl.drawBuffers(saved.drawBuffers);
      gl.viewport(x, y, width, height);
      if (saved.blend) gl.enable(gl.BLEND);
      else gl.disable(gl.BLEND);
      if (saved.depthTest) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
      gl.depthMask(saved.depthMask);
      gl.depthFunc(saved.depthFunc);
      if (saved.stencil) gl.enable(gl.STENCIL_TEST);
      gl.blendFunc(gl.ONE, gl.ZERO);
    }
  }

  /** Least recently drawn blocks off the GPU (and their data dropped) past the budget. */
  private evict(): void {
    if (this.gpuBytes <= GPU_BYTES) return;
    const old = [...this.blocks.entries()].filter(([, b]) => b.gpu !== undefined).sort((a, b) => a[1].used - b[1].used);
    for (const [key, b] of old) {
      if (this.gpuBytes <= GPU_BYTES * 0.8 || b.used === this.frame) break;
      this.renderer!.release(b.gpu!);
      this.gpuBytes -= b.gpu!.bytes;
      this.blocks.delete(key);
    }
  }

  status(): string {
    if (this.error !== undefined && this.info === undefined) return `Could not open the image: ${this.error}`;
    if (this.info === undefined) return "Opening the image…";
    if (this.problem) return this.problem;
    const s = this.selection;
    if (s === undefined) return "";
    const level = this.info.levels[s.level];
    const size = level.voxelSize >= 0.1 ? `${+level.voxelSize.toFixed(2)} mm` : `${+(level.voxelSize * 1000).toFixed(1)} µm`;
    let splats = 0;
    for (const key of s.draw) splats += this.blocks.get(key)?.data?.weights.length ?? 0;
    return `Splats from level ${s.level} (${size} voxels): ${splats.toLocaleString()} in ${s.draw.length} blocks${s.complete ? "" : `, ${this.wanted.length} blocks to read`}${this.error ? ` · a block failed: ${this.error}` : ""}`;
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.handle.dispose();
    this.worker.terminate();
  }
}

