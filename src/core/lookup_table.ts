/**
 * Label lookup tables: the values of a label image, each with a name and a
 * colour, as atlases publish them.  The common form is FreeSurfer's colour
 * table (`index name R G B A`, `#` comments), which Freeview, FSLeyes and
 * most atlas packages read; ITK-SNAP label descriptions, FSL atlas XML, the
 * Allen Institute's structure graph (JSON), and plain `index name` lists
 * (AAL's) are read too.  A table without colours gets distinct ones.
 *
 * Pure functions, no Neuroglancer: the engine turns a table into segment
 * colours and a segment property map (./engine/lookup_tables.ts).
 */

export interface LookupEntry {
  /** The label's value in the image. */
  value: bigint;
  /** Its short name (FreeSurfer's names have no spaces; others may). */
  name: string;
  /** Red, green, blue, 0..255. */
  colour: [number, number, number];
  /** A longer name, when the table gives one (the Allen ontology's full names). */
  description?: string;
  /** The value of the structure this one is part of, when the table is a hierarchy (the Allen ontology). */
  parent?: bigint;
}

export interface LookupTable {
  entries: LookupEntry[];
  /** Whether the colours were made here because the file gave none. */
  generatedColours?: boolean;
}

export class LookupTableError extends Error {}

const INTEGER = /^\d+$/;
const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i;

/** A distinct colour for the i-th label of a table without colours (golden-angle hues). */
export function generatedColour(i: number): [number, number, number] {
  const hue = (i * 137.508) % 360;
  const lightness = [0.55, 0.42, 0.68][i % 3];
  const saturation = 0.7;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** One line of a FreeSurfer-like table: index, a name (perhaps with spaces), then colour numbers. */
function parseLine(line: string): { value: bigint; name: string; colour?: [number, number, number]; description?: string } | undefined {
  let text = line.trim();
  if (text === "" || text.startsWith("#") || text.startsWith("//")) return undefined;
  // ITK-SNAP: IDX R G B A VIS MSH "LABEL".
  const snap = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+[\d.]+\s+\d+\s+\d+\s+"(.*)"\s*$/.exec(text);
  if (snap !== null) {
    return { value: BigInt(snap[1]), name: snap[5], colour: [Number(snap[2]), Number(snap[3]), Number(snap[4])] };
  }
  // A trailing "# …" is a description (FreeSurfer's reader stops at the sixth field).
  let description: string | undefined;
  const hash = text.search(/\s#\s?/);
  if (hash > 0) {
    description = text.slice(hash).replace(/^\s*#\s?/, "").trim() || undefined;
    text = text.slice(0, hash).trim();
  }
  const tokens = text.split(/\t|,|;|\s+/).map((t) => t.trim()).filter((t) => t !== "");
  if (tokens.length < 2 || !INTEGER.test(tokens[0])) return undefined;
  // FSLeyes: value R G B name (colours as fractions), the name last.
  if (tokens.length >= 5 && tokens.slice(1, 4).every((t) => NUMBER.test(t)) && !NUMBER.test(tokens[tokens.length - 1])) {
    let rgb = tokens.slice(1, 4).map(Number);
    if (rgb.every((v) => v <= 1)) rgb = rgb.map((v) => v * 255);
    return { value: BigInt(tokens[0]), name: tokens.slice(4).join(" "), colour: [clampByte(rgb[0]), clampByte(rgb[1]), clampByte(rgb[2])], description };
  }
  // Trailing numbers: three or four are a colour (and alpha); one alone (AAL's code) is not.
  let end = tokens.length;
  while (end > 1 && NUMBER.test(tokens[end - 1])) end--;
  // More than R G B A: the first ones end the name ("Area 4 …").
  if (end > 1 && tokens.length - end > 4) end = tokens.length - 4;
  const numbers = tokens.slice(end).map(Number);
  let nameTokens = tokens.slice(1, end);
  let colour: [number, number, number] | undefined;
  if (nameTokens.length === 0) {
    // A numeric name ("12 12 255 0 0"): the first number after the index.
    if (numbers.length < 4) return undefined;
    nameTokens = [String(numbers.shift())];
  }
  if (numbers.length >= 3) {
    let rgb = numbers.slice(0, 3);
    // Colours as fractions (0..1) in some tables.
    if (rgb.every((v) => v <= 1) && rgb.some((v) => !Number.isInteger(v))) rgb = rgb.map((v) => v * 255);
    colour = [clampByte(rgb[0]), clampByte(rgb[1]), clampByte(rgb[2])];
  }
  const name = nameTokens.join(" ").replace(/^"(.*)"$/, "$1");
  return { value: BigInt(tokens[0]), name, colour, description };
}

/**
 * FSL atlas XML: `<label index="N" …>Name</label>`; image values are index +
 * `offset`.  FSL's atlases differ: Harvard-Oxford's index 0 is its first
 * region (value 1), JHU's is "Unclassified" (the background, value 0); with
 * no offset given, a first label that names the background means 0.
 */
function parseFslXml(text: string, offset: number | undefined): LookupTable {
  const entries: LookupEntry[] = [];
  const pattern = /<label\b([^>]*)>([^<]*)<\/label>/g;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const index = /\bindex\s*=\s*"(\d+)"/.exec(m[1]);
    if (index === null) continue;
    entries.push({ value: BigInt(index[1]), name: decodeXml(m[2].trim()), colour: [0, 0, 0] });
  }
  const background = entries[0]?.value === 0n && /^(unclassified|unknown|background|none|clear label)$/i.test(entries[0].name);
  const shift = BigInt(offset ?? (background ? 0 : 1));
  for (const e of entries) e.value += shift;
  entries.forEach((e, i) => (e.colour = generatedColour(i)));
  return { entries, generatedColours: true };
}

function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (all, code: string) => {
    if (code.startsWith("#")) return String.fromCharCode(Number(code.slice(1)));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[code] ?? all;
  });
}

interface AllenStructure {
  id: number;
  acronym?: string;
  name?: string;
  color_hex_triplet?: string;
  children?: AllenStructure[];
}

/** The Allen Institute's structure graph (structure_graph_download/*.json, or its `msg`). */
function parseAllenJson(data: unknown): LookupTable | undefined {
  const root = (data as { msg?: unknown })?.msg ?? data;
  const list = Array.isArray(root) ? root : [root];
  if (!list.every((s) => typeof s === "object" && s !== null && typeof (s as AllenStructure).id === "number")) return undefined;
  const entries: LookupEntry[] = [];
  const visit = (s: AllenStructure, parent: bigint | undefined) => {
    const hex = /^#?([0-9a-f]{6})$/i.exec(s.color_hex_triplet ?? "");
    const rgb = hex ? [0, 2, 4].map((k) => parseInt(hex[1].slice(k, k + 2), 16)) : [128, 128, 128];
    const value = BigInt(s.id);
    entries.push({ value, name: s.acronym ?? s.name ?? String(s.id), colour: rgb as [number, number, number], description: s.acronym ? s.name : undefined, ...(parent !== undefined ? { parent } : {}) });
    for (const child of s.children ?? []) visit(child, value);
  };
  for (const s of list) visit(s as AllenStructure, undefined);
  return { entries };
}

export interface ParseOptions {
  /** FSL atlas XML: the image value of label index 0 (see parseFslXml). */
  xmlOffset?: number;
}

/**
 * Reads a lookup table in any of the forms above.  Later lines for the same
 * value replace earlier ones; entries keep the file's order.
 */
export function parseLookupTable(text: string, options: ParseOptions = {}): LookupTable {
  const trimmed = text.replace(/^﻿/, "").trimStart();
  let table: LookupTable | undefined;
  if (trimmed.startsWith("<")) {
    table = parseFslXml(trimmed, options.xmlOffset);
  } else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      throw new LookupTableError(`Not valid JSON: ${(e as Error).message}`);
    }
    table = parseAllenJson(data);
    if (table === undefined) throw new LookupTableError("A JSON lookup table must be the Allen Institute's structure graph (id, acronym, name, color_hex_triplet).");
  } else {
    const parsed = text.split(/\r?\n/).map(parseLine).filter((x) => x !== undefined);
    const anyColour = parsed.some((p) => p.colour !== undefined);
    table = {
      entries: parsed.map((p, i) => ({ value: p.value, name: p.name, colour: p.colour ?? generatedColour(i), ...(p.description ? { description: p.description } : {}) })),
      ...(anyColour ? {} : { generatedColours: true }),
    };
  }
  // One entry per value, the last one given, in the order first seen.
  const byValue = new Map<bigint, LookupEntry>();
  for (const e of table.entries) byValue.set(e.value, e);
  const entries = [...byValue.values()];
  if (entries.length === 0) throw new LookupTableError("No labels found. A lookup table has lines of `index name R G B A` (FreeSurfer's colour table).");
  return { ...table, entries };
}

/** A table in FreeSurfer's format; descriptions follow as `# …` (which FreeSurfer ignores). */
export function formatLookupTable(table: LookupTable, header: string[] = []): string {
  const lines = header.map((h) => `# ${h}`.trimEnd());
  const width = Math.max(...table.entries.map((e) => e.name.replace(/\s+/g, "_").length), 8);
  for (const e of table.entries) {
    const name = e.name.replace(/\s+/g, "_").padEnd(width);
    const rgb = e.colour.map((c) => String(c).padStart(3)).join(" ");
    lines.push(`${String(e.value).padStart(5)}  ${name}  ${rgb}  0${e.description ? `  # ${e.description}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

/** "#rrggbb" for a colour. */
export function hexColour(rgb: readonly number[]): string {
  return `#${rgb.map((c) => clampByte(c).toString(16).padStart(2, "0")).join("")}`;
}

// ------------------------------------------------------- source URLs

/**
 * A layer source naming a table, which the engine's `lut://` data source
 * reads into segment names:
 *   lut://<id>                 a table bundled with the app
 *   lut://https://…            a table fetched from its publisher when used
 *   lut://inline/<title>/<b64> a table from this computer, kept in the link
 */
export type LookupSource = { kind: "bundled"; id: string } | { kind: "remote"; url: string } | { kind: "inline"; title: string; data: string };

export const LUT_SCHEME = "lut://";

export function parseLookupSource(url: string): LookupSource | undefined {
  if (!url.startsWith(LUT_SCHEME)) return undefined;
  const rest = url.slice(LUT_SCHEME.length);
  if (/^https?:\/\//.test(rest)) return { kind: "remote", url: rest };
  const inline = /^inline\/([^/]*)\/(.*)$/.exec(rest);
  if (inline !== null) return { kind: "inline", title: decodeURIComponent(inline[1]), data: inline[2] };
  if (/^[\w.-]+$/.test(rest)) return { kind: "bundled", id: rest };
  return undefined;
}

export function lookupSourceUrl(source: LookupSource): string {
  switch (source.kind) {
    case "bundled":
      return `${LUT_SCHEME}${source.id}`;
    case "remote":
      return `${LUT_SCHEME}${source.url}`;
    case "inline":
      return `${LUT_SCHEME}inline/${encodeURIComponent(source.title)}/${source.data}`;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; ++i) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * A table from this computer as an inline source: its names and values only
 * (the colours are in the layer's segment colours), compressed, so a link
 * with it still works for someone who does not have the file.
 */
export async function inlineLookupSource(title: string, table: LookupTable): Promise<string> {
  // `value<TAB>name<TAB># description`: a tab ends the value and the name, so names keep their
  // commas and trailing numbers ("Brodmann area 4"), which a table's own line format would not.
  const field = (text: string) => text.replace(/[\t\r\n]+/g, " ");
  const lines = table.entries.map((e) => `${e.value}\t${field(e.name)}${e.description ? `\t# ${field(e.description)}` : ""}`);
  // A hierarchy's parents (an Allen structure graph from a file): `#parents value:parent …` lines, which tables ignore.
  const pairs = table.entries.filter((e) => e.parent !== undefined).map((e) => `${e.value}:${e.parent}`);
  for (let i = 0; i < pairs.length; i += 200) lines.push(`${PARENTS} ${pairs.slice(i, i + 200).join(" ")}`);
  const text = lines.join("\n");
  const packed = await pipe(new TextEncoder().encode(text), new CompressionStream("deflate-raw"));
  return lookupSourceUrl({ kind: "inline", title, data: toBase64Url(packed) });
}

/** The text of an inline source (names only: `value<TAB>name<TAB># description` lines, or `value name # description` in older links, and `#parents` lines). */
export async function inlineLookupText(data: string): Promise<string> {
  return new TextDecoder().decode(await pipe(fromBase64Url(data), new DecompressionStream("deflate-raw")));
}

const PARENTS = "#parents";

/** An inline source's table: its names, and the parents its `#parents` lines give. */
export function parseInlineLookup(text: string): LookupTable {
  let table = parseLookupTable(text);
  // Lines with tabs give their names (and descriptions) exactly.
  const exact = new Map<bigint, { name: string; description?: string }>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+)\t([^\t]*)(?:\t# ?(.*))?$/.exec(line);
    if (m !== null) exact.set(BigInt(m[1]), { name: m[2], ...(m[3] ? { description: m[3] } : {}) });
  }
  if (exact.size > 0) {
    table = {
      ...table,
      entries: table.entries.map((e) => {
        const x = exact.get(e.value);
        if (x === undefined) return e;
        const { description: _, ...rest } = e;
        return { ...rest, ...x };
      }),
    };
  }
  const parents = new Map<bigint, bigint>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${PARENTS} `)) continue;
    for (const pair of line.slice(PARENTS.length + 1).split(/\s+/)) {
      const m = /^(\d+):(\d+)$/.exec(pair);
      if (m !== null) parents.set(BigInt(m[1]), BigInt(m[2]));
    }
  }
  if (parents.size === 0) return table;
  return { ...table, entries: table.entries.map((e) => (parents.has(e.value) ? { ...e, parent: parents.get(e.value)! } : e)) };
}
