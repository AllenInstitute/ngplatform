/**
 * One layer drawn in Luxar's style: its reading worker, its drawing in the
 * 3-D view (./view3d.ts) and over the 2-D views (./view2d.ts), and the
 * uniforms they share from its style.
 */
import type { Disposer, LayerTransform, PlatformContext } from "@ngplatform/sdk";
import type { Selection } from "./chunks.js";
import { StoreClient } from "./client.js";
import type { DrawUniforms } from "./render_gl.js";
import { COLORMAP_INDEX, COLOUR_INDEX, type LayerStyle, rgbOf, scalarOf, TONE_INDEX } from "./style.js";
import { View2d } from "./view2d.js";
import { View3d } from "./view3d.js";
import { autoGain, directionMatrix } from "./view_math.js";

export class LayerView {
  readonly client: StoreClient;
  private handle: { redraw(): void; dispose(): void };
  private readonly view3d: View3d;
  private readonly view2d: View2d;
  private readonly levels = new Map<string, Selection>();
  private transformCache: { at: number; value: LayerTransform | undefined } | undefined;
  private readonly offs: Disposer[] = [];
  /** Called when what the panel shows about this layer changes. */
  onStatus: (() => void) | undefined;

  constructor(
    readonly ctx: PlatformContext,
    readonly name: string,
    readonly storeUrl: string,
    public style: LayerStyle,
  ) {
    this.client = new StoreClient(storeUrl);
    this.client.setScalar(scalarOf(style));
    this.view3d = new View3d(this);
    this.view2d = new View2d(this);
    this.handle = ctx.viewer.draw3d(name, {
      draw: (frame) => this.view3d.draw(frame),
      isReady: () => this.view3d.isReady(),
      afterSections: true,
      dispose: () => this.view3d.dispose(),
    });
    this.client.onChunk = () => {
      this.redraw();
      this.onStatus?.();
    };
    void this.client.ready.then(
      () => {
        this.redraw();
        this.onStatus?.();
      },
      () => this.onStatus?.(),
    );
  }

  setStyle(style: LayerStyle): void {
    this.style = style;
    this.client.setScalar(scalarOf(style));
    this.redraw();
  }

  /** The layer's transform, read once per frame. */
  transform(): LayerTransform | undefined {
    const now = performance.now();
    if (this.transformCache === undefined || now - this.transformCache.at > 8) {
      this.transformCache = { at: now, value: this.ctx.viewer.layerTransform(this.name) };
    }
    return this.transformCache.value;
  }

  redraw(): void {
    this.transformCache = undefined;
    this.handle.redraw();
    this.view2d.schedule();
  }

  get toneIndex(): number {
    return TONE_INDEX[this.style.toneMap];
  }

  /** Half the line width, device pixels. */
  get halfWidth(): number {
    return (this.style.width * (globalThis.devicePixelRatio || 1)) / 2;
  }

  /**
   * The shared uniforms for a draw, given the view's matrix and size and how
   * many times over its lines cover it (see view_math.coverage).
   */
  uniforms(modelToClip: Float32Array, viewport: [number, number], cover: number): DrawUniforms {
    const { style } = this;
    const transform = this.transform();
    const density = style.autoBrightness ? autoGain(cover) : 1;
    const gain = 2 ** style.exposure * density;
    const range = style.range ?? this.client.valueRange ?? [0, 1];
    return {
      modelToClip,
      directions: transform ? directionMatrix(transform) : new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      viewport,
      halfWidth: this.halfWidth,
      sharpness: style.sharpness,
      colourBy: COLOUR_INDEX[style.colourBy],
      colour: rgbOf(style.colour),
      colormap: COLORMAP_INDEX[style.colormap],
      range,
      gain,
      absorption: style.blending === "emission" ? style.absorption * density : 0,
      plane: [0, 0, 0, 0],
      slab: 0,
      depthCut: 0.3,
      depthNear: false,
    };
  }

  /** What a view read and drew, for the panel. */
  reportLevel(view: string, selection: Selection): void {
    const old = this.levels.get(view);
    this.levels.set(view, selection);
    if (old === undefined || old.level !== selection.level || old.complete !== selection.complete) this.onStatus?.();
  }

  /** A line for the panel: the levels drawn and what is loading. */
  status(): string {
    const { client } = this;
    if (client.error !== undefined && client.info === undefined) return `Could not open the store: ${client.error}`;
    if (client.info === undefined) return "Opening the store…";
    const problems = [this.view3d.problem, this.view2d.problem].filter((p) => p !== undefined);
    const levels = [...this.levels.entries()].map(([view, s]) => `${view === "3d" ? "3-D" : "2-D"} level ${s.level}${s.complete ? "" : " (loading)"}`);
    const parts = [...new Set(levels)];
    if (client.pending > 0) parts.push(`${client.pending} chunks to read`);
    if (client.error !== undefined) parts.push(`a chunk failed: ${client.error}`);
    return [...problems, parts.join(" · ")].filter((p) => p).join(" ");
  }

  /** The 2-D views stop drawing when the layer is hidden (the 3-D one stops with the layer). */
  setVisible(visible: boolean): void {
    this.view2d.setVisible(visible);
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.handle.dispose();
    this.view2d.dispose();
    this.client.dispose();
  }
}
