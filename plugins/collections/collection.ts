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
export function graph(root: CollectionNode): { systems: { node: string; id: string; axes: string[] }[]; transforms: { node: string; input: string; output: string; type: string; raw: any }[] } {
  const systems: { node: string; id: string; axes: string[] }[] = [];
  const transforms: { node: string; input: string; output: string; type: string; raw: any }[] = [];
  const visit = (n: CollectionNode) => {
    for (const s of n.systems) systems.push({ node: n.name, id: s.id, axes: s.axes });
    for (const t of n.transforms) transforms.push({ node: n.name, input: t.input, output: t.output, type: t.type, raw: t.raw });
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
