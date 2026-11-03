/** The "under the cursor" line: what one voxel holds, in words. */
import { describe, expect, it } from "vitest";
import type { GlyphOptions } from "../glyphs.js";
import { describeVoxel } from "../readout.js";
import { fibreOdf } from "./synthetic.js";

const options = (patch: Partial<GlyphOptions>): GlyphOptions => ({
  kind: "sh",
  basis: "descoteaux07-legacy",
  tensorOrder: "fsl",
  toData: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  normalise: "minmax",
  tensorGlyph: "ellipsoid",
  subdivisions: 2,
  ...patch,
});

describe("readout", () => {
  it("gives a tensor's FA, MD, eigenvalues and principal direction", () => {
    const line = describeVoxel([0.3e-3, 0, 0, 1.7e-3, 0, 0.3e-3], 6, options({ kind: "tensor" }));
    expect(line).toMatch(/^FA 0\.(799|8), MD 7\.67e-4, λ 1\.70e-3 \/ 3\.00e-4 \/ 3\.00e-4, V1 \((-?0\.00|0), (-?1\.00), (-?0\.00|0)\)$/);
  });

  it("gives an ODF's GFA and its peaks", () => {
    const c = fibreOdf([[1, 0, 0], [0, 1, 0]], "descoteaux07-legacy", 8);
    const line = describeVoxel(c, 45, options({}));
    expect(line).toMatch(/^GFA 0\.\d+; peaks \(.+\) 1, \(.+\) (1|0\.\d+)$/);
  });

  it("gives a vector's direction and length, flips applied", () => {
    expect(describeVoxel([0, 3, 4], 3, options({ kind: "vector", toData: [1, 0, 0, 0, -1, 0, 0, 0, 1] }))).toBe("(0.00, -0.60, 0.80) × 5");
    expect(describeVoxel([0, 0, 0], 3, options({ kind: "vector" }))).toBe("nothing here");
  });
});
