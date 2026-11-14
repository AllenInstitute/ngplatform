/**
 * The pointer's position as Neuroglancer writes it ("x 12  y 34  z 5"),
 * read into names and values for the readout with units (src/ui/pointer_readout.ts).
 */
import { describe, expect, it } from "vitest";
import { parsePointerText } from "../src/ui/pointer_readout.js";

describe("the pointer's position", () => {
  it("is read as names and values, a minus sign for a negative one", () => {
    expect(parsePointerText("x -137  y 80  z 9")).toEqual([
      { name: "x", value: "−137" },
      { name: "y", value: "80" },
      { name: "z", value: "9" },
    ]);
  });

  it("is nothing while the pointer is off the views, or when the text is not as expected", () => {
    expect(parsePointerText("")).toEqual([]);
    expect(parsePointerText("something else entirely")).toEqual([]);
  });
});
