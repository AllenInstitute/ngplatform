import { describe, expect, it } from "vitest";
import { apply4, describe as describeMatrix, fit, invert4, type Mat4, multiply4, type Vec3 } from "../fit.js";
import { readItk, readLta, readPlain, readTransformFile, writeItk, writeLta, writePlain } from "../formats.js";

const points: Vec3[] = [
  [0, 0, 0],
  [10, 0, 0],
  [0, 20, 0],
  [0, 0, 30],
  [5, 7, -3],
  [-12, 4, 9],
];

function rotationZ(degrees: number, scale = 1, t: Vec3 = [3, -4, 5]): Mat4 {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a) * scale;
  const s = Math.sin(a) * scale;
  return Float64Array.from([c, -s, 0, t[0], s, c, 0, t[1], 0, 0, scale, t[2], 0, 0, 0, 1]);
}

const close = (a: Mat4, b: Mat4) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("fitting landmark pairs", () => {
  it("recovers a rigid transform exactly", () => {
    const truth = rotationZ(30);
    const result = fit("rigid", points, points.map((p) => apply4(truth, p)));
    close(result.matrix, truth);
    expect(result.rms).toBeLessThan(1e-6);
    expect(describeMatrix(result.matrix).determinant).toBeCloseTo(1, 6);
  });

  it("recovers a scale with similarity, and rigid keeps scale 1", () => {
    const truth = rotationZ(-45, 1.5);
    const fixed = points.map((p) => apply4(truth, p));
    close(fit("similarity", points, fixed).matrix, truth);
    const rigid = fit("rigid", points, fixed);
    expect(describeMatrix(rigid.matrix).scales[0]).toBeCloseTo(1, 6);
    expect(rigid.rms).toBeGreaterThan(1);
  });

  it("recovers an affine transform, shear included", () => {
    const truth = Float64Array.from([1.1, 0.2, 0, 1, 0.1, 0.9, 0.3, -2, 0, -0.1, 1.2, 4, 0, 0, 0, 1]);
    close(fit("affine", points, points.map((p) => apply4(truth, p))).matrix, truth);
  });

  it("never fits a reflection with rigid", () => {
    const mirror = points.map((p) => [-p[0], p[1], p[2]] as Vec3);
    expect(describeMatrix(fit("rigid", points, mirror).matrix).determinant).toBeGreaterThan(0);
  });

  it("says when there are too few pairs, or they are flat", () => {
    expect(() => fit("affine", points.slice(0, 3), points.slice(0, 3))).toThrow(/at least 4/);
    const flat: Vec3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]];
    expect(() => fit("affine", flat, flat)).toThrow(/plane/);
  });

  it("translates by the centroids' difference", () => {
    const moved = points.map((p) => [p[0] + 1, p[1] - 2, p[2] + 3] as Vec3);
    const result = fit("translation", points, moved);
    [1, -2, 3].forEach((v, k) => expect(result.matrix[4 * k + 3]).toBeCloseTo(v, 9));
  });
});

describe("transform files", () => {
  const m = rotationZ(20, 1.2);

  it("round-trips plain text, ITK and LTA", () => {
    close(readPlain(writePlain(m)), m);
    close(readItk(writeItk(m)), m);
    close(readLta(writeLta(m)), m);
    close(readTransformFile("a.lta", writeLta(m)), m);
    close(readTransformFile("a.txt", writeItk(m)), m);
  });

  it("reads ITK about its centre, from fixed LPS to moving LPS", () => {
    // A pure translation of +5 mm in LPS x (fixed to moving) is -5 mm in RAS x, inverted: +5.
    const text = "#Insight Transform File V1.0\nTransform: AffineTransform_double_3_3\nParameters: 1 0 0 0 1 0 0 0 1 5 0 0\nFixedParameters: 10 20 30\n";
    const ras = readItk(text);
    expect([ras[3], ras[7], ras[11]].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([5, 0, 0]);
    close(multiply4(ras, invert4(ras)), Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  });

  it("refuses LTA files that need their volumes and do not carry them, and types it does not read", () => {
    expect(() => readLta("type = 0\n1 4 4\n1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n")).toThrow(/volumes' info/);
    expect(() => readLta("type = 14\n1 4 4\n1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n")).toThrow(/type 14/);
  });
});

describe("Neuroglancer's transform, in millimetres", async () => {
  const { physical, neuroglancer } = await import("../plugin.js");
  // A source in 2 µm voxels placed in a global space of 1 mm, shifted 3 mm in y.
  const t = {
    rank: 3,
    input: { names: ["x", "y", "z"], scales: [2e-6, 2e-6, 2e-6], units: ["m", "m", "m"] },
    output: { names: ["x", "y", "z"], scales: [1e-3, 1e-3, 1e-3], units: ["m", "m", "m"] },
    matrix: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]),
    defaultMatrix: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  };

  it("turns scale multiples into millimetres and back", () => {
    const p = physical(t)!;
    // One input mm (500 voxels) is one output mm; the shift is 3 mm.
    expect(apply4(p, [1, 0, 0])).toEqual([1, 3, 0]);
    neuroglancer(t, p).forEach((v, i) => expect(v).toBeCloseTo(t.matrix[i], 12));
  });
});

describe("MNI .xfm", () => {
  it("reads FreeSurfer's talairach.xfm as moving to fixed", async () => {
    const { readTransformFile } = await import("../formats.js");
    const text = "MNI Transform File\n% avi2talxfm\n\nTransform_Type = Linear;\nLinear_Transform =\n 1.1 0.02 -0.01 -2.5\n -0.03 1.05 0.2 -18\n 0.01 -0.15 1.2 3;\n";
    expect(Array.from(readTransformFile("talairach.xfm", text))).toEqual([1.1, 0.02, -0.01, -2.5, -0.03, 1.05, 0.2, -18, 0.01, -0.15, 1.2, 3, 0, 0, 0, 1]);
  });
});
