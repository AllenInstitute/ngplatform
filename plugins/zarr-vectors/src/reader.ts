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
import { listHttpDirectories } from "./http_listing.js";

export type { DenseChunkData, ZarrVectorsLevel, ZarrVectorsStore, ZarrVectorsStoreAccess };
export { LevelPipeline, ObjectReader, openZarrVectorsStore, setVertexCellCacheBytes };
export { storeUrlOfSource } from "./source_url.js";
// A level's object table (object id and segment id per row), for tools that
// relate Neuroglancer's segment ids to the store's object ids.
export type { ZarrVectorsObjectTable } from "./objects.js";
export { readObjectTable } from "./objects.js";
// Plain Zarr v3 arrays (sharded or not, any of Neuroglancer's codecs), for
// tools that read other arrays beside a store, such as an image volume.
export type { ZarrArray, ZarrArrayRead } from "./zarr_array.js";
export { openZarrArray, ShardIndexCache, ZarrArrayReader } from "./zarr_array.js";

/**
 * Store access over `fetch`, with byte ranges.  Listing is not offered
 * (a static host cannot list) unless asked for (`listing`: a Cloud Storage
 * bucket's JSON API, or a server's HTML directory index, as
 * ./http_listing.ts reads them, which a mesh's faces spanning chunks
 * need); without it, or where it fails, the reader probes instead.
 */
export function httpAccess(storeUrl: string, options: { listing?: boolean } = {}): ZarrVectorsStoreAccess {
  return kvStoreAccess(
    {
      async read(url, options: { signal?: AbortSignal; byteRange?: { offset: number; length: number } | { suffixLength: number } }) {
        const headers: Record<string, string> = {};
        const range = options.byteRange;
        if (range !== undefined) {
          headers.Range = "suffixLength" in range ? `bytes=-${range.suffixLength}` : `bytes=${range.offset}-${range.offset + range.length - 1}`;
        }
        let response = await fetch(url, { headers, signal: options.signal });
        // A store still being made from a file on this computer answers 503 for a while: ask again.
        for (let attempt = 0; response.status === 503 && attempt < 120; ++attempt) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)));
          options.signal?.throwIfAborted();
          response = await fetch(url, { headers, signal: options.signal });
        }
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
      async list(url: string, listOptions: { signal?: AbortSignal }) {
        if (!options.listing) throw new Error("listing is not supported over plain HTTP");
        return { directories: await listHttpDirectories(url, listOptions?.signal) };
      },
    },
    storeUrl,
  );
}

/** A level's chunk at `chunk` (grid coordinates), or undefined when empty. */
export function levelPipeline(access: ZarrVectorsStoreAccess, store: ZarrVectorsStore, level: ZarrVectorsLevel): LevelPipeline {
  return new LevelPipeline(access, store.description, level);
}
