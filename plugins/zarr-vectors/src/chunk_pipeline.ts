/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Worker-side assembly of one spatial chunk for the dense overview:
 * decode it, give every vertex its object's segment id, and bridge its curves
 * into neighbouring chunks.
 *
 * Bridging: a curve crossing a chunk face is stored as a cross-chunk link
 * between its last vertex on one side and its first on the other. The chunk
 * owning the link (holding its first endpoint) appends the far endpoint as a
 * "ghost" vertex and draws the bridging edge, so each bridge is drawn once.
 *
 * Ghost positions come from the neighbour's vertex cell. Cells are shared
 * through one cache, so a neighbour the view also draws is fetched once,
 * whichever needs it first. A neighbour the view does not draw (a slice
 * view's chunks above and below the plane) is read by row range instead,
 * when its cell is uncompressed.
 */

import type { ZarrVectorsGeometryDescription } from "./base.js";
import type { DecodedChunk } from "./chunk_decode.js";
import {
  decodeChunk,
  forEachFragmentVertex,
} from "./chunk_decode.js";
import type { ElementType } from "./dtype.js";
import {
  attributeDtype,
  decodeFloat32,
  ELEMENT_BYTES,
  isElementType,
} from "./dtype.js";
import { KIND_CAPABILITIES } from "./geometry_kind.js";
import { LevelCells } from "./level_cells.js";
import { CrossChunkLinks } from "./links.js";
import {
  BLOCKS_PATH,
  readAllDenseManifests,
  SPANS_PATH,
} from "./dense_manifests.js";
import type { ManifestBlock } from "./object_manifest.js";
import { decodeObjectManifest } from "./object_manifest.js";
import {
  readObjectTable,
  readShaderObjectValues,
} from "./objects.js";
import type {
  ZarrVectorsLevel,
  ZarrVectorsStoreAccess,
} from "./store.js";
import {
  AsyncLru,
  mapConcurrent,
  SHARED_SIGNAL,
  warnOnce,
} from "./util.js";

/** One decoded chunk, ready to post to the frontend. */
export interface DenseChunkData {
  /** Vertices including ghosts. */
  numVertices: number;
  /** Vertices that belong to this chunk; only these get node circles. */
  numOwnVertices: number;
  positions: Float32Array;
  /** Two uint32 per vertex: the segment id, low word first. */
  segmentIds: Uint32Array;
  /** Line segments as vertex index pairs, bridges included. */
  edges: Uint32Array;
  /** A mesh's triangles, three vertex indices each (drawn in cross-sections as where they cross the section). */
  faces: Uint32Array;
  /** Per exposed attribute (`components` floats per vertex), then the tangent. */
  attributes: Float32Array[];
}

/** Raw vertex cells, by pipeline and cell, shared by chunks and ghosts. */
const vertexCells = new AsyncLru<Uint8Array | undefined>(
  Infinity,
  256 * 1024 * 1024,
  (b) => b?.byteLength ?? 0,
);
let nextPipelineId = 0;

/**
 * A neighbour's attribute cells, decoded, for the corners of faces reaching
 * into it (read again when that chunk is drawn too, so kept a while).
 */
const neighbourAttributes = new AsyncLru<Float32Array | undefined>(
  Infinity,
  64 * 1024 * 1024,
  (a) => a?.byteLength ?? 0,
);

/**
 * Caps the raw vertex cells kept between reads (256 MiB by default).  A
 * worker that keeps its own decoded copy of what it needs can make this
 * small.
 */
export function setVertexCellCacheBytes(bytes: number): void {
  vertexCells.setMaxSize(bytes);
}

/**
 * Segment id per fragment of each chunk, by inverting a level's manifests.
 * Needed for stores without `fragment_attributes/segment_id`, which
 * zarr-vectors-py's own writers do not write.
 */
async function fragmentOwners(
  access: ZarrVectorsStoreAccess,
  cells: LevelCells,
  level: ZarrVectorsLevel,
): Promise<Map<string, BigUint64Array> | undefined> {
  const table = await readObjectTable(access, level.path);
  if (table === undefined) return undefined;
  let manifestsByRow: ManifestBlock[][];
  if (table.dense) {
    const [spans, blocks] = await Promise.all([
      cells.reader(SPANS_PATH),
      cells.reader(BLOCKS_PATH),
    ]);
    if (spans === undefined || blocks === undefined) return undefined;
    manifestsByRow = await readAllDenseManifests(spans, blocks, table.numObjects);
  } else {
    const manifests = await cells.reader("object_index/manifests");
    if (manifests === undefined) return undefined;
    const rows = await manifests.readVlenRows(0, table.numObjects);
    manifestsByRow = rows.map((blob) =>
      blob === undefined ? [] : decodeObjectManifest(blob, 3),
    );
  }
  const owners = new Map<string, bigint[]>();
  manifestsByRow.forEach((manifest, row) => {
    for (const { chunkCoords, fragmentRef: ref } of manifest) {
      const key = chunkCoords.join(".");
      let list = owners.get(key);
      if (list === undefined) owners.set(key, (list = []));
      const fragments =
        ref.mode === "single"
          ? [ref.fragmentIndex]
          : ref.mode === "range"
            ? Array.from({ length: ref.count }, (_, i) => ref.start + i)
            : Array.from(ref.indices);
      for (const f of fragments) list[f] = table.segmentIds[row];
    }
  });
  return new Map(
    [...owners].map(([key, list]) => [
      key,
      BigUint64Array.from(list, (id) => id ?? 0xffffffffffffffffn),
    ]),
  );
}

/**
 * Sets each vertex's object values (`obj_<name>`, `obj_group`) from the
 * object it belongs to: `segmentIds` holds two uint32 per vertex.
 */
/**
 * Starts reading the object values {@link fillObjectValues} will put on
 * vertices, so they are at hand when the first object's geometry is.
 */
export function prefetchObjectValues(
  access: ZarrVectorsStoreAccess,
  description: ZarrVectorsGeometryDescription,
) {
  const wanted = description.attributes.flatMap((a) =>
    a.objectValue !== undefined ? [a.objectValue] : [],
  );
  if (wanted.length === 0 || description.objectValuesPath === undefined) return;
  readShaderObjectValues(access, description.objectValuesPath, wanted).catch(
    () => {},
  );
}

export async function fillObjectValues(
  access: ZarrVectorsStoreAccess,
  description: ZarrVectorsGeometryDescription,
  attributes: Float32Array[],
  segmentIds: Uint32Array,
  numVertices: number,
) {
  const slots = description.attributes.flatMap((a, i) =>
    a.objectValue !== undefined && i < attributes.length ? [i] : [],
  );
  if (slots.length === 0 || description.objectValuesPath === undefined) return;
  const objects = await readShaderObjectValues(
    access,
    description.objectValuesPath,
    slots.map((i) => description.attributes[i].objectValue!),
  ).catch((e) => {
    warnOnce(
      "object values could not be read " +
        `(${e instanceof Error ? e.message : e}); shown as no value (NaN)`,
      access.url,
    );
    return undefined;
  });
  if (objects === undefined) {
    // Not 0, which looks like data: no value.
    for (const slot of slots) attributes[slot].fill(NaN, 0, numVertices);
    return;
  }
  let lastLo = -1;
  let lastHi = -1;
  let row: number | undefined;
  for (let v = 0; v < numVertices; ++v) {
    const lo = segmentIds[2 * v];
    const hi = segmentIds[2 * v + 1];
    if (lo !== lastLo || hi !== lastHi) {
      lastLo = lo;
      lastHi = hi;
      row = objects.rowOf(BigInt(lo) | (BigInt(hi) << 32n));
    }
    slots.forEach((slot, k) => {
      attributes[slot][v] = row === undefined ? NaN : objects.values[k][row];
    });
  }
}

/** The id of a fragment no object claims. */
const NO_OBJECT = 0xffffffffffffffffn;

interface Ghost {
  /** The local vertex the bridge starts from. */
  host: number;
  chunkKey: string;
  vertex: number;
  /** Whether the host comes first in the curve's walk. */
  hostIsPredecessor: boolean;
  /** A corner of a face reaching into another chunk, not the end of a bridge (no edge). */
  corner?: boolean;
}

export class LevelPipeline {
  private cells: LevelCells;
  private links: CrossChunkLinks | undefined;
  private owners: Promise<Map<string, BigUint64Array> | undefined> | undefined;
  private mode:
    | Promise<{
        mode: "direct" | "object_id" | "manifests";
        segmentIds?: BigUint64Array;
      }>
    | undefined;
  private id = nextPipelineId++;

  /**
   * `isRequested` says whether the view also wants the chunk at a cell, so a
   * ghost read of it can fetch the whole cell for that chunk to reuse.
   */
  constructor(
    private access: ZarrVectorsStoreAccess,
    private description: ZarrVectorsGeometryDescription,
    private level: ZarrVectorsLevel,
    private isRequested: (chunk: readonly number[]) => boolean = () => false,
  ) {
    this.cells = LevelCells.forLevel(access, level, description);
    // Lines bridge to their neighbours' vertices; a mesh's faces reach them.
    if (KIND_CAPABILITIES[description.geometryKind].primitive !== "points") {
      this.links = new CrossChunkLinks({
        cells: this.cells,
        listDirectories: (path) =>
          access.listDirectories(`${level.path}/${path}`),
        warn: (message: string) => warnOnce(message, access.url),
      });
    }
  }

  /** The raw vertex cell at `chunkKey`, fetched once for every reader. */
  private vertexCell(chunkKey: string) {
    return vertexCells.get(`${this.id}|${chunkKey}`, () =>
      this.cells.readCell("vertices", chunkKey, SHARED_SIGNAL),
    );
  }

  private get vertexType(): ElementType {
    return this.level.arrays.vertices.attributes?.dtype ?? "float32";
  }

  /**
   * How this level's fragments find their objects, decided once for the
   * level rather than guessed per value:
   * - `direct`: the store's ids are its rows (no id column, or one that is
   *   the identity), so a stored `segment_id` is both and is used as is;
   * - `object_id`: the level has `fragment_attributes/object_id`, always a
   *   dense row, which maps through the object table;
   * - `manifests`: neither; a `segment_id` column could hold ids or rows
   *   (zarr-vectors-tools writes rows where a coarsener needs them), so the
   *   manifests, which are never ambiguous, say.
   */
  private idMode() {
    this.mode ??= (async () => {
      const table = await readObjectTable(this.access, this.level.path).catch(
        () => undefined,
      );
      if (table === undefined || table.idSource === "row") {
        return { mode: "direct" as const };
      }
      const ids = table.segmentIds;
      let identity = true;
      for (let i = 0; i < ids.length && identity; ++i) {
        identity = ids[i] === BigInt(i);
      }
      if (identity) return { mode: "direct" as const };
      if (
        (await this.cells.reader("fragment_attributes/object_id")) !== undefined
      ) {
        return { mode: "object_id" as const, segmentIds: ids };
      }
      return { mode: "manifests" as const };
    })();
    return this.mode;
  }

  private fragmentOwners() {
    if (this.owners === undefined) {
      const promise = fragmentOwners(this.access, this.cells, this.level);
      this.owners = promise;
      promise.catch((e) => {
        if (this.owners === promise) this.owners = undefined;
        warnOnce(
          "could not map fragments to objects " +
            `(${e instanceof Error ? e.message : e}); objects are coloured per chunk`,
          this.access.url,
        );
      });
    }
    return this.owners;
  }

  /**
   * The chunk's vertices (rows) that links join to other fragments, here or
   * in a neighbouring chunk, with how many links each: where a line goes on
   * past the end of one of its fragments (a one-vertex fragment can have a
   * link in and one out).
   */
  async linkedVertices(chunk: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (this.links === undefined) return out;
    const local = (coords: readonly number[]) => coords.every((c, d) => c === chunk[d]);
    for (const { endpoints } of await this.links.linksTouching(chunk)) {
      for (const e of endpoints) if (local(e.chunkCoords)) out.set(e.vertexIndex, (out.get(e.vertexIndex) ?? 0) + 1);
    }
    return out;
  }

  /**
   * The chunk at spatial cell `chunk`, or `undefined` if it is empty.
   *
   * `bridges: false` leaves out the segments that cross into neighbouring
   * chunks, and so every read of a neighbour's vertices: a tool testing a
   * region against the chunks it touches reads those chunks alone.  Linked
   * skeletons keep their links, which define their segments.
   */
  async download(
    chunk: number[],
    signal: AbortSignal,
    options: { bridges?: boolean } = {},
  ): Promise<DenseChunkData | undefined> {
    const { description } = this;
    const chunkKey = chunk.join(".");
    if (!(await this.cells.mayHaveCell("vertices", chunkKey))) return undefined;
    const isLocal = (coords: readonly number[]) =>
      coords.every((c, d) => c === chunk[d]);
    // In "linked" skeletons a cross-chunk link replaces its child's implied
    // parent, so the child's chunk needs the links it does not own.
    const linked = description.skeletonLayout === "linked";
    const linksPromise =
      this.links === undefined || (options.bridges === false && !linked)
        ? Promise.resolve([])
        : linked
          ? this.links.linksTouching(chunk)
          : this.links.linksOwnedBy(chunk);
    linksPromise.catch(() => {});
    // Worked out while the chunk's cells are read.
    const relinkedChildren = linked
      ? linksPromise.then((records) => {
          const out = new Set<number>();
          for (const { endpoints } of records) {
            const [child, parent] = endpoints;
            if (isLocal(child.chunkCoords) && !isLocal(parent.chunkCoords)) {
              out.add(child.vertexIndex);
            }
          }
          return out;
        })
      : undefined;
    const { mode, segmentIds: table } = description.hasObjects
      ? await this.idMode()
      : { mode: "direct" as const, segmentIds: undefined };
    const [decoded, links] = await Promise.all([
      decodeChunk(this.cells, description, chunkKey, signal, {
        relinkedChildren,
        // A mesh's faces draw its outline on cross-sections.
        skipFaces: false,
        vertices: this.vertexCell(chunkKey),
        skipSegmentIds: mode === "manifests",
        fragmentIdColumn: mode === "object_id" ? "object_id" : "segment_id",
      }),
      linksPromise,
    ]);
    if (decoded === undefined) return undefined;

    let { segmentIds } = decoded;
    if (segmentIds === undefined) {
      const ids = new Uint32Array(decoded.numVertices * 2);
      const stored = decoded.fragmentIds;
      let idOf: (f: number) => bigint;
      if (stored !== undefined && mode === "direct") {
        idOf = (f) => stored[f];
      } else if (stored !== undefined && table !== undefined) {
        idOf = (f) =>
          stored[f] < BigInt(table.length)
            ? table[Number(stored[f])]
            : NO_OBJECT;
      } else {
        const owners = await this.fragmentOwners().catch(() => undefined);
        const chunkOwners = owners?.get(chunkKey);
        // Without the manifests (warned), colour per fragment in the chunk;
        // a fragment no object claims is no object.
        idOf =
          owners === undefined
            ? (f) => BigInt(f)
            : (f) => chunkOwners?.[f] ?? NO_OBJECT;
      }
      for (let f = 0; f < decoded.fragments.numFragments; ++f) {
        const id = idOf(f);
        const lo = Number(id & 0xffffffffn);
        const hi = Number(id >> 32n);
        forEachFragmentVertex(decoded.fragments, f, (v) => {
          ids[2 * v] = lo;
          ids[2 * v + 1] = hi;
        });
      }
      segmentIds = ids;
    }

    const ghosts: Ghost[] = [];
    // Faces with corners in other chunks: those corners as ghosts (one per
    // vertex), placed where the neighbour has them, carrying a local
    // corner's segment and values; ghosts are written as -1 - index.
    const crossFaces: number[] = [];
    const cornerGhosts = new Map<string, number>();
    for (const { endpoints } of links) {
      if (endpoints.length !== 3) continue;
      const local = endpoints.find((e) => isLocal(e.chunkCoords));
      if (local === undefined || local.vertexIndex >= decoded.numVertices) {
        continue;
      }
      for (const e of endpoints) {
        if (isLocal(e.chunkCoords)) {
          crossFaces.push(e.vertexIndex);
          continue;
        }
        const chunkKey = e.chunkCoords.join(".");
        const key = `${chunkKey}:${e.vertexIndex}`;
        let g = cornerGhosts.get(key);
        if (g === undefined) {
          g = ghosts.length;
          cornerGhosts.set(key, g);
          ghosts.push({
            host: local.vertexIndex,
            chunkKey,
            vertex: e.vertexIndex,
            hostIsPredecessor: true,
            corner: true,
          });
        }
        crossFaces.push(-1 - g);
      }
    }
    for (const { endpoints } of links) {
      if (endpoints.length !== 2) continue;
      const [a, b] = endpoints;
      const aLocal = isLocal(a.chunkCoords);
      if (aLocal === isLocal(b.chunkCoords)) continue;
      if (linked && !aLocal) continue; // drawn by the child's chunk
      const [host, far] = aLocal ? [a, b] : [b, a];
      if (host.vertexIndex >= decoded.numVertices) continue;
      ghosts.push({
        host: host.vertexIndex,
        chunkKey: far.chunkCoords.join("."),
        vertex: far.vertexIndex,
        hostIsPredecessor: aLocal,
      });
    }
    const [ghostPositions, cornerValues] = await Promise.all([
      this.ghostPositions(ghosts, signal),
      this.cornerValues(ghosts),
    ]);
    await fillObjectValues(
      this.access,
      description,
      decoded.attributes,
      segmentIds,
      decoded.numVertices,
    );
    return assembleChunk(
      decoded,
      segmentIds,
      ghosts,
      ghostPositions,
      crossFaces,
      cornerValues,
    );
  }

  /**
   * The values of the corner ghosts (faces reaching into another chunk) as
   * that chunk stores them, per ghost and attribute (undefined where the
   * host's are kept: bridges, object values, unreadable cells), so another
   * surface kept as an attribute (`coords_inflated`) joins up across chunks.
   */
  private async cornerValues(
    ghosts: readonly Ghost[],
  ): Promise<(Float32Array | undefined)[][]> {
    const out: (Float32Array | undefined)[][] = ghosts.map(() => []);
    const attributes = this.description.attributes;
    if (attributes.length === 0) return out;
    const keys = [...new Set(ghosts.filter((g) => g.corner).map((g) => g.chunkKey))];
    await mapConcurrent(keys, 8, async (key) => {
      await Promise.all(
        attributes.map(async (a, i) => {
          if (a.objectValue !== undefined) return;
          const path = `vertex_attributes/${a.name}`;
          const values = await neighbourAttributes
            .get(`${this.id}|${path}|${key}`, async () => {
              // Shared: the cached cell outlives this request.
              const bytes = await this.cells.readCell(path, key, SHARED_SIGNAL);
              if (bytes === undefined) return undefined;
              const json = (await this.cells.reader(path))?.array.attributes;
              const type = json ? attributeDtype({ attributes: json }) : a.dtype;
              if (!isElementType(type)) return undefined;
              const count = Math.floor(bytes.byteLength / ELEMENT_BYTES[type]);
              return decodeFloat32(bytes, type, count);
            })
            .catch(() => undefined);
          if (values === undefined) return;
          ghosts.forEach((g, gi) => {
            if (!g.corner || g.chunkKey !== key) return;
            const start = g.vertex * a.components;
            if (start + a.components <= values.length) {
              out[gi][i] = values.subarray(start, start + a.components);
            }
          });
        }),
      );
    });
    return out;
  }

  /** Positions of the requested neighbour vertices (NaN where unreadable). */
  private async ghostPositions(
    ghosts: readonly Ghost[],
    signal: AbortSignal,
  ): Promise<Float32Array> {
    const out = new Float32Array(ghosts.length * 3).fill(Number.NaN);
    const byChunk = new Map<string, number[]>();
    ghosts.forEach((g, i) => {
      let list = byChunk.get(g.chunkKey);
      if (list === undefined) byChunk.set(g.chunkKey, (list = []));
      list.push(i);
    });
    const type = this.vertexType;
    await mapConcurrent([...byChunk], 8, async ([key, indices]) => {
      const wanted = [...new Set(indices.map((i) => ghosts[i].vertex))].sort(
        (x, y) => x - y,
      );
      // The whole cell when it is cached or in flight, or when the view will
      // draw that chunk anyway; otherwise only the rows needed, if possible.
      let whole = vertexCells.peek(`${this.id}|${key}`);
      if (whole === undefined && this.isRequested(key.split(".").map(Number))) {
        whole = this.vertexCell(key);
      }
      const found = await this.cells.vertexRows(
        key,
        type,
        whole === undefined ? wanted : [],
        signal,
        () => this.vertexCell(key),
      );
      if (whole !== undefined) {
        const bytes = await whole.catch(() => undefined);
        if (bytes !== undefined) {
          const all = decodeFloat32(
            bytes,
            type,
            bytes.byteLength / ELEMENT_BYTES[type],
          );
          for (const v of wanted) {
            if (3 * v + 3 <= all.length) {
              found.set(v, all.subarray(3 * v, 3 * v + 3));
            }
          }
        }
      }
      for (const i of indices) {
        const p = found.get(ghosts[i].vertex);
        if (p !== undefined) out.set(p, 3 * i);
      }
    });
    return out;
  }
}

/**
 * The final chunk arrays, one allocation each: the decoded vertices, then a
 * ghost per bridge (or corner of a face reaching into another chunk)
 * carrying its host's segment id and attributes, with a tangent along the
 * bridge in the curve's walk direction; the faces, then those reaching
 * across (`crossFaces`, ghosts as -1 - index), where every corner was found.
 */
function assembleChunk(
  decoded: DecodedChunk,
  segmentIds: Uint32Array,
  ghosts: readonly Ghost[],
  ghostPositions: Float32Array,
  crossFaces: readonly number[] = [],
  cornerValues: readonly (Float32Array | undefined)[][] = [],
): DenseChunkData {
  const own = decoded.numVertices;
  const kept = ghosts
    .map((g, i) => ({ ...g, i }))
    .filter((g) => !Number.isNaN(ghostPositions[3 * g.i]));
  const total = own + kept.length;
  const row = new Int32Array(ghosts.length).fill(-1);
  kept.forEach((g, k) => (row[g.i] = own + k));
  const positions = new Float32Array(total * 3);
  positions.set(decoded.positions.subarray(0, own * 3));
  const ids = new Uint32Array(total * 2);
  ids.set(segmentIds.subarray(0, own * 2));
  const bridges = kept.filter((g) => !g.corner).length;
  const edges = new Uint32Array(decoded.edges.length + bridges * 2);
  edges.set(decoded.edges);
  let edgeAt = decoded.edges.length;
  const sources = [...decoded.attributes];
  if (decoded.tangents !== undefined) sources.push(decoded.tangents);
  const widths = sources.map((src) => (own === 0 ? 1 : src.length / own));
  const attributes = sources.map((src, i) => {
    const out = new Float32Array(total * widths[i]);
    out.set(src);
    return out;
  });
  const tangentIndex = decoded.tangents === undefined ? -1 : sources.length - 1;
  kept.forEach((g, k) => {
    const v = own + k;
    positions.set(ghostPositions.subarray(3 * g.i, 3 * g.i + 3), 3 * v);
    ids[2 * v] = ids[2 * g.host];
    ids[2 * v + 1] = ids[2 * g.host + 1];
    if (!g.corner) {
      edges[edgeAt++] = g.host;
      edges[edgeAt++] = v;
    }
    attributes.forEach((out, i) => {
      const width = widths[i];
      if (i !== tangentIndex) {
        const own = cornerValues[g.i]?.[i];
        if (own !== undefined && own.length === width) out.set(own, v * width);
        else out.copyWithin(v * width, g.host * width, (g.host + 1) * width);
        return;
      }
      // Along the bridge, in walk order, so interpolating from the host's
      // tangent never passes through zero.
      const sign = g.hostIsPredecessor ? 1 : -1;
      const d = [0, 1, 2].map(
        (j) => sign * (positions[3 * v + j] - positions[3 * g.host + j]),
      );
      const norm = Math.hypot(d[0], d[1], d[2]);
      for (let j = 0; j < 3; ++j) {
        out[3 * v + j] = norm > 0 ? d[j] / norm : out[3 * g.host + j];
      }
    });
  });
  let faces = decoded.faces;
  if (crossFaces.length > 0) {
    const across: number[] = [];
    for (let f = 0; f + 3 <= crossFaces.length; f += 3) {
      const corners = [0, 1, 2].map((k) => {
        const c = crossFaces[f + k];
        return c >= 0 ? c : row[-1 - c];
      });
      if (corners.every((c) => c >= 0)) across.push(...corners);
    }
    faces = new Uint32Array(decoded.faces.length + across.length);
    faces.set(decoded.faces);
    faces.set(across, decoded.faces.length);
  }
  return {
    numVertices: total,
    numOwnVertices: own,
    positions,
    segmentIds: ids,
    edges,
    faces,
    attributes,
  };
}
