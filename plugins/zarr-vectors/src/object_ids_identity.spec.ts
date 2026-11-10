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
 * Opening a store whose sorted `object_ids` are its rows reads two of the
 * column's chunks, not all of them: the layer's first draw waits on it.
 */

import { describe, expect, it } from "vitest";
import { readObjectTable } from "./objects.js";
import type { ZarrVectorsStoreAccess } from "./store.js";
import { fixtureRead } from "./test_fixtures.js";
import { ShardIndexCache } from "./zarr_array.js";

const NUM_OBJECTS = 100_000;
const CHUNK = 1000;

/**
 * poly_raw with level 0's object index replaced by `ids` (int64, raw, in
 * chunks of {@link CHUNK}); `sorted` sets `object_ids_sorted`.
 */
function store(ids: BigInt64Array, sorted: boolean) {
  const base = fixtureRead("poly_raw");
  const files = new Map<string, Uint8Array>();
  const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  files.set(
    "0/object_index/zarr.json",
    json({
      zarr_format: 3,
      node_type: "group",
      attributes: {
        zv_array: "object_index",
        num_objects: ids.length,
        num_present: ids.length,
        sid_ndim: 3,
        layout: "vlen_manifests_v2",
        ...(sorted ? { object_ids_sorted: true } : {}),
      },
    }),
  );
  files.set(
    "0/object_index/object_ids/zarr.json",
    json({
      zarr_format: 3,
      node_type: "array",
      shape: [ids.length],
      data_type: "int64",
      chunk_grid: { name: "regular", configuration: { chunk_shape: [CHUNK] } },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: 0,
      codecs: [{ name: "bytes", configuration: { endian: "little" } }],
      attributes: {},
    }),
  );
  for (let c = 0; c * CHUNK < ids.length; ++c) {
    const chunk = new BigInt64Array(CHUNK);
    chunk.set(ids.subarray(c * CHUNK, (c + 1) * CHUNK));
    files.set(`0/object_index/object_ids/c/${c}`, new Uint8Array(chunk.buffer));
  }
  const reads: string[] = [];
  const access: ZarrVectorsStoreAccess = {
    read: async (path, options) => {
      reads.push(path);
      const file = files.get(path);
      if (file === undefined) return base(path, options);
      return file.slice();
    },
    listDirectories: async () => [],
    shardIndexes: new ShardIndexCache(),
  };
  const chunkReads = () =>
    reads.filter((p) => p.startsWith("0/object_index/object_ids/c/")).length;
  return { access, chunkReads };
}

const rows = (n: number) => BigInt64Array.from({ length: n }, (_, i) => BigInt(i));

describe("an object table whose sorted ids are its rows", () => {
  it("is known from the first and last id: two chunk reads of a hundred", async () => {
    const { access, chunkReads } = store(rows(NUM_OBJECTS), true);
    const table = (await readObjectTable(access, "0"))!;
    expect(chunkReads()).toBe(2);
    expect(table.idSource).toBe("row");
    expect(table.numObjects).toBe(NUM_OBJECTS);
    expect(table.segmentIds[NUM_OBJECTS - 1]).toBe(BigInt(NUM_OBJECTS - 1));
  });

  it("is read whole when the ids are not the rows", async () => {
    const ids = rows(NUM_OBJECTS);
    ids[NUM_OBJECTS - 1] = BigInt(NUM_OBJECTS + 5);
    const { access, chunkReads } = store(ids, true);
    const table = (await readObjectTable(access, "0"))!;
    expect(table.idSource).toBe("object_ids");
    expect(table.segmentIds[NUM_OBJECTS - 1]).toBe(BigInt(NUM_OBJECTS + 5));
    expect(chunkReads()).toBe(2 + NUM_OBJECTS / CHUNK);
  });

  it("is read whole when the writer does not say the ids are sorted", async () => {
    const { access, chunkReads } = store(rows(NUM_OBJECTS), false);
    const table = (await readObjectTable(access, "0"))!;
    expect(table.idSource).toBe("object_ids");
    expect(chunkReads()).toBe(NUM_OBJECTS / CHUNK);
  });
});
