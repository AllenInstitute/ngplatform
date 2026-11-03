/**
 * NIfTI read as virtual Zarr: headers (NIfTI-1 and -2, both byte orders),
 * the affine (sform, qform, voxel sizes), every chunk of level 0 against
 * the file's voxels, a coarser level against the mean of the finer one,
 * .nii.gz, 4-D images, and the metadata as Neuroglancer and the volume
 * view read it.
 */
import { parseOmeMetadata } from "neuroglancer/unstable/datasource/zarr/ome.js";
import { describe, expect, it } from "vitest";
import { apply, parseOmeLevels } from "../plugins/volume-view/ome.js";
import { readFileSync } from "node:fs";
import { mghVoxelToRas, openMgh, parseMghHeader } from "../src/virtual/images/mgh.js";
import { splitVirtual } from "../src/virtual/local_data.js";
import { NiftiStore, nearestAxes, niftiAffine, openNifti, parseNiftiHeader } from "../src/virtual/images/nifti.js";
import { answer, blobSource, pairAsSingleFile } from "../src/virtual/images/store.js";
import { logEuclideanMean } from "../src/virtual/images/tensors.js";

interface Spec {
  version?: 1 | 2;
  littleEndian?: boolean;
  dim: number[];
  datatype?: number;
  pixdim?: number[];
  sform?: number[][];
  qform?: { quatern: number[]; offset: number[]; qfac?: number };
  slope?: number;
  inter?: number;
  intent?: number;
  units?: number;
  /** The value of the voxel at a flat index in file order. */
  value: (index: number) => number;
}

const TYPES: Record<number, { bytes: number; set: (v: DataView, o: number, x: number, le: boolean) => void }> = {
  2: { bytes: 1, set: (v, o, x) => v.setUint8(o, x) },
  4: { bytes: 2, set: (v, o, x, le) => v.setInt16(o, x, le) },
  16: { bytes: 4, set: (v, o, x, le) => v.setFloat32(o, x, le) },
  64: { bytes: 8, set: (v, o, x, le) => v.setFloat64(o, x, le) },
  512: { bytes: 2, set: (v, o, x, le) => v.setUint16(o, x, le) },
};

/** A NIfTI file in memory. */
function nifti(spec: Spec): Uint8Array {
  const version = spec.version ?? 1;
  const le = spec.littleEndian ?? true;
  const datatype = spec.datatype ?? 4;
  const type = TYPES[datatype];
  const rank = spec.dim.length;
  const count = spec.dim.reduce((a, b) => a * b, 1);
  const offset = version === 1 ? 352 : 544;
  const bytes = new Uint8Array(offset + count * type.bytes);
  const v = new DataView(bytes.buffer);
  const pixdim = [spec.qform?.qfac ?? 1, ...(spec.pixdim ?? spec.dim.map(() => 1))];
  const ascii = (at: number, s: string) => [...s].forEach((c, k) => (bytes[at + k] = c.charCodeAt(0)));
  if (version === 1) {
    v.setInt32(0, 348, le);
    v.setInt16(40, rank, le);
    spec.dim.forEach((d, k) => v.setInt16(42 + 2 * k, d, le));
    v.setInt16(68, spec.intent ?? 0, le);
    v.setInt16(70, datatype, le);
    v.setInt16(72, type.bytes * 8, le);
    pixdim.forEach((p, k) => v.setFloat32(76 + 4 * k, p, le));
    v.setFloat32(108, offset, le);
    v.setFloat32(112, spec.slope ?? 0, le);
    v.setFloat32(116, spec.inter ?? 0, le);
    bytes[123] = spec.units ?? 2;
    ascii(148, "test image");
    if (spec.qform) {
      v.setInt16(252, 1, le);
      spec.qform.quatern.forEach((q, k) => v.setFloat32(256 + 4 * k, q, le));
      spec.qform.offset.forEach((q, k) => v.setFloat32(268 + 4 * k, q, le));
    }
    if (spec.sform) {
      v.setInt16(254, 4, le);
      spec.sform.forEach((row, r) => row.forEach((x, c) => v.setFloat32(280 + 16 * r + 4 * c, x, le)));
    }
    ascii(344, "n+1");
  } else {
    v.setInt32(0, 540, le);
    ascii(4, "n+2\0\r\n\x1a\n");
    v.setInt16(12, datatype, le);
    v.setInt16(14, type.bytes * 8, le);
    v.setBigInt64(16, BigInt(rank), le);
    spec.dim.forEach((d, k) => v.setBigInt64(24 + 8 * k, BigInt(d), le));
    pixdim.forEach((p, k) => v.setFloat64(104 + 8 * k, p, le));
    v.setBigInt64(168, BigInt(offset), le);
    v.setFloat64(176, spec.slope ?? 0, le);
    v.setFloat64(184, spec.inter ?? 0, le);
    if (spec.sform) {
      v.setInt32(348, 4, le);
      spec.sform.forEach((row, r) => row.forEach((x, c) => v.setFloat64(400 + 32 * r + 8 * c, x, le)));
    }
    v.setInt32(500, spec.units ?? 2, le);
    v.setInt32(504, spec.intent ?? 0, le);
  }
  for (let i = 0; i < count; ++i) type.set(v, offset + i * type.bytes, spec.value(i), le);
  return bytes;
}

function store(bytes: Uint8Array): Promise<NiftiStore> {
  return openNifti(new Blob([bytes]), "test");
}

async function json(s: NiftiStore, key: string): Promise<any> {
  return JSON.parse(new TextDecoder().decode((await s.get(key))!));
}

const VIEWS: Record<string, (b: ArrayBuffer) => ArrayLike<number>> = {
  uint8: (b) => new Uint8Array(b),
  int16: (b) => new Int16Array(b),
  uint16: (b) => new Uint16Array(b),
  int32: (b) => new Int32Array(b),
  uint32: (b) => new Uint32Array(b),
  float32: (b) => new Float32Array(b),
};

/** Every voxel of a level, read chunk by chunk through the store's keys (stored in the transpose codec's order). */
async function readLevel(s: NiftiStore, level: number): Promise<{ at: (i: number, j: number, k: number, t?: number) => number; size: number[] }> {
  const meta = await json(s, `${level}/zarr.json`);
  const shape: number[] = meta.shape;
  const chunk: number[] = meta.chunk_grid.configuration.chunk_shape;
  const view = VIEWS[meta.data_type];
  // The stored axes, slowest first, as logical axes.
  const order: number[] = meta.codecs.find((c: any) => c.name === "transpose")?.configuration.order ?? shape.map((_, d) => d);
  const grid = shape.map((n, d) => Math.ceil(n / chunk[d]));
  const values = new Float64Array(shape.reduce((a, b) => a * b, 1)).fill(NaN);
  let padding = 0;
  const visit = async (index: number[]) => {
    const bytes = (await s.get(`${level}/c/${index.join("/")}`))!;
    const data = view(bytes.slice().buffer);
    expect(data.length).toBe(chunk.reduce((a, b) => a * b, 1));
    const local = chunk.map(() => 0);
    for (let flat = 0; flat < data.length; ++flat) {
      let inside = true;
      let at = 0;
      for (let d = 0; d < chunk.length; ++d) {
        const g = index[d] * chunk[d] + local[d];
        if (g >= shape[d]) inside = false;
        at = at * shape[d] + g;
      }
      if (inside) values[at] = data[flat];
      else if (data[flat] !== 0) padding++;
      // The next element in stored order: the last stored axis fastest.
      for (let s = order.length - 1; s >= 0; --s) {
        const d = order[s];
        if (++local[d] < chunk[d]) break;
        local[d] = 0;
      }
    }
  };
  const all: number[][] = [[]];
  for (const g of grid) all.splice(0, all.length, ...all.flatMap((p) => Array.from({ length: g }, (_, k) => [...p, k])));
  for (const index of all) await visit(index);
  expect(padding).toBe(0);
  expect(values.some(Number.isNaN)).toBe(false);
  const extra = shape.length === 4;
  return {
    at: (i, j, k, t = 0) => values[(extra ? [t, i, j, k] : [i, j, k]).reduce((a, v, d) => a * shape[d] + v, 0)],
    size: shape,
  };
}

/** Voxel values: a different number at each index, within int16. */
const value = (n: number) => (n * 7) % 30011;

const RAS = [
  [0.8, 0, 0, -40],
  [0, 0.9, 0, -50],
  [0, 0, 1.2, -30],
];

describe("NIfTI headers", () => {
  it("reads NIfTI-1 in both byte orders and NIfTI-2", () => {
    for (const [version, littleEndian] of [[1, true], [1, false], [2, true], [2, false]] as const) {
      const h = parseNiftiHeader(nifti({ version, littleEndian, dim: [5, 4, 3], datatype: 512, pixdim: [0.8, 0.9, 1.2], sform: RAS, value: (i) => i }));
      expect(h.version).toBe(version);
      expect(h.littleEndian).toBe(littleEndian);
      expect(h.dim.slice(0, 4)).toEqual([3, 5, 4, 3]);
      expect(h.datatype).toBe(512);
      expect(h.voxOffset).toBe(version === 1 ? 352 : 544);
      expect(h.sformCode).toBe(4);
      expect(h.srow[1][3]).toBeCloseTo(-50);
      expect(h.magic).toBe(version === 1 ? "n+1" : "n+2");
    }
  });

  it("takes the sform, else the qform, else the voxel sizes", () => {
    const sform = niftiAffine(parseNiftiHeader(nifti({ dim: [2, 2, 2], sform: RAS, value: () => 0 })));
    expect(sform).toMatchObject({ from: "sform", space: "mni152" });
    sform.matrix.forEach((row, r) => row.forEach((x, c) => expect(x).toBeCloseTo(RAS[r][c], 6)));
    // 90° about z (d = sin 45°), qfac -1 flips k.
    const s = Math.SQRT1_2;
    const q = niftiAffine(parseNiftiHeader(nifti({ dim: [2, 2, 2], pixdim: [2, 3, 4], qform: { quatern: [0, 0, s], offset: [1, 2, 3], qfac: -1 }, value: () => 0 })));
    expect(q.from).toBe("qform");
    expect(q.space).toBe("scanner");
    const expected = [
      [0, -3, 0, 1],
      [2, 0, 0, 2],
      [0, 0, -4, 3],
    ];
    q.matrix.forEach((row, r) => row.forEach((x, c) => expect(x).toBeCloseTo(expected[r][c], 6)));
    expect(niftiAffine(parseNiftiHeader(nifti({ dim: [2, 2, 2], pixdim: [2, 3, 4], value: () => 0 })))).toMatchObject({ from: "pixdim", matrix: [[2, 0, 0, 0], [0, 3, 0, 0], [0, 0, 4, 0]] });
  });

  it("names each voxel axis for the world axis nearest it", () => {
    expect(nearestAxes(RAS)).toEqual([0, 1, 2]);
    // Sagittal: i runs posterior, j up, k right.
    expect(nearestAxes([[0, 0.1, 1, 0], [-1, 0, 0, 0], [0.05, 1, 0, 0]])).toEqual([1, 2, 0]);
  });
});

describe("NIfTI as Zarr", () => {
  const dim = [70, 66, 65];

  it("serves OME-Zarr 0.6 metadata with the affine and a pyramid", async () => {
    const s = await store(nifti({ dim, pixdim: [0.8, 0.9, 1.2], sform: RAS, value }));
    const group = await json(s, "zarr.json");
    expect(group).toMatchObject({ zarr_format: 3, node_type: "group" });
    const ms = group.attributes.ome.multiscales[0];
    expect(group.attributes.ome.version).toBe("0.6");
    expect(ms.coordinateSystems).toEqual([
      {
        name: "mni152",
        axes: [
          { name: "x", type: "space", unit: "millimeter" },
          { name: "y", type: "space", unit: "millimeter" },
          { name: "z", type: "space", unit: "millimeter" },
        ],
      },
      { name: "array", axes: [{ name: "x", type: "space" }, { name: "y", type: "space" }, { name: "z", type: "space" }] },
    ]);
    expect(ms.datasets).toEqual([
      { path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1], input: "0", output: "array" }] },
      {
        path: "1",
        coordinateTransformations: [
          {
            type: "sequence",
            input: "1",
            output: "array",
            transformations: [
              { type: "scale", scale: [2, 2, 2] },
              { type: "translation", translation: [0.5, 0.5, 0.5] },
            ],
          },
        ],
      },
    ]);
    // Rows x, y, z; columns the array's i, j, k: the sform itself.
    expect(ms.coordinateTransformations).toEqual([
      { type: "affine", input: "array", output: "mni152", affine: RAS.map((row) => row.map((x) => expect.closeTo(x, 5))) },
    ]);
    const array = await json(s, "0/zarr.json");
    expect(array).toMatchObject({
      shape: [70, 66, 65],
      data_type: "int16",
      chunk_grid: { configuration: { chunk_shape: [64, 64, 64] } },
      dimension_names: ["x", "y", "z"],
      codecs: [{ name: "transpose", configuration: { order: [2, 1, 0] } }, { name: "bytes", configuration: { endian: "little" } }],
    });
    expect(await json(s, "1/zarr.json")).toMatchObject({ shape: [35, 33, 33], chunk_grid: { configuration: { chunk_shape: [35, 33, 33] } } });
    expect(await s.get("2/zarr.json")).toBeUndefined();
    expect(await s.get("0/c/9/0/0")).toBeUndefined();
    expect(await s.get(".zattrs")).toBeUndefined();
  });

  it("cuts every chunk of level 0 from the file, in either byte order and version", async () => {
    for (const [version, littleEndian] of [[1, true], [1, false], [2, false]] as const) {
      const s = await store(nifti({ version, littleEndian, dim, sform: RAS, value }));
      const level = await readLevel(s, 0);
      for (let k = 0; k < dim[2]; k += 7) for (let j = 0; j < dim[1]; j += 5) for (let i = 0; i < dim[0]; ++i) expect(level.at(i, j, k)).toBe(value(i + dim[0] * (j + dim[1] * k)));
      expect(level.at(69, 65, 64)).toBe(value(dim[0] * dim[1] * dim[2] - 1));
    }
  });

  it("makes a coarser level from the mean of the finer one", async () => {
    const s = await store(nifti({ dim, pixdim: [1, 1, 1], value }));
    expect(s.levels[1].step).toEqual([2, 2, 2]);
    const fine = await readLevel(s, 0);
    const coarse = await readLevel(s, 1);
    for (const [I, J, K] of [[0, 0, 0], [34, 32, 32], [17, 9, 30], [12, 32, 1]]) {
      let sum = 0;
      let n = 0;
      for (let k = 2 * K; k < Math.min(2 * K + 2, dim[2]); ++k) for (let j = 2 * J; j < Math.min(2 * J + 2, dim[1]); ++j) for (let i = 2 * I; i < Math.min(2 * I + 2, dim[0]); ++i) {
        sum += fine.at(i, j, k);
        n++;
      }
      expect(coarse.at(I, J, K)).toBe(Math.round(sum / n));
    }
  });

  it("takes each box's first voxel for label images, and halves only the finest axes", async () => {
    const s = await store(nifti({ dim: [130, 130, 20], pixdim: [0.5, 0.5, 3], intent: 1002, value }));
    expect(s.levels.map((l) => l.step)).toEqual([[1, 1, 1], [2, 2, 1], [2, 2, 1]]);
    const fine = await readLevel(s, 0);
    const coarse = await readLevel(s, 1);
    expect(coarse.at(10, 20, 5)).toBe(fine.at(20, 40, 5));
    expect(coarse.at(64, 64, 19)).toBe(fine.at(128, 128, 19));
    // Signed labels are served unsigned, as segmentations are read.
    expect((await json(s, "0/zarr.json")).data_type).toBe("uint32");
  });

  it("applies scl_slope and scl_inter as float32, and shows float64 as float32", async () => {
    const scaled = await store(nifti({ dim: [9, 8, 7], datatype: 4, slope: 0.5, inter: 10, value: (n) => n }));
    expect((await json(scaled, "0/zarr.json")).data_type).toBe("float32");
    expect((await readLevel(scaled, 0)).at(3, 2, 1)).toBeCloseTo((3 + 9 * (2 + 8 * 1)) * 0.5 + 10);
    const doubles = await store(nifti({ dim: [9, 8, 7], datatype: 64, littleEndian: false, value: (n) => n / 4 }));
    expect((await json(doubles, "0/zarr.json")).data_type).toBe("float32");
    expect((await readLevel(doubles, 0)).at(8, 7, 6)).toBeCloseTo((9 * 8 * 7 - 1) / 4);
  });

  it("reads 4-D images with time as the first axis", async () => {
    const s = await store(nifti({ dim: [6, 5, 4, 3], pixdim: [1, 1, 1, 2.5], units: 2 | 8, value: (n) => n % 250, datatype: 2 }));
    const group = await json(s, "zarr.json");
    const ms = group.attributes.ome.multiscales[0];
    expect(ms.coordinateSystems[0].axes[0]).toEqual({ name: "t", type: "time", unit: "second" });
    expect(ms.coordinateSystems[1].axes.map((a: any) => a.name)).toEqual(["t", "x", "y", "z"]);
    expect(ms.coordinateTransformations[0].affine[0]).toEqual([2.5, 0, 0, 0, 0]);
    const level = await readLevel(s, 0);
    expect(level.size).toEqual([3, 6, 5, 4]);
    expect(level.at(5, 4, 3, 2)).toBe((6 * 5 * 4 * 3 - 1) % 250);
    expect(level.at(1, 2, 3, 1)).toBe((1 + 6 * (2 + 5 * (3 + 4 * 1))) % 250);
  });

  it("keeps a short 4th axis that is not a time series whole in each chunk (as spherical harmonics)", async () => {
    const dim = [70, 9, 8, 45];
    const s = await store(nifti({ dim, value: (n) => n % 251, datatype: 2 }));
    const array = await json(s, "0/zarr.json");
    expect(array.chunk_grid.configuration.chunk_shape).toEqual([45, 28, 9, 8]);
    const level = await readLevel(s, 0);
    expect(level.at(69, 8, 7, 44)).toBe((70 * 9 * 8 * 45 - 1) % 251);
    expect(level.at(40, 3, 2, 17)).toBe((40 + 70 * (3 + 9 * (2 + 8 * 17))) % 251);
    // A time series of the same length keeps one volume a chunk.
    const series = await store(nifti({ dim, pixdim: [1, 1, 1, 2], units: 2 | 8, value: (n) => n % 251, datatype: 2 }));
    expect((await json(series, "0/zarr.json")).chunk_grid.configuration.chunk_shape).toEqual([1, 64, 9, 8]);
  });

  it("reads .nii.gz, decompressing only the header until a chunk is asked for", async () => {
    const bytes = nifti({ dim: [20, 19, 18], value });
    const gz = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const s = await openNifti(new Blob([gz]), "gz");
    expect((await json(s, "0/zarr.json")).shape).toEqual([20, 19, 18]);
    expect((await readLevel(s, 0)).at(19, 18, 17)).toBe(value(20 * 19 * 18 - 1));
  });

  it("refuses what it cannot read, saying why", async () => {
    const pair = nifti({ dim: [2, 2, 2], value });
    pair.set([110, 105, 49, 0], 344);
    await expect(store(pair)).rejects.toThrow(/separate \.img/);
    const complex = nifti({ dim: [2, 2, 2], value });
    new DataView(complex.buffer).setInt16(70, 32, true);
    await expect(store(complex)).rejects.toThrow(/complex64/);
    await expect(store(new Uint8Array(400))).rejects.toThrow(/not a NIfTI/);
  });

  it("serves RGB as one packed uint32 a voxel, marked for the app to show in colour", async () => {
    // A uint8 file of 6 x 2 x 2 bytes, relabelled as 2 x 2 x 2 RGB voxels.
    const bytes = nifti({ dim: [6, 2, 2], datatype: 2, value: (n) => (n * 10) % 256 });
    const v = new DataView(bytes.buffer);
    v.setInt16(42, 2, true);
    v.setInt16(70, 128, true);
    v.setInt16(72, 24, true);
    const s = await store(bytes);
    expect((await json(s, "zarr.json")).attributes.ngplatform).toEqual({ rendering: "rgb" });
    expect((await json(s, "0/zarr.json")).data_type).toBe("uint32");
    const chunk = new Uint32Array((await s.get("0/c/0/0/0"))!.slice().buffer);
    const pack = (r: number, g: number, b: number) => (r | (g << 8) | (b << 16) | (255 << 24)) >>> 0;
    expect([chunk[0], chunk[1]]).toEqual([pack(0, 10, 20), pack(30, 40, 50)]);
  });

  it("reads a .hdr/.img pair (NIfTI or Analyze) as the single file it stands for", async () => {
    const single = nifti({ dim: [5, 4, 3], pixdim: [2, 2, 3], value });
    const hdr = single.slice(0, 348);
    hdr.set([110, 105, 49, 0], 344); // "ni1"
    new DataView(hdr.buffer).setFloat32(108, 0, true);
    const img = single.slice(352);
    const pair = await openNifti(await pairAsSingleFile(new Blob([hdr]), new Blob([img]), "pair.nii"), "pair");
    const expected = await readLevel(await store(single), 0);
    const got = await readLevel(pair, 0);
    expect(got.size).toEqual(expected.size);
    expect(got.at(4, 3, 2)).toBe(expected.at(4, 3, 2));
    expect(got.at(1, 2, 1)).toBe(expected.at(1, 2, 1));
    // Analyze 7.5: no mark, and its orientation bytes where NIfTI keeps qform and sform.
    const analyze = hdr.slice();
    analyze.fill(7, 252, 344);
    analyze.fill(0, 344, 348);
    const old = await openNifti(await pairAsSingleFile(new Blob([analyze]), new Blob([img]), "old.nii"), "old");
    expect(niftiAffine(old.header).matrix.map((row) => row.slice(0, 3))).toEqual([[2, 0, 0], [0, 2, 0], [0, 0, 3]]);
    expect(splitVirtual("study/t1.hdr/zarr.json")).toMatchObject({ file: "study/t1.hdr", key: "zarr.json" });
  });

  it("answers ranges of a key", async () => {
    const s = await store(nifti({ dim: [4, 4, 4], value }));
    const whole = await answer(s, "zarr.json", undefined, false);
    const part = await answer(s, "zarr.json", { start: 2, end: 10 }, false);
    expect(part).toMatchObject({ status: 200, size: whole.size, start: 2 });
    expect(new Uint8Array(part.body!)).toEqual(new Uint8Array(whole.body!).slice(2, 10));
    expect((await answer(s, "nothing", undefined, false)).status).toBe(404);
  });

  describe("tensors", () => {
    // A tensor field (Dxx Dxy Dyy Dxz Dyz Dzz, NIfTI's lower triangle) whose
    // cigars turn from voxel to voxel, with a background of zeros (x < 3).
    const tdim = [60, 10, 9];
    const tensorAt = (i: number, j: number, k: number): number[] => {
      if (i < 3) return [0, 0, 0, 0, 0, 0];
      const a = 0.4 * i + 0.7 * j - 0.3 * k;
      const [l1, l2, l3] = [1.7e-3, 0.3e-3 + 1e-5 * k, 0.2e-3];
      const c = Math.cos(a);
      const s = Math.sin(a);
      // xx, xy, yy, xz, yz, zz
      return [l1 * c * c + l2 * s * s, (l1 - l2) * c * s, l1 * s * s + l2 * c * c, 0, 0, l3];
    };
    const tensorFile = (spec: { intent?: number; fourD?: boolean }) =>
      nifti({
        dim: spec.fourD ? [...tdim, 6] : [...tdim, 1, 6],
        datatype: 16,
        intent: spec.intent,
        // file order: i fastest, then j, k, (t), component
        value: (n) => {
          const i = n % tdim[0];
          const j = Math.floor(n / tdim[0]) % tdim[1];
          const k = Math.floor(n / (tdim[0] * tdim[1])) % tdim[2];
          const c = Math.floor(n / (tdim[0] * tdim[1] * tdim[2]));
          return tensorAt(i, j, k)[c];
        },
      });
    /** The six components of a level's voxel, from readLevel. */
    const sixOf = (level: Awaited<ReturnType<typeof readLevel>>, i: number, j: number, k: number) => Array.from({ length: 6 }, (_, c) => level.at(i, j, k, c));
    const boxes = [[0, 0, 0], [1, 2, 3], [5, 4, 4], [10, 4, 2], [6, 0, 1]];

    it("makes coarse levels of a NIFTI_INTENT_SYMMATRIX image log-Euclidean means, zeros left out", async () => {
      const s = await store(tensorFile({ intent: 1005 }));
      expect(s.coarsening).toEqual({ type: "log-euclidean", order: "dipy" });
      const group = await json(s, "zarr.json");
      expect(group.attributes.ome.multiscales[0].type).toBe("log-euclidean");
      expect(s.levels[1].step).toEqual([2, 2, 2]);
      const coarse = await readLevel(s, 1);
      for (const [I, J, K] of boxes) {
        const box: number[][] = [];
        for (let k = 2 * K; k < Math.min(2 * K + 2, tdim[2]); ++k) for (let j = 2 * J; j < Math.min(2 * J + 2, tdim[1]); ++j) for (let i = 2 * I; i < Math.min(2 * I + 2, tdim[0]); ++i) box.push(tensorAt(i, j, k));
        const expected = logEuclideanMean(box, "dipy");
        const got = sixOf(coarse, I, J, K);
        for (let c = 0; c < 6; ++c) expect(got[c]).toBeCloseTo(expected[c], 8);
      }
      // All background: zeros. Half background: the mean of the tensors alone.
      expect(sixOf(coarse, 0, 3, 3)).toEqual([0, 0, 0, 0, 0, 0]);
      const half = logEuclideanMean([tensorAt(3, 2, 2), tensorAt(3, 3, 2), tensorAt(3, 2, 3), tensorAt(3, 3, 3)], "dipy");
      sixOf(coarse, 1, 1, 1).forEach((v, c) => expect(v).toBeCloseTo(half[c], 8));
      // No NaN at any level, the coarsest too.
      for (let l = 1; l < s.levels.length; ++l) {
        const level = await readLevel(s, l);
        const [, nx, ny, nz] = level.size;
        for (let k = 0; k < nz; ++k) for (let j = 0; j < ny; ++j) for (let i = 0; i < nx; ++i) for (const v of sixOf(level, i, j, k)) expect(Number.isFinite(v)).toBe(true);
      }
    });

    it("keeps the determinant where a plain mean swells it", async () => {
      const log = await readLevel(await store(tensorFile({ intent: 1005 })), 1);
      const plain = await readLevel(await store(tensorFile({})), 1);
      // xx, xy, yy, xz, yz, zz
      const det = (m: number[]) => m[0] * (m[2] * m[5] - m[4] * m[4]) - m[1] * (m[1] * m[5] - m[4] * m[3]) + m[3] * (m[1] * m[4] - m[2] * m[3]);
      for (const [I, J, K] of [[5, 2, 1], [7, 3, 3]]) {
        const dets: number[] = [];
        for (let k = 2 * K; k < 2 * K + 2; ++k) for (let j = 2 * J; j < 2 * J + 2; ++j) for (let i = 2 * I; i < 2 * I + 2; ++i) dets.push(det(tensorAt(i, j, k)));
        const geometric = Math.exp(dets.reduce((a, d) => a + Math.log(d), 0) / dets.length);
        expect(det(sixOf(log, I, J, K)) / geometric).toBeCloseTo(1, 4);
        expect(det(sixOf(plain, I, J, K)) / geometric).toBeGreaterThan(1.2);
      }
    });

    it("averages as tensors when told to (in the order given), and plainly again when told not to", async () => {
      const s = await store(tensorFile({ fourD: true }));
      expect(s.coarsening).toEqual({ type: "mean" });
      const plain = sixOf(await readLevel(s, 1), 5, 2, 1);
      expect(s.message({ tensor: "dipy" })).toEqual({ tensor: "dipy", changed: true });
      expect(s.message({ tensor: "dipy" })).toEqual({ tensor: "dipy", changed: false });
      const told = sixOf(await readLevel(s, 1), 5, 2, 1);
      const reference = sixOf(await readLevel(await store(tensorFile({ intent: 1005 })), 1), 5, 2, 1);
      told.forEach((v, c) => expect(v).toBeCloseTo(reference[c], 10));
      expect(s.message({ tensor: null })).toEqual({ tensor: null, changed: true });
      expect(sixOf(await readLevel(s, 1), 5, 2, 1)).toEqual(plain);
      expect(() => s.message({ tensor: "spm" })).toThrow(/not a tensor order/);
      // Not six components together in a chunk: refused, saying why.
      const series = await store(nifti({ dim: [...tdim, 6], pixdim: [1, 1, 1, 2], units: 2 | 8, datatype: 16, value: () => 1 }));
      expect(series.message({ tensor: "fsl" })).toMatchObject({ tensor: null, changed: false, reason: expect.stringMatching(/six float components/) });
    });

    it("makes a 128³ level of tensors in well under a few seconds", async () => {
      const n = 128;
      // Dxx Dxy Dyy Dxz Dyz Dzz: off-diagonals varying from voxel to voxel.
      const component = (f: number) => [1e-3, ((f % 7) - 3) * 1e-5, 6e-4, ((f % 5) - 2) * 1e-5, ((f % 3) - 1) * 1e-5, 3e-4][Math.floor(f / n ** 3)];
      const bytes = nifti({ dim: [n, n, n, 1, 6], datatype: 16, intent: 1005, value: component });
      const s = await store(bytes);
      const started = performance.now();
      const meta = await json(s, "1/zarr.json");
      const grid = meta.shape.map((v: number, d: number) => Math.ceil(v / meta.chunk_grid.configuration.chunk_shape[d]));
      for (let k = 0; k < grid[3]; ++k) for (let j = 0; j < grid[2]; ++j) for (let i = 0; i < grid[1]; ++i) await s.get(`1/c/0/${i}/${j}/${k}`);
      const ms = performance.now() - started;
      console.log(`a 128³ × 6 level 1 (64³) made in ${Math.round(ms)} ms`);
      expect(ms).toBeLessThan(4000);
    }, 30000);
  });
});

describe("placement", () => {
  // Sagittal and slightly oblique: i posterior, j up, k right.
  const SAG = [
    [0.05, 0, 1.1, -60],
    [-0.9, 0, 0.04, 80],
    [0, 1.0, 0, -45],
  ];
  const ijkToWorld = (ijk: number[]) => SAG.map((row) => row[0] * ijk[0] + row[1] * ijk[1] + row[2] * ijk[2] + row[3]);

  it("puts the volume view's voxels where the NIfTI affine does", async () => {
    const s = await store(nifti({ dim: [40, 30, 20], sform: SAG, value }));
    const group = await json(s, "zarr.json");
    // The array's axes are named for the world axes nearest them.
    expect(group.attributes.ome.multiscales[0].coordinateSystems[1].axes.map((a: any) => a.name)).toEqual(["y", "z", "x"]);
    const pyramid = parseOmeLevels("local/", group);
    expect(pyramid.space).toBe("mni152");
    const [level] = pyramid.levels;
    // The view's voxel (x, y, z) indexes the array's axes by name.
    const ijk = [7, 11, 13];
    const names = level.axes; // array order: i, j, k
    const voxel = [0, 0, 0];
    names.forEach((name, d) => (voxel["xyz".indexOf(name)] = ijk[d]));
    apply(level.voxelToRas, voxel).forEach((v, r) => expect(v).toBeCloseTo(ijkToWorld(ijk)[r], 4));
  });

  it("is read by Neuroglancer as one coordinate space with the affine", async () => {
    const s = await store(nifti({ dim: [40, 30, 20], sform: SAG, value }));
    const group = await json(s, "zarr.json");
    const meta = parseOmeMetadata("http://local/test.nii/", group.attributes, 3)!;
    const { coordinateSpace, scales, baseInfo } = meta.multiscale;
    expect(coordinateSpace.names).toEqual(["x", "y", "z"]);
    expect(coordinateSpace.units).toEqual(["m", "m", "m"]);
    // 40 × 30 × 20 fits in one chunk, so one level.
    expect(scales.map((x) => x.url)).toEqual(["http://local/test.nii/0/"]);
    // Neuroglancer's voxel v spans [v, v + 1); its centre goes through the
    // level's transform to model coordinates, then the model transform,
    // whose linear part is a ratio of physical lengths and whose
    // translation is in output units (coordinate_transform.ts).
    const rank = 3;
    const at = (m: Float64Array | Float32Array, r: number, c: number) => m[c * (rank + 1) + r];
    const centre = [7.5, 11.5, 13.5]; // array order i, j, k
    const level = scales[0].transform;
    const model = [0, 1, 2].map((r) => at(level, r, rank) + [0, 1, 2].reduce((sum, c) => sum + at(level, r, c) * centre[c], 0));
    const base = baseInfo.baseTransform;
    const cs = coordinateSpace.scales;
    const metres = [0, 1, 2].map((r) => at(base, r, rank) * cs[r] + [0, 1, 2].reduce((sum, c) => sum + at(base, r, c) * model[c] * cs[c], 0));
    ijkToWorld([7, 11, 13]).forEach((v, r) => expect(metres[r] * 1e3).toBeCloseTo(v, 3));
  });
});

describe("levels in Neuroglancer", () => {
  it("puts a coarse voxel at the centre of the fine voxels it covers", async () => {
    const s = await store(nifti({ dim: [140, 130, 70], pixdim: [1, 1, 1], value }));
    const group = await json(s, "zarr.json");
    const { scales } = parseOmeMetadata("http://local/t.nii/", group.attributes, 3)!.multiscale;
    // 140 × 130 × 70, 70 × 65 × 35, 35 × 33 × 18.
    expect(scales).toHaveLength(3);
    const rank = 3;
    const at = (m: Float64Array | Float32Array, r: number, c: number) => m[c * (rank + 1) + r];
    const toModel = (level: number, v: number[]) => [0, 1, 2].map((r) => at(scales[level].transform, r, rank) + [0, 1, 2].reduce((sum, c) => sum + at(scales[level].transform, r, c) * v[c], 0));
    // Coarse voxel (i, j, k) = (7, 5, 3)'s centre is fine voxel (14.5, 10.5, 6.5)'s.
    toModel(1, [7.5, 5.5, 3.5]).forEach((v, r) => expect(v).toBeCloseTo(toModel(0, [15, 11, 7])[r], 9));
  });
});

describe("local paths", () => {
  it("splits a path under a NIfTI file into the file and a key", () => {
    expect(splitVirtual("brain.nii.gz/zarr.json")).toMatchObject({ file: "brain.nii.gz", key: "zarr.json" });
    expect(splitVirtual("sub-01/anat/T1w.nii/0/c/0/1/2")).toMatchObject({ file: "sub-01/anat/T1w.nii", key: "0/c/0/1/2" });
    expect(splitVirtual("brain.nii.gz")).toBeUndefined();
    expect(splitVirtual("image.ome.zarr/0/zarr.json")).toBeUndefined();
  });

  it("reads through a blob without copying more than asked", async () => {
    const source = blobSource(new Blob([new Uint8Array([1, 2, 3, 4, 5])]));
    expect(Array.from(await source.read(1, 4))).toEqual([2, 3, 4]);
    expect(source.size).toBe(5);
  });
});

describe("FreeSurfer .mgz and .mgh as virtual OME-Zarr", () => {
  const DIR = new URL("./testdata/mgh/", import.meta.url);
  const expected = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8")) as Record<string, { shape: number[]; affine: number[][]; voxels: number[] }>;

  for (const name of ["short.mgz", "frames.mgh"]) {
    it(`reads ${name}: voxels and placement as nibabel and FreeSurfer's mri_info read them`, async () => {
      const want = expected[name];
      const s = await openMgh(new Blob([readFileSync(new URL(name, DIR))]), name);
      // Voxel to RAS, as FreeSurfer computes it.
      const m = niftiAffine(s.header).matrix;
      for (let r = 0; r < 3; ++r) for (let c = 0; c < 4; ++c) expect(m[r][c]).toBeCloseTo(want.affine[r][c], 4);
      const { at, size } = await readLevel(s, 0);
      const [ni, nj, nk] = want.shape;
      const frames = want.shape[3] ?? 1;
      expect(size.slice(-3)).toEqual([ni, nj, nk]);
      let n = 0;
      for (let t = 0; t < frames; ++t)
        for (let k = 0; k < nk; ++k)
          for (let j = 0; j < nj; ++j)
            for (let i = 0; i < ni; ++i, ++n) expect(at(i, j, k, t)).toBeCloseTo(want.voxels[n], 4);
    });
  }

  it("refuses what is not MGH", () => {
    expect(() => parseMghHeader(new Uint8Array(284))).toThrow(/not an MGH file/);
    expect(mghVoxelToRas(parseMghHeader(Object.assign(new Uint8Array(284), { 3: 1 }))).map((r) => r.slice(0, 3))).toEqual([
      [-1, 0, 0],
      [0, 0, 1],
      [0, -1, 0],
    ]);
  });
});

describe("file names", () => {
  it("reads NIfTI and Analyze as images, and leaves CIFTI to the surfaces it is on", async () => {
    const { VIRTUAL_FILE } = await import("../src/virtual/images/store.js");
    for (const name of ["T1.nii", "T1.nii.gz", "a.hdr", "sub.dwi.nii.gz"]) expect(VIRTUAL_FILE.test(name), name).toBe(true);
    for (const name of ["sub.thickness.dscalar.nii", "aparc.dlabel.nii", "rest.dtseries.nii", "net.pconn.nii"]) expect(VIRTUAL_FILE.test(name), name).toBe(false);
  });
});
