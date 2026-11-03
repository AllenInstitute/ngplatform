/**
 * One spatial chunk of a Zarr Vectors level, made ready to draw: its
 * vertices as one texture's worth of (x, y, z, value), and its line
 * segments as (previous, start, end, next) vertex indices, so the line
 * shader can mitre each joint without looking anything up.  Each vertex
 * also names its object by a slot in the chunk's list of objects, so the
 * views can show some objects and not others (a layer's chosen segments)
 * and colour them as Neuroglancer does, by a small table per chunk.  A
 * mesh's triangles are kept as they are, with a normal per vertex (the
 * area-weighted mean of its faces' in the chunk), for lit surfaces.  Pure,
 * so the worker and the tests share it.
 */

/** Vertex texture width: rows of this many vertices. */
export const TEXTURE_WIDTH = 2048;

/** A chunk as the Zarr Vectors reader decodes it (`LevelPipeline.download`). */
export interface ChunkInput {
  numVertices: number;
  /** Vertices that belong to this chunk; the rest are copies of a neighbour's, ending the lines that cross into it. */
  numOwnVertices: number;
  positions: Float32Array;
  /** Two uint32 per vertex: the object's id, low word first. */
  segmentIds: Uint32Array;
  /** Line segments as vertex index pairs. */
  edges: Uint32Array;
  /** Per exposed attribute, `components` floats per vertex. */
  attributes: Float32Array[];
  /** A mesh's triangles, three vertex indices each (corners in a neighbour chunk included as copies). */
  faces?: Uint32Array;
}

/** What each vertex's fourth value holds. */
export type ScalarSource = { kind: "none" } | { kind: "object" } | { kind: "attribute"; index: number; components: number };

export interface BuiltChunk {
  /** x, y, z (store coordinates) and the value, per vertex, padded to whole texture rows. */
  vertices: Float32Array;
  vertexCount: number;
  /** previous, start, end, next per segment; previous == start (next == end) where the line does not go on. */
  segments: Uint32Array;
  segmentCount: number;
  /** The segments' total length, store units (for judging how much of a view they cover). */
  length: number;
  /** Vertices drawn as points when there are no segments (a point cloud): the chunk's own. */
  pointCount: number;
  /** The value's 2nd and 98th percentiles, for an attribute. */
  valueRange?: [number, number];
  /** The vertices' bounds, store coordinates. */
  lower: [number, number, number];
  upper: [number, number, number];
  /** Distinct objects in the chunk (for comparing levels). */
  objects: number;
  /** Per vertex, its object's slot in `objectIds` (padded to whole texture rows, as `vertices`). */
  slots: Uint32Array;
  /** The chunk's objects in slot order: each id as two uint32, low word first. */
  objectIds: Uint32Array;
  /** Per slot, how much of the chunk the object is: its segments' length, its triangles' area, or (points) its own vertices. */
  objectWeight: Float32Array;
  /** A mesh's triangles, three vertex indices each (empty for lines and points). */
  triangles: Uint32Array;
  triangleCount: number;
  /** A mesh's normal per vertex, (x, y, z, 0), padded as `vertices`; empty without triangles. */
  normals: Float32Array;
  /** The triangles' total area, store units squared. */
  area: number;
}

/** An object id's colour key: a well-mixed hash of its 64 bits, in [0, 1). */
export function objectKey(lo: number, hi: number): number {
  // murmur3's finaliser over the two words, so neighbouring ids get unrelated hues.
  let h = (lo ^ Math.imul(hi, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function percentiles(values: Float32Array, count: number): [number, number] | undefined {
  // A sample is plenty for a colormap's range.
  const step = Math.max(1, Math.floor(count / 20000));
  const sample: number[] = [];
  for (let i = 0; i < count; i += step) {
    const v = values[4 * i + 3];
    if (Number.isFinite(v)) sample.push(v);
  }
  if (sample.length === 0) return undefined;
  sample.sort((a, b) => a - b);
  const at = (q: number) => sample[Math.min(sample.length - 1, Math.max(0, Math.round(q * (sample.length - 1))))];
  return [at(0.02), at(0.98)];
}

export function buildChunk(input: ChunkInput, scalar: ScalarSource): BuiltChunk {
  const n = input.numVertices;
  const own = Math.min(input.numOwnVertices, n);
  const rows = Math.max(1, Math.ceil(n / TEXTURE_WIDTH));
  const vertices = new Float32Array(rows * TEXTURE_WIDTH * 4);
  const lower: [number, number, number] = [Infinity, Infinity, Infinity];
  const upper: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const { positions, segmentIds } = input;
  const attribute = scalar.kind === "attribute" ? input.attributes[scalar.index] : undefined;
  const objects = new Set<number>();
  const slots = new Uint32Array(rows * TEXTURE_WIDTH);
  // Slots by id: the low word alone for the usual ids, both words otherwise.
  const slotOf = new Map<number | string, number>();
  const ids: number[] = [];
  for (let v = 0; v < n; ++v) {
    for (let k = 0; k < 3; ++k) {
      const p = positions[3 * v + k];
      vertices[4 * v + k] = p;
      if (p < lower[k]) lower[k] = p;
      if (p > upper[k]) upper[k] = p;
    }
    const lo = segmentIds[2 * v] ?? 0;
    const hi = segmentIds[2 * v + 1] ?? 0;
    if (v < own && hi === 0) objects.add(lo);
    const key = hi === 0 ? lo : `${hi}:${lo}`;
    let slot = slotOf.get(key);
    if (slot === undefined) {
      slot = ids.length / 2;
      slotOf.set(key, slot);
      ids.push(lo, hi);
    }
    slots[v] = slot;
    let value = 0;
    if (scalar.kind === "object") value = objectKey(lo, hi);
    else if (attribute !== undefined && scalar.kind === "attribute") {
      const c = scalar.components;
      if (c === 1) value = attribute[v];
      else {
        // A vector attribute: its length.
        let s = 0;
        for (let j = 0; j < c; ++j) s += attribute[c * v + j] ** 2;
        value = Math.sqrt(s);
      }
    }
    vertices[4 * v + 3] = value;
  }

  // Each vertex's neighbours along the lines: a vertex met by exactly two
  // segments is a joint, mitred; any other (an end, a branch, a copy of a
  // neighbour chunk's vertex) ends its segments square.
  const edges = input.edges;
  const m = Math.floor(edges.length / 2);
  const degree = new Uint8Array(n);
  const first = new Uint32Array(n);
  const second = new Uint32Array(n);
  for (let e = 0; e < m; ++e) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    if (a >= n || b >= n || a === b) continue;
    for (const [v, w] of [
      [a, b],
      [b, a],
    ]) {
      const d = degree[v];
      if (d === 0) first[v] = w;
      else if (d === 1) second[v] = w;
      if (d < 255) degree[v] = d + 1;
    }
  }
  const across = (v: number, from: number): number => {
    if (v >= own || degree[v] !== 2) return v;
    const other = first[v] === from ? second[v] : first[v];
    // The same segment twice is not a joint.
    return other === from ? v : other;
  };
  const segments = new Uint32Array(m * 4);
  const objectWeight = new Float32Array(ids.length / 2);
  let count = 0;
  let length = 0;
  for (let e = 0; e < m; ++e) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    if (a >= n || b >= n || a === b) continue;
    segments[4 * count] = across(a, b);
    segments[4 * count + 1] = a;
    segments[4 * count + 2] = b;
    segments[4 * count + 3] = across(b, a);
    const l = Math.hypot(positions[3 * b] - positions[3 * a], positions[3 * b + 1] - positions[3 * a + 1], positions[3 * b + 2] - positions[3 * a + 2]);
    length += l;
    objectWeight[slots[a]] += l;
    ++count;
  }
  // A mesh: its triangles (those whose corners are all here and distinct), and a normal per vertex.
  const faces = input.faces ?? new Uint32Array(0);
  const triangles = new Uint32Array(faces.length - (faces.length % 3));
  let triangleCount = 0;
  let area = 0;
  let normals = new Float32Array(0);
  if (faces.length >= 3) {
    normals = new Float32Array(rows * TEXTURE_WIDTH * 4);
    for (let f = 0; f + 3 <= faces.length; f += 3) {
      const a = faces[f];
      const b = faces[f + 1];
      const c = faces[f + 2];
      if (a >= n || b >= n || c >= n || a === b || b === c || a === c) continue;
      const ux = positions[3 * b] - positions[3 * a];
      const uy = positions[3 * b + 1] - positions[3 * a + 1];
      const uz = positions[3 * b + 2] - positions[3 * a + 2];
      const vx = positions[3 * c] - positions[3 * a];
      const vy = positions[3 * c + 1] - positions[3 * a + 1];
      const vz = positions[3 * c + 2] - positions[3 * a + 2];
      // The cross product: the face's normal, twice its area long (so larger faces weigh more).
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) {
        normals[4 * v] += nx;
        normals[4 * v + 1] += ny;
        normals[4 * v + 2] += nz;
      }
      const twice = Math.hypot(nx, ny, nz);
      area += twice / 2;
      objectWeight[slots[a]] += twice / 2;
      triangles[3 * triangleCount] = a;
      triangles[3 * triangleCount + 1] = b;
      triangles[3 * triangleCount + 2] = c;
      ++triangleCount;
    }
    for (let v = 0; v < n; ++v) {
      const l = Math.hypot(normals[4 * v], normals[4 * v + 1], normals[4 * v + 2]);
      if (l > 0) for (let k = 0; k < 3; ++k) normals[4 * v + k] /= l;
    }
  }
  if (count === 0 && triangleCount === 0) for (let v = 0; v < own; ++v) objectWeight[slots[v]] += 1;
  if (n === 0) {
    lower.fill(0);
    upper.fill(0);
  }
  return {
    vertices,
    vertexCount: n,
    segments: count === m ? segments : segments.slice(0, count * 4),
    segmentCount: count,
    length,
    // A point cloud's vertices are its points; a mesh's are its triangles' corners.
    pointCount: count === 0 && triangleCount === 0 ? own : 0,
    valueRange: scalar.kind === "attribute" ? percentiles(vertices, n) : undefined,
    lower,
    upper,
    objects: objects.size,
    slots,
    objectIds: Uint32Array.from(ids),
    objectWeight,
    triangles: triangleCount * 3 === triangles.length ? triangles : triangles.slice(0, triangleCount * 3),
    triangleCount,
    normals,
    area,
  };
}
