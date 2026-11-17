/**
 * Geometry for the path tracer from what Luxar's reader builds: a mesh's
 * triangles in physical millimetres (placed as the layer is), each with its
 * object and its corners' normals, packed for the GPU.
 */
import type { BuiltChunk } from "../../luxar/chunk_build.js";

/** Primitives before the BVH: 9 floats each (lbvh.ts's layout), their objects, and their corners' normals (4 uint each). */
export interface Primitives {
  prims: Float32Array;
  objects: Int32Array;
  /** Per primitive: each corner's normal, octahedral in two snorm16 (x low), and a 0. */
  normals: Uint32Array;
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
  const prims = new Float32Array(9 * count);
  const objects = new Int32Array(count);
  const normals = new Uint32Array(4 * count);
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
  let f = 0;
  for (const c of chunks) {
    if (c.triangleCount === 0) continue;
    const v = c.vertices, nv = c.normals, n = c.vertexCount;
    const pos = new Float32Array(3 * n);
    const nrm = new Uint32Array(n);
    for (let i = 0; i < n; ++i) {
      const x = v[4 * i], y = v[4 * i + 1], z = v[4 * i + 2];
      pos[3 * i] = m[0] * x + m[1] * y + m[2] * z + m[3];
      pos[3 * i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      pos[3 * i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
      if (nv.length >= 4 * n) {
        const p = nv[4 * i], q = nv[4 * i + 1], r = nv[4 * i + 2];
        nrm[i] = packNormal(it[0] * p + it[1] * q + it[2] * r, it[3] * p + it[4] * q + it[5] * r, it[6] * p + it[7] * q + it[8] * r);
      }
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
      const corners = [t[3 * k], t[3 * k + 1], t[3 * k + 2]];
      corners.forEach((vi, j) => prims.set(pos.subarray(3 * vi, 3 * vi + 3), 9 * f + 3 * j));
      objects[f] = slotIndex[c.slots[corners[0]]] ?? 0;
      if (nv.length >= 4 * n) normals.set([nrm[corners[0]], nrm[corners[1]], nrm[corners[2]], 0], 4 * f);
      else {
        // No normals: the face's, at every corner.
        const p0 = corners.map((vi) => [pos[3 * vi], pos[3 * vi + 1], pos[3 * vi + 2]]);
        const e1 = [0, 1, 2].map((q) => p0[1][q] - p0[0][q]), e2 = [0, 1, 2].map((q) => p0[2][q] - p0[0][q]);
        const pn = packNormal(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
        normals.set([pn, pn, pn, 0], 4 * f);
      }
    }
  }
  return { prims: prims.subarray(0, 9 * f), objects: objects.subarray(0, f), normals: normals.subarray(0, 4 * f) };
}

/** Several layers' primitives as one set: each one's objects after the ones before (`offsets`: where each starts). */
export function joinPrimitives(parts: readonly (Primitives & { objectCount: number })[]): Primitives & { offsets: number[] } {
  const n = parts.reduce((s, p) => s + p.objects.length, 0);
  const prims = new Float32Array(9 * n), objects = new Int32Array(n), normals = new Uint32Array(4 * n);
  const offsets: number[] = [];
  let at = 0, base = 0;
  for (const p of parts) {
    offsets.push(base);
    prims.set(p.prims, 9 * at);
    normals.set(p.normals, 4 * at);
    for (let i = 0; i < p.objects.length; ++i) objects[at + i] = p.objects[i] + base;
    at += p.objects.length;
    base += p.objectCount;
  }
  return { prims, objects, normals, offsets };
}
