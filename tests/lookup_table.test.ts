import { describe, expect, it } from "vitest";
import {
  formatLookupTable,
  generatedColour,
  hexColour,
  inlineLookupSource,
  inlineLookupText,
  parseInlineLookup,
  LookupTableError,
  lookupSourceUrl,
  parseLookupSource,
  parseLookupTable,
} from "../src/core/lookup_table.js";

describe("lookup tables", () => {
  it("reads FreeSurfer's colour table, comments and all", () => {
    const text = `#$Id: FreeSurferColorLUT.txt
#No. Label Name:                            R   G   B   A

0   Unknown                                 0   0   0   0
2   Left-Cerebral-White-Matter            245 245 245   0
1035    ctx-lh-insula                     255 192  32   0
`;
    const { entries, generatedColours } = parseLookupTable(text);
    expect(generatedColours).toBeUndefined();
    expect(entries.map((e) => [e.value, e.name, e.colour])).toEqual([
      [0n, "Unknown", [0, 0, 0]],
      [2n, "Left-Cerebral-White-Matter", [245, 245, 245]],
      [1035n, "ctx-lh-insula", [255, 192, 32]],
    ]);
  });

  it("keeps a trailing # as a description, and names with spaces", () => {
    const { entries } = parseLookupTable("385\tVISp\t8\t133\t140\t0  # Primary visual area\n7 Area 4 left 10 20 30 0\n");
    expect(entries[0]).toEqual({ value: 385n, name: "VISp", colour: [8, 133, 140], description: "Primary visual area" });
    expect(entries[1]).toMatchObject({ value: 7n, name: "Area 4 left", colour: [10, 20, 30] });
  });

  it("splits the name from the colour when the name ends in a number", () => {
    expect(parseLookupTable("4 Area 4 255 0 0 0").entries[0]).toMatchObject({ name: "Area 4", colour: [255, 0, 0] });
  });

  it("reads ITK-SNAP label descriptions", () => {
    const text = `################################################
# ITK-SnAP Label Description File
#    IDX   -R-  -G-  -B-  -A--  VIS MSH  LABEL
    0     0    0    0        0  0  0    "Clear Label"
    1   255    0    0        1  1  1    "Label 1"`;
    expect(parseLookupTable(text).entries.map((e) => [e.value, e.name, e.colour])).toEqual([
      [0n, "Clear Label", [0, 0, 0]],
      [1n, "Label 1", [255, 0, 0]],
    ]);
  });

  it("gives distinct colours to a list without them (AAL's index name code)", () => {
    const table = parseLookupTable("1 Precentral_L 2001\n2 Precentral_R 2002\n3 Frontal_Sup_2_L 2101\n");
    expect(table.generatedColours).toBe(true);
    expect(table.entries.map((e) => e.name)).toEqual(["Precentral_L", "Precentral_R", "Frontal_Sup_2_L"]);
    expect(new Set(table.entries.map((e) => hexColour(e.colour))).size).toBe(3);
    expect(table.entries[0].colour).toEqual(generatedColour(0));
  });

  it("reads colours given as fractions", () => {
    expect(parseLookupTable("5,Thalamus,0.5,0.25,1.0").entries[0].colour).toEqual([128, 64, 255]);
  });

  it("reads FSLeyes colour tables (value R G B name, as fractions)", () => {
    const { entries } = parseLookupTable("1  0.00000 0.93333 0.00000 Frontal Pole\n2  0.62745 0.32157 0.17647 Insular Cortex\n");
    expect(entries.map((e) => [e.value, e.name, e.colour])).toEqual([
      [1n, "Frontal Pole", [0, 238, 0]],
      [2n, "Insular Cortex", [160, 82, 45]],
    ]);
  });

  it("reads JHU's XML, whose index 0 is the background, as values equal to the index", () => {
    const xml = '<atlas><data><label index="0" x="0" y="0" z="0">Unclassified</label><label index="1">Middle cerebellar peduncle</label></data></atlas>';
    expect(parseLookupTable(xml).entries.map((e) => [e.value, e.name])).toEqual([
      [0n, "Unclassified"],
      [1n, "Middle cerebellar peduncle"],
    ]);
  });

  it("reads FSL atlas XML, label index 0 as value 1 unless told otherwise", () => {
    const xml = `<?xml version="1.0" encoding="ISO-8859-1"?>
<atlas version="1.0"><header><name>Harvard-Oxford Cortical</name></header>
<data>
<label index="0" x="48" y="94" z="35">Frontal Pole</label>
<label index="1" x="25" y="70" z="32">Insular Cortex</label>
<label index="2" x="1" y="2" z="3">Heschl&apos;s Gyrus</label>
</data></atlas>`;
    expect(parseLookupTable(xml).entries.map((e) => [e.value, e.name])).toEqual([
      [1n, "Frontal Pole"],
      [2n, "Insular Cortex"],
      [3n, "Heschl's Gyrus"],
    ]);
    expect(parseLookupTable(xml, { xmlOffset: 0 }).entries[0].value).toBe(0n);
  });

  it("reads the Allen structure graph, depth first, acronyms as names", () => {
    const graph = {
      success: true,
      msg: [
        {
          id: 997,
          acronym: "root",
          name: "root",
          color_hex_triplet: "FFFFFF",
          children: [{ id: 8, acronym: "grey", name: "Basic cell groups and regions", color_hex_triplet: "BFDAE3", children: [] }],
        },
      ],
    };
    const { entries } = parseLookupTable(JSON.stringify(graph));
    expect(entries.map((e) => [e.value, e.name, e.description, hexColour(e.colour)])).toEqual([
      [997n, "root", "root", "#ffffff"],
      [8n, "grey", "Basic cell groups and regions", "#bfdae3"],
    ]);
    // The hierarchy: each structure's parent.
    expect(entries.map((e) => e.parent)).toEqual([undefined, 997n]);
  });

  it("keeps the last entry for a repeated value, and rejects a file with none", () => {
    expect(parseLookupTable("1 a 1 1 1 0\n1 b 2 2 2 0").entries).toEqual([{ value: 1n, name: "b", colour: [2, 2, 2] }]);
    expect(() => parseLookupTable("# nothing here\n")).toThrow(LookupTableError);
    expect(() => parseLookupTable('{"a": 1}')).toThrow(LookupTableError);
  });

  it("writes FreeSurfer's format, which reads back the same", () => {
    const table = parseLookupTable("0 Unknown 0 0 0 0\n385 VISp 8 133 140 0 # Primary visual area\n");
    const text = formatLookupTable(table, ["A test"]);
    expect(text.startsWith("# A test\n")).toBe(true);
    expect(parseLookupTable(text).entries).toEqual(table.entries);
  });

  it("names tables as lut:// sources", () => {
    expect(parseLookupSource("lut://FreeSurferColorLUT")).toEqual({ kind: "bundled", id: "FreeSurferColorLUT" });
    expect(parseLookupSource("lut://https://example.org/a.txt")).toEqual({ kind: "remote", url: "https://example.org/a.txt" });
    expect(parseLookupSource("lut://inline/my%20labels.txt/abc_-")).toEqual({ kind: "inline", title: "my labels.txt", data: "abc_-" });
    expect(parseLookupSource("precomputed://x")).toBeUndefined();
    expect(lookupSourceUrl({ kind: "inline", title: "a/b", data: "x" })).toBe("lut://inline/a%2Fb/x");
  });

  it("carries a file's names in the link, compressed", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `${i + 1} Region_${i + 1} ${i % 256} 0 0 0`).join("\n");
    const table = parseLookupTable(lines);
    const url = await inlineLookupSource("mine.txt", table);
    const source = parseLookupSource(url);
    expect(source?.kind).toBe("inline");
    if (source?.kind !== "inline") return;
    expect(source.title).toBe("mine.txt");
    expect(url.length).toBeLessThan(lines.length / 2);
    const back = parseLookupTable(await inlineLookupText(source.data));
    expect(back.entries.map((e) => [e.value, e.name])).toEqual(table.entries.map((e) => [e.value, e.name]));
  });

  it("keeps a hierarchy's parents in the link (an Allen structure graph from a file)", async () => {
    const table = {
      entries: [
        { value: 997n, name: "root", colour: [255, 255, 255] as [number, number, number] },
        { value: 8n, name: "grey", colour: [191, 218, 227] as [number, number, number], description: "Basic cell groups and regions", parent: 997n },
        { value: 567n, name: "CH", colour: [176, 240, 255] as [number, number, number], description: "Cerebrum", parent: 8n },
      ],
    };
    const source = parseLookupSource(await inlineLookupSource("allen.json", table));
    if (source?.kind !== "inline") throw new Error("not inline");
    const back = parseInlineLookup(await inlineLookupText(source.data));
    expect(back.entries.map((e) => [e.value, e.name, e.description, e.parent])).toEqual([
      [997n, "root", undefined, undefined],
      [8n, "grey", "Basic cell groups and regions", 997n],
      [567n, "CH", "Cerebrum", 8n],
    ]);
  });
});

describe("the tables that come with the app", () => {
  it("lists only files that are here, and each reads with labels and colours", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../data/lookup-tables/", import.meta.url);
    const catalogue = JSON.parse(readFileSync(new URL("tables.json", dir), "utf-8")) as { id: string; file?: string; url?: string; licence: string }[];
    const files = new Set(readdirSync(dir));
    for (const t of catalogue) {
      expect(t.licence, t.id).not.toBe("");
      if (t.url !== undefined) {
        expect(t.url.startsWith("https://"), t.id).toBe(true);
        continue;
      }
      expect(files.has(t.file!), t.id).toBe(true);
      const table = parseLookupTable(readFileSync(new URL(t.file!, dir), "utf-8"));
      expect(table.generatedColours, t.id).toBeUndefined();
      expect(table.entries.length, t.id).toBeGreaterThan(7);
    }
    // Every table here is in the catalogue.
    for (const f of files) if (f.endsWith(".txt") && !f.startsWith("LICENSE")) expect(catalogue.some((t) => t.file === f), f).toBe(true);
    const fs = parseLookupTable(readFileSync(new URL("FreeSurferColorLUT.txt", dir), "utf-8"));
    expect(fs.entries.find((e) => e.value === 17n)?.name).toBe("Left-Hippocampus");
  });
});
