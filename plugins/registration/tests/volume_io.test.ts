/**
 * Saving a moved image: resampling (nearest, trilinear, cubic), the NIfTI
 * header (sform, and qform where the placement allows one), the OME-Zarr
 * pyramid read back by the volume view's reader (0.5 when along the axes,
 * 0.6 with an affine when turned), LTA volume geometry, and the zip.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { VolumeReader } from "../../volume-view/volume_reader.js";
import { identity4, invert4, type Mat4, multiply4 } from "../fit.js";
import { readLta, writeLta } from "../formats.js";
import { identityManual, manualMatrix } from "../manual.js";
import { crc32, halve, niftiFile, omeZarrFiles, quaternionOf, resample, type Volume } from "../volume_io.js";

const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 5) => Array.from(a).forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

function ramp(size: [number, number, number], f: (x: number, y: number, z: number) => number, type: Volume["type"] = "float32"): Volume {
  const data = type === "float32" ? new Float32Array(size[0] * size[1] * size[2]) : new Uint8Array(size[0] * size[1] * size[2]);
  for (let z = 0, i = 0; z < size[2]; ++z) for (let y = 0; y < size[1]; ++y) for (let x = 0; x < size[0]; ++x, ++i) data[i] = f(x, y, z);
  // 2 mm voxels, x flipped (LAS, as many NIfTI files are), offset.
  const voxelToRas = Float64Array.from([-2, 0, 0, 30, 0, 2, 0, -40, 0, 0, 2, -20, 0, 0, 0, 1]);
  return { data, size, type, voxelToRas };
}

const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity4();
  m[3] = x;
  m[7] = y;
  m[11] = z;
  return m;
};

describe("resampling", () => {
  const v = ramp([12, 10, 8], (x, y, z) => x + 10 * y + 100 * z);
  const grid = { size: v.size, voxelToRas: v.voxelToRas };

  it("is the image itself when nothing moves, by every method", () => {
    for (const method of ["nearest", "linear", "cubic"] as const) close(resample(v, grid, identity4(), method), v.data, 4);
  });

  it("moves the voxels: 2 mm to the right is one voxel along -i here", () => {
    const out = resample(v, grid, translation(2, 0, 0), "nearest");
    // out[i] = v at i + 1 (x is flipped), where there is one.
    for (let i = 0; i < 11; ++i) expect(out[i]).toBe(v.data[i + 1]);
    expect(out[11]).toBe(0);
  });

  it("interpolates halfway between voxels: linearly exactly on a ramp, by cubic B-spline nearly (its mirrored edges bend a ramp a little)", () => {
    const half = translation(-1, 1, 0); // half a voxel along +i and +j
    const at = (data: ArrayLike<number>, x: number, y: number, z: number) => data[x + 12 * (y + 10 * z)];
    for (const [method, digits] of [["linear", 4], ["cubic", 2]] as const) {
      const out = resample(v, grid, half, method);
      // out at (x, y) samples v at (x - 0.5, y - 0.5).
      expect(at(out, 5, 5, 3)).toBeCloseTo(4.5 + 45 + 300, digits);
    }
  });

  it("rounds and clamps integer types", () => {
    const u = ramp([6, 6, 6], (x) => (x % 2 ? 255 : 0), "uint8");
    const out = resample(u, { size: u.size, voxelToRas: u.voxelToRas }, translation(-1, 0, 0), "cubic");
    expect(out).toBeInstanceOf(Uint8Array);
    for (const x of out) expect(x >= 0 && x <= 255 && Number.isInteger(x)).toBe(true);
  });

  it("onto another grid: a finer one samples between the voxels", () => {
    const fine = { size: [24, 20, 16] as [number, number, number], voxelToRas: multiply4(v.voxelToRas, Float64Array.from([0.5, 0, 0, -0.25, 0, 0.5, 0, -0.25, 0, 0, 0.5, -0.25, 0, 0, 0, 1])) };
    const out = resample(v, fine, identity4(), "linear");
    expect(out.length).toBe(24 * 20 * 16);
    // Fine voxel (2x + 1) is at coarse x + 0.25.
    expect(out[5 + 24 * (4 + 20 * 4)]).toBeCloseTo(2.25 + 10 * 1.75 + 100 * 1.75, 4);
  });
});

describe("NIfTI", () => {
  it("writes the placement as sform and qform, and the voxels after the header", () => {
    const v = ramp([4, 3, 2], (x, y, z) => x + 4 * y + 12 * z);
    const turn = manualMatrix({ ...identityManual(), rotate: [10, -20, 30], translate: [1, 2, 3] }, [0, 0, 0]);
    const placed = { ...v, voxelToRas: multiply4(turn, v.voxelToRas) };
    const file = niftiFile(placed, { description: "test", window: [0, 23] });
    const h = new DataView(file.buffer);
    expect(h.getInt32(0, true)).toBe(348);
    expect([1, 2, 3].map((k) => h.getInt16(40 + 2 * k, true))).toEqual([4, 3, 2]);
    expect(h.getInt16(70, true)).toBe(16);
    expect(h.getFloat32(108, true)).toBe(352);
    const srow = Array.from({ length: 12 }, (_, i) => h.getFloat32(280 + 4 * i, true));
    close(srow, placed.voxelToRas.slice(0, 12), 4);
    // The quaternion rebuilds the same matrix (nifti_quatern_to_mat44).
    expect(h.getInt16(252, true)).toBe(2);
    const [b, c, d] = [256, 260, 264].map((o) => h.getFloat32(o, true));
    const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d));
    const qfac = h.getFloat32(76, true);
    const [dx, dy, dz] = [80, 84, 88].map((o) => h.getFloat32(o, true));
    const r = [
      [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
      [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
      [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
    ];
    const q = [0, 1, 2].flatMap((row) => [r[row][0] * dx, r[row][1] * dy, r[row][2] * dz * qfac, h.getFloat32(268 + 4 * row, true)]);
    close(q, placed.voxelToRas.slice(0, 12), 4);
    expect(Array.from(new Float32Array(file.buffer.slice(352)))).toEqual(Array.from(v.data));
  });

  it("has no qform for a sheared placement", () => {
    const sheared = Float64Array.from([1, 0.3, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(quaternionOf(sheared)).toBeUndefined();
    const file = niftiFile({ ...ramp([2, 2, 2], () => 1), voxelToRas: sheared });
    expect(new DataView(file.buffer).getInt16(252, true)).toBe(0);
    expect(new DataView(file.buffer).getInt16(254, true)).toBe(2);
  });
});

describe("OME-Zarr", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The files served at a URL, as the volume view's reader fetches them. */
  function serve(files: Map<string, Uint8Array>, base: string) {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const key = String(input).slice(base.length);
      const bytes = files.get(key);
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes as BodyInit, { status: 200 });
    });
  }

  for (const [what, move] of [
    ["along the axes (0.5)", translation(4, -6, 8)],
    ["turned (0.6, an affine)", manualMatrix({ ...identityManual(), rotate: [0, 0, 25] }, [0, 0, 0])],
  ] as [string, Mat4][]) {
    it(`is read back as written: ${what}`, async () => {
      const v = ramp([150, 70, 9], (x, y, z) => ((x * 7 + y * 3 + z) % 200) + 1, "uint8");
      // Along the axes: a positive diagonal.
      const placed = { ...v, voxelToRas: multiply4(move, what.startsWith("along") ? Float64Array.from([2, 0, 0, -150, 0, 2, 0, -70, 0, 0, 2, -9, 0, 0, 0, 1]) : v.voxelToRas) };
      const files = await omeZarrFiles(placed, "t", { window: [1, 200] });
      const group = JSON.parse(new TextDecoder().decode(files.get("zarr.json")!));
      expect(group.attributes.ome.version).toBe(what.startsWith("along") ? "0.5" : "0.6");
      // Halved until no more than 64 a side: 150 → 75 → 38.
      expect([...files.keys()].filter((k) => k.endsWith("/zarr.json"))).toEqual(["0/zarr.json", "1/zarr.json", "2/zarr.json"]);
      const base = "https://example.org/t.ome.zarr/";
      serve(files, base);
      const reader = new VolumeReader();
      const { levels } = await reader.open([base], undefined);
      expect(levels.length).toBe(3);
      close(levels[0].voxelToRas, placed.voxelToRas, 6);
      close(levels[1].voxelToRas, halve(placed, false).voxelToRas, 6);
      const raw = await reader.rawVolume(0, new AbortController().signal);
      expect(raw.size).toEqual([150, 70, 9]);
      expect(Array.from(raw.data)).toEqual(Array.from(v.data));
    });
  }
});

describe("64-bit labels", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A one-level uint64 or int64 label store (no compression), chunks 4 a side. */
  async function labels(type: "uint64" | "int64", values: bigint[], size: [number, number, number]) {
    const { omeZarrMetadata } = await import("../volume_io.js");
    const files = omeZarrMetadata([{ size, voxelToRas: identity4() }], "uint32", "labels", { label: true, chunk: 4, codecs: [{ name: "bytes", configuration: { endian: "little" } }] });
    const array = JSON.parse(new TextDecoder().decode(files.get("0/zarr.json")!));
    array.data_type = type;
    files.set("0/zarr.json", new TextEncoder().encode(JSON.stringify(array)));
    // One chunk (the whole 4³ grid), z, y, x order, x fastest.
    const chunk = type === "uint64" ? new BigUint64Array(64) : new BigInt64Array(64);
    values.forEach((v, i) => (chunk[i] = v));
    files.set("0/c/0/0/0", new Uint8Array(chunk.buffer));
    const base = `https://example.org/${type}.ome.zarr/`;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const bytes = files.get(String(input).slice(base.length));
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes as BodyInit, { status: 200 });
    });
    const reader = new VolumeReader();
    const { levels } = await reader.open([base], undefined);
    return { levels, raw: () => reader.rawVolume(0, new AbortController().signal) };
  }

  it("reads uint64 and int64 labels as 32-bit ones, for saving", async () => {
    const u = await labels("uint64", [0n, 1n, 4294967295n, 70000n], [4, 4, 4]);
    expect(u.levels[0].type).toBe("uint32");
    const raw = await u.raw();
    expect(raw.type).toBe("uint32");
    expect(Array.from(new Uint32Array(raw.data.buffer).slice(0, 4))).toEqual([0, 1, 4294967295, 70000]);
    const i = await labels("int64", [-5n, 2n, 2147483647n], [4, 4, 4]);
    expect(Array.from(new Int32Array((await i.raw()).data.buffer).slice(0, 3))).toEqual([-5, 2, 2147483647]);
  });

  it("refuses a label past 32 bits rather than wrapping it", async () => {
    const u = await labels("uint64", [1n, 4294967296n], [4, 4, 4]);
    await expect(u.raw()).rejects.toThrow(/4294967296 is past what 32 bits hold/);
  });
});

describe("LTA volume geometry", () => {
  it("records each volume's size, voxel sizes, directions and centre; a VOX to VOX file reads back to the same RAS to RAS", () => {
    const src = { size: [91, 109, 91] as [number, number, number], voxelToRas: Float64Array.from([-2, 0, 0, 90, 0, 2, 0, -126, 0, 0, 2, -72, 0, 0, 0, 1]), filename: "mni" };
    const dst = { size: [64, 64, 40] as [number, number, number], voxelToRas: Float64Array.from([3, 0, 0, -96, 0, 0, 3, -60, 0, -3, 0, 96, 0, 0, 0, 1]) };
    const move = manualMatrix({ ...identityManual(), rotate: [5, 0, -10], translate: [2, 3, 4] }, [0, 0, 0]);
    const text = writeLta(move, { src, dst });
    expect(text).toMatch(/src volume info\nvalid = 1 {2}# volume info valid\nfilename = mni\nvolume = 91 109 91\nvoxelsize = 2\.0+e\+0 /);
    expect(text).toMatch(/xras {3}= -1\.0+e\+0 0\.0+e\+0 0\.0+e\+0/);
    // c_ras: the RAS of voxel (size / 2).
    expect(text).toMatch(/cras {3}= -1\.0+e\+0 -1\.70+e\+1 1\.90+e\+1/);
    close(readLta(text), move, 6);
    // The same transform as VOX to VOX (Freeview's Save Reg), through the geometry.
    const vox = multiply4(invert4(dst.voxelToRas), multiply4(move, src.voxelToRas));
    const voxText = text.replace("type      = 1 # LINEAR_RAS_TO_RAS", "type      = 0 # LINEAR_VOX_TO_VOX").replace(/1 4 4\n([^\n]*\n){4}/, `1 4 4\n${[0, 1, 2, 3].map((r) => Array.from(vox.slice(4 * r, 4 * r + 4)).join(" ")).join("\n")}\n`);
    close(readLta(voxText), move, 5);
  });
});

describe("zip", () => {
  it("uses the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("saving without cropping", () => {
  it("grows the image's own grid to hold all of the moved image", async () => {
    const { enlargedGrid } = await import("../volume_io.js");
    const v = ramp([10, 10, 10], () => 1);
    // A 45° turn about z through the volume's centre: the corners reach out by a factor of √2.
    const centre = [0, 1, 2].map((r) => v.voxelToRas[4 * r] * 4.5 + v.voxelToRas[4 * r + 1] * 4.5 + v.voxelToRas[4 * r + 2] * 4.5 + v.voxelToRas[4 * r + 3]) as [number, number, number];
    const turn = manualMatrix({ ...identityManual(), rotate: [0, 0, 45] }, centre);
    const grid = enlargedGrid(v, turn);
    expect(grid.size[2]).toBe(10);
    expect(grid.size[0]).toBeGreaterThanOrEqual(14);
    expect(grid.size[0]).toBeLessThanOrEqual(16);
    // Same voxel size and axes as the image's own.
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) expect(grid.voxelToRas[i]).toBeCloseTo(v.voxelToRas[i], 9);
    // Nothing moved: the image's own grid.
    expect(enlargedGrid(v, identity4()).size).toEqual([10, 10, 10]);
  });
});
