/**
 * One layer drawn in Luxar's style: its reading worker, its drawing in the
 * 3-D view (./view3d.ts) and over the 2-D views (./view2d.ts), and the
 * uniforms they share from its style.  Only the objects the layer shows are
 * drawn (its chosen segments, or a plugin's temporary set, as Neuroglancer
 * would draw them), and "segment" colours are the layer's segment colours.
 */

/** Tables made by any layer view: each new shading gets a new version. */
let shadingVersions = 0;
import type { Disposer, LayerTransform, PlatformContext } from "@ngplatform/sdk";
import type { Selection } from "./chunks.js";
import { StoreClient } from "./client.js";
import type { DrawUniforms } from "./render_gl.js";
import { needsTable, type ObjectShading } from "./segments.js";
import { COLORMAP_INDEX, COLOUR_INDEX, type LayerStyle, rgbOf, scalarOf, TONE_INDEX } from "./style.js";
import { View2d } from "./view2d.js";
import { View3d } from "./view3d.js";
import { autoGain, directionMatrix, vertexBudget } from "./view_math.js";

export class LayerView {
  readonly client: StoreClient;
  private handle: { redraw(): void; dispose(): void };
  private readonly view3d: View3d;
  private readonly view2d: View2d;
  private readonly levels = new Map<string, Selection>();
  private transformCache: { at: number; value: LayerTransform | undefined } | undefined;
  private readonly offs: Disposer[] = [];
  private shading: (ObjectShading & { segmentColours: boolean; size: number }) | undefined;
  private readonly colours = new Map<bigint, [number, number, number]>();
  /** Per view, the share of what it last drew that showed (a layer's chosen segments). */
  private readonly shares = new Map<string, { version: number; share: number }>();
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
    // What the layer shows, or its colours, changed: tables are made again.
    this.offs.push(
      ctx.viewer.onSegmentsChanged(name, () => {
        this.shading = undefined;
        this.colours.clear();
        this.redraw();
        this.onStatus?.();
      }),
    );
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

  /**
   * The objects the layer shows and their colours: every object, or the
   * chosen segments (`visibleSegments`), each in the layer's colour for it
   * when the style colours by segment.
   */
  objectShading(): ObjectShading {
    const segmentColours = this.style.colourBy === "segment";
    if (this.shading !== undefined && this.shading.segmentColours === segmentColours) return this.shading;
    const visible = this.ctx.viewer.visibleSegments(this.name);
    const { ctx, name, colours } = this;
    const colour = (id: bigint): [number, number, number] => {
      let c = colours.get(id);
      if (c === undefined) {
        c = ctx.viewer.segmentColour(name, id) ?? [1, 1, 1];
        colours.set(id, c);
      }
      return c;
    };
    this.shading = {
      version: ++shadingVersions,
      all: visible === undefined || visible.all,
      has: (id) => visible === undefined || visible.has(id),
      colour: segmentColours ? colour : undefined,
      segmentColours,
      size: visible?.size ?? 0,
    };
    return this.shading;
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
      objectTable: needsTable(this.objectShading()),
    };
  }

  /** The vertices a view reads: the Detail, more when it shows only some of the objects. */
  budget(view: string): number {
    const shading = this.objectShading();
    const known = this.shares.get(view);
    return vertexBudget(this.style.detail, shading.all || known?.version !== shading.version ? 1 : known.share);
  }

  /**
   * The share of what a view drew that showed, for its next budget: the
   * least seen while the layer shows the same objects, so the budget only
   * grows and the level settles rather than going back and forth.
   */
  reportShare(view: string, share: number): void {
    const { version } = this.objectShading();
    const known = this.shares.get(view);
    const old = known?.version === version ? known.share : 1;
    if (share >= old) return;
    this.shares.set(view, { version, share });
    // A new budget may choose another level: draw again.
    if (vertexBudget(1, share) > 1.01 * vertexBudget(1, old)) this.redraw();
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
    // A coarse level of a tractogram is often a sample of its streamlines: say how much of one.
    const share = (level: number) => {
      const s = client.info?.levels[level]?.objectShare;
      return s !== undefined && s < 1 ? `, ${+(s * 100).toPrecision(2)}% of the objects` : "";
    };
    const levels = [...this.levels.entries()].map(([view, s]) => `${view === "3d" ? "3-D" : "2-D"} level ${s.level}${share(s.level)}${s.complete ? "" : " (loading)"}`);
    const parts = [...new Set(levels)];
    const shading = this.objectShading();
    if (!shading.all) parts.unshift(this.shading!.size === 1 ? "1 segment shown" : `${this.shading!.size.toLocaleString()} segments shown`);
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
