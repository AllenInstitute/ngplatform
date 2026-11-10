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
import { type ObjectPlan, objectPlan } from "./objects.js";
import type { DrawUniforms } from "./render_gl.js";
import type { AuthHeader } from "./precomputed_meshes.js";
import { needsTable, type ObjectShading } from "./segments.js";
import { COLORMAP_INDEX, COLOUR_INDEX, type LayerStyle, rgbOf, scalarOf, TONE_INDEX } from "./style.js";
import { View2d } from "./view2d.js";
import { View3d } from "./view3d.js";
import { autoGain, directionMatrix, vertexBudget } from "./view_math.js";

/** What a layer draws now, and how (LayerView.drawing). */
export interface LayerDrawing {
  /** Changes whenever what is shown or the colours change. */
  version: number;
  /** The spatial chunks are read and drawn with this shading; undefined: no chunk is read (the chosen objects are read whole, and the others not drawn). */
  chunks: ObjectShading | undefined;
  /** The chosen objects read whole are drawn with this shading; undefined when they are not read whole. */
  sets: ObjectShading | undefined;
  /** How many segments are chosen (0: every object shows). */
  size: number;
  /** How the chosen objects are read whole, if they are. */
  plan: ObjectPlan | undefined;
  /** How strongly the objects not chosen are drawn (the layer's notSelectedAlpha; 0 when every object shows). */
  others: number;
  /** The shaders look each vertex's object up in its chunk's table. */
  table: boolean;
}

export class LayerView {
  readonly client: StoreClient;
  private handle: { redraw(): void; dispose(): void };
  private readonly view3d: View3d;
  private readonly view2d: View2d;
  private readonly levels = new Map<string, Selection>();
  private transformCache: { at: number; value: LayerTransform | undefined } | undefined;
  private readonly offs: Disposer[] = [];
  private current: (LayerDrawing & { key: string }) | undefined;
  private readonly colours = new Map<bigint, [number, number, number]>();
  /** Per view, the share of what it last drew that showed (a layer's chosen segments). */
  private readonly shares = new Map<string, { version: number; share: number }>();
  /** Per view, how many samples of the chosen objects read whole it draws. */
  private readonly samples = new Map<string, number>();
  /** Called when what the panel shows about this layer changes. */
  onStatus: (() => void) | undefined;
  /** Reads but does not draw: the view of the store the layer drew before still draws (plugin.ts). */
  held = false;
  /** Draws what it drew when frozen, whatever the layer shows now (the view of a store the layer has left). */
  private frozen = false;
  /** Disposed: a store that opens afterwards draws nothing. */
  private disposed = false;
  /** The sign-in's headers its reads carry. */
  readonly headers: readonly AuthHeader[];
  /** The last drawing of chosen segments, and when it was last current (see freeze). */
  private chosen: { drawing: LayerDrawing & { key: string }; ids: BigUint64Array | undefined; at: number } | undefined;

  constructor(
    readonly ctx: PlatformContext,
    readonly name: string,
    readonly storeUrl: string,
    public style: LayerStyle,
    /** `adopt`: the view of the layer's store before, whose reading worker (and what it keeps) this one takes on; `headers`, the sign-in's. */
    options: { adopt?: LayerView; headers?: readonly AuthHeader[] } = {},
  ) {
    this.headers = options.headers ?? [];
    this.client = new StoreClient(storeUrl, { adopt: options.adopt?.client, headers: this.headers });
    this.client.setScalar(scalarOf(this.drawnStyle(style)));
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
        if (this.frozen) return;
        this.current = undefined;
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
        if (this.disposed) return;
        this.client.setScalar(scalarOf(this.drawnStyle(this.style)));
        this.redraw();
        this.onStatus?.();
      },
      () => {
        if (!this.disposed) this.onStatus?.();
      },
    );
  }

  setStyle(style: LayerStyle): void {
    this.style = style;
    this.client.setScalar(scalarOf(this.drawnStyle(style)));
    this.redraw();
  }

  /**
   * The style as drawn: colouring by an attribute chosen before the store
   * was open (none named) draws its first attribute, as the panel shows,
   * without writing it to the state (which would make an undo step).
   */
  private drawnStyle(style: LayerStyle): LayerStyle {
    if (style.colourBy !== "attribute" || style.attribute !== undefined) return style;
    const first = this.client.info?.attributes[0]?.id;
    return first === undefined ? style : { ...style, attribute: first };
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
   * What the layer shows and how it is read: every object, or the chosen
   * segments (`visibleSegments`), each in the layer's colour for it when
   * the style colours by segment, the others at the layer's
   * notSelectedAlpha.  A few chosen objects are read whole, by id
   * (./objects.ts), and the spatial chunks are then read only for the
   * others' faint drawing; otherwise the chunks are read and their tables
   * pick out what shows.
   */
  drawing(): LayerDrawing {
    const segmentColours = this.style.colourBy === "segment";
    // Made again also once the chosen objects read whole can be measured (objectPlan).
    const measured = this.client.objects.measured();
    const key = `${segmentColours}|${this.style.detail}|${this.client.scalarName}|${this.client.info !== undefined}|${measured !== undefined}`;
    if (this.current !== undefined && (this.current.key === key || this.frozen)) {
      if (this.chosen?.drawing === this.current) this.chosen.at = performance.now();
      return this.current;
    }
    const visible = this.ctx.viewer.visibleSegments(this.name);
    const { ctx, name, colours, client } = this;
    const colour = (id: bigint): [number, number, number] => {
      let c = colours.get(id);
      if (c === undefined) {
        c = ctx.viewer.segmentColour(name, id) ?? [1, 1, 1];
        colours.set(id, c);
      }
      return c;
    };
    const all = visible === undefined || visible.all;
    const size = all ? 0 : visible.size;
    const others = all ? 0 : Math.min(1, Math.max(0, visible.notSelectedAlpha ?? 0));
    const plan = all || client.info === undefined ? undefined : objectPlan(client.info, size, client.scalarName, this.style.detail, measured);
    const base = {
      version: ++shadingVersions,
      all,
      has: (id: bigint) => visible === undefined || visible.has(id),
      colour: segmentColours ? colour : undefined,
    };
    const chunks: ObjectShading | undefined = plan === undefined ? { ...base, chosenAlpha: 1, othersAlpha: others } : others > 0 ? { ...base, chosenAlpha: 0, othersAlpha: others } : undefined;
    const sets: ObjectShading | undefined = plan === undefined ? undefined : { ...base, chosenAlpha: 1, othersAlpha: 0 };
    const ids = plan === undefined ? undefined : visible?.ids();
    client.objects.want(ids, plan, client.scalarName);
    // A view that reads no chunks now says no level.
    if (chunks === undefined) this.levels.clear();
    this.current = { key, version: base.version, chunks, sets, size, plan, others, table: chunks === undefined || needsTable(chunks) };
    if (size > 0) this.chosen = { drawing: this.current, ids, at: performance.now() };
    return this.current;
  }

  /**
   * Keeps drawing what it draws now, whatever the layer shows from here on:
   * the layer has moved to another store, whose view takes over once it has
   * read what it wants.  A track-filtering group's layer shows every object
   * of its own store, and that may be seen here first: what it drew a
   * moment before (the group's streamlines) is kept, not the whole dataset.
   */
  freeze(): void {
    const chosen = this.chosen;
    if (this.current?.size === 0 && chosen !== undefined && performance.now() - chosen.at < 3000) {
      this.current = chosen.drawing;
      this.client.objects.want(chosen.ids, chosen.drawing.plan, this.client.scalarName);
      this.levels.clear();
    }
    this.frozen = true;
    this.redraw();
  }

  /** How many objects it draws whole, by id (undefined when it draws chunks). */
  get objectsShown(): number | undefined {
    return this.drawing().plan === undefined ? undefined : this.client.objects.progress().read;
  }

  /** Whether it has read all it wants to draw now (for taking over from the view of the layer's previous store). */
  get ready(): boolean {
    if (this.client.info === undefined || !this.objectsReady) return false;
    if (this.drawing().chunks === undefined) return true;
    const selections = [...this.levels.values()];
    return selections.length > 0 && selections.every((s) => s.complete);
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
      objectTable: this.drawing().table,
      eye: [0, 0, 1, 0],
    };
  }

  /** The vertices a view reads: the Detail, more when it shows only some of the objects. */
  budget(view: string): number {
    const shading = this.drawing().chunks;
    const known = this.shares.get(view);
    return vertexBudget(this.style.detail, shading === undefined || shading.all || known?.version !== shading.version ? 1 : known.share);
  }

  /**
   * The share of what a view drew that showed, for its next budget: the
   * least seen while the layer shows the same objects, so the budget only
   * grows and the level settles rather than going back and forth.
   */
  reportShare(view: string, share: number): void {
    const { version } = this.drawing();
    const known = this.shares.get(view);
    const old = known?.version === version ? known.share : 1;
    if (share >= old) return;
    this.shares.set(view, { version, share });
    // A new budget may choose another level: draw again.
    if (vertexBudget(1, share) > 1.01 * vertexBudget(1, old)) this.redraw();
  }

  /** How many of the SAMPLES samples of the chosen objects read whole a view draws (the Detail), for the panel. */
  reportSamples(view: string, samples: number): void {
    if (this.samples.get(view) === samples) return;
    this.samples.set(view, samples);
    this.onStatus?.();
  }

  /** What a view read and drew, for the panel. */
  reportLevel(view: string, selection: Selection): void {
    const old = this.levels.get(view);
    this.levels.set(view, selection);
    if (old === undefined || old.level !== selection.level || old.complete !== selection.complete) this.onStatus?.();
  }

  /**
   * For the panel's status line: what is being read, or what went wrong;
   * neither once all it wants is drawn (the line is then hidden).
   */
  report(): { progress?: string; error?: string; signIn?: boolean; warning?: string } {
    const { client } = this;
    // Refused for want of a sign-in: said so, not "no meshes" (the panel offers Sign in).
    if (client.error !== undefined && client.signIn) return { error: "Sign in to read this layer's meshes.", signIn: true };
    if (client.error !== undefined && client.info === undefined) return { error: `Could not open the store: ${client.error}` };
    if (client.info === undefined) return { progress: "Opening the store…" };
    const problem = this.view3d.problem ?? this.view2d.problem;
    if (problem !== undefined) return { error: problem };
    if (client.objects.error !== undefined) return { error: `Could not read the chosen objects: ${client.objects.error}` };
    if (client.error !== undefined) return { error: `Could not read a chunk: ${client.error}` };
    // The GPU budget shared by the layers is full: what is drawn is part of the layer.
    if (this.view3d.full || this.view2d.full) return { warning: "GPU memory is full: part of this layer is not drawn. Lower its Detail, or switch off another layer." };
    const drawing = this.drawing();
    if (drawing.plan !== undefined) {
      // Read whole, by id: how far it has got.
      const p = client.objects.progress();
      if (p.pending > 0) return { progress: `Reading the chosen objects: ${p.read.toLocaleString("en-GB")} of ${(p.wanted - p.absent).toLocaleString("en-GB")}…` };
    }
    if (client.pending > 0 || [...this.levels.values()].some((s) => !s.complete)) return { progress: "Reading…" };
    return {};
  }

  /** Whether the chosen objects read whole are all here. */
  get objectsReady(): boolean {
    return this.drawing().plan === undefined || !this.client.objects.busy;
  }

  /** The 2-D views stop drawing when the layer is hidden (the 3-D one stops with the layer). */
  setVisible(visible: boolean): void {
    this.view2d.setVisible(visible);
  }

  dispose(): void {
    this.disposed = true;
    this.offs.forEach((off) => off());
    this.handle.dispose();
    this.view2d.dispose();
    this.client.dispose();
  }
}
