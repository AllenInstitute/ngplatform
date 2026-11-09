import { describe, expect, it } from "vitest";
import { halfToFloat, hostLink } from "../client.js";
import { invert4 } from "../draw.js";
import { farFrom, readSaved } from "../plugin.js";
import { ANATOMICAL_VIEWS, clipPlanes, columnMajor, displayFromPhysical, lightDirection, omeZarrSource, orientationLooking, unitMm } from "../view.js";

const MM = { names: ["x", "y", "z"], scales: [1e-3, 1e-3, 1e-3], units: ["m", "m", "m"] };

describe("image sources the host reads", () => {
  it("passes N5 multiscales on as n5://", () => {
    expect(omeZarrSource("n5://gs://bucket/S-21-46/brain/19.57um/")).toBe("n5://gs://bucket/S-21-46/brain/19.57um");
    expect(omeZarrSource("n5://https://example.org/x.n5|n5:")).toBe("n5://https://example.org/x.n5");
    expect(omeZarrSource("n5://relative/path")).toBeUndefined();
    expect(omeZarrSource("zarr3://gs://b/x.ome.zarr/")).toBe("gs://b/x.ome.zarr");
  });
});

describe("anatomical rendering views", () => {
  it("maps physical mm to display coordinates", () => {
    expect(displayFromPhysical(MM)).toEqual(columnMajor([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    const um = { names: ["z", "y", "x"], scales: [1e-6, 1e-6, 1e-6], units: ["m", "m", "m"] };
    const m = displayFromPhysical(um)!;
    // Display axis 0 is z: 1 mm of z is 1000 display units.
    expect(m[4 * 2 + 0]).toBeCloseTo(1000);
    expect(unitMm(um)).toBeCloseTo(1e-3);
    expect(displayFromPhysical({ names: ["x", "y", "t"], scales: [1, 1, 1], units: ["m", "m", "s"] })).toBeUndefined();
  });

  it("makes cut planes through the position", () => {
    const planes = clipPlanes([{ axis: "y", keep: -1, offset: 2, on: true }, { axis: "x", keep: 1, offset: 0, on: false }], [10, 20, 30], MM);
    expect(planes).toEqual([[0, -1, 0, 22]]);
    // Kept where n.x + d >= 0: y = 21 is kept, y = 23 is cut.
    const [p] = planes;
    expect(p[1] * 21 + p[3]).toBeGreaterThan(0);
    expect(p[1] * 23 + p[3]).toBeLessThan(0);
  });

  it("points lights and reads sources", () => {
    const [x, y, z] = lightDirection(0, 90);
    expect([x, y, z].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 0]);
    expect(omeZarrSource("zarr3://https://h/a.ome.zarr/")).toBe("https://h/a.ome.zarr");
    expect(omeZarrSource("gs://b/p.ome.zarr/|zarr3:")).toBe("gs://b/p.ome.zarr");
    expect(omeZarrSource("precomputed://gs://b/p")).toBeUndefined();
  });

  it("reads half floats and links", () => {
    expect(Array.from(halfToFloat(new Uint16Array([0x3c00, 0x0000, 0x3800, 0xc000])))).toEqual([1, 0, 0.5, -2]);
    expect(hostLink("ws", "http://localhost:7000/", () => Promise.reject(new Error())).base).toBe("http://localhost:7000/svc/render");
    const s = readSaved({ cuts: "bad", budget: -1 });
    expect(s.cuts).toHaveLength(3);
    expect(s.on).toBe(false);
  });

  it("cuts are offset in mm whatever the display unit", () => {
    const um = { names: ["x", "y", "z"], scales: [1e-4, 1e-4, 1e-4], units: ["m", "m", "m"] };
    // 2 mm at 100 µm display units is 20 units.
    expect(clipPlanes([{ axis: "x", keep: 1, offset: 2, on: true }], [100, 0, 0], um)).toEqual([[1, 0, 0, -120]]);
  });

  it("makes Neuroglancer orientations for anatomical views", () => {
    const q = orientationLooking([1, 0, 0], [0, 0, 1]);
    const want = [-0.5, 0.5, -0.5, 0.5];
    const sign = Math.sign(q[3]) || 1;
    q.forEach((v, i) => expect(v * sign).toBeCloseTo(want[i], 6));
    for (const v of ANATOMICAL_VIEWS) expect(Math.hypot(...orientationLooking(v.forward, v.up))).toBeCloseTo(1, 9);
  });
});

describe("keeping the picture in space while the camera moves", () => {
  // A perspective camera at `eye` looking at the origin, z up, as an inverse view-projection (column-major).
  const camera = (eye: number[]) => {
    const f = eye.map((v) => -v / Math.hypot(...eye));
    const up = [0, 0, 1];
    const s = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
    const sl = Math.hypot(...s);
    const r = s.map((v) => v / sl);
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const view = [r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]), -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]), f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2], 1];
    const t = 1 / Math.tan(Math.PI / 12), n = 1, fa = 1000;
    const proj = [t, 0, 0, 0, 0, t, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, (2 * fa * n) / (n - fa), 0];
    const vp = new Array(16).fill(0);
    for (let c = 0; c < 4; ++c) for (let rr = 0; rr < 4; ++rr) for (let k = 0; k < 4; ++k) vp[4 * c + rr] += proj[4 * k + rr] * view[4 * c + k];
    return invert4(vp);
  };
  const at = (deg: number, dist = 100) => [dist * Math.sin((deg * Math.PI) / 180), -dist * Math.cos((deg * Math.PI) / 180), 0];
  const frame = (eye: number[], position: [number, number, number] = [0, 0, 0]) => ({ invViewProjection: camera(eye), position });

  it("keeps it for small turns and zooms, and asks for a new one past 20°, twice as near or far, or a position off the picture", () => {
    const picture = camera(at(0));
    expect(farFrom(picture, frame(at(10)))).toBe(false);
    expect(farFrom(picture, frame(at(0, 70)))).toBe(false);
    expect(farFrom(picture, frame(at(25)))).toBe(true);
    expect(farFrom(picture, frame(at(0, 45)))).toBe(true);
    expect(farFrom(picture, frame(at(0, 250)))).toBe(true);
    // Panned so the position sits near the picture's edge (the camera kept looking the same way).
    expect(farFrom(picture, { invViewProjection: camera(at(0)), position: [24, 0, 0] })).toBe(true);
  });
});
