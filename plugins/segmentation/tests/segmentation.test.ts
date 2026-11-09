/**
 * The label volume drawn by hand: its chunks, the OME-Zarr store it serves
 * (read back by the volume reader, as Neuroglancer reads it), the brush and
 * the fills on small volumes, undo and redo, quick select, and saving
 * (NIfTI read back through the platform's own NIfTI reader).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNifti } from "../../../src/virtual/images/nifti.js";
import { VolumeReader } from "../../volume-view/volume_reader.js";
import { chooseUndo, History, Stroke } from "../history.js";
import { ballReach, ballShape, dabsBetween, distance2d, fillOutline, floodFill, polygonRuns, type ImageBlock, inRange, interpolate, paintBall, relabel, sameLabel, type Vec3, voxelIndex } from "../kernels.js";
import { badLabel } from "../editor.js";
import { LabelVolume } from "../label_volume.js";
import { omeZarrMetadata } from "../../registration/volume_io.js";
import { maskCount, maskSection } from "../preview.js";
import { component, otsu, THRESHOLD_SELECT } from "../quick_select.js";
import { cropped, niftiGz, omeZarr, pruneStore, writeStore } from "../save.js";

afterEach(() => vi.unstubAllGlobals());

// 0.5 mm voxels from (-10, -20, 5), as a NIfTI's grid might be.
const PLACE = Float64Array.from([0.5, 0, 0, -10, 0, 0.5, 0, -20, 0, 0, 0.5, 5, 0, 0, 0, 1]);

const vol = (size: Vec3 = [100, 80, 70], type: "uint8" | "uint16" | "uint32" = "uint8") => new LabelVolume(size, type, PLACE, "t");

function count(v: LabelVolume, value: number): number {
  return v.counts().get(value) ?? 0;
}

/** Serves a store's keys as fetch would get them. */
function serve(get: (key: string) => Uint8Array | undefined | Promise<Uint8Array | undefined>, base: string) {
  vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
    const data = await get(String(url).replace(base, ""));
    if (data === undefined) return new Response(null, { status: 404 });
    const range = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "");
    return new Response((range ? data.slice(Number(range[1]), Number(range[2]) + 1) : data.slice()) as BlobPart, { status: range ? 206 : 200 });
  });
}

/** A folder in memory, as much of the File System Access API's as a save uses. */
class MemoryFolder {
  readonly entries = new Map<string, MemoryFolder | Uint8Array>();
  readonly handle = {
    kind: "directory",
    getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
      let d = this.entries.get(name);
      if (d === undefined && options?.create) this.entries.set(name, (d = new MemoryFolder()));
      if (!(d instanceof MemoryFolder)) throw new DOMException(name, "NotFoundError");
      return d.handle;
    },
    getFileHandle: async (name: string) => ({
      createWritable: async () => ({ write: async (b: Uint8Array) => void this.entries.set(name, b.slice()), close: async () => {} }),
    }),
    removeEntry: async (name: string) => void this.entries.delete(name),
    entries: () => this.list(),
  } as unknown as FileSystemDirectoryHandle;

  private async *list(): AsyncGenerator<[string, { kind: string }]> {
    for (const [name, e] of [...this.entries]) yield [name, e instanceof MemoryFolder ? e.handle : { kind: "file" }];
  }

  async file(path: string, bytes: Uint8Array): Promise<void> {
    const parts = path.split("/");
    let d: MemoryFolder = this;
    for (const p of parts.slice(0, -1)) {
      await d.handle.getDirectoryHandle(p, { create: true });
      d = d.entries.get(p) as MemoryFolder;
    }
    d.entries.set(parts[parts.length - 1], bytes);
  }

  get(path: string): Uint8Array | undefined {
    const parts = path.split("/");
    let d: MemoryFolder | Uint8Array | undefined = this;
    for (const p of parts) d = d instanceof MemoryFolder ? d.entries.get(p) : undefined;
    return d instanceof Uint8Array ? d : undefined;
  }

  /** Every file's path. */
  paths(at = ""): string[] {
    return [...this.entries].flatMap(([name, e]) => (e instanceof MemoryFolder ? e.paths(`${at}${name}/`) : [`${at}${name}`]));
  }
}

describe("a label volume in chunks", () => {
  it("makes chunks only where something is painted", () => {
    const v = vol();
    expect(v.grid).toEqual([2, 2, 2]);
    const s = new Stroke(v);
    s.set(70, 3, 66, 7);
    s.flush();
    expect(v.chunkCount).toBe(1);
    expect(v.get(70, 3, 66)).toBe(7);
    expect(v.get(69, 3, 66)).toBe(0);
    expect(v.get(-1, 0, 0)).toBe(0);
    expect(v.paintedBox()).toEqual({ lo: [70, 3, 66], hi: [71, 4, 67] });
  });

  it("serves an OME-Zarr store the volume reader reads back, voxel for voxel and in place", async () => {
    const v = vol([100, 80, 70], "uint16");
    const s = new Stroke(v);
    for (let z = 10; z < 20; ++z) for (let y = 30; y < 35; ++y) for (let x = 60; x < 75; ++x) s.set(x, y, z, 300 + x);
    s.finish();
    serve((key) => v.getKey(key), "http://labels.test/");
    const reader = new VolumeReader();
    const { levels } = await reader.open(["http://labels.test/"], undefined);
    expect(levels.length).toBe(v.levels.length);
    expect(levels[0].size).toEqual([100, 80, 70]);
    Array.from(levels[0].voxelToRas).forEach((m, i) => expect(m).toBeCloseTo(PLACE[i]));
    const { data, size } = await reader.rawRegion(0, { lo: [55, 28, 8], hi: [80, 37, 22] }, new AbortController().signal);
    const at = (x: number, y: number, z: number) => data[x - 55 + size[0] * (y - 28 + size[1] * (z - 8))];
    expect(at(60, 30, 10)).toBe(360);
    expect(at(74, 34, 19)).toBe(374);
    expect(at(59, 30, 10)).toBe(0);
    expect(at(60, 35, 10)).toBe(0);
  });

  it("makes coarser levels from the level below, keeping thin strokes", async () => {
    const v = vol([200, 200, 200]);
    const s = new Stroke(v);
    // One voxel at an odd index: "the first voxel" of each 2 × 2 × 2 would lose it.
    s.set(131, 77, 41, 9);
    s.finish();
    expect(v.levels.length).toBe(3);
    const c1 = v.levelChunk(1, 1, 0, 0)!;
    expect(c1[(65 - 64) + 64 * (38 + 64 * 20)]).toBe(9);
    const c2 = v.levelChunk(2, 0, 0, 0)!;
    expect(c2[32 + 64 * (19 + 64 * 10)]).toBe(9);
    expect(v.levelChunk(2, 0, 0, 0)).toBe(c2);
    // A stroke there makes them again.
    const t = new Stroke(v);
    t.set(131, 77, 41, 0);
    t.finish();
    expect(v.levelChunk(2, 0, 0, 0)).toBeUndefined();
    expect(v.getKey("2/c/0/0/0")).toBeUndefined();
  });

  it("answers metadata and raw chunk keys", () => {
    const v = vol();
    const group = JSON.parse(new TextDecoder().decode(v.getKey("zarr.json")));
    expect(group.attributes.ome.multiscales[0].type).toBe("nearest");
    const array = JSON.parse(new TextDecoder().decode(v.getKey("0/zarr.json")));
    expect(array.codecs).toEqual([{ name: "bytes", configuration: { endian: "little" } }]);
    expect(array.shape).toEqual([70, 80, 100]);
    expect(v.getKey("0/c/0/0/0")).toBeUndefined();
    const s = new Stroke(v);
    s.set(1, 2, 3, 5);
    s.flush();
    const chunk = v.getKey("0/c/0/0/0")!;
    expect(chunk.byteLength).toBe(64 ** 3);
    expect(chunk[1 + 64 * (2 + 64 * 3)]).toBe(5);
  });

  it("goes out as a block and comes back from one", () => {
    const v = vol([70, 66, 3], "uint32");
    const s = new Stroke(v);
    s.set(69, 65, 2, 70000);
    s.set(0, 0, 0, 1);
    s.finish();
    const block = v.dense();
    const w = new LabelVolume(v.size, "uint32", PLACE);
    w.load(block);
    expect(w.get(69, 65, 2)).toBe(70000);
    expect(w.get(0, 0, 0)).toBe(1);
    expect(w.chunkCount).toBe(2);
    const part = v.dense({ lo: [60, 60, 0], hi: [70, 66, 3] });
    expect(part[9 + 10 * (5 + 6 * 2)]).toBe(70000);
  });
});

describe("the brush", () => {
  it("paints a ball of the radius in voxels", () => {
    const v = vol();
    const s = new Stroke(v);
    const q = ballShape(3, "voxels");
    expect(paintBall(s, [50, 40, 30], q, { value: 2 })).toBe(123);
    expect(v.get(53, 40, 30)).toBe(2);
    // (3, 1, 0) from the centre is past a radius of 3.
    expect(v.get(53, 41, 30)).toBe(0);
    expect(v.get(52, 42, 30)).toBe(2);
  });

  it("is round in millimetres on anisotropic voxels", () => {
    const v = new LabelVolume([40, 40, 40], "uint8", Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1]));
    const q = ballShape(8, "mm", v.voxelToRas);
    const reach = ballReach(q);
    expect(reach[0]).toBeCloseTo(8);
    expect(reach[2]).toBeCloseTo(2);
    const s = new Stroke(v);
    paintBall(s, [20, 20, 20], q, { value: 1 });
    expect(v.get(28, 20, 20)).toBe(1);
    expect(v.get(20, 20, 22)).toBe(1);
    expect(v.get(20, 20, 23)).toBe(0);
  });

  it("paints only the disc in the section when given the section's normal", () => {
    const v = vol();
    const s = new Stroke(v);
    paintBall(s, [50, 40, 30.3], ballShape(3, "voxels"), { value: 1 }, [0, 0, 1]);
    expect(count(v, 1)).toBe(29);
    expect(v.get(50, 40, 30)).toBe(1);
    expect(v.get(50, 40, 31)).toBe(0);
    // On a boundary between sections (a view's position often is), the upper one, as Neuroglancer shows it, rounding or not.
    expect(voxelIndex(30.5)).toBe(31);
    expect(voxelIndex(30.49999)).toBe(31);
    expect(voxelIndex(30.4)).toBe(30);
  });

  it("paints only within an intensity range, and only over what is allowed", () => {
    const v = vol([20, 20, 20]);
    const image: ImageBlock = { lo: [0, 0, 0], size: [20, 20, 20], data: new Float32Array(8000).map((_, i) => i % 20) };
    const s = new Stroke(v);
    paintBall(s, [10, 10, 10], ballShape(5, "voxels"), { value: 3, where: inRange(image, 8, 11) });
    expect(v.get(9, 10, 10)).toBe(3);
    expect(v.get(12, 10, 10)).toBe(0);
    expect(v.get(7, 10, 10)).toBe(0);
    // "Only empty voxels": label 3 stays under a stroke of 4.
    paintBall(s, [10, 10, 10], ballShape(5, "voxels"), { value: 4, only: 0 });
    expect(v.get(9, 10, 10)).toBe(3);
    expect(v.get(12, 10, 10)).toBe(4);
  });

  it("puts dabs close enough together to leave no gap", () => {
    const q = ballShape(2, "voxels");
    const dabs = dabsBetween([0, 0, 0], [10, 0, 0], q);
    expect(dabs[dabs.length - 1]).toEqual([10, 0, 0]);
    for (let i = 1; i < dabs.length; ++i) expect(dabs[i][0] - dabs[i - 1][0]).toBeLessThanOrEqual(1);
  });
});

describe("fills", () => {
  /** A ring of label 1 in section z = 5, radius 6 around (10, 10). */
  function ring(): LabelVolume {
    const v = vol([20, 20, 10]);
    const s = new Stroke(v);
    for (let a = 0; a < 720; ++a) s.set(Math.round(10 + 6 * Math.cos((a * Math.PI) / 360)), Math.round(10 + 6 * Math.sin((a * Math.PI) / 360)), 5, 1);
    s.finish();
    return v;
  }

  it("fills inside an outline in its section (2-D)", () => {
    const v = ring();
    const before = count(v, 1);
    const s = new Stroke(v);
    const r = floodFill(s, [10, 10, 5], sameLabel(v, [10, 10, 5]), { value: 2 }, { axis: 2 });
    expect(r.limited).toBe(false);
    expect(v.get(10, 10, 5)).toBe(2);
    expect(v.get(10, 10, 4)).toBe(0);
    expect(v.get(0, 0, 5)).toBe(0);
    expect(count(v, 1)).toBe(before);
    expect(r.changed).toBeGreaterThan(80);
    expect(r.changed).toBeLessThan(Math.PI * 36);
  });

  it("fills in 3-D by an intensity range, within a box and a voxel limit", () => {
    const v = vol([30, 30, 30]);
    // A bright ball of radius 8 at (15, 15, 15).
    const data = new Float32Array(27000);
    for (let z = 0, i = 0; z < 30; ++z) for (let y = 0; y < 30; ++y) for (let x = 0; x < 30; ++x, ++i) data[i] = Math.hypot(x - 15, y - 15, z - 15) <= 8 ? 100 : 10;
    const image: ImageBlock = { lo: [0, 0, 0], size: [30, 30, 30], data };
    const s = new Stroke(v);
    const r = floodFill(s, [15, 15, 15], inRange(image, 50, 200), { value: 5 });
    expect(r.changed).toBe([...data].filter((d) => d === 100).length);
    expect(v.get(15, 15, 23)).toBe(5);
    expect(v.get(15, 15, 24)).toBe(0);
    const w = vol([30, 30, 30]);
    const boxed = floodFill(new Stroke(w), [15, 15, 15], inRange(image, 50, 200), { value: 5 }, { box: { lo: [10, 10, 10], hi: [20, 20, 20] } });
    let inBox = 0;
    for (let z = 10; z < 20; ++z) for (let y = 10; y < 20; ++y) for (let x = 10; x < 20; ++x) if (data[x + 30 * (y + 30 * z)] === 100) ++inBox;
    expect(boxed.changed).toBe(inBox);
    expect(w.get(15, 15, 21)).toBe(0);
    const limited = floodFill(new Stroke(vol([30, 30, 30])), [15, 15, 15], inRange(image, 50, 200), { value: 5 }, { maxVoxels: 100 });
    expect(limited).toMatchObject({ changed: 100, limited: true });
  });
});

describe("the lasso", () => {
  const rows = (runs: { w: number; from: number; to: number }[]) => runs.map((r) => `${r.w}:${r.from}-${r.to}`);

  it("finds the voxels whose centres are inside an outline, row by row", () => {
    // A square from (1.5, 1.5) to (4.5, 4.5): centres 2, 3, 4 each way.
    expect(rows(polygonRuns([[1.5, 1.5], [4.5, 1.5], [4.5, 4.5], [1.5, 4.5]]))).toEqual(["2:2-5", "3:2-5", "4:2-5"]);
    // A triangle: narrower towards its top.
    expect(rows(polygonRuns([[0, 0], [8, 0], [4, 8]]))).toEqual(["0:0-8", "1:1-8", "2:1-7", "3:2-7", "4:2-6", "5:3-6", "6:3-5", "7:4-5", "8:4-4"].filter((r) => !r.endsWith("4-4")));
    // Fewer than three points hold nothing.
    expect(polygonRuns([[0, 0], [5, 5]])).toEqual([]);
  });

  it("fills both loops of a figure of eight, and not the gap of a ring drawn as one outline", () => {
    const eight = polygonRuns([[0, 0], [4, 4], [8, 0], [8, 4], [4, 0], [0, 4]].map(([u, w]) => [u + 0.5, w + 0.5] as [number, number]));
    const cells = new Set(eight.flatMap((r) => Array.from({ length: r.to - r.from }, (_, i) => `${r.from + i},${r.w}`)));
    expect(cells.has("1,2")).toBe(true);
    expect(cells.has("7,2")).toBe(true);
    // A square with a square hole, the outline going round both (a cut joins them).
    const ring = polygonRuns([[0.5, 0.5], [10.5, 0.5], [10.5, 10.5], [0.5, 10.5], [0.5, 3.5], [3.5, 3.5], [3.5, 7.5], [7.5, 7.5], [7.5, 3.5], [0.5, 3.5]]);
    const filled = new Set(ring.flatMap((r) => Array.from({ length: r.to - r.from }, (_, i) => `${r.from + i},${r.w}`)));
    expect(filled.has("5,5")).toBe(false);
    expect(filled.has("2,5")).toBe(true);
    expect(filled.has("9,9")).toBe(true);
  });

  it("paints inside the outline in its section, as Paint over and an intensity range allow", () => {
    const v = vol([20, 20, 10]);
    // Segment 3 already in a corner of the square, in section z = 4.
    const before = new Stroke(v);
    before.set(2, 2, 4, 3);
    before.finish();
    const square: [number, number][] = [[1.5, 1.5], [6.5, 1.5], [6.5, 6.5], [1.5, 6.5]];
    // Over empty voxels only: segment 3 stays.
    const s = new Stroke(v);
    expect(fillOutline(s, 2, 4, square, { value: 1, only: 0 })).toBe(24);
    s.finish();
    expect(v.get(2, 2, 4)).toBe(3);
    expect(v.get(4, 4, 4)).toBe(1);
    expect(v.get(4, 4, 3)).toBe(0);
    expect(v.get(7, 4, 4)).toBe(0);
    // Across x (a sagittal view): (u, w) are (y, z); only where an image's values are in range.
    const image: ImageBlock = { lo: [0, 0, 0], size: [20, 20, 10], data: new Float32Array(4000).map((_, i) => (Math.floor(i / 20) % 20 < 4 ? 100 : 0)) };
    const t = new Stroke(v);
    const n = fillOutline(t, 0, 10, [[1.5, 1.5], [6.5, 1.5], [6.5, 6.5], [1.5, 6.5]], { value: 2, where: inRange(image, 50, 150) });
    expect(n).toBe(2 * 5);
    expect(v.get(10, 2, 3)).toBe(2);
    expect(v.get(10, 5, 3)).toBe(0);
    // Erasing inside an outline: only the active segment.
    const e = new Stroke(v);
    fillOutline(e, 2, 4, square, { value: 0, only: 1 });
    expect(v.get(4, 4, 4)).toBe(0);
    expect(v.get(2, 2, 4)).toBe(3);
  });
});

describe("relabelling", () => {
  it("merges one label into another, and erases one, undoably", () => {
    const v = vol();
    const s = new Stroke(v);
    paintBall(s, [10, 10, 10], ballShape(2, "voxels"), { value: 1 });
    paintBall(s, [80, 70, 60], ballShape(2, "voxels"), { value: 2 });
    s.finish();
    const history = new History();
    const m = new Stroke(v);
    expect(relabel(m, 2, 1)).toBe(33);
    m.finish();
    history.push(m);
    expect(count(v, 1)).toBe(66);
    expect(count(v, 2)).toBe(0);
    const e = new Stroke(v);
    relabel(e, 1, 0);
    e.finish();
    expect(v.chunkCount).toBe(0);
    history.push(e);
    history.undo();
    history.undo();
    expect(count(v, 2)).toBe(33);
  });

  it("puts back what a stroke's hooks hold (a deleted segment's name) with its voxels", () => {
    const v = vol();
    const s = new Stroke(v);
    paintBall(s, [10, 10, 10], ballShape(2, "voxels"), { value: 3 });
    s.finish();
    const labels = new Map([[3, "kept"]]);
    const history = new History();
    const d = new Stroke(v);
    relabel(d, 3, 0);
    d.finish();
    labels.delete(3);
    d.onUndo = () => labels.set(3, "kept");
    d.onRedo = () => labels.delete(3);
    history.push(d);
    history.undo();
    expect([count(v, 3), labels.get(3)]).toEqual([33, "kept"]);
    history.redo();
    expect([count(v, 3), labels.has(3)]).toEqual([0, false]);
  });
});

describe("interpolation between sections", () => {
  it("measures Euclidean distances to the nearest set pixel", () => {
    const seed = new Uint8Array(25);
    seed[12] = 1;
    const d = distance2d(seed, 5, 5);
    expect(d[12]).toBe(0);
    expect(d[0]).toBeCloseTo(Math.SQRT2 * 2);
    expect(d[14]).toBe(2);
    expect(Array.from(distance2d(new Uint8Array(4), 2, 2))).toEqual([Infinity, Infinity, Infinity, Infinity]);
  });

  it("grows a disc of radius 4 in section 2 into one of 8 in section 6, through the sections between", () => {
    const v = vol([40, 40, 10]);
    const s = new Stroke(v);
    paintBall(s, [20, 20, 2], ballShape(4, "voxels"), { value: 5 }, [0, 0, 1]);
    paintBall(s, [20, 20, 6], ballShape(8, "voxels"), { value: 5 }, [0, 0, 1]);
    // Another label in section 4 is left alone when only empty voxels are painted.
    s.set(20, 20, 4, 9);
    s.set(20, 21, 4, 9);
    s.finish();
    const t = new Stroke(v);
    expect(interpolate(t, 5, 2, { lo: [0, 0, 0], hi: [40, 40, 10] }, 0)).toBe(3);
    t.finish();
    const radius = (z: number) => {
      let r = 0;
      while (v.get(20 + r + 1, 20, z) === 5) ++r;
      return r;
    };
    expect(radius(3)).toBe(5);
    expect(radius(5)).toBe(7);
    expect(v.get(20, 20, 4)).toBe(9);
    expect(v.get(21, 20, 4)).toBe(5);
    expect(v.get(20, 20, 1)).toBe(0);
    expect(v.get(20, 20, 7)).toBe(0);
    // Undone, and done over any label: the other label is painted over.
    const h = new History();
    h.push(t);
    h.undo();
    const all = new Stroke(v);
    interpolate(all, 5, 2, { lo: [0, 0, 0], hi: [40, 40, 10] });
    all.finish();
    expect(v.get(20, 21, 4)).toBe(5);
  });
});

describe("undo and redo", () => {
  it("undoes and redoes strokes, and drops chunks a stroke left empty", () => {
    const v = vol();
    const history = new History();
    const a = new Stroke(v);
    paintBall(a, [10, 10, 10], ballShape(2, "voxels"), { value: 1 });
    a.finish();
    history.push(a);
    const b = new Stroke(v);
    paintBall(b, [10, 10, 10], ballShape(4, "voxels"), { value: 2 });
    b.finish();
    history.push(b);
    expect(count(v, 1)).toBe(0);
    history.undo();
    expect(count(v, 1)).toBe(33);
    expect(count(v, 2)).toBe(0);
    history.undo();
    expect(v.chunkCount).toBe(0);
    expect(history.canUndo).toBe(false);
    history.redo();
    history.redo();
    expect(count(v, 2)).toBe(257);
    // An eraser stroke over all of it leaves no chunk behind.
    const e = new Stroke(v);
    paintBall(e, [10, 10, 10], ballShape(6, "voxels"), { value: 0 });
    e.finish();
    expect(v.chunkCount).toBe(0);
    history.push(e);
    history.undo();
    expect(count(v, 2)).toBe(257);
  });

  it("keeps a budget of bytes, the oldest strokes going first", () => {
    const v = vol();
    const history = new History(64 ** 3 * 3);
    for (let i = 0; i < 4; ++i) {
      const s = new Stroke(v);
      s.set(i, 0, 0, i + 1);
      s.finish();
      history.push(s);
    }
    expect(history.undo().length).toBe(1);
    history.undo();
    expect(history.canUndo).toBe(false);
  });

  it("times strokes, and undoes them with the workspace's changes as one history (Ctrl+Z while editing)", () => {
    let clock = 1000;
    const v = vol();
    const history = new History(undefined, () => clock);
    const stroke = (at: number) => {
      const s = new Stroke(v);
      s.set(at, 0, 0, 1);
      s.finish();
      history.push(s);
    };
    // A stroke at 1000, a workspace change at 2000, a stroke at 3000.
    stroke(1);
    clock = 3000;
    stroke(2);
    let workspace: { undo?: number; redo?: number } = { undo: 2000 };
    const undo = () => {
      const which = chooseUndo(history.undoTime, workspace.undo, false);
      if (which === "stroke") history.undo();
      else if (which === "workspace") workspace = { redo: workspace.undo };
      return which;
    };
    const redo = () => {
      const which = chooseUndo(history.redoTime, workspace.redo, true);
      if (which === "stroke") history.redo();
      else if (which === "workspace") workspace = { undo: workspace.redo };
      return which;
    };
    expect([undo(), undo(), undo(), undo()]).toEqual(["stroke", "workspace", "stroke", undefined]);
    expect([redo(), redo(), redo(), redo()]).toEqual(["stroke", "workspace", "stroke", undefined]);
    expect(history.undoTime).toBe(3000);
    // With no stroke, the workspace's; with no workspace step, the stroke's.
    expect(chooseUndo(undefined, 5, false)).toBe("workspace");
    expect(chooseUndo(5, undefined, true)).toBe("stroke");
  });
});

describe("quick select", () => {
  it("finds Otsu's threshold between two classes", () => {
    const values = new Float32Array(1000).map((_, i) => (i < 600 ? 10 + (i % 5) : 90 + (i % 7)));
    const t = otsu(values);
    expect(t).toBeGreaterThan(14);
    expect(t).toBeLessThan(91);
  });

  it("keeps the connected part at the seed", () => {
    const sel = Uint8Array.from([1, 1, 0, 1, 1, 0, 0, 0, 1]);
    expect(Array.from(component(sel, [3, 3, 1], [0, 0, 0]))).toEqual([1, 1, 0, 1, 1, 0, 0, 0, 0]);
    expect(Array.from(component(sel, [3, 3, 1], [2, 1, 0]))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("selects the bright blob a box is drawn around, in its section", async () => {
    const size: Vec3 = [20, 20, 1];
    const data = new Float32Array(400);
    for (let y = 0; y < 20; ++y) for (let x = 0; x < 20; ++x) data[x + 20 * y] = Math.hypot(x - 10, y - 10) < 4 ? 200 : x === 0 ? 220 : 20;
    const mask = await THRESHOLD_SELECT.run({ prompt: { kind: "box", lo: [3, 3, 7], hi: [18, 18, 8] }, image: { lo: [0, 0, 7], size, data }, axis: 2, tolerance: 0.1 }, new AbortController().signal);
    expect(mask.lo).toEqual([0, 0, 7]);
    expect(mask.data[10 + 20 * 10]).toBe(1);
    // The bright column at x = 0 is not joined to it.
    expect(mask.data[0]).toBe(0);
    const n = mask.data.reduce((a, b) => a + b, 0);
    expect(n).toBeGreaterThan(40);
    expect(n).toBeLessThan(60);
  });

  it("previews a mask as its sections: inside, and the outline", () => {
    // A 4 × 3 block in section z = 7 of a mask 6 × 5 × 2 from (10, 20, 6).
    const data = new Uint8Array(6 * 5 * 2);
    for (let y = 1; y < 4; ++y) for (let x = 1; x < 5; ++x) data[x + 6 * (y + 5 * 1)] = 1;
    const mask = { lo: [10, 20, 6] as Vec3, size: [6, 5, 2] as Vec3, data };
    expect(maskCount(mask)).toBe(12);
    expect(maskSection(mask, 2, 6)).toBeUndefined();
    expect(maskSection(mask, 2, 9)).toBeUndefined();
    const s = maskSection(mask, 2, 7)!;
    expect([s.u, s.w, s.width, s.height]).toEqual([0, 1, 6, 5]);
    const rows = [0, 1, 2, 3, 4].map((j) => Array.from(s.data.slice(6 * j, 6 * j + 6)).join(""));
    expect(rows).toEqual(["000000", "022220", "021120", "022220", "000000"]);
    // Across y: x along the image, z down it.
    const t = maskSection(mask, 1, 22)!;
    expect([t.u, t.w, t.width, t.height]).toEqual([0, 2, 6, 2]);
    expect(Array.from(t.data.slice(6))).toEqual([0, 2, 2, 2, 2, 0]);
  });
});

describe("copying labels above 2^24", () => {
  /** A one-level label store of `type` (raw chunks, 4 a side), its first voxels `values` (x fastest). */
  async function store(type: "uint32" | "uint64", values: bigint[]) {
    const files = omeZarrMetadata([{ size: [4, 4, 4], voxelToRas: PLACE }], "uint32", "labels", { label: true, chunk: 4, codecs: [{ name: "bytes", configuration: { endian: "little" } }] });
    const array = JSON.parse(new TextDecoder().decode(files.get("0/zarr.json")!));
    array.data_type = type;
    files.set("0/zarr.json", new TextEncoder().encode(JSON.stringify(array)));
    const chunk = type === "uint64" ? new BigUint64Array(64) : new Uint32Array(64);
    values.forEach((v, i) => (chunk[i] = (type === "uint64" ? v : Number(v)) as never));
    files.set("0/c/0/0/0", new Uint8Array(chunk.buffer));
    const base = `https://example.org/${type}.ome.zarr/`;
    serve((key) => files.get(key), base);
    const reader = new VolumeReader();
    const { levels } = await reader.open([base], undefined);
    return { reader, levels };
  }
  const box = { lo: [0, 0, 0] as Vec3, hi: [4, 1, 1] as Vec3 };
  const big = [2n ** 24n + 1n, 2n ** 31n + 5n, 4294967295n, 0n];

  it("reads 32-bit labels exactly, where 32-bit floats round them", async () => {
    const { reader } = await store("uint32", big);
    const signal = new AbortController().signal;
    expect(Array.from((await reader.exactRegion(0, box, signal)).data)).toEqual(big.map(Number));
    expect((await reader.rawRegion(0, box, signal)).data[0]).toBe(2 ** 24);
  });

  it("reads 64-bit labels narrowed to 32 bits, exactly; past 32 bits, an error", async () => {
    const { reader, levels } = await store("uint64", big);
    expect(levels[0].type).toBe("uint32");
    expect(Array.from((await reader.exactRegion(0, box, new AbortController().signal)).data)).toEqual(big.map(Number));
    const wide = await store("uint64", [1n, 2n ** 32n + 1n]);
    await expect(wide.reader.exactRegion(0, box, new AbortController().signal)).rejects.toThrow(/past what 32 bits hold/);
  });

  it("puts them into a 32-bit volume as they are, and refuses what is not a label", () => {
    const v = vol([4, 4, 4], "uint32");
    v.addBlock([0, 0, 0], [4, 1, 1], Float64Array.from(big.map(Number)));
    expect([0, 1, 2, 3].map((x) => v.get(x, 0, 0))).toEqual(big.map(Number));
    expect(badLabel(Float64Array.from([0, 2 ** 24 + 1, NaN, 4294967295]), 4294967295)).toBeUndefined();
    expect(badLabel([3, 300], 255)).toBe(300);
    expect(badLabel([1, -2], 255)).toBe(-2);
    expect(badLabel([1, 2.5], 255)).toBe(2.5);
  });
});

describe("saving", () => {
  it("writes a NIfTI the platform's reader reads back, in place", async () => {
    const v = vol([30, 20, 10], "uint16");
    const s = new Stroke(v);
    s.set(3, 4, 5, 1000);
    s.set(29, 19, 9, 7);
    s.finish();
    const gz = await niftiGz(v, "test");
    expect([gz[0], gz[1]]).toEqual([0x1f, 0x8b]);
    const store = await openNifti(new Blob([gz as BlobPart]), "labels.nii.gz");
    serve((key) => store.get(key), "http://nii.test/");
    const reader = new VolumeReader();
    const { levels } = await reader.open(["http://nii.test/"], undefined);
    expect(levels[0].size).toEqual([30, 20, 10]);
    Array.from(levels[0].voxelToRas).forEach((m, i) => expect(m).toBeCloseTo(PLACE[i], 4));
    const { data } = await reader.rawRegion(0, { lo: [0, 0, 0], hi: [30, 20, 10] }, new AbortController().signal);
    expect(data[3 + 30 * (4 + 20 * 5)]).toBe(1000);
    expect(data[29 + 30 * (19 + 20 * 9)]).toBe(7);
    expect(data.reduce((n, x) => n + (x !== 0 ? 1 : 0), 0)).toBe(2);
  });

  it("cuts the painted box, moving the origin to its corner", () => {
    const v = vol();
    const s = new Stroke(v);
    s.set(40, 50, 60, 3);
    s.set(42, 51, 60, 3);
    s.finish();
    const box = v.paintedBox()!;
    const c = cropped(v, box);
    expect(c.size).toEqual([3, 2, 1]);
    expect(c.get(0, 0, 0)).toBe(3);
    expect(c.get(2, 1, 0)).toBe(3);
    expect(c.voxelToRas[3]).toBeCloseTo(-10 + 40 * 0.5);
    expect(c.voxelToRas[11]).toBeCloseTo(5 + 60 * 0.5);
  });

  it("writes an OME-Zarr of only the painted chunks, which reads back", async () => {
    const v = vol([300, 200, 100]);
    const s = new Stroke(v);
    s.set(250, 150, 90, 4);
    s.finish();
    const files = await omeZarr(v, undefined, undefined, [{ value: 4, name: "Soma", colour: "#ff8000", group: "Neurons" }]);
    const group = JSON.parse(new TextDecoder().decode(files.get("zarr.json")));
    expect(group.attributes.ome["image-label"]).toEqual({ colors: [{ "label-value": 4, rgba: [255, 128, 0, 255] }], properties: [{ "label-value": 4, name: "Soma", group: "Neurons" }] });
    const chunks = [...files.keys()].filter((k) => k.includes("/c/"));
    // Four levels: 300 voxels halved to 38, under a chunk's side.
    expect(chunks).toEqual(["0/c/1/2/3", "1/c/0/1/1", "2/c/0/0/0", "3/c/0/0/0"]);
    serve((key) => files.get(key), "http://zarr.test/");
    const reader = new VolumeReader();
    const { levels } = await reader.open(["http://zarr.test/"], undefined);
    const values = await reader.rawPoints(0, Float64Array.from([250, 150, 90, 249, 150, 90]), "nearest", new AbortController().signal);
    expect(Array.from(values)).toEqual([4, 0]);
    expect(levels.length).toBe(4);
  });

  it("saves again into the same folder without bringing erased labels back", async () => {
    const v = vol([300, 200, 100]);
    let s = new Stroke(v);
    s.set(250, 150, 90, 4);
    s.set(10, 10, 10, 5);
    s.finish();
    const root = new MemoryFolder();
    await root.file("notes.txt", new Uint8Array([1]));
    await writeStore(root.handle, await omeZarr(v));
    expect(root.paths()).toContain("0/c/0/0/0");
    // Label 5 erased: its chunk is now empty, so the second save does not write it.
    s = new Stroke(v);
    s.set(10, 10, 10, 0);
    s.finish();
    const files = await omeZarr(v);
    expect(files.has("0/c/0/0/0")).toBe(false);
    await writeStore(root.handle, files);
    // The folder holds exactly this save, and the file that is not the store's.
    expect(root.paths().sort()).toEqual([...files.keys(), "notes.txt"].sort());
    const saved = new Map(root.paths().map((p) => [p, root.get(p)!]));
    serve((key) => saved.get(key), "http://again.test/");
    const reader = new VolumeReader();
    await reader.open(["http://again.test/"], undefined);
    const values = await reader.rawPoints(0, Float64Array.from([250, 150, 90, 10, 10, 10]), "nearest", new AbortController().signal);
    expect(Array.from(values)).toEqual([4, 0]);
  });

  it("removes a store's old chunks and levels, and keeps other files", async () => {
    const root = new MemoryFolder();
    for (const p of ["zarr.json", "0/zarr.json", "0/c/0/0/0", "0/c/0/0/1", "0/c/1/0/0", "4/zarr.json", "4/c/0/0/0", "notes/a.txt", "readme.md"]) await root.file(p, new Uint8Array([1]));
    const removed = await pruneStore(root.handle, ["zarr.json", "0/zarr.json", "0/c/0/0/1"]);
    expect(root.paths().sort()).toEqual(["0/c/0/0/1", "0/zarr.json", "notes/a.txt", "readme.md", "zarr.json"]);
    // 0/c/0/0/0, the folder 0/c/1 and the level 4.
    expect(removed).toBe(3);
  });
});
