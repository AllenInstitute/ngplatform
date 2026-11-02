import { describe, expect, it } from "vitest";
import { MAX_EMBEDDED, OUTLINE_MARKER, outlineOf, outlineShader, type OutlineOptions } from "../src/engine/outline_shader.js";

const base: OutlineOptions = {
  layer: 'aseg "left"',
  dataType: "uint16",
  seed: 0,
  saturation: 1,
  hideSegmentZero: true,
  stated: [],
  fill: [0.5, 0],
};

describe("segmentation outlines", () => {
  it("names its segmentation layer and the fill it took over, which read back", () => {
    const shader = outlineShader({ ...base, fill: [0.75, 0.1] });
    expect(shader.startsWith(OUTLINE_MARKER)).toBe(true);
    expect(outlineOf(shader)).toEqual({ layer: 'aseg "left"', fill: [0.75, 0.1] });
    expect(outlineOf("void main() {}")).toBeUndefined();
  });

  it("compares a voxel with its neighbours along the section's own axes, a set number of pixels away", () => {
    const shader = outlineShader(base);
    expect(shader).toContain("vec3 dx = dFdx(p) * outline_width;");
    expect(shader).toContain("outlineLabelAt(p + dx) != v");
    expect(shader).toContain("outlineLabelAt(p - dy) != v");
    expect(shader).toContain("#uicontrol float outline_width slider(");
    expect(shader).toContain("#uicontrol float fill_opacity slider(");
    // Small integer labels are read through toRaw; uint64 as its two words.
    expect(shader).toContain("uvec2(uint(toRaw(getDataValueAt(p))), 0u)");
    expect(outlineShader({ ...base, dataType: "uint64" })).toContain("return getDataValueAt(p).value;");
    // Background 0 hidden only when the layer hides it.
    expect(shader).toContain("if (v == uvec2(0u))");
    expect(outlineShader({ ...base, hideSegmentZero: false })).not.toContain("if (v == uvec2(0u))");
  });

  it("colours by Neuroglancer's hash with the layer's seed, or one fixed colour", () => {
    const hashed = outlineShader({ ...base, seed: 1234 });
    expect(hashed).toContain("outlineHashCombine(outlineHashCombine(1234u, v.x), v.y)");
    const fixed = outlineShader({ ...base, fixed: [1, 0, 0.5] });
    expect(fixed).not.toContain("outlineHashColour");
    expect(fixed).toContain("return vec3(1.0, 0.0, 0.5);");
  });

  it("hashes ids to the colours Neuroglancer gives them (the shader's steps, in JavaScript)", async () => {
    // Neuroglancer's SegmentColorHash.compute (segment_color.ts, which needs WebGL to import), from its parts.
    const { hashCombine } = await import("neuroglancer/unstable/gpu_hash/hash_function.js");
    const { hsvToRgb } = await import("neuroglancer/unstable/util/colorspace.js");
    class SegmentColorHash {
      constructor(readonly seed: number) {}
      compute(out: Float32Array, x: bigint) {
        const h = hashCombine(hashCombine(this.seed, Number(x & 0xffffffffn)), Number(x >> 32n));
        hsvToRgb(out, (h & 0xff) / 255, 0.5 + 0.5 * (((h >> 8) & 0xff) / 255), 1.0);
        return out;
      }
    }
    const mix = (state: number, value: number) => {
      value = Math.imul(value >>> 0, 0xcc9e2d51) >>> 0;
      value = ((value << 15) | (value >>> 17)) >>> 0;
      value = Math.imul(value, 0x1b873593) >>> 0;
      state = (state ^ value) >>> 0;
      state = ((state << 13) | (state >>> 19)) >>> 0;
      return (Math.imul(state, 5) + 0xe6546b64) >>> 0;
    };
    const shaderColour = (seed: number, id: bigint) => {
      const h = mix(mix(seed, Number(id & 0xffffffffn)), Number(id >> 32n));
      const hue = (h & 0xff) / 255;
      const s = 0.5 + (((h >>> 8) & 0xff) / 255) * 0.5;
      const clamp = (x: number) => Math.min(1, Math.max(0, x));
      const rgb = [clamp(Math.abs(hue * 6 - 3) - 1), clamp(2 - Math.abs(hue * 6 - 2)), clamp(2 - Math.abs(hue * 6 - 4))];
      return rgb.map((c) => (c - 1) * s + 1);
    };
    for (const seed of [0, 1234, 0xdeadbeef]) {
      const hash = new SegmentColorHash(seed);
      for (const id of [1n, 17n, 864691135610744327n, (1n << 40n) + 7n]) {
        const expected = Array.from(hash.compute(new Float32Array(3), id));
        shaderColour(seed, id).forEach((c, i) => expect(c).toBeCloseTo(expected[i], 5));
      }
    }
    // And the shader holds those steps.
    expect(outlineShader(base)).toContain("float saturation = 0.5 + float((h >> 8u) & 0xFFu) / 255.0 * 0.5;");
  });

  it("writes stated colours and visible segments in, sorted for a binary search", () => {
    const big = (1n << 40n) + 7n;
    const shader = outlineShader({
      ...base,
      stated: [
        [17n, [0.86, 0.85, 0.08]],
        [2n, [0.96, 0.96, 0.96]],
        [big, [0, 0, 1]],
      ],
      visible: [17n, 2n],
    });
    expect(shader).toContain("const uvec2 outlineStated[3] = uvec2[3](\n  uvec2(2u, 0u),\n  uvec2(17u, 0u),\n  uvec2(7u, 256u));");
    expect(shader).toContain("vec3(0.96, 0.96, 0.96),\n  vec3(0.86, 0.85, 0.08),\n  vec3(0.0, 0.0, 1.0)");
    expect(shader).toContain("const uvec2 outlineVisible[2]");
    expect(shader).toContain("if (outlineVisibleIndex(v) < 0)");
  });

  it("leaves out tables too large to write in", () => {
    const many: [bigint, [number, number, number]][] = Array.from({ length: MAX_EMBEDDED + 1 }, (_, i) => [BigInt(i + 1), [0, 0, 0]]);
    const shader = outlineShader({ ...base, stated: many, visible: many.map(([id]) => id) });
    expect(shader).not.toContain("outlineStated");
    expect(shader).not.toContain("outlineVisible");
  });
});
