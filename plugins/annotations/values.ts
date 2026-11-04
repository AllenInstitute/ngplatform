/**
 * Values on annotations: the fields a layer's annotations have, and their
 * values.  A field is kept where Neuroglancer can keep it: a list of values
 * is an enum annotation property (0 for none, then 1, 2, … for the list's
 * values, named by its labels) and a number a float32 property, both in
 * the layer's `annotationProperties` and each annotation's `props`; text
 * and ontology terms, which Neuroglancer's properties cannot hold, are in
 * this plugin's state, by annotation id.  Properties the layer had already
 * (made in Neuroglancer, or another program) are fields too.
 *
 * Pure functions on a layer's specification (as the state writes it) and
 * the plugin's record of the layer; each edit returns new ones.
 */
import type { AnnotationJson } from "./measure.js";
import type { Term, TermValue } from "./ontology.js";

/** An annotation property as the layer's specification writes it. */
export interface PropertySpec {
  id: string;
  type: string;
  description?: string;
  default?: number | string;
  enum_values?: number[];
  enum_labels?: string[];
}

/** A local annotation layer's specification: the parts read and written here. */
export interface LayerSpec {
  name: string;
  annotations: AnnotationJson[];
  annotationProperties?: PropertySpec[];
  shader?: string;
  annotationColor?: string;
}

export type FieldKind = "list" | "number" | "text" | "ontology" | "colour";

/** Where an ontology field's terms come from. */
export interface OntologyRef {
  title: string;
  /** A label lookup table's `lut://` URL (the Allen ontology), read when needed. */
  url?: string;
  /** Or the terms themselves, kept with the field. */
  terms?: Term[];
}

/** A field as the plugin records it. */
export interface FieldDef {
  /** Its property's id, or its key in the plugin's values. */
  id: string;
  title: string;
  kind: FieldKind;
  ontology?: OntologyRef;
}

/** A field of a layer, as read from its specification and the plugin's record. */
export interface Field extends FieldDef {
  storage: "property" | "state";
  /** The property's type ("uint8", "float32", "rgb"…). */
  type?: string;
  /** A list's values, and their numbers in the property. */
  options?: string[];
  codes?: number[];
}

export interface Comment {
  /** ISO 8601. */
  time: string;
  text: string;
}

export interface Group {
  /** Its number in the layer's `group` property (1, 2, …; 0 is no group). */
  value: number;
  name: string;
  parent?: number;
  colour: string;
  hidden?: boolean;
}

/** What the plugin keeps of a layer, beside what Neuroglancer keeps. */
export interface LayerMeta {
  fields: FieldDef[];
  groups: Group[];
  /** The group new annotations go to. */
  activeGroup?: number;
  /** "group", a field's id, or nothing (the layer's colour). */
  colourBy?: string;
  /** Text and ontology values, by annotation id and field id. */
  values: Record<string, Record<string, string | TermValue>>;
  comments: Record<string, Comment[]>;
  /** The layer's own shader, kept while one made here (for hidden groups or colours) stands in for it. */
  userShader?: string;
}

export type Value = string | number | TermValue | undefined;

/** The property that holds an annotation's group. */
export const GROUP = "group";

export const emptyMeta = (): LayerMeta => ({ fields: [], groups: [], values: {}, comments: {} });

/** A record read from the state, with anything missing filled in. */
export function metaOf(raw: Partial<LayerMeta> | undefined): LayerMeta {
  return {
    fields: Array.isArray(raw?.fields) ? raw.fields : [],
    groups: Array.isArray(raw?.groups) ? raw.groups : [],
    activeGroup: raw?.activeGroup,
    colourBy: raw?.colourBy,
    values: raw?.values ?? {},
    comments: raw?.comments ?? {},
    ...(typeof raw?.userShader === "string" ? { userShader: raw.userShader } : {}),
  };
}

/** A property's default, as Neuroglancer takes it when none is given. */
export function defaultOf(p: PropertySpec): number | string {
  return p.default ?? (p.type === "rgb" ? "#000000" : p.type === "rgba" ? "#00000000" : 0);
}

/** An annotation's property values, defaults where it has none. */
export function propsOf(a: AnnotationJson, specs: PropertySpec[]): (number | string)[] {
  return specs.map((p, i) => a.props?.[i] ?? defaultOf(p));
}

export function propertyIndex(spec: LayerSpec, id: string): number {
  return (spec.annotationProperties ?? []).findIndex((p) => p.id === id);
}

/** The layer's fields: its properties (but the group), in order, then the text and ontology fields. */
export function fieldsOf(spec: LayerSpec, meta: LayerMeta): Field[] {
  const out: Field[] = [];
  for (const p of spec.annotationProperties ?? []) {
    if (p.id === GROUP) continue;
    const def = meta.fields.find((f) => f.id === p.id);
    const title = def?.title ?? p.description ?? p.id;
    if (p.type === "rgb" || p.type === "rgba") {
      out.push({ id: p.id, title, kind: "colour", storage: "property", type: p.type });
    } else if (p.enum_values !== undefined && p.enum_labels !== undefined) {
      // The value 0 labelled "" is the plugin's "none"; other programs' enums are kept as they are.
      const pairs = p.enum_values.map((v, i) => [v, p.enum_labels![i] ?? String(v)] as const).filter(([v, l]) => !(v === 0 && l === ""));
      out.push({ id: p.id, title, kind: "list", storage: "property", type: p.type, options: pairs.map(([, l]) => l), codes: pairs.map(([v]) => v) });
    } else {
      out.push({ id: p.id, title, kind: "number", storage: "property", type: p.type });
    }
  }
  for (const f of meta.fields) {
    if (f.kind === "text" || f.kind === "ontology") out.push({ ...f, storage: "state" });
  }
  return out;
}

/** A field's value on an annotation. */
export function readValue(field: Field, a: AnnotationJson, spec: LayerSpec, meta: LayerMeta): Value {
  if (field.storage === "state") return meta.values[a.id]?.[field.id];
  const specs = spec.annotationProperties ?? [];
  const i = specs.findIndex((p) => p.id === field.id);
  if (i < 0) return undefined;
  const v = propsOf(a, specs)[i];
  if (field.kind === "list") {
    const k = field.codes!.indexOf(Number(v));
    return k < 0 ? (Number(v) === 0 ? undefined : String(v)) : field.options![k];
  }
  return v;
}

/** A value as text, for the table and CSV. */
export function valueText(v: Value): string {
  if (v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(Number(v.toPrecision(7))) : "";
  if (typeof v === "string") return v;
  return v.name;
}

/** A field id from its title: a property id Neuroglancer takes (`[a-z][a-zA-Z0-9_]*`), not one of `taken`. */
export function fieldId(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  used.add(GROUP);
  let base = title
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-zA-Z]+/, "");
  base = base ? base[0].toLowerCase() + base.slice(1) : "field";
  let id = base;
  for (let n = 2; used.has(id); ++n) id = `${base}_${n}`;
  return id;
}

/** The enum property of a list: 0 is none, then each value. */
export function listProperty(id: string, title: string, options: string[], dflt = 0): PropertySpec {
  return {
    id,
    type: options.length > 254 ? "uint16" : "uint8",
    description: title,
    ...(dflt ? { default: dflt } : {}),
    enum_values: [0, ...options.map((_, i) => i + 1)],
    enum_labels: ["", ...options],
  };
}

/** Adds a property at the end, each annotation taking `value(a)` (its default otherwise). */
export function addProperty(spec: LayerSpec, p: PropertySpec, value?: (a: AnnotationJson) => number | string): LayerSpec {
  const specs = spec.annotationProperties ?? [];
  return {
    ...spec,
    annotationProperties: [...specs, p],
    annotations: spec.annotations.map((a) => ({ ...a, props: [...propsOf(a, specs), value?.(a) ?? defaultOf(p)] })),
  };
}

/** Replaces a property (same place), mapping each annotation's value. */
export function replaceProperty(spec: LayerSpec, p: PropertySpec, map: (v: number | string) => number | string = (v) => v): LayerSpec {
  const specs = spec.annotationProperties ?? [];
  const i = specs.findIndex((s) => s.id === p.id);
  if (i < 0) return addProperty(spec, p);
  return {
    ...spec,
    annotationProperties: specs.map((s, k) => (k === i ? p : s)),
    annotations: spec.annotations.map((a) => {
      const props = propsOf(a, specs);
      props[i] = map(props[i]);
      return { ...a, props };
    }),
  };
}

export function removeProperty(spec: LayerSpec, id: string): LayerSpec {
  const specs = spec.annotationProperties ?? [];
  const i = specs.findIndex((s) => s.id === id);
  if (i < 0) return spec;
  const rest = specs.filter((_, k) => k !== i);
  const out: LayerSpec = {
    ...spec,
    annotations: spec.annotations.map((a) => {
      const props = propsOf(a, specs).filter((_, k) => k !== i);
      const { props: _old, ...plain } = a;
      return rest.length ? { ...plain, props } : plain;
    }),
  };
  if (rest.length) out.annotationProperties = rest;
  else delete out.annotationProperties;
  return out;
}

/** Adds a field: a property for a list or a number, the plugin's record for the others. */
export function addField(spec: LayerSpec, meta: LayerMeta, def: FieldDef & { options?: string[] }): [LayerSpec, LayerMeta] {
  const { options, ...plain } = def;
  const taken = [...(spec.annotationProperties ?? []).map((p) => p.id), ...meta.fields.map((f) => f.id)];
  const field: FieldDef = { ...plain, id: def.id && !taken.includes(def.id) ? def.id : fieldId(def.title, taken) };
  const next = { ...meta, fields: [...meta.fields, field] };
  if (def.kind === "list") return [addProperty(spec, listProperty(field.id, field.title, options ?? [])), next];
  if (def.kind === "number") return [addProperty(spec, { id: field.id, type: "float32", description: field.title }), next];
  return [spec, next];
}

/**
 * Changes a field's title, a list's values (an annotation keeps its value
 * when the new list still has it, by name), or an ontology's terms.
 */
export function updateField(spec: LayerSpec, meta: LayerMeta, id: string, change: { title?: string; options?: string[]; ontology?: OntologyRef }): [LayerSpec, LayerMeta] {
  const field = fieldsOf(spec, meta).find((f) => f.id === id);
  if (field === undefined) return [spec, meta];
  const title = change.title?.trim() || field.title;
  const known = meta.fields.some((f) => f.id === id);
  const def: FieldDef = { id, title, kind: field.kind, ...(field.ontology || change.ontology ? { ontology: change.ontology ?? field.ontology } : {}) };
  const nextMeta = { ...meta, fields: known ? meta.fields.map((f) => (f.id === id ? def : f)) : [...meta.fields, def] };
  let next = spec;
  const p = spec.annotationProperties?.find((s) => s.id === id);
  if (p !== undefined && field.kind === "list") {
    const options = change.options ?? field.options!;
    const ours = p.enum_values?.[0] === 0 && p.enum_labels?.[0] === "";
    if (ours || change.options !== undefined) {
      const old = new Map(field.codes!.map((c, i) => [c, field.options![i]]));
      next = replaceProperty(spec, listProperty(id, title, options), (v) => {
        const label = old.get(Number(v));
        return label === undefined ? 0 : options.indexOf(label) + 1;
      });
    } else {
      next = replaceProperty(spec, { ...p, description: title });
    }
  } else if (p !== undefined) {
    next = replaceProperty(spec, { ...p, description: title });
  }
  return [next, nextMeta];
}

export function removeField(spec: LayerSpec, meta: LayerMeta, id: string): [LayerSpec, LayerMeta] {
  const values: LayerMeta["values"] = {};
  for (const [a, v] of Object.entries(meta.values)) {
    const { [id]: _gone, ...rest } = v;
    if (Object.keys(rest).length) values[a] = rest;
  }
  return [removeProperty(spec, id), { ...meta, fields: meta.fields.filter((f) => f.id !== id), values, colourBy: meta.colourBy === id ? undefined : meta.colourBy }];
}

/**
 * Sets a field's value on annotations: a list's value by its name ("" for
 * none), a number (empty for 0), text, or an ontology term.
 */
export function setValue(spec: LayerSpec, meta: LayerMeta, ids: string[], field: Field, value: string | number | TermValue | undefined): [LayerSpec, LayerMeta] {
  const set = new Set(ids);
  if (field.storage === "state") {
    const values = { ...meta.values };
    for (const id of ids) {
      const { [field.id]: _old, ...rest } = values[id] ?? {};
      const empty = value === undefined || value === "";
      const next = empty ? rest : { ...rest, [field.id]: typeof value === "number" ? String(value) : value };
      if (Object.keys(next).length) values[id] = next;
      else delete values[id];
    }
    return [spec, { ...meta, values }];
  }
  const specs = spec.annotationProperties ?? [];
  const i = specs.findIndex((p) => p.id === field.id);
  if (i < 0 || field.kind === "colour") return [spec, meta];
  let stored: number;
  if (field.kind === "list") {
    const k = field.options!.indexOf(String(value ?? ""));
    stored = k < 0 ? 0 : field.codes![k];
  } else {
    stored = value === undefined || value === "" ? 0 : Number(value);
    if (!Number.isFinite(stored)) return [spec, meta];
  }
  const annotations = spec.annotations.map((a) => {
    if (!set.has(a.id)) return a;
    const props = propsOf(a, specs);
    props[i] = stored;
    return { ...a, props };
  });
  return [{ ...spec, annotations }, meta];
}

/** Forgets values and comments of annotations the layer no longer has. */
export function prune(spec: LayerSpec, meta: LayerMeta): LayerMeta {
  const ids = new Set(spec.annotations.map((a) => a.id));
  const keep = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => ids.has(k)));
  return { ...meta, values: keep(meta.values), comments: keep(meta.comments) };
}
