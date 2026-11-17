/**
 * A Zarr Vectors point cloud (cells of a spatial atlas, say) as a volume
 * this browser's renderer can draw: an 8-bit grid of how near each voxel
 * is to the nearest point (drawn as a sphere a voxel in radius; a mesh's
 * surface as a shell about a voxel thick), and each voxel the group (a
 * cell type, a class) of that point, coloured as the layer colours it
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
const GRID_VOXELS = 64e6;
const GRID_SIDE = 2048;
/** How far (voxels) a point's distance is kept: the most a point's radius can be drawn. */
const BAND = 2;
/** A point's radius as drawn (voxels), and half a surface's shell. */
export const POINT_RADIUS = 1;
export const SHELL_RADIUS = 0.6;
/** The most groups coloured apart (label 0 is empty). */
const MAX_LABELS = 255;

/** A point cloud as a level: occupancy 0..255 and, per voxel, its label (1..255; 0 none); and each label's colour. */
export interface PointsLevel extends Level8 {
  labels: Uint8Array;
  colours: [number, number, number][];
  points: number;
  /** The radius (voxels) a point is drawn: half a surface's thickness. */
  radius: number;
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

/** A grid's voxel side (mm) for store coordinates `lower`..`upper`: within `voxels`, at most GRID_SIDE a side. */
export function gridVoxel(lower: number[], upper: number[], mm: number[], voxels = GRID_VOXELS): number {
  const ext = [0, 1, 2].map((a) => Math.max(upper[a] - lower[a], 1e-9) * mm[a]);
  const h = Math.cbrt((ext[0] * ext[1] * ext[2]) / voxels);
  return Math.max(h, Math.max(...ext) / (GRID_SIDE - 2 * BAND - 2));
}

/**
 * Points as a distance grid (store coordinates in `lower`..`upper`, at most `voxels` voxels): each voxel's value
 * how near the nearest point is, 255 at it falling to 0 at BAND voxels (so the drawing's table, not the grid, sets
 * how large a point is drawn: see pointsTable), and its label that point's group. Points as small as a voxel stay
 * whole wherever they fall between voxel centres, and a surface's points (trianglePoints) make a shell as thin.
 */
export function splatPoints(points: Iterable<Point>, lower: number[], upper: number[], mm: number[], voxels = GRID_VOXELS, colours: GroupColours = groupColours(undefined)): PointsLevel {
  const ext = [0, 1, 2].map((a) => Math.max(upper[a] - lower[a], 1e-9) * mm[a]);
  // A voxel's side (mm); a margin of BAND + 1 about the points.
  const h = gridVoxel(lower, upper, mm, voxels);
  const m = BAND + 1;
  const size = ext.map((e) => Math.max(1, Math.ceil(e / h) + 2 * m)) as [number, number, number];
  const n = size[0] * size[1] * size[2];
  const data = new Uint8Array(n);
  const labels = new Uint8Array(n);
  const labelOf = new Map<number, number>();
  const palette: [number, number, number][] = [[0.8, 0.8, 0.8]];
  const origin = [0, 1, 2].map((a) => lower[a] * mm[a] - m * h);
  const sx = size[0], sxy = size[0] * size[1];
  const scale = 255 / BAND;
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
    const cx = (p.x * mm[0] - origin[0]) / h - 0.5, cy = (p.y * mm[1] - origin[1]) / h - 0.5, cz = (p.z * mm[2] - origin[2]) / h - 0.5;
    const i0 = Math.max(0, Math.ceil(cx - BAND)), i1 = Math.min(size[0] - 1, Math.floor(cx + BAND));
    const j0 = Math.max(0, Math.ceil(cy - BAND)), j1 = Math.min(size[1] - 1, Math.floor(cy + BAND));
    const k0 = Math.max(0, Math.ceil(cz - BAND)), k1 = Math.min(size[2] - 1, Math.floor(cz + BAND));
    for (let k = k0; k <= k1; ++k) {
      const dz = (k - cz) ** 2;
      for (let j = j0; j <= j1; ++j) {
        const dyz = dz + (j - cy) ** 2;
        if (dyz >= BAND * BAND) continue;
        const row = sx * j + sxy * k;
        for (let i = i0; i <= i1; ++i) {
          const d2 = dyz + (i - cx) ** 2;
          if (d2 >= BAND * BAND) continue;
          const v = Math.round(255 - Math.sqrt(d2) * scale);
          const at = row + i;
          if (v > data[at]) {
            data[at] = v;
            labels[at] = label;
          }
        }
      }
    }
  }
  // Voxel centres to millimetres, row-major.
  const voxelToRas = [h, 0, 0, origin[0] + 0.5 * h, 0, h, 0, origin[1] + 0.5 * h, 0, 0, h, origin[2] + 0.5 * h, 0, 0, 0, 1];
  return { data, labels, colours: palette, points: count, size, voxelToRas, range: [0, 255], pct: new Map(), window: undefined, path: "points", radius: POINT_RADIUS };
}

/**
 * The table a point cloud is drawn with (TF_SIZE entries, RGBA): opaque within `radius` voxels of a point (or of a
 * surface: half its shell's thickness), clear beyond, and at each label's place (label / 255) that label's colour.
 */
export function pointsTable(colours: readonly [number, number, number][], radius = POINT_RADIUS): Float32Array {
  const t = new Float32Array(TF_SIZE * 4);
  const r = Math.min(Math.max(radius, 0.3), BAND - 0.3);
  for (let i = 0; i < TF_SIZE; ++i) {
    const v = (i / (TF_SIZE - 1)) * 255;
    const label = Math.round(v);
    const rgb = colours[label] ?? colours[0] ?? [0.8, 0.8, 0.8];
    // The distance (voxels) the value stands for; the edge a quarter of a voxel soft either side of `radius`.
    const d = BAND * (1 - v / 255);
    const s = Math.min(1, Math.max(0, (r + 0.25 - d) / 0.5));
    t.set([rgb[0], rgb[1], rgb[2], s * s * (3 - 2 * s)], 4 * i);
  }
  return t;
}

/** The store coordinates the chunks' vertices span (their chunks' bounds when they have none). */
export function vertexBounds(chunks: readonly BuiltChunk[]): { lower: number[]; upper: number[] } {
  const lower = [Infinity, Infinity, Infinity], upper = [-Infinity, -Infinity, -Infinity];
  for (const c of chunks) {
    const n = c.pointCount || c.vertexCount;
    for (let v = 0; v < n; ++v) {
      for (let a = 0; a < 3; ++a) {
        const x = c.vertices[4 * v + a];
        if (x < lower[a]) lower[a] = x;
        if (x > upper[a]) upper[a] = x;
      }
    }
  }
  if (lower[0] > upper[0]) {
    return { lower: [0, 1, 2].map((a) => Math.min(...chunks.map((c) => c.lower[a]))), upper: [0, 1, 2].map((a) => Math.max(...chunks.map((c) => c.upper[a]))) };
  }
  return { lower, upper };
}

/**
 * Points over the surfaces of built chunks' triangles, a third of a voxel (`h`, mm) apart, so the distance grid
 * holds each surface (to within a fifth of a voxel) as a shell; each point's group the index of its object (`objects`: ids in the order first met).
 */
export function* trianglePoints(chunks: Iterable<BuiltChunk>, h: number, mm: number[], objects: bigint[]): Generator<Point> {
  const indexOf = new Map<bigint, number>();
  const step = 0.35 * h;
  for (const c of chunks) {
    const v = c.vertices, t = c.triangles;
    const slotGroup = Array.from({ length: c.objectIds.length / 2 }, (_, s) => {
      const id = (BigInt(c.objectIds[2 * s + 1]) << 32n) | BigInt(c.objectIds[2 * s]);
      let g = indexOf.get(id);
      if (g === undefined) {
        g = objects.length;
        indexOf.set(id, g);
        objects.push(id);
      }
      return g;
    });
    for (let f = 0; f < c.triangleCount; ++f) {
      const a = t[3 * f], b = t[3 * f + 1], d = t[3 * f + 2];
      const group = slotGroup[c.slots[a]] ?? 0;
      const P = [a, b, d].map((i) => [v[4 * i], v[4 * i + 1], v[4 * i + 2]]);
      const len = (p: number[], q: number[]) => Math.hypot((p[0] - q[0]) * mm[0], (p[1] - q[1]) * mm[1], (p[2] - q[2]) * mm[2]);
      const n = Math.min(64, Math.max(1, Math.ceil(Math.max(len(P[0], P[1]), len(P[1], P[2]), len(P[2], P[0])) / step)));
      for (let i = 0; i <= n; ++i) {
        for (let j = 0; j <= n - i; ++j) {
          const u = i / n, w = j / n, s = 1 - u - w;
          yield { x: s * P[0][0] + u * P[1][0] + w * P[2][0], y: s * P[0][1] + u * P[1][1] + w * P[2][1], z: s * P[0][2] + u * P[1][2] + w * P[2][2], group };
        }
      }
    }
  }
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
export async function readPoints(storeUrl: string, look: ColourByLook | undefined, voxels: number, say: (text: string) => void, stale: () => boolean, segmentColour?: (id: bigint) => [number, number, number] | undefined): Promise<PointsLevel> {
  const g0 = look?.by === "group" ? look.group : undefined;
  // The group's index and colour attributes read with the points (a taxonomy's tier: a cell's class).
  const client = new StoreClient(storeUrl, { attributes: g0 !== undefined ? [g0.attribute, ...(g0.colorAttribute ? [g0.colorAttribute] : [])] : [] });
  try {
    const info = await client.ready;
    const meshes = info.primitive === "triangles";
    if (info.primitive === "lines") throw new Error("this browser draws points and surfaces; this store holds lines (a render computer draws those)");
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
    // The grid about the points themselves (finer than about their chunks).
    const { lower, upper } = vertexBounds(chunks);
    say("placing the points");
    await new Promise((r) => setTimeout(r, 0));
    if (meshes) {
      // Surfaces: their triangles as thin shells, each object in its segment colour.
      say("placing the surfaces");
      await new Promise((r) => setTimeout(r, 0));
      const mm = mmPerUnit(info);
      const ids: bigint[] = [];
      const surfaces = trianglePoints(chunks, gridVoxel(lower, upper, mm, voxels), mm, ids);
      const byId: GroupColours = { shows: () => true, colour: (group) => segmentColour?.(ids[group]) ?? groupPalette(group) };
      const out = splatPoints(surfaces, lower, upper, mm, voxels, byId);
      out.radius = SHELL_RADIUS;
      out.path = `${level}, ${ids.length} object${ids.length === 1 ? "" : "s"}`;
      return out;
    }
    const byObject = await objects;
    if (g !== undefined && !perVertex && byObject === undefined) say(`placing the points (no ${g.attribute} column: one colour)`);
    const out = splatPoints(chunkPoints(chunks, perVertex, byObject), lower, upper, mmPerUnit(info), voxels, byObject !== undefined || perVertex ? groupColours(look) : groupColours(undefined));
    out.path = `${level}, ${out.points.toLocaleString()} points`;
    return out;
  } finally {
    client.dispose();
  }
}
