/**
 * Surfaces ready to trace, in blocks: each block (a segment's mesh, a
 * layer's points or lines) its own BVH, built in a worker
 * (geometry_worker.ts) so the page does not stop while it is built; then
 * the blocks packed together under a top-level tree over their boxes, so
 * a block coming or going builds only itself and that small tree.
 *
 * A block: its vertices (primitives.ts), its primitives in the BVH's order
 * (4 uints: three vertices, and kind << 30 | object), and its wide BVH
 * (wide.ts), all numbered from 0. Packed, each block's numbers are moved
 * past the blocks before it and its objects past the objects before it.
 */
import { type Bvh, buildLbvh, primHit } from "./lbvh.js";
import { expandPrims, type Primitives } from "./primitives.js";
import { collapse, LEAF, WIDE, wideChildren } from "./wide.js";

/** One block: its own BVH over its own primitives. */
export interface Block {
  n: number;
  /** 4 floats a vertex (primitives.ts). */
  vertices: Float32Array;
  /** 4 uints a primitive, in the BVH's order: three vertices, kind << 30 | object. */
  prims: Uint32Array;
  /** The wide BVH (wide.ts), its root node 0. */
  nodes: Uint32Array;
  objectCount: number;
  lo: [number, number, number];
  hi: [number, number, number];
}

/** The blocks packed: one tree (its root `root`) over all their primitives. */
export interface Surfaces {
  n: number;
  vertices: Uint32Array;
  prims: Uint32Array;
  nodes: Uint32Array;
  root: number;
  objectCount: number;
  lo: [number, number, number];
  hi: [number, number, number];
}

/** A block of primitives: the binary LBVH (lbvh.ts, the render computer's), collapsed to a wide one. */
export function buildBlock(p: Primitives, objectCount: number): Block {
  const n = p.objects.length;
  if (n === 0) return { n, vertices: new Float32Array(), prims: new Uint32Array(), nodes: new Uint32Array(), objectCount, lo: [0, 0, 0], hi: [0, 0, 0] };
  const bvh = buildLbvh(expandPrims(p), p.objects, p.kinds);
  const prims = new Uint32Array(4 * n);
  for (let i = 0; i < n; ++i) {
    const j = bvh.order[i];
    prims.set(p.index.subarray(3 * j, 3 * j + 3), 4 * i);
    prims[4 * i + 3] = ((p.kinds[j] << 30) | p.objects[j]) >>> 0;
  }
  const nodes = collapse(binaryOf(bvh));
  return { n, vertices: p.vertices, prims, nodes, objectCount, lo: [...bvh.lo] as Block["lo"], hi: [...bvh.hi] as Block["hi"] };
}

/** lbvh.ts's tree as wide.ts takes it: 0..n−2 internal (0 the root), then the leaves in order. */
function binaryOf(b: Bvh): Parameters<typeof collapse>[0] {
  const n = b.n;
  return {
    root: 0,
    isLeaf: (k) => k >= n - 1,
    left: (k) => b.kids[2 * k],
    right: (k) => b.kids[2 * k + 1],
    box: (k) => b.nodes.subarray(6 * k, 6 * k + 6),
    ref: (k) => (LEAF | (k - (n - 1))) >>> 0,
  };
}

/** A block's box as built (its root's children's union, as stored). */
function rootBox(b: Block): number[] {
  const kids = wideChildren(b.nodes, 0);
  return [0, 1, 2, 3, 4, 5].map((i) => (i < 3 ? Math.min(...kids.map((c) => c.box[i])) : Math.max(...kids.map((c) => c.box[i]))));
}

/** The blocks as one tree, each block's objects from its `objectBase`. */
export function packSurfaces(blocks: readonly { block: Block; objectBase: number }[], objectCount: number): Surfaces {
  const live = blocks.filter((b) => b.block.n > 0);
  const vCount = live.reduce((s, b) => s + b.block.vertices.length, 0);
  const pCount = live.reduce((s, b) => s + b.block.prims.length, 0);
  const own = live.reduce((s, b) => s + b.block.nodes.length, 0);
  const lo: Surfaces["lo"] = [Infinity, Infinity, Infinity], hi: Surfaces["hi"] = [-Infinity, -Infinity, -Infinity];
  // The top tree over the blocks' boxes (a median split), after the blocks' own nodes.
  const boxes = live.map((b) => rootBox(b.block));
  const nodeBase: number[] = [];
  let at = 0;
  for (const b of live) {
    nodeBase.push(at);
    at += b.block.nodes.length / WIDE;
  }
  const top = live.length > 1 ? topTree(boxes, nodeBase, at) : new Uint32Array();
  const vertices = new Uint32Array(vCount), prims = new Uint32Array(pCount), nodes = new Uint32Array(own + top.length);
  let v = 0, p = 0, w = 0;
  for (const [i, { block, objectBase }] of live.entries()) {
    const vBase = v / 4, pBase = p / 4;
    vertices.set(new Uint32Array(block.vertices.buffer, block.vertices.byteOffset, block.vertices.length), v);
    const src = block.prims;
    for (let k = 0; k < src.length; k += 4) {
      prims[p + k] = src[k] + vBase;
      prims[p + k + 1] = src[k + 1] + vBase;
      prims[p + k + 2] = src[k + 2] + vBase;
      prims[p + k + 3] = ((src[k + 3] & 0xc0000000) | ((src[k + 3] & 0x3fffffff) + objectBase)) >>> 0;
    }
    nodes.set(block.nodes, w);
    for (let k = w; k < w + block.nodes.length; k += WIDE) {
      const count = nodes[k + 3] >>> 24;
      for (let c = 0; c < count; ++c) {
        const r = nodes[k + 12 + c];
        nodes[k + 12 + c] = (r & LEAF ? LEAF | ((r & ~LEAF) + pBase) : r + nodeBase[i]) >>> 0;
      }
    }
    for (let a = 0; a < 3; ++a) {
      lo[a] = Math.min(lo[a], block.lo[a], boxes[i][a]);
      hi[a] = Math.max(hi[a], block.hi[a], boxes[i][3 + a]);
    }
    v += block.vertices.length;
    p += src.length;
    w += block.nodes.length;
  }
  nodes.set(top, w);
  const n = pCount / 4;
  if (n === 0) return { n: 0, vertices, prims, nodes, root: 0, objectCount, lo: [0, 0, 0], hi: [0, 0, 0] };
  return { n, vertices, prims, nodes, root: live.length > 1 ? at : 0, objectCount, lo, hi };
}

/** A wide tree over boxes (their roots at `refs`), split at the median of the longest axis; its nodes from `base`. */
function topTree(boxes: number[][], refs: number[], base: number): Uint32Array {
  // A binary tree: leaves 0..m−1 the blocks, internal nodes after.
  const m = boxes.length;
  const all = boxes.map((b) => b.slice());
  const kids: [number, number][] = [];
  const split = (items: number[]): number => {
    if (items.length === 1) return items[0];
    const b = [0, 1, 2, 3, 4, 5].map((i) => (i < 3 ? Math.min(...items.map((k) => all[k][i])) : Math.max(...items.map((k) => all[k][i]))));
    const ax = [0, 1, 2].reduce((x, a) => (b[3 + a] - b[a] > b[3 + x] - b[x] ? a : x), 0);
    const sorted = [...items].sort((x, y) => all[x][ax] + all[x][3 + ax] - all[y][ax] - all[y][3 + ax]);
    const half = sorted.length >> 1;
    const l = split(sorted.slice(0, half)), r = split(sorted.slice(half));
    const k = m + kids.length;
    kids.push([l, r]);
    all[k] = b;
    return k;
  };
  const root = split(boxes.map((_, i) => i));
  return collapse({ root, isLeaf: (k) => k < m, left: (k) => kids[k - m][0], right: (k) => kids[k - m][1], box: (k) => all[k], ref: (k) => refs[k] }, base);
}

/**
 * The CPU's trace of packed surfaces, as the shader's (live_geometry.ts geoTrace): the nearest primitive the ray
 * (o, d) meets in (tmin, tmax) whose object `kept` keeps. A reference for tests.
 */
export function traceSurfaces(s: Surfaces, o: number[], d: number[], tmin = 0, tmax = 1e30, kept: (object: number) => boolean = () => true): { t: number; prim: number } {
  if (s.n === 0) return { t: -1, prim: -1 };
  const inv = d.map((x) => 1 / (Math.abs(x) < 1e-20 ? 1e-20 : x));
  let best = tmax, prim = -1;
  const stack = [s.root];
  while (stack.length > 0) {
    const w = stack.pop()!;
    const hit: { t: number; ref: number }[] = [];
    for (const c of wideChildren(s.nodes, w)) {
      let t0 = 0, t1 = best;
      for (let a = 0; a < 3; ++a) {
        const ta = (c.box[a] - o[a]) * inv[a], tb = (c.box[3 + a] - o[a]) * inv[a];
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
      }
      if (t0 > t1) continue;
      if (c.ref & LEAF) {
        const i = (c.ref & ~LEAF) >>> 0;
        const t = surfaceHit(s, i, o, d);
        if (t > tmin && t < best && kept(s.prims[4 * i + 3] & 0x3fffffff)) [best, prim] = [t, i];
        continue;
      }
      hit.push({ t: t0, ref: c.ref });
    }
    hit.sort((x, y) => y.t - x.t);
    for (const h of hit) stack.push(h.ref);
  }
  return prim < 0 ? { t: -1, prim: -1 } : { t: best, prim };
}

/** Packed primitive i's hit along (o, d): lbvh.ts's intersectors. */
export function surfaceHit(s: Surfaces, i: number, o: number[], d: number[]): number {
  const q = s.prims.subarray(4 * i, 4 * i + 4);
  const kind = q[3] >>> 30;
  const vf = new Float32Array(s.vertices.buffer, s.vertices.byteOffset, s.vertices.length);
  const vert = (k: number) => Array.from(vf.subarray(4 * k, 4 * k + 4));
  const prims = new Float32Array(9);
  if (kind === 0) prims.set([...vert(q[0]).slice(0, 3), ...vert(q[1]).slice(0, 3), ...vert(q[2]).slice(0, 3)]);
  else if (kind === 1) prims.set([...vert(q[0]), ...vert(q[1])]);
  else prims.set(vert(q[0]));
  return primHit({ prims, kinds: new Int32Array([kind]) } as unknown as Bvh, 0, o as [number, number, number], d as [number, number, number]);
}

/** The message a geometry worker is sent. */
export interface BuildRequest {
  primitives: Primitives;
  objectCount: number;
}

let worker: Worker | undefined;
let next = 0;
const waiting = new Map<number, { resolve: (b: Block) => void; reject: (e: Error) => void }>();

/** Builds a block in a worker (the primitives' buffers are handed over); here where there are no workers. */
export function buildBlockAsync(req: BuildRequest): Promise<Block> {
  if (typeof Worker === "undefined") return Promise.resolve(buildBlock(req.primitives, req.objectCount));
  if (worker === undefined) {
    worker = new Worker(new URL("./geometry_worker.ts", import.meta.url), { type: "module", name: "geometry" });
    worker.onmessage = (e: MessageEvent<{ id: number; block?: Block; error?: string }>) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.block) w?.resolve(e.data.block);
      else w?.reject(new Error(e.data.error ?? "the geometry could not be built"));
    };
  }
  const id = ++next;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    const p = req.primitives;
    const buffers = [p.vertices.buffer, p.index.buffer, p.objects.buffer, p.kinds.buffer] as ArrayBuffer[];
    worker!.postMessage({ id, req }, [...new Set(buffers)]);
  });
}
