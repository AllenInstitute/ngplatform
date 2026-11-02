/**
 * Segmentations drawn as outlines in the 2-D views (see ./outline_shader.ts
 * for how).  Turning outlines on for a segmentation layer adds an image
 * layer just above it, "<name> outlines", reading the same labels, and sets
 * the segmentation's own 2-D opacity to 0 (meshes and the 3-D view are
 * untouched); turning them off removes it and gives the opacity back.
 * While an outline layer exists its shader follows the segmentation's
 * colours and visible segments.  Everything is in the Neuroglancer state,
 * so links, scenes and undo keep it.
 */
import { DataType, ImageUserLayer, SegmentationUserLayer, type UserLayer, type Viewer } from "./neuroglancer.js";
import { outlineOf, outlineShader } from "./outline_shader.js";

type Json = Record<string, unknown>;

interface Host {
  viewer: Viewer;
  addLayer(spec: Json, options?: { index?: number }): string;
  removeLayer(name: string): void;
}

let host: Host | undefined;

/** The image layer drawing a segmentation layer's outlines, if any. */
function outlineLayerOf(name: string): ImageUserLayer | undefined {
  for (const managed of host?.viewer.layerManager.managedLayers ?? []) {
    const layer = managed.layer;
    if (layer instanceof ImageUserLayer && outlineOf(layer.fragmentMain.value)?.layer === name) return layer;
  }
  return undefined;
}

export function hasOutlines(name: string): boolean {
  return outlineLayerOf(name) !== undefined;
}

/** The shader for a segmentation layer's outlines, from its colours now. */
function shaderFor(seg: SegmentationUserLayer, name: string, fill: [number, number]): string | undefined {
  const ds = seg.displayState as any;
  const volume = seg.dataSources
    .flatMap((s) => (s.loadState !== undefined && !("error" in s.loadState && s.loadState.error) ? (s.loadState as any).subsources ?? [] : []))
    .map((sub: any) => sub.subsourceEntry?.subsource?.volume)
    .find((v: any) => v !== undefined);
  if (volume === undefined) return undefined;
  const colours = ds.segmentationColorGroupState.value;
  const stated: [bigint, [number, number, number]][] = [];
  for (const [id, packed] of colours.segmentStatedColors as Iterable<[bigint, bigint]>) {
    const c = Number(packed);
    stated.push([id, [(c & 0xff) / 255, ((c >> 8) & 0xff) / 255, ((c >> 16) & 0xff) / 255]]);
  }
  const group = ds.segmentationGroupState.value;
  const visible = group.visibleSegments as { size: number } & Iterable<bigint>;
  const showAll = visible.size === 0 && ds.ignoreNullVisibleSet.value;
  const fixed = colours.segmentDefaultColor.value as Float32Array | undefined;
  return outlineShader({
    layer: name,
    dataType: DataType[volume.dataType as number].toLowerCase(),
    seed: colours.segmentColorHash.value,
    saturation: ds.saturation.value,
    hideSegmentZero: ds.hideSegmentZero.value,
    stated,
    fixed: fixed === undefined ? undefined : [fixed[0], fixed[1], fixed[2]],
    visible: showAll ? undefined : [...visible],
    fill,
  });
}

/** Turns a segmentation layer's outlines on or off. */
export function setOutlines(name: string, on: boolean): void {
  if (host === undefined) return;
  const managed = host.viewer.layerManager.getLayerByName(name);
  const seg = managed?.layer;
  if (!(seg instanceof SegmentationUserLayer)) return;
  const ds = seg.displayState as any;
  const existing = outlineLayerOf(name);
  if (!on) {
    if (existing === undefined) return;
    const { fill } = outlineOf(existing.fragmentMain.value)!;
    host.removeLayer(existing.managedLayer.name);
    ds.selectedAlpha.value = fill[0];
    ds.notSelectedAlpha.value = fill[1];
    return;
  }
  if (existing !== undefined) return;
  const fill: [number, number] = [ds.selectedAlpha.value, ds.notSelectedAlpha.value];
  const shader = shaderFor(seg, name, fill);
  if (shader === undefined) throw new Error("The segmentation has no volume loaded to outline yet.");
  // The labels' own source (the first one, with its transform), not its meshes or a lookup table.
  const sources = (managed!.toJSON() as Json).source;
  const first = Array.isArray(sources) ? sources[0] : sources;
  const lm = host.viewer.layerManager;
  host.addLayer(
    { type: "image", name: `${name} outlines`, source: first, shader, opacity: 1, blend: "default", volumeRendering: false },
    { index: lm.managedLayers.indexOf(managed!) + 1 },
  );
  ds.selectedAlpha.value = 0;
  ds.notSelectedAlpha.value = 0;
}

/** Rewrites outline shaders whose segmentation's colours or segments changed. */
function refresh(): void {
  if (host === undefined) return;
  for (const managed of host.viewer.layerManager.managedLayers) {
    const layer = managed.layer;
    if (!(layer instanceof ImageUserLayer)) continue;
    const about = outlineOf(layer.fragmentMain.value);
    if (about === undefined) continue;
    const seg = host.viewer.layerManager.getLayerByName(about.layer)?.layer;
    if (!(seg instanceof SegmentationUserLayer)) continue;
    const shader = shaderFor(seg, about.layer, about.fill);
    if (shader !== undefined && shader !== layer.fragmentMain.value) layer.fragmentMain.value = shader;
  }
}

/**
 * Watches the segmentation layers that have outlines, while the engine
 * lives.  Returns a disposer.
 */
export function watchOutlines(engine: Host): () => void {
  host = engine;
  const lm = engine.viewer.layerManager;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Colour edits come in bursts (a lookup table sets hundreds): once they settle.
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  };
  const watched = new Map<UserLayer, () => void>();
  const bind = () => {
    const wanted = new Set<UserLayer>();
    for (const managed of lm.managedLayers) {
      const layer = managed.layer;
      if (layer instanceof SegmentationUserLayer && hasOutlines(managed.name)) wanted.add(layer);
    }
    for (const [layer, off] of watched) {
      if (!wanted.has(layer)) {
        off();
        watched.delete(layer);
      }
    }
    for (const layer of wanted) {
      if (watched.has(layer)) continue;
      const ds = (layer as SegmentationUserLayer).displayState as any;
      const colours = () => ds.segmentationColorGroupState.value;
      const group = () => ds.segmentationGroupState.value;
      const offs = [
        ds.segmentationColorGroupState.changed.add(soon),
        ds.segmentationGroupState.changed.add(soon),
        colours().segmentStatedColors.changed.add(soon),
        colours().segmentColorHash.changed.add(soon),
        colours().segmentDefaultColor.changed.add(soon),
        ds.saturation.changed.add(soon),
        ds.hideSegmentZero.changed.add(soon),
        ds.ignoreNullVisibleSet.changed.add(soon),
        group().visibleSegments.changed.add(soon),
      ];
      watched.set(layer, () => offs.forEach((off: () => void) => off()));
    }
    soon();
  };
  const offLayers = lm.layersChanged.add(bind);
  const offSpec = lm.specificationChanged.add(() => {
    // A shader edited, a layer renamed: bind again (cheap).
    clearTimeout(rebind);
    rebind = setTimeout(bind, 200);
  });
  let rebind: ReturnType<typeof setTimeout> | undefined;
  bind();
  return () => {
    offLayers();
    offSpec();
    clearTimeout(timer);
    clearTimeout(rebind);
    for (const off of watched.values()) off();
    watched.clear();
    if (host === engine) host = undefined;
  };
}
