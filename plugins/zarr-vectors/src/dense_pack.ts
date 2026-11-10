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
 * @file A dense chunk as the GPU draws it, in as few bytes per vertex as it
 * can be: a position and one 32-bit word per vertex.
 *
 * The word names the vertex's object by its slot in the chunk's own list of
 * objects, which holds each object's segment id and the object values a
 * shader reads (`obj_<name>`), once per object rather than once per vertex.
 * Its top bit says whether an edge joins the vertex to the one before it:
 * a curve store's fragments are runs of rows, so their edges need no index
 * buffer and their tangents are derived in the shader from the neighbours'
 * positions. Only the bridges into neighbouring chunks are listed, and the
 * tangents of their far ends kept.
 *
 * Kept on the CPU once drawn: the words and the object list, for picking;
 * and for a mesh, its faces and per-vertex values, which the Surface
 * controls read and other surfaces' normals are made from.
 */

import type { ZarrVectorsGeometryDescription } from "./base.js";
import type { DenseChunkData } from "./chunk_pipeline.js";
import { KIND_CAPABILITIES } from "./geometry_kind.js";
import type { ShaderObjectValues } from "./objects.js";

/** The vertex word's flag: an edge joins this vertex to the one before. */
export const JOINS_PREVIOUS = 0x80000000;
/** The vertex word's object slot. */
export const OBJECT_SLOT_MASK = 0x7fffffff;

/** Where a value the shader reads per vertex comes from. */
export type DrawAttributeKind = "vertex" | "object" | "tangent";

export interface DrawAttribute {
  id: string;
  components: number;
  kind: DrawAttributeKind;
}

/**
 * The per-vertex values a chunk's shader reads, in order: the store's
 * vertex attributes and object values (as the description lists them),
 * then the tangent for kinds that have one.
 */
export function drawLayout(
  description: ZarrVectorsGeometryDescription,
): DrawAttribute[] {
  const layout: DrawAttribute[] = description.attributes.map((a) => ({
    id: a.id,
    components: a.components,
    kind: a.objectValue !== undefined ? "object" : "vertex",
  }));
  if (KIND_CAPABILITIES[description.geometryKind].tangent !== undefined) {
    layout.push({ id: "tangent", components: 3, kind: "tangent" });
  }
  return layout;
}

/** One chunk, ready to upload. */
export interface DrawChunkData {
  /** Vertices including ghosts (the far ends of bridges, face corners). */
  numVertices: number;
  numOwnVertices: number;
  /** x, y, z per vertex. */
  positions: Float32Array;
  /**
   * Per vertex, its object's slot, with {@link JOINS_PREVIOUS}; empty when
   * every vertex is an object of its own (`objectPerVertex`).
   */
  vertexObjects: Uint32Array;
  /** Each vertex is its own object, in vertex order (points without objects). */
  objectPerVertex: boolean;
  /** Per object slot, its segment id (two uint32, low word first). */
  objectIds: Uint32Array;
  /**
   * Edges as vertex index pairs: all of them, or with `sequential` only
   * the bridges, the rest following from {@link JOINS_PREVIOUS}.
   */
  edges: Uint32Array;
  sequential: boolean;
  /** A mesh's triangles, three vertex indices each. */
  faces: Uint32Array;
  /**
   * Per {@link drawLayout} entry: a vertex attribute per vertex; an object
   * value per object slot (`undefined` where the shader reads none); the
   * tangent per vertex, or with `sequential` per ghost only.
   */
  attributes: (Float32Array | undefined)[];
  /** As {@link DenseChunkData.ghostsLeftOut}. */
  ghostsLeftOut?: number;
}

/** The object values a chunk carries: those of `ids` (attribute ids), as read. */
export interface PackObjectValues {
  ids: readonly string[];
  /** `undefined`: unreadable, so no value (NaN). */
  values: ShaderObjectValues | undefined;
}

/**
 * The chunk as {@link DrawChunkData}, from what the pipeline gives with
 * `forDrawing`: its per-vertex segment ids become slots in a list of the
 * chunk's objects, and the object values in `objectValues` are looked up
 * once per object.
 */
export function packForDrawing(
  data: DenseChunkData,
  description: ZarrVectorsGeometryDescription,
  objectValues?: PackObjectValues,
): DrawChunkData {
  const layout = drawLayout(description);
  const n = data.numVertices;
  const ids = data.segmentIds;
  const vertexObjects = new Uint32Array(n);
  const slots = new Map<number | string, number>();
  const objectWords: number[] = [];
  let lastLo = -1;
  let lastHi = -1;
  let slot = 0;
  for (let v = 0; v < n; ++v) {
    const lo = ids[2 * v];
    const hi = ids[2 * v + 1];
    if (lo !== lastLo || hi !== lastHi) {
      lastLo = lo;
      lastHi = hi;
      // Exact as one number below 2^53, else as text.
      const key = hi < 0x200000 ? hi * 0x100000000 + lo : `${hi}:${lo}`;
      let found = slots.get(key);
      if (found === undefined) {
        found = objectWords.length / 2;
        slots.set(key, found);
        objectWords.push(lo, hi);
      }
      slot = found;
    }
    vertexObjects[v] = slot;
  }
  const numObjects = objectWords.length / 2;
  // Each vertex its own object (points without objects): the slot is the
  // vertex, and needs no word.
  const objectPerVertex = n > 0 && numObjects === n;
  const { joinsPrevious } = data;
  if (joinsPrevious !== undefined && !objectPerVertex) {
    for (let v = 0; v < joinsPrevious.length; ++v) {
      if (joinsPrevious[v]) vertexObjects[v] |= JOINS_PREVIOUS;
    }
  }
  const objectIds = Uint32Array.from(objectWords);

  const attributes: (Float32Array | undefined)[] = layout.map((a, i) => {
    if (a.kind === "vertex") return data.attributes[i];
    if (a.kind === "tangent") {
      if (joinsPrevious !== undefined) {
        const ghosts = data.ghostTangents;
        return ghosts !== undefined && ghosts.length > 0 ? ghosts : undefined;
      }
      return data.attributes[i];
    }
    const k = objectValues?.ids.indexOf(a.id) ?? -1;
    if (k === -1) return undefined;
    const out = new Float32Array(numObjects).fill(NaN);
    const values = objectValues!.values;
    if (values === undefined) return out;
    const column = values.values[k];
    for (let o = 0; o < numObjects; ++o) {
      const row = values.rowOf(
        BigInt(objectIds[2 * o]) | (BigInt(objectIds[2 * o + 1]) << 32n),
      );
      if (row !== undefined) out[o] = column[row];
    }
    return out;
  });

  return {
    numVertices: n,
    numOwnVertices: data.numOwnVertices,
    positions: data.positions,
    vertexObjects: objectPerVertex ? new Uint32Array(0) : vertexObjects,
    objectPerVertex,
    objectIds,
    edges: data.edges,
    sequential: joinsPrevious !== undefined,
    faces: data.faces,
    attributes,
    ...(data.ghostsLeftOut === undefined
      ? {}
      : { ghostsLeftOut: data.ghostsLeftOut }),
  };
}

/**
 * The bytes a chunk takes on the GPU, and those kept on the CPU once it is
 * there (for a mesh, its faces and per-vertex values too).
 */
export function drawChunkBytes(
  data: DrawChunkData,
  layout: readonly DrawAttribute[],
  mesh: boolean,
): { gpu: number; cpu: number } {
  let objectValues = 0;
  let vertexValues = 0;
  let tangents = 0;
  data.attributes.forEach((a, i) => {
    const bytes = a?.byteLength ?? 0;
    const kind = layout[i]?.kind;
    if (kind === "object") objectValues += bytes;
    else if (kind === "tangent") tangents += bytes;
    else vertexValues += bytes;
  });
  const picking =
    data.vertexObjects.byteLength + data.objectIds.byteLength + objectValues;
  let gpu =
    picking +
    data.positions.byteLength +
    data.edges.byteLength +
    data.faces.byteLength +
    vertexValues +
    tangents;
  // A mesh's normals, one per vertex.
  if (data.faces.length > 0) gpu += data.numVertices * 12;
  return {
    gpu,
    cpu: picking + (mesh ? data.faces.byteLength + vertexValues : 0),
  };
}
