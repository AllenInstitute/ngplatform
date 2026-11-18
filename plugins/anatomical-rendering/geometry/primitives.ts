/**
 * Geometry for the path tracer from what Luxar's reader builds: a mesh's
 * triangles in physical millimetres (placed as the layer is), each with its
 * object and its corners' normals, packed for the GPU.
 */
import type { BuiltChunk } from "../../luxar/chunk_build.js";
import { CONE, SPHERE, TRIANGLE } from "./lbvh.js";

/**
 * Primitives before the BVH, indexed: their vertices (4 floats each: xyz in millimetres, then a triangle corner's
 * packed normal as bits (NO_NORMAL: none), or a sphere's or tube end's radius), each primitive's vertices (3 each:
 * a triangle's corners; a tube's two ends, the second again; a sphere's centre, thrice), kind (lbvh.ts) and object.
 */
export interface Primitives {
  vertices: Float32Array;
  index: Uint32Array;
  objects: Int32Array;
  kinds: Int32Array;
}

/** A vertex's w when it has no normal (a triangle's corners then take the face's). */
export const NO_NORMAL = 0xffffffff;

/** The primitives as lbvh.ts takes them (9 floats each: a triangle's corners; a cone's ends and radii; a sphere's centre and radius). */
export function expandPrims(p: Primitives): Float32Array {
  const n = p.objects.length, v = p.vertices, out = new Float32Array(9 * n);
  for (let i = 0; i < n; ++i) {
    const a = p.index[3 * i], b = p.index[3 * i + 1], c = p.index[3 * i + 2], o = 9 * i;
    const k = p.kinds[i];
    if (k === TRIANGLE) {
      for (const [j, x] of [a, b, c].entries()) out.set(v.subarray(4 * x, 4 * x + 3), o + 3 * j);
    } else if (k === CONE) {
      out.set(v.subarray(4 * a, 4 * a + 4), o);
      out.set(v.subarray(4 * b, 4 * b + 4), o + 4);
    } else out.set(v.subarray(4 * a, 4 * a + 4), o);
  }
  return out;
}

/** A normal (any length) as two snorm16 in one uint (unpackSnorm2x16's), octahedral. */
export function packNormal(x: number, y: number, z: number): number {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / s, v = y / s;
  if (z < 0) [u, v] = [(1 - Math.abs(v)) * (u >= 0 ? 1 : -1), (1 - Math.abs(u)) * (v >= 0 ? 1 : -1)];
  const q = (a: number) => Math.round(Math.min(1, Math.max(-1, a)) * 32767) & 0xffff;
  return (q(u) | (q(v) << 16)) >>> 0;
}

/** The normal a packed one stands for (unit), as the shader unpacks it. */
export function unpackNormal(p: number): [number, number, number] {
  const s = (h: number) => Math.max(((h << 16) >> 16) / 32767, -1);
  const u = s(p & 0xffff), v = s(p >>> 16);
  let x = u, y = v;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) [x, y] = [(1 - Math.abs(v)) * (u >= 0 ? 1 : -1), (1 - Math.abs(u)) * (v >= 0 ? 1 : -1)];
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** A chunk's object id in `slot`. */
function idOf(c: BuiltChunk, slot: number): bigint {
  return (BigInt(c.objectIds[2 * slot + 1]) << 32n) | BigInt(c.objectIds[2 * slot]);
}

/**
 * The chunks' triangles as primitives, in physical millimetres: `toMm` (row-major 4 × 4) takes store coordinates
 * there (the store's units and the layer's placement). Each triangle's object is its index in `ids` (an object met
 * first is added).
 */
export function meshPrimitives(chunks: readonly BuiltChunk[], toMm: readonly number[], ids: bigint[]): Primitives {
  const count = chunks.reduce((s, c) => s + c.triangleCount, 0);
  const nv = chunks.reduce((s, c) => s + (c.triangleCount > 0 ? c.vertexCount : 0), 0);
  const vertices = new Float32Array(4 * nv), bits = new Uint32Array(vertices.buffer);
  const index = new Uint32Array(3 * count), objects = new Int32Array(count);
  const indexOf = new Map<bigint, number>(ids.map((id, i) => [id, i]));
  const m = toMm;
  // Normals by the inverse transpose of the linear part.
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const it = [
    (a[4] * a[8] - a[5] * a[7]) / det, -(a[3] * a[8] - a[5] * a[6]) / det, (a[3] * a[7] - a[4] * a[6]) / det,
    -(a[1] * a[8] - a[2] * a[7]) / det, (a[0] * a[8] - a[2] * a[6]) / det, -(a[0] * a[7] - a[1] * a[6]) / det,
    (a[1] * a[5] - a[2] * a[4]) / det, -(a[0] * a[5] - a[2] * a[3]) / det, (a[0] * a[4] - a[1] * a[3]) / det,
  ];
  let f = 0, base = 0;
  for (const c of chunks) {
    if (c.triangleCount === 0) continue;
    const v = c.vertices, nr = c.normals, n = c.vertexCount, normals = nr.length >= 4 * n;
    for (let i = 0; i < n; ++i) {
      const x = v[4 * i], y = v[4 * i + 1], z = v[4 * i + 2], o = 4 * (base + i);
      vertices[o] = m[0] * x + m[1] * y + m[2] * z + m[3];
      vertices[o + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      vertices[o + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
      if (normals) {
        const p = nr[4 * i], q = nr[4 * i + 1], r = nr[4 * i + 2];
        bits[o + 3] = packNormal(it[0] * p + it[1] * q + it[2] * r, it[3] * p + it[4] * q + it[5] * r, it[6] * p + it[7] * q + it[8] * r);
      } else bits[o + 3] = NO_NORMAL;
    }
    const slotIndex = Array.from({ length: c.objectIds.length / 2 }, (_, s) => {
      const id = idOf(c, s);
      let g = indexOf.get(id);
      if (g === undefined) {
        g = ids.length;
        ids.push(id);
        indexOf.set(id, g);
      }
      return g;
    });
    const t = c.triangles;
    for (let k = 0; k < c.triangleCount; ++k, ++f) {
      index[3 * f] = base + t[3 * k];
      index[3 * f + 1] = base + t[3 * k + 1];
      index[3 * f + 2] = base + t[3 * k + 2];
      objects[f] = slotIndex[c.slots[t[3 * k]]] ?? 0;
    }
    base += n;
  }
  orientOutward(vertices, index, objects, f);
  return { vertices, index, objects, kinds: new Int32Array(f).fill(TRIANGLE) };
}

/**
 * Each object's triangles wound outward (counter-clockwise seen from outside), as the tracers' capped cuts take a
 * surface met from behind as the inside of a solid: an object whose signed volume is negative (wound inward, or
 * mirrored by its transform) has every triangle turned over.
 */
export function orientOutward(vertices: Float32Array, index: Uint32Array, objects: Int32Array, count: number): void {
  const volume = new Map<number, number>();
  for (let k = 0; k < count; ++k) {
    const a = 4 * index[3 * k], b = 4 * index[3 * k + 1], c = 4 * index[3 * k + 2];
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
    const cx = vertices[c], cy = vertices[c + 1], cz = vertices[c + 2];
    const v = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    volume.set(objects[k], (volume.get(objects[k]) ?? 0) + v);
  }
  for (let k = 0; k < count; ++k) {
    if ((volume.get(objects[k]) ?? 0) >= 0) continue;
    const t = index[3 * k + 1];
    index[3 * k + 1] = index[3 * k + 2];
    index[3 * k + 2] = t;
  }
}

/** A point at store coordinates, and its object's index (its colour's); -1 leaves it out. */
export interface IndexedPoint {
  x: number;
  y: number;
  z: number;
  index: number;
}

/** Points as spheres of `radius` mm about where `toMm` (row-major 4 × 4) puts them. */
export function pointPrimitives(points: Iterable<IndexedPoint>, toMm: readonly number[], radius: number): Primitives {
  const m = toMm;
  let vertices = new Float32Array(4 * 1024), objects = new Int32Array(1024);
  let n = 0;
  for (const p of points) {
    if (p.index < 0) continue;
    if (n === objects.length) {
      // Twice the room.
      const v2 = new Float32Array(vertices.length * 2), o2 = new Int32Array(objects.length * 2);
      v2.set(vertices);
      o2.set(objects);
      [vertices, objects] = [v2, o2];
    }
    vertices[4 * n] = m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3];
    vertices[4 * n + 1] = m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7];
    vertices[4 * n + 2] = m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11];
    vertices[4 * n + 3] = radius;
    objects[n++] = p.index;
  }
  const index = new Uint32Array(3 * n);
  for (let i = 0; i < n; ++i) index[3 * i] = index[3 * i + 1] = index[3 * i + 2] = i;
  return { vertices: vertices.slice(0, 4 * n), index, objects: objects.slice(0, n), kinds: new Int32Array(n).fill(SPHERE) };
}

/**
 * The chunks' line segments as round cones (tubes with round ends) between their vertices, where `toMm` puts
 * them: each `radius` mm, or a vertex's own (`radiusAt`, mm; undefined: `radius`); each segment's object the index
 * `objectOf` gives its first vertex (-1 leaves it out).
 */
export function linePrimitives(chunks: readonly BuiltChunk[], toMm: readonly number[], radius: number, objectOf: (c: BuiltChunk, vertex: number) => number, radiusAt?: (c: BuiltChunk, vertex: number) => number | undefined): Primitives {
  const count = chunks.reduce((s, c) => s + c.segmentCount, 0);
  const nv = chunks.reduce((s, c) => s + (c.segmentCount > 0 ? c.vertexCount : 0), 0);
  const vertices = new Float32Array(4 * nv), index = new Uint32Array(3 * count), objects = new Int32Array(count);
  const m = toMm;
  let n = 0, base = 0;
  for (const c of chunks) {
    if (c.segmentCount === 0) continue;
    const v = c.vertices;
    for (let i = 0; i < c.vertexCount; ++i) {
      const x = v[4 * i], y = v[4 * i + 1], z = v[4 * i + 2], o = 4 * (base + i);
      vertices[o] = m[0] * x + m[1] * y + m[2] * z + m[3];
      vertices[o + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      vertices[o + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
      vertices[o + 3] = radiusAt?.(c, i) ?? radius;
    }
    for (let k = 0; k < c.segmentCount; ++k) {
      const a = c.segments[4 * k + 1], b = c.segments[4 * k + 2];
      const object = objectOf(c, a);
      if (object < 0) continue;
      index[3 * n] = base + a;
      index[3 * n + 1] = index[3 * n + 2] = base + b;
      objects[n++] = object;
    }
    base += c.vertexCount;
  }
  return { vertices, index: index.slice(0, 3 * n), objects: objects.slice(0, n), kinds: new Int32Array(n).fill(CONE) };
}

/** A sphere's radius for `count` points over the box `lower`..`upper` (mm): a quarter of their mean spacing. */
export function pointRadius(count: number, lower: readonly number[], upper: readonly number[]): number {
  const ext = [0, 1, 2].map((a) => Math.max(upper[a] - lower[a], 1e-9));
  return 0.25 * Math.cbrt((ext[0] * ext[1] * ext[2]) / Math.max(count, 1));
}

/** A tube's radius for segments of these lengths (mm): a sixth of the median, at most a 200th of `extent`. */
export function lineRadius(lengths: readonly number[], extent: number): number {
  if (lengths.length === 0) return extent / 500;
  const sorted = [...lengths].sort((a, b) => a - b);
  return Math.min(sorted[sorted.length >> 1] / 6, extent / 200);
}
