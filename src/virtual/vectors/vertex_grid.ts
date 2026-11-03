/**
 * The vertex of a mesh nearest a point, through a uniform grid over the
 * vertices' bounding box: each cell lists the vertices in it (sorted by
 * cell, `start[c]` to `start[c + 1]` in `order`).  A lookup reads the
 * point's cell, then shells of cells around it, one cell thicker each
 * time, and stops once no cell further out can hold a nearer vertex, or
 * once the shells pass the distance asked for.  Cells are about the size
 * that puts a few vertices in each occupied one on a surface (a sheet,
 * not a volume), so a lookup on a 160 000-vertex cortex reads a few
 * dozen vertices.
 */

/** The nearest vertex and its distance (in the vertices' units). */
export interface Nearest {
  index: number;
  distance: number;
}

/** At most this many cells (a grid of 128³), however the vertices spread. */
const MAX_CELLS = 1 << 21;

export class VertexGrid {
  private readonly lo: [number, number, number];
  private readonly cell: number;
  private readonly dims: [number, number, number];
  /** Where each cell's vertices start in `order` (one more entry than cells). */
  private readonly start: Int32Array;
  /** Vertex indices, by cell. */
  private readonly order: Int32Array;

  /** `vertices`: x, y, z of each vertex in turn (non-finite ones are left out). */
  constructor(private readonly vertices: ArrayLike<number>) {
    const n = Math.floor(vertices.length / 3);
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; ++i) {
      for (let k = 0; k < 3; ++k) {
        const v = vertices[3 * i + k];
        if (!Number.isFinite(v)) continue;
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
    for (let k = 0; k < 3; ++k) if (!(lo[k] <= hi[k])) lo[k] = hi[k] = 0;
    const span = [0, 1, 2].map((k) => hi[k] - lo[k]);
    // Vertices on a sheet: the cell whose square holds about 4 of them, if they spread over the box's largest face.
    const sorted = [...span].sort((a, b) => b - a);
    const area = Math.max(sorted[0] * sorted[1], sorted[0] * sorted[0] * 1e-6, 1e-12);
    let cell = Math.sqrt((4 * area) / Math.max(1, n));
    if (!(cell > 0)) cell = 1;
    const dimsOf = (c: number) => span.map((s) => Math.max(1, Math.floor(s / c) + 1)) as [number, number, number];
    let dims = dimsOf(cell);
    while (dims[0] * dims[1] * dims[2] > MAX_CELLS) {
      cell *= 1.25;
      dims = dimsOf(cell);
    }
    this.lo = lo;
    this.cell = cell;
    this.dims = dims;
    // Counting sort of the vertices by cell.
    const cells = dims[0] * dims[1] * dims[2];
    const cellOf = new Int32Array(n);
    const start = new Int32Array(cells + 1);
    for (let i = 0; i < n; ++i) {
      const c = this.cellIndex(vertices[3 * i], vertices[3 * i + 1], vertices[3 * i + 2]);
      cellOf[i] = c;
      if (c >= 0) start[c + 1]++;
    }
    for (let c = 0; c < cells; ++c) start[c + 1] += start[c];
    const order = new Int32Array(start[cells]);
    const fill = start.slice(0, cells);
    for (let i = 0; i < n; ++i) if (cellOf[i] >= 0) order[fill[cellOf[i]]++] = i;
    this.start = start;
    this.order = order;
  }

  /** The cell a point is in (-1 for a non-finite point). */
  private cellIndex(x: number, y: number, z: number): number {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return -1;
    const [i, j, k] = [x, y, z].map((v, a) => Math.min(this.dims[a] - 1, Math.max(0, Math.floor((v - this.lo[a]) / this.cell))));
    return i + this.dims[0] * (j + this.dims[1] * k);
  }

  /**
   * The vertex nearest `point`, if one is within `within` of it (any
   * distance when it is left out); undefined when none is, or the grid
   * holds no vertex.
   */
  nearest(point: ArrayLike<number>, within = Infinity): Nearest | undefined {
    const [x, y, z] = [point[0], point[1], point[2]];
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) || this.order.length === 0) return undefined;
    const { dims, cell, lo, start, order, vertices } = this;
    // The point's cell, unclamped (the point may be outside the box).
    const q = [x, y, z].map((v, a) => Math.floor((v - lo[a]) / cell));
    let best = -1;
    let bestSq = within === Infinity ? Infinity : within * within;
    // The furthest shell that still meets the grid.
    const last = Math.max(...[0, 1, 2].map((a) => Math.max(q[a], dims[a] - 1 - q[a])));
    // How far outside the grid the point is, in cells: shells before that are empty.
    const first = Math.max(0, ...[0, 1, 2].map((a) => Math.max(-q[a], q[a] - (dims[a] - 1))));
    const visit = (i: number, j: number, k: number) => {
      const c = i + dims[0] * (j + dims[1] * k);
      for (let p = start[c]; p < start[c + 1]; ++p) {
        const v = order[p];
        const dx = vertices[3 * v] - x;
        const dy = vertices[3 * v + 1] - y;
        const dz = vertices[3 * v + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestSq || (d === bestSq && best === -1)) {
          bestSq = d;
          best = v;
        }
      }
    };
    for (let r = first; r <= last; ++r) {
      // A vertex in shell r is at least (r - 1) cells from the point (in its cell, or clamped to the grid's edge).
      const reach = Math.max(0, r - 1) * cell;
      if (reach * reach > bestSq) break;
      const i0 = Math.max(0, q[0] - r);
      const i1 = Math.min(dims[0] - 1, q[0] + r);
      const j0 = Math.max(0, q[1] - r);
      const j1 = Math.min(dims[1] - 1, q[1] + r);
      for (let i = i0; i <= i1; ++i) {
        for (let j = j0; j <= j1; ++j) {
          if (Math.abs(i - q[0]) === r || Math.abs(j - q[1]) === r) {
            for (let k = Math.max(0, q[2] - r); k <= Math.min(dims[2] - 1, q[2] + r); ++k) visit(i, j, k);
          } else {
            if (q[2] - r >= 0 && q[2] - r < dims[2]) visit(i, j, q[2] - r);
            if (r > 0 && q[2] + r >= 0 && q[2] + r < dims[2]) visit(i, j, q[2] + r);
          }
        }
      }
    }
    return best === -1 ? undefined : { index: best, distance: Math.sqrt(bestSq) };
  }
}
