/**
 * Export of a computed view (src/virtual/out/read_level.ts on the engine's
 * metadata): OME-Zarr 0.5, axes z, y, x in micrometres, read x fastest and
 * placed in millimetres; and the 0.6 metadata a view of a local file is
 * served with (`placeLike`), its affine kept.
 */
import { describe, expect, it } from "vitest";
import { placeLike } from "../src/virtual/computed.js";
import type { VirtualStore } from "../src/virtual/images/store.js";
import { readLevel, storeLevels } from "../src/virtual/out/read_level.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** A z, y, x float32 store of `shape` (one chunk a level), value(z, y, x) at level 0, its group's attributes given. */
function engineStore(attributes: unknown, shape: number[], value: (z: number, y: number, x: number) => number): VirtualStore {
  const [nz, ny, nx] = shape;
  const data = new Float32Array(nz * ny * nx);
  for (let z = 0; z < nz; ++z) for (let y = 0; y < ny; ++y) for (let x = 0; x < nx; ++x) data[(z * ny + y) * nx + x] = value(z, y, x);
  const files = new Map<string, Uint8Array>([
    ["zarr.json", bytes({ zarr_format: 3, node_type: "group", attributes })],
    [
      "0/zarr.json",
      bytes({
        zarr_format: 3,
        node_type: "array",
        shape,
        data_type: "float32",
        fill_value: 0,
        chunk_grid: { name: "regular", configuration: { chunk_shape: shape } },
        chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
        codecs: [{ name: "bytes", configuration: { endian: "little" } }],
        dimension_names: ["z", "y", "x"],
        attributes: {},
      }),
    ],
    ["0/c/0/0/0", new Uint8Array(data.buffer)],
  ]);
  return { get: async (key) => files.get(key) };
}

const value = (z: number, y: number, x: number) => 100 * z + 10 * y + x;

describe("export of a computed view", () => {
  it("reads OME-Zarr 0.5 z, y, x x fastest, placed in millimetres", async () => {
    const attributes = {
      ome: {
        version: "0.5",
        multiscales: [
          {
            name: "p1",
            axes: ["z", "y", "x"].map((name) => ({ name, type: "space", unit: "micrometer" })),
            datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [4, 2, 1] }, { type: "translation", translation: [40, 20, 10] }] }],
          },
        ],
      },
    };
    const store = engineStore(attributes, [3, 4, 5], value);
    const { levels } = await storeLevels(store);
    expect(levels[0].size).toEqual([5, 4, 3]);
    // i is x (1 µm), j is y (2 µm), k is z (4 µm); the origin 10, 20, 40 µm.
    expect(Array.from(levels[0].voxelToRas).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.001, 0, 0, 0.01, 0, 0.002, 0, 0.02, 0, 0, 0.004, 0.04, 0, 0, 0, 1]);
    const volume = await readLevel(store, levels[0]);
    for (let z = 0; z < 3; ++z) for (let y = 0; y < 4; ++y) for (let x = 0; x < 5; ++x) expect(volume.data[x + 5 * (y + 4 * z)]).toBe(value(z, y, x));
    // A box: voxels (x, y, z) 1..3, 1..3, 1..2.
    const box = await readLevel(store, levels[0], undefined, { lo: [1, 1, 1], hi: [4, 4, 3] });
    expect(box.size).toEqual([3, 3, 2]);
    expect(box.data[0]).toBe(value(1, 1, 1));
  });

  it("keeps the affine of a local file's view (0.6, as placeLike serves it)", async () => {
    const engine = {
      ome: {
        version: "0.5",
        multiscales: [{ name: "p1", axes: ["z", "y", "x"].map((name) => ({ name, type: "space" })), datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1] }, { type: "translation", translation: [0, 0, 0] }] }] }],
      },
    };
    // The source: i along y, j along z, k along x (2 mm), as its z, y, x view lists it.
    const source = {
      attributes: {
        ome: {
          multiscales: [
            {
              coordinateSystems: [
                { name: "scanner", axes: ["x", "y", "z"].map((name) => ({ name, type: "space", unit: "millimeter" })) },
                { name: "array", axes: ["z", "y", "x"].map((name) => ({ name, type: "space" })) },
              ],
              datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1], input: "0", output: "array" }] }],
              coordinateTransformations: [{ type: "affine", input: "array", output: "scanner", affine: [[0, 0, 2, 10], [0, 2, 0, 20], [2, 0, 0, 30]] }],
            },
          ],
        },
      },
    };
    const placed = placeLike({ zarr_format: 3, node_type: "group", attributes: engine }, source);
    const store = engineStore(placed.attributes, [3, 4, 5], value);
    const { levels } = await storeLevels(store);
    expect(levels[0].size).toEqual([5, 4, 3]);
    expect(Array.from(levels[0].voxelToRas)).toEqual([2, 0, 0, 10, 0, 2, 0, 20, 0, 0, 2, 30, 0, 0, 0, 1]);
    const volume = await readLevel(store, levels[0]);
    expect(volume.data[2 + 5 * (3 + 4 * 1)]).toBe(value(1, 3, 2));
  });
});
