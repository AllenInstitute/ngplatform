/**
 * Luxar switched off while an answer is still on its way: a segmentation's
 * `info`, read to learn whether its segments have meshes, that comes after
 * the plugin is off makes no view (no worker, no WebGL context), hides no
 * layer and writes no state.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformContext } from "@ngplatform/sdk";

// The splat worker's module is imported for its helpers, and sets `self.onmessage` as it loads.
vi.hoisted(() => {
  (globalThis as { self?: unknown }).self ??= globalThis;
});

import { Luxar } from "../plugin.js";
import { DEFAULT_STYLE } from "../style.js";

afterEach(() => vi.unstubAllGlobals());

/** A context with one precomputed segmentation, Luxar on for it, recording what is done to the viewer. */
function context() {
  const done = { hidden: [] as [string, boolean][], drawn: 0, workers: 0, writes: 0 };
  const shown = { all: false, size: 1, has: (id: bigint) => id === 5n, ids: () => BigUint64Array.from([5n]), notSelectedAlpha: 0 };
  const ctx = {
    state: { get: () => ({ layers: { seg: { ...DEFAULT_STYLE, on: true } } }), set: () => void done.writes++, onChanged: () => () => {} },
    viewer: {
      layers: () => [{ name: "seg", type: "segmentation", visible: true, ready: true, sources: ["precomputed://https://em.test/seg"] }],
      layerSpec: () => undefined,
      visibleSegments: () => shown,
      onSegmentsChanged: () => () => {},
      onLayersChanged: () => () => {},
      hideLayerDrawing: (name: string, hidden: boolean) => void done.hidden.push([name, hidden]),
      setTemporaryBackground: () => {},
      draw3d: () => {
        done.drawn++;
        return { redraw() {}, dispose() {} };
      },
      getState: () => ({}),
      panels: () => [],
    },
    workspace: { onChanged: () => () => {}, selectedLayer: () => undefined },
    context: { set: () => {} },
  };
  return { ctx: ctx as unknown as PlatformContext, done };
}

describe("Luxar switched off", () => {
  it("ignores a segmentation's info that comes after: no view, no worker, the layer not hidden", async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", (url: string) => {
      expect(url).toBe("https://em.test/seg/info");
      return new Promise<Response>((resolve) => (answer = resolve));
    });
    const { ctx, done } = context();
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          done.workers++;
        }
        postMessage() {}
        terminate() {}
      },
    );
    const luxar = new Luxar(ctx);
    // The info is being read: nothing drawn yet.
    expect(done.drawn).toBe(0);
    luxar.dispose();
    answer(new Response(JSON.stringify({ type: "segmentation", mesh: "mesh" })));
    await new Promise((r) => setTimeout(r, 0));
    expect(done.workers).toBe(0);
    expect(done.drawn).toBe(0);
    expect(done.hidden.filter(([, hidden]) => hidden)).toEqual([]);
    // A setting changed afterwards (the panel's deferred ones) is not written either.
    luxar.setStyle("seg", { on: false });
    expect(done.writes).toBe(0);
  });
});
