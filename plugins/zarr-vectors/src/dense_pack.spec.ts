/**
 * The dense layer's chunks as the GPU draws them (`dense_pack.ts`): a
 * position and one word per vertex, objects' ids and values once per
 * object, no index buffer for runs of rows, tangents derived from the
 * neighbours. What they draw is what the per-vertex arrays drew; they take
 * a third of the bytes on the GPU, and a tenth on the CPU.
 */

import { describe, expect, it } from "vitest";
import type { ZarrVectorsGeometryDescription } from "./base.js";
import type { DecodedChunk } from "./chunk_decode.js";
import { walkJoins, walkTangents } from "./chunk_decode.js";
import type { DenseChunkData } from "./chunk_pipeline.js";
import { assembleChunk, LevelPipeline } from "./chunk_pipeline.js";
import type { DrawChunkData } from "./dense_pack.js";
import {
  drawChunkBytes,
  drawLayout,
  JOINS_PREVIOUS,
  OBJECT_SLOT_MASK,
  packForDrawing,
} from "./dense_pack.js";
import { decodeFragments } from "./fragment_index.js";
import { openZarrVectorsStore } from "./store.js";
import { fixtureListDirectories, fixtureRead } from "./test_fixtures.js";
import { ShardIndexCache } from "./zarr_array.js";

const signal = new AbortController().signal;

/** A packed chunk's segment id at vertex `v`. */
function idOf(d: DrawChunkData, v: number): bigint {
  const slot = d.objectPerVertex ? v : d.vertexObjects[v] & OBJECT_SLOT_MASK;
  return BigInt(d.objectIds[2 * slot]) | (BigInt(d.objectIds[2 * slot + 1]) << 32n);
}

/** The edges a packed chunk draws, as the shader does, sorted. */
function drawnEdges(d: DrawChunkData): string[] {
  const out: string[] = [];
  if (d.sequential && !d.objectPerVertex) {
    for (let v = 1; v < d.numOwnVertices; ++v) {
      if (d.vertexObjects[v] & JOINS_PREVIOUS) out.push(`${v - 1},${v}`);
    }
  }
  for (let e = 0; e < d.edges.length; e += 2) out.push(`${d.edges[e]},${d.edges[e + 1]}`);
  return out.sort();
}

/** A packed chunk's tangent at vertex `v`, as the shader derives it. */
function tangentOf(d: DrawChunkData, t: number, v: number): number[] {
  const stored = d.attributes[t];
  if (!d.sequential) return Array.from(stored!.subarray(3 * v, 3 * v + 3));
  const own = d.numOwnVertices;
  if (v >= own) return Array.from(stored!.subarray(3 * (v - own), 3 * (v - own) + 3));
  const joins = (i: number) => i > 0 && i < own && (d.vertexObjects[i] & JOINS_PREVIOUS) !== 0;
  const previous = joins(v) ? v - 1 : v;
  const next = joins(v + 1) ? v + 1 : v;
  const p = d.positions;
  const dx = [0, 1, 2].map((j) => Math.fround(p[3 * next + j] - p[3 * previous + j]));
  const n = Math.hypot(dx[0], dx[1], dx[2]);
  return dx.map((x) => (n > 0 ? x / n : 0));
}

function sortedEdges(edges: Uint32Array): string[] {
  const out: string[] = [];
  for (let e = 0; e < edges.length; e += 2) out.push(`${edges[e]},${edges[e + 1]}`);
  return out.sort();
}

describe("a chunk packed for drawing", () => {
  it("draws what the per-vertex arrays drew: ids, edges, tangents, values", async () => {
    const read = fixtureRead("poly_raw");
    const access = { read, listDirectories: fixtureListDirectories("poly_raw"), shardIndexes: new ShardIndexCache() };
    const store = await openZarrVectorsStore(access, undefined);
    const level = store.levels[0];
    // An object value, as the frontend offers one to shaders.
    const description: ZarrVectorsGeometryDescription = {
      ...store.description,
      attributes: [
        ...store.description.attributes,
        { name: "length", id: "obj_length", dtype: "float32", components: 1, objectValue: { column: "length" } } as never,
      ],
      objectValuesPath: level.path,
    };
    const layout = drawLayout(description);
    const tangent = layout.findIndex((a) => a.kind === "tangent");
    const value = layout.findIndex((a) => a.id === "obj_length");
    expect(tangent).toBeGreaterThan(-1);
    const { shape, attributes } = level.arrays.vertices;
    const origin = attributes.chunk_grid_origin ?? [0, 0, 0];
    let checked = 0;
    let bridges = 0;
    for (let i = 0; i < shape[0]; ++i) {
      for (let j = 0; j < shape[1]; ++j) {
        for (let k = 0; k < shape[2]; ++k) {
          const chunk = [i + origin[0], j + origin[1], k + origin[2]];
          const pipeline = () => new LevelPipeline(access, description, level, () => true, new Set(["obj_length"]));
          const before = await pipeline().download(chunk, signal);
          const after = await pipeline().downloadForDrawing(chunk, signal);
          if (before === undefined) {
            expect(after).toBeUndefined();
            continue;
          }
          ++checked;
          expect(after!.sequential).toBe(true);
          bridges += after!.edges.length / 2;
          expect(after!.numVertices).toBe(before.numVertices);
          expect(Array.from(after!.positions)).toEqual(Array.from(before.positions));
          expect(drawnEdges(after!)).toEqual(sortedEdges(before.edges));
          for (let v = 0; v < before.numVertices; ++v) {
            const id = BigInt(before.segmentIds[2 * v]) | (BigInt(before.segmentIds[2 * v + 1]) << 32n);
            expect(idOf(after!, v)).toBe(id);
            const t = tangentOf(after!, tangent, v);
            for (let c = 0; c < 3; ++c) expect(t[c]).toBeCloseTo(before.attributes[tangent][3 * v + c], 5);
            const slot = after!.vertexObjects[v] & OBJECT_SLOT_MASK;
            expect(after!.attributes[value]![slot]).toBe(before.attributes[value][v]);
          }
          // The store's vertex attribute stays per vertex.
          const fa = layout.findIndex((a) => a.kind === "vertex");
          expect(Array.from(after!.attributes[fa]!)).toEqual(Array.from(before.attributes[fa]));
        }
      }
    }
    expect(checked).toBeGreaterThan(1);
    expect(bridges).toBeGreaterThan(0);
  });

  it("takes a third of the GPU bytes per vertex, and a tenth of the CPU's", () => {
    // A big level-0 cell's worth (6.6 M vertices in 171 k streamlines, as
    // S-21-46's largest), at a tenth: 660 k vertices in 17 k fragments,
    // three object values the shader could read (one used), one ghost in
    // a hundred fragments.
    const numVertices = 660_000;
    const numFragments = 17_100;
    // Fragment runs of rows, built as `decodeFragments` reads them.
    const fragments = syntheticRuns(numVertices, numFragments);
    const positions = new Float32Array(numVertices * 3);
    for (let i = 0; i < positions.length; ++i) positions[i] = Math.sin(i * 0.37) * 100 + i * 1e-3;
    const description: ZarrVectorsGeometryDescription = {
      geometryKind: "streamline",
      linksConvention: "implicit_sequential",
      linkWidth: 2,
      skeletonLayout: undefined,
      hasObjects: true,
      objectValuesPath: "0",
      attributes: ["a", "b", "c"].map((c) => ({ name: c, id: `obj_${c}`, dtype: "float32", components: 1, objectValue: { column: c } })) as never,
    };
    const ids = new Uint32Array(numVertices * 2);
    for (let f = 0; f < numFragments; ++f) {
      const { start, count } = fragments.range(f);
      for (let v = start; v < start + count; ++v) ids[2 * v] = 1000 + f;
    }
    const base = (tangents: Float32Array | undefined, joins: Uint8Array | undefined, edges: Uint32Array, slots: (n: number) => Float32Array): DecodedChunk => ({
      numVertices,
      positions,
      fragments,
      edges,
      faces: new Uint32Array(0),
      tangents,
      joinsPrevious: joins,
      attributes: [slots(numVertices), slots(numVertices), slots(numVertices)],
      segmentIds: undefined,
      fragmentIds: undefined,
    });
    const ghosts = Array.from({ length: numFragments / 100 }, (_, g) => ({
      host: fragments.range(g * 100).start,
      chunkKey: "1.0.0",
      vertex: g,
      hostIsPredecessor: false,
    }));
    const ghostPositions = new Float32Array(ghosts.length * 3).fill(7);
    // Before: per-vertex edges, tangents, ids and every object value slot.
    const old: DenseChunkData = assembleChunk(
      base(walkTangents(positions, fragments), undefined, sequentialPairs(fragments), (n) => new Float32Array(n).fill(NaN)),
      ids,
      ghosts,
      ghostPositions,
    );
    let oldBytes = old.positions.byteLength + old.segmentIds.byteLength + old.edges.byteLength;
    for (const a of old.attributes) oldBytes += a.byteLength;
    // After: packed, the shader reading one object value.
    const lean = assembleChunk(
      base(undefined, walkJoins(fragments, numVertices), new Uint32Array(0), () => new Float32Array(0)),
      ids,
      ghosts,
      ghostPositions,
    );
    const values = { rowOf: (id: bigint) => Number(id) - 1000, values: [new Float32Array(numFragments).fill(3)] };
    const packed = packForDrawing(lean, description, { ids: ["obj_a"], values });
    const { gpu, cpu } = drawChunkBytes(packed, drawLayout(description), false);
    const n = old.numVertices;
    // Before, the GPU and the CPU each held every array.
    const perVertex = { before: oldBytes / n, gpu: gpu / n, cpu: cpu / n };
    console.info(`bytes per vertex: before ${perVertex.before.toFixed(1)} (GPU and CPU each); after ${perVertex.gpu.toFixed(1)} GPU, ${perVertex.cpu.toFixed(1)} CPU`);
    expect(perVertex.before).toBeGreaterThan(50);
    expect(perVertex.gpu).toBeLessThan(16.5);
    expect(oldBytes / gpu).toBeGreaterThan(3);
    expect(oldBytes / cpu).toBeGreaterThan(10);
    // The same picture: ids and edges.
    expect(drawnEdges(packed)).toEqual(sortedEdges(old.edges));
    for (let v = 0; v < n; v += 997) {
      expect(idOf(packed, v)).toBe(BigInt(old.segmentIds[2 * v]));
    }
    expect(packed.attributes[1]).toBeUndefined();
  });

  it("names each point as its own object without a word per vertex", () => {
    const n = 1000;
    const ids = new Uint32Array(2 * n);
    for (let v = 0; v < n; ++v) {
      ids[2 * v] = v;
      ids[2 * v + 1] = 77;
    }
    const data: DenseChunkData = {
      numVertices: n,
      numOwnVertices: n,
      positions: new Float32Array(3 * n),
      segmentIds: ids,
      edges: new Uint32Array(0),
      faces: new Uint32Array(0),
      attributes: [],
    };
    const description = { geometryKind: "point_cloud", attributes: [] } as unknown as ZarrVectorsGeometryDescription;
    const packed = packForDrawing(data, description);
    expect(packed.objectPerVertex).toBe(true);
    expect(packed.vertexObjects.length).toBe(0);
    expect(idOf(packed, 123)).toBe(123n | (77n << 32n));
  });
});

/** `numFragments` runs of rows covering `numVertices`, as a fragment index. */
function syntheticRuns(numVertices: number, numFragments: number) {
  const starts: number[] = [];
  for (let f = 0; f < numFragments; ++f) starts.push(Math.floor((f * numVertices) / numFragments));
  const range = (f: number) => ({ start: starts[f], count: (f + 1 < numFragments ? starts[f + 1] : numVertices) - starts[f] });
  return {
    numFragments,
    numExplicitFragments: 0,
    isRange: () => true,
    range,
    indices: (f: number) => {
      const { start, count } = range(f);
      return Uint32Array.from({ length: count }, (_, i) => start + i);
    },
    rowCount: (f: number) => range(f).count,
  } as unknown as ReturnType<typeof decodeFragments>;
}

function sequentialPairs(fragments: ReturnType<typeof decodeFragments>): Uint32Array {
  const out: number[] = [];
  for (let f = 0; f < fragments.numFragments; ++f) {
    const { start, count } = fragments.range(f);
    for (let v = start + 1; v < start + count; ++v) out.push(v - 1, v);
  }
  return Uint32Array.from(out);
}
