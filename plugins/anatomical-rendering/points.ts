/**
 * A Zarr Vectors point cloud (cells of a spatial atlas, say) as a volume
 * this browser's renderer can draw: each point a small soft sphere in an
 * 8-bit occupancy grid, and each voxel the group (a cell type, a class)
 * of the point that weighs most there, coloured as the layer colours it
 * (its Vertex colour: the store's colour for each group, or a palette's;
 * the groups not shown left out).  The grid is then drawn, lit and path
 * traced as an image is, cut by its own crops, and drawn together with
 * images as one volume.
 *
 * The points are read by Luxar's reader (its worker and chunk building),
 * at the finest level within POINTS_MAX points.
 */
import { type ColourByLook, groupPalette, unpackRgb } from "@ngplatform/sdk/colour_by";
import type { BuiltChunk } from "../luxar/chunk_build.js";
import { keyOf } from "../luxar/chunks.js";
import { StoreClient, type StoreInfo } from "../luxar/client.js";
import { chunkRange, chunksIn } from "../luxar/view_math.js";
import { type Level8, TF_SIZE } from "./local/local.js";
import { httpAccess, openZarrVectorsStore } from "neuroglancer-zarr-vectors/reader";
import { readShaderObjectValues } from "../zarr-vectors/src/objects.js";

/** The most points read. */
export const POINTS_MAX = 1.5e6;
/** The most voxels of the grid, and its longest side. */
const GRID_VOXELS = 32e6;
const GRID_SIDE = 1024;
/** The most groups coloured apart (label 0 is empty). */
const MAX_LABELS = 255;

/** A point cloud as a level: occupancy 0..255 and, per voxel, its label (1..255; 0 none); and each label's colour. */
export interface PointsLevel extends Level8 {
  labels: Uint8Array;
  colours: [number, number, number][];
  points: number;
}

/** Millimetres a store unit along each axis. */
export function mmPerUnit(info: Pick<StoreInfo, "axisScales" | "axisUnits">): number[] {
  const unit = (u: string | undefined) => {
    switch ((u ?? "").toLowerCase()) {
      case "m":
      case "meter":
        return 1000;
      case "um":
      case "µm":
      case "micrometer":
        return 1e-3;
      case "nm":
      case "nanometer":
        return 1e-6;
      default:
        return 1;
    }
  };
  return [0, 1, 2].map((a) => (info.axisScales[a] ?? 1) * unit(info.axisUnits[a]));
}

/** The level read: the finest within `max` points (its count unknown: the coarsest). */
export function pointsLevelIndex(info: Pick<StoreInfo, "levels">, max = POINTS_MAX): number {
  let best = info.levels.length - 1;
  for (let i = info.levels.length - 1; i >= 0; --i) {
    const n = info.levels[i].vertexCount;
    if (n !== undefined && n <= max) best = i;
  }
  return Math.max(0, best);
}

/** How a point's group is coloured, and whether it shows. */
export interface GroupColours {
  shows(group: number): boolean;
  colour(group: number, stored: number | undefined): [number, number, number];
}

/** The layer's Vertex colour, for points: by group (stored or palette colours, the groups shown), else all one colour. */
export function groupColours(look: ColourByLook | undefined): GroupColours {
  const g = look?.by === "group" ? look.group : undefined;
  if (g === undefined) return { shows: () => true, colour: () => [0.85, 0.82, 0.78] };
  const shown = g.shown !== undefined ? new Set(g.shown) : undefined;
  return {
    shows: (group) => shown === undefined || shown.has(group),
    colour: (group, stored) => (g.colours === "stored" && stored !== undefined ? unpackRgb(stored) : groupPalette(group)),
  };
}

/** One point: store coordinates, its group (-1: none) and its stored colour. */
export interface Point {
  x: number;
  y: number;
  z: number;
  group: number;
  stored?: number;
}

/**
 * Points as a soft grid (store coordinates in `lower`..`upper`, at most `voxels` voxels): each point spread over
 * the voxels within 1.5 of it (a Gaussian), the occupancy the sum (to 255), the label the group weighing most.
 */
export function splatPoints(points: Iterable<Point>, lower: number[], upper: number[], mm: number[], voxels = GRID_VOXELS, colours: GroupColours = groupColours(undefined)): PointsLevel {
  const ext = [0, 1, 2].map((a) => Math.max(upper[a] - lower[a], 1e-9) * mm[a]);
  // A voxel's side (mm): the grid within the voxels, at most GRID_SIDE a side; a margin of 2 for the spheres.
  let h = Math.cbrt((ext[0] * ext[1] * ext[2]) / voxels);
  h = Math.max(h, Math.max(...ext) / (GRID_SIDE - 4));
  const size = ext.map((e) => Math.max(1, Math.ceil(e / h) + 4)) as [number, number, number];
  const n = size[0] * size[1] * size[2];
  const weight = new Float32Array(n);
  const best = new Float32Array(n);
  const labels = new Uint8Array(n);
  const labelOf = new Map<number, number>();
  const palette: [number, number, number][] = [[0.8, 0.8, 0.8]];
  const origin = [0, 1, 2].map((a) => lower[a] * mm[a] - 2 * h);
  let count = 0;
  for (const p of points) {
    if (!colours.shows(p.group)) continue;
    let label = labelOf.get(p.group);
    if (label === undefined) {
      label = palette.length <= MAX_LABELS ? palette.length : 1 + (labelOf.size % MAX_LABELS);
      labelOf.set(p.group, label);
      if (palette.length <= MAX_LABELS) palette.push(colours.colour(p.group, p.stored));
    }
    ++count;
    // The point in voxels (centres at whole numbers).
    const c = [(p.x * mm[0] - origin[0]) / h - 0.5, (p.y * mm[1] - origin[1]) / h - 0.5, (p.z * mm[2] - origin[2]) / h - 0.5];
    const i0 = Math.round(c[0]), j0 = Math.round(c[1]), k0 = Math.round(c[2]);
    for (let dk = -1; dk <= 1; ++dk) {
      const k = k0 + dk;
      if (k < 0 || k >= size[2]) continue;
      for (let dj = -1; dj <= 1; ++dj) {
        const j = j0 + dj;
        if (j < 0 || j >= size[1]) continue;
        for (let di = -1; di <= 1; ++di) {
          const i = i0 + di;
          if (i < 0 || i >= size[0]) continue;
          const d2 = (i - c[0]) ** 2 + (j - c[1]) ** 2 + (k - c[2]) ** 2;
          if (d2 > 2.25) continue;
          const w = Math.exp(-d2 / 1.2);
          const at = i + size[0] * (j + size[1] * k);
          weight[at] += w;
          if (w > best[at]) {
            best[at] = w;
            labels[at] = label;
          }
        }
      }
    }
  }
  const data = new Uint8Array(n);
  for (let i = 0; i < n; ++i) data[i] = Math.min(255, Math.round(weight[i] * 255));
  // Voxel centres to millimetres, row-major.
  const voxelToRas = [h, 0, 0, origin[0] + 0.5 * h, 0, h, 0, origin[1] + 0.5 * h, 0, 0, h, origin[2] + 0.5 * h, 0, 0, 0, 1];
  return { data, labels, colours: palette, points: count, size, voxelToRas, range: [0, 255], pct: new Map(), window: undefined, path: "points" };
}

/**
 * The table a point cloud is drawn with (TF_SIZE entries, RGBA): opacity by occupancy (clear below a sphere's
 * edge, opaque within), and at each label's place (label / 255) that label's colour.
 */
export function pointsTable(colours: readonly [number, number, number][]): Float32Array {
  const t = new Float32Array(TF_SIZE * 4);
  for (let i = 0; i < TF_SIZE; ++i) {
    const v = (i / (TF_SIZE - 1)) * 255;
    const label = Math.round(v);
    const rgb = colours[label] ?? colours[0] ?? [0.8, 0.8, 0.8];
    // A sphere's edge at about a quarter of a point's peak (a point between voxel centres peaks at about 0.6).
    const s = Math.min(1, Math.max(0, (v - 45) / 50));
    t.set([rgb[0], rgb[1], rgb[2], s * s * (3 - 2 * s)], 4 * i);
  }
  return t;
}

/** Each object's group and stored colour, by its id (a store whose groups are per object: a cell's class). */
export type ObjectGroups = (id: bigint) => { group: number; stored?: number };

/**
 * The points of built chunks (their own vertices). A vertex's group: its slot's object when the chunks were read
 * by group (per-vertex groups), else its object's through `objects` (per-object groups), else 0.
 */
export function* chunkPoints(chunks: Iterable<BuiltChunk>, byGroup: boolean, objects?: ObjectGroups): Generator<Point> {
  for (const c of chunks) {
    const n = c.pointCount || c.vertexCount;
    const bySlot = objects ? Array.from({ length: c.objectIds.length / 2 }, (_, s) => objects((BigInt(c.objectIds[2 * s + 1]) << 32n) | BigInt(c.objectIds[2 * s]))) : undefined;
    for (let v = 0; v < n; ++v) {
      const slot = c.slots[v];
      const x = c.vertices[4 * v], y = c.vertices[4 * v + 1], z = c.vertices[4 * v + 2];
      if (bySlot !== undefined) {
        const o = bySlot[slot];
        yield { x, y, z, group: o.group, stored: o.stored };
        continue;
      }
      const group = byGroup ? c.objectIds[2 * slot] : 0;
      yield { x, y, z, group: byGroup && group === 0xffffffff ? -1 : group, stored: c.slotColours?.[slot] };
    }
  }
}

/**
 * A store's per-object group (`attribute`) and colour (`colour`, 0xRRGGBB) columns, read from its object table,
 * as a lookup by object id; undefined when the store has no such columns.
 */
async function objectGroups(storeUrl: string, attribute: string, colour: string | undefined): Promise<ObjectGroups | undefined> {
  const access = httpAccess(storeUrl);
  const store = await openZarrVectorsStore(access, []);
  const columns = store.description.availableObjects ?? [];
  // The look names a column by its shader id (letters, digits and _).
  const column = (id: string) => columns.find((c) => c === id || c.replace(/[^A-Za-z0-9_]/g, "_") === id);
  const g = column(attribute);
  if (g === undefined) return undefined;
  const c = colour !== undefined ? column(colour) : undefined;
  const path = store.description.objectValuesPath ?? store.levels[0].path;
  const values = await readShaderObjectValues(access, path, [{ column: g }, ...(c !== undefined ? [{ column: c }] : [])]);
  if (values === undefined) return undefined;
  const [groups, colours] = values.values;
  return (id) => {
    const row = values.rowOf(id);
    const group = row === undefined ? NaN : groups[row];
    const stored = row === undefined || colours === undefined ? NaN : colours[row];
    return { group: Number.isFinite(group) ? Math.round(group) : -1, ...(Number.isFinite(stored) ? { stored: Math.round(stored) } : {}) };
  };
}

/**
 * Reads a store's points (the finest level within POINTS_MAX), coloured as `look` says, and makes the grid.
 * `scalar` is what Luxar's reader is asked for (`group:<attribute>[:<colour attribute>]`, else "none").
 */
export async function readPoints(storeUrl: string, look: ColourByLook | undefined, voxels: number, say: (text: string) => void, stale: () => boolean): Promise<PointsLevel> {
  const g0 = look?.by === "group" ? look.group : undefined;
  // The group's index and colour attributes read with the points (a taxonomy's tier: a cell's class).
  const client = new StoreClient(storeUrl, { attributes: g0 !== undefined ? [g0.attribute, ...(g0.colorAttribute ? [g0.colorAttribute] : [])] : [] });
  try {
    const info = await client.ready;
    if (info.primitive !== "points") throw new Error(`this browser draws a Zarr Vectors store's points; this one holds ${info.primitive} (a render computer draws those)`);
    const g = look?.by === "group" ? look.group : undefined;
    // Groups per vertex (an attribute the reader exposes), else per object (the object table's columns: a cell's class).
    const perVertex = g !== undefined && info.attributes.some((a) => a.id === g.attribute);
    client.setScalar(g !== undefined && perVertex ? `group:${g.attribute}${g.colours === "stored" && g.colorAttribute ? `:${g.colorAttribute}` : ""}` : "object");
    const objects = g !== undefined && !perVertex ? objectGroups(storeUrl, g.attribute, g.colours === "stored" ? g.colorAttribute : undefined) : undefined;
    const level = pointsLevelIndex(info);
    const shape = info.levels[level].chunkShape;
    const keys = chunksIn(chunkRange(info.bounds.lower, info.bounds.upper, shape)).map((c) => keyOf(level, c));
    client.want("anatomical-rendering", keys);
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (stale()) return reject(new Error("stale"));
        const done = keys.filter((k) => client.has(k)).length;
        say(`reading the points: ${done} of ${keys.length} pieces`);
        if (done === keys.length) resolve();
        else if (client.error !== undefined && client.pending === 0) reject(new Error(client.error));
      };
      client.onChunk = check;
      check();
    });
    const chunks = keys.map((k) => client.get(k)).filter((c): c is BuiltChunk => !!c);
    if (chunks.length === 0) throw new Error("the store has no points");
    const lower = [0, 1, 2].map((a) => Math.min(...chunks.map((c) => c.lower[a])));
    const upper = [0, 1, 2].map((a) => Math.max(...chunks.map((c) => c.upper[a])));
    say("placing the points");
    await new Promise((r) => setTimeout(r, 0));
    const byObject = await objects;
    if (g !== undefined && !perVertex && byObject === undefined) say(`placing the points (no ${g.attribute} column: one colour)`);
    const out = splatPoints(chunkPoints(chunks, perVertex, byObject), lower, upper, mmPerUnit(info), voxels, byObject !== undefined || perVertex ? groupColours(look) : groupColours(undefined));
    out.path = `${level}, ${out.points.toLocaleString()} points`;
    return out;
  } finally {
    client.dispose();
  }
}
