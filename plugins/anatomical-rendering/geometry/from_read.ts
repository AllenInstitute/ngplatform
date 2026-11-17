/**
 * A layer's geometry, as read (points.ts readGeometry), as primitives to
 * trace: a mesh's triangles, points as spheres, lines as tubes. A mesh's
 * objects take their segments' colours as the frame draws them; points'
 * and lines' are coloured once, as the layer colours them (by group, else
 * by object).
 */
import type { BuiltChunk } from "../../luxar/chunk_build.js";
import { type ColourByLook, groupPalette } from "@ngplatform/sdk/colour_by";
import { chunkPoints, type GeometryRead, groupColours } from "../points.js";
import { type IndexedPoint, linePrimitives, lineRadius, meshPrimitives, pointPrimitives, pointRadius, type Primitives } from "./primitives.js";

/** A layer's primitives and their objects' colours: by segment (`ids`, coloured each frame), else fixed (`colours`, rgb). */
export interface LayerGeometry {
  prims: Primitives;
  objectCount: number;
  /** A mesh's objects: segment ids, coloured as the layer colours them now. */
  ids?: bigint[];
  /** Points' and lines' objects: their colours, 3 floats each. */
  colours?: Float32Array;
  /** Spheres' and tubes' radius (mm; a vertex's own where the store has radii). */
  radius?: number;
  /** What it is, for the readout. */
  text: string;
}

/** Fixed colours, numbered as met. */
class Palette {
  private readonly index = new Map<string | number | bigint, number>();
  readonly rgb: number[] = [];
  of(key: string | number | bigint, colour: () => [number, number, number]): number {
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.index.size;
      this.index.set(key, i);
      this.rgb.push(...colour());
    }
    return i;
  }
  get size(): number {
    return this.index.size;
  }
}

/**
 * The geometry of `read` placed by `toMm` (row-major 4 × 4: store coordinates to physical millimetres), coloured
 * as `look` says (else by object, `segmentColour`); spheres and tubes at `size` times their natural radius.
 */
export function layerGeometry(read: GeometryRead, toMm: readonly number[], look: ColourByLook | undefined, size: number, segmentColour: (id: bigint) => [number, number, number] | undefined): LayerGeometry {
  if (read.kind === "meshes") {
    const ids: bigint[] = [];
    const prims = meshPrimitives(read.chunks, toMm, ids);
    return { prims, objectCount: ids.length, ids, text: `${read.count.toLocaleString()} triangles as surfaces` };
  }
  // Millimetres a store unit along each axis, placed: the box's extent, and a radius's (their mean).
  const scale = [0, 1, 2].map((a) => Math.hypot(toMm[a], toMm[4 + a], toMm[8 + a]));
  const unit = (scale[0] + scale[1] + scale[2]) / 3;
  const lo = [0, 1, 2].map((a) => read.lower[a] * scale[a]), hi = [0, 1, 2].map((a) => read.upper[a] * scale[a]);
  const extent = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const palette = new Palette();
  const grouped = read.perVertex || read.byObject !== undefined;
  const groups = groupColours(grouped ? look : undefined);
  const idOf = (c: BuiltChunk, slot: number) => (BigInt(c.objectIds[2 * slot + 1]) << 32n) | BigInt(c.objectIds[2 * slot]);
  const bySegment = (id: bigint) => palette.of(id, () => segmentColour(id) ?? groupPalette(Number(id % 1000003n)));

  if (read.kind === "points") {
    const points = function* (): Generator<IndexedPoint> {
      if (!grouped) {
        // By object: each point its object's colour.
        for (const c of read.chunks) {
          const n = c.pointCount || c.vertexCount;
          for (let v = 0; v < n; ++v) yield { x: c.vertices[4 * v], y: c.vertices[4 * v + 1], z: c.vertices[4 * v + 2], index: bySegment(idOf(c, c.slots[v])) };
        }
        return;
      }
      for (const p of chunkPoints(read.chunks, read.perVertex, read.byObject)) {
        yield { x: p.x, y: p.y, z: p.z, index: groups.shows(p.group) ? palette.of(`g${p.group}`, () => groups.colour(p.group, p.stored)) : -1 };
      }
    };
    const radius = size * pointRadius(read.count, lo, hi);
    const prims = pointPrimitives(points(), toMm, radius);
    return { prims, objectCount: palette.size, colours: new Float32Array(palette.rgb), radius, text: `${prims.objects.length.toLocaleString()} points as spheres (${radiusText(radius)})` };
  }

  // Lines: a segment's object (or group) its first vertex's.
  const objectOf = (c: BuiltChunk, v: number): number => {
    const slot = c.slots[v];
    if (read.perVertex) {
      const g = c.objectIds[2 * slot];
      const group = g === 0xffffffff ? -1 : g;
      return groups.shows(group) ? palette.of(`g${group}`, () => groups.colour(group, c.slotColours?.[slot])) : -1;
    }
    const id = idOf(c, slot);
    if (read.byObject !== undefined) {
      const o = read.byObject(id);
      return groups.shows(o.group) ? palette.of(`g${o.group}`, () => groups.colour(o.group, o.stored)) : -1;
    }
    return bySegment(id);
  };
  // The natural radius: from the segments' lengths (a sample of them).
  const lengths: number[] = [];
  for (const c of read.chunks) {
    for (let k = 0; k < c.segmentCount && lengths.length < 20000; k += Math.max(1, Math.floor(c.segmentCount / 200))) {
      const a = c.segments[4 * k + 1], b = c.segments[4 * k + 2];
      lengths.push(Math.hypot(...[0, 1, 2].map((d) => (c.vertices[4 * a + d] - c.vertices[4 * b + d]) * scale[d])));
    }
  }
  const radius = size * lineRadius(lengths, extent);
  const radiusAt = read.radii ? (c: BuiltChunk, v: number) => {
    const r = c.vertices[4 * v + 3];
    return Number.isFinite(r) && r > 0 ? size * r * unit : undefined;
  } : undefined;
  const prims = linePrimitives(read.chunks, toMm, radius, objectOf, radiusAt);
  return {
    prims, objectCount: palette.size, colours: new Float32Array(palette.rgb), radius,
    text: `${prims.objects.length.toLocaleString()} segments as tubes (${read.radii ? "the store's radii" : radiusText(radius)})`,
  };
}

/** A radius (mm) for the readout. */
function radiusText(mm: number): string {
  return mm >= 0.1 ? `radius ${mm.toPrecision(2)} mm` : mm >= 1e-4 ? `radius ${(mm * 1000).toPrecision(2)} µm` : `radius ${(mm * 1e6).toPrecision(2)} nm`;
}
