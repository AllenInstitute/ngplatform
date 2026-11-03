/**
 * Filtered images, computed on the fly: a virtual store over an image's
 * store whose every chunk is the filter applied to the source's chunks
 * around it (with a margin as wide as the filter reaches), at every level,
 * the filter's width kept in physical units from level to level.  Nothing
 * is written: a chunk is computed when the viewer asks for it.
 *
 * Filters: mean and median over a box, Gaussian smoothing, and Frangi's
 * vesselness (tubes brighter, or darker, than around them, over a range of
 * scales).  Chunks are the image store's: x fastest (its transpose codec),
 * one block per time point or component.
 */
import type { VirtualStore } from "./store.js";

export type FilterSpec =
  | { kind: "mean"; radius: number }
  | { kind: "median"; radius: number }
  | { kind: "gaussian"; sigma: number }
  | { kind: "frangi"; sigmas: number[]; alpha: number; beta: number; c: number; bright: boolean };

/** A filter as written in a file name ("gaussian-sigma=1.5"), and back. */
export function filterName(f: FilterSpec): string {
  switch (f.kind) {
    case "mean":
    case "median":
      return `${f.kind}-radius=${f.radius}`;
    case "gaussian":
      return `gaussian-sigma=${f.sigma}`;
    case "frangi":
      return `frangi-sigmas=${f.sigmas.join("_")}-alpha=${f.alpha}-beta=${f.beta}-c=${f.c}-${f.bright ? "bright" : "dark"}`;
  }
}

export function parseFilterName(name: string): FilterSpec {
  const [kind, ...rest] = name.split("-");
  const p = Object.fromEntries(rest.filter((r) => r.includes("=")).map((r) => r.split("=") as [string, string]));
  const num = (k: string, d: number) => (p[k] !== undefined && Number.isFinite(Number(p[k])) ? Number(p[k]) : d);
  switch (kind) {
    case "mean":
    case "median":
      return { kind, radius: Math.max(1, Math.min(kind === "median" ? 3 : 8, Math.round(num("radius", 1)))) };
    case "gaussian":
      return { kind, sigma: Math.max(0.1, num("sigma", 1)) };
    case "frangi":
      return {
        kind,
        sigmas: (p.sigmas ?? "1_2").split("_").map(Number).filter((s) => s > 0),
        alpha: num("alpha", 0.5),
        beta: num("beta", 0.5),
        c: num("c", 100),
        bright: !rest.includes("dark"),
      };
    default:
      throw new Error(`no filter called ${kind}`);
  }
}

/** A filter's width in voxels at a level `factor` times coarser than the finest. */
function scaled(f: FilterSpec, factor: number): FilterSpec {
  switch (f.kind) {
    case "mean":
    case "median":
      return { ...f, radius: Math.max(0, Math.round(f.radius / factor)) };
    case "gaussian":
      return { ...f, sigma: f.sigma / factor };
    case "frangi":
      return { ...f, sigmas: f.sigmas.map((s) => s / factor) };
  }
}

/** How far a filter reaches, in voxels: the margin a chunk needs read around it. */
export function reach(f: FilterSpec): number {
  switch (f.kind) {
    case "mean":
    case "median":
      return f.radius;
    case "gaussian":
      return Math.ceil(3 * f.sigma);
    case "frangi":
      return Math.ceil(3 * Math.max(...f.sigmas)) + 1;
  }
}

// ------------------------------------------------------------ kernels

/** A block of voxels, x fastest. */
export interface Block {
  data: Float32Array;
  size: [number, number, number];
}

const at = (b: Block, x: number, y: number, z: number) => x + b.size[0] * (y + b.size[1] * z);

/** Along one axis, each voxel the weighted sum of its neighbours (`weights` centred, edges clamped). */
function convolveAxis(b: Block, axis: number, weights: Float32Array): Block {
  const [nx, ny, nz] = b.size;
  const out = new Float32Array(b.data.length);
  const r = (weights.length - 1) / 2;
  const n = b.size[axis];
  const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny;
  for (let z = 0; z < nz; ++z) {
    for (let y = 0; y < ny; ++y) {
      for (let x = 0; x < nx; ++x) {
        const i = at(b, x, y, z);
        const p = axis === 0 ? x : axis === 1 ? y : z;
        let sum = 0;
        for (let k = -r; k <= r; ++k) {
          const q = Math.min(n - 1, Math.max(0, p + k));
          sum += weights[k + r] * b.data[i + (q - p) * stride];
        }
        out[i] = sum;
      }
    }
  }
  return { data: out, size: b.size };
}

function separable(b: Block, weights: Float32Array): Block {
  let out = b;
  for (let axis = 0; axis < 3; ++axis) if (b.size[axis] > 1) out = convolveAxis(out, axis, weights);
  return out;
}

export function boxMean(b: Block, radius: number): Block {
  if (radius <= 0) return b;
  return separable(b, new Float32Array(2 * radius + 1).fill(1 / (2 * radius + 1)));
}

export function gaussian(b: Block, sigma: number): Block {
  if (sigma < 0.3) return b;
  const r = Math.ceil(3 * sigma);
  const w = new Float32Array(2 * r + 1);
  let total = 0;
  for (let k = -r; k <= r; ++k) total += w[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma));
  for (let k = 0; k < w.length; ++k) w[k] /= total;
  return separable(b, w);
}

export function boxMedian(b: Block, radius: number): Block {
  if (radius <= 0) return b;
  const [nx, ny, nz] = b.size;
  const out = new Float32Array(b.data.length);
  const values = new Float32Array((2 * radius + 1) ** 3);
  for (let z = 0; z < nz; ++z) {
    for (let y = 0; y < ny; ++y) {
      for (let x = 0; x < nx; ++x) {
        let n = 0;
        for (let dz = -radius; dz <= radius; ++dz) {
          const zz = z + dz;
          if (zz < 0 || zz >= nz) continue;
          for (let dy = -radius; dy <= radius; ++dy) {
            const yy = y + dy;
            if (yy < 0 || yy >= ny) continue;
            for (let dx = -radius; dx <= radius; ++dx) {
              const xx = x + dx;
              if (xx < 0 || xx >= nx) continue;
              values[n++] = b.data[at(b, xx, yy, zz)];
            }
          }
        }
        const part = values.subarray(0, n).sort();
        out[at(b, x, y, z)] = n % 2 ? part[(n - 1) / 2] : (part[n / 2 - 1] + part[n / 2]) / 2;
      }
    }
  }
  return { data: out, size: b.size };
}

/** The eigenvalues of a symmetric 3 × 3 matrix, sorted by size (|λ1| ≤ |λ2| ≤ |λ3|). */
export function symmetricEigenvalues(a: number, b: number, c: number, d: number, e: number, f: number): [number, number, number] {
  // [[a, b, c], [b, d, e], [c, e, f]], by the trigonometric method.
  const p1 = b * b + c * c + e * e;
  let l: number[];
  if (p1 < 1e-30) {
    l = [a, d, f];
  } else {
    const q = (a + d + f) / 3;
    const p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1;
    const p = Math.sqrt(p2 / 6);
    const B = [(a - q) / p, b / p, c / p, (d - q) / p, e / p, (f - q) / p];
    const det = B[0] * (B[3] * B[5] - B[4] * B[4]) - B[1] * (B[1] * B[5] - B[4] * B[2]) + B[2] * (B[1] * B[4] - B[3] * B[2]);
    const r = Math.max(-1, Math.min(1, det / 2));
    const phi = Math.acos(r) / 3;
    const e1 = q + 2 * p * Math.cos(phi);
    const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
    l = [e1, 3 * q - e1 - e3, e3];
  }
  l.sort((u, v) => Math.abs(u) - Math.abs(v));
  return l as [number, number, number];
}

/**
 * Frangi's vesselness (Frangi et al. 1998): at each scale, the Hessian of
 * the image smoothed to that scale (scale-normalised); tubes are where one
 * eigenvalue is near 0 and the other two large and of the tube's sign.  The
 * largest response over the scales.
 */
export function frangi(b: Block, f: { sigmas: number[]; alpha: number; beta: number; c: number; bright: boolean }): Block {
  const [nx, ny, nz] = b.size;
  const out = new Float32Array(b.data.length);
  for (const sigma of f.sigmas) {
    const s = gaussian(b, Math.max(sigma, 0.5));
    const v = s.data;
    const norm = sigma * sigma;
    const g = (x: number, y: number, z: number) => v[at(s, Math.min(nx - 1, Math.max(0, x)), Math.min(ny - 1, Math.max(0, y)), Math.min(nz - 1, Math.max(0, z)))];
    for (let z = 0; z < nz; ++z) {
      for (let y = 0; y < ny; ++y) {
        for (let x = 0; x < nx; ++x) {
          const c0 = g(x, y, z);
          const hxx = (g(x + 1, y, z) - 2 * c0 + g(x - 1, y, z)) * norm;
          const hyy = (g(x, y + 1, z) - 2 * c0 + g(x, y - 1, z)) * norm;
          const hzz = (g(x, y, z + 1) - 2 * c0 + g(x, y, z - 1)) * norm;
          const hxy = ((g(x + 1, y + 1, z) - g(x + 1, y - 1, z) - g(x - 1, y + 1, z) + g(x - 1, y - 1, z)) / 4) * norm;
          const hxz = ((g(x + 1, y, z + 1) - g(x + 1, y, z - 1) - g(x - 1, y, z + 1) + g(x - 1, y, z - 1)) / 4) * norm;
          const hyz = ((g(x, y + 1, z + 1) - g(x, y + 1, z - 1) - g(x, y - 1, z + 1) + g(x, y - 1, z - 1)) / 4) * norm;
          const [l1, l2, l3] = symmetricEigenvalues(hxx, hxy, hxz, hyy, hyz, hzz);
          // Bright tubes: λ2, λ3 negative; dark tubes: positive.
          if (f.bright ? l2 > 0 || l3 > 0 : l2 < 0 || l3 < 0) continue;
          const ra = Math.abs(l2) / (Math.abs(l3) || 1e-12);
          const rb = Math.abs(l1) / (Math.sqrt(Math.abs(l2 * l3)) || 1e-12);
          const st = Math.sqrt(l1 * l1 + l2 * l2 + l3 * l3);
          const response =
            (1 - Math.exp(-(ra * ra) / (2 * f.alpha * f.alpha))) * Math.exp(-(rb * rb) / (2 * f.beta * f.beta)) * (1 - Math.exp(-(st * st) / (2 * f.c * f.c)));
          const i = at(b, x, y, z);
          if (response > out[i]) out[i] = response;
        }
      }
    }
  }
  return { data: out, size: b.size };
}

export function applyFilter(b: Block, f: FilterSpec): Block {
  switch (f.kind) {
    case "mean":
      return boxMean(b, f.radius);
    case "median":
      return boxMedian(b, f.radius);
    case "gaussian":
      return gaussian(b, f.sigma);
    case "frangi":
      return frangi(b, f);
  }
}

// ------------------------------------------------------------ the store

const ARRAY: Record<string, { new (b: ArrayBufferLike): ArrayLike<number> }> = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** A filtered image: `source` (an image store, as the platform makes them) with `filter` applied, chunk by chunk. */
export class FilteredStore implements VirtualStore {
  private readonly meta = new Map<string, any>();
  private readonly factors: number[];

  private constructor(
    private readonly source: VirtualStore,
    private readonly filter: FilterSpec,
    private readonly group: any,
    readonly name: string,
  ) {
    const ms = group.attributes?.ome?.multiscales?.[0];
    // Each level's voxel size relative to the finest, along the spatial axes.
    const scales: number[][] = (ms?.datasets ?? []).map((d: any) => {
      const t = d.coordinateTransformations?.[0];
      const scale = t?.type === "sequence" ? t.transformations?.find((x: any) => x.type === "scale")?.scale : t?.scale;
      return Array.isArray(scale) ? scale.slice(-3) : [1, 1, 1];
    });
    this.factors = scales.map((s) => (s[0] + s[1] + s[2]) / 3 / ((scales[0]?.[0] + scales[0]?.[1] + scales[0]?.[2]) / 3 || 1));
  }

  static async open(source: VirtualStore, filter: FilterSpec, name: string): Promise<FilteredStore> {
    const bytes = await source.get("zarr.json");
    if (bytes === undefined) throw new Error("the source image has no zarr.json");
    return new FilteredStore(source, filter, JSON.parse(decoder.decode(bytes)), name);
  }

  /** Float results for smoothing and vesselness; a median keeps the image's own type. */
  private outType(inType: string): string {
    return this.filter.kind === "median" ? inType : "float32";
  }

  private async levelMeta(level: string): Promise<any> {
    let m = this.meta.get(level);
    if (m === undefined) {
      const bytes = await this.source.get(`${level}/zarr.json`);
      if (bytes === undefined) return undefined;
      m = JSON.parse(decoder.decode(bytes));
      this.meta.set(level, m);
    }
    return m;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    if (key === "zarr.json") {
      const group = structuredClone(this.group);
      const ms = group.attributes?.ome?.multiscales?.[0];
      if (ms !== undefined) {
        ms.name = this.name;
        ms.metadata = { ...(ms.metadata ?? {}), description: `${this.name}: ${filterName(this.filter)}, computed on the fly` };
      }
      // Vesselness is 0 to 1, not the image's range.
      if (this.filter.kind === "frangi" && group.attributes?.ome?.omero !== undefined) delete group.attributes.ome.omero;
      return encoder.encode(JSON.stringify(group));
    }
    const m = /^(\d+)\/zarr\.json$/.exec(key);
    if (m !== null) {
      const meta = await this.levelMeta(m[1]);
      if (meta === undefined) return undefined;
      // Written little-endian, whatever the source's byte order.
      const codecs = (meta.codecs ?? []).map((c: any) => (c.name === "bytes" ? { name: "bytes", configuration: { endian: "little" } } : c));
      return encoder.encode(JSON.stringify({ ...meta, data_type: this.outType(meta.data_type), fill_value: 0, codecs }));
    }
    const c = /^(\d+)\/c\/([\d/]+)$/.exec(key);
    if (c === null) return this.source.get(key);
    return this.chunk(c[1], c[2].split("/").map(Number));
  }

  private async chunk(level: string, index: number[]): Promise<Uint8Array | undefined> {
    const meta = await this.levelMeta(level);
    if (meta === undefined) return undefined;
    const shape: number[] = meta.shape;
    const chunk: number[] = meta.chunk_grid.configuration.chunk_shape;
    const rank = shape.length;
    const extra = rank - 3;
    const inArray = ARRAY[meta.data_type];
    const width = inArray === undefined ? 1 : (inArray as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
    // A big-endian source (MGH) is read in its own byte order.
    const big = width > 1 && meta.codecs?.find((c: any) => c.name === "bytes")?.configuration?.endian === "big";
    const outType = this.outType(meta.data_type);
    const OutArray = ARRAY[outType] as unknown as { new (n: number): Float32Array };
    const filter = scaled(this.filter, this.factors[Number(level)] ?? 1);
    const margin = reach(filter);
    const cs = chunk.slice(extra) as [number, number, number];
    const ss = shape.slice(extra);
    const grid = ss.map((n, d) => Math.ceil(n / cs[d]));
    const lo = cs.map((n, d) => Math.max(0, index[extra + d] * n - margin));
    const hi = cs.map((n, d) => Math.min(ss[d], (index[extra + d] + 1) * n + margin));
    const size = [0, 1, 2].map((d) => hi[d] - lo[d]) as [number, number, number];
    const frames = extra === 0 ? 1 : chunk[0];
    const per = cs[0] * cs[1] * cs[2];
    const out = new OutArray(frames * per);
    const blocks = Array.from({ length: frames }, () => new Float32Array(size[0] * size[1] * size[2]));
    // The source chunks the padded box touches.
    const first = lo.map((v, d) => Math.floor(v / cs[d]));
    const last = hi.map((v, d) => Math.min(grid[d] - 1, Math.floor((v - 1) / cs[d])));
    for (let k = first[2]; k <= last[2]; ++k) {
      for (let j = first[1]; j <= last[1]; ++j) {
        for (let i = first[0]; i <= last[0]; ++i) {
          const bytes = await this.source.get(`${level}/c/${[...index.slice(0, extra), i, j, k].join("/")}`);
          if (bytes === undefined) continue;
          const raw = bytes.slice();
          if (big) for (let b = 0; b < raw.length; b += width) raw.subarray(b, b + width).reverse();
          const values = new inArray(raw.buffer);
          const origin = [i * cs[0], j * cs[1], k * cs[2]];
          for (let f = 0; f < frames; ++f) {
            const block = blocks[f];
            for (let z = Math.max(lo[2], origin[2]); z < Math.min(hi[2], origin[2] + cs[2]); ++z) {
              for (let y = Math.max(lo[1], origin[1]); y < Math.min(hi[1], origin[1] + cs[1]); ++y) {
                const from = f * per + (z - origin[2]) * cs[0] * cs[1] + (y - origin[1]) * cs[0];
                const to = (z - lo[2]) * size[0] * size[1] + (y - lo[1]) * size[0];
                for (let x = Math.max(lo[0], origin[0]); x < Math.min(hi[0], origin[0] + cs[0]); ++x) block[to + x - lo[0]] = values[from + x - origin[0]];
              }
            }
          }
        }
      }
    }
    for (let f = 0; f < frames; ++f) {
      const filtered = applyFilter({ data: blocks[f], size }, filter).data;
      const start = index.slice(extra).map((v, d) => v * cs[d]);
      for (let z = 0; z < cs[2]; ++z) {
        const zz = start[2] + z - lo[2];
        if (start[2] + z >= ss[2]) break;
        for (let y = 0; y < cs[1]; ++y) {
          const yy = start[1] + y - lo[1];
          if (start[1] + y >= ss[1]) break;
          for (let x = 0; x < cs[0]; ++x) {
            if (start[0] + x >= ss[0]) break;
            out[f * per + x + cs[0] * (y + cs[1] * z)] = filtered[start[0] + x - lo[0] + size[0] * (yy + size[1] * zz)];
          }
        }
      }
    }
    return new Uint8Array(out.buffer);
  }
}
