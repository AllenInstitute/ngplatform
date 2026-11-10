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
 * The typed decode loops give, byte for byte, what the plain loops they
 * replaced gave (kept here as the reference), on a large chunk of mixed
 * range and explicit fragments; and a chunk with no ghosts is not copied.
 */

import { describe, expect, it } from "vitest";
import type { DecodedChunk } from "./chunk_decode.js";
import {
  forEachFragmentVertex,
  sequentialEdges,
  walkTangents,
} from "./chunk_decode.js";
import { assembleChunk } from "./chunk_pipeline.js";
import { FragmentIndex } from "./fragment_index.js";

// The loops as they were before they were typed.
function referenceEdges(fragments: FragmentIndex): Uint32Array {
  const out: number[] = [];
  for (let f = 0; f < fragments.numFragments; ++f) {
    let prev = -1;
    forEachFragmentVertex(fragments, f, (v) => {
      if (prev >= 0) out.push(prev, v);
      prev = v;
    });
  }
  return Uint32Array.from(out);
}

function referenceTangents(positions: Float32Array, fragments: FragmentIndex) {
  const out = new Float32Array(positions.length);
  const delta = (from: number, to: number) =>
    [0, 1, 2].map((d) => positions[3 * to + d] - positions[3 * from + d]);
  for (let f = 0; f < fragments.numFragments; ++f) {
    const walk: number[] = [];
    forEachFragmentVertex(fragments, f, (v) => walk.push(v));
    const n = walk.length;
    if (n < 2) continue;
    for (let i = 0; i < n; ++i) {
      const d = delta(walk[Math.max(0, i - 1)], walk[Math.min(n - 1, i + 1)]);
      const norm = Math.hypot(d[0], d[1], d[2]);
      if (norm > 0) for (let j = 0; j < 3; ++j) out[3 * walk[i] + j] = d[j] / norm;
    }
  }
  return out;
}

/** A deterministic pseudo-random sequence in [0, 1). */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * About `numVertices` vertices as random walks (some steps of length zero,
 * some fragments of one vertex), in fragments that are ranges or, every
 * fifth, explicit rows in shuffled order.
 */
function synthetic(numVertices: number, seed = 1) {
  const rand = random(seed);
  const positions = new Float32Array(numVertices * 3);
  const isRange: boolean[] = [];
  const rangeTable: bigint[] = [];
  const csrOffsets = [0];
  const csrIndices: bigint[] = [];
  let v = 0;
  while (v < numVertices) {
    const n = Math.min(numVertices - v, rand() < 0.05 ? 1 : 2 + Math.floor(rand() * 60));
    let x = rand() * 1000;
    let y = rand() * 1000;
    let z = rand() * 1000;
    for (let i = 0; i < n; ++i) {
      if (rand() > 0.02) {
        x += rand() - 0.5;
        y += rand() - 0.5;
        z += rand() - 0.5;
      }
      positions.set([x, y, z], 3 * (v + i));
    }
    if (isRange.length % 5 === 4) {
      const rows = Array.from({ length: n }, (_, i) => v + i);
      for (let i = rows.length - 1; i > 0; --i) {
        const j = Math.floor(rand() * (i + 1));
        [rows[i], rows[j]] = [rows[j], rows[i]];
      }
      for (const r of rows) csrIndices.push(BigInt(r));
      csrOffsets.push(csrIndices.length);
      isRange.push(false);
    } else {
      rangeTable.push(BigInt(v), BigInt(n));
      isRange.push(true);
    }
    v += n;
  }
  const bitmap = new Uint8Array(Math.ceil(isRange.length / 8));
  isRange.forEach((r, f) => {
    if (r) bitmap[f >> 3] |= 1 << (f & 7);
  });
  const fragments = new FragmentIndex(
    isRange.length,
    bitmap,
    BigInt64Array.from(rangeTable),
    Uint32Array.from(csrOffsets),
    BigInt64Array.from(csrIndices),
  );
  return { positions, fragments };
}

const bytes = (a: ArrayBufferView) =>
  new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** Where two arrays' bytes first differ, -1 if nowhere (quicker than toEqual at this size). */
function firstDifference(a: ArrayBufferView, b: ArrayBufferView): number {
  const x = bytes(a);
  const y = bytes(b);
  if (x.length !== y.length) return Math.min(x.length, y.length);
  for (let i = 0; i < x.length; ++i) if (x[i] !== y[i]) return i;
  return -1;
}

describe("typed decode loops", () => {
  it("give the same bytes as the plain loops, for a million vertices", () => {
    const { positions, fragments } = synthetic(1_000_000);
    expect(fragments.numExplicitFragments).toBeGreaterThan(1000);
    const edges = sequentialEdges(fragments);
    expect(edges.length).toBeGreaterThan(1_500_000);
    expect(firstDifference(edges, referenceEdges(fragments))).toBe(-1);
    expect(
      firstDifference(
        walkTangents(positions, fragments),
        referenceTangents(positions, fragments),
      ),
    ).toBe(-1);
  });

  it("count each fragment's rows without listing them", () => {
    const { fragments } = synthetic(5000, 7);
    for (let f = 0; f < fragments.numFragments; ++f) {
      expect(fragments.rowCount(f)).toBe(fragments.indices(f).length);
    }
  });
});

describe("a chunk with no ghosts", () => {
  it("keeps its decoded arrays, copying only the positions", () => {
    const { positions, fragments } = synthetic(10_000, 3);
    const numVertices = positions.length / 3;
    const decoded: DecodedChunk = {
      numVertices,
      positions,
      fragments,
      edges: sequentialEdges(fragments),
      faces: new Uint32Array(0),
      tangents: walkTangents(positions, fragments),
      attributes: [new Float32Array(numVertices).fill(2)],
      segmentIds: undefined,
      fragmentIds: undefined,
    };
    const ids = new Uint32Array(numVertices * 2).fill(5);
    // A ghost whose position was not found is dropped: none are left.
    const ghost = { host: 0, chunkKey: "1.0.0", vertex: 0, hostIsPredecessor: true };
    const out = assembleChunk(decoded, ids, [ghost], new Float32Array(3).fill(NaN));
    expect(out.numVertices).toBe(numVertices);
    expect(out.edges).toBe(decoded.edges);
    expect(out.segmentIds).toBe(ids);
    expect(out.attributes[0]).toBe(decoded.attributes[0]);
    expect(out.attributes[1]).toBe(decoded.tangents);
    // The positions view the shared vertex cell: copied, never handed over.
    expect(out.positions.buffer).not.toBe(positions.buffer);
    expect(firstDifference(out.positions, positions)).toBe(-1);
  });
});
