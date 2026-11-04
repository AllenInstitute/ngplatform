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
 * The binary-search property map answers as Neuroglancer's hash-table one
 * does: rows, labels with tags, numerical properties, and ids out of order.
 */

import {
  type InlineSegmentPropertyMap,
  PreprocessedSegmentPropertyMap,
  SegmentPropertyMap,
} from "neuroglancer/unstable/segmentation_display_state/property_map.js";
import { DataType } from "neuroglancer/unstable/util/data_type.js";
import { describe, expect, it } from "vitest";
import {
  idsAscending,
  sortedIndexOf,
  SortedSegmentPropertyMap,
} from "./sorted_property_map.js";

function inline(ids: bigint[]): InlineSegmentPropertyMap {
  const n = ids.length;
  return {
    ids: BigUint64Array.from(ids),
    properties: [
      { id: "label", type: "label", values: ids.map((id) => `s${id}`) },
      {
        id: "tags",
        type: "tags",
        tags: ["left", "long"],
        tagDescriptions: ["", ""],
        values: ids.map((_, i) => (i % 2 === 0 ? "\x00\x01" : "")),
      },
      {
        id: "length",
        type: "number",
        dataType: DataType.FLOAT32,
        description: undefined,
        values: Float32Array.from(ids, (_, i) => i * 1.5),
        bounds: [0, n * 1.5],
      },
    ],
  };
}

function compare(ids: bigint[], probes: bigint[]) {
  const map = new SegmentPropertyMap({ inlineProperties: inline(ids) });
  const sorted = new SortedSegmentPropertyMap(map);
  const hashed = new PreprocessedSegmentPropertyMap(map);
  for (const id of probes) {
    expect(sorted.getSegmentInlineIndex(id)).toBe(hashed.getSegmentInlineIndex(id));
    expect(sorted.getSegmentLabel(id)).toBe(hashed.getSegmentLabel(id));
  }
  expect(sorted.segmentPropertyMap).toBe(map);
  expect(sorted.tags).toBe(hashed.tags);
  expect(sorted.labels).toBe(hashed.labels);
  expect(sorted.numericalProperties).toEqual(hashed.numericalProperties);
  return sorted;
}

describe("SortedSegmentPropertyMap", () => {
  it("finds rows as the hash table does, for ascending ids", () => {
    const ids = [1n, 2n, 3n, 7n, 2n ** 32n, 2n ** 32n + 5n, 2n ** 63n + 1n];
    compare(ids, [0n, ...ids, 4n, 2n ** 32n + 1n, 2n ** 64n - 1n]);
  });

  it("falls back to the hash table for ids out of order", () => {
    const ids = [5n, 3n, 9n, 2n ** 40n, 1n];
    compare(ids, [0n, ...ids, 4n]);
  });

  it("finds nothing without inline properties", () => {
    const map = new SortedSegmentPropertyMap(new SegmentPropertyMap({ inlineProperties: undefined }));
    expect(map.getSegmentInlineIndex(1n)).toBe(-1);
    expect(map.getSegmentLabel(1n)).toBeUndefined();
    expect(map.numericalProperties).toEqual([]);
  });

  it("looks up a million ids", () => {
    const n = 1_000_000;
    const ids = new BigUint64Array(n);
    for (let i = 0; i < n; ++i) ids[i] = BigInt(i * 3 + 1);
    const map = new SortedSegmentPropertyMap(
      new SegmentPropertyMap({ inlineProperties: { ids, properties: [] } }),
    );
    expect(map.getSegmentInlineIndex(1n)).toBe(0);
    expect(map.getSegmentInlineIndex(BigInt((n - 1) * 3 + 1))).toBe(n - 1);
    expect(map.getSegmentInlineIndex(BigInt(500_000 * 3 + 1))).toBe(500_000);
    expect(map.getSegmentInlineIndex(2n)).toBe(-1);
  });
});

describe("idsAscending", () => {
  it("compares across the 32-bit halves", () => {
    expect(idsAscending(BigUint64Array.from([]))).toBe(true);
    expect(idsAscending(BigUint64Array.from([4n]))).toBe(true);
    expect(idsAscending(BigUint64Array.from([1n, 2n ** 32n, 2n ** 32n + 1n]))).toBe(true);
    expect(idsAscending(BigUint64Array.from([2n ** 32n, 1n]))).toBe(false);
    expect(idsAscending(BigUint64Array.from([3n, 3n]))).toBe(false);
    expect(idsAscending(BigUint64Array.from([2n ** 32n + 2n, 2n ** 32n + 1n]))).toBe(false);
  });

  it("reads a view at an offset", () => {
    const all = BigUint64Array.from([9n, 1n, 2n, 3n]);
    expect(idsAscending(all.subarray(1))).toBe(true);
    expect(idsAscending(all)).toBe(false);
  });
});

describe("sortedIndexOf", () => {
  it("finds each id and misses the rest", () => {
    const ids = BigUint64Array.from([2n, 4n, 6n, 8n]);
    expect([1n, 2n, 3n, 4n, 6n, 8n, 9n].map((x) => sortedIndexOf(ids, x))).toEqual([-1, 0, -1, 1, 2, 3, -1]);
    expect(sortedIndexOf(new BigUint64Array(0), 1n)).toBe(-1);
  });
});
