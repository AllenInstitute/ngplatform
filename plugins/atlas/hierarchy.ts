/**
 * An atlas as a tree of regions, made from a segmentation's lookup table:
 *
 * - a table with parents (the Allen ontology's structure graph): its own
 *   hierarchy, each structure under the one it is part of;
 * - FreeSurfer's labels: grouped by what their codes and names say (cortex,
 *   white matter, subcortical grey matter, cerebellum, brain stem,
 *   ventricles), each group split into left and right;
 * - Schaefer's parcellations: by hemisphere, then network;
 * - any other table: flat, in the table's order.
 *
 * A group the table does not number (FreeSurfer's "Cerebral cortex") has no
 * value; a region's labels are its own value and its descendants'.  Pure
 * functions, no DOM: tested in ./tests.
 */
import type { LookupEntry, LookupTable } from "@ngplatform/sdk";

export interface Region {
  /** Unique in its atlas: the value, or `group:<path>` for a group the table does not number. */
  key: string;
  /** The label's value in the image; undefined for a group. */
  value?: bigint;
  /** The full name. */
  name: string;
  /** A short name, when the table gives a full name too (the Allen ontology's acronyms). */
  acronym?: string;
  colour?: [number, number, number];
  parent?: Region;
  children: Region[];
}

/** How the tree was made, for saying so. */
export type AtlasKind = "hierarchy" | "freesurfer" | "schaefer" | "flat";

export const KIND_TEXT: Record<AtlasKind, string> = {
  hierarchy: "the table's own hierarchy",
  freesurfer: "FreeSurfer's labels grouped by their codes and names",
  schaefer: "Schaefer's parcels by hemisphere and network",
  flat: "a flat list (the table has no hierarchy)",
};

export class Atlas {
  private readonly byValue = new Map<bigint, Region>();
  private readonly byKey = new Map<string, Region>();

  constructor(
    readonly roots: Region[],
    readonly kind: AtlasKind,
  ) {
    for (const r of this.all()) {
      this.byKey.set(r.key, r);
      if (r.value !== undefined) this.byValue.set(r.value, r);
    }
  }

  /** The tree a table makes (see the top of this file). */
  static fromTable(table: LookupTable): Atlas {
    const { entries } = table;
    if (entries.some((e) => e.parent !== undefined)) return new Atlas(hierarchy(entries), "hierarchy");
    if (isFreeSurfer(entries)) return new Atlas(freeSurferGroups(entries), "freesurfer");
    if (isSchaefer(entries)) return new Atlas(schaeferGroups(entries), "schaefer");
    return new Atlas(entries.map((e) => regionOf(e)), "flat");
  }

  /** Every region, depth first. */
  all(): Region[] {
    const out: Region[] = [];
    const visit = (r: Region) => {
      out.push(r);
      r.children.forEach(visit);
    };
    this.roots.forEach(visit);
    return out;
  }

  get size(): number {
    return this.byKey.size;
  }

  region(key: string): Region | undefined {
    return this.byKey.get(key);
  }

  /** The region a label value is, if the table has it. */
  regionOf(value: bigint): Region | undefined {
    return this.byValue.get(value);
  }

  /** A region and everything above it, the root first. */
  path(region: Region): Region[] {
    const out: Region[] = [];
    for (let r: Region | undefined = region; r !== undefined; r = r.parent) out.unshift(r);
    return out;
  }

  /** "Isocortex › Somatomotor areas › Primary motor area". */
  pathText(region: Region, separator = " › "): string {
    return this.path(region)
      .map((r) => r.name)
      .join(separator);
  }

  /** A region and all its descendants, depth first. */
  descendants(region: Region): Region[] {
    const out: Region[] = [];
    const visit = (r: Region) => {
      out.push(r);
      r.children.forEach(visit);
    };
    visit(region);
    return out;
  }

  /** The label values of a region and its descendants. */
  values(region: Region): bigint[] {
    return this.descendants(region)
      .map((r) => r.value)
      .filter((v): v is bigint => v !== undefined);
  }

  /**
   * The regions whose name, acronym or value match every word of `query`
   * (case aside), and those to show for them: the matches, their ancestors
   * (to reach them) and, with `descendants`, everything under a match.
   */
  search(query: string, descendants = false): { matches: Set<Region>; shown: Set<Region> } {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
    const matches = new Set<Region>();
    const shown = new Set<Region>();
    if (words.length === 0) return { matches, shown };
    for (const r of this.all()) {
      const text = `${r.name} ${r.acronym ?? ""}`.toLowerCase();
      const value = r.value?.toString();
      if (!words.every((w) => text.includes(w) || w === value)) continue;
      matches.add(r);
      for (const a of this.path(r)) shown.add(a);
      if (descendants) for (const d of this.descendants(r)) shown.add(d);
    }
    return { matches, shown };
  }

  /**
   * Each region's total over itself and its descendants, of a number per
   * label value (voxel counts); regions with none are left out.
   */
  totals(perValue: ReadonlyMap<bigint, number>): Map<Region, number> {
    const out = new Map<Region, number>();
    const visit = (r: Region): number => {
      let sum = r.value === undefined ? 0 : (perValue.get(r.value) ?? 0);
      for (const c of r.children) sum += visit(c);
      if (sum > 0) out.set(r, sum);
      return sum;
    };
    this.roots.forEach(visit);
    return out;
  }
}

/** A table's entry as a region: a full name with its acronym, when the table gives both. */
function regionOf(e: LookupEntry): Region {
  const full = e.description !== undefined && e.description !== e.name;
  return { key: e.value.toString(), value: e.value, name: full ? e.description! : e.name, ...(full ? { acronym: e.name } : {}), colour: e.colour, children: [] };
}

function adopt(parent: Region, child: Region): void {
  child.parent = parent;
  parent.children.push(child);
}

/** Entries with parents: each under its parent; those whose parent the table lacks are roots. */
function hierarchy(entries: LookupEntry[]): Region[] {
  const regions = new Map(entries.map((e) => [e.value, regionOf(e)]));
  const roots: Region[] = [];
  for (const e of entries) {
    const r = regions.get(e.value)!;
    const parent = e.parent === undefined ? undefined : regions.get(e.parent);
    if (parent === undefined || parent === r) roots.push(r);
    else adopt(parent, r);
  }
  return roots;
}

/** Groups by path ("Cerebral cortex", "Left hemisphere"), made as entries need them, in order of first use. */
class Groups {
  readonly roots: Region[] = [];
  private readonly made = new Map<string, Region>();

  /** The group at `path`, or the top level for an empty path. */
  private at(path: string[]): Region | undefined {
    if (path.length === 0) return undefined;
    const key = `group:${path.join("/")}`;
    let g = this.made.get(key);
    if (g === undefined) {
      g = { key, name: path[path.length - 1], children: [] };
      this.made.set(key, g);
      const parent = this.at(path.slice(0, -1));
      if (parent === undefined) this.roots.push(g);
      else adopt(parent, g);
    }
    return g;
  }

  add(path: string[], region: Region): void {
    const parent = this.at(path);
    if (parent === undefined) this.roots.push(region);
    else adopt(parent, region);
  }

  /** The top-level groups in a given order (others after, as made). */
  ordered(order: string[]): Region[] {
    const rank = (r: Region) => {
      const i = order.indexOf(r.name);
      return i < 0 ? order.length : i;
    };
    return [...this.roots].sort((a, b) => rank(a) - rank(b));
  }
}

// ------------------------------------------------------------ FreeSurfer

const LEFT = "Left hemisphere";
const RIGHT = "Right hemisphere";

export const FREESURFER_CLASSES = ["Cerebral cortex", "Cerebral white matter", "Subcortical grey matter", "Cerebellum", "Brain stem", "Ventricles and CSF", "Other"] as const;
type FreeSurferClass = (typeof FREESURFER_CLASSES)[number];

/** Names only FreeSurfer's tables have (aseg's, aparc's). */
const FREESURFER_NAME = /^(Left|Right)-(Cerebral-White-Matter|Lateral-Ventricle|Thalamus|Hippocampus|Cerebellum-Cortex)$|^ctx[-_][lr]h[-_]/;

function isFreeSurfer(entries: LookupEntry[]): boolean {
  return entries.some((e) => FREESURFER_NAME.test(e.name));
}

/** The hemisphere a FreeSurfer label is in, from its code or its name. */
function freeSurferSide(value: number, name: string): string | undefined {
  // aparc (1000s, 2000s), wmparc (3000s, 4000s), Destrieux (11100s, 12100s) and its white matter (13100s, 14100s).
  if ((value >= 1000 && value < 2000) || (value >= 3000 && value < 4000) || (value >= 11000 && value < 12000) || (value >= 13000 && value < 14000)) return LEFT;
  if ((value >= 2000 && value < 3000) || (value >= 4000 && value < 5000) || (value >= 12000 && value < 13000) || (value >= 14000 && value < 15000)) return RIGHT;
  if (value === 5001) return LEFT;
  if (value === 5002) return RIGHT;
  if (/^(Left|lh)[-_.]|[-_.](lh|left)[-_.]|^ctx[-_]lh|^wm[-_]lh/i.test(name)) return LEFT;
  if (/^(Right|rh)[-_.]|[-_.](rh|right)[-_.]|^ctx[-_]rh|^wm[-_]rh/i.test(name)) return RIGHT;
  return undefined;
}

/** The kind of tissue a FreeSurfer label is, from its code or its name. */
export function freeSurferClass(value: number, name: string): FreeSurferClass {
  if ((value >= 1000 && value < 3000) || (value >= 11000 && value < 13000)) return "Cerebral cortex";
  if ((value >= 3000 && value < 5000) || value === 5001 || value === 5002 || (value >= 13000 && value < 15000)) return "Cerebral white matter";
  if (/non-WM/i.test(name)) return "Other";
  if (/Ventricle|Inf-Lat-Vent|Inf_Lat_Vent|^CSF|choroid-plexus/i.test(name)) return "Ventricles and CSF";
  if (/Cerebellum|Vermis|Floculus|CblumNodulus/i.test(name)) return "Cerebellum";
  if (/Cerebral-White-Matter|Cerebral_White_Matter|WM-hypointensities|Cerebral-WM|IntCapsule|WMCrowns|WMSA|^CC_|Corpus_Callosum|Optic-Chiasm|Fornix|wm-intensity/i.test(name)) return "Cerebral white matter";
  if (/Cerebral-Cortex|Cerebral_Cortex|Insula|Operculum|^ctx/i.test(name)) return "Cerebral cortex";
  if (/Brain-Stem|brainstem|Midbrain|Pons|Medulla|^SCP$|Locus-Coeruleus|Substancia-Nigra/i.test(name)) return "Brain stem";
  if (/Thalamus|Caudate|Putamen|Pallidum|Hippocampus|Amygdala|Accumbens|VentralDC|Claustrum|Basal-Ganglia|Subcortical-Gray/i.test(name)) return "Subcortical grey matter";
  return "Other";
}

/** FreeSurfer's labels by tissue, then hemisphere (labels on neither side sit in the tissue's group itself). */
function freeSurferGroups(entries: LookupEntry[]): Region[] {
  const groups = new Groups();
  for (const e of entries) {
    const value = Number(e.value);
    const kind = freeSurferClass(value, e.name);
    const side = freeSurferSide(value, e.name);
    groups.add(side === undefined ? [kind] : [kind, side], regionOf(e));
  }
  const roots = groups.ordered([...FREESURFER_CLASSES]);
  // Within a tissue: left, right, then the labels on neither side.
  for (const g of roots) g.children.sort((a, b) => sideRank(a) - sideRank(b));
  return roots;
}

function sideRank(r: Region): number {
  return r.value !== undefined ? 2 : r.name === LEFT ? 0 : r.name === RIGHT ? 1 : 2;
}

// -------------------------------------------------------------- Schaefer

/** "7Networks_LH_Vis_1", "17Networks_RH_DefaultA_PFCm_2". */
const SCHAEFER_NAME = /^\d+Networks_(LH|RH)_([A-Za-z]+)_/;

function isSchaefer(entries: LookupEntry[]): boolean {
  const named = entries.filter((e) => e.value !== 0n);
  return named.length > 0 && named.filter((e) => SCHAEFER_NAME.test(e.name)).length >= 0.9 * named.length;
}

function schaeferGroups(entries: LookupEntry[]): Region[] {
  const groups = new Groups();
  for (const e of entries) {
    const m = SCHAEFER_NAME.exec(e.name);
    groups.add(m === null ? [] : [m[1] === "LH" ? LEFT : RIGHT, m[2]], regionOf(e));
  }
  return groups.roots;
}
