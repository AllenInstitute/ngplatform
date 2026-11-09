/**
 * What the drawer and the browser's renderer hold, let go: bitmaps of
 * frames replaced before they were drawn, and the brick bounds worked out
 * in slabs so the page goes on answering.
 */
import { describe, expect, it, vi } from "vitest";
import { PictureDrawer } from "../draw.js";
import { brickBounds } from "../local/local.js";

const bitmap = () => ({ width: 2, height: 2, close: vi.fn() }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };

describe("the drawer's frames", () => {
  it("lets go of a frame replaced before it was drawn, and of all it holds when disposed", () => {
    const d = new PictureDrawer();
    const a = bitmap(), b = bitmap();
    d.set({ bitmap: a });
    d.set({ bitmap: b });
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).not.toHaveBeenCalled();
    d.set(undefined);
    expect(b.close).toHaveBeenCalledOnce();
    const c = bitmap();
    d.set({ bitmap: c });
    d.dispose();
    expect(c.close).toHaveBeenCalledOnce();
  });
});

describe("brick bounds in this browser", () => {
  it("are each brick's least and greatest value with a voxel around it, worked out a slab at a time", async () => {
    // 8 × 4 × 4 voxels, bricks of 4: two bricks along x.  One bright voxel at x = 4 (the second brick's first).
    const size = [8, 4, 4];
    const data = new Uint8Array(8 * 4 * 4);
    data[(1 * 4 + 1) * 8 + 4] = 255;
    const b = await brickBounds(data, size, 4);
    expect(Array.from(b)).toEqual([0, 1, 0, 1]);
    // Without the voxel of overlap the first brick would stay dark; with it, it sees x = 4 from x = 3.
    data[(1 * 4 + 1) * 8 + 4] = 0;
    data[(1 * 4 + 1) * 8 + 6] = 255;
    expect(Array.from(await brickBounds(data, size, 4))).toEqual([0, 0, 0, 1]);
  });

  it("stops when asked (the image closed while it worked)", async () => {
    // Slabs of about 4 M voxels: a 2048² image is one slice a slab, so a second slab waits for the page.
    const size = [2048, 2048, 2];
    let asked = 0;
    const b = await brickBounds(new Uint8Array(2048 * 2048 * 2).fill(9), size, 4, () => ++asked > 1);
    expect(asked).toBe(2);
    // It stopped before the second slab, after reading the first.
    expect(Array.from(b.slice(0, 2))).toEqual([9 / 255, 9 / 255].map((x) => Math.fround(x)));
  });
});
