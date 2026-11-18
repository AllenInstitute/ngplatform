import { describe, expect, it } from "vitest";
import { cameraFromInverse, framesFor, keyframeCount, lookAt, rotationCount, rotationFrames } from "../movie_camera.js";
import { invert4 } from "../draw.js";

const camA = { eye: [10, -40, 5] as [number, number, number], target: [10, 0, 5] as [number, number, number], up: [0, 0, 1] as [number, number, number], fovy: 30 };
const camB = { eye: [50, 0, 5] as [number, number, number], target: [10, 0, 5] as [number, number, number], up: [0, 0, 1] as [number, number, number], fovy: 30 };
const invOf = (c: typeof camA, aspect = 1.5) => invert4(lookAt(c, aspect, 2, 200));
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-3) => Array.from(a).every((v, i) => Math.abs(v - b[i]) < eps * Math.max(1, Math.abs(b[i])));

describe("a movie's cameras here", () => {
  it("takes a view apart into the camera it was made from", () => {
    const { camera, aspect, near, far } = cameraFromInverse(invOf(camA), camA.target);
    expect(close(camera.eye, camA.eye)).toBe(true);
    expect(close(camera.target, camA.target)).toBe(true);
    expect(close(camera.up, camA.up)).toBe(true);
    expect(camera.fovy).toBeCloseTo(30, 3);
    expect(aspect).toBeCloseTo(1.5, 4);
    expect(near).toBeCloseTo(2, 3);
    expect(far).toBeCloseTo(200, 1);
  });

  it("starts and ends at the keyframes, and orbits the target between them", () => {
    const frames = framesFor([{ time: 0, inv: invOf(camA), center: camA.target }, { time: 2, inv: invOf(camB), center: camB.target }], 10, "smooth", 1.5);
    expect(frames.length).toBe(keyframeCount([0, 2], 10));
    expect(frames.length).toBe(21);
    expect(close(frames[0].invViewProjection, invOf(camA))).toBe(true);
    expect(close(frames[20].invViewProjection, invOf(camB))).toBe(true);
    // Half way: the eye a quarter turn about the target, at the same distance.
    const mid = cameraFromInverse(frames[10].invViewProjection, camA.target).camera;
    expect(Math.hypot(mid.eye[0] - 10, mid.eye[1], mid.eye[2] - 5)).toBeCloseTo(40, 2);
    expect(close(mid.eye, [10 + 40 * Math.SQRT1_2, -40 * Math.SQRT1_2, 5])).toBe(true);
  });

  it("turns about the centre, a full circle leaving out its last", () => {
    expect(rotationCount(360, 2)).toBe(180);
    expect(rotationCount(180, 2)).toBe(91);
    const f = rotationFrames(invOf(camA), camA.target, "vertical", 360, 90, 1.5);
    expect(f.length).toBe(4);
    const eyes = f.map((v) => cameraFromInverse(v.invViewProjection, camA.target).camera.eye);
    expect(close(eyes[0], camA.eye)).toBe(true);
    // A quarter turn about +z (the up) takes -y to +x.
    expect(close(eyes[1], [50, 0, 5])).toBe(true);
  });
});
