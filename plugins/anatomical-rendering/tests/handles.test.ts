import { describe, expect, it } from "vitest";
import { cropToDisplay, cutOffset, cutShape, displayToCrop, levelAxes, planeFromShape, planeShape } from "../handles.js";
import type { CameraPlane } from "../view.js";

/** Column-major display-from-physical for a display in mm, x y z (as `displayFromPhysical` gives for 1 mm dimensions). */
const mmDisplay = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Row-major voxel-to-RAS: 2 mm voxels, x flipped, from (100, −50, 10). */
const voxelToRas = [-2, 0, 0, 100, 0, 2, 0, -50, 0, 0, 2, 10, 0, 0, 0, 1];
const size = [50, 60, 70];

describe("crops as boxes in the views", () => {
  it("finds which display axis each voxel axis runs along", () => {
    const l = levelAxes(mmDisplay, voxelToRas)!;
    expect(l.axis).toEqual([0, 1, 2]);
    expect(l.scale).toEqual([-2, 2, 2]);
    expect(l.offset).toEqual([100, -50, 10]);
    // Turned 45° about z: not a box of the display's axes.
    const c = Math.SQRT1_2;
    expect(levelAxes(mmDisplay, [c, -c, 0, 0, c, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBeUndefined();
    // Axes swapped (x runs along display y) are fine.
    expect(levelAxes(mmDisplay, [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])!.axis).toEqual([1, 0, 2]);
  });

  it("puts a crop's fractions at the voxels the renderer keeps, and back", () => {
    const l = levelAxes(mmDisplay, voxelToRas)!;
    const box = cropToDisplay({ lo: [0, 0, 0.5], hi: [1, 0.5, 1] }, size, l);
    // x: voxel −0.5 at 101 mm, voxel 49.5 at 1 mm (flipped).
    expect(box.lower).toEqual([1, -51, 79]);
    expect(box.upper).toEqual([101, 9, 149]);
    const back = displayToCrop(box.lower, box.upper, size, l);
    back.lo.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 0.5][i]));
    back.hi.forEach((v, i) => expect(v).toBeCloseTo([1, 0.5, 1][i]));
  });

  it("keeps a crop within the volume and its ends apart", () => {
    const l = levelAxes(mmDisplay, voxelToRas)!;
    const crop = displayToCrop([-500, 0, 40], [500, 0, 40], size, l);
    expect(crop.lo[0]).toBe(0);
    expect(crop.hi[0]).toBe(1);
    expect(crop.hi[1] - crop.lo[1]).toBeCloseTo(0.005);
  });
});

describe("cut planes as planes in the views", () => {
  const plane: CameraPlane = { name: "Plane 1", on: true, normal: [0, 0, 2], point: [1, 2, 3], offset: 4 };

  it("shows a camera plane where its offset puts it", () => {
    expect(planeShape(plane, 2)).toEqual({ point: [1, 2, 5], normal: [0, 0, 1] });
  });

  it("moves a camera plane along its normal by its offset, and turns it about where it passes", () => {
    const moved = planeFromShape(plane, [1, 2, 8], [0, 0, 1], 2);
    expect(moved.offset).toBeCloseTo(10);
    expect(moved.point).toEqual([1, 2, 3]);
    const turned = planeFromShape(plane, [1, 2, 5], [1, 0, 0], 2);
    expect(turned.normal).toEqual([1, 0, 0]);
    expect(turned.offset).toBe(4);
    // Still through (1, 2, 5): its point 2 units back along the new normal.
    expect(planeShape(turned, 2).point).toEqual([1, 2, 5]);
  });

  it("moves an axis plane by its offset from the position", () => {
    const cut = { axis: "y" as const, keep: -1 as const, offset: 6, on: true };
    const shape = cutShape(cut, 1, [10, 20, 30], 2);
    expect(shape).toEqual({ point: [10, 23, 30], normal: [0, -1, 0] });
    expect(cutOffset([10, 25, 30], 1, [10, 20, 30], 2)).toBe(10);
  });
});
