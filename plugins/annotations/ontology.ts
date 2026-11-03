/**
 * Term lists for annotation values: a plain list (one term a line, or
 * `id<tab>name`), an OBO file's terms (`[Term]` stanzas, `is_a` giving the
 * parent), JSON (a list of names or of `{id, name, parent}`, or a tree with
 * `children`, as the Allen structure graph is), or a label lookup table
 * (the Allen ontology through the platform's tables).  Pure functions.
 */
import type { LookupTable } from "@ngplatform/sdk";

export interface Term {
  id: string;
  name: string;
  /** A short name (an Allen acronym), when the list gives one. */
  short?: string;
  /** The id of the term this one is part of, or a kind of. */
  parent?: string;
}

export interface Ontology {
  title: string;
  terms: Term[];
}

/** A value of an ontology field: the term's id, and its name when chosen (so it reads without the list). */
export interface TermValue {
  id: string;
  name: string;
}

/** Reads a term list from a file's text; `fileName` decides the format where the text does not. */
export function parseTerms(text: string, fileName = ""): Ontology {
  const title = fileName.replace(/\.[^.]*$/, "") || "Terms";
  const trimmed = text.trim();
  if (/\.obo$/i.test(fileName) || /^\[Term\]/m.test(trimmed)) return parseObo(trimmed, title);
  if (/\.json$/i.test(fileName) || /^[[{]/.test(trimmed)) return { title, terms: parseJsonTerms(JSON.parse(trimmed)) };
  const terms: Term[] = [];
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const tab = line.split("\t");
    if (tab.length >= 2 && tab[0].trim() !== "" && tab[1].trim() !== "") terms.push({ id: tab[0].trim(), name: tab[1].trim(), ...(tab[2]?.trim() ? { parent: tab[2].trim() } : {}) });
    else terms.push({ id: line, name: line });
  }
  return { title, terms: unique(terms) };
}

function parseObo(text: string, fallback: string): Ontology {
  const title = /^ontology:\s*(.+)$/m.exec(text)?.[1].trim() ?? fallback;
  const terms: Term[] = [];
  for (const stanza of text.split(/^\[/m)) {
    if (!stanza.startsWith("Term]")) continue;
    const tag = (name: string) => new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m").exec(stanza)?.[1];
    if (tag("is_obsolete") === "true") continue;
    const id = tag("id");
    if (id === undefined) continue;
    // "is_a: UBERON:0000062 ! organ": the id, without the comment.
    const parent = tag("is_a")?.split("!")[0].trim();
    terms.push({ id, name: tag("name") ?? id, ...(parent ? { parent } : {}) });
  }
  return { title, terms: unique(terms) };
}

function parseJsonTerms(json: unknown): Term[] {
  const out: Term[] = [];
  const visit = (node: unknown, parent: string | undefined) => {
    if (typeof node === "string" || typeof node === "number") {
      out.push({ id: String(node), name: String(node), ...(parent ? { parent } : {}) });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, parent));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const o = node as Record<string, unknown>;
    // A wrapper: the Allen API's {msg: [...]}, or {terms: [...]}.
    for (const key of ["msg", "terms", "structures", "items"]) {
      if (Array.isArray(o[key]) && o.id === undefined && o.name === undefined) {
        visit(o[key], parent);
        return;
      }
    }
    const name = o.name ?? o.label ?? o.title ?? o.acronym;
    const id = o.id ?? o.identifier ?? name;
    if (id === undefined || id === null) return;
    const own = o.parent ?? o.parent_structure_id ?? o.parent_id ?? parent;
    const short = typeof o.acronym === "string" && o.acronym !== name ? o.acronym : undefined;
    out.push({ id: String(id), name: String(name ?? id), ...(short ? { short } : {}), ...(own !== undefined && own !== null ? { parent: String(own) } : {}) });
    if (Array.isArray(o.children)) o.children.forEach((c) => visit(c, String(id)));
  };
  visit(json, undefined);
  return unique(out);
}

/** The first term of each id. */
function unique(terms: Term[]): Term[] {
  const seen = new Set<string>();
  return terms.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

/** A label lookup table as terms: its values as ids, its long names (or names) as names. */
export function lookupTerms(table: LookupTable): Term[] {
  return table.entries.map((e) => ({
    id: String(e.value),
    name: e.description ?? e.name,
    ...(e.description && e.description !== e.name ? { short: e.name } : {}),
    ...(e.parent !== undefined ? { parent: String(e.parent) } : {}),
  }));
}

/** A term's label in lists: its name, and its short name when it has one. */
export const termLabel = (t: Term) => (t.short ? `${t.name} (${t.short})` : t.name);

/**
 * Terms matching typed text, best first: an exact id, name or short name,
 * then names starting with it, then names containing it.
 */
export function searchTerms(terms: Term[], text: string, limit = 50): Term[] {
  const q = text.trim().toLowerCase();
  if (q === "") return terms.slice(0, limit);
  const scored: [number, Term][] = [];
  for (const t of terms) {
    const name = t.name.toLowerCase();
    const short = t.short?.toLowerCase() ?? "";
    const id = t.id.toLowerCase();
    const score = id === q || name === q || short === q ? 0 : name.startsWith(q) || short.startsWith(q) ? 1 : name.includes(q) || short.includes(q) || id.includes(q) ? 2 : -1;
    if (score >= 0) scored.push([score, t]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length)
    .slice(0, limit)
    .map(([, t]) => t);
}

/** The term typed: one whose label, name, short name or id is the text (case aside). */
export function findTerm(terms: Term[], text: string): Term | undefined {
  const q = text.trim().toLowerCase();
  if (q === "") return undefined;
  return terms.find((t) => termLabel(t).toLowerCase() === q) ?? terms.find((t) => t.name.toLowerCase() === q || t.short?.toLowerCase() === q || t.id.toLowerCase() === q);
}

/** A term's ancestors' names, nearest first (a search for a structure finds the terms within it). */
export function ancestorNames(terms: Term[] | Map<string, Term>, id: string): string[] {
  const byId = terms instanceof Map ? terms : new Map(terms.map((t) => [t.id, t]));
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let parent = byId.get(id)?.parent;
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent);
    const t = byId.get(parent);
    if (t === undefined) break;
    out.push(t.name, ...(t.short ? [t.short] : []));
    parent = t.parent;
  }
  return out;
}
