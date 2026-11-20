/**
 * A Zarr Vectors store (or a segmentation's meshes) read for this browser's
 * path tracer: one level's built chunks, by Luxar's reader (its worker and
 * chunk building), at the finest level within the geometry budget, with
 * how its points are grouped and coloured. geometry/from_read.ts makes
 * them primitives: triangles, spheres and tubes.
 */
import { type ColourByLook, groupPalette, unpackRgb } from "@ngplatform/sdk/colour_by";
import type { BuiltChunk } from "../luxar/chunk_build.js";
import { keyOf } from "../luxar/chunks.js";
import { StoreClient, type StoreInfo } from "../luxar/client.js";
import { chunkRange, chunksIn } from "../luxar/view_math.js";
import { httpAccess, openZarrVectorsStore } from "neuroglancer-zarr-vectors/reader";
import { readShaderObjectValues } from "../zarr-vectors/src/objects.js";

/** The primitives read across the geometry layers drawn, unless Quality › Geometry says otherwise. */
export const GEOMETRY_BUDGET = 2e6;

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
export function pointsLevelIndex(info: { levels: readonly { vertexCount: number | undefined }[] }, max = GEOMETRY_BUDGET): number {
  let best = info.levels.length - 1;
  for (let i = info.levels.length - 1; i >= 0; --i) {
    const n = info.levels[i].vertexCount;
    if (n !== undefined && n <= max) best = i;
  }
  return Math.max(0, best);
}

/**
 * Levels for several stores sharing `max` vertices (a layer's segments): each from its coarsest, the cheapest finer
 * level that still fits taken in turn, so small segments come in finer and large ones as fine as is left room for.
 * A level of unknown size is never taken over a known one.
 */
export function allocateLevels(stores: readonly { levels: readonly { vertexCount: number | undefined }[] }[], max: number): number[] {
  const size = (s: number, l: number) => stores[s].levels[l].vertexCount ?? Infinity;
  const at = stores.map((s) => Math.max(0, s.levels.length - 1));
  let total = stores.reduce((n, _, s) => n + (Number.isFinite(size(s, at[s])) ? size(s, at[s]) : 0), 0);
  for (;;) {
    let best = -1, cost = Infinity;
    for (let s = 0; s < stores.length; ++s) {
      if (at[s] === 0) continue;
      const more = size(s, at[s] - 1) - (Number.isFinite(size(s, at[s])) ? size(s, at[s]) : 0);
      if (more < cost && total + more <= max) [best, cost] = [s, more];
    }
    if (best < 0) return at;
    --at[best];
    total += cost;
  }
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
 * A store's geometry, read for the path tracer to trace as surfaces, spheres or tubes: its chunks at the level
 * read, millimetres a store unit, and how its points are grouped (as `chunkPoints` takes them).
 */
export interface GeometryRead {
  kind: "meshes" | "points" | "lines";
  chunks: BuiltChunk[];
  mm: number[];
  level: number;
  /** Triangles, points or segments. */
  count: number;
  /** The vertices' bounds (store coordinates). */
  lower: number[];
  upper: number[];
  /** Points' and lines' groups: per vertex (read by group), else per object (`byObject`), else none. */
  perVertex: boolean;
  byObject?: ObjectGroups;
  /** Lines: each vertex's value is its radius (store units). */
  radii: boolean;
  /** The store's levels' vertex counts and chunk shapes (finest first): which level another budget would read, which chunks by distance. */
  levels: { vertexCount: number | undefined; chunkShape: number[] }[];
  /** The store's bounds (store coordinates), its chunks' grid's extent. */
  bounds: { lower: number[]; upper: number[] };
}

/**
 * Reads a store's geometry for the path tracer: level `at`, else the finest within `budget` primitives (a mesh's
 * taken as two triangles a vertex), grouped as `look` colours it; or the chunks `chunks.keys` (of any levels: detail
 * by distance), those in its cache not read again, and it left holding these alone.
 */
/**
 * Readers' workers between reads (geometry is read a part at a time): handed on to the next read, so what a worker
 * keeps of the stores it has read (their shards' indexes and segments' manifests) serves it, and a segment read
 * again finer does not read them again. Let go after IDLE_MS unused.
 */
const idle: { client: StoreClient; timer: ReturnType<typeof setTimeout> }[] = [];
const IDLE = 2;
const IDLE_MS = 60_000;

function park(client: StoreClient): void {
  if (client.error !== undefined) {
    client.dispose();
    return;
  }
  const entry = { client, timer: setTimeout(() => {
    const i = idle.indexOf(entry);
    if (i >= 0) idle.splice(i, 1);
    client.dispose();
  }, IDLE_MS) };
  idle.push(entry);
  while (idle.length > IDLE) {
    const old = idle.shift()!;
    clearTimeout(old.timer);
    old.client.dispose();
  }
}

/** A reader for `storeUrl`: on an idle reader's worker, where there is one. */
function readerFor(storeUrl: string, attributes: string[]): StoreClient {
  const was = idle.pop();
  if (was !== undefined) clearTimeout(was.timer);
  const client = new StoreClient(storeUrl, { attributes, adopt: was?.client });
  was?.client.dispose();
  return client;
}

/** readGeometry's level: the coarsest (a mesh's levels, bounds and a first look, read cheaply). */
export const COARSEST = -1;

export async function readGeometry(storeUrl: string, look: ColourByLook | undefined, budget: number, say: (text: string) => void, stale: () => boolean, at?: number, chunks?: { keys?: string[]; cache: Map<string, BuiltChunk | null> }): Promise<GeometryRead> {
  const g = look?.by === "group" ? look.group : undefined;
  // The group's index and colour attributes read with the points (a taxonomy's tier: a cell's class).
  const client = readerFor(storeUrl, g !== undefined ? [g.attribute, ...(g.colorAttribute ? [g.colorAttribute] : [])] : []);
  try {
    const info = await client.ready;
    const meshes = info.primitive === "triangles";
    const lines = info.primitive === "lines";
    // Groups per vertex (an attribute the reader exposes), else per object (the object table's columns: a cell's class).
    const perVertex = g !== undefined && info.attributes.some((a) => a.id === g.attribute);
    // Lines not grouped by vertex: each vertex's radius (an SWC's), where the store has one.
    const radius = lines && !perVertex ? info.attributes.find((a) => /^radi(us|i)$/i.test(a.id) && a.components === 1) : undefined;
    client.setScalar(g !== undefined && perVertex ? `group:${g.attribute}${g.colours === "stored" && g.colorAttribute ? `:${g.colorAttribute}` : ""}` : radius ? `attribute:${radius.id}` : "object");
    const objects = g !== undefined && !perVertex ? objectGroups(storeUrl, g.attribute, g.colours === "stored" ? g.colorAttribute : undefined) : undefined;
    // A level asked for (where it exists; COARSEST the coarsest), else the finest within the budget; or the chunks asked
    // for (the finest of them its level). With a cache, chunks it holds are not read again (whatever chose them).
    const asked = chunks?.keys;
    const level = asked !== undefined && asked.length > 0 ? Math.min(...asked.map((k) => Number(k.split("|")[0]))) : at === COARSEST ? info.levels.length - 1 : at !== undefined && at >= 0 && at < info.levels.length ? at : pointsLevelIndex(info, meshes ? budget / 2 : budget);
    const shape = info.levels[level].chunkShape;
    const keys = asked ?? chunksIn(chunkRange(info.bounds.lower, info.bounds.upper, shape)).map((c) => keyOf(level, c));
    const cache = chunks?.cache;
    const need = keys.filter((k) => !cache?.has(k));
    client.want("anatomical-rendering", need);
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (stale()) return reject(new Error("stale"));
        const done = need.filter((k) => client.has(k)).length;
        say(`reading the geometry: ${done} of ${need.length} pieces`);
        if (done === need.length) resolve();
        else if (client.error !== undefined && client.pending === 0) reject(new Error(client.error));
      };
      client.onChunk = check;
      check();
    });
    if (cache) {
      for (const k of need) cache.set(k, client.get(k) ?? null);
      const kept = new Set(keys);
      for (const k of [...cache.keys()]) if (!kept.has(k)) cache.delete(k);
    }
    const built = keys.map((k) => (cache ? cache.get(k) : client.get(k))).filter((c): c is BuiltChunk => !!c);
    if (built.length === 0) throw new Error("the store has no geometry");
    const { lower, upper } = vertexBounds(built);
    const kind = meshes ? "meshes" : lines ? "lines" : "points";
    const count = built.reduce((n, c) => n + (meshes ? c.triangleCount : lines ? c.segmentCount : c.pointCount || c.vertexCount), 0);
    const byObject = await objects;
    if (g !== undefined && !perVertex && byObject === undefined) say(`no ${g.attribute} column: one colour`);
    return {
      kind, chunks: built, mm: mmPerUnit(info), level, count, lower, upper, perVertex, byObject, radii: radius !== undefined,
      levels: info.levels.map((l) => ({ vertexCount: l.vertexCount, chunkShape: [...l.chunkShape] })), bounds: { lower: [...info.bounds.lower], upper: [...info.bounds.upper] },
    };
  } finally {
    park(client);
  }
}
