/**
 * The splats' reading worker: one image (OME-Zarr, a file read in place as
 * virtual OME-Zarr, or precomputed), read through the volume view's reader
 * a block of BLOCK³ voxels of a level at a time, each block made into
 * Gaussian splats (./splats.ts) in RAS millimetres.
 *
 * Intensities are the reader's (its window, 0..255) above the background:
 * the image's border says whether that is dark (fluorescence, MRI) or pale
 * (a stain), and tissue starts THRESHOLD past it, as the volume view takes
 * it.
 *
 * Messages in:  { type: "open", store }
 *               { type: "want", keys }    keys "<level>|x.y.z" (block coordinates)
 * Messages out: { type: "opened", info } | { type: "error", key?, message }
 *               { type: "splats", key, centres, covariances, weights } | { type: "empty", key }
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { asyncComputationWorker } from "@ngplatform/sdk/workers";
import { VolumeReader } from "../volume-view/volume_reader.js";
import { borderMean } from "../volume-view/solid.js";
import { splatsOfBlock, splatsToWorld } from "./splats.js";

setAsyncComputationWorkerFactory(() => asyncComputationWorker(["org.ngplatform.zarr-vectors"]));

/** Voxels a block a side, and a splat's cell. */
export const BLOCK = 32;
export const CELL = 4;
const THRESHOLD = 0.08;
const CONCURRENCY = 4;

export interface SplatLevel {
  size: [number, number, number];
  /** Voxel (x, y, z) to RAS mm, row-major. */
  voxelToRas: number[];
  voxelSize: number;
}

export interface SplatImageInfo {
  levels: SplatLevel[];
  darkBackground: boolean;
}

const reader = new VolumeReader();
let info: SplatImageInfo | undefined;
let background = 0;
let queue: string[] = [];
const inFlight = new Set<string>();
let running = 0;

const post = (message: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

async function open(store: string): Promise<void> {
  const { levels } = await reader.open([store], undefined);
  // The coarsest level, whole, says what the background is.
  const coarse = await reader.volume(levels.length - 1, new AbortController().signal);
  const mean = borderMean(coarse.data, coarse.size);
  const darkBackground = mean < 128;
  background = (darkBackground ? mean : 255 - mean) / 255;
  info = { levels: levels.map((l) => ({ size: l.size, voxelToRas: Array.from(l.voxelToRas), voxelSize: l.voxelSize })), darkBackground };
  post({ type: "opened", info });
  pump();
}

async function build(key: string): Promise<void> {
  const [level, coords] = key.split("|");
  const index = Number(level);
  const l = info!.levels[index];
  const c = coords.split(".").map(Number);
  const lo = c.map((v) => v * BLOCK) as [number, number, number];
  const hi = lo.map((v, k) => Math.min(l.size[k], v + BLOCK)) as [number, number, number];
  if (lo.some((v, k) => v >= hi[k] || v < 0)) {
    post({ type: "empty", key });
    return;
  }
  const { data, size } = await reader.volume(index, new AbortController().signal, undefined, { lo, hi });
  // Intensity above the background, 0..1 past the threshold.
  const floor = background + THRESHOLD;
  const scale = 1 / Math.max(1e-3, 1 - floor);
  const dark = info!.darkBackground;
  const values = new Float32Array(data.length);
  for (let i = 0; i < data.length; ++i) {
    const v = (dark ? data[i] : 255 - data[i]) / 255;
    values[i] = v > floor ? (v - floor) * scale : 0;
  }
  const splats = splatsOfBlock(values, size, CELL);
  if (splats.count === 0) {
    post({ type: "empty", key });
    return;
  }
  // The block's voxel 0 is the level's voxel `lo`.
  const m = l.voxelToRas.slice();
  for (let r = 0; r < 3; ++r) m[4 * r + 3] += m[4 * r] * lo[0] + m[4 * r + 1] * lo[1] + m[4 * r + 2] * lo[2];
  const world = splatsToWorld(splats, m);
  post({ type: "splats", key, centres: world.centres, covariances: world.covariances, weights: world.weights }, [world.centres.buffer, world.covariances.buffer, world.weights.buffer]);
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const key = queue.shift()!;
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    running++;
    build(key)
      .catch((e) => post({ type: "error", key, message: (e as Error).message }))
      .finally(() => {
        inFlight.delete(key);
        running--;
        pump();
      });
  }
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "open") {
    open(msg.store).catch((e) => post({ type: "error", message: (e as Error).message }));
  } else if (msg.type === "want") {
    // The newest list replaces the queue; blocks being read finish.
    queue = (msg.keys as string[]).filter((k) => !inFlight.has(k));
    if (info !== undefined) pump();
  }
};
