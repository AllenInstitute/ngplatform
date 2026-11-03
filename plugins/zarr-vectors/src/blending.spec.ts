/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from "vitest";
import {
  emitsPremultipliedAlpha,
  glslZvEmit,
  linesDrawVertexDiscs,
} from "./blending.js";

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

/** What `zvEmit(rgb, alpha)` emits, read from its GLSL. */
function emitted(glsl: string, rgb: RGB, alpha: number): RGBA {
  const m = glsl.match(/emit\(vec4\(([^,]+), alpha\), pickId\)/);
  if (m === null) throw new Error(`no emit in ${glsl}`);
  const expr = m[1].trim();
  if (expr === "rgb") return [...rgb, alpha];
  if (expr === "rgb * alpha") return [...rgb.map((c) => c * alpha), alpha] as RGBA;
  throw new Error(`unexpected colour ${expr}`);
}

/** A cross-section's blending: SRC_ALPHA, ONE_MINUS_SRC_ALPHA. */
function sliceViewComposite(src: RGBA, dst: RGB): RGB {
  return dst.map((d, i) => src[i] * src[3] + d * (1 - src[3])) as RGB;
}

/**
 * The 3-d view's transparent pass for one fragment: weighted blended OIT
 * (accumulate colour * weight and alpha * weight, revealage 1 - alpha), then
 * resolved over the opaque image with ONE_MINUS_SRC_ALPHA, SRC_ALPHA.
 */
function perspectiveOITComposite(src: RGBA, dst: RGB): RGB {
  const weight = 3.7;
  const accum = src.map((c) => c * weight);
  const revealage = 1 - src[3];
  const colour = accum.slice(0, 3).map((c) => c / accum[3]);
  return dst.map((d, i) => colour[i] * (1 - revealage) + d * revealage) as RGB;
}

/** Colour `rgb` at opacity `alpha` laid over `dst`, as it should look. */
function over(rgb: RGB, alpha: number, dst: RGB): RGB {
  return dst.map((d, i) => rgb[i] * alpha + d * (1 - alpha)) as RGB;
}

describe("zvEmit", () => {
  const colour: RGB = [1, 0.4, 0.1];
  const backgrounds: RGB[] = [
    [0, 0, 0],
    [0.5, 0.5, 0.5],
    [1, 1, 1],
  ];

  it("emits straight colour in a cross-section and premultiplied in 3-d", () => {
    expect(emitsPremultipliedAlpha(true)).toBe(false);
    expect(emitsPremultipliedAlpha(false)).toBe(true);
  });

  it("fades a cross-section's colour into what is behind it, without darkening", () => {
    const glsl = glslZvEmit(emitsPremultipliedAlpha(true));
    for (const alpha of [1, 0.5, 0.2, 0.05]) {
      for (const dst of backgrounds) {
        const got = sliceViewComposite(emitted(glsl, colour, alpha), dst);
        const want = over(colour, alpha, dst);
        got.forEach((c, i) => expect(c).toBeCloseTo(want[i], 6));
      }
    }
  });

  it("fades 3-d colour into what is behind it, neither darker nor brighter", () => {
    const glsl = glslZvEmit(emitsPremultipliedAlpha(false));
    for (const alpha of [1, 0.5, 0.2, 0.05]) {
      for (const dst of backgrounds) {
        const got = perspectiveOITComposite(emitted(glsl, colour, alpha), dst);
        const want = over(colour, alpha, dst);
        got.forEach((c, i) => expect(c).toBeCloseTo(want[i], 6));
      }
    }
  });

  it("would darken a cross-section if premultiplied (the old behaviour)", () => {
    const glsl = glslZvEmit(true);
    const got = sliceViewComposite(emitted(glsl, colour, 0.5), [0, 0, 0]);
    expect(got[0]).toBeCloseTo(0.25, 6);
    expect(over(colour, 0.5, [0, 0, 0])[0]).toBeCloseTo(0.5, 6);
  });
});

describe("linesDrawVertexDiscs", () => {
  it("draws the points asked for, in every view", () => {
    for (const targetIsSliceView of [true, false]) {
      for (const transparent of [true, false]) {
        expect(
          linesDrawVertexDiscs({ linesAndPoints: true, targetIsSliceView, transparent }),
        ).toBe(true);
      }
    }
  });

  it("leaves lines alone without discs wherever colour is blended", () => {
    // A cross-section always blends.
    for (const transparent of [true, false]) {
      expect(
        linesDrawVertexDiscs({ linesAndPoints: false, targetIsSliceView: true, transparent }),
      ).toBe(false);
    }
    // 3-d at partial opacity: the transparent pass.
    expect(
      linesDrawVertexDiscs({ linesAndPoints: false, targetIsSliceView: false, transparent: true }),
    ).toBe(false);
  });

  it("fills the bends of opaque lines in 3-d", () => {
    expect(
      linesDrawVertexDiscs({ linesAndPoints: false, targetIsSliceView: false, transparent: false }),
    ).toBe(true);
  });
});
