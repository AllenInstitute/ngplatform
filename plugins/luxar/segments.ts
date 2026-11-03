/**
 * Which of a chunk's objects a view draws, how strongly, and in what
 * colour: a layer's chosen segments (Neuroglancer's visible segments, or a
 * plugin's temporary set such as a track-filtering group's), the others at
 * the layer's notSelectedAlpha, and its segment colours.  Each chunk lists
 * its objects (chunk_build.ts); this makes, per chunk, a small table the
 * shaders look each vertex's object up in.  Pure, so the tests can use it.
 */
import { TEXTURE_WIDTH } from "./chunk_build.js";

/** An object id from its two words, low first. */
export function idOf(lo: number, hi: number): bigint {
  return hi === 0 ? BigInt(lo >>> 0) : (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

/** What a layer shows and how its segments are coloured, as the views need it. */
export interface ObjectShading {
  /** Changes whenever what is shown or the colours change, so tables are made again. */
  version: number;
  /** Every object shows, fully. */
  all: boolean;
  /** Whether an object is one of the chosen segments. */
  has(id: bigint): boolean;
  /** Each object's colour (RGB 0 to 1), when the style colours by segment. */
  colour?: (id: bigint) => [number, number, number];
  /**
   * How strongly the chosen objects are drawn (1 when omitted): 0 when they
   * are drawn another way (read whole, by id), so these chunks leave them out.
   */
  chosenAlpha?: number;
  /** How strongly the objects not chosen are drawn: the layer's notSelectedAlpha (0, not at all, when omitted). */
  othersAlpha?: number;
}

/** Whether a view needs a table at all: some objects hidden or faint, or colours by segment. */
export function needsTable(shading: ObjectShading): boolean {
  return !shading.all || shading.colour !== undefined;
}

/** An object's strength: 0 (not drawn) to 1. */
export function alphaOf(shading: ObjectShading, id: bigint): number {
  if (shading.all) return 1;
  return shading.has(id) ? (shading.chosenAlpha ?? 1) : (shading.othersAlpha ?? 0);
}

/** A strength as the table's alpha byte: anything above 0 is at least 1, so it is drawn. */
export function alphaByte(alpha: number): number {
  if (!(alpha > 0)) return 0;
  return Math.max(1, Math.min(255, Math.round(alpha * 255)));
}

export interface ObjectTable {
  /** RGBA8 per slot (the colour; alpha how strongly it is drawn, 0 not at all), padded to whole rows of TEXTURE_WIDTH. */
  table: Uint8Array;
  rows: number;
  /** The share of the chunk drawn at all, by its objects' weight (length of line, or points). */
  shown: number;
  /** The same share with each object counted at its strength (how much light the chunk adds). */
  light: number;
}

/** A chunk's table: for each of its objects (ids as word pairs), how strongly it is drawn and its colour. */
export function objectTable(objectIds: Uint32Array, weight: Float32Array, shading: ObjectShading): ObjectTable {
  const n = objectIds.length / 2;
  const rows = Math.max(1, Math.ceil(n / TEXTURE_WIDTH));
  const table = new Uint8Array(rows * TEXTURE_WIDTH * 4);
  let total = 0;
  let shown = 0;
  let light = 0;
  let any = false;
  for (let i = 0; i < n; ++i) {
    const id = idOf(objectIds[2 * i], objectIds[2 * i + 1]);
    const alpha = alphaByte(alphaOf(shading, id));
    const w = weight[i] ?? 0;
    total += w;
    if (alpha === 0) continue;
    shown += w;
    light += (w * alpha) / 255;
    any = true;
    table[4 * i + 3] = alpha;
    const c = shading.colour?.(id);
    if (c !== undefined) {
      for (let k = 0; k < 3; ++k) table[4 * i + k] = Math.round(Math.min(1, Math.max(0, c[k])) * 255);
    } else table.fill(255, 4 * i, 4 * i + 3);
  }
  const share = (x: number) => (total > 0 ? x / total : any ? 1 : 0);
  return { table, rows, shown: share(shown), light: share(light) };
}
