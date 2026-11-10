/**
 * The 2-D views' one WebGL context, shared by every Luxar layer.
 *
 * Before, each layer drew its 2-D views in a WebGL2 context of its own, on
 * its canvas over the views; a browser keeps about 16 contexts, so a few
 * layers (more during a store's hand-over) could make it drop
 * Neuroglancer's.  Now one context, on a canvas that is not shown, draws
 * each layer in turn; the layer's drawing is copied at once onto its own
 * canvas over the views, a plain 2-D canvas (no WebGL context), which keeps
 * the layer's own blending with the views below (light added, or laid
 * over) and keeps what it shows until it is drawn again.
 *
 * The context's chunk copies share one budget (`pool`, ./gpu_pool.ts).
 * When the context is lost, every layer's copies go with it (`epoch`
 * changes, and the layers make theirs again); nothing draws until the
 * browser restores it, and then every layer draws again (`onRestored`).
 */
import { Bloom } from "./bloom.js";
import { GpuPool } from "./gpu_pool.js";
import { LightTarget, Renderer } from "./render_gl.js";
import { SplatRenderer } from "./splat_gl.js";

/** GPU memory for every layer's chunk copies in the 2-D views. */
export const POOL_2D_BYTES = 768 * 1024 * 1024;

/** What a layer draws with: the context and the parts made in it, all shared. */
export interface Context2d {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  target: LightTarget;
  bloom: Bloom;
  /** An image's splats (made when first wanted). */
  splats(): SplatRenderer;
}

export class Shared2d {
  readonly canvas: HTMLCanvasElement;
  readonly pool = new GpuPool("2-D", POOL_2D_BYTES);
  private gl: WebGL2RenderingContext | null = null;
  private parts: Omit<Context2d, "gl" | "canvas" | "splats"> | undefined;
  private splatRenderer: SplatRenderer | undefined;
  /** Changes when the context is lost: copies made in it before are gone. */
  epoch = 0;
  /** Lost, and not yet restored: nothing draws. */
  lost = false;
  /** Why it cannot draw (no WebGL2), for the panel. */
  problem: string | undefined;
  private readonly restored = new Set<() => void>();
  private users = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.addEventListener("webglcontextlost", (e) => {
      // Asks the browser to restore it.
      e.preventDefault();
      this.lost = true;
      ++this.epoch;
      this.parts = undefined;
      this.splatRenderer = undefined;
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      for (const f of [...this.restored]) f();
    });
  }

  /** The context and its parts, made the first time; undefined while lost, or without WebGL2. */
  context(): Context2d | undefined {
    if (this.lost) return undefined;
    if (this.gl === null) {
      this.gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: true, stencil: false });
      if (this.gl === null) {
        this.problem = "No WebGL2 for the 2-D views.";
        return undefined;
      }
    }
    const gl = this.gl;
    if (this.parts === undefined) {
      const renderer = new Renderer(gl);
      this.parts = { renderer, target: new LightTarget(gl, renderer.floatTargets), bloom: new Bloom(renderer, renderer.floatTargets) };
    }
    return {
      gl,
      canvas: this.canvas,
      ...this.parts,
      splats: () => (this.splatRenderer ??= new SplatRenderer(gl)),
    };
  }

  /** Calls `f` when the context is restored after a loss. */
  onRestored(f: () => void): () => void {
    this.restored.add(f);
    return () => this.restored.delete(f);
  }

  /** How many layers draw with it (a context per page, however many layers). */
  get layers(): number {
    return this.users;
  }

  /** Whether it has a WebGL context now. */
  get hasContext(): boolean {
    return this.gl !== null;
  }

  private acquired(): void {
    ++this.users;
  }

  /** The last layer has gone: the context is given back to the browser. */
  private released(): void {
    if (--this.users > 0) return;
    this.parts?.target.release();
    this.parts?.bloom.release();
    this.parts?.renderer.dispose();
    this.splatRenderer?.dispose();
    this.parts = undefined;
    this.splatRenderer = undefined;
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
    if (shared === this) shared = undefined;
  }

  /** The page's shared context, for one more layer; `release` when the layer goes. */
  static acquire(): Shared2d {
    shared ??= new Shared2d();
    shared.acquired();
    return shared;
  }

  release(): void {
    this.released();
  }
}

let shared: Shared2d | undefined;

/** The page's shared 2-D context, if a layer has one now (for the tests and the report). */
export function sharedContext2d(): Shared2d | undefined {
  return shared;
}

/**
 * Copies what the shared context just drew onto a layer's own canvas over
 * the views (a 2-D canvas), sized to match: done at once, before the
 * context draws the next layer.
 */
export function copyTo(out: HTMLCanvasElement, from: HTMLCanvasElement): void {
  if (out.width !== from.width || out.height !== from.height) {
    out.width = from.width;
    out.height = from.height;
  }
  const c = out.getContext("2d");
  if (c === null) return;
  c.clearRect(0, 0, out.width, out.height);
  c.drawImage(from, 0, 0);
}
