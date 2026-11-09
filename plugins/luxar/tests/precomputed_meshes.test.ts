/**
 * Precomputed segment meshes as a virtual Zarr Vectors mesh store: the
 * formats (multi-resolution manifests, quantized vertices, legacy
 * fragments), the store's URL and segments, and whole stores (sharded and
 * not, multi-resolution and legacy) made from files in memory and read back
 * by the Zarr Vectors reader as Luxar's worker reads them.  Draco is stood
 * in for by a plain encoding of the same content (quantized positions and
 * indices).
 */
import { describe, expect, it } from "vitest";
import { shardOf } from "@ngplatform/sdk/precomputed";
import { LevelPipeline, openZarrVectorsStore } from "neuroglancer-zarr-vectors/reader";
import { applyAffine, composeAffine, decodeLegacyFragment, decodeMultilodManifest, dequantize } from "../../zarr-vectors/src/virtual/precomputed_meshes.js";
import { meshIdsFor, meshStoreUrl, parseMeshStoreUrl } from "../mesh_layers.js";
import { type DracoDecode, openPrecomputedMeshes, storeAccess } from "../precomputed_meshes.js";

const signal = new AbortController().signal;

/** A manifest's bytes, as meshes.md lays it out. */
function manifestBytes(m: { chunkShape: number[]; gridOrigin: number[]; lods: { scale: number; offset: number[]; nodes: number[][]; sizes: number[] }[] }): Uint8Array {
  const n = m.lods.length;
  const total = m.lods.reduce((a, l) => a + l.nodes.length, 0);
  const out = new DataView(new ArrayBuffer(28 + 20 * n + 16 * total));
  let at = 0;
  const f = (v: number) => (out.setFloat32(at, v, true), (at += 4));
  const u = (v: number) => (out.setUint32(at, v, true), (at += 4));
  m.chunkShape.forEach(f);
  m.gridOrigin.forEach(f);
  u(n);
  m.lods.forEach((l) => f(l.scale));
  m.lods.forEach((l) => l.offset.forEach(f));
  m.lods.forEach((l) => u(l.nodes.length));
  for (const l of m.lods) {
    for (let k = 0; k < 3; ++k) l.nodes.forEach((p) => u(p[k]));
    l.sizes.forEach(u);
  }
  return new Uint8Array(out.buffer);
}

/** A stand-in for a Draco fragment: u32 vertices, u32 indices, then the quantized positions and the indices. */
function fragmentBytes(q: number[], indices: number[]): Uint8Array {
  return new Uint8Array(Uint32Array.from([q.length / 3, indices.length, ...q, ...indices]).buffer);
}

const fakeDraco: DracoDecode = async (bytes) => {
  const words = new Uint32Array(bytes.slice().buffer);
  const nv = words[0];
  const ni = words[1];
  return { vertexPositions: words.slice(2, 2 + 3 * nv), indices: words.slice(2 + 3 * nv, 2 + 3 * nv + ni) };
};

/** Files in memory, read as `RangeRead` reads them. */
function memoryFiles(files: Map<string, Uint8Array>) {
  const reads: string[] = [];
  const read = async (url: string, range?: { offset: number; length: number }) => {
    reads.push(range ? `${url}@${range.offset}+${range.length}` : url);
    const data = files.get(url);
    if (data === undefined) return undefined;
    return range === undefined ? data : data.subarray(range.offset, range.offset + range.length);
  };
  return { read, reads };
}

const text = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.byteLength) - p.byteLength);
  return out;
};

const VOLUME = "https://example.org/seg/";
const MESH = `${VOLUME}mesh/`;
// The finest scale's resolution, nm: the store is in these voxels.
const RESOLUTION = [8, 8, 40];
// The mesh info's transform: stored model units to nanometres.
const TRANSFORM = [16, 0, 0, 0, 0, 16, 0, 0, 0, 0, 40, 0];

/** One triangle per node, at three of its corners (quantized 10-bit: 0 and 1023). */
const TRI_Q = [0, 0, 0, 1023, 0, 0, 0, 1023, 0];
const TRI = [0, 1, 2];

/** Two segments: 7 with two levels of detail (two nodes at lod 0, one at lod 1), 9 with one. */
function segments() {
  const seg7 = { chunkShape: [10, 10, 10], gridOrigin: [100, 200, 300], lods: [
    { scale: 1, offset: [0, 0, 0], nodes: [[0, 0, 0], [1, 0, 0]], frags: [fragmentBytes(TRI_Q, TRI), fragmentBytes(TRI_Q, TRI)] },
    { scale: 2, offset: [0.5, 0, 0], nodes: [[0, 0, 0]], frags: [fragmentBytes([...TRI_Q, 1023, 1023, 1023], [0, 1, 2, 1, 2, 3])] },
  ] };
  const seg9 = { chunkShape: [10, 10, 10], gridOrigin: [0, 0, 0], lods: [{ scale: 1, offset: [0, 0, 0], nodes: [[3, 3, 3]], frags: [fragmentBytes(TRI_Q, TRI)] }] };
  const out = new Map<bigint, { manifest: Uint8Array; data: Uint8Array }>();
  for (const [id, s] of [[7n, seg7], [9n, seg9]] as const) {
    const lods = s.lods.map((l) => ({ ...l, sizes: l.frags.map((b) => b.byteLength) }));
    out.set(id, { manifest: manifestBytes({ ...s, lods }), data: concat(lods.flatMap((l) => l.frags)) });
  }
  return out;
}

function infos(files: Map<string, Uint8Array>, sharding?: unknown) {
  files.set(`${VOLUME}info`, text({ "@type": "neuroglancer_multiscale_volume", type: "segmentation", data_type: "uint64", num_channels: 1, mesh: "mesh", scales: [{ key: "8_8_40", resolution: RESOLUTION, size: [100, 100, 100] }] }));
  files.set(`${MESH}info`, text({ "@type": "neuroglancer_multilod_draco", vertex_quantization_bits: 10, transform: TRANSFORM, lod_scale_multiplier: 1, ...(sharding ? { sharding } : {}) }));
}

/** Every cell of every level, read by the reader: per level, the vertices by segment id (voxels), and the face count. */
async function readAll(store: Awaited<ReturnType<typeof openPrecomputedMeshes>>) {
  const access = storeAccess(store);
  const zv = await openZarrVectorsStore(access, []);
  expect(zv.description.geometryKind).toBe("mesh");
  const levels: { vertices: Map<bigint, number[][]>; faces: number }[] = [];
  for (let k = 0; k < zv.levels.length; ++k) {
    const meta = JSON.parse(new TextDecoder().decode((await store.get(`${k}/vertices/zarr.json`))!));
    const ids = new BigInt64Array((await store.get(`${k}/object_index/object_ids/c/0`))!.slice().buffer);
    const vertices = new Map<bigint, number[][]>();
    let faces = 0;
    for (const cell of meta.attributes.nonempty_chunks as string[]) {
      const d = (await new LevelPipeline(access, zv.description, zv.levels[k]).download(cell.split(".").map(Number), signal))!;
      for (let v = 0; v < d.numOwnVertices; ++v) {
        // The reader's segment ids are the object index's rows' ids.
        const id = BigInt(d.segmentIds[2 * v]) + (BigInt(d.segmentIds[2 * v + 1]) << 32n);
        const list = vertices.get(id) ?? [];
        list.push(Array.from(d.positions.subarray(3 * v, 3 * v + 3), (x) => +x.toFixed(3)));
        vertices.set(id, list);
      }
      faces += (d.faces?.length ?? 0) / 3;
    }
    levels.push({ vertices, faces });
    expect(ids[0]).toBe(7n);
  }
  return levels;
}

describe("precomputed mesh formats", () => {
  it("reads a multi-resolution manifest: nodes [3, n] in C order, fragment offsets summed from lod 0", () => {
    const m = decodeMultilodManifest(
      manifestBytes({ chunkShape: [1, 2, 3], gridOrigin: [4, 5, 6], lods: [
        { scale: 1, offset: [0, 0, 0], nodes: [[0, 1, 2], [3, 4, 5]], sizes: [10, 20] },
        { scale: 2, offset: [1, 1, 1], nodes: [[6, 7, 8]], sizes: [5] },
      ] }),
    );
    expect(m.chunkShape).toEqual([1, 2, 3]);
    expect(m.gridOrigin).toEqual([4, 5, 6]);
    expect(m.lodScales).toEqual([1, 2]);
    expect(m.vertexOffsets).toEqual([[0, 0, 0], [1, 1, 1]]);
    expect(m.lods[0].positions).toEqual([[0, 1, 2], [3, 4, 5]]);
    expect(m.lods[0].offsets).toEqual([0, 10]);
    expect(m.lods[1].positions).toEqual([[6, 7, 8]]);
    expect(m.lods[1].offsets).toEqual([30]);
    expect(m.dataBytes).toBe(35);
    expect(() => decodeMultilodManifest(new Uint8Array(30))).toThrow();
  });

  it("dequantizes as meshes.md says: grid origin + vertex offset + chunk shape · 2^lod · (node + q / (2^bits − 1))", () => {
    const m = decodeMultilodManifest(manifestBytes({ chunkShape: [10, 10, 10], gridOrigin: [100, 200, 300], lods: [
      { scale: 1, offset: [0, 0, 0], nodes: [], sizes: [] },
      { scale: 2, offset: [0.5, 0, -1], nodes: [], sizes: [] },
    ] }));
    expect(Array.from(dequantize([0, 0, 0, 1023, 1023, 1023], m, 1, [1, 2, 3], 10))).toEqual([120.5, 240, 359, 140.5, 260, 379]);
  });

  it("reads a legacy fragment, and composes and applies 3 × 4 affines", () => {
    const bytes = new DataView(new ArrayBuffer(4 + 36 + 12));
    bytes.setUint32(0, 3, true);
    [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((v, i) => bytes.setFloat32(4 + 4 * i, v, true));
    [0, 2, 1].forEach((v, i) => bytes.setUint32(40 + 4 * i, v, true));
    const f = decodeLegacyFragment(new Uint8Array(bytes.buffer));
    expect(Array.from(f.positions)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(f.triangles)).toEqual([0, 2, 1]);
    expect(() => decodeLegacyFragment(new Uint8Array(bytes.buffer, 0, 50))).toThrow();
    const a = composeAffine([0.5, 0, 0, 1, 0, 0.5, 0, 0, 0, 0, 0.25, 0], [16, 0, 0, 2, 0, 16, 0, 0, 0, 0, 40, 0]);
    expect(Array.from(applyAffine(a, [1, 1, 1]))).toEqual([10, 8, 10]);
  });
});

describe("the store's URL and segments", () => {
  it("names the volume and the segments, ascending, and reads them back", () => {
    const url = meshStoreUrl(VOLUME, [9n, 864691135610744327n, 7n, 9n]);
    expect(url).toBe(`precomputed-meshes:${VOLUME}#segments=7,9,864691135610744327`);
    expect(parseMeshStoreUrl(url)).toEqual({ volume: VOLUME, ids: [7n, 9n, 864691135610744327n] });
    expect(parseMeshStoreUrl("https://example.org/store.zarr/")).toBeUndefined();
  });

  it("keeps the store while it holds every segment shown; a new one only for a segment it lacks", () => {
    expect(meshIdsFor([3n, 1n], undefined)).toEqual([1n, 3n]);
    expect(meshIdsFor([3n], [1n, 3n])).toEqual([1n, 3n]);
    expect(meshIdsFor([3n, 5n], [1n, 3n])).toEqual([3n, 5n]);
  });
});

describe("precomputed meshes as a Zarr Vectors mesh store", () => {
  for (const sharded of [false, true]) {
    it(`serves each level of detail as a level, with the segmentation's ids, in the volume's voxels (${sharded ? "sharded" : "unsharded"})`, async () => {
      const files = new Map<string, Uint8Array>();
      const segs = segments();
      if (!sharded) {
        infos(files);
        for (const [id, s] of segs) {
          files.set(`${MESH}${id}.index`, s.manifest);
          files.set(`${MESH}${id}`, s.data);
        }
      } else {
        // One shard, one minishard, identity hash: per segment its fragments, then its manifest.
        const sharding = { "@type": "neuroglancer_uint64_sharded_v1", preshift_bits: 0, hash: "identity", minishard_bits: 0, shard_bits: 0, minishard_index_encoding: "raw", data_encoding: "raw" } as const;
        infos(files, sharding);
        const parts: Uint8Array[] = [];
        const entries: { id: bigint; start: number; size: number }[] = [];
        let at = 0;
        for (const [id, s] of segs) {
          parts.push(s.data, s.manifest);
          at += s.data.byteLength;
          entries.push({ id, start: at, size: s.manifest.byteLength });
          at += s.manifest.byteLength;
        }
        // The minishard index: id deltas, start deltas (from the previous entry's end), sizes.
        const index = new DataView(new ArrayBuffer(24 * entries.length));
        let id = 0n;
        let end = 0;
        entries.forEach((e, i) => {
          index.setBigUint64(8 * i, e.id - id, true);
          index.setBigUint64(8 * (entries.length + i), BigInt(e.start - end), true);
          index.setBigUint64(8 * (2 * entries.length + i), BigInt(e.size), true);
          id = e.id;
          end = e.start + e.size;
        });
        const shardIndex = new DataView(new ArrayBuffer(16));
        shardIndex.setBigUint64(0, BigInt(at), true);
        shardIndex.setBigUint64(8, BigInt(at + index.byteLength), true);
        expect(shardOf(sharding, 7n).shard).toBe("0.shard");
        files.set(`${MESH}0.shard`, concat([new Uint8Array(shardIndex.buffer), ...parts, new Uint8Array(index.buffer)]));
      }
      const { read, reads } = memoryFiles(files);
      const store = await openPrecomputedMeshes(VOLUME, [9n, 7n, 11n], { read, decode: fakeDraco });
      // Segment 11 has no mesh: left out.  Opening reads no fragment.
      expect(store.plan.ids).toEqual([7n, 9n]);
      expect(store.fragmentCounts).toEqual([3, 2]);
      const before = reads.length;
      const levels = await readAll(store);
      expect(reads.length - before).toBe(5);
      expect(levels.length).toBe(2);
      // Stored → nm (×16, ×16, ×40) → voxels (/8, /8, /40): x and y twice the stored model's, z the same.
      const v = (p: number[]) => [2 * p[0], 2 * p[1], p[2]];
      // Level 0, segment 7: lod 0's two nodes (10 wide at 100, 200, 300), each a triangle on three corners.
      expect(levels[0].vertices.get(7n)!.sort()).toEqual([
        v([100, 200, 300]), v([110, 200, 300]), v([100, 210, 300]),
        v([110, 200, 300]), v([120, 200, 300]), v([110, 210, 300]),
      ].sort());
      expect(levels[0].vertices.get(9n)!.sort()).toEqual([v([30, 30, 30]), v([40, 30, 30]), v([30, 40, 30])].sort());
      expect(levels[0].faces).toBe(3);
      // Level 1: segment 7's lod 1 (one node 20 wide, offset 0.5 in x), two triangles; segment 9 again at its only lod.
      expect(levels[1].vertices.get(7n)!.sort()).toEqual([v([100.5, 200, 300]), v([120.5, 200, 300]), v([100.5, 220, 300]), v([120.5, 220, 320])].sort());
      expect(levels[1].vertices.get(9n)!.length).toBe(3);
      expect(levels[1].faces).toBe(3);
    });
  }

  it("drops the finer levels of detail past the vertex budget", async () => {
    const files = new Map<string, Uint8Array>();
    infos(files);
    for (const [id, s] of segments()) {
      files.set(`${MESH}${id}.index`, s.manifest);
      files.set(`${MESH}${id}`, s.data);
    }
    const { read } = memoryFiles(files);
    // Level of detail 0 has 3 fragments of 44 bytes (about 53 vertices estimated), lod 1 two (one of 64 bytes).
    const store = await openPrecomputedMeshes(VOLUME, [7n, 9n], { read, decode: fakeDraco, budget: 50 });
    expect(store.plan.levels.map((l) => l.label)).toEqual(["lod 1"]);
    const levels = await readAll(store);
    expect(levels[0].vertices.get(7n)!.length).toBe(4);
  });

  it("serves legacy meshes (<id>:0 listing fragment files, in nanometres) as one level", async () => {
    const files = new Map<string, Uint8Array>();
    files.set(`${VOLUME}info`, text({ type: "segmentation", data_type: "uint64", num_channels: 1, mesh: "mesh", scales: [{ resolution: RESOLUTION }] }));
    const frag = new DataView(new ArrayBuffer(4 + 36 + 12));
    frag.setUint32(0, 3, true);
    [80, 160, 400, 160, 160, 400, 80, 240, 800].forEach((x, i) => frag.setFloat32(4 + 4 * i, x, true));
    [0, 1, 2].forEach((x, i) => frag.setUint32(40 + 4 * i, x, true));
    files.set(`${MESH}7:0`, text({ fragments: ["7:0:a"] }));
    files.set(`${MESH}7:0:a`, new Uint8Array(frag.buffer));
    const { read } = memoryFiles(files);
    const store = await openPrecomputedMeshes(VOLUME, [7n], { read, decode: fakeDraco });
    const levels = await readAll(store);
    expect(levels.length).toBe(1);
    expect(levels[0].vertices.get(7n)!.sort()).toEqual([[10, 20, 10], [20, 20, 10], [10, 30, 20]].sort());
    expect(levels[0].faces).toBe(1);
  });
});
