/**
 * Label volumes kept in this browser (its origin private file system,
 * OPFS) while they are drawn, so a reload or a closed tab does not lose
 * them: a folder per volume with its description and each painted chunk's
 * raw bytes, written a moment after strokes stop.  This is not saving (the
 * files stay in the browser, which may clear them when short of space);
 * Save is.
 */
import type { LabelType } from "./label_volume.js";
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

/** Writes a volume's changed chunks (and its description) into its folder; resolves false where the browser keeps nothing. */
export async function keep(volume: LabelVolume, info: Omit<KeptInfo, "size" | "type" | "voxelToRas" | "time" | "chunks">, keys: Iterable<number>): Promise<boolean> {
  const top = await root();
  if (top === undefined) return false;
  try {
    const dir = (await top.getDirectoryHandle(info.id, { create: true })) as Dir;
    for (const key of keys) {
      const c = volume.chunk(key);
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

/** Forgets a kept volume. */
export async function discard(id: string): Promise<void> {
  const top = await root();
  await top?.removeEntry(id, { recursive: true }).catch(() => {});
}
