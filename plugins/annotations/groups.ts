/**
 * Groups of annotations, as WebKnossos groups its trees: named, nested,
 * each with a colour, shown or hidden.  An annotation's group is the
 * layer's `group` property (an enum whose labels are the groups' paths, so
 * Neuroglancer's own panels name it); the tree (parents, colours, hidden)
 * is the plugin's record.  Hiding a group and colouring by group or by a
 * value are the layer's shader, which this module writes (marked, so a
 * shader of the user's own is not taken for it).  Pure functions.
 */
import type { AnnotationJson } from "./measure.js";
import { type Field, GROUP, type Group, type LayerMeta, type LayerSpec, propsOf, replaceProperty, type PropertySpec } from "./values.js";

/** Distinct colours for groups and list values, in order. */
export const PALETTE = ["#e4572e", "#3fb6c9", "#f3a712", "#8cb369", "#a06cd5", "#ef798a", "#4c8bf5", "#c5d86d", "#ff9f1c", "#2ec4b6", "#d4a5a5", "#9b5de5"];

export const paletteColour = (i: number) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

/** The first line of a shader written here. */
export const SHADER_MARK = "// Annotations tab: colours and hidden groups (rewritten when they change).";

/** The layer's groups: the plugin's record, and a group for each value of the property it does not know. */
export function groupsOf(spec: LayerSpec, meta: LayerMeta): Group[] {
  const groups = meta.groups.slice();
  const p = spec.annotationProperties?.find((s) => s.id === GROUP);
  p?.enum_values?.forEach((v, i) => {
    if (v === 0 || groups.some((g) => g.value === v)) return;
    groups.push({ value: v, name: p.enum_labels?.[i]?.split(" / ").pop() || `Group ${v}`, colour: paletteColour(groups.length) });
  });
  return groups;
}

/** A group's name with its parents' ("Cortex / Layer 5"); "" for no group. */
export function groupPath(groups: Group[], value: number): string {
  const names: string[] = [];
  const seen = new Set<number>();
  let g = groups.find((x) => x.value === value);
  while (g !== undefined && !seen.has(g.value)) {
    seen.add(g.value);
    names.unshift(g.name);
    const parent = g.parent;
    g = parent === undefined ? undefined : groups.find((x) => x.value === parent);
  }
  return names.join(" / ");
}

/** The groups in tree order, each with its depth. */
export function groupTree(groups: Group[]): { group: Group; depth: number }[] {
  const out: { group: Group; depth: number }[] = [];
  const known = new Set(groups.map((g) => g.value));
  const visit = (parent: number | undefined, depth: number, seen: Set<number>) => {
    for (const g of groups) {
      const p = g.parent !== undefined && known.has(g.parent) ? g.parent : undefined;
      if (p !== parent || seen.has(g.value)) continue;
      seen.add(g.value);
      out.push({ group: g, depth });
      visit(g.value, depth + 1, seen);
    }
  };
  visit(undefined, 0, new Set());
  return out;
}

/** A group and every group within it. */
export function withinGroup(groups: Group[], value: number): Set<number> {
  const out = new Set([value]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of groups) {
      if (g.parent !== undefined && out.has(g.parent) && !out.has(g.value)) {
        out.add(g.value);
        grew = true;
      }
    }
  }
  return out;
}

/** Groups not shown: hidden, or within a hidden group. */
export function hiddenValues(groups: Group[]): number[] {
  const out = new Set<number>();
  for (const g of groups) if (g.hidden) for (const v of withinGroup(groups, g.value)) out.add(v);
  return [...out].sort((a, b) => a - b);
}

/** Adds a group (within `parent`, if given); returns the groups and the new one's value. */
export function addGroup(groups: Group[], name: string, parent?: number): { groups: Group[]; value: number } {
  const value = Math.max(0, ...groups.map((g) => g.value)) + 1;
  const group: Group = { value, name: name.trim() || `Group ${value}`, colour: paletteColour(value - 1), ...(parent !== undefined ? { parent } : {}) };
  return { groups: [...groups, group], value };
}

/** Removes a group: groups within it move to its parent, and so do its annotations (`moveTo`). */
export function removeGroup(groups: Group[], value: number): { groups: Group[]; moveTo: number } {
  const gone = groups.find((g) => g.value === value);
  const parent = gone?.parent;
  return {
    groups: groups.filter((g) => g.value !== value).map((g) => (g.parent === value ? withParent(g, parent) : g)),
    moveTo: parent ?? 0,
  };
}

/** A group moved under another (or to the top); not into itself or a group within it. */
export function moveGroup(groups: Group[], value: number, parent: number | undefined): Group[] {
  if (parent !== undefined && withinGroup(groups, value).has(parent)) return groups;
  return groups.map((g) => (g.value === value ? withParent(g, parent) : g));
}

function withParent(g: Group, parent: number | undefined): Group {
  const { parent: _old, ...rest } = g;
  return parent === undefined ? rest : { ...rest, parent };
}

/** An annotation's group (0 for none). */
export function groupOf(spec: LayerSpec, a: AnnotationJson): number {
  const specs = spec.annotationProperties ?? [];
  const i = specs.findIndex((p) => p.id === GROUP);
  return i < 0 ? 0 : Number(propsOf(a, specs)[i]) || 0;
}

/** The `group` property for these groups: their paths as its labels, new annotations going to `active`. */
export function groupProperty(groups: Group[], active = 0): PropertySpec {
  return {
    id: GROUP,
    type: "uint16",
    description: "Group",
    ...(active && groups.some((g) => g.value === active) ? { default: active } : {}),
    enum_values: [0, ...groups.map((g) => g.value)],
    enum_labels: ["", ...groups.map((g) => groupPath(groups, g.value))],
  };
}

/**
 * Writes the groups: the layer's `group` property (made when the layer has
 * none) and the plugin's record.  Annotations whose group is gone take
 * `moveTo`'s.
 */
export function writeGroups(spec: LayerSpec, meta: LayerMeta, groups: Group[], active = meta.activeGroup ?? 0, moved?: { from: number; to: number }): [LayerSpec, LayerMeta] {
  const valid = active && groups.some((g) => g.value === active) ? active : 0;
  const known = new Set(groups.map((g) => g.value));
  const p = groupProperty(groups, valid);
  const next = replaceProperty(spec, p, (v) => {
    const n = Number(v) || 0;
    if (moved && n === moved.from) return moved.to;
    return known.has(n) ? n : 0;
  });
  const nextMeta: LayerMeta = { ...meta, groups, activeGroup: valid || undefined };
  return [next, nextMeta];
}

/** Puts annotations in a group (0: none); the layer must have the group property. */
export function setGroup(spec: LayerSpec, ids: string[], value: number): LayerSpec {
  const specs = spec.annotationProperties ?? [];
  const i = specs.findIndex((p) => p.id === GROUP);
  if (i < 0) return spec;
  const set = new Set(ids);
  return {
    ...spec,
    annotations: spec.annotations.map((a) => {
      if (!set.has(a.id)) return a;
      const props = propsOf(a, specs);
      props[i] = value;
      return { ...a, props };
    }),
  };
}

// --------------------------------------------------------------- shader

const glslColour = (hex: string) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  const c = m ? [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255) : [1, 1, 1];
  return `vec3(${c.map((v) => v.toFixed(3)).join(", ")})`;
};

/** A colour for each of a list's values, in order. */
export const optionColours = (field: Field) => (field.options ?? []).map((_, i) => paletteColour(i));

/**
 * The layer's shader for its hidden groups and its colouring (by group, by
 * a list's values, or along a number's range between `range`), or
 * undefined when it needs none.
 */
export function layerShader(spec: LayerSpec, meta: LayerMeta, fields: Field[], range?: [number, number]): string | undefined {
  const groups = groupsOf(spec, meta);
  const hasGroups = propsIndex(spec, GROUP) >= 0;
  const hidden = hasGroups ? hiddenValues(groups) : [];
  const by = meta.colourBy;
  const field = by && by !== GROUP ? fields.find((f) => f.id === by && f.storage === "property") : undefined;
  const byGroup = by === GROUP && hasGroups;
  if (hidden.length === 0 && !byGroup && field === undefined) return undefined;
  const lines = [SHADER_MARK, "void main() {"];
  if (hidden.length) lines.push(`  if (${hidden.map((v) => `prop_${GROUP}() == ${v}u`).join(" || ")}) discard;`);
  lines.push("  vec3 c = defaultColor();");
  if (byGroup) {
    for (const g of groups) lines.push(`  if (prop_${GROUP}() == ${g.value}u) c = ${glslColour(g.colour)};`);
  } else if (field?.kind === "list") {
    const colours = optionColours(field);
    // Signed properties are ints in the shader, unsigned ones uints.
    const suffix = field.type?.startsWith("int") ? "" : "u";
    field.codes!.forEach((code, i) => lines.push(`  if (prop_${field.id}() == ${code}${suffix}) c = ${glslColour(colours[i])};`));
  } else if (field?.kind === "number") {
    const [lo, hi] = range ?? [0, 1];
    const span = hi > lo ? hi - lo : 1;
    lines.push(`  float t = clamp((float(prop_${field.id}()) - ${lo.toPrecision(7)}) / ${span.toPrecision(7)}, 0.0, 1.0);`);
    lines.push("  c = mix(vec3(0.231, 0.298, 0.753), vec3(0.906, 0.776, 0.149), t);");
  } else if (field?.kind === "colour") {
    lines.push(`  c = prop_${field.id}().rgb;`);
  }
  lines.push("  setColor(c);", "}");
  return lines.join("\n") + "\n";
}

const propsIndex = (spec: LayerSpec, id: string) => (spec.annotationProperties ?? []).findIndex((p) => p.id === id);

/**
 * The layer with its shader brought up to date: the one made here, or
 * none; a shader of the user's own is replaced only when colours or hidden
 * groups need one.
 */
export function withShader(spec: LayerSpec, meta: LayerMeta, fields: Field[], range?: [number, number]): LayerSpec {
  return withShaderKept(spec, meta, fields, range)[0];
}

/**
 * As `withShader`, and the record to keep with it: a shader of the user's
 * own replaced here is kept in the record (`userShader`), and put back when
 * no shader made here is needed any more.
 */
export function withShaderKept(spec: LayerSpec, meta: LayerMeta, fields: Field[], range?: [number, number]): [LayerSpec, LayerMeta] {
  const shader = layerShader(spec, meta, fields, range);
  const ours = spec.shader === undefined || spec.shader.startsWith(SHADER_MARK);
  if (shader !== undefined) {
    const kept = !ours && spec.shader !== undefined ? { ...meta, userShader: spec.shader } : meta;
    return [shader === spec.shader ? spec : { ...spec, shader }, kept];
  }
  if (!ours || spec.shader === undefined) return [spec, meta];
  const { shader: _gone, ...rest } = spec;
  if (meta.userShader !== undefined) {
    const { userShader, ...m } = meta;
    return [{ ...rest, shader: userShader }, m];
  }
  return [rest, meta];
}
