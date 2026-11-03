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

/**
 * How the dense layer's colours meet what is behind them.
 *
 * Neuroglancer's panels composite differently.  A cross-section blends each
 * fragment with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`: it takes colour as is
 * (straight alpha) and multiplies it by alpha itself.  The 3-d view's
 * transparent pass (weighted blended order-independent transparency) takes
 * colour already multiplied by alpha (premultiplied), and divides the sum of
 * colours by the sum of alphas.  Colour premultiplied for a cross-section is
 * multiplied by alpha twice (at opacity 0.5 a quarter of its colour, so it
 * darkens before it fades); colour not premultiplied in 3-d comes out
 * divided by alpha (brighter as opacity falls).
 */

/** Whether a pass emits colour premultiplied by alpha: in 3-d, not in a cross-section. */
export function emitsPremultipliedAlpha(targetIsSliceView: boolean): boolean {
  return !targetIsSliceView;
}

/**
 * GLSL for `zvEmit(rgb, alpha, pickId)`, which emits colour `rgb` at opacity
 * `alpha` (the object's opacity times the fragment's coverage) as the panel
 * composites it.  Needs the panel's `emit`.
 */
export function glslZvEmit(premultiplied: boolean): string {
  return `
void zvEmit(vec3 rgb, float alpha, highp uint pickId) {
  emit(vec4(${premultiplied ? "rgb * alpha" : "rgb"}, alpha), pickId);
}
`;
}

/**
 * Whether a layer of lines draws a disc at each vertex as well as its
 * segments.  Lines and points always do (the points are what is asked for).
 * Lines alone do only where nothing is blended (3-d drawn opaque), where a
 * disc as wide as the line fills the notch at each bend of a wide line.
 * Where colour is blended (every cross-section, the 3-d view's transparent
 * pass) a vertex's disc lays its colour over the segments' a second time,
 * and every vertex shows as a dot, the more so the lower the opacity.
 */
export function linesDrawVertexDiscs(options: {
  linesAndPoints: boolean;
  targetIsSliceView: boolean;
  transparent: boolean;
}): boolean {
  if (options.linesAndPoints) return true;
  return !options.targetIsSliceView && !options.transparent;
}
