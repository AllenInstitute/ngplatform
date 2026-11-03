/**
 * Which of a chunk's objects a view draws, and in what colour: a layer's
 * chosen segments (Neuroglancer's visible segments, or a plugin's
 * temporary set such as a track-filtering group's) and its segment colours.
 * Each chunk lists its objects (chunk_build.ts); this makes, per chunk, a
 * small table the shaders look each vertex's object up in.  Pure, so the
 * tests can use it.
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
  /** Every object shows. */
  all: boolean;
  has(id: bigint): boolean;
  /** Each object's colour (RGB 0 to 1), when the style colours by segment. */
  colour?: (id: bigint) => [number, number, number];
}

/** Whether a view needs a table at all: some objects hidden, or colours by segment. */
export function needsTable(shading: ObjectShading): boolean {
  return !shading.all || shading.colour !== undefined;
}

export interface ObjectTable {
  /** RGBA8 per slot (the colour; alpha 255 shown, 0 not), padded to whole rows of TEXTURE_WIDTH. */
  table: Uint8Array;
  rows: number;
  /** The share of the chunk shown, by its objects' weight (length of line, or points). */
  shown: number;
}

/** A chunk's table: for each of its objects (ids as word pairs), whether it shows and its colour. */
export function objectTable(objectIds: Uint32Array, weight: Float32Array, shading: ObjectShading): ObjectTable {
  const n = objectIds.length / 2;
  const rows = Math.max(1, Math.ceil(n / TEXTURE_WIDTH));
  const table = new Uint8Array(rows * TEXTURE_WIDTH * 4);
  let total = 0;
  let shown = 0;
  let any = false;
  for (let i = 0; i < n; ++i) {
    const id = idOf(objectIds[2 * i], objectIds[2 * i + 1]);
    const on = shading.all || shading.has(id);
    const w = weight[i] ?? 0;
    total += w;
    if (!on) continue;
    shown += w;
    any = true;
    table[4 * i + 3] = 255;
    const c = shading.colour?.(id);
    if (c !== undefined) {
      for (let k = 0; k < 3; ++k) table[4 * i + k] = Math.round(Math.min(1, Math.max(0, c[k])) * 255);
    } else table.fill(255, 4 * i, 4 * i + 3);
  }
  return { table, rows, shown: total > 0 ? shown / total : any ? 1 : 0 };
}
