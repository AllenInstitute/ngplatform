/**
 * A binary BVH collapsed into a 4-wide one with 8-bit child boxes (after
 * Ylitie, Karras and Laine 2017, "Efficient incoherent ray traversal on
 * GPUs through compressed wide BVHs"), for the browser's tracer: about a
 * third of the binary tree's memory, and a node's four children tested
 * from one fetch of 64 bytes.
 *
 * The binary tree is lbvh.ts's (the render computer's, bit for bit); the
 * collapse is the browser's own. Each wide node takes the children of its
 * binary node and, while it has fewer than four, opens the child of most
 * surface area. Wide nodes are numbered breadth first, the root 0.
 *
 * A node is 16 uints (4 RGBA32UI texels):
 *   0..2  the box's low corner (float bits), rounded down to a float;
 *   3     each axis's scale as an exponent + 127 (bits 0..23), and the
 *         number of children (bits 24..31);
 *   4..6  each child's low corner along x, y, z, a byte a child (child c
 *         at bits 8c), in steps of the axis's scale from the corner;
 *   8..10 their high corners, likewise; 7 and 11 unused;
 *   12..15 the children: a node's index, or LEAF | a primitive's.
 * A child's box as stored contains its true box (rounded outward, checked
 * in float32 as a GPU computes corner + q × scale).
 */

/** uints a wide node. */
export const WIDE = 16;
/** A child that is a primitive: this bit and its index. */
export const LEAF = 0x80000000;

/** A binary tree to collapse: its root, its nodes' children and boxes, and what a leaf stands for. */
export interface BinaryTree {
  root: number;
  isLeaf(k: number): boolean;
  left(k: number): number;
  right(k: number): number;
  /** Node k's box: lo xyz, hi xyz. */
  box(k: number): ArrayLike<number>;
  /** A leaf's child reference in the wide tree (LEAF | primitive, or another tree's node). */
  ref(k: number): number;
}

const f = Math.fround;

/** The float32 at or below x. */
function floorF(x: number): number {
  let y = f(x);
  if (y > x) y = f(y - Math.max(Math.abs(y) * 1.2e-7, 1.5e-45));
  return y;
}

function area(b: ArrayLike<number>): number {
  const x = b[3] - b[0], y = b[4] - b[1], z = b[5] - b[2];
  return x * y + y * z + z * x;
}

/** Writes wide node `w` of `out` for children (their boxes and references). */
export function quantise(out: Uint32Array, w: number, boxes: ArrayLike<number>[], refs: number[]): void {
  const o = WIDE * w;
  const lo = [0, 1, 2].map((a) => Math.min(...boxes.map((b) => b[a])));
  const hi = [0, 1, 2].map((a) => Math.max(...boxes.map((b) => b[3 + a])));
  const origin = lo.map(floorF);
  const fl = new Float32Array(origin);
  out.set(new Uint32Array(fl.buffer), o);
  const scale: number[] = [];
  let exps = 0;
  for (let a = 0; a < 3; ++a) {
    const ext = hi[a] - origin[a];
    let e = ext > 0 ? Math.ceil(Math.log2(ext / 255)) : -126;
    e = Math.max(-126, Math.min(127, e));
    while (e < 127 && f(origin[a] + 255 * 2 ** e) < hi[a]) ++e;
    scale.push(2 ** e);
    exps |= (e + 127) << (8 * a);
  }
  out[o + 3] = (exps | (boxes.length << 24)) >>> 0;
  for (let c = 0; c < boxes.length; ++c) {
    const b = boxes[c];
    for (let a = 0; a < 3; ++a) {
      const s = scale[a], at = origin[a];
      let ql = Math.max(0, Math.min(255, Math.floor((b[a] - at) / s)));
      while (ql > 0 && f(at + ql * s) > b[a]) --ql;
      let qh = Math.max(0, Math.min(255, Math.ceil((b[3 + a] - at) / s)));
      while (qh < 255 && f(at + qh * s) < b[3 + a]) ++qh;
      out[o + 4 + a] = (out[o + 4 + a] | (ql << (8 * c))) >>> 0;
      out[o + 8 + a] = (out[o + 8 + a] | (qh << (8 * c))) >>> 0;
    }
    out[o + 12 + c] = refs[c] >>> 0;
  }
}

/**
 * The tree collapsed (`nodes`: WIDE uints each, the root first), its node indices from `base` (the wide tree's place
 * among others').
 */
export function collapse(t: BinaryTree, base = 0): Uint32Array {
  // Breadth first: each wide node's binary root, numbered as met.
  const roots = [t.root];
  const kids: number[][] = [];
  for (let w = 0; w < roots.length; ++w) {
    const r = roots[w];
    let open = t.isLeaf(r) ? [r] : [t.left(r), t.right(r)];
    while (open.length < 4) {
      let best = -1, most = -1;
      for (let i = 0; i < open.length; ++i) {
        if (t.isLeaf(open[i])) continue;
        const a = area(t.box(open[i]));
        if (a > most) [best, most] = [i, a];
      }
      if (best < 0) break;
      const k = open[best];
      open = [...open.slice(0, best), t.left(k), t.right(k), ...open.slice(best + 1)];
    }
    kids.push(open);
    for (const k of open) if (!t.isLeaf(k)) roots.push(k);
  }
  const out = new Uint32Array(WIDE * roots.length);
  let next = 1;
  for (let w = 0; w < roots.length; ++w) {
    const refs = kids[w].map((k) => (t.isLeaf(k) ? t.ref(k) : base + next++));
    quantise(out, w, kids[w].map((k) => t.box(k)), refs);
  }
  return out;
}

/** A wide node's children's boxes (as stored, float32 as a GPU decodes them) and references. */
export function wideChildren(nodes: Uint32Array, w: number): { box: number[]; ref: number }[] {
  const o = WIDE * w;
  const origin = new Float32Array(nodes.buffer, nodes.byteOffset + 4 * o, 3);
  const h = nodes[o + 3];
  const count = h >>> 24;
  const out: { box: number[]; ref: number }[] = [];
  for (let c = 0; c < count; ++c) {
    const box: number[] = [];
    for (const off of [4, 8]) {
      for (let a = 0; a < 3; ++a) {
        const s = 2 ** (((h >>> (8 * a)) & 255) - 127);
        box.push(f(origin[a] + ((nodes[o + off + a] >>> (8 * c)) & 255) * s));
      }
    }
    out.push({ box, ref: nodes[o + 12 + c] });
  }
  return out;
}
