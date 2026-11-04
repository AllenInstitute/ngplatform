/**
 * Label volumes kept in this browser (its origin private file system,
 * OPFS) while they are drawn, so a reload or a closed tab does not lose
 * them: a folder per volume with its description and each painted chunk's
 * raw bytes, written a moment after strokes stop.  This is not saving (the
 * files stay in the browser, which may clear them when short of space);
 * Save is.
 *
 * A segmentation edited in place keeps its edited chunks here the same
 * way, with where its original is; past its memory budget the edited
 * chunks kept here are let go from memory and read back from here
 * (`readKept`) when needed.
 */
import type { CowVolume, Original } from "./cow_volume.js";
import type { LabelArray, LabelType } from "./label_volume.js";
import { LABEL_ARRAYS, LabelVolume } from "./label_volume.js";

const ROOT = "ngplatform-label-volumes";

/** What is kept of a volume besides its chunks. */
export interface KeptInfo {
  /** Its store's file name without the extension, which its layer's source names. */
  id: string;
  name: string;
  size: [number, number, number];
  type: LabelType;
  voxelToRas: number[];
  labels: [number, { name: string; colour: string }][];
  /** The image whose values limited the tools. */
  reference?: string;
  /** When last written (ms since 1970). */
  time: number;
  chunks: number;
  /** Edited in place: the original its unedited chunks are read from. */
  original?: Original;
}

type Dir = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
};

async function root(): Promise<Dir | undefined> {
  try {
    const storage = navigator.storage as unknown as { getDirectory?(): Promise<FileSystemDirectoryHandle> } | undefined;
    const top = await storage?.getDirectory?.();
    return (await top?.getDirectoryHandle(ROOT, { create: true })) as Dir | undefined;
  } catch {
    return undefined;
  }
}

async function write(dir: FileSystemDirectoryHandle, name: string, data: BufferSource | string): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const w = await (file as unknown as { createWritable(): Promise<{ write(d: unknown): Promise<void>; close(): Promise<void> }> }).createWritable();
  await w.write(data);
  await w.close();
}

/**
 * Writes a volume's changed chunks (and its description) into its folder;
 * resolves false where the browser keeps nothing.  Each chunk is written as
 * it is at its `versionOf` given (`versions`, in the order of `keys`), so
 * the volume knows which writes are still current.
 */
export async function keep(volume: LabelVolume, info: Omit<KeptInfo, "size" | "type" | "voxelToRas" | "time" | "chunks">, keys: Iterable<number>, versions?: number[]): Promise<boolean> {
  const top = await root();
  if (top === undefined) return false;
  try {
    const dir = (await top.getDirectoryHandle(info.id, { create: true })) as Dir;
    let i = 0;
    for (const key of keys) {
      const at = i++;
      const c = volume.own(key);
      // A chunk let go from memory is here already, as it is.
      if (c === undefined && volume.edited(key)) continue;
      // Changed since: the next keep writes it.
      if (versions !== undefined && volume.versionOf(key) !== versions[at]) continue;
      if (c === undefined) await dir.removeEntry(`c${key}`).catch(() => {});
      else await write(dir, `c${key}`, c.slice().buffer as ArrayBuffer);
    }
    const kept: KeptInfo = { ...info, size: volume.size, type: volume.type, voxelToRas: Array.from(volume.voxelToRas), time: Date.now(), chunks: volume.chunkCount };
    await write(dir, "volume.json", JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

/** The volumes kept in this browser, the latest first. */
export async function kept(): Promise<KeptInfo[]> {
  const top = await root();
  if (top === undefined) return [];
  const out: KeptInfo[] = [];
  try {
    for await (const [name, handle] of top.entries()) {
      if (handle.kind !== "directory") continue;
      try {
        const file = await (await (handle as FileSystemDirectoryHandle).getFileHandle("volume.json")).getFile();
        out.push(JSON.parse(await file.text()) as KeptInfo);
      } catch {
        // A folder whose description was never written: nothing to restore.
        void name;
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.time - a.time);
}

/** A kept volume read back. */
export async function restore(info: KeptInfo): Promise<LabelVolume> {
  const top = await root();
  if (top === undefined) throw new Error("this browser keeps no files");
  const dir = (await top.getDirectoryHandle(info.id)) as Dir;
  const volume = new LabelVolume(info.size, info.type, Float64Array.from(info.voxelToRas), info.name);
  for await (const [name, handle] of dir.entries()) {
    const m = /^c(\d+)$/.exec(name);
    if (m === null || handle.kind !== "file") continue;
    const bytes = await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer();
    const Type = LABEL_ARRAYS[info.type];
    if (bytes.byteLength !== 64 ** 3 * Type.BYTES_PER_ELEMENT) continue;
    volume.putChunk(Number(m[1]), new Type(bytes));
  }
  return volume;
}

/** Reads back a volume's chunk kept here (undefined: not kept). */
export async function readKept(id: string, key: number, type: LabelType): Promise<LabelArray | undefined> {
  const top = await root();
  try {
    const dir = await top?.getDirectoryHandle(id);
    const bytes = await (await dir?.getFileHandle(`c${key}`))?.getFile().then((f) => f.arrayBuffer());
    const Type = LABEL_ARRAYS[type];
    return bytes?.byteLength === 64 ** 3 * Type.BYTES_PER_ELEMENT ? new Type(bytes) : undefined;
  } catch {
    return undefined;
  }
}

/** Puts a kept volume's edited chunks back into a volume edited in place over the same original (kept here already). */
export async function restoreInto(volume: CowVolume, info: KeptInfo): Promise<void> {
  const top = await root();
  if (top === undefined) throw new Error("this browser keeps no files");
  const dir = (await top.getDirectoryHandle(info.id)) as Dir;
  const Type = LABEL_ARRAYS[info.type];
  for await (const [name, handle] of dir.entries()) {
    const m = /^c(\d+)$/.exec(name);
    if (m === null || handle.kind !== "file") continue;
    const bytes = await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer();
    if (bytes.byteLength !== 64 ** 3 * Type.BYTES_PER_ELEMENT) continue;
    volume.restoreChunk(Number(m[1]), new Type(bytes));
  }
}

/** Forgets a kept volume. */
export async function discard(id: string): Promise<void> {
  const top = await root();
  await top?.removeEntry(id, { recursive: true }).catch(() => {});
}
