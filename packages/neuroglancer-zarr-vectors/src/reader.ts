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
 * @file The reader, for tools that work on a store's geometry outside
 * Neuroglancer's views (filters, statistics): open a store over plain HTTP
 * and read a level's spatial chunks as positions, per-vertex object ids and
 * line segments, or many objects' whole curves at once (`ObjectReader`).  Runs in any worker; nothing here touches the DOM or WebGL.
 */

import type { DenseChunkData } from "./chunk_pipeline.js";
import { LevelPipeline, setVertexCellCacheBytes } from "./chunk_pipeline.js";
import { ObjectReader } from "./object_reader.js";
import type { ZarrVectorsLevel, ZarrVectorsStore, ZarrVectorsStoreAccess } from "./store.js";
import { kvStoreAccess, openZarrVectorsStore } from "./store.js";

export type { DenseChunkData, ZarrVectorsLevel, ZarrVectorsStore, ZarrVectorsStoreAccess };
export { LevelPipeline, ObjectReader, openZarrVectorsStore, setVertexCellCacheBytes };
export { storeUrlOfSource } from "./source_url.js";
// Plain Zarr v3 arrays (sharded or not, any of Neuroglancer's codecs), for
// tools that read other arrays beside a store, such as an image volume.
export type { ZarrArray } from "./zarr_array.js";
export { openZarrArray, ShardIndexCache, ZarrArrayReader } from "./zarr_array.js";

/**
 * Store access over `fetch`, with byte ranges.  Listing is not offered
 * (a static host cannot list); the reader then probes instead.
 */
export function httpAccess(storeUrl: string): ZarrVectorsStoreAccess {
  return kvStoreAccess(
    {
      async read(url, options: { signal?: AbortSignal; byteRange?: { offset: number; length: number } | { suffixLength: number } }) {
        const headers: Record<string, string> = {};
        const range = options.byteRange;
        if (range !== undefined) {
          headers.Range = "suffixLength" in range ? `bytes=-${range.suffixLength}` : `bytes=${range.offset}-${range.offset + range.length - 1}`;
        }
        const response = await fetch(url, { headers, signal: options.signal });
        if (response.status === 404 || response.status === 403) return undefined;
        if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
        // Where the returned bytes start: a 206 says; a 200 is the whole file.
        let offset = 0;
        const contentRange = response.headers.get("Content-Range");
        const match = contentRange?.match(/bytes (\d+)-/);
        if (response.status === 206 && match) offset = Number(match[1]);
        else if (response.status === 206 && range !== undefined && "offset" in range) offset = range.offset;
        return { response, offset };
      },
      async list() {
        throw new Error("listing is not supported over plain HTTP");
      },
    },
    storeUrl,
  );
}

/** A level's chunk at `chunk` (grid coordinates), or undefined when empty. */
export function levelPipeline(access: ZarrVectorsStoreAccess, store: ZarrVectorsStore, level: ZarrVectorsLevel): LevelPipeline {
  return new LevelPipeline(access, store.description, level);
}
