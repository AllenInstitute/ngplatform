/**
 * The annotation table: a row for each annotation of the scene's local
 * annotation layers (its type, name, group, values, size and comments),
 * found by any value with a short query, sorted by any column, and written
 * to or read from CSV.  Pure functions; ./table_panel.ts draws it.
 *
 * A query is words, each of which a row must match: plain text anywhere in
 * the row, `column:text` (contains), `column=text` (is; `column=` is
 * empty), `column!=text`, `column>n`, `column<n`, `>=`, `<=` (numbers),
 * and `-word` for rows that do not match.  Columns are named by their
 * titles, without spaces or case ("celltype" for "Cell type").  Text with
 * spaces goes in quotes.
 */
import { addGroup, groupOf, groupPath, groupsOf, setGroup, writeGroups } from "./groups.js";
import type { AnnotationJson, Quantity } from "./measure.js";
import { ancestorNames, findTerm, type Term, type TermValue } from "./ontology.js";
import { addField, type Comment, type Field, fieldsOf, type Group, type LayerMeta, type LayerSpec, readValue, setValue, updateField, valueText } from "./values.js";

export const TYPE_NAMES: Record<string, string> = { point: "Point", line: "Line", polyline: "Polyline", axis_aligned_bounding_box: "Box", ellipsoid: "Ellipsoid" };

/** A layer as the table reads it. */
export interface TableLayer {
  spec: LayerSpec;
  meta: LayerMeta;
  /** Kept by another plugin (track filtering's regions): read, gone to, deleted, commented; not edited. */
  managed: boolean;
}

export interface Row {
  layer: string;
  id: string;
  /** Neuroglancer's type ("axis_aligned_bounding_box"). */
  type: string;
  description: string;
  group: number;
  groupPath: string;
  /** Each field's value as text, by the field's title. */
  values: Record<string, string>;
  /** Number fields' values, by title. */
  numbers: Record<string, number>;
  /** More text a search finds a field by (an ontology term's ancestors), by title. */
  extra: Record<string, string>;
  size?: { quantity: Quantity; value: number };
  comments: Comment[];
  managed: boolean;
  annotation: AnnotationJson;
}

/** The name a row shows: its description, or its type and the start of its id. */
export const rowName = (r: { description: string; type: string; id: string }) => r.description || `${TYPE_NAMES[r.type] ?? r.type} ${r.id.slice(0, 6)}`;

/**
 * The rows of these layers.  `measure` gives an annotation's size (mm, mm²
 * or mm³); `terms` an ontology field's terms when they are at hand, so a
 * term is found by its ancestors' names too.
 */
export function buildRows(
  layers: TableLayer[],
  measure: (layer: string, a: AnnotationJson) => { quantity: Quantity; value: number } | undefined,
  terms: (field: Field) => Map<string, Term> | undefined = () => undefined,
): Row[] {
  const rows: Row[] = [];
  for (const { spec, meta, managed } of layers) {
    const fields = fieldsOf(spec, meta);
    const groups = groupsOf(spec, meta);
    const paths = new Map(groups.map((g) => [g.value, groupPath(groups, g.value)]));
    const known = new Map(fields.map((f) => [f, f.kind === "ontology" ? terms(f) : undefined]));
    for (const a of spec.annotations) {
      const values: Record<string, string> = {};
      const numbers: Record<string, number> = {};
      const extra: Record<string, string> = {};
      for (const f of fields) {
        const v = readValue(f, a, spec, meta);
        values[f.title] = valueText(v);
        if (typeof v === "number") numbers[f.title] = v;
        const byId = known.get(f);
        if (byId && typeof v === "object" && v !== null) extra[f.title] = ancestorNames(byId, v.id).join(" ");
      }
      const group = groupOf(spec, a);
      rows.push({
        layer: spec.name,
        id: a.id,
        type: a.type,
        description: a.description ?? "",
        group,
        groupPath: paths.get(group) ?? "",
        values,
        numbers,
        extra,
        size: measure(spec.name, a),
        comments: meta.comments[a.id] ?? [],
        managed,
        annotation: a,
      });
    }
  }
  return rows;
}

// --------------------------------------------------------------- columns

export interface Column {
  key: string;
  title: string;
  text(row: Row): string;
  number?(row: Row): number | undefined;
}

export const BUILTIN_COLUMNS: Column[] = [
  { key: "type", title: "Type", text: (r) => TYPE_NAMES[r.type] ?? r.type },
  { key: "name", title: "Name", text: (r) => rowName(r) },
  { key: "group", title: "Group", text: (r) => r.groupPath },
  { key: "layer", title: "Layer", text: (r) => r.layer },
  {
    key: "size",
    title: "Size",
    text: (r) => (r.size ? String(r.size.value) : ""),
    number: (r) => r.size?.value,
  },
  { key: "comments", title: "Comments", text: (r) => r.comments.map((c) => c.text).join("\n"), number: (r) => r.comments.length },
  { key: "id", title: "Id", text: (r) => r.id },
];

/** The columns of the fields of these rows' layers, by title, in the order first met. */
export function fieldColumns(fields: Field[]): Column[] {
  const seen = new Set<string>();
  const out: Column[] = [];
  for (const f of fields) {
    if (seen.has(f.title)) continue;
    seen.add(f.title);
    const title = f.title;
    out.push({
      key: `field:${title}`,
      title,
      text: (r) => r.values[title] ?? "",
      number: f.kind === "number" ? (r) => r.numbers[title] : undefined,
    });
  }
  return out;
}

/** A column's name in a query: its title without spaces, underscores or case. */
export const queryName = (title: string) => title.toLowerCase().replace(/[\s_-]+/g, "");

// ----------------------------------------------------------------- query

export interface QueryTerm {
  column?: string;
  op: ":" | "=" | "!=" | ">" | "<" | ">=" | "<=";
  value: string;
  negate: boolean;
}

/** Splits a query into its terms (see the module's comment). */
export function parseQuery(query: string): QueryTerm[] {
  const out: QueryTerm[] = [];
  const re = /(-?)(?:([^\s:=!<>"]+)(:|!=|>=|<=|=|>|<))?(?:"([^"]*)"?|(\S*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    const value = m[4] ?? m[5] ?? "";
    if (m[2] === undefined && value === "") continue;
    out.push({ ...(m[2] !== undefined ? { column: m[2] } : {}), op: (m[3] as QueryTerm["op"]) ?? ":", value, negate: m[1] === "-" });
  }
  return out;
}

/** Whether a row matches every term; a term naming no column (or one the table has not) looks everywhere. */
export function matches(row: Row, terms: QueryTerm[], columns: Column[]): boolean {
  const byName = new Map(columns.map((c) => [queryName(c.title), c]));
  return terms.every((t) => {
    const column = t.column === undefined ? undefined : byName.get(queryName(t.column));
    let hit: boolean;
    if (column === undefined) {
      const text = t.column === undefined ? t.value : `${t.column}${t.op}${t.value}`;
      hit = columns.some((c) => contains(c.text(row), text)) || Object.values(row.extra).some((x) => contains(x, text));
    } else {
      hit = test(row, column, t);
    }
    return hit !== t.negate;
  });
}

const contains = (text: string, part: string) => text.toLowerCase().includes(part.toLowerCase());

function test(row: Row, column: Column, t: QueryTerm): boolean {
  const text = column.text(row);
  switch (t.op) {
    case ":":
      return contains(text, t.value) || (column.key.startsWith("field:") && contains(row.extra[column.title] ?? "", t.value));
    case "=":
      return text.toLowerCase() === t.value.toLowerCase();
    case "!=":
      return text.toLowerCase() !== t.value.toLowerCase();
    default: {
      const v = column.number?.(row) ?? (text === "" ? NaN : Number(text));
      const q = Number(t.value);
      if (!Number.isFinite(v) || !Number.isFinite(q)) return false;
      return t.op === ">" ? v > q : t.op === "<" ? v < q : t.op === ">=" ? v >= q : v <= q;
    }
  }
}

/** Rows sorted by a column: numbers as numbers, text naturally ("Box 2" before "Box 10"), empty ones last. */
export function sortRows(rows: Row[], column: Column, descending = false): Row[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const key = (r: Row) => {
    const n = column.number?.(r);
    return n !== undefined && Number.isFinite(n) ? n : column.text(r);
  };
  const keyed = rows.map((r, i) => ({ r, i, k: key(r) }));
  keyed.sort((a, b) => {
    const ea = a.k === "";
    const eb = b.k === "";
    if (ea || eb) return ea === eb ? a.i - b.i : ea ? 1 : -1;
    const c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : collator.compare(String(a.k), String(b.k));
    return (descending ? -c : c) || a.i - b.i;
  });
  return keyed.map((x) => x.r);
}

// ------------------------------------------------------------------- CSV

const UNITS: Record<Quantity, string> = { length: "mm", area: "mm2", volume: "mm3" };
const GEOMETRY = ["point", "point_a", "point_b", "center", "radii", "points"] as const;

const vector = (v: number[] | undefined) => (v ? v.map((x) => String(Number(x.toPrecision(7)))).join(" ") : "");

/** Comments in one cell: a line each, its time then its text. */
export const commentsText = (comments: Comment[]) => comments.map((c) => `${c.time} ${c.text}`).join("\n");

export function parseComments(text: string): Comment[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const m = /^(\d{4}-\d\d-\d\d[T ][\d:.]+Z?)\s+(.*)$/.exec(line);
      return m ? { time: m[1], text: m[2] } : { time: "", text: line };
    });
}

/** The table as CSV rows: what each annotation is, its values, size, comments and coordinates (in its layer's). */
export function tableCsv(rows: Row[], fieldTitles: string[]): (string | number)[][] {
  const out: (string | number)[][] = [["layer", "id", "type", "description", "group", ...fieldTitles, "size", "unit", "comments", ...GEOMETRY]];
  for (const r of rows) {
    const a = r.annotation;
    const point = a.type === "point" ? a.point : undefined;
    out.push([
      r.layer,
      r.id,
      TYPE_NAMES[r.type]?.toLowerCase() ?? r.type,
      r.description,
      r.groupPath,
      ...fieldTitles.map((t) => r.values[t] ?? ""),
      r.size ? r.size.value : "",
      r.size ? UNITS[r.size.quantity] : "",
      commentsText(r.comments),
      vector(point),
      vector(a.pointA),
      vector(a.pointB),
      vector(a.center),
      vector(a.radii),
      a.points ? a.points.map(vector).join("; ") : "",
    ]);
  }
  return out;
}

/** CSV text as rows of fields (RFC 4180: quoted fields may hold commas, quotes and line breaks). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; ++i) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        ++i;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") ++i;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export interface ImportResult {
  /** The layers changed, by name. */
  layers: Map<string, TableLayer>;
  added: number;
  updated: number;
  skipped: number;
  notes: string[];
}

const TYPES: Record<string, string> = { point: "point", line: "line", polyline: "polyline", box: "axis_aligned_bounding_box", axis_aligned_bounding_box: "axis_aligned_bounding_box", ellipsoid: "ellipsoid" };
const BUILTIN = new Set(["layer", "id", "type", "description", "group", "size", "unit", "comments", ...GEOMETRY]);

const parseVector = (s: string) => {
  const v = s.trim().split(/[\s,]+/).filter((x) => x !== "").map(Number);
  return v.length && v.every(Number.isFinite) ? v : undefined;
};

/** An annotation from a CSV record's type and coordinates, or why not. */
function annotationFrom(rec: Record<string, string>, id: string, rank: number | undefined): AnnotationJson | string {
  const type = TYPES[(rec.type ?? "").trim().toLowerCase()];
  if (type === undefined) return `no type ("${rec.type ?? ""}")`;
  const a: AnnotationJson = { type, id };
  const need = (key: string) => {
    const v = parseVector(rec[key] ?? "");
    if (v === undefined) throw new Error(`no ${key}`);
    if (rank !== undefined && v.length !== rank) throw new Error(`${key} has ${v.length} coordinates, the layer ${rank}`);
    return v;
  };
  try {
    if (type === "point") a.point = need(rec.point ? "point" : "point_a");
    else if (type === "line" || type === "axis_aligned_bounding_box") {
      a.pointA = need("point_a");
      a.pointB = need("point_b");
    } else if (type === "ellipsoid") {
      a.center = need("center");
      a.radii = need("radii");
    } else {
      const points = (rec.points ?? "").split(";").map(parseVector);
      if (points.length < 2 || points.some((p) => p === undefined || (rank !== undefined && p.length !== rank))) throw new Error("points need two or more points of the layer's rank");
      a.points = points as number[][];
    }
  } catch (e) {
    return (e as Error).message;
  }
  return a;
}

const rankOfLayer = (spec: LayerSpec) => {
  const a = spec.annotations[0];
  return a ? (a.point ?? a.pointA ?? a.center ?? a.points?.[0])?.length : undefined;
};

/**
 * Reads a CSV table (as `tableCsv` writes it, or a spreadsheet's) into the
 * layers.  A row whose layer and id are known updates that annotation's
 * description, group, values and comments (new comments are added); any
 * other row with a type and coordinates is a new annotation, in its layer
 * when the scene has it, else in `target`.  Groups are made from their
 * paths; a column no field has becomes one (a number when all its values
 * are, a list otherwise); a list gains values it lacks; an ontology's term
 * is found by its name or id in `termsOf(field)`.
 */
export function importCsv(
  text: string,
  layers: Map<string, TableLayer>,
  target: string | undefined,
  newId: () => string,
  termsOf: (field: Field) => Term[] | undefined = (f) => f.ontology?.terms,
): ImportResult {
  const result: ImportResult = { layers: new Map(), added: 0, updated: 0, skipped: 0, notes: [] };
  const table = parseCsv(text);
  if (table.length < 2) {
    result.notes.push("The file has no rows.");
    return result;
  }
  const header = table[0].map((h) => h.trim());
  const records = table.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h.toLowerCase(), r[i] ?? ""])) as Record<string, string>);
  const titles = header.filter((h) => !BUILTIN.has(h.toLowerCase()));
  const work = (name: string): TableLayer | undefined => {
    const l = result.layers.get(name) ?? layers.get(name);
    if (l === undefined || l.managed) return undefined;
    return l;
  };
  // Each record's layer.
  const where = records.map((rec) => (rec.layer && work(rec.layer) ? rec.layer : target));
  // Columns the layers have no field for become fields: numbers when every value is one, lists otherwise.
  for (const name of new Set(where)) {
    if (name === undefined) continue;
    let l = work(name)!;
    for (const title of titles) {
      const values = records.filter((_, i) => where[i] === name).map((r) => r[title.toLowerCase()].trim()).filter((v) => v !== "");
      if (values.length === 0) continue;
      let field = fieldsOf(l.spec, l.meta).find((f) => f.title.toLowerCase() === title.toLowerCase());
      if (field === undefined) {
        const numeric = values.every((v) => Number.isFinite(Number(v)));
        const [spec, meta] = addField(l.spec, l.meta, numeric ? { id: "", title, kind: "number" } : { id: "", title, kind: "list", options: [...new Set(values)] });
        l = { ...l, spec, meta };
        result.notes.push(`Made the field “${title}” (${numeric ? "a number" : "a list"}) in ${name}.`);
      } else if (field.kind === "list") {
        const missing = [...new Set(values)].filter((v) => !field!.options!.includes(v));
        if (missing.length) {
          const [spec, meta] = updateField(l.spec, l.meta, field.id, { options: [...field.options!, ...missing] });
          l = { ...l, spec, meta };
        }
      }
      result.layers.set(name, l);
    }
  }
  records.forEach((rec, i) => {
    const name = where[i];
    if (name === undefined) {
      result.skipped++;
      return;
    }
    let l = work(name)!;
    let spec = l.spec;
    let meta = l.meta;
    const id = rec.id?.trim();
    const existing = id ? spec.annotations.find((a) => a.id === id) : undefined;
    let annotationId: string;
    if (existing) {
      annotationId = existing.id;
      result.updated++;
    } else {
      annotationId = id && !spec.annotations.some((a) => a.id === id) ? id : newId();
      const a = annotationFrom(rec, annotationId, rankOfLayer(spec));
      if (typeof a === "string") {
        result.skipped++;
        if (result.notes.length < 12) result.notes.push(`Row ${i + 2}: ${a}.`);
        return;
      }
      const specs = spec.annotationProperties ?? [];
      if (specs.length) a.props = specs.map((p) => p.default ?? (p.type === "rgb" ? "#000000" : p.type === "rgba" ? "#00000000" : 0));
      spec = { ...spec, annotations: [...spec.annotations, a] };
      result.added++;
    }
    if ("description" in rec) {
      const description = rec.description.trim();
      spec = {
        ...spec,
        annotations: spec.annotations.map((a) => {
          if (a.id !== annotationId) return a;
          const { description: _old, ...rest } = a;
          return description ? { ...rest, description } : rest;
        }),
      };
    }
    if ("group" in rec) {
      const path = rec.group.trim();
      let groups: Group[] = groupsOf(spec, meta);
      let value = 0;
      if (path) {
        let parent: number | undefined;
        for (const part of path.split(/\s+\/\s+/).map((p) => p.trim()).filter((p) => p !== "")) {
          const found = groups.find((g) => g.name === part && g.parent === parent);
          if (found) value = found.value;
          else ({ groups, value } = addGroup(groups, part, parent));
          parent = value;
        }
        [spec, meta] = writeGroups(spec, meta, groups);
      } else if (groups.length) [spec, meta] = writeGroups(spec, meta, groups);
      spec = setGroup(spec, [annotationId], value);
    }
    const fields = fieldsOf(spec, meta);
    for (const title of titles) {
      const field = fields.find((f) => f.title.toLowerCase() === title.toLowerCase());
      if (field === undefined || field.kind === "colour") continue;
      const raw = rec[title.toLowerCase()].trim();
      let value: string | number | TermValue | undefined = raw;
      if (field.kind === "ontology" && raw) {
        // A term by its name or id, when the terms are at hand; else the text as both.
        const terms = termsOf(field);
        const t = terms ? findTerm(terms, raw) : undefined;
        value = t ? { id: t.id, name: t.name } : { id: raw, name: raw };
      }
      [spec, meta] = setValue(spec, meta, [annotationId], field, value);
    }
    if (rec.comments?.trim()) {
      const have = meta.comments[annotationId] ?? [];
      const more = parseComments(rec.comments).filter((c) => !have.some((h) => h.text === c.text && h.time === c.time));
      if (more.length) meta = { ...meta, comments: { ...meta.comments, [annotationId]: [...have, ...more] } };
    }
    l = { ...l, spec, meta };
    result.layers.set(name, l);
  });
  if (where.some((w) => w === undefined)) result.notes.push("Rows naming no layer of this scene need a layer chosen to go to.");
  return result;
}
