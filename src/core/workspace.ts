/**
 * The workspace model: scenes and datasets.
 *
 * A **dataset** is a piece of data: one source (a URL, or a layer's local
 * annotations).  A **layer** is one way of showing a dataset inside a scene:
 * its colours, shader, visible segments.  A scene usually shows a dataset
 * through one layer, but may show it through several (a filtered copy beside
 * the original, say).  A **scene** is a whole Neuroglancer state.
 *
 * The active scene's state is the workspace's `ng`, so every link stays a
 * valid Neuroglancer link; the platform's record of scenes and datasets lives
 * in `app.platform`, and inactive scenes carry their own state there.  Layers
 * belong to the dataset whose source they read, so any Neuroglancer state
 * opens as a scene with no extra bookkeeping.
 *
 * Everything here is a pure function of plain JSON, so it is tested without
 * a viewer.
 */

export type Json = Record<string, unknown>;

export interface DatasetRecord {
  id: string;
  /** Normalised source(s): how a layer is matched to its dataset. */
  key: string;
  name: string;
  /** The source as a layer specification writes it. */
  source: unknown;
  /** Neuroglancer layer type that shows it best ("image", "segmentation", …), or "auto". */
  kind: string;
}

export interface SceneRecord {
  id: string;
  name: string;
  /** Neuroglancer state of an inactive scene; the active scene's is the workspace `ng`. */
  ng?: Json;
}

export interface PlatformState {
  version: 1;
  scenes: SceneRecord[];
  activeScene: string;
  datasets: DatasetRecord[];
}

export const PLATFORM_KEY = "platform";

export type IdMaker = (prefix: string) => string;

export const randomId: IdMaker = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 8)}`;

// ------------------------------------------------------------------ layers

/** The layer specifications of a Neuroglancer state, in draw order. */
export function layersOf(ng: Json): Json[] {
  const layers = ng.layers;
  if (Array.isArray(layers)) return layers.filter((l): l is Json => typeof l === "object" && l !== null);
  if (typeof layers === "object" && layers !== null) {
    return Object.entries(layers as Json).map(([name, spec]) =>
      typeof spec === "string" ? { name, source: spec } : { ...(spec as Json), name },
    );
  }
  return [];
}

export function layerName(spec: Json): string {
  return typeof spec.name === "string" ? spec.name : "";
}

/** The URLs in a layer specification's `source`, which may be a string, an object or a list. */
export function sourceUrls(source: unknown): string[] {
  const one = (s: unknown): string | undefined => {
    if (typeof s === "string") return s;
    if (typeof s === "object" && s !== null && typeof (s as Json).url === "string") return (s as Json).url as string;
    return undefined;
  };
  const list = Array.isArray(source) ? source : [source];
  return list.map(one).filter((u): u is string => u !== undefined && u.trim() !== "");
}

/**
 * A file made in the page from another dataset (a track group's own
 * streamlines): a layer's source under it is a view of that dataset, not a
 * dataset of its own (see LocalData.openFile).
 */
export const DERIVED_LOCAL = /\/local\/derived-[0-9a-f]+\//;

/** A URL in comparable form: trimmed, no trailing slash before a `|` adapter or the end. */
export function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+(?=\||$)/g, "");
}

/**
 * Which dataset a layer shows.  Layers with a data source share a dataset
 * when their sources match; a layer without one (local annotations) is its
 * own dataset.  A lookup table (`lut://`, segment names) describes how a
 * layer shows its data, not which data it is.
 */
export function datasetKey(spec: Json): string {
  const urls = sourceUrls(spec.source).filter((u) => !u.startsWith("local://") && !u.startsWith("lut://") && !DERIVED_LOCAL.test(u));
  if (urls.length === 0) return `layer:${layerName(spec)}`;
  return urls.map(normaliseUrl).join("\n");
}

export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base} ${i}`;
    if (!names.has(name)) return name;
  }
}

// ---------------------------------------------------------------- platform

export function emptyPlatform(makeId: IdMaker = randomId): PlatformState {
  const id = makeId("s-");
  return { version: 1, scenes: [{ id, name: "Scene 1" }], activeScene: id, datasets: [] };
}

/**
 * Reads `app.platform`, repairing what a hand-edited or older link may lack.
 * Returns a fresh workspace with one scene when there is none.
 */
export function readPlatform(app: Json, makeId: IdMaker = randomId): PlatformState {
  const raw = app[PLATFORM_KEY];
  if (typeof raw !== "object" || raw === null) return emptyPlatform(makeId);
  const p = raw as Partial<PlatformState>;
  const scenes = (Array.isArray(p.scenes) ? p.scenes : [])
    .filter((s): s is SceneRecord => typeof s === "object" && s !== null && typeof s.id === "string")
    .map((s) => ({ id: s.id, name: typeof s.name === "string" ? s.name : "Scene", ...(s.ng ? { ng: s.ng } : {}) }));
  if (scenes.length === 0) return { ...emptyPlatform(makeId), datasets: readDatasets(p.datasets) };
  const activeScene = scenes.some((s) => s.id === p.activeScene) ? (p.activeScene as string) : scenes[0].id;
  return { version: 1, scenes, activeScene, datasets: readDatasets(p.datasets) };
}

function readDatasets(raw: unknown): DatasetRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is DatasetRecord => typeof d === "object" && d !== null && typeof d.id === "string" && typeof d.key === "string")
    .map((d) => ({ id: d.id, key: d.key, name: String(d.name ?? d.key), source: d.source, kind: String(d.kind ?? "auto") }));
}

/** The resolved type of each layer, by name, as the viewer reports it. */
export type LayerTypes = Record<string, string>;

/**
 * Adds a dataset for every layer whose source no dataset holds yet, and
 * fills in a dataset's kind once the viewer has resolved its layer's type.
 * Datasets are never dropped here: one used by no scene stays in the
 * workspace, ready to add back.
 */
export function syncDatasets(
  p: PlatformState,
  ng: Json,
  types: LayerTypes = {},
  makeId: IdMaker = randomId,
): PlatformState {
  let datasets = p.datasets;
  let changed = false;
  for (const spec of layersOf(ng)) {
    const key = datasetKey(spec);
    const name = layerName(spec);
    const type = types[name] ?? (typeof spec.type === "string" ? spec.type : "auto");
    const known = datasets.find((d) => d.key === key);
    if (known === undefined) {
      datasets = [
        ...datasets,
        { id: makeId("d-"), key, name: uniqueName(name || "dataset", datasets.map((d) => d.name)), source: spec.source, kind: type },
      ];
      changed = true;
    } else if ((known.kind === "auto" || known.kind === "new") && type !== "auto" && type !== "new") {
      datasets = datasets.map((d) => (d === known ? { ...d, kind: type } : d));
      changed = true;
    }
  }
  return changed ? { ...p, datasets } : p;
}

export interface SceneDataset {
  dataset: DatasetRecord;
  /** Names of the layers showing it, in draw order. */
  layers: string[];
}

/** The datasets a scene shows, in the order of their first layer. */
export function sceneDatasets(p: PlatformState, ng: Json): SceneDataset[] {
  const result = new Map<string, SceneDataset>();
  for (const spec of layersOf(ng)) {
    const dataset = p.datasets.find((d) => d.key === datasetKey(spec));
    if (dataset === undefined) continue;
    let entry = result.get(dataset.id);
    if (entry === undefined) {
      entry = { dataset, layers: [] };
      result.set(dataset.id, entry);
    }
    entry.layers.push(layerName(spec));
  }
  return [...result.values()];
}

export function datasetOfLayer(p: PlatformState, ng: Json, layer: string): DatasetRecord | undefined {
  const spec = layersOf(ng).find((l) => layerName(l) === layer);
  if (spec === undefined) return undefined;
  const key = datasetKey(spec);
  return p.datasets.find((d) => d.key === key);
}

/** A new layer specification that shows `dataset`, named so no layer in `ng` clashes. */
export function layerForDataset(dataset: DatasetRecord, ng: Json, name = dataset.name): Json {
  const spec: Json = { type: dataset.kind === "new" ? "auto" : dataset.kind, source: dataset.source, name };
  spec.name = uniqueName(name, layersOf(ng).map(layerName));
  return spec;
}

/** Records a new dataset for `source` (or returns the one already holding it). */
export function addDataset(
  p: PlatformState,
  source: unknown,
  name: string,
  kind = "auto",
  makeId: IdMaker = randomId,
): { platform: PlatformState; dataset: DatasetRecord } {
  const key = datasetKey({ source, name });
  const known = p.datasets.find((d) => d.key === key);
  if (known !== undefined) return { platform: p, dataset: known };
  const dataset: DatasetRecord = {
    id: makeId("d-"),
    key,
    name: uniqueName(name || "dataset", p.datasets.map((d) => d.name)),
    source,
    kind,
  };
  return { platform: { ...p, datasets: [...p.datasets, dataset] }, dataset };
}

export function renameDataset(p: PlatformState, id: string, name: string): PlatformState {
  const trimmed = name.trim();
  if (trimmed === "") return p;
  return { ...p, datasets: p.datasets.map((d) => (d.id === id ? { ...d, name: trimmed } : d)) };
}

/** Drops a dataset from the workspace; scenes still showing it must lose those layers first. */
export function forgetDataset(p: PlatformState, id: string): PlatformState {
  return { ...p, datasets: p.datasets.filter((d) => d.id !== id) };
}

/** Datasets no scene shows. */
export function unusedDatasets(p: PlatformState, activeNg: Json): DatasetRecord[] {
  const used = new Set<string>();
  const scan = (ng: Json) => layersOf(ng).forEach((l) => used.add(datasetKey(l)));
  scan(activeNg);
  for (const scene of p.scenes) if (scene.id !== p.activeScene && scene.ng) scan(scene.ng);
  return p.datasets.filter((d) => !used.has(d.key));
}

// ------------------------------------------------------------------ scenes

export function activeScene(p: PlatformState): SceneRecord {
  return p.scenes.find((s) => s.id === p.activeScene) ?? p.scenes[0];
}

/** The parts of a scene a new, empty scene inherits: the layout. */
export function emptySceneFrom(ng: Json): Json {
  const out: Json = {};
  // Not the dimensions: the first data added sets them, in its own units (an
  // EM volume in nanometres, a TIFF stack in micrometres), and the zoom fits it.
  if (ng.layout !== undefined) out.layout = ng.layout;
  return out;
}

/**
 * Makes scene `id` active.  Returns the new record and the Neuroglancer state
 * to show; `currentNg` (the active scene's live state) is stored on the scene
 * it came from.
 */
export function switchScene(p: PlatformState, currentNg: Json, id: string): { platform: PlatformState; ng: Json } {
  const target = p.scenes.find((s) => s.id === id);
  if (target === undefined || id === p.activeScene) return { platform: p, ng: currentNg };
  const scenes = p.scenes.map((s) => {
    if (s.id === p.activeScene) return { ...s, ng: currentNg };
    if (s.id === id) {
      const { ng: _ng, ...rest } = s;
      return rest;
    }
    return s;
  });
  return { platform: { ...p, scenes, activeScene: id }, ng: target.ng ?? {} };
}

/** Adds a scene after the active one and switches to it: empty, or a copy of the current scene. */
export function addScene(
  p: PlatformState,
  currentNg: Json,
  options: { copy?: boolean; name?: string } = {},
  makeId: IdMaker = randomId,
): { platform: PlatformState; ng: Json; id: string } {
  const id = makeId("s-");
  const current = activeScene(p);
  const base = options.name ?? (options.copy ? `${current.name} copy` : `Scene ${p.scenes.length + 1}`);
  const name = uniqueName(base, p.scenes.map((s) => s.name));
  const ng = options.copy ? structuredClone(currentNg) : emptySceneFrom(currentNg);
  const index = p.scenes.findIndex((s) => s.id === p.activeScene);
  const scenes = p.scenes.map((s) => (s.id === p.activeScene ? { ...s, ng: currentNg } : s));
  scenes.splice(index + 1, 0, { id, name });
  return { platform: { ...p, scenes, activeScene: id }, ng, id };
}

export function renameScene(p: PlatformState, id: string, name: string): PlatformState {
  const trimmed = name.trim();
  if (trimmed === "") return p;
  return { ...p, scenes: p.scenes.map((s) => (s.id === id ? { ...s, name: trimmed } : s)) };
}

/**
 * Removes a scene.  Removing the active scene switches to its neighbour,
 * whose state is returned as `ng`; removing the only scene leaves a blank
 * one in its place, so there is always a scene.
 */
export function removeScene(p: PlatformState, currentNg: Json, id: string, makeId: IdMaker = randomId): { platform: PlatformState; ng: Json } {
  if (!p.scenes.some((s) => s.id === id)) return { platform: p, ng: currentNg };
  if (p.scenes.length === 1) {
    const blank = { id: makeId("s-"), name: "Scene 1" };
    return { platform: { ...p, scenes: [blank], activeScene: blank.id }, ng: emptySceneFrom(currentNg) };
  }
  const index = p.scenes.findIndex((s) => s.id === id);
  if (id !== p.activeScene) {
    return { platform: { ...p, scenes: p.scenes.filter((s) => s.id !== id) }, ng: currentNg };
  }
  const neighbour = p.scenes[index + 1] ?? p.scenes[index - 1];
  const switched = switchScene(p, currentNg, neighbour.id);
  return { platform: { ...switched.platform, scenes: switched.platform.scenes.filter((s) => s.id !== id) }, ng: switched.ng };
}

export function moveScene(p: PlatformState, id: string, toIndex: number): PlatformState {
  const from = p.scenes.findIndex((s) => s.id === id);
  if (from === -1) return p;
  const scenes = [...p.scenes];
  const [scene] = scenes.splice(from, 1);
  scenes.splice(Math.max(0, Math.min(toIndex, scenes.length)), 0, scene);
  return { ...p, scenes };
}
