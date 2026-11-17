/**
 * A linear BVH (Karras 2012) over triangles, round cones and spheres: the
 * render computer's (`runner/ngplatform_render/geometry.py`) algorithm and
 * layout, built here on the CPU (WebGL2 has no compute) so the browser and
 * the render computer trace the same trees, tested by the same vectors
 * (`runner/tests/geometry_vectors.json`).
 *
 * Build: each primitive's box centre gets a 30-bit Morton code in the
 * scene's box (float32 arithmetic as CUDA does it); the primitives are
 * sorted by code, then index; each internal node finds its range and split
 * from the common prefixes of its neighbours' keys; leaves' boxes are
 * carried up, a node's box written by the second child to arrive.
 *
 * Layout: `prims` (n × 9, sorted as the leaves are): a triangle's corners;
 * a round cone's a xyz, radius there, b xyz, radius there, 0; a sphere's
 * centre, radius and 0s. `kinds`, `objects` (n, sorted). `nodes`
 * ((2n − 1) × 6: lo xyz, hi xyz): 0..n−2 internal (0 the root), n−1..2n−2
 * the leaves in sorted order. `kids` ((n − 1) × 2): internal nodes'
 * children, node indices.
 */

export const TRIANGLE = 0;
export const CONE = 1;
export const SPHERE = 2;

export interface Bvh {
  n: number;
  prims: Float32Array;
  kinds: Int32Array;
  objects: Int32Array;
  nodes: Float32Array;
  kids: Int32Array;
  /** Each sorted primitive's index in the input. */
  order: Uint32Array;
  /** The primitives' box, the Morton codes' frame. */
  lo: [number, number, number];
  hi: [number, number, number];
}

const f = Math.fround;

/** Each primitive's box (n × 6: lo xyz, hi xyz), float32 as geometry.py's boxes_of. */
export function boxesOf(prims: Float32Array, kinds?: Int32Array): Float32Array {
  const n = prims.length / 9;
  const out = new Float32Array(n * 6);
  for (let i = 0; i < n; ++i) {
    const p = 9 * i, o = 6 * i;
    const k = kinds?.[i] ?? TRIANGLE;
    if (k === TRIANGLE) {
      for (let a = 0; a < 3; ++a) {
        out[o + a] = Math.min(prims[p + a], prims[p + 3 + a], prims[p + 6 + a]);
        out[o + 3 + a] = Math.max(prims[p + a], prims[p + 3 + a], prims[p + 6 + a]);
      }
    } else if (k === CONE) {
      const ra = prims[p + 3], rb = prims[p + 7];
      for (let a = 0; a < 3; ++a) {
        out[o + a] = Math.min(f(prims[p + a] - ra), f(prims[p + 4 + a] - rb));
        out[o + 3 + a] = Math.max(f(prims[p + a] + ra), f(prims[p + 4 + a] + rb));
      }
    } else {
      const r = prims[p + 3];
      for (let a = 0; a < 3; ++a) {
        out[o + a] = f(prims[p + a] - r);
        out[o + 3 + a] = f(prims[p + a] + r);
      }
    }
  }
  return out;
}

/** Spreads 10 bits over 30, two zeros between (CUDA's expand10). */
function expand10(v: number): number {
  v = Math.imul(v, 0x00010001) & 0xff0000ff;
  v = Math.imul(v, 0x00000101) & 0x0f00f00f;
  v = Math.imul(v, 0x00000011) & 0xc30c30c3;
  v = Math.imul(v, 0x00000005) & 0x49249249;
  return v >>> 0;
}

/** Indices sorted by code, ties by index (a stable radix sort, 10 bits a pass). */
function sortByCode(codes: Uint32Array): Uint32Array {
  const n = codes.length;
  let a = new Uint32Array(n);
  let b = new Uint32Array(n);
  for (let i = 0; i < n; ++i) a[i] = i;
  const count = new Uint32Array(1024);
  for (let shift = 0; shift < 30; shift += 10) {
    count.fill(0);
    for (let i = 0; i < n; ++i) ++count[(codes[a[i]] >>> shift) & 1023];
    let sum = 0;
    for (let c = 0; c < 1024; ++c) {
      const k = count[c];
      count[c] = sum;
      sum += k;
    }
    for (let i = 0; i < n; ++i) b[count[(codes[a[i]] >>> shift) & 1023]++] = a[i];
    [a, b] = [b, a];
  }
  return a;
}

/**
 * A BVH over primitives (n × 9, float32): triangles, or of `kinds`; `objects`: each primitive's object (0s when
 * left out).
 */
export function buildLbvh(prims: Float32Array, objects?: Int32Array, kinds?: Int32Array): Bvh {
  const n = prims.length / 9;
  const pbox = boxesOf(prims, kinds);
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; ++i) {
    for (let a = 0; a < 3; ++a) {
      lo[a] = Math.min(lo[a], pbox[6 * i + a]);
      hi[a] = Math.max(hi[a], pbox[6 * i + 3 + a]);
    }
  }
  const inv = [0, 1, 2].map((a) => f(1 / Math.max(f(hi[a] - lo[a]), f(1e-12))));
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; ++i) {
    let code = 0;
    for (let a = 0; a < 3; ++a) {
      const m = f(f(pbox[6 * i + a] + pbox[6 * i + 3 + a]) * 0.5);
      const u = Math.min(Math.max(f(f(m - lo[a]) * inv[a]), 0), 1);
      const c = Math.min(Math.floor(u * 1024), 1023);
      code |= expand10(c) << (2 - a);
    }
    codes[i] = code >>> 0;
  }
  const order = sortByCode(codes);
  const sortedCodes = new Uint32Array(n);
  for (let i = 0; i < n; ++i) sortedCodes[i] = codes[order[i]];
  // The keys' common prefix (code above, index below, 64 bits), -1 beyond the ends.
  const delta = (i: number, j: number): number => {
    if (j < 0 || j >= n) return -1;
    const x = (sortedCodes[i] ^ sortedCodes[j]) >>> 0;
    return x !== 0 ? Math.clz32(x) : 32 + Math.clz32((order[i] ^ order[j]) >>> 0);
  };
  const kids = new Int32Array(Math.max(n - 1, 1) * 2);
  const parent = new Int32Array(Math.max(2 * n - 1, 1)).fill(-1);
  for (let i = 0; i < n - 1; ++i) {
    const d = delta(i, i + 1) - delta(i, i - 1) >= 0 ? 1 : -1;
    const dmin = delta(i, i - d);
    let lmax = 2;
    while (delta(i, i + lmax * d) > dmin) lmax *= 2;
    let l = 0;
    for (let t = lmax >> 1; t >= 1; t >>= 1) if (delta(i, i + (l + t) * d) > dmin) l += t;
    const j = i + l * d;
    const dnode = delta(i, j);
    let s = 0;
    for (let t = (l + 1) >> 1; ; t = (t + 1) >> 1) {
      if (delta(i, i + (s + t) * d) > dnode) s += t;
      if (t === 1) break;
    }
    const g = i + s * d + Math.min(d, 0);
    const left = Math.min(i, j) === g ? n - 1 + g : g;
    const right = Math.max(i, j) === g + 1 ? n - 1 + g + 1 : g + 1;
    kids[2 * i] = left;
    kids[2 * i + 1] = right;
    parent[left] = i;
    parent[right] = i;
  }
  const nodes = new Float32Array(Math.max(2 * n - 1, 1) * 6);
  const flags = new Uint8Array(Math.max(n - 1, 1));
  for (let i = 0; i < n; ++i) {
    const node = n - 1 + i;
    nodes.set(pbox.subarray(6 * order[i], 6 * order[i] + 6), 6 * node);
    if (n === 1) break;
    let p = parent[node];
    while (p >= 0) {
      // The first child to arrive: the other writes the box.
      if (flags[p]++ === 0) break;
      const l = 6 * kids[2 * p], r = 6 * kids[2 * p + 1], o = 6 * p;
      for (let a = 0; a < 3; ++a) {
        nodes[o + a] = Math.min(nodes[l + a], nodes[r + a]);
        nodes[o + 3 + a] = Math.max(nodes[l + 3 + a], nodes[r + 3 + a]);
      }
      p = p === 0 ? -1 : parent[p];
    }
  }
  const sorted = new Float32Array(n * 9);
  const sk = new Int32Array(n);
  const so = new Int32Array(n);
  for (let i = 0; i < n; ++i) {
    sorted.set(prims.subarray(9 * order[i], 9 * order[i] + 9), 9 * i);
    sk[i] = kinds?.[order[i]] ?? TRIANGLE;
    so[i] = objects?.[order[i]] ?? 0;
  }
  return { n, prims: sorted, kinds: sk, objects: so, nodes, kids, order, lo, hi };
}

// ---------------------------------------------------------------- a reference tracer (tests; the shaders' twin)

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function at(p: Float32Array, i: number, k: number): V {
  return [p[9 * i + k], p[9 * i + k + 1], p[9 * i + k + 2]];
}

/** Möller–Trumbore: the distance along the ray (o, d any length) to sorted triangle i, or -1. */
function trihit(b: Bvh, i: number, o: V, d: V): number {
  const a = at(b.prims, i, 0), e1 = sub(at(b.prims, i, 3), a), e2 = sub(at(b.prims, i, 6), a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-20) return -1;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return -1;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return -1;
  return dot(e2, q) * inv;
}

function spherehit(c: V, r: number, o: V, d: V): number {
  const oc = sub(o, c);
  const bb = dot(oc, d);
  let h = bb * bb - (dot(oc, oc) - r * r);
  if (h < 0) return -1;
  h = Math.sqrt(h);
  const t = -bb - h;
  return t > 0 ? t : -bb + h;
}

function conehit(pa: V, ra: number, pb: V, rb: number, o: V, d: V): number {
  const ba = sub(pb, pa), oa = sub(o, pa), ob = sub(o, pb);
  const rr = ra - rb, m0 = dot(ba, ba), m1 = dot(ba, oa), m2 = dot(ba, d), m3 = dot(d, oa);
  const m5 = dot(oa, oa), m6 = dot(ob, d), m7 = dot(ob, ob);
  const d2 = m0 - rr * rr;
  const k2 = d2 - m2 * m2, k1 = d2 * m3 - m1 * m2 + m2 * rr * ra, k0 = d2 * m5 - m1 * m1 + m1 * rr * ra * 2 - m0 * ra * ra;
  const h = k1 * k1 - k0 * k2;
  if (h < 0) return -1;
  const t = (-Math.sqrt(h) - k1) / k2;
  const y = m1 - ra * rr + t * m2;
  if (y > 0 && y < d2) return t;
  let best = 1e30;
  const h1 = m3 * m3 - m5 + ra * ra, h2 = m6 * m6 - m7 + rb * rb;
  if (h1 > 0) best = -m3 - Math.sqrt(h1);
  if (h2 > 0) best = Math.min(best, -m6 - Math.sqrt(h2));
  return best < 1e29 ? best : -1;
}

/** Sorted primitive i's entry along the ray (o, d any length), or -1. */
export function primHit(b: Bvh, i: number, o: V, d: V): number {
  const k = b.kinds[i];
  if (k === TRIANGLE) return trihit(b, i, o, d);
  const p = b.prims;
  const len = Math.hypot(...d);
  const u: V = [d[0] / len, d[1] / len, d[2] / len];
  const s = k === SPHERE ? spherehit(at(p, i, 0), p[9 * i + 3], o, u) : conehit(at(p, i, 0), p[9 * i + 3], at(p, i, 4), p[9 * i + 7], o, u);
  return s < 0 ? -1 : s / len;
}

/** The nearest primitive the ray meets in (tmin, tmax): its distance and sorted index; t -1 when none. */
export function traceBvh(b: Bvh, o: V, d: V, tmin = 0, tmax = 1e30): { t: number; prim: number } {
  if (b.n <= 0) return { t: -1, prim: -1 };
  if (b.n === 1) {
    const t = primHit(b, 0, o, d);
    return t > tmin && t < tmax ? { t, prim: 0 } : { t: -1, prim: -1 };
  }
  const inv = d.map((x) => 1 / (Math.abs(x) > 1e-20 ? x : 1e-20)) as V;
  const box = (k: number, limit: number): number => {
    const n = b.nodes, j = 6 * k;
    let t0 = 0, t1 = limit;
    for (let a = 0; a < 3; ++a) {
      const ta = (n[j + a] - o[a]) * inv[a], tb = (n[j + 3 + a] - o[a]) * inv[a];
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    return t0 <= t1 ? t0 : -1;
  };
  let best = tmax, hit = -1;
  const stack = [0];
  if (box(0, best) < 0) return { t: -1, prim: -1 };
  while (stack.length) {
    const k = stack.pop()!;
    if (k >= b.n - 1) {
      const i = k - (b.n - 1);
      const t = primHit(b, i, o, d);
      if (t > tmin && t < best) [best, hit] = [t, i];
      continue;
    }
    const l = b.kids[2 * k], r = b.kids[2 * k + 1];
    const tl = box(l, best), tr = box(r, best);
    if (tl >= 0 && tr >= 0) stack.push(...(tl < tr ? [r, l] : [l, r]));
    else if (tl >= 0) stack.push(l);
    else if (tr >= 0) stack.push(r);
  }
  return hit < 0 ? { t: -1, prim: -1 } : { t: best, prim: hit };
}
