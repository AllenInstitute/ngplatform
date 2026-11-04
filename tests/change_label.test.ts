import { describe, expect, it } from "vitest";
import { describeChange, describeStep } from "../src/core/change_label.js";

const ws = (ng: object, app: object = {}) => ({ ng: ng as never, app: app as never });
const layer = (name: string, extra: object = {}) => ({ name, type: "image", source: "zarr://x", ...extra });

describe("describeChange", () => {
  it("names layer changes", () => {
    const a = ws({ layers: [layer("T1")] });
    expect(describeChange(a, ws({ layers: [layer("T1"), layer("Labels")] }))).toBe("Added Labels");
    expect(describeChange(a, ws({ layers: [] }))).toBe("Removed T1");
    expect(describeChange(a, ws({ layers: [layer("T1", { visible: false })] }))).toBe("Hid T1");
    expect(describeChange(a, ws({ layers: [layer("T1", { shader: "void main() {}" })] }))).toBe("T1: shader");
    expect(describeChange(a, ws({ layers: [layer("Brain")] }))).toBe("Renamed T1 to Brain");
  });

  it("names the view, the layout, plugin state and scenes", () => {
    expect(describeChange(ws({ layout: "xy" }), ws({ layout: "3d" }))).toBe("Layout: 3d");
    expect(describeChange(ws({ position: [0, 0, 0] }), ws({ position: [1, 0, 0] }))).toBe("Moved");
    expect(describeChange(ws({ projectionScale: 1 }), ws({ projectionScale: 2, position: [1] }))).toBe("Moved, Zoomed");
    expect(describeChange(ws({}, { trackFiltering: { a: 1 } }), ws({}, { trackFiltering: { a: 2 } }))).toBe("Track filtering");
    const scenes = (n: number) => ({ platform: { activeScene: "s1", scenes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Scene ${i}` })) } });
    expect(describeChange(ws({}, scenes(1)), ws({}, scenes(2)))).toBe("Added a scene");
    expect(describeChange(undefined, ws({}))).toBe("Opened");
  });
});

describe("describeStep", () => {
  const platform = {
    platform: {
      activeScene: "s2",
      scenes: [
        { id: "s1", name: "Scene 1" },
        { id: "s2", name: "Scene 2" },
      ],
      datasets: [{ id: "d1", name: "SRB 2026a", key: "zarr://x", source: "zarr://x", kind: "image" }],
    },
  };
  const viridis = "#uicontrol invlerp normalized\n// Colour map: viridis\nvoid main() {}";

  it("names the scene and the datasets a change touched", () => {
    const a = ws({ layers: [layer("SRB 2026a")] }, platform);
    expect(describeStep(a, ws({ layers: [layer("SRB 2026a", { shader: viridis })] }, platform))).toEqual({
      label: "SRB 2026a: colour map viridis",
      scene: "Scene 2",
      datasets: ["SRB 2026a"],
    });
    // A view of the dataset under another name still names the dataset.
    const b = ws({ layers: [layer("SRB (view)")] }, platform);
    expect(describeStep(b, ws({ layers: [layer("SRB (view)", { opacity: 0.5 })] }, platform)).datasets).toEqual(["SRB 2026a"]);
    expect(describeStep(a, ws({ layers: [layer("SRB 2026a")], layout: "3d" }, platform))).toEqual({ label: "Layout: 3d", scene: "Scene 2", datasets: [] });
  });

  it("names the scene added, removed, switched to or renamed", () => {
    const scenes = (active: string, ...names: string[]) => ({ platform: { activeScene: active, scenes: names.map((name, i) => ({ id: `s${i + 1}`, name })) } });
    expect(describeStep(ws({}, scenes("s1", "A")), ws({}, scenes("s2", "A", "B")))).toEqual({ label: "Added a scene", scene: "B" });
    expect(describeStep(ws({}, scenes("s1", "A", "B")), ws({}, scenes("s1", "A")))).toEqual({ label: "Removed a scene", scene: "B" });
    expect(describeStep(ws({}, scenes("s1", "A", "B")), ws({}, scenes("s2", "A", "B")))).toEqual({ label: "Switched scene", scene: "B" });
    expect(describeStep(ws({}, scenes("s1", "A", "B")), ws({}, scenes("s1", "A", "C")))).toEqual({ label: "Renamed a scene", scene: "C" });
  });
});
