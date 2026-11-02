/**
 * The scene as the Annotations sections read it: the global space,
 * annotation layers and their annotations placed in it, and image layers
 * placed through their transforms.
 */
import type { Json, PlatformContext } from "@ngplatform/sdk";
import { annotationToGlobal, type GlobalSpace, globalSpace, invertOr, type Mat4, placement, type Placement } from "./geometry.js";
import type { AnnotationJson } from "./measure.js";
import type { ImageLevel } from "./voxels.js";

export interface AnnotationLayer {
  name: string;
  annotations: AnnotationJson[];
}

export function space(ctx: PlatformContext): GlobalSpace {
  return globalSpace(ctx.viewer.getState());
}

/** Annotation layers in the active scene with annotations kept in the state (local ones). */
export function annotationLayers(ctx: PlatformContext): AnnotationLayer[] {
  const layers = ((ctx.viewer.getState() as { layers?: Json[] }).layers ?? []) as { name: string; type?: string; annotations?: AnnotationJson[] }[];
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
