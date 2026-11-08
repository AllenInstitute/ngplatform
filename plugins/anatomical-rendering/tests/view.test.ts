import { describe, expect, it } from "vitest";
import { halfToFloat, hostLink } from "../client.js";
import { readSaved } from "../plugin.js";
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
