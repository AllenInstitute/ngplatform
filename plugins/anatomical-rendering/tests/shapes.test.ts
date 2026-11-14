/**
 * Cuts in the views (the platform's in-view tools): each camera plane and
 * axis plane that is on is a plane shape while rendering; dragging one
 * writes what its slider does (quietly while moving, one change when let
 * go); a new camera plane faces the camera and is selected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { plugin, type Saved } from "../plugin.js";
import { fakeContext, frame3d, IMAGE, XYZ } from "./fake_context.js";

const active: ReturnType<typeof fakeContext>[] = [];

describe("cuts in the views", () => {
  let dom: FakeDom;
  beforeEach(() => {
    dom = fakeDocument();
  });
  afterEach(() => {
    for (const f of active.splice(0)) for (const off of f.ctx.subscriptions.splice(0)) off();
    dom.restore();
  });

  async function rendering(state: Partial<Saved> = {}) {
    const f = fakeContext({ layers: [IMAGE], axes: { brain: XYZ }, state: { on: true, layer: "brain", ...state }, hosts: ["workstation"] });
    active.push(f);
    // A 1 mm global space, x y z.
    Object.assign(f.ctx.viewer.getState(), { dimensions: { x: [1e-3, "m"], y: [1e-3, "m"], z: [1e-3, "m"] } });
    await plugin.activate(f.ctx);
    const host = dom.host();
    f.panels.get("anatomicalRendering.panel")!(host);
    await vi.waitFor(() => expect(f.drawers.length).toBeGreaterThan(0));
    f.drawers.at(-1)!.draw(frame3d());
    return { f, host };
  }

  const saved = (f: ReturnType<typeof fakeContext>) => f.ctx.state.get<Saved>()!;

  it("shows the planes that are on, and moves a camera plane along its normal by its offset", async () => {
    const plane = { name: "Plane 1", on: true, normal: [0, 0, 1] as [number, number, number], point: [1, 2, 3] as [number, number, number], offset: 0 };
    const { f } = await rendering({ planes: [plane, { ...plane, name: "Plane 2", on: false }] });
    expect(f.views.shapes.get("plane0")).toMatchObject({ kind: "plane", point: [1, 2, 3], normal: [0, 0, 1], label: "Plane 1" });
    expect(f.views.shapes.has("plane1")).toBe(false);
    f.views.drag("plane0", { point: [1, 2, 7], normal: [0, 0, 1] }, false);
    // While dragged: not written.
    expect(saved(f).planes[0].offset).toBe(0);
    f.views.drag("plane0", { point: [1, 2, 8], normal: [0, 0, 1] }, true);
    expect(saved(f).planes[0]).toMatchObject({ offset: 5, point: [1, 2, 3] });
    // Turned about where it passes.
    f.views.drag("plane0", { point: [1, 2, 8], normal: [1, 0, 0] }, true);
    expect(saved(f).planes[0].normal).toEqual([1, 0, 0]);
  });

  it("moves an axis plane by its offset from the position, without turning it", async () => {
    const cuts = [
      { axis: "x" as const, keep: -1 as const, offset: 0, on: false },
      { axis: "y" as const, keep: 1 as const, offset: 2, on: true },
      { axis: "z" as const, keep: -1 as const, offset: 0, on: false },
    ];
    const { f } = await rendering({ cuts });
    expect(f.views.shapes.get("cut1")).toMatchObject({ kind: "plane", point: [0, 2, 0], normal: [0, 1, 0], turns: false });
    f.views.drag("cut1", { point: [0, 6.5, 0], normal: [0, 1, 0] }, true);
    expect(saved(f).cuts[1].offset).toBe(6.5);
  });

  it("starts a new camera plane facing the camera, selected", async () => {
    const { f, host } = await rendering();
    dom.find(host, "button", "Add a camera plane").click();
    expect(saved(f).planes).toHaveLength(1);
    expect(f.views.selected()).toBe("plane0");
    expect(f.views.shapes.get("plane0")).toMatchObject({ kind: "plane", label: "Plane 1" });
  });
});
