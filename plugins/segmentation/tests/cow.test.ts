/**
 * A segmentation edited in place, copy-on-write (../cow_volume.ts): chunks
 * read through from the original until edited, copied on the first edit,
 * coarse levels the original's except over edits, undo back to the
 * original, edits let go from memory and read back, and saving the edits
 * (and the whole volume) and reading them back.  The original is a real
 * OME-Zarr store (a label volume's, served through fetch) read by the
 * volume reader, as the editor reads one through the annotations worker.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { VolumeReader } from "../../volume-view/volume_reader.js";
import { cowLevels, CowVolume, type ReadOriginal } from "../cow_volume.js";
import { hashCombine } from "neuroglancer/unstable/gpu_hash/hash_function.js";
import { serializeColor } from "neuroglancer/unstable/util/color.js";
import { hsvToRgb } from "neuroglancer/unstable/util/colorspace.js";
import { capBox, reachChunks } from "../editor.js";
import { hashColour } from "../segments.js";
import { History, Stroke } from "../history.js";
import { floodFill, sameLabel, type Vec3 } from "../kernels.js";
import { CHUNK, type LabelArray, LabelVolume } from "../label_volume.js";
import { editsZarr, readEdits, writeWhole } from "../save.js";

afterEach(() => vi.unstubAllGlobals());

const PLACE = Float64Array.from([0.5, 0, 0, -10, 0, 0.5, 0, -20, 0, 0, 0.5, 5, 0, 0, 0, 1]);
const SIZE: Vec3 = [300, 200, 140];
const BASE = "http://original.test/labels.ome.zarr/";

/** Serves stores' keys as fetch gets them: each base URL its own. */
function serve(stores: Record<string, (key: string) => Uint8Array | undefined | Promise<Uint8Array | undefined>>) {
  vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    const base = Object.keys(stores).find((b) => u.startsWith(b));
    const data = base === undefined ? undefined : await stores[base](u.slice(base.length));
    if (data === undefined) return new Response(null, { status: 404 });
    const range = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "");
    return new Response((range ? data.slice(Number(range[1]), Number(range[2]) + 1) : data.slice()) as BlobPart, { status: range ? 206 : 200 });
  });
}

/** The original: a 32-bit segmentation with three levels, label 7 in a slab, 70000 + x in a bar, served as an OME-Zarr. */
function originalVolume(): LabelVolume {
  const v = new LabelVolume(SIZE, "uint32", PLACE, "original");
  const s = new Stroke(v);
  for (let z = 0; z < 140; ++z) for (let y = 0; y < 200; ++y) for (let x = 100; x < 140; ++x) s.set(x, y, z, 7);
  for (let z = 60; z < 70; ++z) for (let y = 90; y < 100; ++y) for (let x = 0; x < 300; ++x) s.set(x, y, z, 70000 + x);
  s.finish();
  return v;
}

/** A volume edited in place over the original, its reads counted by level. */
async function edited(): Promise<{ original: LabelVolume; cow: CowVolume; reads: number[]; reader: VolumeReader }> {
  const original = originalVolume();
  serve({ [BASE]: (key) => original.getKey(key) });
  const reader = new VolumeReader();
  const { levels } = await reader.open([BASE], undefined);
  const reads = levels.map(() => 0);
  const read: ReadOriginal = async (level, lo, size) => {
    reads[level]++;
    const hi = lo.map((v, k) => v + size[k]) as Vec3;
    return (await reader.exactRegion(level, { lo, hi }, new AbortController().signal)).data;
  };
  const cow = new CowVolume(levels, "uint32", { store: BASE, layer: "original" }, read, "edited");
  return { original, cow, reads, reader };
}

const at = (c: LabelArray | undefined, x: number, y: number, z: number) => (c === undefined ? 0 : c[(x & 63) + CHUNK * ((y & 63) + CHUNK * (z & 63))]);

describe("the levels of a segmentation edited in place", () => {
  it("are the original's while each divides the one before by whole numbers", () => {
    const grid = (size: Vec3, s: number[]) => ({ size, voxelToRas: Float64Array.from([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]) });
    const { levels, factors } = cowLevels([grid([1000, 1000, 101], [1, 1, 1]), grid([500, 500, 101], [2, 2, 1]), grid([250, 250, 51], [4, 4, 2]), grid([100, 100, 20], [10, 10, 5])]);
    expect(levels.length).toBe(3);
    expect(factors).toEqual([[1, 1, 1], [2, 2, 1], [2, 2, 2]]);
  });
});

describe("the original's colours", () => {
  it("are Neuroglancer's for a segment with none of its own", () => {
    // As SegmentColorHash.compute (segment_color.ts), from its own parts.
    const theirs = (seed: number, x: bigint) => {
      let h = hashCombine(seed, Number(x & 0xffffffffn));
      h = hashCombine(h, Number(x >> 32n));
      const out = hsvToRgb(new Float32Array(3), (h & 0xff) / 255, 0.5 + 0.5 * (((h >> 8) & 0xff) / 255), 1.0);
      return serializeColor(out as never);
    };
    for (const seed of [0, 12345, 4294967295]) for (const id of [1, 5, 255, 70001, 2 ** 31 + 7, 4294967295]) expect(hashColour(id, seed)).toBe(theirs(seed, BigInt(id)));
  });
});

describe("what a tool reads at once, edited in place", () => {
  it("cuts a fill's box to the chunks it may read, round the click, keeping a section's axis", () => {
    const v = new LabelVolume([4096, 4096, 1024], "uint32", PLACE);
    expect(reachChunks(v)).toBe(256);
    // A 2-D fill of a whole section: 4096² voxels, 64² chunks.
    const seed: Vec3 = [2000, 3000, 500];
    const { lo, hi, capped } = capBox(seed, [0, 0, 500], [4096, 4096, 501], reachChunks(v), (a, b) => v.chunksIn(a, b));
    expect(capped).toBe(true);
    expect(v.chunksIn(lo, hi)).toBeLessThanOrEqual(256);
    expect(v.chunksIn(lo, hi)).toBeGreaterThan(150);
    expect([lo[2], hi[2]]).toEqual([500, 501]);
    expect(lo[0] <= 2000 && hi[0] > 2000 && lo[1] <= 3000 && hi[1] > 3000).toBe(true);
    // A small box is left as it is.
    expect(capBox(seed, [1990, 2990, 490], [2010, 3010, 510], 256, (a, b) => v.chunksIn(a, b)).capped).toBe(false);
  });
});

describe("a segmentation edited in place", () => {
  it("reads chunks through from the original until edited, and never writes it", async () => {
    const { original, cow, reads } = await edited();
    expect(cow.levels.length).toBe(original.levels.length);
    expect(cow.type).toBe("uint32");
    // Served as the original's, chunk for chunk, and as the original's bytes.
    const got = (await cow.serve("0/c/0/1/1")) as Uint8Array;
    expect(Array.from(got)).toEqual(Array.from(original.getKey("0/c/0/1/1")!));
    expect(await cow.serve("0/c/2/3/4")).toBeUndefined();
    expect(cow.chunkCount).toBe(0);
    // The tools read only what was prepared; anything else is an error, not a silent 0.
    expect(() => cow.get(120, 10, 10)).toThrow(/not read/);
    const release = await cow.prepare([110, 0, 0], [130, 100, 70]);
    expect(cow.get(120, 10, 10)).toBe(7);
    expect(cow.get(120, 95, 65)).toBe(70120);
    expect(reads[0]).toBeGreaterThan(0);
    release();
    expect(cow.chunkCount).toBe(0);
    expect(cow.largestSeen).toBeGreaterThanOrEqual(70120);
  });

  it("copies a chunk on its first edit, as the original's labels, then changes the copy", async () => {
    const { original, cow } = await edited();
    const release = await cow.prepare([60, 90, 60], [70, 100, 70]);
    const s = new Stroke(cow);
    s.set(65, 95, 65, 9);
    s.finish();
    release();
    expect(cow.chunkCount).toBe(1);
    const key = cow.key(1, 1, 1);
    const own = cow.own(key)!;
    expect(at(own, 65, 95, 65)).toBe(9);
    // The rest of the chunk is the original's.
    const theirs = original.chunk(key)!;
    let differ = 0;
    for (let i = 0; i < own.length; ++i) if (own[i] !== theirs[i]) ++differ;
    expect(differ).toBe(1);
    expect(original.get(65, 95, 65)).toBe(70065);
    // Served from the edit.
    const got = new Uint32Array(((await cow.serve("0/c/1/1/1")) as Uint8Array).slice().buffer);
    expect(at(got, 65, 95, 65)).toBe(9);
    expect(at(got, 66, 95, 65)).toBe(70066);
  });

  it("makes coarse chunks again only over edits; elsewhere they are the original's", async () => {
    const { original, cow, reads } = await edited();
    // Level 1, chunk (1, 0, 0): its own read from the original's level 1.
    const before = reads[1];
    const away = (await cow.chunkAt(1, 1, 0, 0))!;
    expect(reads[1]).toBe(before + 1);
    expect(Array.from(away)).toEqual(Array.from(original.levelChunk(1, 1, 0, 0)!));
    // Paint a block of 9 in chunk (0, 0, 0) at level 0 (4 × 4 × 4 voxels from (8, 8, 8)).
    const release = await cow.prepare([8, 8, 8], [12, 12, 12]);
    const s = new Stroke(cow);
    for (let z = 8; z < 12; ++z) for (let y = 8; y < 12; ++y) for (let x = 8; x < 12; ++x) s.set(x, y, z, 9);
    s.finish();
    release();
    expect(cow.editedUnder(1, 0, 0, 0)).toBe(true);
    expect(cow.editedUnder(1, 1, 0, 0)).toBe(false);
    const reads0 = reads[1];
    const over = (await cow.chunkAt(1, 0, 0, 0))!;
    // Made from level 0, not read from the original's level 1.
    expect(reads[1]).toBe(reads0);
    expect(at(over, 4, 4, 4)).toBe(9);
    expect(at(over, 5, 5, 5)).toBe(9);
    expect(at(over, 6, 6, 6)).toBe(0);
    // The slab of 7 (x 100 to 139) is in chunk (0, 0, 0) of level 1 too, from level 0 below it.
    expect(at(over, 55, 4, 4)).toBe(7);
    // Level 2 over it is made again from level 1; away from it, the original's.
    expect(at((await cow.chunkAt(2, 0, 0, 0))!, 2, 2, 2)).toBe(9);
    expect((await cow.chunkAt(1, 1, 0, 0))!).toBe(away);
  });

  it("takes the commonest label of each 2 × 2 × 2 for a coarse voxel over edits", async () => {
    const { cow } = await edited();
    const release = await cow.prepare([0, 0, 0], [2, 2, 2]);
    const s = new Stroke(cow);
    // Six of 3, two of 4: 3.  The next 2 × 2 × 2: one of 5 and seven 0: 0 (the commonest), not 5.
    for (let i = 0; i < 8; ++i) s.set(i & 1, (i >> 1) & 1, i >> 2, i < 6 ? 3 : 4);
    s.finish();
    release();
    const r2 = await cow.prepare([2, 0, 0], [4, 2, 2]);
    const t = new Stroke(cow);
    t.set(2, 0, 0, 5);
    t.finish();
    r2();
    const c = (await cow.chunkAt(1, 0, 0, 0))!;
    expect(at(c, 0, 0, 0)).toBe(3);
    expect(at(c, 1, 0, 0)).toBe(0);
  });

  it("fills only through what it was given to read, and undoes back to the original", async () => {
    const { cow } = await edited();
    const history = new History();
    // A 2-D fill of the slab of 7 in section z = 30, limited to a box.
    const lo: Vec3 = [90, 0, 30];
    const hi: Vec3 = [150, 64, 31];
    const release = await cow.prepare(lo, hi);
    const s = new Stroke(cow);
    const result = floodFill(s, [120, 10, 30], sameLabel(cow, [120, 10, 30]), { value: 11 }, { axis: 2, box: { lo, hi } });
    s.finish();
    release();
    expect(result.changed).toBe(40 * 64);
    history.push(s);
    expect(cow.chunkCount).toBe(2);
    expect(cow.counts().get(11)).toBe(40 * 64);
    expect(cow.editedUnder(1, 0, 0, 0)).toBe(true);
    // Undo: the chunks are the original's again; nothing is edited.
    expect(history.undo().length).toBe(2);
    expect(cow.chunkCount).toBe(0);
    expect(cow.editedUnder(1, 0, 0, 0)).toBe(false);
    const r = await cow.prepare([120, 10, 30], [121, 11, 31]);
    expect(cow.get(120, 10, 30)).toBe(7);
    r();
    // Redo: edited again.
    history.redo();
    expect(cow.chunkCount).toBe(2);
    expect(cow.get(120, 10, 30)).toBe(11);
  });

  it("drops an edit that comes back to the original's labels", async () => {
    const { cow } = await edited();
    const release = await cow.prepare([120, 10, 10], [121, 11, 11]);
    const s = new Stroke(cow);
    s.set(120, 10, 10, 3);
    s.set(120, 10, 10, 7);
    s.finish();
    release();
    expect(s.changes).toBe(2);
    expect(cow.chunkCount).toBe(0);
  });

  it("lets edits the browser keeps go from memory past its budget, and reads them back when used", async () => {
    const { cow } = await edited();
    const kept = new Map<number, LabelArray>();
    cow.spill = { read: async (key) => kept.get(key)?.slice() };
    cow.memoryBudget = 2.5 * 4 * CHUNK ** 3;
    const keys: number[] = [];
    for (let cx = 0; cx < 4; ++cx) {
      const release = await cow.prepare([cx * 64, 0, 0], [cx * 64 + 1, 1, 1]);
      const s = new Stroke(cow);
      s.set(cx * 64, 0, 0, 20 + cx);
      s.finish();
      release();
      keys.push(cow.key(cx, 0, 0));
    }
    // Not yet kept in the browser: all in memory.
    expect(cow.bytes).toBe(4 * 4 * CHUNK ** 3);
    for (const k of keys) kept.set(k, cow.own(k)!.slice());
    cow.keptAt(keys, keys.map((k) => cow.versionOf(k)));
    expect(cow.spilledCount).toBe(2);
    expect(cow.chunkCount).toBe(4);
    // Still counted, still served, and read back for a tool.
    expect(cow.counts().get(20)).toBe(1);
    expect(at((await cow.chunkAt(0, 0, 0, 0))!, 0, 0, 0)).toBe(20);
    const release = await cow.prepare([0, 0, 0], [1, 1, 1]);
    expect(cow.get(0, 0, 0)).toBe(20);
    release();
  });
});

describe("saving a segmentation edited in place", () => {
  it("writes only the edits with a note of the original, and reads them back over it", async () => {
    const { cow } = await edited();
    const release = await cow.prepare([200, 150, 100], [201, 151, 101]);
    const s = new Stroke(cow);
    s.set(200, 150, 100, 12);
    s.finish();
    release();
    const files = await editsZarr(cow, "test", undefined, [{ value: 12, name: "twelve", colour: "#ff0000" }]);
    const group = JSON.parse(new TextDecoder().decode(files.get("zarr.json")));
    expect(group.attributes.ngplatform.edits.original.store).toBe(BASE);
    const chunks = [...files.keys()].filter((k) => /\/c\//.test(k)).sort();
    // The edited chunk at level 0 and the one over it at each coarser level.
    expect(cow.levels.length).toBe(4);
    expect(chunks).toEqual(["0/c/1/2/3", "1/c/0/1/1", "2/c/0/0/0", "3/c/0/0/0"]);
    const back = await readEdits(files);
    expect(back.note.original.store).toBe(BASE);
    expect(back.labels).toEqual([{ value: 12, name: "twelve", colour: "#ff0000", group: undefined }]);
    expect(back.chunks.map((c) => c.at)).toEqual([[3, 2, 1]]);
    // Over a fresh volume on the original: the edit is back.
    const { cow: again } = await edited();
    for (const c of back.chunks) again.putChunk(again.key(...c.at), c.data);
    const r = await again.prepare([200, 150, 100], [201, 151, 101]);
    expect(again.get(200, 150, 100)).toBe(12);
    r();
  });

  it("writes the whole volume, the original's chunks copied in blocks and the edited ones as edited, which the reader reads back", async () => {
    const { original, cow } = await edited();
    const release = await cow.prepare([120, 10, 10], [121, 11, 11]);
    const s = new Stroke(cow);
    s.set(120, 10, 10, 5);
    s.finish();
    release();
    const files = new Map<string, Uint8Array>();
    const progress: number[] = [];
    const written = await writeWhole(cow, async (path, bytes) => void files.set(path, bytes), { progress: (d, t) => progress.push(d / t) });
    expect(progress[progress.length - 1]).toBe(1);
    expect(written).toBe([...files.keys()].filter((k) => /\/c\//.test(k)).length);
    // Read back as an OME-Zarr (gzipped chunks): the original's labels, and the edit.
    const out = "http://saved.test/whole.ome.zarr/";
    serve({ [BASE]: (key) => original.getKey(key), [out]: (key) => files.get(key) });
    const reader = new VolumeReader();
    const { levels } = await reader.open([out], undefined);
    expect(levels.length).toBe(cow.levels.length);
    const { data, size } = await reader.exactRegion(0, { lo: [118, 8, 8], hi: [123, 12, 12] }, new AbortController().signal);
    const v = (x: number, y: number, z: number) => data[x - 118 + size[0] * (y - 8 + size[1] * (z - 8))];
    expect(v(120, 10, 10)).toBe(5);
    expect(v(121, 10, 10)).toBe(7);
    const bar = await reader.exactRegion(0, { lo: [250, 95, 65], hi: [251, 96, 66] }, new AbortController().signal);
    expect(bar.data[0]).toBe(70250);
  });
});
