/**
 * The GL code without a GPU (./fake_gl.ts): the glyph sets' buffers and
 * coefficient textures as the renderer lays them out, the shaders it
 * writes declaring every uniform it sets and fed every attribute they take,
 * the 3-D view's extra outputs, buffers let go, and the 2-D overlay's
 * lost and restored context.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDocument } from "@ngplatform/sdk/testing";
import type { GlyphSet } from "../glyphs.js";
import { CONTEXT_LOST, GlyphOverlay, sectionClip } from "../overlay.js";
import { type DrawParams, GlyphRenderer } from "../render.js";
import type { Section } from "../view.js";
import { type FakeGl, type FakeProgram, fakeGl } from "./fake_gl.js";

const PARAMS: DrawParams = {
  matrix: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  viewDir: [0, 0, 1],
  scale: 1,
  viewport: [100, 100],
  lineWidth: 2,
  lift: 0,
};

/** Coefficients per ODF of order 4: 15 monomials. */
const N4 = 15;

function odfs(count: number): GlyphSet {
  return {
    shape: "odfs",
    count,
    centres: new Float32Array(3 * count),
    coefficients: Float32Array.from({ length: N4 * count }, (_, i) => i + 1),
    lmax: 4,
    bounds: new Float32Array(count).fill(1),
    toData: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };
}

const ellipsoids = (count: number): GlyphSet => ({ shape: "ellipsoids", count, centres: new Float32Array(3 * count), axes: new Float32Array(9 * count), colours: new Float32Array(3 * count) });
const lines = (count: number): GlyphSet => ({ shape: "lines", count, centres: new Float32Array(3 * count), dirs: new Float32Array(3 * count), colours: new Float32Array(3 * count) });

const source = (p: FakeProgram) => p.shaders.map((s) => s.source).join("\n");

/** The uniforms a program's shaders declare, and the attribute locations its vertex shader takes. */
function declared(p: FakeProgram): { uniforms: Set<string>; attributes: Set<number> } {
  const text = source(p);
  const uniforms = new Set([...text.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]));
  const vs = p.shaders[0].source;
  const attributes = new Set([...vs.matchAll(/layout\(location = (\d+)\) in /g)].map((m) => Number(m[1])));
  return { uniforms, attributes };
}

function drawAll(f: FakeGl, outputs = { color: 0 }): GlyphRenderer {
  const r = new GlyphRenderer(f.gl, outputs);
  for (const set of [odfs(3), ellipsoids(2), lines(4)]) r.draw(set, PARAMS);
  return r;
}

describe("drawing glyph sets", () => {
  it("lays ODF coefficients in rows of texels no wider than a texture may be", () => {
    // 15 coefficients are 4 RGBA texels; a texture 8 texels wide holds 2 glyphs a row.
    const f = fakeGl({ maxTexture: 8 });
    new GlyphRenderer(f.gl, { color: 0 }).draw(odfs(3), PARAMS);
    const [args] = f.named("texImage2D");
    const [, , , width, rows, , , , data] = args as [number, number, number, number, number, number, number, number, Float32Array];
    expect([width, rows]).toEqual([8, 2]);
    expect(data.length).toBe(4 * 8 * 2);
    // Glyph 1 starts at texel 4 of row 0, glyph 2 at texel 0 of row 1.
    expect(Array.from(data.subarray(16, 16 + N4))).toEqual(Array.from({ length: N4 }, (_, i) => N4 + i + 1));
    expect(Array.from(data.subarray(4 * 8, 4 * 8 + N4))).toEqual(Array.from({ length: N4 }, (_, i) => 2 * N4 + i + 1));
    // Told how many glyphs a row holds, and drawn as one instance each.
    const perRow = f.named("uniform1i").find(([loc]) => (loc as { name: string }).name === "uPerRow");
    expect(perRow?.[1]).toBe(2);
    expect(f.named("drawArraysInstanced")[0]).toEqual([f.gl.TRIANGLES, 0, 6, 3]);
  });

  it("writes shaders that declare every uniform it sets, and feeds every attribute they take", () => {
    const f = fakeGl();
    drawAll(f);
    expect(f.programs).toHaveLength(3);
    for (const p of f.programs) {
      expect(p.shaders.map((s) => s.source.startsWith("#version 300 es"))).toEqual([true, true]);
      const { uniforms, attributes } = declared(p);
      const used = f.uniforms.filter((u) => u.program === p).map((u) => u.name);
      expect(used.length).toBeGreaterThan(0);
      for (const name of used) expect(uniforms, `${name} in program ${f.programs.indexOf(p)}`).toContain(name);
      // Every input the vertex shader declares is fed (ODFs are fed a colour they do not take, which GL ignores).
      for (const k of attributes) expect(f.attributes.get(p), `attribute ${k}`).toContain(k);
    }
    // ODFs read their coefficients from a texture, by glyph.
    const odf = f.programs.find((p) => declared(p).uniforms.has("uCoefficients"))!;
    expect([...declared(odf).uniforms]).toEqual(expect.arrayContaining(["uToData", "uPerRow", "uInverse", "uViewport"]));
  });

  it("writes the 3-D view's depth and pick outputs where it says", () => {
    const f = fakeGl();
    drawAll(f, { color: 0, z: 1, pick: 2 } as never);
    for (const p of f.programs) {
      const fs = p.shaders[1].source;
      expect(fs).toContain("layout(location = 1) out highp vec4 out_z;");
      expect(fs).toContain("layout(location = 2) out highp vec4 out_pickId;");
    }
    const plain = fakeGl();
    drawAll(plain);
    for (const p of plain.programs) expect(p.shaders[1].source).not.toContain("out_z");
  });

  it("makes a set's buffers once a context, and lets go of those no longer drawn", () => {
    const f = fakeGl();
    const r = new GlyphRenderer(f.gl, { color: 0 });
    const a = lines(2);
    const b = ellipsoids(2);
    r.draw(a, PARAMS);
    r.draw(a, PARAMS);
    r.draw(b, PARAMS);
    // A vertex array, centres, colours and directions for each.
    expect(f.objects).toHaveLength(8);
    r.keepOnly([b]);
    expect(f.objects.filter((o) => o.deleted)).toHaveLength(4);
    r.dispose();
    expect(f.objects.every((o) => o.deleted)).toBe(true);
    expect(f.programs.every((p) => p.deleted)).toBe(true);
  });

  it("draws nothing for an empty set", () => {
    const f = fakeGl();
    new GlyphRenderer(f.gl, { color: 0 }).draw(lines(0), PARAMS);
    expect(f.named("drawArraysInstanced")).toHaveLength(0);
    expect(f.programs).toHaveLength(0);
  });
});

describe("the 2-D views' overlay", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** An overlay whose canvas answers with a fake context (or none). */
  function overlay(withGl = true) {
    const dom = fakeDocument();
    const f = fakeGl();
    const create = dom.document.createElement.bind(dom.document);
    (dom.document as { createElement: unknown }).createElement = (tag: string) => {
      const e = create(tag) as HTMLElement & { getContext?: unknown };
      if (tag === "canvas") e.getContext = () => (withGl ? f.gl : null);
      return e;
    };
    const changed = vi.fn();
    const o = new GlyphOverlay(dom.host(), changed);
    return { dom, f, o, changed };
  }

  it("places a section's points in its viewport's clip space", () => {
    // A 200 × 100 view, 2 px a mm, x to the right and y up the screen, the origin at its centre.
    const section: Section = { toScreen: [2, 0, 0, 100, 0, -2, 0, 50, 0, 0, 1, 0], width: 200, height: 100, origin: [0, 0, 0], normal: [0, 0, 1], pxPerMm: 2 };
    const m = sectionClip(section, 4);
    const clip = (p: number[]) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    expect(clip([0, 0, 0]).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 0]);
    for (const v of clip([50, 25, 4])) expect(v).toBeCloseTo(1, 6);
  });

  it("says when the browser has no WebGL2", () => {
    const { dom, o } = overlay(false);
    expect(o.problem).toMatch(/no WebGL2/);
    o.draw([], 1);
    dom.restore();
  });

  it("says when its context is lost, and draws again when it is given back", () => {
    const { dom, f, o, changed } = overlay();
    expect(o.problem).toBeUndefined();
    f.lose();
    // Asking for it back: the default (giving it up for good) prevented.
    expect(dom.fire(o.canvas, "webglcontextlost")).toBe(false);
    expect(o.problem).toBe(CONTEXT_LOST);
    expect(changed).toHaveBeenCalledTimes(1);
    const before = f.calls.length;
    o.draw([], 1);
    expect(f.calls.length).toBe(before);
    f.lose(false);
    dom.fire(o.canvas, "webglcontextrestored");
    expect(o.problem).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    o.draw([], 1);
    expect(f.named("clear")).toHaveLength(1);
    o.dispose();
    dom.restore();
  });
});
