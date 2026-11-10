/**
 * The Collection panel's graph, laid out so it stays readable with a
 * hundred members: a group per coordinate system, the system's box on top
 * and its members in rows of two below it, each member's box naming the
 * transform that joins it (so no edge label crosses a box).  Members joined
 * to no system are grouped last.  A group of more than `shown` members
 * shows the first few and a "+N more" box that opens it; the Members card
 * lists every one.  Transforms between systems are arcs in a gutter on the
 * right, their kinds written in the system's box.
 *
 * Pure functions, no DOM: the panel (./plugin.ts) draws the boxes and moves
 * the keyboard's focus between them with `nextBox`.  Tested in ./tests.
 */

/** What the graph shows: the systems, the members (by the ids, names and own systems a transform may name them by) and the transforms. */
export interface GraphInput {
  systems: { id: string; name?: string }[];
  members: { name: string; keys: string[]; warped?: boolean; hidden?: boolean }[];
  transforms: { input: string; output: string; type: string }[];
}

export interface GraphBox {
  /** Unique in the layout, and kept across redraws (the focus follows it). */
  key: string;
  kind: "system" | "member" | "more";
  x: number;
  y: number;
  w: number;
  h: number;
  /** The text shown: a name, and a second line (the transform, or the system's own transforms). */
  lines: [string, string?];
  /** The accessible name: "member brain.ome.zarr, in system MNI, translation". */
  label: string;
  /** The full text, for the hover title. */
  title: string;
  /** The system it chooses (a system's box), or the member (a member's). */
  system?: string;
  member?: string;
  /** The group a "more" box opens or closes. */
  group?: string;
  warped?: boolean;
  hidden?: boolean;
}

export interface GraphLayout {
  width: number;
  height: number;
  boxes: GraphBox[];
  /** Arcs between systems' boxes, in the gutter. */
  arcs: { d: string }[];
  /** Lines from a system's box down to its rows of members. */
  spines: { d: string }[];
}

/** The layout's measures, in the SVG's own units (the panel scales it to its width). */
export const GRAPH = {
  width: 320,
  pad: 4,
  gutter: 18,
  indent: 14,
  columns: 2,
  gap: 4,
  groupGap: 10,
  line: 13,
  /** A caption character's width, near enough, for cutting names to their box. */
  char: 6.4,
};

/** The members a group shows before the rest are folded into "+N more". */
export const SHOWN = 12;

/** `text` cut to `chars` characters with an ellipsis. */
export function fit(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`;
}

/** A member's name for its box: without its .ome.zarr or .zarr when the whole does not fit (the rest tells members apart). */
export function shortName(name: string, chars: number): string {
  return name.length <= chars ? name : name.replace(/\.ome\.zarr$|\.zarr$/i, "");
}

/** The characters that fit a box `w` wide. */
const charsIn = (w: number) => Math.max(4, Math.floor((w - 12) / GRAPH.char));

/**
 * The graph's boxes, arcs and size.  `open` holds the groups shown in full;
 * `chosen` is the system the tab is viewed in (said in its name).
 */
export function layoutGraph(input: GraphInput, open: ReadonlySet<string> = new Set(), chosen?: string): GraphLayout {
  const { width: W, pad, gutter, indent, columns, gap, groupGap, line } = GRAPH;
  const systemName = new Map(input.systems.map((s) => [s.id, s.name ?? s.id]));
  const memberOf = new Map<string, string>();
  for (const m of input.members) for (const k of m.keys) memberOf.set(k, m.name);
  const byName = new Map(input.members.map((m) => [m.name, m]));

  // Each member under each system a transform joins it to directly, with the transforms' kinds.
  const joined = new Map<string, Map<string, string[]>>(input.systems.map((s) => [s.id, new Map()]));
  const elsewhere = new Map<string, string[]>();
  const between = new Map<string, { to: string; text: string }[]>();
  for (const t of input.transforms) {
    const [a, b] = [memberOf.get(t.input), memberOf.get(t.output)];
    const [sa, sb] = [systemName.has(t.input) ? t.input : undefined, systemName.has(t.output) ? t.output : undefined];
    const member = a ?? b;
    const system = a !== undefined ? sb : sa;
    if (member !== undefined && system !== undefined) {
      const kinds = joined.get(system)!.get(member) ?? [];
      if (!kinds.includes(t.type)) kinds.push(t.type);
      joined.get(system)!.set(member, kinds);
    } else if (a !== undefined && b !== undefined) {
      const list = elsewhere.get(a) ?? [];
      list.push(`${t.type} → ${b}`);
      elsewhere.set(a, list);
    } else if (sa !== undefined && sb !== undefined) {
      const list = between.get(sa) ?? [];
      list.push({ to: sb, text: `${t.type} → ${systemName.get(sb)}` });
      between.set(sa, list);
    }
  }
  const placed = new Set([...joined.values()].flatMap((m) => [...m.keys()]));
  const loose = input.members.filter((m) => !placed.has(m.name));

  const boxes: GraphBox[] = [];
  const arcs: { d: string }[] = [];
  const spines: { d: string }[] = [];
  const headW = W - 2 * pad - gutter;
  const areaX = pad + indent;
  const boxW = (W - pad - gutter - areaX - (columns - 1) * gap) / columns;
  const memberH = 2 * line + 8;
  const heads = new Map<string, GraphBox>();
  let y = pad;

  /** A group's members in rows, folded past SHOWN unless open; returns the y below it. */
  const rows = (group: string, entries: { name: string; kinds: string[]; system?: string; systemText: string }[], top: number): number => {
    const folded = entries.length > SHOWN && !open.has(group);
    const shown = folded ? entries.slice(0, SHOWN - 1) : entries;
    const cells: GraphBox[] = shown.map((e, i) => {
      const m = byName.get(e.name)!;
      const how = e.kinds.length ? e.kinds.join(", ") : "no transform";
      const state = m.warped ? ", warped through a displacement field" : m.hidden ? ", hidden in the system viewed" : "";
      return {
        key: `m:${group}:${e.name}`,
        kind: "member",
        x: areaX + (i % columns) * (boxW + gap),
        y: top + Math.floor(i / columns) * (memberH + gap),
        w: boxW,
        h: memberH,
        lines: [fit(shortName(e.name, charsIn(boxW)), charsIn(boxW)), fit(how, charsIn(boxW))],
        label: `member ${e.name}, ${e.systemText}, ${how}${state}`,
        title: `${e.name}: ${how}${state}`,
        member: e.name,
        system: e.system,
        warped: m.warped,
        hidden: m.hidden,
      };
    });
    if (entries.length > SHOWN) {
      const i = cells.length;
      const more = folded ? `+${entries.length - shown.length} more` : "Show fewer";
      cells.push({
        key: `more:${group}`,
        kind: "more",
        x: areaX + (i % columns) * (boxW + gap),
        y: top + Math.floor(i / columns) * (memberH + gap),
        w: boxW,
        h: memberH,
        lines: [more],
        label: folded ? `${entries.length - shown.length} more members, ${entries[0].systemText}` : `Show fewer members, ${entries[0].systemText}`,
        title: folded ? `Show all ${entries.length} members` : `Show the first ${SHOWN - 1}`,
        group,
      });
    }
    boxes.push(...cells);
    const n = Math.ceil(cells.length / columns);
    // The spine: from the group's top down to its last row, a tick to each row.
    if (n > 0) {
      const sx = pad + indent / 2;
      const mid = (r: number) => top + r * (memberH + gap) + memberH / 2;
      spines.push({ d: `M${sx},${top - gap} V${mid(n - 1)} ${Array.from({ length: n }, (_, r) => `M${sx},${mid(r)} H${areaX}`).join(" ")}` });
    }
    return top + n * (memberH + gap) - gap;
  };

  for (const s of input.systems) {
    const name = systemName.get(s.id)!;
    const own = (between.get(s.id) ?? []).map((b) => b.text);
    const entries = [...joined.get(s.id)!].map(([member, kinds]) => ({ name: member, kinds, system: s.id, systemText: `in system ${name}` }));
    const h = own.length ? memberH : line + 9;
    const head: GraphBox = {
      key: `s:${s.id}`,
      kind: "system",
      x: pad,
      y,
      w: headW,
      h,
      lines: [fit(name, charsIn(headW)), own.length ? fit(own.join("; "), charsIn(headW)) : undefined],
      label: `system ${name}${s.id === chosen ? ", viewed" : ""}, ${entries.length} member${entries.length === 1 ? "" : "s"}${own.length ? `, ${own.join("; ")}` : ""}`,
      title: own.length ? `${name}: ${own.join("; ")}` : name,
      system: s.id,
    };
    boxes.push(head);
    heads.set(s.id, head);
    y += h + gap;
    y = entries.length ? rows(`s:${s.id}`, entries, y) + groupGap : y - gap + groupGap;
  }
  if (loose.length) {
    const entries = loose.map((m) => ({ name: m.name, kinds: elsewhere.get(m.name) ?? [], systemText: "joined to no system" }));
    y = rows("loose", entries, y + line + 2) + groupGap;
  }

  // Transforms between systems: an arc from one box's right edge to the other's, in the gutter.
  for (const [from, list] of between) {
    for (const { to } of list) {
      const a = heads.get(from);
      const b = heads.get(to);
      if (!a || !b || a === b) continue;
      const ax = a.x + a.w;
      const ay = a.y + a.h / 2;
      const by = b.y + b.h / 2;
      const out = ax + gutter - 4;
      arcs.push({ d: `M${ax},${ay} C${out},${ay} ${out},${by} ${ax},${by}` });
    }
  }
  return { width: W, height: Math.max(y - groupGap + pad, 2 * pad + line), boxes, arcs, spines };
}

/** Where the loose group's heading goes, when there is one: just above its first box. */
export function looseHeading(layout: GraphLayout): { x: number; y: number } | undefined {
  const first = layout.boxes.find((b) => b.key.startsWith("m:loose:") || b.key === "more:loose");
  return first && { x: GRAPH.pad, y: first.y - 4 };
}

/**
 * The box the keyboard moves to from box `i`: Left and Right the one before
 * and after in reading order, Up and Down the nearest in the row above or
 * below (closest across), Home and End the first and last.  Undefined for
 * any other key, or at an edge.
 */
export function nextBox(boxes: readonly GraphBox[], i: number, key: string): number | undefined {
  const n = boxes.length;
  if (n === 0) return undefined;
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return n - 1;
    case "ArrowRight":
      return i + 1 < n ? i + 1 : undefined;
    case "ArrowLeft":
      return i > 0 ? i - 1 : undefined;
    case "ArrowDown":
    case "ArrowUp": {
      const here = boxes[i];
      const down = key === "ArrowDown";
      const cx = here.x + here.w / 2;
      let best: number | undefined;
      let bestRow = down ? Infinity : -Infinity;
      let bestAcross = Infinity;
      boxes.forEach((b, j) => {
        if (down ? b.y <= here.y : b.y >= here.y) return;
        const across = Math.abs(b.x + b.w / 2 - cx);
        const nearer = down ? b.y < bestRow : b.y > bestRow;
        if (nearer || (b.y === bestRow && across < bestAcross)) {
          best = j;
          bestRow = b.y;
          bestAcross = across;
        }
      });
      return best;
    }
  }
  return undefined;
}
