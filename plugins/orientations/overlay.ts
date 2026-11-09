/**
 * The canvas over the 2-D views that glyphs are drawn on: one WebGL2
 * context for every view, each drawn in its own viewport (clipped to it),
 * with a depth buffer so a glyph's near side hides its far side.  Redrawn
 * after each frame Neuroglancer draws, from each view's projection then, so
 * glyphs stay on their voxels while the view moves.
 *
 * The browser may take the context back (it keeps only so many, and
 * Neuroglancer, Luxar and Anatomical rendering hold some): the overlay then
 * says so in `problem`, and draws again when the context is given back;
 * a new overlay (a new canvas) asks for a context afresh.
 */
import type { GlyphSet } from "./glyphs.js";
import { GlyphRenderer } from "./render.js";
import type { Section } from "./view.js";

export interface PanelDraw {
  /** The view's rectangle, CSS pixels, relative to the overlay. */
  left: number;
  top: number;
  width: number;
  height: number;
  section: Section;
  sets: { set: GlyphSet; scale: number; depthRange: number }[];
}

/**
 * A view's section as clip space for its viewport: screen x and y as the
 * view has them, and depth along the normal over ±`depthRange` mm from the
 * section.  Column-major, from RAS mm.
 */
export function sectionClip(section: Section, depthRange: number): Float32Array {
  const m = section.toScreen;
  const { width: w, height: h, origin } = section;
  const dn = Math.hypot(m[8], m[9], m[10]) || 1;
  const depth0 = m[8] * origin[0] + m[9] * origin[1] + m[10] * origin[2] + m[11];
  const rows = [
    [(2 / w) * m[0], (2 / w) * m[1], (2 / w) * m[2], (2 / w) * m[3] - 1],
    [(-2 / h) * m[4], (-2 / h) * m[5], (-2 / h) * m[6], (-2 / h) * m[7] + 1],
    [m[8] / dn / depthRange, m[9] / dn / depthRange, m[10] / dn / depthRange, (m[11] - depth0) / dn / depthRange],
    [0, 0, 0, 1],
  ];
  const out = new Float32Array(16);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) out[4 * c + r] = rows[r][c];
  return out;
}

/** What the overlay says when its context is taken back. */
export const CONTEXT_LOST = "The 2-D glyphs stopped: the browser took back their drawing context.";

export class GlyphOverlay {
  readonly canvas = document.createElement("canvas");
  private readonly gl: WebGL2RenderingContext | null;
  private renderer: GlyphRenderer | undefined;
  problem: string | undefined;

  /** `changed` is called when the context is lost or given back: say so, and draw again. */
  constructor(host: HTMLElement, changed?: () => void) {
    this.canvas.className = "orientations-canvas";
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
    host.append(this.canvas);
    this.gl = this.canvas.getContext("webgl2", { alpha: true, depth: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false });
    if (this.gl === null) {
      this.problem = "This browser has no WebGL2 for the 2-D glyphs.";
      return;
    }
    this.renderer = new GlyphRenderer(this.gl, { color: 0 });
    // Asking for the context back (by preventing the default); its programs and buffers are gone, so a new renderer.
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.renderer = undefined;
      this.problem = CONTEXT_LOST;
      changed?.();
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.renderer = new GlyphRenderer(this.gl!, { color: 0 });
      this.problem = undefined;
      changed?.();
    });
  }

  /** Draws each view's glyph sets; nothing for an empty list. */
  draw(panels: PanelDraw[], lineWidth: number): void {
    const { gl, renderer, canvas } = this;
    if (gl === null || renderer === undefined) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const used: GlyphSet[] = [];
    gl.enable(gl.SCISSOR_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    for (const p of panels) {
      const x = Math.round(p.left * dpr);
      const y = Math.round(height - (p.top + p.height) * dpr);
      const w = Math.round(p.width * dpr);
      const h = Math.round(p.height * dpr);
      if (w <= 0 || h <= 0) continue;
      gl.viewport(x, y, w, h);
      gl.scissor(x, y, w, h);
      for (const { set, scale, depthRange } of p.sets) {
        used.push(set);
        renderer.draw(set, {
          matrix: sectionClip(p.section, depthRange),
          viewDir: p.section.normal,
          scale,
          viewport: [w, h],
          lineWidth: lineWidth * dpr,
          lift: 0,
        });
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    renderer.keepOnly(used);
  }

  dispose(): void {
    if (this.gl?.isContextLost() === false) this.renderer?.dispose();
    this.canvas.remove();
  }
}
