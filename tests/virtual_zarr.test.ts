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
import { splitVirtual } from "../src/platform/local_data.js";
import { NiftiStore, nearestAxes, niftiAffine, openNifti, parseNiftiHeader } from "../src/platform/virtual_zarr/nifti.js";
import { answer, blobSource } from "../src/platform/virtual_zarr/store.js";

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
    const rgb = nifti({ dim: [2, 2, 2], value });
    new DataView(rgb.buffer).setInt16(70, 128, true);
    await expect(store(rgb)).rejects.toThrow(/RGB/);
    await expect(store(new Uint8Array(400))).rejects.toThrow(/not a NIfTI/);
  });

  it("answers ranges of a key", async () => {
    const s = await store(nifti({ dim: [4, 4, 4], value }));
    const whole = await answer(s, "zarr.json", undefined, false);
    const part = await answer(s, "zarr.json", { start: 2, end: 10 }, false);
    expect(part).toMatchObject({ status: 200, size: whole.size, start: 2 });
    expect(new Uint8Array(part.body!)).toEqual(new Uint8Array(whole.body!).slice(2, 10));
    expect((await answer(s, "nothing", undefined, false)).status).toBe(404);
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
    expect(splitVirtual("brain.nii.gz/zarr.json")).toEqual({ file: "brain.nii.gz", key: "zarr.json" });
    expect(splitVirtual("sub-01/anat/T1w.nii/0/c/0/1/2")).toEqual({ file: "sub-01/anat/T1w.nii", key: "0/c/0/1/2" });
    expect(splitVirtual("brain.nii.gz")).toBeUndefined();
    expect(splitVirtual("image.ome.zarr/0/zarr.json")).toBeUndefined();
  });

  it("reads through a blob without copying more than asked", async () => {
    const source = blobSource(new Blob([new Uint8Array([1, 2, 3, 4, 5])]));
    expect(Array.from(await source.read(1, 4))).toEqual([2, 3, 4]);
    expect(source.size).toBe(5);
  });
});
