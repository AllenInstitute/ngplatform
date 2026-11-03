/**
 * The time series plugin without the page: a 4-D NIfTI read in place
 * (tests/fixtures/tiny.nii.gz, made by generate.py with nibabel) read as
 * time courses; global positions to voxels and time points through a
 * layer's transform; regions; stepping; colours; CSV; the plot's numbers.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerTransform } from "@ngplatform/sdk";
import { openNifti } from "../../../src/virtual/images/nifti.js";
import { linePath, ticks, valueRange } from "../plot.js";
import { ChunkCache, type SeriesInfo, SeriesReader, timeAxisOf } from "../reader.js";
import { inside, regionVoxels, shapeOf } from "../region.js";
import { coordinateOf, formatTime, freeColour, indexAt, nextIndex, percentChange, seriesCsv, stepIndex, type TimeAxis, timeAxis, timesOf, voxelAt, voxelLabel } from "../series.js";
import { type GlobalSpace, invert, LayerMap, placeOf } from "../space.js";

const FIXTURE = path.join(__dirname, "fixtures", "tiny.nii.gz");
/** The fixture's value at voxel (x, y, z), time point t. */
const value = (x: number, y: number, z: number, t: number) => x + 10 * y + 100 * z + 1000 * t;

afterEach(() => vi.unstubAllGlobals());

describe("reading time courses", () => {
  let reader: SeriesReader;
  let info: SeriesInfo;

  beforeEach(async () => {
    const store = await openNifti(new Blob([fs.readFileSync(FIXTURE)]), "tiny");
    vi.stubGlobal("fetch", async (url: string) => {
      const data = await store.get(String(url).replace("http://nifti.test/", ""));
      return data === undefined ? new Response(null, { status: 404 }) : new Response(data as BodyInit);
    });
    reader = new SeriesReader(new ChunkCache(1 << 20));
    info = await reader.open("http://nifti.test/");
  });

  it("finds the time axis, its unit and the shape in the metadata's order", () => {
    expect(info.axes).toEqual(["t", "x", "y", "z"]);
    expect(info.shape).toEqual([12, 6, 5, 4]);
    expect(info.timeAxis).toBe(0);
    expect(info.timeUnit).toBe("second");
  });

  it("reads one voxel's values at every time point", async () => {
    const values = await reader.mean(Int32Array.from([0, 3, 2, 1]), new AbortController().signal);
    expect(Array.from(values)).toEqual(Array.from({ length: 12 }, (_, t) => value(3, 2, 1, t)));
  });

  it("averages several voxels, leaving out those outside the image", async () => {
    const progress: number[] = [];
    const values = await reader.mean(Int32Array.from([0, 0, 0, 0, 0, 5, 4, 3, 0, 9, 0, 0]), new AbortController().signal, (done, total) => progress.push(done / total));
    expect(Array.from(values)).toEqual(Array.from({ length: 12 }, (_, t) => (value(0, 0, 0, t) + value(5, 4, 3, t)) / 2));
    expect(progress[progress.length - 1]).toBe(1);
    const outside = await reader.mean(Int32Array.from([0, 6, 0, 0]), new AbortController().signal);
    expect(Array.from(outside).every(Number.isNaN)).toBe(true);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(reader.mean(Int32Array.from([0, 1, 1, 1]), controller.signal)).rejects.toThrow();
  });

  it("reads OME-Zarr 0.4 (Zarr v2) with several time points to a chunk, partly filled", async () => {
    // Axes t, z, y, x; shape 10 × 3 × 4 × 5, chunks 4 × 2 × 3 × 3; value 1000 t + 100 z + 10 y + x.
    const shape = [10, 3, 4, 5];
    const chunks = [4, 2, 3, 3];
    const files = new Map<string, Uint8Array | string>();
    files.set(
      ".zattrs",
      JSON.stringify({
        multiscales: [
          {
            version: "0.4",
            name: "v2",
            axes: [{ name: "t", type: "time", unit: "millisecond" }, { name: "z", type: "space" }, { name: "y", type: "space" }, { name: "x", type: "space" }],
            datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [250, 1, 1, 1] }] }],
          },
        ],
      }),
    );
    files.set("0/.zarray", JSON.stringify({ zarr_format: 2, shape, chunks, dtype: "<f4", compressor: null, fill_value: 0, order: "C", filters: null }));
    const grid = shape.map((s, d) => Math.ceil(s / chunks[d]));
    for (let a = 0; a < grid[0]; ++a)
      for (let b = 0; b < grid[1]; ++b)
        for (let c = 0; c < grid[2]; ++c)
          for (let d = 0; d < grid[3]; ++d) {
            const data = new Float32Array(chunks[0] * chunks[1] * chunks[2] * chunks[3]);
            let i = 0;
            for (let t = 0; t < chunks[0]; ++t) for (let z = 0; z < chunks[1]; ++z) for (let y = 0; y < chunks[2]; ++y) for (let x = 0; x < chunks[3]; ++x) data[i++] = 1000 * (a * 4 + t) + 100 * (b * 2 + z) + 10 * (c * 3 + y) + (d * 3 + x);
            files.set(`0/${a}.${b}.${c}.${d}`, new Uint8Array(data.buffer));
          }
    vi.stubGlobal("fetch", async (url: string) => {
      const data = files.get(String(url).replace("http://v2.test/", ""));
      return data === undefined ? new Response(null, { status: 404 }) : new Response(data as BodyInit);
    });
    const v2 = new SeriesReader();
    const opened = await v2.open("http://v2.test/");
    expect(opened.axes).toEqual(["t", "z", "y", "x"]);
    expect(opened.timeUnit).toBe("millisecond");
    // Voxel x 4, y 3, z 2: in the last, partial chunk along each axis.
    const values = await v2.mean(Int32Array.from([0, 2, 3, 4]), new AbortController().signal);
    expect(Array.from(values)).toEqual(Array.from({ length: 10 }, (_, t) => 1000 * t + 234));
  });

  it("names the time axis by type, else by name", () => {
    expect(timeAxisOf([{ name: "z" }, { name: "time", type: "time" }])).toBe(1);
    expect(timeAxisOf([{ name: "t" }, { name: "x" }])).toBe(0);
    expect(timeAxisOf([{ name: "x" }, { name: "y" }])).toBe(-1);
  });
});

/** Column-major homogeneous matrix from rows (n × (n + 1)). */
function columnMajor(rows: number[][]): Float64Array {
  const n = rows.length;
  const m = new Float64Array((n + 1) * (n + 1));
  for (let r = 0; r < n; ++r) for (let c = 0; c <= n; ++c) m[(n + 1) * c + r] = rows[r][c];
  m[(n + 1) * (n + 1) - 1] = 1;
  return m;
}

/** The fixture as Neuroglancer shows it: source t, x, y, z (1.5 s, 2, 2, 3 mm); global x, y, z in mm and t in steps of 1.5 s. */
const SPACE: GlobalSpace = { names: ["x", "y", "z", "t"], scales: [1e-3, 1e-3, 1e-3, 1.5], units: ["m", "m", "m", "s"] };
function imageTransform(rows?: number[][]): LayerTransform {
  const matrix = columnMajor(rows ?? [
    [1, 0, 0, 0, 0],
    [0, 1, 0, 0, -6],
    [0, 0, 1, 0, -4],
    [0, 0, 0, 1, 1],
  ]);
  return {
    rank: 4,
    input: { names: ["t", "x", "y", "z"], scales: [1.5, 2e-3, 2e-3, 3e-3], units: ["s", "m", "m", "m"], bounds: { lower: [-0.5, -0.5, -0.5, -0.5], upper: [11.5, 5.5, 4.5, 3.5] } },
    output: { names: ["t", "x", "y", "z"], scales: [1.5, 1e-3, 1e-3, 1e-3], units: ["s", "m", "m", "m"] },
    matrix,
    defaultMatrix: matrix,
  };
}
const INFO: SeriesInfo = { url: "http://nifti.test/", path: "0", name: "tiny", axes: ["t", "x", "y", "z"], shape: [12, 6, 5, 4], timeAxis: 0, timeUnit: "second", type: "int16" };

describe("positions, voxels and time points", () => {
  const map = new LayerMap(imageTransform(), SPACE);

  it("maps source coordinates to global ones and back", () => {
    // Voxel (2, 3, 1) at time point 4: x 2·2 − 6 mm, y 3·2 − 4 mm, z 1·3 + 1 mm.
    const g = map.toGlobal([4, 2, 3, 1]);
    expect(g).toEqual([-2, 2, 4, 4]);
    expect(map.toInput(g)!.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([4, 2, 3, 1]);
  });

  it("finds the voxel under a position, and none outside", () => {
    expect(voxelAt(map, INFO, [-2.4, 2.9, 4.6, 7])).toEqual([0, 2, 3, 1]);
    expect(voxelAt(map, INFO, [-20, 2, 4, 0])).toBeUndefined();
    expect(voxelLabel(INFO, [0, 2, 3, 1])).toBe("x 2, y 3, z 1");
  });

  it("finds the time axis: its global dimension, start, step and unit", () => {
    const axis = timeAxis(map, INFO, [0, 0, 0, 0]) as TimeAxis;
    expect(axis.dim).toBe(3);
    expect(axis.count).toBe(12);
    expect(axis.start).toBeCloseTo(0);
    expect(axis.step).toBeCloseTo(1.5);
    expect(axis.unit.label).toBe("s");
    expect(Array.from(timesOf(axis)).slice(0, 3)).toEqual([0, 1.5, 3]);
    // Milliseconds: the same seconds, shown in ms.
    const ms = timeAxis(map, { ...INFO, timeUnit: "millisecond" }, [0, 0, 0, 0]) as TimeAxis;
    expect(ms.step).toBeCloseTo(1500);
    expect(ms.unit.label).toBe("ms");
  });

  it("finds the time point shown, and the coordinate that shows one", () => {
    const axis = timeAxis(map, INFO, [0, 0, 0, 0]) as TimeAxis;
    // Neuroglancer's first position is the middle of the bounds, between two time points: the later one shows.
    expect(indexAt(map, axis, [0, 0, 0, 5.5])).toBe(6);
    expect(indexAt(map, axis, [0, 0, 0, 5.4])).toBe(5);
    expect(indexAt(map, axis, [0, 0, 0, -3])).toBe(0);
    expect(indexAt(map, axis, [0, 0, 0, 99])).toBe(11);
    expect(coordinateOf(map, axis, [1, 2, 3, 5.5], 7)).toBeCloseTo(7);
  });

  it("reads time with an offset and a layer moved in space", () => {
    // Time starts at 3 s (2 steps of 1.5 s); the layer is turned 90° about z.
    const turned = new LayerMap(
      imageTransform([
        [1, 0, 0, 0, 2],
        [0, 0, -1, 0, 0],
        [0, 1, 0, 0, 0],
        [0, 0, 0, 1, 0],
      ]),
      SPACE,
    );
    const axis = timeAxis(turned, INFO, [0, 0, 0, 0]) as TimeAxis;
    expect(axis.start).toBeCloseTo(3);
    expect(indexAt(turned, axis, [0, 0, 0, 2])).toBe(0);
    // Voxel (x 1, y 2): x −2·2 mm, y 1·2 mm.
    expect(voxelAt(turned, INFO, [-4, 2, 0, 2])).toEqual([0, 1, 2, 0]);
  });

  it("reads time from the layer's local position when it is a local dimension (t')", () => {
    const t = imageTransform();
    const transform = { ...t, output: { ...t.output, names: ["t'", "x", "y", "z"] } };
    // Without the layer's local dimensions, time is not shown.
    expect(typeof timeAxis(new LayerMap(transform, SPACE), INFO, [0, 0, 0, 0])).toBe("string");
    const ng = { dimensions: { x: [1e-3, "m"], y: [1e-3, "m"], z: [1e-3, "m"] }, position: [-2.4, 2.9, 4.6] };
    const place = placeOf(ng, { names: ["t'"], scales: [1.5], units: ["s"], position: [5.5] });
    expect(place.space.names).toEqual(["x", "y", "z", "t'"]);
    expect(place.globalRank).toBe(3);
    expect(place.position).toEqual([-2.4, 2.9, 4.6, 5.5]);
    const map = new LayerMap(transform, place.space);
    const axis = timeAxis(map, INFO, place.position) as TimeAxis;
    expect(axis.dim).toBe(3);
    expect(axis.unit.label).toBe("s");
    expect(axis.step).toBeCloseTo(1.5);
    expect(indexAt(map, axis, place.position)).toBe(6);
    expect(coordinateOf(map, axis, place.position, 2)).toBeCloseTo(2);
    expect(voxelAt(map, INFO, place.position)).toEqual([0, 2, 3, 1]);
    // A state with no local dimensions is the global space alone.
    expect(placeOf(ng).space.names).toEqual(["x", "y", "z"]);
  });

  it("inverts matrices, and finds none for a singular one", () => {
    const m = [
      [2, 1, 0],
      [0, 1, 0],
      [1, 0, 4],
    ];
    const inv = invert(m)!;
    const product = m.map((row) => inv[0].map((_, c) => row.reduce((s, v, k) => s + v * inv[k][c], 0)));
    product.forEach((row, r) => row.forEach((v, c) => expect(v).toBeCloseTo(r === c ? 1 : 0)));
    expect(
      invert([
        [1, 2],
        [2, 4],
      ]),
    ).toBeUndefined();
  });
});

describe("regions", () => {
  const image = new LayerMap(imageTransform(), SPACE);
  // An annotation layer in millimetres, x, y, z (and t, as one drawn in a 4-D scene is).
  const annotationTransform: LayerTransform = {
    rank: 4,
    input: { names: ["x", "y", "z", "t"], scales: [1e-3, 1e-3, 1e-3, 1.5], units: ["m", "m", "m", "s"] },
    output: { names: ["x", "y", "z", "t"], scales: [1e-3, 1e-3, 1e-3, 1.5], units: ["m", "m", "m", "s"] },
    matrix: columnMajor([
      [1, 0, 0, 0, 0],
      [0, 1, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 1, 0],
    ]),
    defaultMatrix: new Float64Array(25),
  };
  const annotation = new LayerMap(annotationTransform, SPACE);

  it("reads boxes and ellipsoids, not other annotations", () => {
    expect(shapeOf({ type: "axis_aligned_bounding_box", id: "a", pointA: [0, 0, 0], pointB: [1, 1, 1] })?.type).toBe("box");
    expect(shapeOf({ type: "ellipsoid", id: "b", center: [0, 0, 0], radii: [1, 1, 1] })?.type).toBe("ellipsoid");
    expect(shapeOf({ type: "point", id: "c" })).toBeUndefined();
    expect(inside({ type: "ellipsoid", center: [0, 0, 0], radii: [2, 1, 0] }, [1, 0.5, 0.2], [0, 1, 2])).toBe(true);
    expect(inside({ type: "ellipsoid", center: [0, 0, 0], radii: [2, 1, 0] }, [1.8, 0.8, 0], [0, 1, 2])).toBe(false);
  });

  it("finds the voxels whose centres are inside a box, whatever its time extent", () => {
    // x −6..−2 mm holds voxel centres x 0, 1, 2; y −4..−2 holds y 0, 1; z 1..4 holds z 0, 1.
    const box = { type: "box" as const, a: [-6, -4, 1, 0], b: [-2, -2, 4, 0] };
    const { voxels, count } = regionVoxels(box, annotation, image, INFO, [0, 0, 0, 5]);
    expect(count).toBe(12);
    const xs = new Set<number>();
    for (let v = 0; v < count; ++v) {
      expect(voxels[4 * v]).toBe(0);
      xs.add(voxels[4 * v + 1]);
    }
    expect([...xs].sort()).toEqual([0, 1, 2]);
  });

  it("finds the voxels inside an ellipsoid", () => {
    // Centred on voxel (2, 2, 1), reaching one voxel along x and y, flat in z.
    const ellipsoid = { type: "ellipsoid" as const, center: [-2, 0, 4, 0], radii: [2.1, 2.1, 0, 0] };
    const { voxels, count } = regionVoxels(ellipsoid, annotation, image, INFO, [0, 0, 0, 5]);
    expect(count).toBe(5);
    const found = Array.from({ length: count }, (_, v) => Array.from(voxels.slice(4 * v + 1, 4 * v + 4)).join(","));
    expect(found.sort()).toEqual(["1,2,1", "2,1,1", "2,2,1", "2,3,1", "3,2,1"]);
  });

  it("refuses a region past the limit", () => {
    const box = { type: "box" as const, a: [-100, -100, -100, 0], b: [100, 100, 100, 0] };
    expect(() => regionVoxels(box, annotation, image, INFO, [0, 0, 0, 0], 10)).toThrow(/voxels/);
  });
});

describe("stepping, colours and CSV", () => {
  it("steps and plays through time", () => {
    expect(nextIndex(3, 10, false)).toBe(4);
    expect(nextIndex(9, 10, false)).toBeUndefined();
    expect(nextIndex(9, 10, true)).toBe(0);
    expect(stepIndex(0, -1, 10)).toBe(0);
    expect(stepIndex(8, 5, 10)).toBe(9);
    expect(stepIndex(4, 1, 10)).toBe(5);
  });

  it("gives each pin the first colour free, and none past the last", () => {
    expect(freeColour([])).toBe(0);
    expect(freeColour([0, 1, 3])).toBe(2);
    expect(freeColour([0, 1, 2, 3, 4, 5, 6, 7])).toBeUndefined();
  });

  it("writes times in their unit", () => {
    expect(formatTime(34, "s")).toBe("34 s");
    expect(formatTime(1.25, "s")).toBe("1.25 s");
    expect(formatTime(1234.5678, "ms")).toBe("1235 ms");
    expect(formatTime(17, "")).toBe("17");
  });

  it("gives a series as its change from its mean, in percent", () => {
    expect(Array.from(percentChange([90, 110, NaN, 100]))).toEqual([-10, 10, NaN, 0]);
    expect(Array.from(percentChange([0, 0])).every(Number.isNaN)).toBe(true);
  });

  it("writes the series as CSV: a row per time point, a column per series", () => {
    const axis = { count: 3, start: 0, step: 2, unit: { label: "s", seconds: 1 } };
    const csv = seriesCsv(axis, [
      { label: "x 1, y 2, z 3", values: [1, 2.5, NaN] },
      { label: 'box "a"', values: Float32Array.from([0.1, 0.2, 0.3]) },
    ]);
    expect(csv).toBe('time point,time (s),"x 1, y 2, z 3","box ""a"""\n0,0,1,0.1\n1,2,2.5,0.2\n2,4,,0.3\n');
  });
});

describe("the plot's numbers", () => {
  it("chooses round ticks", () => {
    expect(ticks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(ticks(95.3, 114.2, 4)).toEqual([100, 105, 110]);
    expect(ticks(3, 3)).toEqual([3]);
  });

  it("spans every series' finite values", () => {
    expect(valueRange([[1, 2, NaN], [3]])).toEqual([0.9, 3.1]);
    expect(valueRange([[5, 5]])).toEqual([4, 6]);
    expect(valueRange([[NaN]])).toEqual([0, 1]);
  });

  it("breaks a line where values are missing", () => {
    const d = linePath([0, 1, 2, 3], [1, NaN, 2, 3], (x) => x * 10, (y) => y);
    expect(d).toBe("M0.0,1.0M20.0,2.0L30.0,3.0");
  });
});
