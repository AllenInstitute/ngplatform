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
 * @file Format 0.9.4's dense object-index layout (`dense_manifests_v1`):
 * manifests as two integer arrays rather than one blob per object.
 *
 *     object_index/manifest_spans   int64 (n_objects, 2)       start, count
 *     object_index/manifest_blocks  int64|int32 (n_blocks, sid_ndim + 1)
 *                                   chunk coords..., fragment index
 *
 * Object row `o` owns block rows `start .. start + count`, in manifest
 * order, one per fragment.  Blocks need not be contiguous or ordered by
 * object (a patch appends), so they are read by span, never by position.
 */

import type { ElementType } from "./dtype.js";
import type { ManifestBlock } from "./object_manifest.js";
import type { ZarrArrayReader } from "./zarr_array.js";

export const DENSE_MANIFESTS_LAYOUT = "dense_manifests_v1";
export const SPANS_PATH = "object_index/manifest_spans";
export const BLOCKS_PATH = "object_index/manifest_blocks";

export function isDenseLayout(objectIndexAttrs: any): boolean {
  return objectIndexAttrs?.layout === DENSE_MANIFESTS_LAYOUT;
}

/**
 * Integers of a fixed-size array's raw little-endian bytes, as numbers.
 * Spans and blocks are chunk-grid indices and counts, far below 2^53.
 */
export function decodeIntegers(
  bytes: Uint8Array,
  elementType: string,
): Float64Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = elementType as ElementType;
  const width =
    type === "int64" || type === "uint64"
      ? 8
      : type === "int32" || type === "uint32"
        ? 4
        : 0;
  if (width === 0) {
    throw new Error(`dense manifests: unexpected element type ${elementType}`);
  }
  const n = Math.floor(bytes.byteLength / width);
  const out = new Float64Array(n);
  for (let i = 0; i < n; ++i) {
    const at = i * width;
    out[i] =
      type === "int64"
        ? Number(view.getBigInt64(at, true))
        : type === "uint64"
          ? Number(view.getBigUint64(at, true))
          : type === "int32"
            ? view.getInt32(at, true)
            : view.getUint32(at, true);
  }
  return out;
}

/** The blocks of rows `[start, start + count)` as manifest blocks. */
export function blocksToManifest(
  blocks: Float64Array,
  columns: number,
  firstRow: number,
  start: number,
  count: number,
): ManifestBlock[] {
  const out: ManifestBlock[] = [];
  for (let r = start; r < start + count; ++r) {
    const base = (r - firstRow) * columns;
    const chunkCoords: number[] = new Array(columns - 1);
    for (let i = 0; i < columns - 1; ++i) chunkCoords[i] = blocks[base + i];
    out.push({
      chunkCoords,
      fragmentRef: { mode: "single", fragmentIndex: blocks[base + columns - 1] },
    });
  }
  return out;
}

/** Every object's manifest, by row: one read of each array, no decode. */
export async function readAllDenseManifests(
  spans: ZarrArrayReader,
  blocks: ZarrArrayReader,
  numObjects: number,
  signal?: AbortSignal,
): Promise<ManifestBlock[][]> {
  const [spanBytes, blockBytes] = await Promise.all([
    spans.readRows(0, numObjects, signal),
    blocks.readAllRows(signal),
  ]);
  const spanValues = decodeIntegers(spanBytes, spans.array.elementType);
  const blockValues = decodeIntegers(blockBytes, blocks.array.elementType);
  const columns = blocks.array.shape[1];
  const out: ManifestBlock[][] = [];
  for (let o = 0; o < numObjects; ++o) {
    const start = spanValues[2 * o];
    const count = spanValues[2 * o + 1];
    out.push(
      count > 0 ? blocksToManifest(blockValues, columns, 0, start, count) : [],
    );
  }
  return out;
}

/**
 * One object's manifest at a time, reading (and keeping) only the array
 * chunks its span and blocks fall in.
 */
export class DenseManifestReader {
  private chunks = new Map<string, Promise<Float64Array>>();
  private order: string[] = [];

  constructor(
    readonly spans: ZarrArrayReader,
    readonly blocks: ZarrArrayReader,
    private readonly maxChunks = 32,
    private readonly signal?: AbortSignal,
  ) {}

  private chunk(reader: ZarrArrayReader, index: number): Promise<Float64Array> {
    const key = `${reader === this.spans ? "s" : "b"}${index}`;
    let pending = this.chunks.get(key);
    if (pending === undefined) {
      pending = reader
        .readChunk([index, 0], this.signal)
        .then((bytes) =>
          bytes === undefined
            ? new Float64Array(
                reader.array.readChunkShape[0] * reader.array.shape[1],
              )
            : decodeIntegers(bytes, reader.array.elementType),
        );
      this.chunks.set(key, pending);
      this.order.push(key);
      pending.catch(() => this.chunks.delete(key));
      while (this.order.length > this.maxChunks) {
        this.chunks.delete(this.order.shift()!);
      }
    }
    return pending;
  }

  async manifest(row: number): Promise<ManifestBlock[]> {
    const spanRows = this.spans.array.readChunkShape[0];
    const spanChunk = Math.floor(row / spanRows);
    const spans = await this.chunk(this.spans, spanChunk);
    const at = (row - spanChunk * spanRows) * 2;
    const start = spans[at];
    const count = spans[at + 1];
    if (!(count > 0)) return [];
    const blockRows = this.blocks.array.readChunkShape[0];
    const columns = this.blocks.array.shape[1];
    const first = Math.floor(start / blockRows);
    const last = Math.floor((start + count - 1) / blockRows);
    const out: ManifestBlock[] = [];
    for (let c = first; c <= last; ++c) {
      const values = await this.chunk(this.blocks, c);
      const lo = Math.max(start, c * blockRows);
      const hi = Math.min(start + count, (c + 1) * blockRows);
      out.push(...blocksToManifest(values, columns, c * blockRows, lo, hi - lo));
    }
    return out;
  }
}
