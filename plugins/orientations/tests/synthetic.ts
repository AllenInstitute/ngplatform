/**
 * Synthetic multiscale OME-Zarr stores of orientations, made in memory for
 * the tests (and written to a folder for trying the plugin in a browser,
 * see orientations.test.ts): crossing fibres as spherical harmonics, a
 * tensor field and a vector field, each with coarser levels that are the
 * means of 2 × 2 × 2 boxes of the finer, as a pyramid writer would make
 * (log-Euclidean means for the tensors, as make_dipy_example.py and the
 * app's NIfTI reader make them).
 *
 * The layout: a band of fibres along x (y in the band's rows), a band along
 * y (x in its columns), crossing where they meet, fibres along z elsewhere,
 * and nothing (zeros) in a border.
 */
import { LogEuclideanSum } from "../../../src/virtual/images/tensors.js";
import { fitSh, type ShBasis } from "../sh.js";

export type Store = Map<string, Uint8Array>;

export interface Synthetic {
  name: string;
  components: number;
  size: [number, number, number];
  /** Voxel size, mm, of the finest level. */
  voxel: number;
  levels: number;
  chunk: number;
  /** Writes voxel (x, y, z)'s components into `out` (left as zeros for none). */
  value(x: number, y: number, z: number, out: Float32Array): void;
  /** attributes.orientations, when the store says what it holds. */
  orientations?: Record<string, unknown>;
  /** How coarser levels average a box: each component's mean (the default), or tensors' log-Euclidean mean (FSL's order). */
  pyramid?: "mean" | "log-euclidean";
}

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** The fibre directions at a voxel of the layout (none in the border). */
export function fibresAt(x: number, y: number, z: number, size: [number, number, number]): [number, number, number][] {
  const [nx, ny, nz] = size;
  const border = Math.max(1, Math.round(nx / 16));
  if (x < border || y < border || x >= nx - border || y >= ny - border || z >= nz) return [];
  const inRows = y >= Math.round(ny * 0.3) && y < Math.round(ny * 0.5);
  const inCols = x >= Math.round(nx * 0.55) && x < Math.round(nx * 0.75);
  const out: [number, number, number][] = [];
  if (inRows) out.push([1, 0, 0]);
  if (inCols) out.push([0, 1, 0]);
  if (out.length === 0) out.push([0, 0, 1]);
  return out;
}

/** Points spread evenly over the sphere (a Fibonacci spiral). */
export function spiral(n: number): number[] {
  const dirs: number[] = [];
  for (let i = 0; i < n; ++i) {
    const z = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - z * z);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    dirs.push(r * Math.cos(phi), r * Math.sin(phi), z);
  }
  return dirs;
}

/** SH coefficients of a fibre ODF, a sharp lobe along each fibre, in a basis. */
export function fibreOdf(fibres: [number, number, number][], basis: ShBasis, lmax: number): Float64Array {
  const dirs = spiral(500);
  const values: number[] = [];
  for (let i = 0; i < dirs.length; i += 3) {
    let v = 0;
    for (const f of fibres) {
      const c = dirs[i] * f[0] + dirs[i + 1] * f[1] + dirs[i + 2] * f[2];
      v += Math.exp(-12 * (1 - c * c));
    }
    values.push(v / fibres.length);
  }
  return fitSh(basis, lmax, dirs, values, 1e-4);
}

export function crossingSh(size: [number, number, number], basis: ShBasis = "descoteaux07-legacy", lmax = 8): Synthetic {
  const count = ((lmax + 1) * (lmax + 2)) / 2;
  const cache = new Map<string, Float64Array>();
  return {
    name: "crossing-sh",
    components: count,
    size,
    voxel: 2,
    levels: 4,
    chunk: 16,
    value(x, y, z, out) {
      const fibres = fibresAt(x, y, z, size);
      if (fibres.length === 0) return;
      const key = JSON.stringify(fibres);
      let c = cache.get(key);
      if (c === undefined) cache.set(key, (c = fibreOdf(fibres, basis, lmax)));
      out.set(c);
    },
    orientations: { type: "sh", basis: basis.replace("-legacy", ""), legacy: basis.endsWith("-legacy"), frame: "voxel" },
  };
}

/** Tensors (FSL's order): prolate along a fibre, planar where two cross. */
export function tensorField(size: [number, number, number]): Synthetic {
  return {
    name: "tensors",
    components: 6,
    size,
    voxel: 2,
    levels: 4,
    chunk: 16,
    value(x, y, z, out) {
      const fibres = fibresAt(x, y, z, size);
      if (fibres.length === 0) return;
      // D = 0.3 I + 1.4 Σ f fᵀ / n  (×1e-3 mm²/s)
      const d = [0.3, 0, 0, 0.3, 0, 0.3]; // xx xy xz yy yz zz
      for (const f of fibres) {
        const w = 1.4 / fibres.length;
        d[0] += w * f[0] * f[0];
        d[1] += w * f[0] * f[1];
        d[2] += w * f[0] * f[2];
        d[3] += w * f[1] * f[1];
        d[4] += w * f[1] * f[2];
        d[5] += w * f[2] * f[2];
      }
      out.set(d.map((v) => v * 1e-3));
    },
    orientations: { type: "tensor", order: "fsl", frame: "voxel" },
    pyramid: "log-euclidean",
  };
}

/** Unit vectors turning around the volume's middle (a vortex in x, y), tilting up with z. */
export function vectorField(size: [number, number, number]): Synthetic {
  const [nx, ny, nz] = size;
  return {
    name: "vectors",
    components: 3,
    size,
    voxel: 2,
    levels: 4,
    chunk: 16,
    value(x, y, z, out) {
      const dx = x - (nx - 1) / 2;
      const dy = y - (ny - 1) / 2;
      const r = Math.hypot(dx, dy);
      if (r < 1 || r > nx / 2 - 1) return;
      const tilt = (z / Math.max(1, nz - 1)) * 0.8;
      const v = [-dy / r, dx / r, tilt];
      const n = Math.hypot(v[0], v[1], v[2]);
      out.set(v.map((c) => c / n));
    },
    orientations: { type: "vector", frame: "voxel" },
  };
}

/**
 * The store's keys: an OME-Zarr 0.5 image (axes c, z, y, x; millimetres),
 * float32, little-endian, uncompressed, each level the mean of 2 × 2 × 2
 * boxes of the one before.
 */
export function buildStore(s: Synthetic): Store {
  const store: Store = new Map();
  const C = s.components;
  let [nx, ny, nz] = s.size;
  // Level 0, x fastest then y, z, then components: data[((c * nz + z) * ny + y) * nx + x].
  let data = new Float32Array(C * nx * ny * nz);
  const one = new Float32Array(C);
  for (let z = 0; z < nz; ++z) {
    for (let y = 0; y < ny; ++y) {
      for (let x = 0; x < nx; ++x) {
        one.fill(0);
        s.value(x, y, z, one);
        for (let c = 0; c < C; ++c) data[((c * nz + z) * ny + y) * nx + x] = one[c];
      }
    }
  }
  const datasets: unknown[] = [];
  for (let level = 0; level < s.levels; ++level) {
    if (level > 0) {
      const [px, py, pz] = [nx, ny, nz];
      nx = Math.ceil(px / 2);
      ny = Math.ceil(py / 2);
      nz = Math.ceil(pz / 2);
      const next = new Float32Array(C * nx * ny * nz);
      if (s.pyramid === "log-euclidean") {
        const sums = new LogEuclideanSum(nx * ny * nz, "fsl");
        for (let Z = 0; Z < pz; ++Z)
          for (let Y = 0; Y < py; ++Y)
            for (let X = 0; X < px; ++X) sums.add((Math.floor(Z / 2) * ny + Math.floor(Y / 2)) * nx + Math.floor(X / 2), data, (Z * py + Y) * px + X, px * py * pz);
        for (let d = 0; d < nx * ny * nz; ++d) sums.mean(d, next, d, nx * ny * nz);
      } else for (let c = 0; c < C; ++c) {
        for (let z = 0; z < nz; ++z) {
          for (let y = 0; y < ny; ++y) {
            for (let x = 0; x < nx; ++x) {
              let sum = 0;
              let n = 0;
              for (let dz = 0; dz < 2; ++dz)
                for (let dy = 0; dy < 2; ++dy)
                  for (let dx = 0; dx < 2; ++dx) {
                    const X = 2 * x + dx;
                    const Y = 2 * y + dy;
                    const Z = 2 * z + dz;
                    if (X >= px || Y >= py || Z >= pz) continue;
                    sum += data[((c * pz + Z) * py + Y) * px + X];
                    n++;
                  }
              next[((c * nz + z) * ny + y) * nx + x] = sum / n;
            }
          }
        }
      }
      data = next;
    }
    const f = 2 ** level;
    const scale = s.voxel * f;
    const shift = ((f - 1) / 2) * s.voxel;
    datasets.push({
      path: String(level),
      coordinateTransformations: [
        { type: "scale", scale: [1, scale, scale, scale] },
        { type: "translation", translation: [0, shift, shift, shift] },
      ],
    });
    const ch = s.chunk;
    const shape = [C, nz, ny, nx];
    store.set(
      `${level}/zarr.json`,
      json({
        zarr_format: 3,
        node_type: "array",
        shape,
        data_type: "float32",
        chunk_grid: { name: "regular", configuration: { chunk_shape: [C, ch, ch, ch] } },
        chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
        fill_value: 0,
        codecs: [{ name: "bytes", configuration: { endian: "little" } }],
        dimension_names: ["c", "z", "y", "x"],
        attributes: {},
      }),
    );
    for (let cz = 0; cz < Math.ceil(nz / ch); ++cz) {
      for (let cy = 0; cy < Math.ceil(ny / ch); ++cy) {
        for (let cx = 0; cx < Math.ceil(nx / ch); ++cx) {
          // Every chunk is full size; the part past the array's edge is fill.
          const chunk = new Float32Array(C * ch * ch * ch);
          for (let c = 0; c < C; ++c)
            for (let z = 0; z < ch; ++z)
              for (let y = 0; y < ch; ++y)
                for (let x = 0; x < ch; ++x) {
                  const X = cx * ch + x;
                  const Y = cy * ch + y;
                  const Z = cz * ch + z;
                  if (X >= nx || Y >= ny || Z >= nz) continue;
                  chunk[((c * ch + z) * ch + y) * ch + x] = data[((c * nz + Z) * ny + Y) * nx + X];
                }
          if (chunk.every((v) => v === 0)) continue;
          store.set(`${level}/c/0/${cz}/${cy}/${cx}`, new Uint8Array(chunk.buffer));
        }
      }
    }
  }
  store.set(
    "zarr.json",
    json({
      zarr_format: 3,
      node_type: "group",
      attributes: {
        ome: {
          version: "0.5",
          multiscales: [
            {
              name: s.name,
              axes: [
                { name: "c", type: "channel" },
                { name: "z", type: "space", unit: "millimeter" },
                { name: "y", type: "space", unit: "millimeter" },
                { name: "x", type: "space", unit: "millimeter" },
              ],
              datasets,
            },
          ],
        },
        ...(s.orientations ? { orientations: s.orientations } : {}),
      },
    }),
  );
  return store;
}

/**
 * The same image as OME-Zarr 0.4 in Zarr v2 (`.zattrs`, `.zarray`, chunk
 * keys "0.1.2.3"), as ome-zarr-py writes it; `order` "F" stores each
 * chunk's first index fastest.
 */
export function toZarr2(v3: Store, order: "C" | "F" = "C"): Store {
  const out: Store = new Map();
  const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
  const group = decode(v3.get("zarr.json")!);
  const { ome, ...rest } = group.attributes;
  out.set(".zgroup", json({ zarr_format: 2 }));
  out.set(".zattrs", json({ multiscales: ome.multiscales.map((m: object) => ({ ...m, version: "0.4" })), ...rest }));
  for (const [key, bytes] of v3) {
    const meta = /^(\d+)\/zarr\.json$/.exec(key);
    if (meta !== null) {
      const array = decode(bytes);
      out.set(`${meta[1]}/.zarray`, json({
        zarr_format: 2,
        shape: array.shape,
        chunks: array.chunk_grid.configuration.chunk_shape,
        dtype: "<f4",
        compressor: null,
        fill_value: 0,
        order,
        filters: null,
      }));
      continue;
    }
    const chunk = /^(\d+)\/c\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(key);
    if (chunk === null) continue;
    const [, level, ...index] = chunk;
    let data = bytes;
    if (order === "F") {
      const shape = decode(v3.get(`${level}/zarr.json`)!).chunk_grid.configuration.chunk_shape as number[];
      const c = new Float32Array(bytes.slice().buffer);
      const f = new Float32Array(c.length);
      const [n0, n1, n2, n3] = shape;
      for (let a = 0; a < n0; ++a) for (let b = 0; b < n1; ++b) for (let d = 0; d < n2; ++d) for (let e = 0; e < n3; ++e) f[a + n0 * (b + n1 * (d + n2 * e))] = c[((a * n1 + b) * n2 + d) * n3 + e];
      data = new Uint8Array(f.buffer);
    }
    out.set(`${level}/${index.join(".")}`, data);
  }
  return out;
}

/** A fetch answering from stores by URL prefix (and 404 for anything else). */
export function storeFetch(stores: Record<string, Store>): (url: string | URL) => Promise<Response> {
  return async (url) => {
    const text = String(url);
    for (const [prefix, store] of Object.entries(stores)) {
      if (!text.startsWith(prefix)) continue;
      const data = store.get(text.slice(prefix.length));
      return data === undefined ? new Response(null, { status: 404 }) : new Response(data as BodyInit, { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
}
