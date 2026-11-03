/**
 * The sphere glyphs are drawn on: an icosahedron subdivided (2: 162
 * vertices, 3: 642; FURY's default is 724 points from electrostatic
 * repulsion, about the same), with, for each vertex, four neighbours around
 * it in order, so a shader can find the normal of the glyph's deformed
 * surface by central differences.
 */

export interface Sphere {
  /** Unit directions, x y z per vertex. */
  vertices: Float32Array;
  /** Triangles, counter-clockwise seen from outside. */
  faces: Uint32Array;
  /** Per vertex: neighbours a, b, c, d in order around it (a opposite c, b opposite d). */
  around: Uint32Array;
  count: number;
}

const cache = new Map<number, Sphere>();

export function icosphere(subdivisions: number): Sphere {
  const known = cache.get(subdivisions);
  if (known !== undefined) return known;
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((v) => {
    const n = Math.hypot(v[0], v[1], v[2]);
    return v.map((x) => x / n);
  });
  let faces: number[][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let s = 0; s < subdivisions; ++s) {
    const middles = new Map<string, number>();
    const middle = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let i = middles.get(key);
      if (i === undefined) {
        const m = [0, 1, 2].map((k) => verts[a][k] + verts[b][k]);
        const n = Math.hypot(m[0], m[1], m[2]);
        i = verts.push(m.map((x) => x / n)) - 1;
        middles.set(key, i);
      }
      return i;
    };
    const next: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = middle(a, b);
      const bc = middle(b, c);
      const ca = middle(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  // Make every face counter-clockwise from outside.
  for (const f of faces) {
    const [a, b, c] = f.map((i) => verts[i]);
    const u = [0, 1, 2].map((k) => b[k] - a[k]);
    const v = [0, 1, 2].map((k) => c[k] - a[k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (n[0] * a[0] + n[1] * a[1] + n[2] * a[2] < 0) [f[1], f[2]] = [f[2], f[1]];
  }
  const count = verts.length;
  // Each vertex's ring of neighbours, in order: follow the faces around it.
  const next = Array.from({ length: count }, () => new Map<number, number>());
  for (const [a, b, c] of faces) {
    next[a].set(b, c);
    next[b].set(c, a);
    next[c].set(a, b);
  }
  const around = new Uint32Array(4 * count);
  for (let i = 0; i < count; ++i) {
    const ring: number[] = [];
    let at = next[i].keys().next().value as number;
    while (ring.length < next[i].size) {
      ring.push(at);
      at = next[i].get(at)!;
    }
    const n = ring.length;
    around[4 * i] = ring[0];
    around[4 * i + 1] = ring[Math.round(n / 4)];
    around[4 * i + 2] = ring[Math.round(n / 2)];
    around[4 * i + 3] = ring[Math.round((3 * n) / 4) % n];
  }
  const sphere: Sphere = { vertices: Float32Array.from(verts.flat()), faces: Uint32Array.from(faces.flat()), around, count };
  cache.set(subdivisions, sphere);
  return sphere;
}
