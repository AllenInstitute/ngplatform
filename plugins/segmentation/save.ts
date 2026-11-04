/**
 * Saving a label volume: NIfTI-1 (.nii.gz, intent "label") or an OME-Zarr
 * folder.  The OME-Zarr is written from the chunks there are, so a mask on a
 * large grid writes only what is painted (the rest is the fill value, 0);
 * NIfTI holds every voxel, so for a large grid save only the painted box
 * (`crop`), which moves the origin to the box's corner.
 */
import { gunzip } from "@ngplatform/sdk/precomputed";
import { gzip, niftiFile, omeZarrMetadata } from "../registration/volume_io.js";
import { multiply4 } from "../registration/fit.js";
import type { CowVolume, Original } from "./cow_volume.js";
import { type Box, CHUNK, isEmpty, LABEL_ARRAYS, type LabelArray, type LabelType, LabelVolume, type Vec3 } from "./label_volume.js";

/** The volume cut to a box (a new volume, placed where the box is). */
export function cropped(volume: LabelVolume, box: Box): LabelVolume {
  const size = [0, 1, 2].map((k) => box.hi[k] - box.lo[k]) as [number, number, number];
  const shift = Float64Array.from([1, 0, 0, box.lo[0], 0, 1, 0, box.lo[1], 0, 0, 1, box.lo[2], 0, 0, 0, 1]);
  const out = new LabelVolume(size, volume.type, multiply4(volume.voxelToRas, shift), volume.name);
  out.load(volume.dense(box));
  return out;
}

/** Bytes a NIfTI of the whole volume would take, before compression. */
export function niftiBytes(volume: LabelVolume): number {
  return volume.size[0] * volume.size[1] * volume.size[2] * (volume.type === "uint8" ? 1 : volume.type === "uint16" ? 2 : 4) + 352;
}

export async function niftiGz(volume: LabelVolume, description = ""): Promise<Uint8Array> {
  const nii = niftiFile({ data: volume.dense(), size: volume.size, type: volume.type, voxelToRas: volume.voxelToRas }, { label: true, description: description.slice(0, 79) });
  return gzip(nii);
}

/** A segment's name, colour and group, as saved. */
export interface SavedLabel {
  value: number;
  name?: string;
  colour?: string;
  group?: string;
}

/**
 * The OME-Zarr metadata of a volume's levels, with its segments' names and
 * colours as OME-NGFF's label images carry them ("image-label"; a segment's
 * group as a property too), and anything else for the group's attributes.
 */
function labelMetadata(volume: LabelVolume, description: string | undefined, labels: SavedLabel[], attributes: Record<string, unknown> = {}): Map<string, Uint8Array> {
  const files = omeZarrMetadata(volume.levels, volume.type, volume.name, { label: true, chunk: CHUNK, description });
  if (labels.length || Object.keys(attributes).length) {
    const group = JSON.parse(new TextDecoder().decode(files.get("zarr.json")));
    const rgba = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);
    if (labels.length) {
      group.attributes.ome["image-label"] = {
        colors: labels.filter((l) => l.colour).map((l) => ({ "label-value": l.value, rgba: rgba(l.colour!) })),
        properties: labels.map((l) => ({ "label-value": l.value, ...(l.name ? { name: l.name } : {}), ...(l.group ? { group: l.group } : {}) })),
      };
    }
    Object.assign(group.attributes, attributes);
    files.set("zarr.json", new TextEncoder().encode(JSON.stringify(group, null, 1)));
  }
  return files;
}

const bytesOf = (c: LabelArray) => new Uint8Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength));

/** An OME-Zarr (Zarr v3, gzipped chunks) of the volume's pyramid, as files by path; chunks not painted are left out. */
export async function omeZarr(
  volume: LabelVolume,
  description?: string,
  progress?: (done: number, total: number) => void,
  labels: SavedLabel[] = [],
): Promise<Map<string, Uint8Array>> {
  const files = labelMetadata(volume, description, labels);
  const todo: [number, number, number, number][] = [];
  for (let level = 0; level < volume.levels.length; ++level) {
    const seen = new Set<string>();
    for (const key of volume.keys()) {
      const [cx, cy, cz] = volume.coords(key).map((v) => v >> level);
      const id = `${cx}/${cy}/${cz}`;
      if (seen.has(id)) continue;
      seen.add(id);
      todo.push([level, cx, cy, cz]);
    }
  }
  let done = 0;
  for (const [level, cx, cy, cz] of todo) {
    const c = volume.levelChunk(level, cx, cy, cz);
    if (c !== undefined) files.set(`${level}/c/${cz}/${cy}/${cx}`, await gzip(bytesOf(c)));
    progress?.(++done, todo.length);
  }
  return files;
}

// ------------------------------------------------------------ edited in place

/** What an OME-Zarr of edits records of its original: the group's attribute `ngplatform`. */
export interface EditsNote {
  edits: {
    /** Where the original is. */
    original: Original;
    size: Vec3;
    type: LabelType;
    /** Level-0 chunks edited. */
    chunks: number;
    note: string;
  };
}

/**
 * An OME-Zarr of a volume edited in place holding only its edits, as files
 * by path: the original's levels and placement, each edited chunk of level
 * 0 and each coarser chunk over edits (written even where all 0, since the
 * original may not be), and a note of where the original is.  The chunks
 * not written are the original's.
 */
export async function editsZarr(volume: CowVolume, description?: string, progress?: (done: number, total: number) => void, labels: SavedLabel[] = []): Promise<Map<string, Uint8Array>> {
  const original = volume.original;
  const note: EditsNote = {
    edits: {
      original,
      size: volume.size,
      type: volume.type,
      chunks: volume.chunkCount,
      note: `Only the chunks edited in ngplatform; every chunk not here is ${original.layer}'s (${original.store}). Segmentation's Open edits… edits it over the original again.`,
    },
  };
  const files = labelMetadata(volume, description, labels, { ngplatform: note });
  const todo: [number, Vec3][] = [];
  for (let level = 0; level < volume.levels.length; ++level) for (const c of volume.editedChunks(level)) todo.push([level, c]);
  const zeros = new LABEL_ARRAYS[volume.type](CHUNK ** 3);
  let done = 0;
  for (const [level, [cx, cy, cz]] of todo) {
    const c = await volume.chunkAt(level, cx, cy, cz);
    files.set(`${level}/c/${cz}/${cy}/${cx}`, await gzip(bytesOf(c ?? zeros)));
    progress?.(++done, todo.length);
  }
  return files;
}

/** The chunks a block of the whole volume is read in (4 × 4 × 1: 256 × 256 × 64 voxels). */
const WHOLE_BLOCK: Vec3 = [4, 4, 1];

/**
 * The whole of a volume edited in place as an OME-Zarr, written file by
 * file (`write`): each level a block of the original at a time (its
 * chunks as they are), the chunks over edits as edited or made again;
 * chunks all 0 are left out.  Resolves the chunks written.
 */
export async function writeWhole(
  volume: CowVolume,
  write: (path: string, bytes: Uint8Array) => Promise<void>,
  options: { description?: string; labels?: SavedLabel[]; progress?: (done: number, total: number) => void; cancelled?: () => boolean } = {},
): Promise<number> {
  for (const [path, bytes] of labelMetadata(volume, options.description, options.labels ?? [])) await write(path, bytes);
  const plan = volume.levels.map((l) => {
    const grid = l.size.map((n) => Math.ceil(n / CHUNK)) as Vec3;
    return { grid, blocks: grid.map((g, k) => Math.ceil(g / WHOLE_BLOCK[k])) as Vec3 };
  });
  const total = plan.reduce((n, p) => n + p.blocks[0] * p.blocks[1] * p.blocks[2], 0);
  let done = 0;
  let written = 0;
  for (let level = 0; level < volume.levels.length; ++level) {
    const { grid, blocks } = plan[level];
    const size = volume.levels[level].size;
    for (let bz = 0; bz < blocks[2]; ++bz) {
      for (let by = 0; by < blocks[1]; ++by) {
        for (let bx = 0; bx < blocks[0]; ++bx) {
          if (options.cancelled?.()) throw new Error("cancelled");
          const first = [bx, by, bz].map((b, k) => b * WHOLE_BLOCK[k]);
          const chunks: Vec3[] = [];
          for (let cz = first[2]; cz < Math.min(grid[2], first[2] + WHOLE_BLOCK[2]); ++cz) {
            for (let cy = first[1]; cy < Math.min(grid[1], first[1] + WHOLE_BLOCK[1]); ++cy) {
              for (let cx = first[0]; cx < Math.min(grid[0], first[0] + WHOLE_BLOCK[0]); ++cx) chunks.push([cx, cy, cz]);
            }
          }
          const lo = first.map((c) => c * CHUNK) as Vec3;
          const extent = lo.map((v, k) => Math.min(WHOLE_BLOCK[k] * CHUNK, size[k] - v)) as Vec3;
          // The original's block, read once, unless every chunk in it is over edits.
          const block = chunks.every((c) => volume.editedUnder(level, ...c)) ? undefined : await volume.readOriginal(level, lo, extent);
          for (const [cx, cy, cz] of chunks) {
            let c: LabelArray | null | undefined;
            if (volume.editedUnder(level, cx, cy, cz)) c = await volume.chunkAt(level, cx, cy, cz);
            else {
              const from = [cx * CHUNK - lo[0], cy * CHUNK - lo[1], cz * CHUNK - lo[2]] as Vec3;
              c = volume.fromBlock(block!, extent, from, from.map((v, k) => Math.min(CHUNK, extent[k] - v)) as Vec3);
            }
            if (c && !isEmpty(c)) {
              await write(`${level}/c/${cz}/${cy}/${cx}`, await gzip(bytesOf(c)));
              ++written;
            }
          }
          options.progress?.(++done, total);
        }
      }
    }
  }
  return written;
}

/** Saved edits read back: their note, their segments, and their level-0 chunks by [x, y, z]. */
export interface ReadEdits {
  note: EditsNote["edits"];
  labels: SavedLabel[];
  chunks: { at: Vec3; data: LabelArray }[];
}

/**
 * Reads an OME-Zarr of edits (`editsZarr`) from its files by path within
 * it (`zarr.json`, `0/c/z/y/x`, …); only level 0's chunks are read, the
 * coarser ones are made again.  An error if it is not one.
 */
export async function readEdits(files: Map<string, Blob | Uint8Array>): Promise<ReadEdits> {
  const bytes = async (b: Blob | Uint8Array) => (b instanceof Uint8Array ? b : new Uint8Array(await b.arrayBuffer()));
  const head = files.get("zarr.json");
  if (head === undefined) throw new Error("no zarr.json: not an OME-Zarr folder");
  const group = JSON.parse(new TextDecoder().decode(await bytes(head)));
  const note = (group?.attributes?.ngplatform as EditsNote | undefined)?.edits;
  if (note?.original?.store === undefined) throw new Error("it holds no edits of a segmentation (Save → Edits only writes them)");
  const label = group.attributes.ome?.["image-label"] ?? {};
  const hex = (rgba: number[]) => `#${rgba.slice(0, 3).map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const colours = new Map<number, string>(((label.colors ?? []) as { "label-value": number; rgba: number[] }[]).map((c) => [c["label-value"], hex(c.rgba)]));
  const labels: SavedLabel[] = ((label.properties ?? []) as { "label-value": number; name?: string; group?: string }[]).map((p) => ({ value: p["label-value"], name: p.name, colour: colours.get(p["label-value"]), group: p.group }));
  const Type = LABEL_ARRAYS[note.type];
  const chunks: ReadEdits["chunks"] = [];
  for (const [path, blob] of files) {
    const m = /^0\/c\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
    if (m === null) continue;
    const raw = await gunzip(await bytes(blob));
    if (raw.byteLength !== CHUNK ** 3 * Type.BYTES_PER_ELEMENT) throw new Error(`chunk ${path} is not a ${note.type} chunk of 64³`);
    chunks.push({ at: [Number(m[3]), Number(m[2]), Number(m[1])], data: new Type(raw.slice().buffer as ArrayBuffer) });
  }
  return { note, labels, chunks };
}
