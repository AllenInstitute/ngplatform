/**
 * Surfaces for the WebGPU path tracer (./geometry.wgsl): the packed blocks
 * (geometry/surfaces.ts) as one storage buffer, the WebGL texture's regions
 * without their rows, after a block of numbers that says where they are and
 * how each layer is drawn (G_* in geometry.wgsl). One buffer, as a stage has
 * at most 8 storage buffers (WebGPU's least limit) and the tracer has 7 of
 * its own.
 */
import { DEFAULT_SURFACE, GEO_LAYERS, geoData, geoLayout, type LiveGeometryLook } from "../geometry/live_geometry.js";
import type { Surfaces } from "../geometry/surfaces.js";

/** geometry.wgsl's layout of G. */
export const G = { N: 0, ROOT: 1, PRIM_AT: 2, NODE_AT: 3, OBJ_AT: 4, NCLIP: 5, EPS: 9, FROM_WORLD: 10, MAT: 22, CROP: 38, CLIPS: 62, SIZE: 160 } as const;
/** vec4u the numbers take, before the regions. */
export const G_VEC4 = G.SIZE / 4;
/** Cuts a layer, as geometry.wgsl takes them. */
export const GEO_CLIPS = 6;

/**
 * The surfaces as one buffer (vec4u each): room for the numbers (geometryParams, written there each view), then
 * vertices, primitives, nodes, and the objects' colours and layers (`colours`, rgb and layer + 1).
 */
export function geometryBuffer(s: Surfaces, colours: Float32Array): Uint32Array {
  const { objAt } = geoLayout(s, 1);
  const out = new Uint32Array(4 * (G_VEC4 + objAt + Math.max(s.objectCount, 1)));
  out.set(geoData(s, 1).subarray(0, 4 * objAt), 4 * G_VEC4);
  out.set(new Uint32Array(colours.buffer, colours.byteOffset, Math.min(colours.length, 4 * s.objectCount)), 4 * (G_VEC4 + objAt));
  return out;
}

/** Where the objects' colours start in geometryBuffer's (bytes). */
export function objectsByteOffset(s: Surfaces): number {
  return 16 * (G_VEC4 + geoLayout(s, 1).objAt);
}

/**
 * The block G for surfaces `s` (none: nothing traced), drawn as `look` says, placed by `geoFromWorld` (row-major
 * 4 × 4); a ray leaving a surface starts `eps` (world) from it.
 */
export function geometryParams(s: Surfaces | undefined, look: Pick<LiveGeometryLook, "layers"> | undefined, geoFromWorld: readonly number[], eps: number): Uint32Array {
  const out = new Uint32Array(G.SIZE);
  if (s === undefined || s.n === 0 || look === undefined) return out;
  const f = new Float32Array(out.buffer);
  const { primAt, nodeAt, objAt } = geoLayout(s, 1);
  out[G.N] = s.n;
  out[G.ROOT] = s.root;
  out[G.PRIM_AT] = G_VEC4 + primAt;
  out[G.NODE_AT] = G_VEC4 + nodeAt;
  out[G.OBJ_AT] = G_VEC4 + objAt;
  f[G.EPS] = eps;
  f.set(geoFromWorld.slice(0, 12), G.FROM_WORLD);
  for (let li = 0; li < GEO_LAYERS; ++li) {
    const l = look.layers[li];
    const m = l?.material ?? DEFAULT_SURFACE;
    f.set([m.roughness, m.specular, m.emission, m.opacity], G.MAT + 4 * li);
    f.set([...(l?.crop?.[0] ?? [-1e30, -1e30, -1e30]), ...(l?.crop?.[1] ?? [1e30, 1e30, 1e30])], G.CROP + 6 * li);
    const clips = (l?.clips ?? []).slice(0, GEO_CLIPS);
    out[G.NCLIP + li] = clips.length;
    clips.forEach((c, i) => f.set(c.slice(0, 4), G.CLIPS + 4 * (GEO_CLIPS * li + i)));
  }
  return out;
}
