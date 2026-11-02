/**
 * Neuroglancer precomputed annotations, for plugins that query them in their
 * own workers: the annotations whose spatial-index chunks meet a box, read
 * from every level (a level holds the annotations not held by coarser ones),
 * sharded or not, with their geometry and ids.
 *
 * A spatial chunk is: uint64 count, then `count` records (the geometry as
 * float32, then the properties, padded to 4 bytes), then `count` uint64 ids
 * (Neuroglancer's src/datasource/precomputed/backend.ts, parseAnnotations).
 */
import { chunkId, httpRead, type RangeRead, type Sharding, ShardedReader } from "./precomputed.js";

export type AnnotationType = "POINT" | "LINE" | "AXIS_ALIGNED_BOUNDING_BOX" | "ELLIPSOID";

export interface AnnotationInfo {
  "@type": "neuroglancer_annotations_v1";
  annotation_type: AnnotationType;
  /** Name to [scale, unit], in order. */
  dimensions: Record<string, [number, string]>;
  lower_bound: number[];
  upper_bound: number[];
  properties?: { id: string; type: string }[];
  spatial: { key: string; grid_shape: number[]; chunk_size: number[]; limit: number; sharding?: Sharding }[];
}

export interface Annotation {
  id: bigint;
  /** Its points in the source's coordinates: a point's one, a line's or box's two, an ellipsoid's centre and radii. */
  points: number[][];
}

const PROPERTY_BYTES: Record<string, [number, number]> = {
  // [bytes, alignment]
  float32: [4, 4], uint32: [4, 4], int32: [4, 4], uint16: [2, 2], int16: [2, 2], uint8: [1, 1], int8: [1, 1], rgb: [3, 1], rgba: [4, 1],
};

/** Bytes a record takes: its geometry, then its properties by alignment (largest first), padded to 4. */
export function recordBytes(info: Pick<AnnotationInfo, "annotation_type" | "dimensions" | "properties">): number {
  const rank = Object.keys(info.dimensions).length;
  const points = info.annotation_type === "POINT" ? 1 : 2;
  let offset = 4 * rank * points;
  const props = (info.properties ?? []).map((p) => PROPERTY_BYTES[p.type] ?? [4, 4]).sort((a, b) => b[1] - a[1]);
  for (const [bytes, alignment] of props) offset += ((alignment - (offset % alignment)) % alignment) + bytes;
  return offset + ((4 - (offset % 4)) % 4);
}

/** The annotations in one spatial chunk. */
export function decodeSpatialChunk(bytes: Uint8Array, info: Pick<AnnotationInfo, "annotation_type" | "dimensions" | "properties">): Annotation[] {
  if (bytes.byteLength < 8) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const rank = Object.keys(info.dimensions).length;
  const points = info.annotation_type === "POINT" ? 1 : 2;
  const size = recordBytes(info);
  const idsAt = 8 + size * count;
  if (bytes.byteLength < idsAt + 8 * count) throw new Error(`an annotation chunk of ${bytes.byteLength} bytes for ${count} annotations`);
  const out: Annotation[] = [];
  for (let i = 0; i < count; ++i) {
    const at = 8 + size * i;
    const pts: number[][] = [];
    for (let p = 0; p < points; ++p) pts.push(Array.from({ length: rank }, (_, k) => view.getFloat32(at + 4 * (p * rank + k), true)));
    out.push({ id: view.getBigUint64(idsAt + 8 * i, true), points: pts });
  }
  return out;
}

export async function readAnnotationInfo(url: string, read: RangeRead = httpRead, signal?: AbortSignal): Promise<AnnotationInfo> {
  const bytes = await read(`${url}info`, undefined, signal);
  if (bytes === undefined) throw new Error(`${url}: no info file`);
  const info = JSON.parse(new TextDecoder().decode(bytes)) as AnnotationInfo;
  if (info["@type"] !== "neuroglancer_annotations_v1") throw new Error(`${url}: not precomputed annotations`);
  return info;
}

export class PrecomputedAnnotations {
  private readonly sharded = new Map<number, ShardedReader>();

  constructor(
    readonly url: string,
    readonly info: AnnotationInfo,
    private readonly read: RangeRead = httpRead,
  ) {}

  /** Every annotation in a spatial chunk meeting the box [lo, hi] (source coordinates), once each. */
  async inBox(lo: number[], hi: number[], signal?: AbortSignal): Promise<{ annotations: Annotation[]; chunks: number }> {
    const seen = new Set<bigint>();
    const out: Annotation[] = [];
    let chunks = 0;
    const base = this.info.lower_bound;
    for (let level = 0; level < this.info.spatial.length; ++level) {
      const spec = this.info.spatial[level];
      const first = spec.grid_shape.map((g, k) => Math.max(0, Math.floor((lo[k] - base[k]) / spec.chunk_size[k])));
      const last = spec.grid_shape.map((g, k) => Math.min(g - 1, Math.floor((hi[k] - base[k]) / spec.chunk_size[k])));
      const positions: number[][] = [];
      for (let z = first[2]; z <= last[2]; ++z) for (let y = first[1]; y <= last[1]; ++y) for (let x = first[0]; x <= last[0]; ++x) positions.push([x, y, z]);
      const results = await Promise.all(positions.map((p) => this.chunk(level, p, signal)));
      chunks += positions.length;
      for (const bytes of results) {
        if (bytes === undefined) continue;
        for (const a of decodeSpatialChunk(bytes, this.info)) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          out.push(a);
        }
      }
    }
    return { annotations: out, chunks };
  }

  private chunk(level: number, position: number[], signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const spec = this.info.spatial[level];
    if (spec.sharding === undefined) return this.read(`${this.url}${spec.key}/${position.join("_")}`, undefined, signal);
    let reader = this.sharded.get(level);
    if (reader === undefined) this.sharded.set(level, (reader = new ShardedReader(`${this.url}${spec.key}/`, spec.sharding, this.read)));
    return reader.read(chunkId(position, spec.grid_shape), signal);
  }
}
