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
  /**
   * Objects read whole (a set, not a spatial chunk): its segments sorted
   * into pieces of space, PIECE_STRIDE numbers each: the first segment, how
   * many, the piece's bounds (lower x, y, z, upper x, y, z), and how many
   * the first 1, 2, … SAMPLES samples of the objects hold.  See sortIntoPieces.
   */
  pieces?: Float64Array;
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

/**
 * A layer's chosen objects read whole, by id (the Zarr Vectors reader's
 * `ObjectReader.readCurves`), as one chunk's input: each curve's vertices
 * in order, each joined to the next.
 */
export function curvesInput(ids: ArrayLike<bigint>, offsets: Uint32Array, positions: Float32Array): ChunkInput {
  const n = positions.length / 3;
  const segmentIds = new Uint32Array(2 * n);
  let edgeCount = 0;
  for (let c = 0; c < ids.length; ++c) edgeCount += Math.max(0, offsets[c + 1] - offsets[c] - 1);
  const edges = new Uint32Array(2 * edgeCount);
  let e = 0;
  for (let c = 0; c < ids.length; ++c) {
    const lo = Number(BigInt.asUintN(32, ids[c]));
    const hi = Number(BigInt.asUintN(32, ids[c] >> 32n));
    for (let v = offsets[c]; v < offsets[c + 1]; ++v) {
      segmentIds[2 * v] = lo;
      segmentIds[2 * v + 1] = hi;
      if (v + 1 < offsets[c + 1]) {
        edges[e++] = v;
        edges[e++] = v + 1;
      }
    }
  }
  return { numVertices: n, numOwnVertices: n, positions, segmentIds, edges, attributes: [] };
}

/** Objects read whole one at a time (`ObjectReader.readSkeleton`): their vertices, edges and attributes, one after another. */
export function skeletonsInput(parts: { id: bigint; positions: Float32Array; edges: Uint32Array; attributes: Float32Array[] }[], components: number[]): ChunkInput {
  let n = 0;
  let m = 0;
  for (const p of parts) {
    n += p.positions.length / 3;
    m += p.edges.length;
  }
  const positions = new Float32Array(3 * n);
  const segmentIds = new Uint32Array(2 * n);
  const edges = new Uint32Array(m);
  const attributes = components.map((c) => new Float32Array(c * n));
  let at = 0;
  let e = 0;
  for (const p of parts) {
    const count = p.positions.length / 3;
    positions.set(p.positions, 3 * at);
    const lo = Number(BigInt.asUintN(32, p.id));
    const hi = Number(BigInt.asUintN(32, p.id >> 32n));
    for (let v = 0; v < count; ++v) {
      segmentIds[2 * (at + v)] = lo;
      segmentIds[2 * (at + v) + 1] = hi;
    }
    for (let k = 0; k < p.edges.length; ++k) edges[e++] = p.edges[k] + at;
    components.forEach((c, k) => {
      const a = p.attributes[k];
      if (a !== undefined) attributes[k].set(a.subarray(0, c * count), c * at);
    });
    at += count;
  }
  return { numVertices: n, numOwnVertices: n, positions, segmentIds, edges, attributes };
}

/** At most this many pieces along each axis when a set of whole objects is cut up for culling. */
export const PIECES_PER_AXIS = 16;

/** Each piece's segments are ordered by this many samples of the objects (see sortIntoPieces). */
export const SAMPLES = 8;
/** Numbers per piece in `BuiltChunk.pieces`: first segment, count, bounds (6), and the end of each sample (SAMPLES). */
export const PIECE_STRIDE = 8 + SAMPLES;

/**
 * Sorts a built chunk's segments into pieces of space (a grid over its
 * bounds, cells about `cell` store units, at most PIECES_PER_AXIS a side),
 * so a view draws only the pieces it can show (a 2-D view's slab, the 3-D
 * view's frustum) while the lines stay joined across them (the vertices
 * are not moved).  Within a piece the segments are ordered by their
 * object's sample (the hash of its id, objectKey, in SAMPLES parts), so the
 * first k samples of every piece are the same k / SAMPLES of the objects,
 * whole: a view with more lines than its Detail draws that share.  Sets
 * `pieces`, PIECE_STRIDE numbers each: its first segment, its count, its
 * bounds, and how many of its segments the first 1, 2, … SAMPLES samples
 * hold.
 */
export function sortIntoPieces(chunk: BuiltChunk, cell: number): void {
  const count = chunk.segmentCount;
  if (count === 0) return;
  const { lower, upper, vertices, segments, slots, objectIds } = chunk;
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.min(PIECES_PER_AXIS, Math.ceil((upper[k] - lower[k]) / Math.max(cell, 1e-9)))));
  const size = [0, 1, 2].map((k) => Math.max((upper[k] - lower[k]) / dims[k], 1e-12));
  const cells = dims[0] * dims[1] * dims[2];
  // Each object's sample, by its slot.
  const sampleOf = new Uint8Array(objectIds.length / 2);
  for (let i = 0; i < sampleOf.length; ++i) sampleOf[i] = Math.min(SAMPLES - 1, Math.floor(objectKey(objectIds[2 * i], objectIds[2 * i + 1]) * SAMPLES));
  const keyOf = new Uint32Array(count);
  const starts = new Uint32Array(cells * SAMPLES + 1);
  for (let s = 0; s < count; ++s) {
    const a = segments[4 * s + 1];
    let index = 0;
    for (let k = 2; k >= 0; --k) {
      const i = Math.min(dims[k] - 1, Math.max(0, Math.floor((vertices[4 * a + k] - lower[k]) / size[k])));
      index = index * dims[k] + i;
    }
    const key = index * SAMPLES + sampleOf[slots[a]];
    keyOf[s] = key;
    ++starts[key + 1];
  }
  for (let c = 0; c < cells * SAMPLES; ++c) starts[c + 1] += starts[c];
  const next = starts.slice(0, cells * SAMPLES);
  const sorted = new Uint32Array(4 * count);
  for (let s = 0; s < count; ++s) {
    const to = next[keyOf[s]]++;
    sorted.set(segments.subarray(4 * s, 4 * s + 4), 4 * to);
  }
  const pieces: number[] = [];
  for (let c = 0; c < cells; ++c) {
    const start = starts[c * SAMPLES];
    const end = starts[(c + 1) * SAMPLES];
    if (end === start) continue;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let s = start; s < end; ++s) {
      for (let j = 1; j <= 2; ++j) {
        const v = sorted[4 * s + j];
        for (let k = 0; k < 3; ++k) {
          const p = vertices[4 * v + k];
          if (p < lo[k]) lo[k] = p;
          if (p > hi[k]) hi[k] = p;
        }
      }
    }
    pieces.push(start, end - start, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    for (let b = 1; b <= SAMPLES; ++b) pieces.push(starts[c * SAMPLES + b] - start);
  }
  chunk.segments = sorted;
  chunk.pieces = Float64Array.from(pieces);
}
