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
 * A chunk only cross-sections draw reads no neighbour's vertices for its
 * bridges: it keeps those into neighbours already at hand (cached, being
 * read, or drawn by the view) and leaves out the rest, which lie off the
 * plane. A chunk a 3-D view draws keeps every bridge.
 */

import { describe, expect, it } from "vitest";
import { LevelPipeline } from "./chunk_pipeline.js";
import { openZarrVectorsStore } from "./store.js";
import { fixtureListDirectories, fixtureRead } from "./test_fixtures.js";
import { ShardIndexCache } from "./zarr_array.js";

const signal = new AbortController().signal;

async function setUp(name: string) {
  const reads: string[] = [];
  const read = fixtureRead(name);
  const access = {
    read: (path: string, options: any) => {
      if (path.startsWith("0/vertices/c/")) reads.push(path);
      return read(path, options);
    },
    listDirectories: fixtureListDirectories(name),
    shardIndexes: new ShardIndexCache(),
  };
  const store = await openZarrVectorsStore(access, undefined);
  const level = store.levels[0];
  const { shape, attributes } = level.arrays.vertices;
  const origin = attributes.chunk_grid_origin ?? [0, 0, 0];
  const chunks: number[][] = [];
  for (let i = 0; i < shape[0]; ++i) {
    for (let j = 0; j < shape[1]; ++j) {
      for (let k = 0; k < shape[2]; ++k) {
        chunks.push([i + origin[0], j + origin[1], k + origin[2]]);
      }
    }
  }
  reads.length = 0;
  const pipeline = (requested: (c: readonly number[]) => boolean = () => false) =>
    new LevelPipeline(access, store.description, level, requested);
  return { reads, chunks, pipeline };
}

describe("bridges of a chunk only cross-sections draw", () => {
  it("read no neighbour's vertices, and say how many were left out", async () => {
    const { reads, chunks, pipeline } = await setUp("poly_raw");
    let leftOut = 0;
    let drawn = 0;
    for (const chunk of chunks) {
      // A pipeline of its own each: nothing cached from another chunk.
      const data = await pipeline().download(chunk, signal, { sliceOnly: true });
      if (data === undefined) continue;
      ++drawn;
      expect(data.numVertices).toBe(data.numOwnVertices);
      leftOut += data.ghostsLeftOut ?? 0;
    }
    expect(drawn).toBeGreaterThan(1);
    expect(leftOut).toBeGreaterThan(0);
    // The cells read are those of the chunks alone, as without bridges.
    const sliceReads = reads.splice(0);
    for (const chunk of chunks) {
      await pipeline().download(chunk, signal, { bridges: false });
    }
    expect(sliceReads.sort()).toEqual(reads.sort());
  });

  it("keep those into a neighbour already read, or one the view draws", async () => {
    const { chunks, pipeline } = await setUp("poly_raw");
    // In 3-D: every bridge, and which neighbour each goes to.
    const full = pipeline();
    let withBridges: { chunk: number[]; bridges: number } | undefined;
    for (const chunk of chunks) {
      const data = await full.download(chunk, signal);
      const bridges = data === undefined ? 0 : data.numVertices - data.numOwnVertices;
      if (bridges > 0) {
        withBridges = { chunk, bridges };
        break;
      }
    }
    expect(withBridges).toBeDefined();
    const { chunk, bridges } = withBridges!;
    // Every neighbour drawn by the view: all bridges kept.
    const drawnAround = await pipeline(() => true).download(chunk, signal, { sliceOnly: true });
    expect(drawnAround!.numVertices - drawnAround!.numOwnVertices).toBe(bridges);
    expect(drawnAround!.ghostsLeftOut).toBeUndefined();
    // Every neighbour read before it: all bridges kept too.
    const cached = pipeline();
    for (const other of chunks) {
      if (other.join() !== chunk.join()) await cached.download(other, signal);
    }
    const afterNeighbours = await cached.download(chunk, signal, { sliceOnly: true });
    expect(afterNeighbours!.numVertices - afterNeighbours!.numOwnVertices).toBe(bridges);
  });
});

describe("bridges of a chunk a 3-D view draws", () => {
  it("are all kept, reading neighbours as before", async () => {
    const { reads, chunks, pipeline } = await setUp("poly_raw");
    let bridges = 0;
    for (const chunk of chunks) {
      const data = await pipeline().download(chunk, signal);
      if (data === undefined) continue;
      bridges += data.numVertices - data.numOwnVertices;
      expect(data.ghostsLeftOut).toBeUndefined();
    }
    expect(bridges).toBeGreaterThan(0);
    // Neighbours' rows read beside the chunks' own cells.
    const fullReads = reads.length;
    reads.length = 0;
    for (const chunk of chunks) {
      await pipeline().download(chunk, signal, { bridges: false });
    }
    expect(fullReads).toBeGreaterThan(reads.length);
  });
});
