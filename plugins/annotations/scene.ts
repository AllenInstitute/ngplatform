/**
 * The scene as the Annotations sections read it: the global space,
 * annotation layers and their annotations placed in it, and image layers
 * placed through their transforms.
 */
import type { Disposer, Json, PlatformContext } from "@ngplatform/sdk";
import { annotationToGlobal, type GlobalSpace, globalSpace, invertOr, type Mat4, placement, type Placement } from "./geometry.js";
import type { AnnotationJson } from "./measure.js";
import type { ImageLevel } from "./voxels.js";

export interface AnnotationLayer {
  name: string;
  annotations: AnnotationJson[];
}

export function space(ctx: PlatformContext): GlobalSpace {
  return globalSpace({ dimensions: statePart(ctx, "dimensions") } as Json);
}

/**
 * The state's layers as last read.  Writing out the state writes out every
 * annotation, so they are read again only when a layer changes (the
 * viewer's layers generation), not each time the view moves.  The arrays
 * are shared: never changed in place.
 */
const readLayers = new WeakMap<PlatformContext, { generation: number; layers: Json[] }>();

export function stateLayers(ctx: PlatformContext): Json[] {
  const generation = ctx.viewer.layersGeneration?.();
  const known = readLayers.get(ctx);
  if (generation !== undefined && known?.generation === generation) return known.layers;
  const layers = ((ctx.viewer.getState() as { layers?: Json[] }).layers ?? []) as Json[];
  if (generation !== undefined) readLayers.set(ctx, { generation, layers });
  return layers;
}

/** One top-level key of the state (`selection`, `position`…), without writing out the layers when the viewer can. */
export function statePart<T = unknown>(ctx: PlatformContext, key: string): T | undefined {
  return (ctx.viewer.statePart ? ctx.viewer.statePart(key) : (ctx.viewer.getState() as Record<string, unknown>)[key]) as T | undefined;
}

/**
 * Calls back when what the Annotations sections show may have changed: a
 * layer (its annotations among it), the selection, the selected layer or
 * the global dimensions; not when the view only moves.  A viewer that
 * cannot tell a layer's change calls back on every change of state.
 */
export function onSceneChanged(ctx: PlatformContext, callback: () => void): Disposer {
  const keyNow = () => {
    const generation = ctx.viewer.layersGeneration?.();
    return generation === undefined ? undefined : JSON.stringify([generation, statePart(ctx, "selection") ?? null, statePart(ctx, "selectedLayer") ?? null, statePart(ctx, "dimensions") ?? null]);
  };
  // As the caller has drawn it.
  let last = keyNow();
  const check = () => {
    const key = keyNow();
    if (key !== undefined && key === last) return;
    last = key;
    callback();
  };
  const offs = [ctx.viewer.onStateChanged(check), ctx.viewer.onLayersChanged(check)];
  return () => offs.forEach((off) => off());
}

/** Annotation layers in the active scene with annotations kept in the state (local ones). */
export function annotationLayers(ctx: PlatformContext): AnnotationLayer[] {
  const layers = stateLayers(ctx) as unknown as { name: string; type?: string; annotations?: AnnotationJson[] }[];
  return layers.filter((l) => Array.isArray(l.annotations)).map((l) => ({ name: l.name, annotations: l.annotations! }));
}

/** The rank of an annotation's coordinates. */
export function rankOf(a: AnnotationJson): number {
  return (a.point ?? a.pointA ?? a.center ?? a.points?.[0] ?? []).length;
}

/** An annotation layer's coordinates to global positions. */
export function toGlobalOf(ctx: PlatformContext, layer: string, rank: number): (p: ArrayLike<number>) => number[] {
  return annotationToGlobal(ctx.viewer.layerTransform(layer), space(ctx), rank);
}

/**
 * From global coordinates (of `dims`, in order) to an annotation layer's
 * own (3-D layers): the inverse of its transform; undefined otherwise.
 */
export function annotationFromGlobal(ctx: PlatformContext, layer: string, dims: number[]): Mat4 | undefined {
  const toGlobal = toGlobalOf(ctx, layer, 3);
  // The map is affine: read it off at the origin and the unit points.
  const o = toGlobal([0, 0, 0]);
  const cols = [0, 1, 2].map((k) => toGlobal([0, 1, 2].map((i) => (i === k ? 1 : 0))));
  if (dims.some((d) => !Number.isFinite(o[d]))) return undefined;
  const forward = new Float64Array(16);
  forward[15] = 1;
  dims.forEach((d, r) => {
    for (let c = 0; c < 3; ++c) forward[4 * r + c] = cols[c][d] - o[d];
    forward[4 * r + 3] = o[d];
  });
  return invertOr(forward);
}

/** Where an image layer's level shows in the global space. */
export function imagePlacement(ctx: PlatformContext, layer: string, level: ImageLevel): Placement | undefined {
  return placement(ctx.viewer.layerTransform(layer), level.voxelToRas, space(ctx));
}
