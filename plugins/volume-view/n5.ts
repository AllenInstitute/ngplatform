/**
 * N5 images (as Neuroglancer and the Human Organ Atlas serve them, `n5://gs://…`): a pyramid of arrays `s0`, `s1`,
 * … under a group whose attributes.json gives `downsamplingFactors` (or `scales`), `resolution` (or
 * `pixelResolution`) and `units`, each array's attributes.json its `dimensions`, `blockSize`, `dataType` and
 * `compression`. As runner/ngplatform_render/volumes.py reads them, here for the browser's readers.
 *
 * A block is stored at `<array>/<x>/<y>/<z>`: a header (mode and the number of dimensions, as big-endian 16-bit
 * numbers; each dimension's size, 32-bit), then the values, compressed (raw, gzip, zlib, blosc or zstd),
 * big-endian, x fastest. A block at the array's far edge is stored at its own (smaller) size: it is padded here
 * to the full block, as Zarr's chunks are.
 */
import { httpJson } from "@ngplatform/sdk/precomputed";
import type { Mat4, VolumeLevel } from "./ome.js";

/** What an N5 array's attributes say, as the reader needs them (x, y, z order). */
export interface N5Array {
  dimensions: [number, number, number];
  blockSize: [number, number, number];
  dataType: string;
  compression: { type?: string; useZlib?: boolean; [key: string]: unknown };
}

/** Millimetres in a unit as N5 names them. */
const UNIT_MM: Record<string, number> = {
  nm: 1e-6, nanometer: 1e-6, um: 1e-3, µm: 1e-3, micrometer: 1e-3, micron: 1e-3, mm: 1, millimeter: 1, cm: 10, centimeter: 10, m: 1e3, meter: 1e3, "": 1,
};

/** The pyramid's levels (finest first) and each one's array attributes, read from the store at `url` (ending "/"). */
export async function readN5Levels(url: string, signal?: AbortSignal): Promise<{ levels: VolumeLevel[]; arrays: N5Array[]; name: string }> {
  const top = (await httpJson(`${url}attributes.json`, signal)) as Record<string, unknown> | undefined;
  if (top === undefined) throw new Error(`${url}: no attributes.json (not an N5 store)`);
  const pixel = top.pixelResolution as { dimensions?: number[]; unit?: string } | undefined;
  const res = ((top.resolution as number[] | undefined) ?? pixel?.dimensions ?? [1, 1, 1]).map(Number);
  const units = (top.units as string[] | undefined) ?? [pixel?.unit ?? "um", pixel?.unit ?? "um", pixel?.unit ?? "um"];
  const mm = units.map((u) => UNIT_MM[u] ?? UNIT_MM[u.toLowerCase()] ?? 1e-3);
  const factors = ((top.downsamplingFactors as number[][] | undefined) ?? (top.scales as number[][] | undefined) ?? [[1, 1, 1]]).map((f) => f.map(Number));
  const levels: VolumeLevel[] = [];
  const arrays: N5Array[] = [];
  for (let k = 0; k < factors.length; ++k) {
    const path = `s${k}`;
    const a = (await httpJson(`${url}${path}/attributes.json`, signal)) as Partial<N5Array> | undefined;
    if (a === undefined || a.dimensions === undefined || a.blockSize === undefined) break;
    const f = factors[k];
    // Voxel i of a level spans [i, i + 1) of its own voxels from the store's origin, its centre at i + 0.5 (as
    // Neuroglancer places an N5 level).
    const edge = [0, 1, 2].map((d) => res[d] * f[d] * mm[d]);
    const m = new Float64Array(16) as Mat4;
    for (let d = 0; d < 3; ++d) {
      m[5 * d] = edge[d];
      m[4 * d + 3] = 0.5 * edge[d];
    }
    m[15] = 1;
    levels.push({ url, path, voxelToRas: m, voxelSize: (edge[0] + edge[1] + edge[2]) / 3, axes: ["z", "y", "x"] });
    arrays.push({
      dimensions: a.dimensions.map(Number) as [number, number, number],
      blockSize: a.blockSize.map(Number) as [number, number, number],
      dataType: String(a.dataType),
      compression: a.compression ?? { type: "raw" },
    });
  }
  if (levels.length === 0) throw new Error(`${url}: no levels (s0, s1, …) with attributes.json`);
  // Finest first.
  const order = levels.map((_, i) => i).sort((i, j) => levels[i].voxelSize - levels[j].voxelSize);
  return { levels: order.map((i) => levels[i]), arrays: order.map((i) => arrays[i]), name: url.replace(/\/$/, "").split("/").pop() ?? "" };
}

/** Decompresses a block's payload as its array's attributes name. */
async function decompress(bytes: Uint8Array, compression: N5Array["compression"]): Promise<Uint8Array> {
  const type = compression.type ?? "raw";
  switch (type) {
    case "raw":
      return bytes;
    case "gzip": {
      const { default: Codec } = compression.useZlib ? await import("numcodecs/zlib") : await import("numcodecs/gzip");
      return (await Codec.fromConfig({ id: compression.useZlib ? "zlib" : "gzip" } as never).decode(bytes)) as Uint8Array;
    }
    case "blosc": {
      const { default: Blosc } = await import("numcodecs/blosc");
      return (await Blosc.fromConfig({ id: "blosc" } as never).decode(bytes)) as Uint8Array;
    }
    case "zstd": {
      const { default: Zstd } = await import("numcodecs/zstd");
      return (await Zstd.fromConfig({ id: "zstd" } as never).decode(bytes)) as Uint8Array;
    }
    default:
      throw new Error(`N5 ${type} compression is not read here (raw, gzip, blosc and zstd are)`);
  }
}

/**
 * A block's values from its stored bytes: the header read, the payload decompressed, swapped to little-endian, and
 * padded to the full block (x fastest), so it reads as a Zarr chunk of shape (z, y, x) does.
 */
export async function decodeN5Block(stored: Uint8Array, array: N5Array, width: number): Promise<Uint8Array> {
  const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
  const mode = view.getUint16(0);
  const nd = view.getUint16(2);
  const dims = Array.from({ length: nd }, (_, i) => view.getUint32(4 + 4 * i));
  // Mode 1 (varlength) has the number of elements after the dimensions.
  const offset = 4 + 4 * nd + (mode === 1 ? 4 : 0);
  const payload = await decompress(stored.subarray(offset), array.compression);
  const [bx, by, bz] = array.blockSize;
  const [dx, dy, dz] = [dims[0] ?? bx, dims[1] ?? 1, dims[2] ?? 1];
  const out = new Uint8Array(bx * by * bz * width);
  const row = dx * width;
  for (let z = 0; z < Math.min(dz, bz); ++z)
    for (let y = 0; y < Math.min(dy, by); ++y) {
      const from = (z * dy + y) * row;
      const to = (z * by + y) * bx * width;
      for (let i = 0; i < Math.min(dx, bx) * width; i += width)
        for (let b = 0; b < width; ++b) out[to + i + b] = payload[from + i + width - 1 - b];
    }
  return out;
}
