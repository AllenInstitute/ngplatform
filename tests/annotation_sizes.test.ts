import { describe, expect, it } from "vitest";
import { ANNOTATION_SIZES, hasSize, sizeDefault, withSize } from "../src/engine/annotation_sizes.js";

const DEFAULT = "void main() {\n  setColor(defaultColor());\n}\n";

describe("annotation sizes as shader controls", () => {
  it("adds a fractional size's control and its calls, once", () => {
    const point = ANNOTATION_SIZES.point;
    expect(hasSize(DEFAULT, point)).toBe(false);
    expect(sizeDefault(DEFAULT, point)).toBe(5);
    const s = withSize(DEFAULT, point, 2.5);
    expect(hasSize(s, point)).toBe(true);
    expect(sizeDefault(s, point)).toBe(2.5);
    expect(s).toContain("setPointMarkerSize(point_size);");
    expect(s).toContain("setColor(defaultColor());");
    // Again: the default changes, nothing is added twice.
    const t = withSize(s, point, 0.75);
    expect(sizeDefault(t, point)).toBe(0.75);
    expect(t.match(/#uicontrol/g)).toHaveLength(1);
    expect(t.match(/setPointMarkerSize/g)).toHaveLength(1);
  });

  it("keeps both sizes apart, and leaves a shader without main() alone", () => {
    const s = withSize(withSize(DEFAULT, ANNOTATION_SIZES.point, 3), ANNOTATION_SIZES.line, 0.4);
    expect(sizeDefault(s, ANNOTATION_SIZES.line)).toBe(0.4);
    expect(sizeDefault(s, ANNOTATION_SIZES.point)).toBe(3);
    expect(s).toContain("setLineWidth(line_width);");
    expect(withSize("// nothing", ANNOTATION_SIZES.line, 2)).toBe("// nothing");
  });
});
