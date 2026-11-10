/**
 * Luxar rendering: chosen Zarr Vectors layers drawn the way the Luxar
 * viewer draws lines and points, inside Neuroglancer's own views.
 *
 * Each layer with it on gets a LayerView (./layer_view.ts): its own reading
 * worker, a drawer in the 3-D view and a canvas over the 2-D views.
 * Neuroglancer's own drawing of the layer is hidden while it is on
 * (`hideLayerDrawing`: a Zarr Vectors layer's segments shown as a temporary
 * set naming no object, which Neuroglancer neither draws nor reads chunks
 * for; an image's opacity 0), never saved: the same link opened without
 * this plugin shows the layer as Neuroglancer draws it.  What the layer
 * shows (its chosen segments, or another plugin's temporary set, such as a
 * track-filtering group's) is still known (`visibleSegments`), and drawn.
 *
 * A precomputed segmentation whose segments have meshes (an EM
 * segmentation, MICrONS') is drawn from its meshes: the segments it shows,
 * read as a virtual Zarr Vectors mesh store (./precomputed_meshes.ts, made in
 * the layer's reading worker), which takes the same mesh path as a Zarr
 * Vectors mesh store.  A segment shown that the store does not hold makes a
 * new store, handed over to as a track-filtering group's new store is: the
 * new store's view takes on the reading worker of the one before, which
 * keeps the volume open and each segment's manifest, so only the new
 * segment's is read.  The meshes are read with the layer's own sign-in
 * (Google, middleauth as CAVE uses, ngauth; graphene segmentations too);
 * a server that refuses says to sign in.
 */
import type { Disposer, LayerInfo, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { button, card, type Child, el, emptyState, field, numberInput, type OnOff, region, select, type Settable, type Slider, slider, statusLine, toggle } from "@ngplatform/sdk/dom";
import { meshSourceOf, type SourceSignInNeed } from "@ngplatform/sdk/sources";
import { storeUrlOfSource } from "neuroglancer-zarr-vectors/source-url";
import { Momentum } from "./camera.js";
import { storeOf } from "../volume-view/sources.js";
import type { StoreInfo } from "./client.js";
import { LayerView } from "./layer_view.js";
import { meshIdsFor, type MeshStatus, meshStatus, meshStoreUrl, parseMeshStoreUrl, segmentCapNote } from "./mesh_layers.js";
import type { AuthHeader } from "./precomputed_meshes.js";
import { signInHeaders } from "./sign_in.js";
import { SplatView } from "./splat_view.js";
import { drawnSources } from "./sources.js";
import { LUXAR_CAN_DRAW, LUXAR_PANEL } from "./manifest.js";
import {
  autoSlab,
  BLENDING_LABELS,
  COLORMAP_LABELS,
  COLOUR_LABELS,
  DEFAULT_STYLE,
  extentMm,
  type LayerStyle,
  readSaved,
  readStyle,
  type Saved,
  type SlabScale,
  slabScale,
  TONE_LABELS,
} from "./style.js";

/** The settings a layer has (Luxar.kindOf). */
type SettingsKind = "splats" | "lines" | "points" | "mesh";

/** A style's numbers set on a slider. */
type NumberKey = "width" | "exposure" | "sharpness" | "absorption" | "detail" | "bloom" | "glowDepth";

/** At most this long a layer's view of its previous store keeps drawing while the new one reads. */
const OUTGOING_MS = 30_000;
/** Segments chosen within this long of each other make one new mesh store, not one each. */
export const SEGMENT_SETTLE_MS = 150;
/** After Sign in, a refused layer is asked again this often, this many times. */
const SIGN_IN_POLL_MS = 3000;
const SIGN_IN_POLLS = 100;

/** What is known of a segmentation's meshes: its status (undefined while asking), and the sign-in's headers. */
interface MeshVolumeEntry {
  state: MeshStatus | undefined;
  need: SourceSignInNeed | undefined;
  headers: AuthHeader[];
  asking: boolean;
}

/** The image a layer reads, when it is an image this plugin can draw as splats. */
export function imageOfLayer(layer: LayerInfo): string | undefined {
  return layer.type === "image" ? storeOf(layer.sources[0]) : undefined;
}

/**
 * The store a layer draws, when it is a Zarr Vectors layer this plugin can
 * draw: its first source that draws anything (`spec`, the layer's
 * specification, says which draw nothing: a track-filtering group with a
 * store of its own keeps the dataset's source beside it, drawing nothing).
 */
export function storeOfLayer(layer: LayerInfo, spec?: { source?: unknown }): string | undefined {
  if (layer.type !== "segmentation" && layer.type !== "auto") return undefined;
  for (const source of drawnSources(layer.sources, spec)) {
    const url = storeUrlOfSource(source);
    if (url !== undefined) return url;
  }
  return undefined;
}

/**
 * The precomputed (or graphene) volume a segmentation layer reads (its
 * http(s) URL, ending in "/"; `graphene+` before a graphene one), and the
 * sign-in it reads with, when it is one.  A graphene source is a
 * segmentation whatever the layer's type: one added by its URL stays
 * "auto" while its server refuses it (CAVE's, until signed in), and is
 * listed so the panel can say to sign in.
 */
export function precomputedSegmentationOf(layer: LayerInfo): { volume: string; signIn?: SourceSignInNeed } | undefined {
  const source = layer.sources[0];
  if (layer.type === "segmentation") return meshSourceOf(source);
  if ((layer.type === "auto" || layer.type === "new") && /^graphene:\/\//i.test(source?.trim() ?? "")) return meshSourceOf(source);
  return undefined;
}

export class Luxar {
  private saved: Saved;
  /**
   * Switched off: an answer that comes after (a volume's `info`, a timer, a
   * deferred setting) makes no view, hides no layer and writes no state.
   */
  private disposed = false;
  private readonly views = new Map<string, LayerView | SplatView>();
  /** A layer's view of the store it drew before, drawing until its new store's view is ready (see sync). */
  private readonly outgoing = new Map<string, { view: LayerView; timer: ReturnType<typeof setTimeout> }>();
  /** Layers whose own drawing is hidden while this plugin draws them. */
  private readonly drawingHidden = new Set<string>();
  private panelUpdate: (() => void) | undefined;
  private statusUpdate: (() => void) | undefined;
  /** The layer whose settings the panel shows. */
  private editing: string | undefined;
  private readonly momentum: Momentum;
  private readonly offs: Disposer[] = [];
  /** Precomputed volumes, by URL: whether their segments have meshes, and the sign-in's headers. */
  private readonly meshVolumes = new Map<string, MeshVolumeEntry>();
  /** Segmentation layers whose new segments wait a moment for more (SEGMENT_SETTLE_MS). */
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>();
  /** Asking refused layers again after Sign in. */
  private signInPoll: ReturnType<typeof setInterval> | undefined;
  /** Segmentation layers with meshes, watched for the segments they show. */
  private readonly segmentWatch = new Map<string, Disposer>();
  /** Each layer's store as last opened, for its settings while it is off. */
  private readonly opened = new Map<string, StoreInfo>();

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.momentum = new Momentum(ctx);
    this.offs.push(
      ctx.state.onChanged(() => {
        const next = readSaved(ctx.state.get());
        if (JSON.stringify(next) === JSON.stringify(this.saved)) return;
        this.saved = next;
        this.sync();
        this.panelUpdate?.();
      }),
      ctx.viewer.onLayersChanged(() => {
        this.sync();
        this.panelUpdate?.();
      }),
      ctx.workspace.onChanged(() => {
        this.updateCanDraw();
        this.panelUpdate?.();
      }),
    );
    this.sync();
  }

  /** Whether the selected layer is one this plugin can draw: the toggle command applies (LUXAR_CAN_DRAW). */
  private updateCanDraw(): void {
    if (this.disposed) return;
    const selected = this.ctx.workspace.selectedLayer();
    this.ctx.context.set(LUXAR_CAN_DRAW, selected !== undefined && this.candidates().some((l) => l.name === selected));
  }

  candidates(): LayerInfo[] {
    return this.ctx.viewer.layers().filter((l) => this.storeOf(l) !== undefined || imageOfLayer(l) !== undefined || this.isMeshLayer(l));
  }

  /**
   * The store a layer draws: a Zarr Vectors store, or for a segmentation
   * with precomputed meshes, the virtual store of the segments it shows
   * (none while it shows none, or every one).
   */
  private storeOf(layer: LayerInfo): string | undefined {
    const store = storeOfLayer(layer, this.ctx.viewer.layerSpec(layer.name) as { source?: unknown } | undefined);
    if (store !== undefined) return store;
    const volume = this.meshVolumeOf(layer);
    if (volume === undefined) return undefined;
    const shown = this.ctx.viewer.visibleSegments(layer.name);
    if (shown === undefined || shown.all || shown.size === 0) return undefined;
    const view = this.views.get(layer.name);
    const current = view === undefined ? undefined : parseMeshStoreUrl(view.storeUrl);
    return meshStoreUrl(volume, meshIdsFor(shown.ids(), current?.volume === volume ? current.ids : undefined));
  }

  /**
   * The precomputed volume of a segmentation layer whose segments have
   * meshes; undefined for other layers, and while its `info` is being read
   * (the panel and the layers are brought up to date when it is).
   */
  private meshVolumeOf(layer: LayerInfo): string | undefined {
    const entry = this.meshEntry(layer);
    return entry?.[1].state === "meshes" ? entry[0] : undefined;
  }

  /** A segmentation with meshes, or one whose `info` could not be read without a sign-in (listed, to say so). */
  private isMeshLayer(layer: LayerInfo): boolean {
    const state = this.meshEntry(layer)?.[1].state;
    return state === "meshes" || state === "sign-in";
  }

  /** Whether a layer's meshes need a sign-in to be read. */
  private needsSignIn(layer: LayerInfo): boolean {
    return this.meshEntry(layer)?.[1].state === "sign-in";
  }

  /** What is known of a segmentation layer's volume, asked for the first time it is seen. */
  private meshEntry(layer: LayerInfo): [string, MeshVolumeEntry] | undefined {
    const source = precomputedSegmentationOf(layer);
    if (source === undefined) return undefined;
    let entry = this.meshVolumes.get(source.volume);
    if (entry === undefined) {
      entry = { state: undefined, need: source.signIn, headers: [], asking: false };
      this.meshVolumes.set(source.volume, entry);
      void this.ask(source.volume, entry);
    }
    return [source.volume, entry];
  }

  /** Reads a volume's `info` with its sign-in: whether it has meshes, or wants a sign-in. */
  private async ask(volume: string, entry: MeshVolumeEntry): Promise<void> {
    if (entry.asking) return;
    entry.asking = true;
    try {
      const headers = await signInHeaders(entry.need);
      const state = await meshStatus(volume, headers);
      if (this.disposed) return;
      const changed = state !== entry.state;
      entry.headers = headers;
      entry.state = state;
      if (!changed || state === "none") return;
      this.sync();
      this.panelUpdate?.();
    } finally {
      entry.asking = false;
    }
  }

  /** Opens Settings › Sign-in, then asks the refused layers again until they can be read (or a while has passed). */
  private signIn(): void {
    void this.ctx.commands.invoke("settings.signIn");
    if (this.signInPoll !== undefined) clearInterval(this.signInPoll);
    let polls = 0;
    this.signInPoll = setInterval(() => void this.askAgain(++polls >= SIGN_IN_POLLS), SIGN_IN_POLL_MS);
  }

  /** The layers refused for want of a sign-in, asked again: a view whose sign-in has a new token reads afresh. */
  private async askAgain(last: boolean): Promise<void> {
    if (this.disposed) return;
    let waiting = false;
    for (const [volume, entry] of this.meshVolumes) {
      if (entry.state !== "sign-in") continue;
      waiting = true;
      void this.ask(volume, entry);
    }
    for (const [name, view] of this.views) {
      if (!(view instanceof LayerView) || !view.client.signIn) continue;
      waiting = true;
      const entry = this.meshVolumes.get(parseMeshStoreUrl(view.storeUrl)?.volume ?? "");
      if (entry === undefined) continue;
      const headers = await signInHeaders(entry.need);
      if (this.disposed || this.views.get(name) !== view || JSON.stringify(headers) === JSON.stringify(view.headers)) continue;
      entry.headers = headers;
      this.retry(name);
    }
    if ((!waiting || last) && this.signInPoll !== undefined) {
      clearInterval(this.signInPoll);
      this.signInPoll = undefined;
    }
  }

  private write(saved: Saved): void {
    if (this.disposed) return;
    this.saved = saved;
    this.ctx.state.set(saved);
    this.sync();
    this.panelUpdate?.();
  }

  /** A layer's style as saved, or the default for a layer not yet drawn (an image: grey splats that absorb, so tissue looks solid). */
  styleOf(name: string): LayerStyle {
    const saved = this.saved.layers[name];
    if (saved !== undefined) return saved;
    const layer = this.ctx.viewer.layers().find((l) => l.name === name);
    if (layer !== undefined && imageOfLayer(layer) !== undefined) return { ...DEFAULT_STYLE, on: false, blending: "emission", colourBy: "attribute", colormap: "grey", absorption: 0.3 };
    // A layer whose segments have colours of their own (a track-filtering group's colour, colours chosen
    // for segments) is drawn in them.
    const spec = this.ctx.viewer.layerSpec(name) as { segmentDefaultColor?: unknown; segmentColors?: unknown } | undefined;
    // A segmentation's meshes: each cell in its colour in the layer.
    if (layer !== undefined && this.isMeshLayer(layer)) return { ...DEFAULT_STYLE, on: false, colourBy: "segment" };
    const coloured = spec?.segmentDefaultColor !== undefined || (typeof spec?.segmentColors === "object" && spec.segmentColors !== null && Object.keys(spec.segmentColors).length > 0);
    return { ...DEFAULT_STYLE, on: false, ...(coloured ? { colourBy: "segment" as const } : {}) };
  }

  setStyle(name: string, patch: Partial<LayerStyle>, save = true): void {
    const style = readStyle({ ...this.styleOf(name), ...patch });
    if (save) this.write({ ...this.saved, layers: { ...this.saved.layers, [name]: style } });
    else {
      // While a slider moves: drawn at once, saved when it is let go.
      this.saved = { ...this.saved, layers: { ...this.saved.layers, [name]: style } };
      this.views.get(name)?.setStyle(style);
    }
  }

  toggle(name: string): void {
    const style = this.styleOf(name);
    // The panel redraws in setStyle: it shows this layer's settings.
    this.editing = name;
    this.setStyle(name, { on: !style.on });
  }

  /**
   * Hands a layer's drawing over from its view of the store it drew before
   * to the view of its new one, once that one has all it wants to draw, or
   * after OUTGOING_MS whatever it has.  When the one before drew the chosen
   * objects whole, by id, it stays until the new one has read all it
   * wants, and stays for good over a store with fewer objects than it drew
   * (a big track-filtering group's preview store, a sample of its
   * streamlines): that one waits for the next.
   */
  private handOver(name: string): void {
    const out = this.outgoing.get(name);
    if (out === undefined) return;
    const view = this.views.get(name);
    // A track-filtering group's first store of its own may be a sample of its streamlines (a big
    // group's preview): while the store before showed more of them whole, it stays.
    // Nor, while the store before drew the chosen objects whole, to a store still reading:
    // what is drawn is right meanwhile, and only slower to come by chunks.
    const before = out.view.objectsShown;
    const after = view instanceof LayerView ? view.client.info?.levels[0]?.objects : undefined;
    if (view instanceof LayerView && view.held && before !== undefined && (!view.ready || (after !== undefined && after < before))) {
      clearTimeout(out.timer);
      out.timer = this.handOverLater(name);
      return;
    }
    this.finishHandOver(name);
  }

  private handOverLater(name: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (!this.disposed) this.handOver(name);
    }, OUTGOING_MS);
  }

  private finishHandOver(name: string): void {
    const out = this.outgoing.get(name);
    if (out === undefined) return;
    this.outgoing.delete(name);
    clearTimeout(out.timer);
    out.view.dispose();
    const view = this.views.get(name);
    if (view instanceof LayerView && view.held) {
      view.held = false;
      view.redraw();
    }
  }

  /** Makes the layer views match the state and the scene's layers. */
  private sync(): void {
    if (this.disposed) return;
    const layers = new Map(this.ctx.viewer.layers().map((l) => [l.name, l]));
    /** Views let go of whose reading worker the layer's new view may take on; disposed at the end. */
    const spare = new Map<string, LayerView>();
    for (const [name, view] of this.views) {
      const layer = layers.get(name);
      const style = this.saved.layers[name];
      const store = layer && (this.storeOf(layer) ?? imageOfLayer(layer));
      if (layer === undefined || style === undefined || !style.on || store !== view.storeUrl) {
        this.views.delete(name);
        // The layer now reads another store (a track-filtering group's own, made after its
        // streamlines were shown by id): what was drawn stays until the new store's view has
        // read what it wants, so the layer does not go blank in between.
        if (view instanceof LayerView && !view.held && style?.on && layer?.visible && store !== undefined && this.storeOf(layer) !== undefined) {
          this.finishHandOver(name);
          view.freeze();
          // While Neuroglancer made the layer afresh it may have seemed hidden for a moment.
          view.setVisible(true);
          this.outgoing.set(name, { view, timer: this.handOverLater(name) });
        } else if (view instanceof LayerView && parseMeshStoreUrl(view.storeUrl) !== undefined && layer !== undefined && style?.on) {
          // A mesh store's view may hand its reading worker (the volume, its manifests) to the next store's.
          spare.set(name, view);
        } else view.dispose();
      }
    }
    // A view kept for a layer no longer drawn here goes.
    for (const name of [...this.outgoing.keys()]) {
      const style = this.saved.layers[name];
      if (!layers.has(name) || style === undefined || !style.on) this.finishHandOver(name);
    }
    for (const [name, style] of Object.entries(this.saved.layers)) {
      const layer = layers.get(name);
      if (layer === undefined || !style.on) continue;
      const store = this.storeOf(layer);
      const image = store === undefined ? imageOfLayer(layer) : undefined;
      if (store === undefined && image === undefined) continue;
      let view = this.views.get(name);
      if (view === undefined) {
        // An image is drawn as splats made from its voxels; a Zarr Vectors layer as lines and points.
        if (image !== undefined) {
          view = new SplatView(this.ctx, name, image, style);
          view.onStatus = () => this.statusUpdate?.();
        } else {
          // The same segmentation's meshes, read with the same sign-in: its worker kept the volume open.
          const before = spare.get(name) ?? this.outgoing.get(name)?.view;
          const volume = parseMeshStoreUrl(store!)?.volume;
          const headers = volume === undefined ? [] : (this.meshVolumes.get(volume)?.headers ?? []);
          const adopt = before !== undefined && volume !== undefined && parseMeshStoreUrl(before.storeUrl)?.volume === volume && JSON.stringify(before.headers) === JSON.stringify(headers) ? before : undefined;
          const lines = new LayerView(this.ctx, name, store!, style, { adopt, headers });
          // Held (reading, not drawing) while the view of the store before it still draws.
          lines.held = this.outgoing.has(name);
          lines.onStatus = () => {
            if (lines.held && lines.ready && this.views.get(name) === lines) this.handOver(name);
            this.statusUpdate?.();
          };
          view = lines;
        }
        this.views.set(name, view);
      } else if (view.style !== style) view.setStyle(style);
      view.setVisible(layer.visible);
      const out = this.outgoing.get(name);
      if (out !== undefined) {
        if (out.view.style !== style) out.view.setStyle(style);
        out.view.setVisible(layer.visible);
      }
    }
    for (const view of spare.values()) view.dispose();
    // A layer is drawn either by Neuroglancer or here, not both: its own
    // drawing is hidden (not in the link) while ours is on; asked each time,
    // as a layer still loading may not take it yet, and a layer made afresh
    // shows again (the engine does nothing when it is hidden already).
    for (const name of [...this.drawingHidden]) {
      if (this.views.has(name)) continue;
      this.drawingHidden.delete(name);
      if (layers.has(name)) this.ctx.viewer.hideLayerDrawing(name, false);
    }
    for (const name of this.views.keys()) {
      this.drawingHidden.add(name);
      this.ctx.viewer.hideLayerDrawing(name, true);
    }
    // A segmentation drawn from its meshes reads the segments it shows: a segment shown that its
    // store lacks makes a new store (one let go is hidden by the layer's table, nothing read).
    for (const [name, off] of [...this.segmentWatch]) {
      const layer = layers.get(name);
      if (layer !== undefined && this.meshVolumeOf(layer) !== undefined) continue;
      off();
      this.segmentWatch.delete(name);
      clearTimeout(this.settling.get(name));
      this.settling.delete(name);
    }
    for (const layer of layers.values()) {
      if (this.segmentWatch.has(layer.name) || this.meshVolumeOf(layer) === undefined) continue;
      this.segmentWatch.set(
        layer.name,
        this.ctx.viewer.onSegmentsChanged(layer.name, () => {
          const view = this.views.get(layer.name);
          const now = this.ctx.viewer.layers().find((l) => l.name === layer.name);
          // Segments clicked one after another make one new store once they settle.
          if (now !== undefined && this.saved.layers[layer.name]?.on && (view === undefined || this.storeOf(now) !== view.storeUrl) && !this.settling.has(layer.name)) {
            this.settling.set(
              layer.name,
              setTimeout(() => {
                this.settling.delete(layer.name);
                this.sync();
              }, SEGMENT_SETTLE_MS),
            );
          }
          this.panelUpdate?.();
        }),
      );
    }
    // Splats add light to the 2-D views: on black, as the image they stand for is drawn.
    const splats = [...this.views.values()].some((v) => v instanceof SplatView);
    this.ctx.viewer.setTemporaryBackground(splats ? [0, 0, 0] : undefined);
    this.momentum.set(this.saved.momentum);
    this.updateCanDraw();
  }

  // ------------------------------------------------------------- panel

  /**
   * The settings a layer has: an image's splats, or a store's lines, points
   * or mesh (a store not yet open has the lines' settings until it is).
   */
  private kindOf(name: string): SettingsKind {
    const layer = this.ctx.viewer.layers().find((l) => l.name === name);
    if (layer !== undefined && imageOfLayer(layer) !== undefined) return "splats";
    if (layer !== undefined && this.isMeshLayer(layer)) return "mesh";
    const view = this.views.get(name);
    const primitive = view instanceof LayerView ? view.client.info?.primitive : undefined;
    return primitive === "points" ? "points" : primitive === "triangles" ? "mesh" : "lines";
  }

  /** A layer's store as last opened (its size and attributes), kept while it is off. */
  private storeInfoOf(name: string): StoreInfo | undefined {
    const view = this.views.get(name);
    const info = view instanceof LayerView ? view.client.info : undefined;
    if (info !== undefined) this.opened.set(name, info);
    return info ?? this.opened.get(name);
  }

  /** Draws a layer's view again from scratch: a store that could not be opened is tried again. */
  private retry(name: string): void {
    const view = this.views.get(name);
    if (view === undefined) return;
    this.views.delete(name);
    view.dispose();
    this.sync();
    this.panelUpdate?.();
  }

  /**
   * Draws the panel once and keeps it up to date in place (`sync`): the
   * layer rows and each control are set from the state, and only what
   * changes shape (the rows, the cards of another kind of layer) is drawn
   * again, so an open select, a drag or a number being typed is kept.
   */
  render(host: HTMLElement): Disposer {
    const { ctx } = this;
    const empty = emptyState("Nothing here Luxar can draw.", { label: "Open data…", run: () => void ctx.commands.invoke("dataset.add") });
    const rows = new Map<string, { draw: OnOff; cap: HTMLElement }>();
    const list = region(
      (names: string[]) => {
        rows.clear();
        return names.map((name) => {
          const draw = toggle(name, this.styleOf(name).on, (on) => {
            this.editing = name;
            this.setStyle(name, { on });
          });
          const cap = el("p", { class: "hint", hidden: true });
          rows.set(name, { draw, cap });
          return el("div", {}, draw, cap);
        });
      },
      { class: "list" },
    );
    let chooser: Settable<HTMLSelectElement, string> | undefined;
    const choose = region((names: string[]) => {
      if (names.length < 2) return (chooser = undefined);
      chooser = select(
        names.map((n) => [n, n]),
        this.editing ?? names[0],
        (name) => {
          this.editing = name;
          sync();
        },
        "Settings for",
      );
      return field("Settings for", chooser);
    });
    const status = statusLine();
    let shownStatus = "";
    let settingsSync: (() => void) | undefined;
    const settings = region((key: [string, SettingsKind] | null) => {
      if (key === null) return (settingsSync = undefined);
      const built = this.settingsCards(key[0], key[1]);
      settingsSync = built.sync;
      return built.cards;
    });
    const momentum = toggle("Momentum", this.saved.momentum, (v) => this.write({ ...this.saved, momentum: v }), { info: "Keeps the 3-D view turning after a drag, slowing to a stop, as Luxar's camera does." });
    host.append(card("luxar.layers", "Layers", { open: true }, empty, list, choose, status), settings, card("luxar.view", "3-D view", {}, momentum));

    const updateStatus = () => {
      const name = this.editing;
      const view = name === undefined ? undefined : this.views.get(name);
      const layer = name === undefined ? undefined : ctx.viewer.layers().find((l) => l.name === name);
      // A segmentation whose info was refused: no view yet, and a sign-in to offer.
      const refused = view === undefined && layer !== undefined && this.needsSignIn(layer);
      const report: ReturnType<LayerView["report"]> = refused ? { error: "Sign in to read this layer's meshes.", signIn: true } : (view?.report() ?? {});
      // While the view of the layer's previous store still draws, the new one is reading.
      const progress = report.progress ?? (name !== undefined && this.outgoing.has(name) ? "Reading…" : undefined);
      const key = JSON.stringify([report.error, progress, report.warning]);
      if (key === shownStatus) return;
      shownStatus = key;
      if (report.error !== undefined && report.signIn) status.error(report.error, { label: "Sign in…", run: () => this.signIn() });
      else if (report.error !== undefined && name !== undefined) status.error(report.error, { label: "Retry", run: () => this.retry(name) });
      else if (report.warning !== undefined) status.error(report.warning);
      else if (progress !== undefined) status.progress(progress);
      else status.clear();
    };
    const sync = () => {
      const candidates = this.candidates();
      if (this.editing === undefined || !candidates.some((c) => c.name === this.editing)) {
        const selected = ctx.workspace.selectedLayer();
        this.editing = candidates.find((c) => c.name === selected)?.name ?? candidates.find((c) => this.saved.layers[c.name]?.on)?.name ?? candidates[0]?.name;
      }
      const names = candidates.map((c) => c.name);
      empty.hidden = names.length > 0;
      list.update(names);
      for (const layer of candidates) {
        const row = rows.get(layer.name)!;
        row.draw.set(this.styleOf(layer.name).on);
      }
      notes(candidates);
      choose.update(names);
      choose.hidden = names.length < 2;
      if (this.editing !== undefined) chooser?.set(this.editing);
      settings.update(this.editing === undefined ? null : [this.editing, this.kindOf(this.editing)]);
      settingsSync?.();
      momentum.set(this.saved.momentum);
      updateStatus();
    };
    /**
     * The quiet note under each layer's row: the segment cap, and what its
     * store says of itself (segments with no mesh, fragments that failed,
     * the reader's notes), each once per store.
     */
    const notes = (candidates: LayerInfo[]) => {
      for (const layer of candidates) {
        const row = rows.get(layer.name);
        if (row === undefined) continue;
        // A segmentation drawn from its meshes reads at most MAX_SEGMENTS of the segments it shows: said, not silent.
        const shown = this.meshVolumeOf(layer) === undefined ? undefined : this.ctx.viewer.visibleSegments(layer.name);
        const cap = shown === undefined || shown.all ? undefined : segmentCapNote(shown.size);
        const view = this.views.get(layer.name);
        const said = [cap, ...(view instanceof LayerView ? view.client.warnings : [])].filter((w): w is string => w !== undefined);
        const text = said.join(". ");
        row.cap.hidden = said.length === 0;
        if (row.cap.textContent !== text) row.cap.textContent = text;
      }
    };
    // A view's news (its store opened, a chunk read: often) changes only the editing layer's settings
    // (its kind, attributes, the slab's unit, the range), the status and the notes: not the rows.
    const news = () => {
      notes(this.candidates());
      if (this.editing !== undefined) settings.update([this.editing, this.kindOf(this.editing)]);
      settingsSync?.();
      updateStatus();
    };
    sync();
    this.panelUpdate = sync;
    this.statusUpdate = news;
    return () => {
      if (this.panelUpdate === sync) this.panelUpdate = undefined;
      if (this.statusUpdate === news) this.statusUpdate = undefined;
    };
  }

  /**
   * The cards of one layer's settings, drawn once for the layer and its
   * kind, and `sync`, which sets them from its style and its store.
   */
  private settingsCards(name: string, kind: SettingsKind): { cards: Child[]; sync: () => void } {
    const style = () => this.styleOf(name);
    const set = (patch: Partial<LayerStyle>, save = true) => this.setStyle(name, patch, save);
    const syncs: (() => void)[] = [];
    /** Shown only while `when` holds. */
    const shownWhen = <E extends HTMLElement>(e: E, when: () => boolean): E => {
      syncs.push(() => void (e.hidden = !when()));
      return e;
    };
    /** A style's number on the one slider: drawn as it moves, saved when let go; `scale` shows it in other units. */
    const number = (label: string, key: NumberKey, o: { min: number; max: number; step: number; unit?: string; scale?: number; info?: string }) => {
      const k = o.scale ?? 1;
      const control = slider(style()[key] * k, { min: o.min, max: o.max, step: o.step, unit: o.unit, label, oninput: (v) => set({ [key]: v / k }, false), onchange: (v) => set({ [key]: v / k }) });
      syncs.push(() => control.set(style()[key] * k));
      return field(label, control, o.info === undefined ? undefined : { info: o.info });
    };
    const choice = <T extends string>(label: string, options: [T, string][], value: () => T, change: (v: T) => void) => {
      const control = select(options, value(), (v) => change(v as T), label);
      syncs.push(() => control.set(value()));
      return field(label, control);
    };
    const colourPicker = (label: string) => {
      const input = el("input", { type: "color", value: style().colour, "aria-label": label });
      input.addEventListener("input", () => set({ colour: input.value }, false));
      input.addEventListener("change", () => set({ colour: input.value }));
      syncs.push(() => {
        if (input.ownerDocument.activeElement !== input && input.value !== style().colour) input.value = style().colour;
      });
      return field(label, input);
    };
    const splats = kind === "splats";
    const solid = () => style().blending === "solid";
    const look: Child[] = [];
    if (splats) {
      look.push(
        choice<"emission" | "glow">(
          "Blending",
          [
            ["emission", "Emission and absorption (looks solid)"],
            ["glow", "Glow (light added up)"],
          ],
          () => (style().blending === "emission" ? "emission" : "glow"),
          (blending) => set({ blending }),
        ),
        choice<"attribute" | "solid">(
          "Colour",
          [
            ["attribute", "By intensity, through a colormap"],
            ["solid", "One colour"],
          ],
          () => (style().colourBy === "solid" ? "solid" : "attribute"),
          (colourBy) => set({ colourBy }),
        ),
        shownWhen(choice("Colormap", COLORMAP_LABELS, () => style().colormap, (colormap) => set({ colormap })), () => style().colourBy !== "solid"),
      );
    } else {
      look.push(
        choice("Blending", BLENDING_LABELS, () => style().blending, (blending) => set({ blending })),
        choice("Colour", COLOUR_LABELS, () => style().colourBy, (colourBy) => {
          const first = this.storeInfoOf(name)?.attributes[0]?.id;
          set({ colourBy, attribute: colourBy === "attribute" ? (style().attribute ?? first) : style().attribute });
        }),
      );
      // The store's attributes, once it is open.
      let attribute: Settable<HTMLSelectElement, string> | undefined;
      const attributes = region((list: [string, string][]) => {
        attribute = select(list.length > 0 ? list : [["", "None"]], style().attribute ?? list[0]?.[0] ?? "", (id) => set({ attribute: id, range: undefined }), "Attribute");
        attribute.disabled = list.length === 0;
        return field("Attribute", attribute);
      });
      const byAttribute = () => style().colourBy === "attribute";
      const range = () => {
        const view = this.views.get(name);
        return style().range ?? (view instanceof LayerView ? view.client.valueRange : undefined);
      };
      const apply = () => {
        const a = Number(lo.value);
        const b = Number(hi.value);
        if (lo.value !== "" && hi.value !== "" && Number.isFinite(a) && Number.isFinite(b) && a !== b) set({ range: [a, b] });
      };
      const lo = numberInput(NaN, apply, { step: "any", "aria-label": "Range from" });
      const hi = numberInput(NaN, apply, { step: "any", "aria-label": "Range to" });
      lo.value = hi.value = "";
      const reset = shownWhen(button("Reset", () => set({ range: undefined }), "Back to the range of the data read"), () => style().range !== undefined);
      syncs.push(() => {
        const info = this.storeInfoOf(name);
        attributes.hidden = !byAttribute() || info === undefined;
        attributes.update((info?.attributes ?? []).map((a) => [a.id, a.name]));
        if (info !== undefined && info.attributes.length > 0) attribute?.set(style().attribute ?? info.attributes[0].id);
        const r = range();
        if (r !== undefined) {
          lo.set(+r[0].toPrecision(4));
          hi.set(+r[1].toPrecision(4));
        }
      });
      look.push(
        attributes,
        shownWhen(choice("Colormap", COLORMAP_LABELS, () => style().colormap, (colormap) => set({ colormap })), byAttribute),
        shownWhen(field("Range", el("div", { class: "row" }, lo, hi, reset)), byAttribute),
      );
    }
    look.push(
      shownWhen(colourPicker("Colour"), () => style().colourBy === "solid"),
      number("Brightness", "exposure", { min: -8, max: 8, step: 0.25, unit: "stops" }),
      shownWhen(number("Absorption", "absorption", { min: 0, max: 8, step: 0.05 }), () => style().blending === "emission"),
      shownWhen(choice("Tone map", TONE_LABELS, () => style().toneMap, (toneMap) => set({ toneMap })), () => !solid()),
      shownWhen(number("Bloom", "bloom", { min: 0, max: 3, step: 0.05, info: "A glow around bright light: the brightest parts, blurred, added back around them. 0 is off." }), () => !solid()),
    );
    const cards: Child[] = [card("luxar.look", "Look", { open: true }, ...look)];
    if (!splats) {
      const mesh = kind === "mesh";
      cards.push(
        card(
          "luxar.lines",
          mesh ? "Surface" : kind === "points" ? "Points" : "Lines",
          {},
          kind === "points"
            ? number("Point size", "width", { min: 1.5, max: 36, step: 0.75, unit: "px", scale: 3 })
            : number(mesh ? "Outline width" : "Width", "width", { min: 0.5, max: 12, step: 0.25, unit: "px", info: mesh ? "Of the outline where a 2-D section cuts the mesh." : undefined }),
          number("Sharpness", "sharpness", { min: 0, max: 1, step: 0.05, info: "From a soft glow (0) to a hard edge (1)." }),
          mesh
            ? shownWhen(number("Glow depth", "glowDepth", { min: 0, max: 20, step: 0.5, unit: "%", scale: 100, info: "How far light from behind the nearest surface still shows, as a share of the layer's size; 0 adds every fold up." }), () => style().blending === "glow" || style().blending === "glow-through")
            : null,
        ),
        card("luxar.slab", "2-D sections", {}, this.slabField(name, syncs)),
      );
    }
    const unit = splats ? "M splats" : "M vertices";
    cards.push(
      card(
        "luxar.detail",
        "Detail",
        {},
        number("Detail", "detail", { min: 0.25, max: 12, step: 0.25, unit, info: "About how much a view reads and draws: more is finer and slower." }),
        splats ? null : this.onOffField(name, syncs),
      ),
    );
    return { cards, sync: () => syncs.forEach((f) => f()) };
  }

  /** Automatic brightness, a switch. */
  private onOffField(name: string, syncs: (() => void)[]): HTMLElement {
    const control = toggle("Automatic brightness", this.styleOf(name).autoBrightness, (autoBrightness) => this.setStyle(name, { autoBrightness }), { info: "Dims lines where they crowd the view, so a whole brain glows rather than turning white." });
    syncs.push(() => control.set(this.styleOf(name).autoBrightness));
    return control;
  }

  /**
   * The slab's thickness, in the unit that suits the layer's data (mm for a
   * brain, µm or nm for EM): drawn again when that changes.  It follows the
   * data until it is set; Reset follows the data again.  Shown once the
   * layer's store has been open (its size is known), or once it is set.
   */
  private slabField(name: string, syncs: (() => void)[]): HTMLElement {
    let control: Slider | undefined;
    let reset: HTMLButtonElement | undefined;
    let shown: SlabScale | undefined;
    const part = region((scale: SlabScale | null) => {
      shown = scale ?? undefined;
      if (scale === null) return (control = reset = undefined);
      const toMm = (v: number) => v * scale.perUnit;
      control = slider(this.slabMm(name)! / scale.perUnit, {
        min: scale.min,
        max: scale.max,
        step: scale.step,
        unit: scale.unit,
        label: "Slab thickness",
        unbounded: true,
        oninput: (v) => this.setStyle(name, { slab: toMm(v) }, false),
        // Kept above zero (style.readStyle).
        onchange: (v) => this.setStyle(name, { slab: toMm(v) }),
      });
      reset = button("Reset", () => this.setStyle(name, { slab: undefined }), "Follow the data's size again");
      return field("Slab thickness", el("div", { class: "row" }, control, reset), { info: "In a 2-D view, what is within half this of the section shows, fading away from it. It follows the data's size until you set it." });
    });
    syncs.push(() => {
      const info = this.storeInfoOf(name);
      const auto = info === undefined ? undefined : autoSlab(extentMm(info));
      // The unit and range follow the data; before its store is open, a slab set is shown in its own.
      part.update(auto !== undefined ? slabScale(auto) : this.styleOf(name).slab !== undefined ? slabScale(this.styleOf(name).slab!) : null);
      if (reset !== undefined) reset.hidden = this.styleOf(name).slab === undefined;
      const mm = this.slabMm(name);
      if (control !== undefined && shown !== undefined && mm !== undefined) control.set(mm / shown.perUnit);
    });
    return part;
  }

  /** A layer's slab in mm: as set, or following its store's size; undefined while neither is known. */
  private slabMm(name: string): number | undefined {
    const style = this.styleOf(name);
    const info = this.storeInfoOf(name);
    return style.slab ?? (info === undefined ? undefined : autoSlab(extentMm(info)));
  }

  /** Releases every view (its worker and WebGL context) and shows the layers' own drawing again. */
  dispose(): void {
    this.disposed = true;
    this.panelUpdate = this.statusUpdate = undefined;
    for (const timer of this.settling.values()) clearTimeout(timer);
    this.settling.clear();
    if (this.signInPoll !== undefined) clearInterval(this.signInPoll);
    this.signInPoll = undefined;
    this.offs.forEach((off) => off());
    this.segmentWatch.forEach((off) => off());
    this.segmentWatch.clear();
    for (const name of [...this.outgoing.keys()]) this.finishHandOver(name);
    for (const view of this.views.values()) view.dispose();
    const splats = [...this.views.values()].some((v) => v instanceof SplatView);
    for (const name of this.drawingHidden) this.ctx.viewer.hideLayerDrawing(name, false);
    if (splats) this.ctx.viewer.setTemporaryBackground(undefined);
    this.drawingHidden.clear();
    this.views.clear();
    this.momentum.dispose();
    this.ctx.context.set(LUXAR_CAN_DRAW, false);
  }
}

/** The 2-D views' canvas over Neuroglancer's (view2d.ts, splat_view2d.ts): the panel has no style of its own. */
const STYLE = `
.luxar-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
`;

let instance: Luxar | undefined;

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = el("style", {}, STYLE);
    document.head.append(style);
    const own = (instance = new Luxar(ctx));
    ctx.subscriptions.push(() => style.remove());
    ctx.subscriptions.push(() => {
      own.dispose();
      if (instance === own) instance = undefined;
    });
    ctx.ui.panel(LUXAR_PANEL, (host) => own.render(host));
    ctx.commands.register("luxar.toggle", () => {
      const name = ctx.workspace.selectedLayer();
      const layer = name === undefined ? undefined : own.candidates().find((l) => l.name === name);
      if (layer === undefined) {
        ctx.ui.toast("Select a layer Luxar can draw first.");
        return;
      }
      own.toggle(layer.name);
    });
    ctx.commands.register("luxar.show", () => ctx.ui.showPanel(LUXAR_PANEL));
  },
};
