import { describe, expect, it } from "vitest";
import { computeMask, countPassing, emptyFilter, histogram, passingIds, tagCounts, toCsv } from "../filter.js";
import type { SegmentProperties } from "@ngplatform/sdk";

const props: SegmentProperties = {
  ids: new BigUint64Array([10n, 11n, 12n, 13n, 14n]),
  numeric: [
    { id: "length", description: "mm", values: new Float32Array([5, 20, 40, NaN, 80]), min: 5, max: 80 },
    { id: "fa", description: undefined, values: new Float32Array([0.1, 0.5, 0.4, 0.9, 0.3]), min: 0.1, max: 0.9 },
  ],
  // Tags 0 = CST, 1 = AF, 2 = "odd, name".
  tags: { names: ["CST", "AF", "odd, name"], descriptions: ["", "", ""], values: ["\u0000", "\u0001", "\u0000\u0002", "", "\u0001"] },
};

describe("track filtering", () => {
  it("passes everything with no filter", () => {
    expect(countPassing(computeMask(props, emptyFilter()))).toBe(5);
  });

  it("keeps values inside every range, and never a missing one", () => {
    const mask = computeMask(props, { ...emptyFilter(), ranges: { length: [10, 80], fa: [0.3, 1] } });
    expect(Array.from(mask)).toEqual([0, 1, 1, 0, 1]);
    expect(Array.from(passingIds(props, mask))).toEqual([11n, 12n, 14n]);
  });

  it("keeps objects in any ticked group, and drops excluded ones", () => {
    expect(Array.from(computeMask(props, { ...emptyFilter(), includeTags: ["CST"] }))).toEqual([1, 0, 1, 0, 0]);
    expect(Array.from(computeMask(props, { ...emptyFilter(), includeTags: ["CST", "AF"] }))).toEqual([1, 1, 1, 0, 1]);
    expect(Array.from(computeMask(props, { ...emptyFilter(), excludeTags: ["odd, name"] }))).toEqual([1, 1, 0, 1, 1]);
    // A ticked group no object has passes nothing.
    expect(countPassing(computeMask({ ...props, tags: undefined }, { ...emptyFilter(), includeTags: ["CST"] }))).toBe(0);
  });

  it("bins finite values, optionally only the passing ones", () => {
    expect(Array.from(histogram(props.numeric[0].values, 0, 100, 4))).toEqual([2, 1, 0, 1]);
    const mask = new Uint8Array([0, 1, 1, 1, 1]);
    expect(Array.from(histogram(props.numeric[0].values, 0, 100, 4, mask))).toEqual([1, 1, 0, 1]);
    expect(Array.from(tagCounts(props))).toEqual([2, 2, 1]);
    expect(Array.from(tagCounts(props, mask))).toEqual([1, 2, 1]);
  });

  it("exports the passing objects as CSV", () => {
    const csv = toCsv(props, new Uint8Array([0, 0, 1, 1, 0]));
    expect(csv).toBe('id,length,fa,tags\n12,40,0.4000000059604645,"CST;odd, name"\n13,,0.8999999761581421,\n');
  });
});
