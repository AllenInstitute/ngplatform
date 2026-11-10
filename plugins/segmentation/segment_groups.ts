/**
 * Segment groups, as WebKnossos's segment list has them: named groups of a
 * label volume's segments, each with a colour, shown or hidden as a whole.
 * Pure: the groups of one volume and the edits on them.
 *
 * They are kept in the plugin's slice of the workspace state, per scene
 * (each scene's slice is its own), by the volume's id (`Session.id`, which
 * a volume kept in the browser keeps through a reload): so they are in the
 * link and undo with the workspace's other changes.  A segment is in one
 * group at most; one in none is listed under "No group".
 */

export interface SegmentGroup {
  id: string;
  name: string;
  /** The colour given to the group's segments when it was last set. */
  colour: string;
  /** Its rows folded away in the list. */
  collapsed?: boolean;
}

export interface VolumeGroups {
  groups: SegmentGroup[];
  /** Each grouped segment's group id, by the segment's value. */
  of: Record<string, string>;
}

/** The plugin's slice of the workspace state. */
export interface SegmentationSaved {
  /** Segment groups by label volume id. */
  groups?: Record<string, VolumeGroups>;
  /** Segments hidden, by label volume id, for a volume with more segments than its layer's list may name (see segments.ts). */
  hidden?: Record<string, number[]>;
}

/** Colours for new groups, distinct from the segment palette's first ones. */
const GROUP_COLOURS = ["#ff9f1c", "#2ec4b6", "#e71d36", "#9b5de5", "#00bbf9", "#f15bb5", "#fee440", "#00f5d4"];

export const noGroups = (): VolumeGroups => ({ groups: [], of: {} });

/** A volume's groups from saved state, whatever shape it is in (dropping what does not fit). */
export function readGroups(raw: unknown): VolumeGroups {
  const r = raw as Partial<VolumeGroups> | undefined;
  const groups = Array.isArray(r?.groups)
    ? r.groups.filter((g): g is SegmentGroup => typeof g?.id === "string" && typeof g.name === "string").map((g) => ({ id: g.id, name: g.name, colour: typeof g.colour === "string" ? g.colour : GROUP_COLOURS[0], ...(g.collapsed ? { collapsed: true } : {}) }))
    : [];
  const ids = new Set(groups.map((g) => g.id));
  const of: Record<string, string> = {};
  for (const [value, id] of Object.entries(r?.of ?? {})) if (ids.has(id) && /^\d+$/.test(value)) of[value] = id;
  return { groups, of };
}

/** A new, empty group ("Group n", the smallest n not taken), with the next colour. */
export function addGroup(vg: VolumeGroups, name?: string, id = newId(vg)): { next: VolumeGroups; id: string } {
  const taken = new Set(vg.groups.map((g) => g.name));
  let n = 1;
  while (taken.has(`Group ${n}`)) ++n;
  const group: SegmentGroup = { id, name: name?.trim() || `Group ${n}`, colour: GROUP_COLOURS[vg.groups.length % GROUP_COLOURS.length] };
  return { next: { groups: [...vg.groups, group], of: vg.of }, id };
}

function newId(vg: VolumeGroups): string {
  let n = vg.groups.length + 1;
  while (vg.groups.some((g) => g.id === `g${n}`)) ++n;
  return `g${n}`;
}

/** Changes a group's name, colour or folding. */
export function editGroup(vg: VolumeGroups, id: string, patch: Partial<Pick<SegmentGroup, "name" | "colour" | "collapsed">>): VolumeGroups {
  return {
    groups: vg.groups.map((g) => {
      if (g.id !== id) return g;
      const next = { ...g, ...patch };
      if (patch.name !== undefined) next.name = patch.name.trim() || g.name;
      if (!next.collapsed) delete next.collapsed;
      return next;
    }),
    of: vg.of,
  };
}

/** Takes a group away; its segments stay, in no group. */
export function removeGroup(vg: VolumeGroups, id: string): VolumeGroups {
  return { groups: vg.groups.filter((g) => g.id !== id), of: Object.fromEntries(Object.entries(vg.of).filter(([, g]) => g !== id)) };
}

/** Puts segments in a group (undefined: in none), out of any other. */
export function assign(vg: VolumeGroups, values: number[], id: string | undefined): VolumeGroups {
  if (id !== undefined && !vg.groups.some((g) => g.id === id)) return vg;
  const of = { ...vg.of };
  for (const v of values) {
    if (id === undefined) delete of[String(v)];
    else of[String(v)] = id;
  }
  return { groups: vg.groups, of };
}

/** The group a segment is in, if any. */
export function groupOf(vg: VolumeGroups, value: number): SegmentGroup | undefined {
  const id = vg.of[String(value)];
  return id === undefined ? undefined : vg.groups.find((g) => g.id === id);
}

/** Of these segments, those in a group. */
export function members(vg: VolumeGroups, id: string, values: number[]): number[] {
  return values.filter((v) => vg.of[String(v)] === id);
}

/**
 * The segment list in sections: each group in order with its rows (in the
 * order given), then the rows in no group (`group` undefined).
 */
export function grouped<R extends { value: number }>(vg: VolumeGroups, rows: R[]): { group: SegmentGroup | undefined; rows: R[] }[] {
  const sections: { group: SegmentGroup | undefined; rows: R[] }[] = vg.groups.map((group) => ({ group, rows: rows.filter((r) => vg.of[String(r.value)] === group.id) }));
  sections.push({ group: undefined, rows: rows.filter((r) => groupOf(vg, r.value) === undefined) });
  return sections;
}
