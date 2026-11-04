/**
 * Annotations organised as Neuroglass and WebKnossos organise them, for one
 * user: the scene's local annotation layers, each with fields (values from
 * a list, a number, text, or an ontology's terms), groups, and comments,
 * listed in the annotation table (./table_panel.ts) and set up in the
 * Annotate section (./annotate_panel.ts).
 *
 * Annotations stay in Neuroglancer's state; what Neuroglancer can hold is
 * kept there (see ./values.ts and ./groups.ts), the rest in this plugin's
 * state under `annotate`, by layer name.  Both are the active scene's, so
 * switching scenes switches them.  A new annotation drawn in a view is
 * selected in the table, ready for its values; one selected in a view is
 * selected in the table; one under the pointer shows its values and
 * comments beside it.
 */
import type { Disposer, Json, PlatformContext } from "@ngplatform/sdk";
import { TABLE_PANEL } from "./manifest.js";
import { measure, type AnnotationJson } from "./measure.js";
import { lookupTerms, type Term } from "./ontology.js";
import { rankOf, space, toGlobalOf } from "./scene.js";
import { buildRows, rowName, type Row, type TableLayer } from "./table.js";
import { withShader } from "./groups.js";
import { el, physical } from "./ui.js";
import { type Comment, type Field, fieldsOf, type LayerMeta, type LayerSpec, metaOf, prune, readValue } from "./values.js";

/** Neuroglancer's annotation tools, by the names the Annotate section gives them. */
export const TOOLS: [string, string, string][] = [
  ["annotatePoint", "Point", "Ctrl+click a point"],
  ["annotateLine", "Line", "Ctrl+click its two ends"],
  ["annotateBoundingBox", "Box", "Ctrl+click two corners"],
  ["annotateSphere", "Ellipsoid", "Ctrl+click the centre, then the extent"],
  ["annotatePolyline", "Polyline", "Ctrl+click its points; Ctrl+double-click ends it"],
];

/** The plugin's record, in its state slice under `annotate`. */
interface Saved {
  /** The layer new annotations go to. */
  layer?: string;
  layers?: Record<string, Partial<LayerMeta>>;
}

export interface Selected {
  layer: string;
  id: string;
}

/** Track filtering's regions layer: written by it from its groups, so here only read, gone to, deleted and commented. */
export function isManaged(spec: LayerSpec): boolean {
  const props = spec.annotationProperties ?? [];
  return / regions$/.test(spec.name) && props.length === 1 && props[0].id === "color";
}

export class Annotate {
  selected: Selected | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly offs: Disposer[] = [];
  /** Ontologies read from lookup tables, by URL. */
  private readonly tables = new Map<string, { byId?: Map<string, Term>; terms?: Term[]; error?: string }>();
  private readonly inline = new WeakMap<Term[], Map<string, Term>>();
  /** Each layer's annotation ids as last seen, by scene: an id new to them was just drawn. */
  private readonly known = new Map<string, Map<string, Set<string>>>();
  /** The annotation Neuroglancer last had selected ("layer|id"). */
  private lastSelection = "";
  private readonly tip = el("div", { class: "an-tip" });
  private readonly overlay: { element: HTMLElement; dispose(): void };
  private pointer: [number, number] = [0, 0];

  constructor(private readonly ctx: PlatformContext) {
    this.overlay = ctx.ui.overlay();
    this.overlay.element.append(this.tip);
    this.tip.hidden = true;
    const move = (e: MouseEvent) => (this.pointer = [e.clientX, e.clientY]);
    document.addEventListener("mousemove", move, { passive: true });
    this.offs.push(
      () => document.removeEventListener("mousemove", move),
      ctx.viewer.onStateChanged(() => this.stateChanged()),
      ctx.state.onChanged(() => this.notify()),
      ctx.viewer.onCursorChanged(() => this.hover()),
    );
    this.stateChanged();
  }

  dispose(): void {
    if (this.waiting !== undefined) clearInterval(this.waiting);
    this.offs.forEach((off) => off());
    this.overlay.dispose();
  }

  /** Calls back when the layers, the record or the selection change. */
  onChange(callback: () => void): Disposer {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify(): void {
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------- reading

  private saved(): Saved {
    return this.ctx.state.get<{ annotate?: Saved }>()?.annotate ?? {};
  }

  private save(next: Saved): void {
    this.ctx.state.set({ ...(this.ctx.state.get<Json>() ?? {}), annotate: next });
  }

  /** The active scene's local annotation layers (annotations kept in the state). */
  layers(): TableLayer[] {
    const saved = this.saved();
    const layers = ((this.ctx.viewer.getState() as { layers?: Json[] }).layers ?? []) as unknown as LayerSpec[];
    return layers
      .filter((l) => Array.isArray(l.annotations))
      .map((spec) => ({ spec, meta: metaOf(saved.layers?.[spec.name]), managed: isManaged(spec) }));
  }

  layer(name: string): TableLayer | undefined {
    return this.layers().find((l) => l.spec.name === name);
  }

  /** The layer new annotations go to: the one chosen, else the first the plugin may edit. */
  chosen(): string | undefined {
    const layers = this.layers().filter((l) => !l.managed);
    const name = this.saved().layer;
    return layers.find((l) => l.spec.name === name)?.spec.name ?? layers[0]?.spec.name;
  }

  choose(name: string): void {
    this.save({ ...this.saved(), layer: name });
  }

  /** An ontology field's terms by id, when at hand (a lookup table's are read once, then the table is drawn again). */
  terms(field: Field): Map<string, Term> | undefined {
    const o = field.ontology;
    if (o?.terms) {
      let byId = this.inline.get(o.terms);
      if (byId === undefined) this.inline.set(o.terms, (byId = new Map(o.terms.map((t) => [t.id, t]))));
      return byId;
    }
    if (!o?.url) return undefined;
    const known = this.tables.get(o.url);
    if (known) return known.byId;
    this.tables.set(o.url, {});
    void this.ctx.viewer.lookupTables.load(o.url).then(
      (table) => {
        const terms = lookupTerms(table);
        this.tables.set(o.url!, { terms, byId: new Map(terms.map((t) => [t.id, t])) });
        this.notify();
      },
      (e: Error) => {
        this.tables.set(o.url!, { error: e.message });
        this.notify();
      },
    );
    return undefined;
  }

  /** An ontology field's terms as a list, or why there are none yet. */
  termList(field: Field): Term[] | string {
    if (field.ontology?.terms) return field.ontology.terms;
    const byId = this.terms(field);
    if (byId) return this.tables.get(field.ontology!.url!)?.terms ?? [...byId.values()];
    return this.tables.get(field.ontology?.url ?? "")?.error ?? "Reading the terms…";
  }

  /** The table's rows; each layer's placement in the global space is read once. */
  rows(layers = this.layers()): Row[] {
    const global = space(this.ctx);
    const placed = new Map<string, (p: ArrayLike<number>) => number[]>();
    const measureOf = (layer: string, a: AnnotationJson) => {
      const key = `${layer}|${rankOf(a)}`;
      let toGlobal = placed.get(key);
      if (toGlobal === undefined) placed.set(key, (toGlobal = toGlobalOf(this.ctx, layer, rankOf(a))));
      const m = measure(a, layer, toGlobal, global);
      return m ? { quantity: m.quantity, value: m.value } : undefined;
    };
    return buildRows(layers, measureOf, (f) => this.terms(f));
  }

  // ------------------------------------------------------------- writing

  /**
   * Writes a layer: its annotations, properties and shader (brought up to
   * date with its groups and colours) in the state, and its record, as one
   * undo step.
   */
  write(name: string, spec: LayerSpec, meta: LayerMeta): void {
    // An annotation half drawn (a polyline, say) would be lost by rewriting the layer: the edit waits.
    if (this.ctx.viewer.annotationInProgress()) {
      // The layer's annotations before the first edit queued: anything else there when drawing ends was drawn meanwhile.
      const before = this.pending.get(name)?.before ?? new Set((this.layer(name)?.spec.annotations ?? []).map((a) => a.id));
      this.pending.set(name, { spec, meta, before, scene: activeScene(this.ctx) });
      this.waitForDrawing();
      return;
    }
    const current = this.layer(name);
    if (current === undefined) return;
    const fields = fieldsOf(spec, meta);
    const next = current.managed ? spec : withShader(spec, meta, fields, this.range(spec, meta, fields));
    this.ctx.viewer.patchState((ng) => {
      const l = ((ng.layers as Json[] | undefined) ?? []).find((x) => x.name === name);
      if (l === undefined) return;
      l.annotations = next.annotations;
      for (const key of ["annotationProperties", "shader"] as const) {
        if (next[key] === undefined) delete l[key];
        else l[key] = next[key];
      }
    });
    // Annotations written here are not new ones drawn.
    this.remember();
    const saved = this.saved();
    this.save({ ...saved, layers: { ...saved.layers, [name]: prune(next, meta) } });
  }

  /** Edits waiting for an annotation being drawn, by layer (the latest of each). */
  private readonly pending = new Map<string, { spec: LayerSpec; meta: LayerMeta; before: Set<string | undefined>; scene: string | undefined }>();
  private waiting: ReturnType<typeof setInterval> | undefined;

  private waitForDrawing(): void {
    if (this.waiting !== undefined) return;
    this.waiting = setInterval(() => {
      if (this.ctx.viewer.annotationInProgress()) return;
      clearInterval(this.waiting);
      this.waiting = undefined;
      const edits = [...this.pending];
      this.pending.clear();
      // The annotation drawn meanwhile is in the layer now: each edit is applied to the layer as it is.
      for (const [name, { spec, meta, before, scene }] of edits) {
        // An edit made in another scene is not applied to a layer of the same name here.
        if (scene !== activeScene(this.ctx)) continue;
        const now = this.layer(name)?.spec;
        const known = new Set(spec.annotations.map((a) => a.id));
        // Drawn: new since the edit was queued (not ones the edit deleted).
        const drawn = (now?.annotations ?? []).filter((a) => !known.has(a.id) && !before.has(a.id));
        this.write(name, { ...spec, annotations: [...spec.annotations, ...drawn] }, meta);
      }
    }, 250);
  }

  /** Writes only a layer's record (comments, text and terms). */
  writeMeta(name: string, meta: LayerMeta): void {
    // A layer edit waiting for drawing to end keeps these comments and values too.
    const waiting = this.pending.get(name);
    if (waiting !== undefined) waiting.meta = { ...waiting.meta, comments: meta.comments, values: meta.values };
    const saved = this.saved();
    this.save({ ...saved, layers: { ...saved.layers, [name]: meta } });
  }

  /** The range of the number a layer is coloured by. */
  private range(spec: LayerSpec, meta: LayerMeta, fields: Field[]): [number, number] | undefined {
    const field = fields.find((f) => f.id === meta.colourBy && f.kind === "number");
    if (field === undefined) return undefined;
    const values = spec.annotations.map((a) => Number(readValue(field, a, spec, meta))).filter(Number.isFinite);
    if (values.length === 0) return undefined;
    // Not Math.min(...values): that overflows the stack for a large layer.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi];
  }

  /** Makes a local annotation layer in the global space and chooses it. */
  newLayer(name = "annotations"): string {
    const taken = new Set(this.ctx.viewer.layers().map((l) => l.name));
    let unique = name;
    for (let n = 2; taken.has(unique); ++n) unique = `${name} ${n}`;
    this.ctx.viewer.patchState((ng) => {
      const layers = ((ng.layers as Json[] | undefined) ?? []).slice();
      const dimensions = ng.dimensions as Json | undefined;
      layers.push({
        type: "annotation",
        source: dimensions ? { url: "local://annotations", transform: { outputDimensions: dimensions } } : "local://annotations",
        name: unique,
        annotationColor: "#ffd166",
        annotations: [],
      });
      ng.layers = layers;
    });
    this.choose(unique);
    return unique;
  }

  /**
   * Picks a drawing tool on the chosen layer (made when there is none) and
   * selects the layer, since Ctrl+click draws with the selected layer's
   * tool.  The tool already on, on the selected layer, is turned off.
   */
  useTool(tool: string): void {
    const name = this.chosen() ?? this.newLayer();
    const on = this.currentTool() === tool;
    this.ctx.viewer.patchState((ng) => {
      for (const l of (ng.layers as Json[] | undefined) ?? []) {
        // One drawing tool at a time among the layers drawn in here.
        if (l.name !== name && Array.isArray(l.annotations) && typeof l.tool === "string" && l.tool.startsWith("annotate")) delete l.tool;
        if (l.name !== name) continue;
        if (on) delete l.tool;
        else l.tool = tool;
      }
      ng.selectedLayer = { ...((ng.selectedLayer as Json | undefined) ?? {}), layer: name };
    });
  }

  /** The drawing tool Ctrl+click uses in the chosen layer: its tool, while it is the selected layer. */
  currentTool(): string | undefined {
    const name = this.chosen();
    const ng = this.ctx.viewer.getState() as { layers?: Json[]; selectedLayer?: { layer?: string } };
    if (name === undefined || ng.selectedLayer?.layer !== name) return undefined;
    const t = ng.layers?.find((l) => l.name === name)?.tool;
    return typeof t === "string" ? t : undefined;
  }

  /** Where an annotation is: the middle of its points, in global coordinates. */
  centre(layer: string, a: AnnotationJson): number[] | undefined {
    const points = a.point ? [a.point] : (a.points ?? (a.pointA && a.pointB ? [a.pointA, a.pointB] : a.center ? [a.center] : []));
    if (points.length === 0) return undefined;
    const g = points.map(toGlobalOf(this.ctx, layer, rankOf(a)));
    // Dimensions the annotation does not have stay where the view is.
    const position = ((this.ctx.viewer.getState() as { position?: number[] }).position ?? []) as number[];
    return g[0].map((_, i) => {
      const v = g.reduce((s, p) => s + p[i], 0) / g.length;
      return Number.isFinite(v) ? v : (position[i] ?? 0);
    });
  }

  /** Selects an annotation here and in Neuroglancer (its details in the selection panel), and moves the views to it. */
  select(target: Selected | undefined, go = true): void {
    this.selected = target;
    if (target !== undefined) {
      this.lastSelection = `${target.layer}|${target.id}`;
      const a = this.layer(target.layer)?.spec.annotations.find((x) => x.id === target.id);
      this.ctx.viewer.patchState(
        (ng) => {
          ng.selection = { ...((ng.selection as Json | undefined) ?? {}), layers: { [target.layer]: { annotationId: target.id, annotationSource: 0, annotationSubsource: "default" } } };
        },
        { quiet: true },
      );
      const at = go && a ? this.centre(target.layer, a) : undefined;
      if (at) this.ctx.viewer.setPosition(at);
    }
    this.notify();
  }

  /** Deletes annotations (by layer), and their values and comments. */
  delete(items: Selected[]): void {
    const byLayer = new Map<string, Set<string>>();
    for (const s of items) byLayer.set(s.layer, (byLayer.get(s.layer) ?? new Set()).add(s.id));
    for (const [name, ids] of byLayer) {
      const l = this.layer(name);
      if (l === undefined) continue;
      this.write(name, { ...l.spec, annotations: l.spec.annotations.filter((a) => !ids.has(a.id)) }, l.meta);
    }
    if (this.selected && byLayer.get(this.selected.layer)?.has(this.selected.id)) this.selected = undefined;
    this.notify();
  }

  addComment(target: Selected, text: string): void {
    const l = this.layer(target.layer);
    if (l === undefined || text.trim() === "") return;
    const comment: Comment = { time: new Date().toISOString().replace(/\.\d+Z$/, "Z"), text: text.trim() };
    const list = [...(l.meta.comments[target.id] ?? []), comment];
    this.writeMeta(target.layer, { ...l.meta, comments: { ...l.meta.comments, [target.id]: list } });
  }

  removeComment(target: Selected, index: number): void {
    const l = this.layer(target.layer);
    if (l === undefined) return;
    const list = (l.meta.comments[target.id] ?? []).filter((_, i) => i !== index);
    const comments = { ...l.meta.comments, [target.id]: list };
    if (list.length === 0) delete comments[target.id];
    this.writeMeta(target.layer, { ...l.meta, comments });
  }

  // ------------------------------------------------------------ the views

  private sceneId(): string {
    return this.ctx.workspace.scenes().find((s) => s.active)?.id ?? "";
  }

  private ids(layers = this.layers()): Map<string, Set<string>> {
    return new Map(layers.map((l) => [l.spec.name, new Set(l.spec.annotations.map((a) => a.id))]));
  }

  private remember(): void {
    this.known.set(this.sceneId(), this.ids());
  }

  /**
   * After each change to the state: an annotation new to a layer (drawn in
   * a view) is selected, and the table shown when the layer is the one
   * chosen; an annotation Neuroglancer selected is selected here.
   */
  /**
   * A layer renamed (in Neuroglancer or the platform) keeps its record:
   * a name gone and a new one holding the same annotations (by id) are the
   * same layer, so its fields, groups, text values and comments move to it.
   */
  private followRenames(before: Map<string, Set<string>>, now: Map<string, Set<string>>): void {
    const gone = [...before.keys()].filter((n) => !now.has(n));
    const added = [...now.keys()].filter((n) => !before.has(n));
    if (gone.length === 0 || added.length === 0) return;
    const saved = this.saved();
    const records = { ...saved.layers };
    let chosen = saved.layer;
    let moved = false;
    for (const name of added) {
      const ids = now.get(name)!;
      const from = renamedFrom(ids, gone.map((g) => [g, before.get(g)!] as const));
      if (from === undefined || records[from] === undefined || records[name] !== undefined) continue;
      records[name] = records[from];
      delete records[from];
      if (chosen === from) chosen = name;
      if (this.selected?.layer === from) this.selected = { ...this.selected, layer: name };
      moved = true;
    }
    if (moved) this.save({ ...saved, layers: records, ...(chosen !== undefined ? { layer: chosen } : {}) });
  }

  private stateChanged(): void {
    const layers = this.layers();
    const scene = this.sceneId();
    const before = this.known.get(scene);
    const now = this.ids(layers);
    this.known.set(scene, now);
    if (before !== undefined) this.followRenames(before, now);
    if (before !== undefined) {
      for (const l of layers) {
        const old = before.get(l.spec.name);
        if (old === undefined || l.managed) continue;
        const drawn = l.spec.annotations.filter((a) => !old.has(a.id));
        if (drawn.length === 1) {
          this.selected = { layer: l.spec.name, id: drawn[0].id };
          this.lastSelection = `${l.spec.name}|${drawn[0].id}`;
          // The table opens for the layer drawn in from the Annotate section (not Measure's, say).
          if (l.spec.name === this.chosen()) this.ctx.ui.showPanel(TABLE_PANEL);
        }
      }
    }
    const selection = (this.ctx.viewer.getState() as { selection?: { layers?: Record<string, { annotationId?: string }> } }).selection?.layers ?? {};
    for (const [layer, s] of Object.entries(selection)) {
      if (typeof s?.annotationId !== "string" || !now.get(layer)?.has(s.annotationId)) continue;
      const key = `${layer}|${s.annotationId}`;
      if (key !== this.lastSelection) {
        this.lastSelection = key;
        this.selected = { layer, id: s.annotationId };
      }
    }
    if (this.selected && !now.get(this.selected.layer)?.has(this.selected.id)) {
      this.selected = undefined;
    }
    // Listeners redraw only what changed (moving about changes the state too).
    this.notify();
  }

  /** The annotation under the pointer: its name, group, values and comments beside it. */
  private hover(): void {
    const cursor = this.ctx.viewer.cursor();
    const values = cursor.values as Record<string, { annotationId?: string } | undefined>;
    let shown: { row: Row; fields: Field[] } | undefined;
    // Only when the pointer is on an annotation is the state read.
    if (cursor.active && Object.values(values).some((v) => typeof v?.annotationId === "string")) {
      for (const l of this.layers()) {
        const id = values[l.spec.name]?.annotationId;
        if (typeof id !== "string") continue;
        const a = l.spec.annotations.find((x) => x.id === id);
        if (a === undefined) continue;
        const [row] = this.rows([{ ...l, spec: { ...l.spec, annotations: [a] } }]);
        shown = { row, fields: fieldsOf(l.spec, l.meta) };
        break;
      }
    }
    if (shown === undefined) {
      this.tip.hidden = true;
      return;
    }
    const { row, fields } = shown;
    const facts = fields.map((f) => [f.title, row.values[f.title]] as const).filter(([, v]) => v);
    this.tip.replaceChildren(
      el("strong", {}, rowName(row)),
      row.groupPath ? el("div", { class: "an-faint" }, row.groupPath) : "",
      row.size ? el("div", { class: "an-faint" }, physical(row.size.value, row.size.quantity === "length" ? 1 : row.size.quantity === "area" ? 2 : 3)) : "",
      ...facts.map(([k, v]) => el("div", {}, el("span", { class: "an-faint" }, `${k}: `), v)),
      ...row.comments.slice(-3).map((c) => el("div", { class: "an-tip-comment" }, `“${c.text}”`, el("span", { class: "an-faint" }, ` ${c.time.slice(0, 16).replace("T", " ")}`))),
      row.comments.length > 3 ? el("div", { class: "an-faint" }, `and ${row.comments.length - 3} more`) : "",
    );
    const box = this.overlay.element.getBoundingClientRect();
    this.tip.style.left = `${this.pointer[0] - box.left + 14}px`;
    this.tip.style.top = `${this.pointer[1] - box.top + 14}px`;
    this.tip.hidden = false;
  }
}

/**
 * The layer a new one was renamed from: of the layers gone, the one whose
 * annotations (by id) are the new one's, all of them; an empty layer only
 * when it is the one empty layer gone.
 */
export function renamedFrom(ids: Set<string>, gone: (readonly [string, Set<string>])[]): string | undefined {
  const same = gone.filter(([, old]) => old.size === ids.size && [...old].every((id) => ids.has(id)));
  if (same.length !== 1) return undefined;
  if (ids.size === 0 && gone.filter(([, old]) => old.size === 0).length !== 1) return undefined;
  return same[0][0];
}

/** The id of the scene on show (pending edits belong to it). */
function activeScene(ctx: PlatformContext): string | undefined {
  return ctx.workspace.scenes().find((x) => x.active)?.id;
}
