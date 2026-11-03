/** Filters computed on the fly: the kernels, and the store's chunks against the filter applied to the whole image. */
import { describe, expect, it } from "vitest";
import { applyFilter, type Block, boxMedian, FilteredStore, filterName, frangi, gaussian, parseFilterName, symmetricEigenvalues } from "../src/virtual/images/filters.js";
import { openNpy } from "../src/virtual/images/npy.js";
import { readLevel, storeLevels } from "../src/virtual/out/read_level.js";

/** A float32 .npy of shape [z, y, x] (x fastest), made in the test. */
function npy(size: [number, number, number], value: (x: number, y: number, z: number) => number): Blob {
  const [nx, ny, nz] = size;
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${nz}, ${ny}, ${nx}), }`;
  header = header.padEnd(118, " ") + "\n";
  const head = new Uint8Array(10 + header.length);
  head.set([0x93, ...new TextEncoder().encode("NUMPY"), 1, 0]);
  new DataView(head.buffer).setUint16(8, header.length, true);
  head.set(new TextEncoder().encode(header), 10);
  const data = new Float32Array(nx * ny * nz);
  for (let z = 0, i = 0; z < nz; ++z) for (let y = 0; y < ny; ++y) for (let x = 0; x < nx; ++x, ++i) data[i] = value(x, y, z);
  return new Blob([head, data]);
}

const block = (size: [number, number, number], value: (x: number, y: number, z: number) => number): Block => {
  const data = new Float32Array(size[0] * size[1] * size[2]);
  for (let z = 0, i = 0; z < size[2]; ++z) for (let y = 0; y < size[1]; ++y) for (let x = 0; x < size[0]; ++x, ++i) data[i] = value(x, y, z);
  return { data, size };
};

describe("filter kernels", () => {
  it("keeps a constant constant and a linear ramp linear inside", () => {
    const ramp = block([9, 9, 9], (x) => 3 * x + 1);
    for (const f of [parseFilterName("mean-radius=1"), parseFilterName("gaussian-sigma=1")]) {
      const out = applyFilter(ramp, f).data;
      expect(out[4 + 9 * (4 + 9 * 4)]).toBeCloseTo(13, 4);
    }
  });

  it("median removes a single spike that a mean smears", () => {
    const spike = block([5, 5, 5], (x, y, z) => (x === 2 && y === 2 && z === 2 ? 270 : 0));
    expect(boxMedian(spike, 1).data[62]).toBe(0);
    expect(applyFilter(spike, { kind: "mean", radius: 1 }).data[62]).toBeCloseTo(10, 4);
  });

  it("finds a symmetric matrix's eigenvalues", () => {
    // diag(1, -4, 2) turned: the same eigenvalues.
    const [a, b, c] = symmetricEigenvalues(1, 0, 0, -4, 0, 2);
    expect([a, b, c]).toEqual([1, 2, -4]);
    const l = symmetricEigenvalues(2, 1, 0, 2, 0, 3).sort((u, v) => u - v);
    [1, 3, 3].forEach((v, i) => expect(l[i]).toBeCloseTo(v, 6));
  });

  it("Frangi's vesselness picks out a bright tube, not a plain background or a blob", () => {
    const tube = block([21, 21, 21], (x, y) => 100 * Math.exp(-((x - 10) ** 2 + (y - 10) ** 2) / 4));
    const v = frangi(tube, { sigmas: [1.5], alpha: 0.5, beta: 0.5, c: 20, bright: true });
    const centre = v.data[10 + 21 * (10 + 21 * 10)];
    const away = v.data[2 + 21 * (2 + 21 * 10)];
    expect(centre).toBeGreaterThan(0.3);
    expect(away).toBeLessThan(0.01);
    const blob = block([21, 21, 21], (x, y, z) => 100 * Math.exp(-((x - 10) ** 2 + (y - 10) ** 2 + (z - 10) ** 2) / 4));
    expect(frangi(blob, { sigmas: [1.5], alpha: 0.5, beta: 0.5, c: 20, bright: true }).data[10 + 21 * (10 + 21 * 10)]).toBeLessThan(centre / 3);
    expect(gaussian(tube, 0.1)).toBe(tube);
  });

  it("names filters in file names and reads them back", () => {
    const f = { kind: "frangi" as const, sigmas: [1, 2.5], alpha: 0.5, beta: 0.5, c: 40, bright: false };
    expect(parseFilterName(filterName(f))).toEqual(f);
    expect(parseFilterName("median-radius=9")).toEqual({ kind: "median", radius: 3 });
  });
});

describe("a filtered image's store", () => {
  it("gives every chunk as the filter on the whole image (no seams where chunks meet)", async () => {
    const size: [number, number, number] = [70, 12, 9];
    const value = (x: number, y: number, z: number) => Math.sin(x / 3) * 50 + y * 2 + ((x * 7 + y * 3 + z * 5) % 11);
    const source = await openNpy(npy(size, value), "ramp");
    for (const name of ["gaussian-sigma=1.2", "median-radius=1"]) {
      const filter = parseFilterName(name);
      const store = await FilteredStore.open(source, filter, "ramp filtered");
      const { levels } = await storeLevels(store);
      const got = await readLevel(store, levels[0]);
      const want = applyFilter(block(size, value), filter).data;
      Array.from(got.data).forEach((v, i) => expect(v, `${name} at ${i}`).toBeCloseTo(want[i], 3));
    }
  });
});

describe("a filtered big-endian image", () => {
  it("reads the source in its own byte order and writes little-endian", async () => {
    const { readFileSync } = await import("node:fs");
    const { openMgh } = await import("../src/virtual/images/mgh.js");
    const source = await openMgh(new Blob([readFileSync(new URL("./testdata/mgh/short.mgz", import.meta.url))]), "short");
    const store = await FilteredStore.open(source, { kind: "median", radius: 1 }, "short median");
    const meta = JSON.parse(new TextDecoder().decode((await store.get("0/zarr.json"))!));
    expect(meta.codecs.find((c: any) => c.name === "bytes").configuration.endian).toBe("little");
    const { levels } = await storeLevels(store);
    const got = await readLevel(store, levels[0]);
    const original = await readLevel(source, (await storeLevels(source)).levels[0]);
    const want = boxMedian({ data: Float32Array.from(original.data), size: original.size as [number, number, number] }, 1).data;
    Array.from(got.data).forEach((v, i) => expect(v).toBe(Math.trunc(want[i])));
  });
});
