import { describe, expect, it } from "vitest";
import { describeChange } from "../src/core/change_label.js";

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
