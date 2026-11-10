/**
 * Neuroglancer's memory: its limits sized by the computer's memory, and a
 * hint when the GPU memory is full.
 *
 * Neuroglancer's own defaults are 1 GB of GPU memory and 2 GB of system
 * memory on every computer.  Here they follow `navigator.deviceMemory`
 * (Chrome and Edge; GB, rounded down to a power of 2 and at most 8): a
 * quarter of it on the GPU, from 512 MB to 2 GB, and three eighths of it in
 * system memory, from 768 MB to 3 GB (at least the GPU's: Neuroglancer keeps
 * a copy of what it uploads).  They are the limits' defaults, so a link or a
 * workspace that names other limits still has them, and they are not written
 * into states that do not.
 */
import type { ChunkSourceStatistics } from "./view_settings.js";
import type { Viewer } from "./neuroglancer.js";

const MB = 2 ** 20;
const GB = 2 ** 30;

/** The limits for a computer with `deviceMemory` GB; undefined where the browser does not say (Neuroglancer's own then). */
export function memoryLimits(deviceMemory: number | undefined): { gpu: number; system: number } | undefined {
  if (deviceMemory === undefined || !(deviceMemory > 0)) return undefined;
  const gpu = Math.min(2 * GB, Math.max(512 * MB, (deviceMemory * GB) / 4));
  const system = Math.max(gpu, Math.min(3 * GB, Math.max(768 * MB, (deviceMemory * GB * 3) / 8)));
  return { gpu, system };
}

/** Sets the viewer's memory limits (and their defaults) by the computer's memory. */
export function sizeMemoryLimits(viewer: Viewer, deviceMemory = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory): void {
  const limits = memoryLimits(deviceMemory);
  if (limits === undefined) return;
  const { gpuMemory, systemMemory } = viewer.chunkQueueManager.capacities;
  for (const [limit, bytes] of [
    [gpuMemory.sizeLimit, limits.gpu],
    [systemMemory.sizeLimit, limits.system],
  ] as const) {
    // Only when nothing has set it yet: a limit a state named is kept.
    if (limit.value !== limit.defaultValue) continue;
    limit.defaultValue = bytes;
    limit.value = bytes;
  }
}

/**
 * Whether the GPU memory is full: chunks the views need are downloaded but
 * wait in system memory, while those on the GPU fill most of its limit.
 */
export function gpuMemoryFull(rows: ChunkSourceStatistics[], gpuLimit: number): boolean {
  let waiting = 0;
  let onGpu = 0;
  for (const r of rows) {
    if (Number.isFinite(r.memory)) waiting += r.memory;
    if (Number.isFinite(r.gpuBytes)) onGpu += r.gpuBytes;
  }
  return waiting > 0 && onGpu >= 0.85 * gpuLimit;
}

/** "2 GB", "512 MB". */
const size = (bytes: number) => (bytes >= GB ? `${+(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`);

/** The hint shown when the GPU memory is full. */
export function gpuMemoryHint(gpuLimit: number): string {
  return `GPU memory is full (${size(gpuLimit)}): some of what the views show is not drawn. Raise GPU memory in Settings › View, or hide layers you are not using.`;
}

/**
 * Watches the views' chunks every `every` ms (while the page is shown) and
 * calls `hint` once each time the GPU memory becomes full, after it has been
 * full for two looks running (an upload under way is not a full GPU).
 */
export function watchGpuMemory(
  read: () => Promise<ChunkSourceStatistics[]>,
  gpuLimit: () => number,
  hint: (message: string) => void,
  every = 3000,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let looks = 0;
  let told = false;
  const look = async () => {
    const hidden = (globalThis.document as Document | undefined)?.hidden === true;
    const rows = hidden ? undefined : await read().catch(() => undefined);
    if (stopped) return;
    if (rows !== undefined) {
      const full = gpuMemoryFull(rows, gpuLimit());
      looks = full ? looks + 1 : 0;
      if (looks >= 2 && !told) hint(gpuMemoryHint(gpuLimit()));
      // Told once until it is no longer full.
      told = looks >= 2 || (told && full);
    }
    timer = setTimeout(() => void look(), every);
  };
  timer = setTimeout(() => void look(), every);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
