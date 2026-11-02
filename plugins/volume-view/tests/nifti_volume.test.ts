/**
 * A NIfTI read as virtual Zarr (stored transposed, int16) drawn by the
 * volume view: its levels open in x, y, z order and its values come through
 * the window to 0..255 in place (x fastest), so the solid is not scrambled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNifti } from "../../../src/virtual/images/nifti.js";
import { VolumeReader } from "../volume_reader.js";

/** A NIfTI-1 of int16 voxels, value(x, y, z), 1 mm, at the origin. */
function niftiBytes(n: [number, number, number], value: (x: number, y: number, z: number) => number): Uint8Array {
  const [nx, ny, nz] = n;
  const bytes = new Uint8Array(352 + nx * ny * nz * 2);
  const v = new DataView(bytes.buffer);
  v.setInt32(0, 348, true);
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((d, k) => v.setInt16(40 + 2 * k, d, true));
  v.setInt16(70, 4, true);
  v.setInt16(72, 16, true);
  [1, 1, 1, 1].forEach((p, k) => v.setFloat32(76 + 4 * k, p, true));
  v.setFloat32(108, 352, true);
  bytes[123] = 2;
  v.setInt16(254, 4, true);
  [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]].forEach((row, r) => row.forEach((x, c) => v.setFloat32(280 + 16 * r + 4 * c, x, true)));
  bytes.set([110, 43, 49, 0], 344);
  for (let z = 0; z < nz; ++z) for (let y = 0; y < ny; ++y) for (let x = 0; x < nx; ++x) v.setInt16(352 + 2 * (x + nx * (y + ny * z)), value(x, y, z), true);
  return bytes;
}

afterEach(() => vi.unstubAllGlobals());

describe("NIfTI in the volume view", () => {
  it("reads a transposed int16 store in x, y, z order, windowed to 0..255", async () => {
    const n: [number, number, number] = [70, 40, 30];
    const store = await openNifti(new Blob([niftiBytes(n, (x, y, z) => 10 * x + y + 400 * z) as BlobPart]), "t1");
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
      const key = String(url).replace("http://nifti.test/", "");
      const data = await store.get(key);
      if (data === undefined) return new Response(null, { status: 404 });
      const range = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "");
      return new Response(range ? data.slice(Number(range[1]), Number(range[2]) + 1) : data, { status: range ? 206 : 200 });
    });
    const reader = new VolumeReader();
    const { levels } = await reader.open(["http://nifti.test/"], undefined);
    expect(levels[0].size).toEqual(n);
    const { data, size } = await reader.volume(0, new AbortController().signal);
    expect(size).toEqual(n);
    const at = (x: number, y: number, z: number) => data[x + n[0] * (y + n[1] * z)];
    // Rising along x and z, as the values do; not one flat value.
    for (let z = 0; z < n[2]; z += 7) for (let y = 0; y < n[1]; y += 9) for (let x = 1; x < n[0]; ++x) expect(at(x, y, z)).toBeGreaterThanOrEqual(at(x - 1, y, z));
    for (let x = 0; x < n[0]; x += 11) for (let z = 1; z < n[2]; ++z) expect(at(x, 5, z)).toBeGreaterThanOrEqual(at(x, 5, z - 1));
    expect(at(0, 0, 0)).toBeLessThan(30);
    expect(at(n[0] - 1, n[1] - 1, n[2] - 1)).toBeGreaterThan(225);
  });
});
