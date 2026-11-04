/**
 * A large mesh as zarr-vectors levels: level 0 split into spatial cells,
 * then coarser levels made by vertex clustering, each in cells twice as
 * large (what Neuroglancer's multiscale meshes and zarr-vectors-tools'
 * `zvtools pyramid --chunk-scale 2,2,2` expect).
 *
 * Cells: each face goes to the cell holding its centroid; a cell keeps, per
 * object, one vertex fragment (the vertices its faces there use, copied:
 * a vertex on a border is stored in every cell whose faces use it, at the
 * same float32 position) and one face group whose rows are cell-local. So
 * every cell is whole on its own (no cross-cell links), and the welded
 * union of the cells is the mesh.
 *
 * Coarser levels: vertex clustering with quadric representatives
 * (Lindstrom 2000, "Out-of-core simplification of large polygonal
 * models"). Vertices are binned on a grid nested in the level's cells, one
 * cluster per bin and object; each cluster's vertex is the point
 * minimising the summed squared distance to the planes of its faces
 * (area-weighted quadrics), kept inside its bin; faces whose corners fall
 * in fewer than three clusters go, and repeated faces are kept once. Each
 * level is made from the one before with bins twice as large, carrying the
 * quadrics, which is the same as clustering level 0 with those bins. It is
 * linear in the faces and needs memory for the clusters only, so ten
 * million triangles take seconds. Clustering is done on the whole mesh
 * before it is split, so cells meet without cracks at every level.
 */
import type { MeshData } from "./mesh_files.js";

/** Meshes with more triangles than this are split into cells with coarser levels; smaller ones stay one cell. */
export const SPLIT_TRIANGLES = 1_000_000;
/** About how many faces a level-0 cell holds, on average. */
export const CELL_FACES = 1 << 17;
/** A level with no more faces than this is the last. */
export const LAST_LEVEL_FACES = 1 << 17;
const MAX_LEVELS = 10;

export interface MeshCell {
  /** The cell's grid coordinates (absolute: positions / chunk, floored). */
  at: [number, number, number];
  /** x y z per vertex, fragment by fragment. */
  vertices: Float32Array;
  /** Three cell-local vertex rows per face, face group by face group. */
  faces: Int32Array;
  /** Per fragment: its vertices, its faces and its object (0-based). */
  vertexCounts: Uint32Array;
  faceCounts: Uint32Array;
  owners: Uint32Array;
}

export interface MeshLevel {
  chunk: number;
  cells: MeshCell[];
  vertexCount: number;
  faceCount: number;
  /** Objects with faces at this level. */
  present: number;
  /** The clustering bin (0 at level 0). */
  bin: number;
  /** Time taken to make it, ms. */
  ms: number;
}

export interface MeshLevels {
  /** Subtracted from the file's positions (whole units), kept as `coordinate_offset`. */
  offset: number[];
  lo: number[];
  hi: number[];
  objects: string[];
  levels: MeshLevel[];
  /** Per object, from the file: vertices, faces, area. */
  columns: { name: string; values: Float32Array }[];
}

// ---------------------------------------------------------------- hashing

/** Integer keys (below 2^53) to dense ids, by open addressing; grows as needed. */
export class KeyIndex {
  private keys: Float64Array;
  private ids: Int32Array;
  private mask: number;
  size = 0;
  constructor(expected = 1024) {
    let cap = 1024;
    while (cap < 2 * expected) cap *= 2;
    this.keys = new Float64Array(cap);
    this.ids = new Int32Array(cap).fill(-1);
    this.mask = cap - 1;
  }
  private slot(key: number): number {
    const lo = key >>> 0;
    const hi = Math.floor(key / 4294967296);
    return (Math.imul(lo ^ Math.imul(hi, 0x85ebca6b), 0x9e3779b1) >>> 0) & this.mask;
  }
  /** The key's id, given the next id when new. */
  id(key: number): number {
    let s = this.slot(key);
    for (;;) {
      const id = this.ids[s];
      if (id === -1) break;
      if (this.keys[s] === key) return id;
      s = (s + 1) & this.mask;
    }
    this.keys[s] = key;
    this.ids[s] = this.size;
    if (++this.size * 2 > this.ids.length) this.grow();
    return this.size - 1;
  }
  private grow(): void {
    const keys = this.keys;
    const ids = this.ids;
    this.keys = new Float64Array(keys.length * 2);
    this.ids = new Int32Array(ids.length * 2).fill(-1);
    this.mask = this.ids.length - 1;
    for (let i = 0; i < ids.length; ++i) {
      if (ids[i] === -1) continue;
      let s = this.slot(keys[i]);
      while (this.ids[s] !== -1) s = (s + 1) & this.mask;
      this.keys[s] = keys[i];
      this.ids[s] = ids[i];
    }
  }
}

/** Whether a face (three ids, rotated to start at the smallest, winding kept) was seen; by open addressing. */
class FaceSet {
  private keys: Int32Array;
  private mask: number;
  private count = 0;
  constructor(expected: number) {
    let cap = 1024;
    while (cap < 2 * expected) cap *= 2;
    this.keys = new Int32Array(3 * cap).fill(-1);
    this.mask = cap - 1;
  }
  /** Adds the face; false when it was already there. */
  add(a: number, b: number, c: number): boolean {
    // Rotate so the smallest leads.
    if (b < a && b < c) {
      const t = a;
      a = b;
      b = c;
      c = t;
    } else if (c < a && c < b) {
      const t = c;
      c = b;
      b = a;
      a = t;
    }
    let s = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b) ^ Math.imul(c, 0xc2b2ae35)) >>> 0;
    s &= this.mask;
    const k = this.keys;
    for (;;) {
      if (k[3 * s] === -1) break;
      if (k[3 * s] === a && k[3 * s + 1] === b && k[3 * s + 2] === c) return false;
      s = (s + 1) & this.mask;
    }
    k[3 * s] = a;
    k[3 * s + 1] = b;
    k[3 * s + 2] = c;
    if (++this.count * 2 > this.mask + 1) this.grow();
    return true;
  }
  private grow(): void {
    const old = this.keys;
    this.keys = new Int32Array(old.length * 2).fill(-1);
    this.mask = this.keys.length / 3 - 1;
    this.count = 0;
    for (let s = 0; s < old.length; s += 3) if (old[s] !== -1) this.add(old[s], old[s + 1], old[s + 2]);
  }
}

// ---------------------------------------------------------------- cells

/** The cell size: a power of two giving cells of about `CELL_FACES` faces on average (by their centroids). */
export function chooseCellSize(positions: Float32Array, faces: Uint32Array, hi: number[], target = CELL_FACES): number {
  let chunk = 1;
  const top = Math.max(...hi, 1e-9);
  while (chunk <= top) chunk *= 2;
  while (chunk > top) chunk /= 2;
  chunk *= 2;
  const nFaces = faces.length / 3;
  if (nFaces <= target) return chunk;
  const step = Math.max(1, Math.floor(nFaces / 262_144));
  const centroids: number[] = [];
  for (let f = 0; f < nFaces; f += step) {
    for (let k = 0; k < 3; ++k) centroids.push((positions[3 * faces[3 * f] + k] + positions[3 * faces[3 * f + 1] + k] + positions[3 * faces[3 * f + 2] + k]) / 3);
  }
  const occupied = (c: number) => {
    const seen = new Set<number>();
    const n = Math.floor(top / c) + 1;
    for (let i = 0; i < centroids.length; i += 3) {
      seen.add((Math.floor(centroids[i + 2] / c) * n + Math.floor(centroids[i + 1] / c)) * n + Math.floor(centroids[i] / c));
    }
    return seen.size;
  };
  for (let i = 0; i < 40 && nFaces / occupied(chunk) > target; ++i) chunk /= 2;
  return chunk;
}

/**
 * Splits faces into cells of `chunk` by centroid: per cell, one vertex
 * fragment and one face group per object, in object order; cells in z, y,
 * x order. `positions` are non-negative (cells start at the origin).
 */
export function splitCells(positions: Float32Array, faces: Uint32Array, faceObject: Uint32Array, objects: number, chunk: number): MeshCell[] {
  const nFaces = faces.length / 3;
  const nVertices = positions.length / 3;
  // Each face's cell, numbered as first seen.
  const cellOf = new Int32Array(nFaces);
  const cellIndex = new KeyIndex(64);
  const cellAt: number[] = [];
  let top = 0;
  for (let i = 0; i < positions.length; ++i) if (positions[i] > top) top = positions[i];
  const n = Math.floor(top / chunk) + 2;
  for (let f = 0; f < nFaces; ++f) {
    const a = 3 * faces[3 * f];
    const b = 3 * faces[3 * f + 1];
    const c = 3 * faces[3 * f + 2];
    const x = Math.max(0, Math.floor((positions[a] + positions[b] + positions[c]) / 3 / chunk));
    const y = Math.max(0, Math.floor((positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3 / chunk));
    const z = Math.max(0, Math.floor((positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3 / chunk));
    const before = cellIndex.size;
    const id = cellIndex.id((z * n + y) * n + x);
    if (id === before) cellAt.push(x, y, z);
    cellOf[f] = id;
  }
  const nCells = cellIndex.size;
  // Buckets: (cell, object), ranked by cell (z, y, x) then object.
  let bucketOf: Int32Array;
  let bucketCell: number[];
  let bucketObject: number[];
  if (objects <= 1) {
    bucketOf = cellOf;
    bucketCell = Array.from({ length: nCells }, (_, i) => i);
    bucketObject = new Array(nCells).fill(0);
  } else {
    bucketOf = new Int32Array(nFaces);
    const buckets = new KeyIndex(nCells);
    bucketCell = [];
    bucketObject = [];
    for (let f = 0; f < nFaces; ++f) {
      const before = buckets.size;
      const id = buckets.id(cellOf[f] * objects + faceObject[f]);
      if (id === before) {
        bucketCell.push(cellOf[f]);
        bucketObject.push(faceObject[f]);
      }
      bucketOf[f] = id;
    }
  }
  const nBuckets = bucketCell.length;
  const cellOrder = Array.from({ length: nCells }, (_, i) => i).sort((p, q) => cellAt[3 * p + 2] - cellAt[3 * q + 2] || cellAt[3 * p + 1] - cellAt[3 * q + 1] || cellAt[3 * p] - cellAt[3 * q]);
  const cellRank = new Int32Array(nCells);
  cellOrder.forEach((c, r) => (cellRank[c] = r));
  const bucketOrder = Array.from({ length: nBuckets }, (_, i) => i).sort((p, q) => cellRank[bucketCell[p]] - cellRank[bucketCell[q]] || bucketObject[p] - bucketObject[q]);
  const rank = new Int32Array(nBuckets);
  bucketOrder.forEach((b, r) => (rank[b] = r));
  // Faces in bucket order (counting sort, stable).
  const start = new Uint32Array(nBuckets + 1);
  for (let f = 0; f < nFaces; ++f) ++start[rank[bucketOf[f]] + 1];
  for (let r = 0; r < nBuckets; ++r) start[r + 1] += start[r];
  const order = new Uint32Array(nFaces);
  const fill = start.slice(0, nBuckets);
  for (let f = 0; f < nFaces; ++f) order[fill[rank[bucketOf[f]]]++] = f;
  // Each bucket's vertices, in the order its faces first use them.
  const stamp = new Int32Array(nVertices).fill(-1);
  const local = new Int32Array(nVertices);
  const vertexCount = new Uint32Array(nBuckets);
  for (let r = 0; r < nBuckets; ++r) {
    let count = 0;
    for (let i = start[r]; i < start[r + 1]; ++i) {
      const f = order[i];
      for (let k = 0; k < 3; ++k) {
        const v = faces[3 * f + k];
        if (stamp[v] !== r) {
          stamp[v] = r;
          ++count;
        }
      }
    }
    vertexCount[r] = count;
  }
  stamp.fill(-1);
  const cells: MeshCell[] = [];
  let r = 0;
  while (r < nBuckets) {
    const cell = bucketCell[bucketOrder[r]];
    let end = r;
    let vertices = 0;
    while (end < nBuckets && bucketCell[bucketOrder[end]] === cell) vertices += vertexCount[end++];
    const out: MeshCell = {
      at: [cellAt[3 * cell], cellAt[3 * cell + 1], cellAt[3 * cell + 2]],
      vertices: new Float32Array(3 * vertices),
      faces: new Int32Array(3 * (start[end] - start[r])),
      vertexCounts: vertexCount.slice(r, end),
      faceCounts: new Uint32Array(end - r),
      owners: new Uint32Array(end - r),
    };
    let row = 0;
    let at = 0;
    for (let b = r; b < end; ++b) {
      out.faceCounts[b - r] = start[b + 1] - start[b];
      out.owners[b - r] = bucketObject[bucketOrder[b]];
      for (let i = start[b]; i < start[b + 1]; ++i) {
        const f = order[i];
        for (let k = 0; k < 3; ++k) {
          const v = faces[3 * f + k];
          if (stamp[v] !== b) {
            stamp[v] = b;
            local[v] = row;
            out.vertices[3 * row] = positions[3 * v];
            out.vertices[3 * row + 1] = positions[3 * v + 1];
            out.vertices[3 * row + 2] = positions[3 * v + 2];
            ++row;
          }
          out.faces[at++] = local[v];
        }
      }
    }
    cells.push(out);
    r = end;
  }
  return cells;
}

// ---------------------------------------------------------------- clustering

/** A level's mesh while levels are made: vertices with their object, bin and quadric. */
interface Work {
  positions: Float32Array;
  object: Uint32Array;
  faces: Uint32Array;
  faceObject: Uint32Array;
  /** Bin coordinates per vertex, at this level's bin (absent at level 0). */
  bins?: Int32Array;
  /** Per vertex: the quadric (10 values) and position sum and weight (4), summed over what it stands for. */
  quadrics?: Float64Array;
  sums?: Float64Array;
}

/** A face's area-weighted plane quadric (10 values) into `out`; false for a face of no area. */
function faceQuadric(out: Float64Array, p: Float32Array, a: number, b: number, c: number): boolean {
  const ux = p[3 * b] - p[3 * a];
  const uy = p[3 * b + 1] - p[3 * a + 1];
  const uz = p[3 * b + 2] - p[3 * a + 2];
  const wx = p[3 * c] - p[3 * a];
  const wy = p[3 * c + 1] - p[3 * a + 1];
  const wz = p[3 * c + 2] - p[3 * a + 2];
  let nx = uy * wz - uz * wy;
  let ny = uz * wx - ux * wz;
  let nz = ux * wy - uy * wx;
  const twice = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(twice > 0)) return false;
  nx /= twice;
  ny /= twice;
  nz /= twice;
  const d = -(nx * p[3 * a] + ny * p[3 * a + 1] + nz * p[3 * a + 2]);
  const w = twice / 2;
  out[0] = w * nx * nx;
  out[1] = w * nx * ny;
  out[2] = w * nx * nz;
  out[3] = w * nx * d;
  out[4] = w * ny * ny;
  out[5] = w * ny * nz;
  out[6] = w * ny * d;
  out[7] = w * nz * nz;
  out[8] = w * nz * d;
  out[9] = w * d * d;
  return true;
}

/**
 * The next level: `from`'s vertices clustered in bins of `bin` (level 1:
 * from level 0's positions; later levels: the bins before, halved), one
 * cluster per bin and object.
 */
function cluster(from: Work, bin: number, lo: number[], hi: number[]): Work {
  const nv = from.positions.length / 3;
  const nf = from.faces.length / 3;
  const p = from.positions;
  const ids = new KeyIndex(Math.max(1024, nv >> 2));
  const cid = new Int32Array(nv);
  const binOf: number[] = [];
  const objectOf: number[] = [];
  const n = Math.ceil(Math.max(...hi) / bin) + 2;
  for (let v = 0; v < nv; ++v) {
    let x: number, y: number, z: number;
    if (from.bins === undefined) {
      x = Math.max(0, Math.floor(p[3 * v] / bin));
      y = Math.max(0, Math.floor(p[3 * v + 1] / bin));
      z = Math.max(0, Math.floor(p[3 * v + 2] / bin));
    } else {
      x = from.bins[3 * v] >> 1;
      y = from.bins[3 * v + 1] >> 1;
      z = from.bins[3 * v + 2] >> 1;
    }
    const o = from.object[v];
    const before = ids.size;
    const id = ids.id(((o * n + z) * n + y) * n + x);
    if (id === before) {
      binOf.push(x, y, z);
      objectOf.push(o);
    }
    cid[v] = id;
  }
  const nc = ids.size;
  const q = new Float64Array(10 * nc);
  const sums = new Float64Array(4 * nc);
  if (from.quadrics === undefined) {
    const face = new Float64Array(10);
    for (let f = 0; f < nf; ++f) {
      const a = from.faces[3 * f];
      const b = from.faces[3 * f + 1];
      const c = from.faces[3 * f + 2];
      if (!faceQuadric(face, p, a, b, c)) continue;
      const qa = 10 * cid[a];
      const qb = 10 * cid[b];
      const qc = 10 * cid[c];
      for (let k = 0; k < 10; ++k) {
        q[qa + k] += face[k];
        q[qb + k] += face[k];
        q[qc + k] += face[k];
      }
    }
    for (let v = 0; v < nv; ++v) {
      const s = 4 * cid[v];
      sums[s] += p[3 * v];
      sums[s + 1] += p[3 * v + 1];
      sums[s + 2] += p[3 * v + 2];
      sums[s + 3] += 1;
    }
  } else {
    for (let v = 0; v < nv; ++v) {
      const c = cid[v];
      for (let k = 0; k < 10; ++k) q[10 * c + k] += from.quadrics[10 * v + k];
      for (let k = 0; k < 4; ++k) sums[4 * c + k] += from.sums![4 * v + k];
    }
  }
  // Faces between three clusters, each kept once.
  const seen = new FaceSet(nf >> 2);
  let kept = new Uint32Array(3 * Math.max(1024, nf >> 2));
  let keptObject = new Uint32Array(kept.length / 3);
  let nKept = 0;
  const used = new Uint8Array(nc);
  for (let f = 0; f < nf; ++f) {
    const a = cid[from.faces[3 * f]];
    const b = cid[from.faces[3 * f + 1]];
    const c = cid[from.faces[3 * f + 2]];
    if (a === b || b === c || a === c || !seen.add(a, b, c)) continue;
    if (nKept === keptObject.length) {
      const k2 = new Uint32Array(2 * kept.length);
      k2.set(kept);
      kept = k2;
      const o2 = new Uint32Array(2 * keptObject.length);
      o2.set(keptObject);
      keptObject = o2;
    }
    kept[3 * nKept] = a;
    kept[3 * nKept + 1] = b;
    kept[3 * nKept + 2] = c;
    keptObject[nKept++] = from.faceObject[f];
    used[a] = used[b] = used[c] = 1;
  }
  // Only clusters with faces stay; each one's position from its quadric.
  const renumber = new Int32Array(nc).fill(-1);
  let m = 0;
  for (let c = 0; c < nc; ++c) if (used[c]) renumber[c] = m++;
  const out: Work = {
    positions: new Float32Array(3 * m),
    object: new Uint32Array(m),
    faces: new Uint32Array(3 * nKept),
    faceObject: keptObject.slice(0, nKept),
    bins: new Int32Array(3 * m),
    quadrics: new Float64Array(10 * m),
    sums: new Float64Array(4 * m),
  };
  for (let c = 0; c < nc; ++c) {
    const r = renumber[c];
    if (r === -1) continue;
    out.object[r] = objectOf[c];
    for (let k = 0; k < 3; ++k) out.bins![3 * r + k] = binOf[3 * c + k];
    out.quadrics!.set(q.subarray(10 * c, 10 * c + 10), 10 * r);
    out.sums!.set(sums.subarray(4 * c, 4 * c + 4), 4 * r);
    const point = representative(q, 10 * c, sums, 4 * c);
    for (let k = 0; k < 3; ++k) {
      const b0 = binOf[3 * c + k] * bin;
      const low = Math.max(b0, lo[k]);
      const high = Math.min(b0 + bin, hi[k]);
      out.positions[3 * r + k] = Math.min(high, Math.max(low, point[k]));
    }
  }
  for (let i = 0; i < 3 * nKept; ++i) out.faces[i] = renumber[kept[i]];
  return out;
}

/** The point minimising a quadric, or the mean where the quadric does not fix one. */
export function representative(q: ArrayLike<number>, at: number, sums: ArrayLike<number>, s: number): [number, number, number] {
  const a = q[at], b = q[at + 1], c = q[at + 2], d = q[at + 4], e = q[at + 5], f = q[at + 7];
  const rx = -q[at + 3], ry = -q[at + 6], rz = -q[at + 8];
  const det = a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c);
  const trace = (a + d + f) / 3;
  const w = sums[s + 3] || 1;
  const mean: [number, number, number] = [sums[s] / w, sums[s + 1] / w, sums[s + 2] / w];
  // Nearly flat or a ridge: the planes leave a line or plane of solutions.
  if (!(Math.abs(det) > 1e-3 * trace * trace * trace) || !(trace > 0)) return mean;
  const x = (rx * (d * f - e * e) - b * (ry * f - e * rz) + c * (ry * e - d * rz)) / det;
  const y = (a * (ry * f - e * rz) - rx * (b * f - e * c) + c * (b * rz - ry * c)) / det;
  const z = (a * (d * rz - ry * e) - b * (b * rz - ry * c) + rx * (b * e - d * c)) / det;
  return Number.isFinite(x + y + z) ? [x, y, z] : mean;
}

// ---------------------------------------------------------------- levels

/**
 * The bin (`top` halved some times) that puts closest to `per` of a
 * sample's vertices (a cell's: a contiguous piece of the surface) in each
 * occupied bin.
 */
export function chooseBin(sample: Float32Array, top: number, per = 4): number {
  const n = sample.length / 3;
  let best = top;
  let bestError = Infinity;
  for (let bin = top; bin > top / 2 ** 24; bin /= 2) {
    const seen = new KeyIndex(1024);
    const side = 2 ** 17;
    for (let v = 0; v < n; ++v) {
      const x = Math.floor(sample[3 * v] / bin) % side;
      const y = Math.floor(sample[3 * v + 1] / bin) % side;
      const z = Math.floor(sample[3 * v + 2] / bin) % side;
      seen.id((z * side + y) * side + x);
    }
    const error = Math.abs(Math.log(n / seen.size / per));
    if (error < bestError) {
      best = bin;
      bestError = error;
    }
    // Finer bins only get further from `per` once most vertices have one each.
    if (seen.size > 0.9 * n) break;
  }
  return best;
}

/**
 * The levels of a mesh: level 0 in cells, then clustered levels while the
 * last has more than `LAST_LEVEL_FACES` faces and clustering still halves
 * them. `progress` hears of each level made; with `inPlace`, the mesh's
 * positions are moved where they are rather than copied.
 */
export function buildMeshLevels(mesh: MeshData, options: { cellFaces?: number; lastLevelFaces?: number; progress?: (level: MeshLevel) => void; inPlace?: boolean } = {}): MeshLevels {
  const started = performance.now();
  const { positions: source, triangles, triangleObject, objects } = mesh;
  const nObjects = Math.max(1, objects.length);
  const nFaces = triangles.length / 3;
  // Bounds of the vertices faces use, and the offset (whole units) that moves them to start at the origin.
  const usedVertex = new Uint8Array(source.length / 3);
  for (let i = 0; i < triangles.length; ++i) usedVertex[triangles[i]] = 1;
  const low = [Infinity, Infinity, Infinity];
  for (let v = 0; v < usedVertex.length; ++v) {
    if (!usedVertex[v]) continue;
    for (let k = 0; k < 3; ++k) if (source[3 * v + k] < low[k]) low[k] = source[3 * v + k];
  }
  const offset = low.map((v) => (Number.isFinite(v) ? Math.floor(v) : 0));
  // Moved in place when the mesh is ours to change (`inPlace`: a worker's own copy).
  const positions = options.inPlace ? source : new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    positions[i] = source[i] - offset[0];
    positions[i + 1] = source[i + 1] - offset[1];
    positions[i + 2] = source[i + 2] - offset[2];
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < usedVertex.length; ++v) {
    if (!usedVertex[v]) continue;
    for (let k = 0; k < 3; ++k) {
      const x = positions[3 * v + k];
      if (x < lo[k]) lo[k] = x;
      if (x > hi[k]) hi[k] = x;
    }
  }
  for (let k = 0; k < 3; ++k) if (!Number.isFinite(lo[k])) lo[k] = hi[k] = 0;

  // Per object: vertices, faces and area, from the file.
  const nVerticesOf = new Float32Array(nObjects);
  const nFacesOf = new Float32Array(nObjects);
  const areaOf = new Float64Array(nObjects);
  const lastObject = new Int32Array(source.length / 3).fill(-1);
  const byObject = new Uint32Array(nFaces);
  {
    const start = new Uint32Array(nObjects + 1);
    for (let f = 0; f < nFaces; ++f) ++start[triangleObject[f] + 1];
    for (let o = 0; o < nObjects; ++o) start[o + 1] += start[o];
    const fill = start.slice(0, nObjects);
    for (let f = 0; f < nFaces; ++f) byObject[fill[triangleObject[f]]++] = f;
  }
  for (const f of byObject) {
    const o = triangleObject[f];
    nFacesOf[o] += 1;
    const a = triangles[3 * f];
    const b = triangles[3 * f + 1];
    const c = triangles[3 * f + 2];
    for (let k = 0; k < 3; ++k) {
      const v = triangles[3 * f + k];
      if (lastObject[v] !== o) {
        lastObject[v] = o;
        nVerticesOf[o] += 1;
      }
    }
    const ux = positions[3 * b] - positions[3 * a], uy = positions[3 * b + 1] - positions[3 * a + 1], uz = positions[3 * b + 2] - positions[3 * a + 2];
    const wx = positions[3 * c] - positions[3 * a], wy = positions[3 * c + 1] - positions[3 * a + 1], wz = positions[3 * c + 2] - positions[3 * a + 2];
    areaOf[o] += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
  }

  const chunk = chooseCellSize(positions, triangles, hi, options.cellFaces ?? CELL_FACES);
  const levels: MeshLevel[] = [];
  const level0Cells = splitCells(positions, triangles, triangleObject, nObjects, chunk);
  const level0: MeshLevel = {
    chunk,
    cells: level0Cells,
    vertexCount: level0Cells.reduce((n, c) => n + c.vertices.length / 3, 0),
    faceCount: nFaces,
    present: nFacesOf.reduce((n, f) => n + (f > 0 ? 1 : 0), 0),
    bin: 0,
    ms: performance.now() - started,
  };
  levels.push(level0);
  options.progress?.(level0);

  // Level 0 as a working mesh: one vertex per (file vertex, object).
  let work: Work;
  if (nObjects === 1) {
    work = { positions, object: new Uint32Array(positions.length / 3), faces: triangles, faceObject: triangleObject };
  } else {
    const ids = new KeyIndex(positions.length / 3);
    const faces = new Uint32Array(triangles.length);
    const pos: number[] = [];
    const obj: number[] = [];
    for (let f = 0; f < nFaces; ++f) {
      const o = triangleObject[f];
      for (let k = 0; k < 3; ++k) {
        const v = triangles[3 * f + k];
        const before = ids.size;
        const id = ids.id(v * nObjects + o);
        if (id === before) {
          pos.push(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]);
          obj.push(o);
        }
        faces[3 * f + k] = id;
      }
    }
    work = { positions: Float32Array.from(pos), object: Uint32Array.from(obj), faces, faceObject: triangleObject };
  }

  // Bins of level 1: a power-of-two part of level 1's cells, the one that
  // puts about four vertices in a bin where the mesh is densest (its
  // fullest level-0 cell), so each level has about a quarter of the faces
  // of the one before, as its cells have four times the area.
  const fullest = level0Cells.reduce((a, b) => (b.vertices.length > a.vertices.length ? b : a));
  let bin = chooseBin(fullest.vertices, 2 * chunk);
  // Cluster keys stay exact integers (below 2^52).
  while ((Math.ceil(Math.max(...hi) / bin) + 2) ** 3 * nObjects > 2 ** 52) bin *= 2;
  const last = options.lastLevelFaces ?? LAST_LEVEL_FACES;
  for (let k = 1; k < MAX_LEVELS && levels[k - 1].faceCount > last; ++k, bin *= 2) {
    const t = performance.now();
    const next = cluster(work, bin, lo, hi);
    const faces = next.faces.length / 3;
    // Clustering no longer reduces: stop.
    if (faces === 0 || faces > 0.75 * levels[k - 1].faceCount) break;
    const cells = splitCells(next.positions, next.faces, next.faceObject, nObjects, chunk * 2 ** k);
    const present = new Set(next.faceObject).size;
    const level: MeshLevel = { chunk: chunk * 2 ** k, cells, vertexCount: cells.reduce((n, c) => n + c.vertices.length / 3, 0), faceCount: faces, present, bin, ms: performance.now() - t };
    levels.push(level);
    options.progress?.(level);
    work = next;
  }
  return {
    offset,
    lo,
    hi,
    objects: objects.length > 0 ? objects : ["mesh"],
    levels,
    columns: [
      { name: "n_vertices", values: nVerticesOf },
      { name: "n_faces", values: nFacesOf },
      { name: "area", values: Float32Array.from(areaOf) },
    ],
  };
}

/** The buffers of a level set, to transfer between workers. */
export function meshLevelBuffers(levels: MeshLevels): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const level of levels.levels) for (const c of level.cells) for (const a of [c.vertices, c.faces, c.vertexCounts, c.faceCounts, c.owners]) out.push(a.buffer as ArrayBuffer);
  for (const c of levels.columns) out.push(c.values.buffer as ArrayBuffer);
  return out;
}
