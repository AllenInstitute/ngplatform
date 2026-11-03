/**
 * OME-Zarr collections as RFC-8 drafts them ("Collections and
 * Extensibility", under review): a tree of nodes, each a `collection`
 * (holding `nodes`, or pointing at another document with `path`), a
 * `multiscale` (an image; its `singlescale` children are its levels) or a
 * node of another type, with coordinate systems and the transforms between
 * them (RFC-5) in `attributes`, a collection's in `attributes.scene`.
 *
 * Read here: the tree, every member's resolved location, every coordinate
 * system and transform; and, for a member whose system a scene transform
 * maps into the collection's, where the collection places it (a 4 × 4 on
 * x, y, z), so a scene can show the members together.  The RFC is a draft;
 * this follows it as of its 2026-10 text and reads what it can.
 */

export type Mat4 = number[];

export interface CollectionNode {
  type: string;
  name: string;
  id?: string;
  /** Where it is, resolved against the document's URL ("zarr": a Zarr group; "json": another document). */
  location?: { type: string; url: string };
  nodes: CollectionNode[];
  /** Coordinate systems, with each axis's name and unit ("" when none). */
  systems: { id: string; name?: string; axes: string[]; units: string[] }[];
  transforms: Transform[];
}

export interface Transform {
  type: string;
  input: string;
  output: string;
  /** The transform as written, for showing and composing. */
  raw: any;
  /** The URL of the document it is written in, which a displacement field's `path` is relative to. */
  document: string;
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const refId = (r: unknown): string => (typeof r === "string" ? r : r && typeof r === "object" ? String((r as any).id ?? (r as any).name ?? "") : "");

/** Resolves a node's path (relative, http(s) or file) against the document it is in. */
export function resolvePath(path: string, documentUrl: string): string {
  try {
    return new URL(path, documentUrl).href.replace(/\/$/, "");
  } catch {
    return path;
  }
}

/** The tree in a collection document (its `ome` object, or the document itself). */
export function readCollection(document: any, documentUrl: string): CollectionNode {
  const root = document?.ome ?? document?.attributes?.ome ?? document;
  if (root === null || typeof root !== "object") throw new Error("not a collection document");
  if (root.type === undefined && root.nodes === undefined) throw new Error("not an OME collection (no type or nodes)");
  return readNode(root, documentUrl);
}

function readNode(n: any, documentUrl: string): CollectionNode {
  const attributes = n.attributes ?? {};
  const scene = attributes.scene ?? attributes;
  const systems = (scene.coordinateSystems ?? attributes.coordinateSystems ?? []).map((c: any) => ({
    id: String(c.id ?? c.name ?? ""),
    name: c.name,
    axes: (c.axes ?? []).map((a: any) => (typeof a === "string" ? a : String(a.name))),
    units: (c.axes ?? []).map((a: any) => (typeof a === "string" ? "" : String(a.unit ?? ""))),
  }));
  const transforms = (scene.coordinateTransformations ?? attributes.coordinateTransformations ?? []).map((t: any) => ({
    type: String(t.type),
    input: refId(t.input),
    output: refId(t.output),
    raw: t,
    document: documentUrl,
  }));
  const path = n.path;
  return {
    type: String(n.type ?? "collection"),
    name: String(n.name ?? n.id ?? "(unnamed)"),
    id: n.id,
    location: path === undefined ? undefined : { type: String(path.type ?? "zarr"), url: resolvePath(String(path.path ?? path), documentUrl) },
    nodes: Array.isArray(n.nodes) ? n.nodes.map((c: any) => readNode(c, documentUrl)) : [],
    systems,
    transforms,
  };
}

const multiply = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) for (let k = 0; k < 4; ++k) out[4 * r + c] += a[4 * r + k] * b[4 * k + c];
  return out;
};

/**
 * A transform as a 4 × 4 on x, y, z (the axes in `axes` order, as the
 * output system names them); undefined for kinds this cannot compose
 * (displacement fields, by-coordinate maps).
 */
export function transformMatrix(t: any, axes: string[] = ["x", "y", "z"]): Mat4 | undefined {
  const at = ["x", "y", "z"].map((n) => axes.indexOf(n));
  if (at.some((i) => i === -1)) return undefined;
  switch (t?.type) {
    case "identity":
      return [...IDENTITY];
    case "scale": {
      if (!Array.isArray(t.scale)) return undefined;
      const m = [...IDENTITY];
      at.forEach((i, k) => (m[5 * k] = t.scale[i]));
      return m;
    }
    case "translation": {
      if (!Array.isArray(t.translation)) return undefined;
      const m = [...IDENTITY];
      at.forEach((i, k) => (m[4 * k + 3] = t.translation[i]));
      return m;
    }
    case "affine": {
      const a = t.affine;
      if (!Array.isArray(a) || !Array.isArray(a[0])) return undefined;
      const n = axes.length;
      const m = [...IDENTITY];
      at.forEach((row, r) => {
        at.forEach((col, c) => (m[4 * r + c] = a[row][col]));
        m[4 * r + 3] = a[row][n];
      });
      return m;
    }
    case "sequence": {
      let m = [...IDENTITY];
      for (const inner of t.transformations ?? []) {
        const step = transformMatrix(inner, axes);
        if (step === undefined) return undefined;
        m = multiply(step, m);
      }
      return m;
    }
    default:
      return undefined;
  }
}

export interface Member {
  node: CollectionNode;
  /** Its place in the tree, for lists ("gallery / left"). */
  trail: string;
  /** Where the collection puts it, when a scene transform says (x, y, z in the scene system's units). */
  placement?: Mat4;
}

/**
 * Every image in the tree (multiscale nodes, and nodes pointing at a Zarr
 * group), with where its collection's scene transforms put it: a transform
 * whose input is the member (its id, or one of its coordinate systems) and
 * whose output is a system of the collection holding it.
 */
export function members(root: CollectionNode): Member[] {
  const out: Member[] = [];
  const visit = (node: CollectionNode, trail: string[], scene: CollectionNode | undefined) => {
    const here = [...trail, node.name];
    const holder = node.type === "collection" ? node : scene;
    const image = node.type === "multiscale" || (node.location?.type === "zarr" && node.type !== "collection");
    if (image && node.location !== undefined) {
      const keys = new Set([node.id, node.name, ...node.systems.map((s) => s.id)].filter((k): k is string => !!k));
      const t = holder?.transforms.find((x) => keys.has(x.input));
      const axes = holder?.systems.find((s) => s.id === t?.output)?.axes ?? ["x", "y", "z"];
      out.push({ node, trail: here.join(" / "), placement: t === undefined ? undefined : transformMatrix(t.raw, axes) });
    }
    for (const child of node.nodes) visit(child, here, holder);
  };
  visit(root, [], undefined);
  return out;
}

/** Every coordinate system and transform in the tree, with the node each belongs to. */
export function graph(root: CollectionNode): { systems: { node: string; id: string; axes: string[] }[]; transforms: { node: string; input: string; output: string; type: string; raw: any; document: string }[] } {
  const systems: { node: string; id: string; axes: string[] }[] = [];
  const transforms: { node: string; input: string; output: string; type: string; raw: any; document: string }[] = [];
  const visit = (n: CollectionNode) => {
    for (const s of n.systems) systems.push({ node: n.name, id: s.id, axes: s.axes });
    for (const t of n.transforms) transforms.push({ node: n.name, input: t.input, output: t.output, type: t.type, raw: t.raw, document: t.document });
    n.nodes.forEach(visit);
  };
  visit(root);
  return { systems, transforms };
}

/** The inverse of an affine 4 × 4 (row-major), or undefined when it is singular. */
export function invert(m: Mat4): Mat4 | undefined {
  const [a, b, c, d, e, f, g, h, i, j, k, l] = m;
  const det = a * (f * k - g * j) - b * (e * k - g * i) + c * (e * j - f * i);
  if (Math.abs(det) < 1e-12) return undefined;
  const r = [
    (f * k - g * j) / det, (c * j - b * k) / det, (b * g - c * f) / det,
    (g * i - e * k) / det, (a * k - c * i) / det, (c * e - a * g) / det,
    (e * j - f * i) / det, (b * i - a * j) / det, (a * f - b * e) / det,
  ];
  return [
    r[0], r[1], r[2], -(r[0] * d + r[1] * h + r[2] * l),
    r[3], r[4], r[5], -(r[3] * d + r[4] * h + r[5] * l),
    r[6], r[7], r[8], -(r[6] * d + r[7] * h + r[8] * l),
    0, 0, 0, 1,
  ];
}

/** The axes a system id names in the tree (x, y, z when it is not a system: a member's own space). */
function axesOf(root: CollectionNode, id: string): string[] {
  return graph(root).systems.find((s) => s.id === id)?.axes ?? ["x", "y", "z"];
}

/**
 * Where `member` sits in coordinate system `system`: the transforms of the
 * tree from the member (its id, name or one of its systems) to `system`,
 * walked either way (a transform walked backwards is inverted) and
 * composed, shortest first.  Undefined when no chain of transforms this can
 * compose (affine ones) joins them.
 */
export function placeInto(root: CollectionNode, member: CollectionNode, system: string): Mat4 | undefined {
  const edges = graph(root).transforms.flatMap((t) => {
    const m = transformMatrix(t.raw, axesOf(root, t.output));
    if (m === undefined) return [];
    const back = invert(m);
    return [{ from: t.input, to: t.output, m }, ...(back ? [{ from: t.output, to: t.input, m: back }] : [])];
  });
  const starts = [member.id, member.name, ...member.systems.map((s) => s.id)].filter((k): k is string => !!k);
  const seen = new Map<string, Mat4>(starts.map((s) => [s, [...IDENTITY]]));
  const queue = [...starts];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const here = seen.get(at)!;
    if (at === system) return here;
    for (const e of edges) {
      if (e.from !== at || seen.has(e.to)) continue;
      seen.set(e.to, multiply(e.m, here));
      queue.push(e.to);
    }
  }
  return undefined;
}

/**
 * A step of a chain of transforms on x, y, z: an affine, or a displacement
 * field (RFC-5's `displacements`: x → x + D(x), D the field at `url`;
 * `inverse`: the inverse of that).  `components`: the axes of the field's
 * vector components in order (its transform's output system's), when the
 * tree names that system.
 */
export type Step = { kind: "affine"; m: Mat4 } | { kind: "field"; url: string; inverse: boolean; components?: string[] };

/**
 * A transform as steps on x, y, z (the axes in `axes` order, its output
 * system's when known): affines, and displacement fields alone or in a
 * sequence; a field's `path` resolved against `document`.  Undefined for
 * kinds this cannot apply (coordinate maps, among others).
 */
export function transformSteps(t: any, axes: string[] | undefined, document: string): Step[] | undefined {
  // A bijection forwards is its `forward`; walked backwards (see `inverseOf`) its `inverse` as written.
  if (t?.type === "bijection") return transformSteps(t.forward, axes, document);
  if (t?.type === INVERSE) {
    const inner = transformSteps(t.of, axes, document);
    return inner && invertSteps(inner);
  }
  if (t?.type === "displacements") {
    if (typeof t.path !== "string") return undefined;
    return [{ kind: "field", url: resolvePath(t.path, document), inverse: false, ...(axes ? { components: axes } : {}) }];
  }
  if (t?.type === "sequence") {
    const out: Step[] = [];
    for (const inner of t.transformations ?? []) {
      const steps = transformSteps(inner, axes, document);
      if (steps === undefined) return undefined;
      out.push(...steps);
    }
    return out;
  }
  const m = transformMatrix(t, axes);
  return m === undefined ? undefined : [{ kind: "affine", m }];
}

/** A transform walked backwards, the steps of which are its parts' inverses in reverse order (`transformSteps` reads it). */
const INVERSE = "ngplatform:inverse";

/**
 * A transform walked backwards, as a transform: a sequence reversed with
 * each part inverted, a bijection with its two sides swapped (so its stated
 * inverse is used, wherever it sits), anything else marked to be inverted.
 */
export function inverseOf(t: any): any {
  if (t?.type === "sequence") return { ...t, transformations: [...(t.transformations ?? [])].reverse().map(inverseOf) };
  if (t?.type === "bijection") return { ...t, forward: t.inverse, inverse: t.forward };
  if (t?.type === INVERSE) return t.of;
  return { type: INVERSE, of: t };
}

/** Steps walked backwards: in reverse order, each inverted (undefined when an affine is singular). */
export function invertSteps(steps: Step[]): Step[] | undefined {
  const out: Step[] = [];
  for (const s of [...steps].reverse()) {
    if (s.kind === "field") out.push({ ...s, inverse: !s.inverse });
    else {
      const m = invert(s.m);
      if (m === undefined) return undefined;
      out.push({ kind: "affine", m });
    }
  }
  return out;
}

/**
 * The chain of steps taking `member` into `system`, as `placeInto` finds
 * it but through displacement fields too (at most one in the chain; a
 * field walked backwards is its inverse; a `bijection` walked backwards is
 * its `inverse` as written), shortest first.  Undefined when none joins them.
 */
export function chainInto(root: CollectionNode, member: CollectionNode, system: string): Step[] | undefined {
  const known = (id: string) => graph(root).systems.find((s) => s.id === id)?.axes;
  const edges = graph(root).transforms.flatMap((t) => {
    // A system the tree does not name (a member's own) has the axes of the other side.
    const output = known(t.output) ?? known(t.input);
    const input = known(t.input) ?? known(t.output);
    const there = transformSteps(t.raw, output, t.document);
    // Backwards: a bijection's stated inverse wherever it sits (alone or in a sequence); the rest inverted.
    const back = transformSteps(inverseOf(t.raw), input, t.document);
    return [...(there ? [{ from: t.input, to: t.output, steps: there }] : []), ...(back ? [{ from: t.output, to: t.input, steps: back }] : [])];
  });
  const fields = (steps: Step[]) => steps.filter((s) => s.kind === "field").length;
  const starts = [member.id, member.name, ...member.systems.map((s) => s.id)].filter((k): k is string => !!k);
  // States: a system and how many fields the chain to it has (0 or 1).
  const seen = new Map<string, Step[]>(starts.map((s) => [`0:${s}`, []]));
  const queue = starts.map((s) => ({ at: s, steps: [] as Step[] }));
  while (queue.length > 0) {
    const { at, steps } = queue.shift()!;
    if (at === system) return steps;
    for (const e of edges) {
      if (e.from !== at) continue;
      const next = [...steps, ...e.steps];
      const n = fields(next);
      if (n > 1 || seen.has(`${n}:${e.to}`)) continue;
      seen.set(`${n}:${e.to}`, next);
      queue.push({ at: e.to, steps: next });
    }
  }
  return undefined;
}

/** A matrix in system units (its translation) as millimetres, `unit` mm a unit (no −0s, for a tidy link). */
const inMm = (m: Mat4, unit: number): Mat4 => m.map((v, i) => (i % 4 === 3 && i < 12 ? v * unit : v) + 0);

/**
 * How a member whose chain into a system holds a displacement field is
 * shown: its layer placed by `placement` (the chain's affines, the field
 * left out: a 4 × 4 in the system's units), and resampled through a
 * computed warp that takes each place of the placed layer back through the
 * chain to the member (the Platform's `{kind: "field"}` warp: affines in
 * mm `before` the field, the field, inverted when the chain walks it
 * forwards, and affines `after`).  Undefined when the chain has no field.
 */
export function fieldWarp(steps: Step[], unit: number): { placement: Mat4; warp: { kind: "field"; url: string; before: Mat4[]; after: Mat4[]; invert: boolean; components?: string[] } } | undefined {
  const at = steps.findIndex((s) => s.kind === "field");
  if (at === -1) return undefined;
  const field = steps[at] as Extract<Step, { kind: "field" }>;
  const affines = (part: Step[]) => part.map((s) => (s as Extract<Step, { kind: "affine" }>).m);
  const placement = affines(steps.filter((s) => s.kind === "affine")).reduce((m, step) => multiply(step, m), [...IDENTITY]);
  // From the placed layer back to the member: the placement, then each step undone, last first.
  const after = invertSteps(steps.slice(0, at));
  const before = invertSteps(steps.slice(at + 1));
  if (after === undefined || before === undefined) return undefined;
  return {
    placement,
    warp: {
      kind: "field",
      url: field.url,
      before: [placement, ...affines(before)].map((m) => inMm(m, unit)),
      after: affines(after).map((m) => inMm(m, unit)),
      // Undoing x → x + D(x) is the field's inverse; undoing its inverse is the field.
      invert: !field.inverse,
      ...(field.components ? { components: field.components } : {}),
    },
  };
}

const DTYPE_RANGE: Record<string, [number, number]> = {
  uint8: [0, 255],
  int8: [-128, 127],
  uint16: [0, 65535],
  int16: [-32768, 32767],
  uint32: [0, 4294967295],
  int32: [-2147483648, 2147483647],
};
const V2_DTYPE: Record<string, string> = { u1: "uint8", i1: "int8", u2: "uint16", i2: "int16", u4: "uint32", i4: "int32" };

/**
 * The contrast range an image is shown with by default, from its group's
 * metadata (`group`: zarr.json or .zattrs) and its first level's (`array`:
 * zarr.json or .zarray): OME's omero window, else its integer type's whole
 * range (Neuroglancer's default for it); undefined for floats, which a
 * warped copy (float32 too) shows the same way by default.
 */
export function displayRangeOf(group: any, array: any): [number, number] | undefined {
  const ome = group?.attributes?.ome ?? group?.ome ?? group?.attributes ?? group;
  const w = ome?.omero?.channels?.[0]?.window;
  if (Number.isFinite(w?.start) && Number.isFinite(w?.end) && w.end > w.start) return [w.start, w.end];
  const dtype = typeof array?.data_type === "string" ? array.data_type : V2_DTYPE[String(array?.dtype ?? "").replace(/^[<>|=]/, "")];
  return dtype === undefined ? undefined : DTYPE_RANGE[dtype];
}

/** The path of an image's first (finest) level, from its group's metadata. */
export function firstLevel(group: any): string | undefined {
  const ome = group?.attributes?.ome ?? group?.ome ?? group?.attributes ?? group;
  const path = ome?.multiscales?.[0]?.datasets?.[0]?.path;
  return typeof path === "string" ? path : undefined;
}

/** The coordinate systems of the tree members can be placed in: a collection's own (its scene's). */
export function sceneSystems(root: CollectionNode): { id: string; name?: string; axes: string[]; units: string[]; node: string }[] {
  const out: { id: string; name?: string; axes: string[]; units: string[]; node: string }[] = [];
  const visit = (n: CollectionNode) => {
    if (n.type === "collection") for (const s of n.systems) out.push({ ...s, node: n.name });
    n.nodes.forEach(visit);
  };
  visit(root);
  return out;
}

/**
 * The folders above an image's URL where a collection holding it may be:
 * its parent Zarr groups, nearest first, up to `depth` of them, below the
 * bucket or host.
 */
export function parentGroups(url: string, depth = 6): string[] {
  const clean = url.replace(/\|.*$/, "").replace(/^(zarr3?|zarr2|n5|ome-zarr):\/\//, "").replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(clean.replace(/^gs:\/\/([^/]+)/, "https://storage.googleapis.com/$1").replace(/^s3:\/\/([^/]+)/, "https://$1.s3.amazonaws.com"));
  } catch {
    return [];
  }
  if (!/^https?:$/.test(u.protocol)) return [];
  const parts = u.pathname.split("/").filter(Boolean);
  // Below the bucket on Cloud Storage; below the host elsewhere.
  const floor = u.hostname === "storage.googleapis.com" ? 1 : 0;
  const out: string[] = [];
  for (let n = parts.length - 1; n > floor && out.length < depth; --n) out.push(`${u.origin}/${parts.slice(0, n).join("/")}`);
  return out;
}

/** Whether a Zarr group's metadata (its zarr.json) is an OME collection. */
export function isCollection(document: any): boolean {
  const ome = document?.attributes?.ome ?? document?.ome;
  return ome !== undefined && ome !== null && (ome.type === "collection" || Array.isArray(ome.nodes));
}
