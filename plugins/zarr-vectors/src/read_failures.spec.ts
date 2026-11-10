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
 * A read that fails on the network is not an empty cell: it is tried again,
 * then fails the chunk, and is never kept. Only a key that is not there (404)
 * reads as empty.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LevelPipeline } from "./chunk_pipeline.js";
import type { DenseChunkData } from "./chunk_pipeline.js";
import { kvStoreAccess, openZarrVectorsStore } from "./store.js";
import { FIXTURE_DIR } from "./test_fixtures.js";
import { NotFoundError } from "neuroglancer/unstable/kvstore/index.js";
import { HttpError } from "neuroglancer/unstable/util/http_request.js";

const signal = new AbortController().signal;

/**
 * A kvstore context over a fixture store that answers as Neuroglancer's
 * HTTP kvstore does: with `throwIfMissing`, a missing key throws a
 * NotFoundError whose cause is the 404, and a network failure one whose
 * cause has status 0; without it, both read as `undefined`. `fails(n)` says
 * whether the n-th read (from 1) fails on the network.
 */
function fixtureContext(store: string, fails: (n: number, url: string) => boolean) {
  const root = path.join(FIXTURE_DIR, `${store}.zarrvectors`);
  const log: string[] = [];
  let n = 0;
  const context = {
    async read(url: string, options: any) {
      const rel = url.replace(/^http:\/\/example\/store\//, "");
      log.push(rel);
      const handle = { getUrl: () => url };
      const missing = (status: number) => {
        if (options.throwIfMissing) {
          throw new NotFoundError(handle as any, {
            cause: new HttpError(url, status, ""),
          });
        }
        return undefined;
      };
      if (fails(++n, rel)) return missing(0);
      let file: Buffer;
      try {
        file = fs.readFileSync(path.join(root, rel));
      } catch {
        return missing(404);
      }
      const range = options.byteRange;
      if (range === undefined) {
        return { response: new Response(new Uint8Array(file)), offset: 0 };
      }
      const offset =
        "suffixLength" in range ? file.length - range.suffixLength : range.offset;
      const length = "suffixLength" in range ? range.suffixLength : range.length;
      return {
        response: new Response(new Uint8Array(file.subarray(offset, offset + length))),
        offset,
      };
    },
    async list() {
      return { directories: [] };
    },
  };
  return { context, log };
}

const quick = { attempts: 4, delayMs: 1 };

async function everyChunk(
  store: string,
  fails: (n: number, url: string) => boolean,
) {
  const { context, log } = fixtureContext(store, fails);
  const access = kvStoreAccess(context, "http://example/store/", undefined, quick);
  const opened = await openZarrVectorsStore(access, undefined);
  const level = opened.levels[0];
  const pipeline = new LevelPipeline(access, opened.description, level);
  const { shape, attributes } = level.arrays.vertices;
  const origin = attributes.chunk_grid_origin ?? [0, 0, 0];
  const out = new Map<string, DenseChunkData | undefined>();
  for (let i = 0; i < shape[0]; ++i) {
    for (let j = 0; j < shape[1]; ++j) {
      for (let k = 0; k < shape[2]; ++k) {
        const chunk = [i + origin[0], j + origin[1], k + origin[2]];
        out.set(chunk.join(), await pipeline.download(chunk, signal));
      }
    }
  }
  return { out, log, pipeline };
}

const summary = (chunk: DenseChunkData | undefined) =>
  chunk === undefined
    ? "empty"
    : JSON.stringify([
        Array.from(chunk.positions),
        Array.from(chunk.segmentIds),
        Array.from(chunk.edges),
        chunk.attributes.map((a) => Array.from(a)),
      ]);

describe("reads that fail on the network", () => {
  it("with every 10th read failing, end with every cell as without failures, and no manifest scan", async () => {
    for (const store of ["add_replace", "poly_zstd_shard", "ids_int32"]) {
      const clean = await everyChunk(store, () => false);
      const flaky = await everyChunk(store, (n) => n % 10 === 0);
      expect(flaky.out.size, store).toBe(clean.out.size);
      expect([...clean.out.values()].some((c) => c !== undefined), store).toBe(true);
      for (const [key, chunk] of clean.out) {
        expect(summary(flaky.out.get(key)), `${store} ${key}`).toBe(summary(chunk));
      }
      // A failed segment_id cell must not send the reader to the manifests.
      const scans = (log: string[]) =>
        log.filter((p) => /object_index\/(manifests|manifest_spans)\/c/.test(p)).length;
      expect(scans(flaky.log), store).toBe(scans(clean.log));
    }
  });

  it("fail the chunk when the network stays down, and read it afresh later", async () => {
    let down = false;
    const { context } = fixtureContext("add_replace", (_n, url) => down && url.startsWith("0/vertices/c"));
    const access = kvStoreAccess(context, "http://example/store/", undefined, quick);
    const opened = await openZarrVectorsStore(access, undefined);
    const level = opened.levels[0];
    const pipeline = new LevelPipeline(access, opened.description, level);
    const origin = level.arrays.vertices.attributes.chunk_grid_origin ?? [0, 0, 0];
    const fresh = await pipeline.download(origin, signal);
    expect(fresh).toBeDefined();
    // Another pipeline: nothing cached from the first.
    const second = new LevelPipeline(access, opened.description, level);
    down = true;
    await expect(second.download(origin, signal)).rejects.toMatchObject({ status: 0 });
    down = false;
    expect(summary(await second.download(origin, signal))).toBe(summary(fresh));
  });

  it("read a key that is not there (404) as empty", async () => {
    const { context } = fixtureContext("add_replace", () => false);
    const access = kvStoreAccess(context, "http://example/store/", undefined, quick);
    expect(await access.read("0/no_such_array/zarr.json", {})).toBeUndefined();
    const opened = await openZarrVectorsStore(access, undefined);
    const level = opened.levels[0];
    const pipeline = new LevelPipeline(access, opened.description, level);
    // Far outside the store: no cell there.
    expect(await pipeline.download([1000, 1000, 1000], signal)).toBeUndefined();
  });

  it("are tried a few times, waiting longer each time", async () => {
    let calls = 0;
    const context = {
      async read() {
        ++calls;
        throw new TypeError("Failed to fetch");
      },
      async list() {
        return { directories: [] };
      },
    };
    const access = kvStoreAccess(context, "http://example/store/", undefined, quick);
    await expect(access.read("zarr.json", {})).rejects.toMatchObject({ status: 0 });
    expect(calls).toBe(quick.attempts);
  });
});
