/**
 * The data palette: eight categorical colours for what a user makes and
 * the platform colours by kind (track groups, label classes, annotation
 * groups, landmark pairs, series in a plot).  Okabe and Ito's colour-blind
 * safe set, its black left out, its blue lighter and a pale green added:
 * each at least 5:1 on black (4.2:1 on a card's grey), and at least ΔE2000
 * 11 from every other with normal vision and simulated deuteranopia and
 * protanopia (10 with tritanopia).  The same colours are the tokens
 * --data-1 … --data-8 in src/ui/styles.css.
 *
 * The rule: the interface (chrome) never uses these; they mean data.
 *
 *     import { dataColour } from "@ngplatform/sdk/palette";
 *     group.colour = dataColour(groups.length);
 */

/** The eight colours, in the order they are handed out (most distinct first). */
export const DATA_COLOURS: readonly string[] = Object.freeze([
  "#e69f00", // orange
  "#56b4e9", // sky blue
  "#009e73", // bluish green
  "#cc79a7", // reddish purple
  "#f0e442", // yellow
  "#2f7fd0", // blue
  "#d55e00", // vermilion
  "#99ddbb", // pale green
]);

/** The `i`-th colour of the palette (from 0), round again after the eighth. */
export function dataColour(i: number): string {
  const n = DATA_COLOURS.length;
  return DATA_COLOURS[((Math.trunc(i) % n) + n) % n];
}

/** The first palette colour none of `taken` uses (case aside), or the next in turn once all are used. */
export function nextDataColour(taken: Iterable<string>): string {
  const used = new Set([...taken].map((c) => c.toLowerCase()));
  return DATA_COLOURS.find((c) => !used.has(c)) ?? dataColour(used.size);
}
