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
 * @file A segment property map that finds an id's row by binary search.
 *
 * Neuroglancer's {@link PreprocessedSegmentPropertyMap} builds a hash table
 * from id to row when it is made, on the main thread.  For a store of
 * millions of objects that took about two seconds and 32 MiB (3.3 million
 * streamlines).  The ids `readSegmentProperties` writes are in ascending
 * order, so a binary search finds a row with no table; lookups are made
 * only for what is on screen (a hovered segment, the segment list's rows).
 * Ids out of order are looked up through Neuroglancer's table, built the
 * first time one is asked for.
 */

import {
  type InlineSegmentNumericalProperty,
  type InlineSegmentStringProperty,
  type InlineSegmentTagsProperty,
  PreprocessedSegmentPropertyMap,
  SegmentPropertyMap,
} from "neuroglancer/unstable/segmentation_display_state/property_map.js";

/** Whether `ids` rise strictly, read as 32-bit halves (no BigInt per element). */
export function idsAscending(ids: BigUint64Array): boolean {
  const words = new Uint32Array(ids.buffer, ids.byteOffset, ids.length * 2);
  // Little-endian: the low word first.
  for (let i = 2, n = words.length; i < n; i += 2) {
    const hi = words[i + 1];
    const prevHi = words[i - 1];
    if (hi < prevHi || (hi === prevHi && words[i] <= words[i - 2])) {
      return false;
    }
  }
  return true;
}

/** The row of `id` in ascending `ids`, or -1. */
export function sortedIndexOf(ids: BigUint64Array, id: bigint): number {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = ids[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export class SortedSegmentPropertyMap extends PreprocessedSegmentPropertyMap {
  private readonly ids: BigUint64Array | undefined;
  private readonly sorted: boolean;
  private hashed: PreprocessedSegmentPropertyMap | undefined;

  constructor(map: SegmentPropertyMap) {
    // The base class builds its table from the inline properties it is
    // given: given none, it builds none.  The fields it would set from them
    // are set here as it sets them.
    super(new SegmentPropertyMap({ inlineProperties: undefined }));
    this.segmentPropertyMap = map;
    const inline = map.inlineProperties;
    this.tags = inline?.properties.find((p) => p.type === "tags") as
      | InlineSegmentTagsProperty
      | undefined;
    this.labels = inline?.properties.find((p) => p.type === "label") as
      | InlineSegmentStringProperty
      | undefined;
    this.numericalProperties = (inline?.properties.filter(
      (p) => p.type === "number",
    ) ?? []) as InlineSegmentNumericalProperty[];
    this.ids = inline?.ids;
    this.sorted = this.ids === undefined || idsAscending(this.ids);
  }

  getSegmentInlineIndex(id: bigint): number {
    const { ids } = this;
    if (ids === undefined) return -1;
    if (this.sorted) return sortedIndexOf(ids, id);
    this.hashed ??= new PreprocessedSegmentPropertyMap(this.segmentPropertyMap);
    return this.hashed.getSegmentInlineIndex(id);
  }
}
