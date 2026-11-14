/**
 * The data palette (src/sdk/palette.ts): legible on black, the same as the
 * CSS tokens, and handed out in turn.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATA_COLOURS, dataColour, nextDataColour } from "../src/sdk/palette.js";

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("data palette", () => {
  it("has eight distinct colours, each at least 3:1 on black and on a card", () => {
    expect(DATA_COLOURS).toHaveLength(8);
    expect(new Set(DATA_COLOURS).size).toBe(8);
    for (const c of DATA_COLOURS) {
      expect(contrast(c, "#000000")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c, "#1a1a1a")).toBeGreaterThanOrEqual(3);
    }
  });

  it("is the --data-1 … --data-8 tokens", () => {
    const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
    DATA_COLOURS.forEach((c, i) => expect(css).toContain(`--data-${i + 1}: ${c};`));
  });

  it("hands colours out in turn, round again after the eighth", () => {
    expect(dataColour(0)).toBe(DATA_COLOURS[0]);
    expect(dataColour(9)).toBe(DATA_COLOURS[1]);
    expect(dataColour(-1)).toBe(DATA_COLOURS[7]);
    expect(nextDataColour([DATA_COLOURS[0].toUpperCase(), DATA_COLOURS[2]])).toBe(DATA_COLOURS[1]);
    expect(nextDataColour(DATA_COLOURS)).toBe(DATA_COLOURS[0]);
  });
});
