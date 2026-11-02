/**
 * Precomputed images in the volume view: sharded chunk ids and indexes as
 * Neuroglancer reads them, a hand-made sharded scale read back voxel for
 * voxel, regions of a level, and placement.  `NET=1` also reads a box of
 * MICrONS' electron microscopy.
 */
import { describe, expect, it } from "vitest";
import { encodeZIndexCompressed3d } from "neuroglancer/unstable/util/zorder.js";
import { apply } from "../ome.js";
import { chunkId, decodeMinishardIndex, type RangeRead, PrecomputedScale, readInfo, type Scale, scaleLevel, shardOf, type Sharding } from "../precomputed.js";
import { precomputedUrl } from "../sources.js";
import { storeOf } from "../plugin.js";

const u64 = (values: bigint[]) => {
  const out = new Uint8Array(8 * values.length);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setBigUint64(8 * i, v, true));
  return out;
};

/** A sharded scale in memory, written as the format says, and a reader over it. */
function shardedScale(size: [number, number, number], chunk: [number, number, number], value: (x: number, y: number, z: number) => number) {
  const sharding: Sharding = { "@type": "neuroglancer_uint64_sharded_v1", preshift_bits: 1, hash: "identity", minishard_bits: 1, shard_bits: 2, minishard_index_encoding: "raw", data_encoding: "raw" };
  const scale: Scale = { key: "s0", size, resolution: [8, 8, 40], voxel_offset: [100, 200, 10], chunk_sizes: [chunk], encoding: "raw", sharding };
  const grid = [0, 1, 2].map((k) => Math.ceil(size[k] / chunk[k]));
  // Chunks by shard and minishard.
  const shards = new Map<string, Map<number, { id: bigint; data: Uint8Array }[]>>();
  for (let cz = 0; cz < grid[2]; ++cz) {
    for (let cy = 0; cy < grid[1]; ++cy) {
      for (let cx = 0; cx < grid[0]; ++cx) {
        const lo = [cx * chunk[0], cy * chunk[1], cz * chunk[2]];
        const ext = [0, 1, 2].map((k) => Math.min(chunk[k], size[k] - lo[k]));
        const data = new Uint8Array(ext[0] * ext[1] * ext[2]);
        for (let z = 0; z < ext[2]; ++z) for (let y = 0; y < ext[1]; ++y) for (let x = 0; x < ext[0]; ++x) data[(z * ext[1] + y) * ext[0] + x] = value(lo[0] + x, lo[1] + y, lo[2] + z);
        const id = chunkId([cx, cy, cz], grid);
        const { shard, minishard } = shardOf(sharding, id);
        if (!shards.has(shard)) shards.set(shard, new Map());
        const m = shards.get(shard)!;
        if (!m.has(minishard)) m.set(minishard, []);
        m.get(minishard)!.push({ id, data });
      }
    }
  }
  // Each shard file: the shard index, the chunks, then the minishard indexes.
  const files = new Map<string, Uint8Array>();
  const indexSize = 16 * 2 ** sharding.minishard_bits;
  for (const [shard, minishards] of shards) {
    const parts: Uint8Array[] = [];
    let at = 0;
    const ranges: bigint[] = new Array(2 * 2 ** sharding.minishard_bits).fill(0n);
    const indexes: Uint8Array[] = [];
    const placed = new Map<number, { id: bigint; start: number; size: number }[]>();
    for (const [minishard, chunks] of minishards) {
      chunks.sort((a, b) => (a.id < b.id ? -1 : 1));
      placed.set(minishard, chunks.map((c) => {
        parts.push(c.data);
        const entry = { id: c.id, start: at, size: c.data.byteLength };
        at += c.data.byteLength;
        return entry;
      }));
    }
    for (const [minishard, entries] of placed) {
      const ids: bigint[] = [];
      const starts: bigint[] = [];
      const sizes: bigint[] = [];
      let prevId = 0n;
      let prevEnd = 0;
      for (const e of entries) {
        ids.push(e.id - prevId);
        starts.push(BigInt(e.start - prevEnd));
        sizes.push(BigInt(e.size));
        prevId = e.id;
        prevEnd = e.start + e.size;
      }
      const index = u64([...ids, ...starts, ...sizes]);
      ranges[2 * minishard] = BigInt(at);
      ranges[2 * minishard + 1] = BigInt(at + index.byteLength);
      at += index.byteLength;
      indexes.push(index);
    }
    const file = new Uint8Array(indexSize + at);
    file.set(u64(ranges), 0);
    let p = indexSize;
    for (const part of [...parts, ...indexes]) {
      file.set(part, p);
      p += part.byteLength;
    }
    files.set(`mem://x/s0/${shard}`, file);
  }
  const read: RangeRead = async (url, range) => {
    const file = files.get(url);
    if (file === undefined) return undefined;
    return range === undefined ? file : file.slice(range.offset, range.offset + range.length);
  };
  return { scale, reader: new PrecomputedScale("mem://x/", scale, "uint8", read), grid };
}

describe("precomputed images", () => {
  it("names chunks as Neuroglancer does", () => {
    for (const [grid, pos] of [
      [[13, 11, 7], [5, 9, 3]],
      [[1, 64, 3], [0, 37, 2]],
      [[832, 704, 409].map((s) => Math.ceil(s / 64)), [6, 5, 3]],
    ]) {
      const bits = grid.map((g) => Math.ceil(Math.log2(g)));
      expect(chunkId(pos, grid)).toBe(encodeZIndexCompressed3d(bits[0], bits[1], bits[2], pos[0], pos[1], pos[2]));
    }
    const sharding: Sharding = { "@type": "neuroglancer_uint64_sharded_v1", preshift_bits: 9, hash: "identity", minishard_bits: 6, shard_bits: 2 };
    // Above the 9 preshift bits: minishard 5 (6 bits), then shard 2 (2 bits); higher bits are dropped.
    expect(shardOf(sharding, 0b1_10_000101n << 9n)).toEqual({ shard: "2.shard", minishard: 5 });
    expect(shardOf({ ...sharding, shard_bits: 5 }, 0b101_000011n << 9n).shard).toBe("05.shard");
  });

  it("decodes a minishard index: delta ids, offsets after the previous chunk", () => {
    const index = u64([3n, 2n, 10n, 5n, 0n, 7n, 4n, 6n, 1n]);
    expect(decodeMinishardIndex(index, 1024)).toEqual({ ids: [3n, 5n, 15n], starts: [1029, 1033, 1046], ends: [1033, 1039, 1047] });
  });

  it("reads a sharded scale back voxel for voxel, edge chunks padded", async () => {
    const value = (x: number, y: number, z: number) => (x * 7 + y * 13 + z * 29) % 251;
    const { reader, grid } = shardedScale([20, 17, 9], [8, 8, 4], value);
    expect(grid).toEqual([3, 3, 3]);
    for (let cz = 0; cz < 3; ++cz) {
      for (let cy = 0; cy < 3; ++cy) {
        for (let cx = 0; cx < 3; ++cx) {
          const data = (await reader.readChunk([cx, cy, cz]))!;
          expect(data.length).toBe(8 * 8 * 4);
          for (let z = 0; z < 4; ++z) {
            for (let y = 0; y < 8; ++y) {
              for (let x = 0; x < 8; ++x) {
                const [gx, gy, gz] = [cx * 8 + x, cy * 8 + y, cz * 4 + z];
                const inside = gx < 20 && gy < 17 && gz < 9;
                expect(data[(z * 8 + y) * 8 + x]).toBe(inside ? value(gx, gy, gz) : 0);
              }
            }
          }
        }
      }
    }
  });

  it("places voxels where Neuroglancer does: v spans [v, v + 1) after the offset, in nanometres", () => {
    const level = scaleLevel("https://x/", { key: "8_8_40", size: [10, 10, 10], resolution: [8, 8, 40], voxel_offset: [100, 200, 10], chunk_sizes: [[4, 4, 4]], encoding: "raw" });
    expect(level.axes).toEqual(["z", "y", "x"]);
    const centre = apply(level.voxelToRas, [0, 0, 0]);
    [100.5 * 8e-6, 200.5 * 8e-6, 10.5 * 40e-6].forEach((v, k) => expect(centre[k]).toBeCloseTo(v, 12));
  });

  it("knows precomputed sources from others", () => {
    expect(precomputedUrl("precomputed://gs://iarpa_microns/minnie/minnie65/em")).toBe("https://storage.googleapis.com/iarpa_microns/minnie/minnie65/em/");
    expect(precomputedUrl("precomputed://https://a.org/em/")).toBe("https://a.org/em/");
    expect(precomputedUrl("zarr://https://a.org/x.ome.zarr")).toBeUndefined();
    expect(storeOf("precomputed://s3://bucket/em")).toBe("precomputed:https://bucket.s3.amazonaws.com/em/");
    expect(storeOf("zarr://https://a.org/x.ome.zarr")).toBe("https://a.org/x.ome.zarr/");
    expect(storeOf("nifti://https://a.org/x.nii")).toBeUndefined();
  });

  it.skipIf(!process.env.NET)("reads a box of MICrONS' electron microscopy (NET=1)", async () => {
    const url = "https://storage.googleapis.com/iarpa_microns/minnie/minnie65/em/";
    const info = await readInfo(url);
    const coarsest = info.scales[info.scales.length - 1];
    const reader = new PrecomputedScale(url, coarsest, info.data_type);
    const middle = reader.grid.map((g) => g >> 1) as [number, number, number];
    const data = (await reader.readChunk(middle))!;
    expect(data.length).toBe(64 * 64 * 64);
    const mean = data.reduce((s, v) => s + v, 0) / data.length;
    expect(mean).toBeGreaterThan(40);
    expect(mean).toBeLessThan(220);
  }, 60_000);
});
