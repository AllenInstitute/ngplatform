/**
 * A virtual zarr-vectors mesh store: a mesh file's triangles served as a
 * format 0.9.3 mesh store made from them, nothing written.
 *
 * The simplest valid layout: one cell holds the whole mesh, so every face
 * is a row of `links/0/0.0.0_0.0.0` (three cell-local vertex rows, in the
 * file's winding).  Each object (an .obj `o`/`g` group, or the whole file)
 * is one fragment of the vertices and one group of the faces
 * (`link_fragments`, with the level's `fragment_link_groups`), so the
 * viewer reads one object's mesh by two byte ranges.  Object ids start at 1
 * (segment 0 is the background).  A mesh is moved to start at the cell's
 * corner, the move kept as `coordinate_offset`, which the reader adds back.
 */
import type { MeshData } from "./mesh_files.js";
import { fragmentIndex } from "./streamlines.js";
import { DEFAULT_MAPS, labelTable, type SurfaceCompanions, type SurfaceMap } from "./surfaces.js";
import type { SurfaceLabel } from "./surface_values.js";
import { VertexGrid } from "./vertex_grid.js";

const MANIFEST_ROWS = 16384;
const COLUMN_ROWS = 65536;

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const group = (attributes: Record<string, unknown> = {}) => ({ zarr_format: 3, node_type: "group", attributes });

function element(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, payload.byteLength, true);
  out.set(payload, 8);
  return out;
}

function perCell(attributes: Record<string, unknown>): unknown {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: [1, 1, 1],
    data_type: "variable_length_bytes",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 1, 1] } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: "",
    codecs: [{ name: "vlen-bytes", configuration: {} }],
    attributes: { nonempty_chunks: ["0.0.0"], chunk_grid_origin: [0, 0, 0], ...attributes },
  };
}

function column(n: number, rows: number, dataType: string, fill: unknown, attributes: Record<string, unknown> = {}): unknown {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: [n],
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: [rows] } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: fill,
    codecs: dataType === "variable_length_bytes" ? [{ name: "vlen-bytes", configuration: {} }] : [{ name: "bytes", configuration: { endian: "little" } }],
    attributes,
  };
}

/** A guess at the unit: EM meshes are in nanometres (spans of tens of thousands), others millimetres. */
export function meshUnit(extent: number): string {
  return extent > 50_000 ? "nanometer" : "millimeter";
}

export class MeshStore {
  private readonly vertices: Float32Array;
  /** Three int32 cell-local rows per face, object by object. */
  private readonly faces: Int32Array;
  private readonly vertexCounts: number[];
  private readonly faceCounts: number[];
  private readonly offset: number[];
  private readonly chunk: number;
  private readonly lo: number[];
  private readonly hi: number[];
  private readonly columns: { name: string; values: Float32Array }[];
  private readonly directories: Set<string>;
  /** The file's vertex number of each stored vertex, object by object. */
  private readonly sourceVertex: Uint32Array;
  /** Each map's values in stored order, made when first asked for (a series' map, for the time point it was made at). */
  private readonly attributeBytes = new Map<string, Promise<Uint8Array>>();
  /** The stored vertices by place, for the vertex nearest a point; made when first asked for. */
  private grid: VertexGrid | undefined;
  /** Each parcellation's codes by the file's vertex numbers, and its labels, read when first asked for. */
  private readonly parcellations = new Map<string, Promise<{ values: Float32Array; labels: SurfaceLabel[] }>>();
  readonly count: number;

  /**
   * `companions`: a surface's values on its vertices (served as vertex
   * attributes, the first `DEFAULT_MAPS` declared, any asked for by name)
   * and its sibling surfaces, both described in `headers/surface` as
   * zarr-vectors-tools writes a surface store's header.
   */
  constructor(
    mesh: MeshData,
    readonly name: string,
    private readonly companions: SurfaceCompanions = { maps: [], surfaces: {}, skipped: [] },
  ) {
    const objects = mesh.objects.length;
    // Each object's vertices: those its faces use, in file order (an object's own copy where groups share one).
    const used = Array.from({ length: objects }, () => new Map<number, number>());
    const facesOf = Array.from({ length: objects }, () => [] as number[]);
    for (let t = 0; t < mesh.triangleObject.length; ++t) facesOf[mesh.triangleObject[t]].push(t);
    for (let o = 0; o < objects; ++o) {
      const indices = new Set<number>();
      for (const t of facesOf[o]) for (let k = 0; k < 3; ++k) indices.add(mesh.triangles[3 * t + k]);
      [...indices].sort((a, b) => a - b).forEach((v, row) => used[o].set(v, row));
    }
    // A mesh file with vertices but no faces (a point cloud) keeps its vertices as one object.
    if (mesh.triangles.length === 0) for (let v = 0; v < mesh.positions.length / 3; ++v) used[0].set(v, v);
    this.vertexCounts = used.map((m) => m.size);
    this.faceCounts = facesOf.map((f) => f.length);
    const totalVertices = this.vertexCounts.reduce((a, b) => a + b, 0);
    const world = new Float64Array(3 * totalVertices);
    this.sourceVertex = new Uint32Array(totalVertices);
    let base = 0;
    for (let o = 0; o < objects; ++o) {
      for (const [v, row] of used[o]) {
        for (let k = 0; k < 3; ++k) world[3 * (base + row) + k] = mesh.positions[3 * v + k];
        this.sourceVertex[base + row] = v;
      }
      base += this.vertexCounts[o];
    }
    const lo = [0, 1, 2].map((k) => {
      let m = Infinity;
      for (let i = k; i < world.length; i += 3) m = Math.min(m, world[i]);
      return Number.isFinite(m) ? m : 0;
    });
    // Moved to start at the cell's corner, so one cell holds it however it sits about the origin.
    this.offset = lo.map((v) => Math.floor(v));
    this.vertices = new Float32Array(world.length);
    for (let i = 0; i < world.length; ++i) this.vertices[i] = world[i] - this.offset[i % 3];
    this.lo = [0, 1, 2].map((k) => {
      let m = Infinity;
      for (let i = k; i < this.vertices.length; i += 3) m = Math.min(m, this.vertices[i]);
      return Number.isFinite(m) ? m : 0;
    });
    this.hi = [0, 1, 2].map((k) => {
      let m = -Infinity;
      for (let i = k; i < this.vertices.length; i += 3) m = Math.max(m, this.vertices[i]);
      return Number.isFinite(m) ? m : 0;
    });
    // The smallest power of two past every coordinate (strictly: hi == C would be the next cell).
    this.chunk = 1;
    while (this.chunk <= Math.max(...this.hi)) this.chunk *= 2;
    this.faces = new Int32Array(3 * facesOf.reduce((n, f) => n + f.length, 0));
    let at = 0;
    base = 0;
    const area = new Float32Array(objects);
    for (let o = 0; o < objects; ++o) {
      let sum = 0;
      for (const t of facesOf[o]) {
        const r = [0, 1, 2].map((k) => used[o].get(mesh.triangles[3 * t + k])!);
        for (let k = 0; k < 3; ++k) this.faces[at++] = base + r[k];
        const p = r.map((row) => [0, 1, 2].map((k) => world[3 * (base + row) + k]));
        const u = [0, 1, 2].map((k) => p[1][k] - p[0][k]);
        const w = [0, 1, 2].map((k) => p[2][k] - p[0][k]);
        sum += 0.5 * Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
      }
      area[o] = sum;
      base += this.vertexCounts[o];
    }
    this.count = objects;
    this.columns = [
      { name: "n_vertices", values: Float32Array.from(this.vertexCounts) },
      { name: "n_faces", values: Float32Array.from(this.faceCounts) },
      { name: "area", values: area },
    ];
    this.directories = new Set();
    const surface = this.hasHeader ? ["headers/surface"] : [];
    const attributes = this.declared.map((m) => `0/vertex_attributes/${m.name}`);
    for (const path of ["0/vertices", "0/vertex_fragments", "0/link_fragments", "0/links/0/0.0.0_0.0.0", "0/object_index/manifests", "0/object_index/object_ids", ...this.columns.map((c) => `0/object_attributes/${c.name}`), ...attributes, ...surface]) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; ++i) this.directories.add(parts.slice(0, i).join("/"));
    }
  }

  /** The maps a reader shows without being asked: the first few (the reader takes at most that many by default). */
  private get declared(): SurfaceMap[] {
    return this.companions.maps.slice(0, DEFAULT_MAPS);
  }

  private get hasHeader(): boolean {
    return this.companions.maps.length > 0 || Object.keys(this.companions.surfaces).length > 1;
  }

  /** A map's values in stored vertex order, NaN where the file has none. */
  private attribute(map: SurfaceMap): Promise<Uint8Array> {
    const key = map.version === undefined ? map.name : `${map.name}@${map.version()}`;
    let bytes = this.attributeBytes.get(key);
    if (bytes === undefined) {
      // A series' map keeps only the time point asked for last.
      if (map.version !== undefined) for (const old of this.attributeBytes.keys()) if (old.startsWith(`${map.name}@`)) this.attributeBytes.delete(old);
      bytes = map.load().then(({ values }) => {
        const out = new Float32Array(this.sourceVertex.length);
        for (let i = 0; i < out.length; ++i) {
          const v = this.sourceVertex[i];
          out[i] = v < values.length ? values[v] : Number.NaN;
        }
        return element(bytesOf(out));
      });
      this.attributeBytes.set(key, bytes);
      bytes.catch(() => this.attributeBytes.delete(key));
    }
    return bytes;
  }

  /**
   * A message from the page (`WorkspaceApi.local.send`) about a series
   * (`series`, its map's name):
   *
   * - `{ series, time }` chooses the time point the series' map serves;
   *   without `time`, nothing changes.  Answers the series as it is then:
   *   `{ series, time, count }`.  The page then has the viewer read the map
   *   again (`ViewerApi.reloadData`).
   * - `{ series, nearest: [x, y, z], within? }` finds the vertex nearest a
   *   point in the store's coordinates (as `0/vertices` holds them: the
   *   file's, less `coordinate_offset`; the layer's source coordinates),
   *   if one is within `within` of it.  Answers `{ series, vertex,
   *   distance, position }` (the vertex as the surface file numbers it, its
   *   position in the store's coordinates), or `{ series, vertex: null }`.
   * - `{ series, vertex }` answers that vertex's values at every time point:
   *   `{ series, vertex, values }` (a Float32Array, NaN where the file has
   *   none for it, as on the medial wall).
   * - `{ series, parcellations: true }` answers the surface's parcellations
   *   (its `.annot`, `.label` and CIFTI dlabel maps): `{ series,
   *   parcellations: [{ name, labels: [{ code, name, rgba, vertices }],
   *   codes }] }`, `codes` each vertex's label code (a Float32Array by the
   *   surface file's vertex numbers), `vertices` how many have the label.
   * - `{ series, parcellation?, parcel }` answers the mean and standard
   *   deviation (n - 1) over the vertices with label `parcel` (its code, or
   *   its name) in `parcellation` (the first if not named) at every time
   *   point: `{ series, parcellation, parcel, name, vertices, mean, sd }`
   *   (Float32Arrays; `vertices` how many have values in the series).
   */
  message(body: unknown): unknown {
    const { series: name, time, nearest, within, vertex, parcellations, parcellation, parcel } = (body ?? {}) as {
      series?: unknown;
      time?: unknown;
      nearest?: unknown;
      within?: unknown;
      vertex?: unknown;
      parcellations?: unknown;
      parcellation?: unknown;
      parcel?: unknown;
    };
    const series = this.companions.series?.find((s) => s.map.name === name);
    if (series === undefined) throw new Error(`no time series ${String(name)} on this surface`);
    if (parcellations === true) {
      const maps = this.companions.maps.filter((m) => m.parcellation);
      return Promise.all(
        maps.map(async (m) => {
          const { values, labels } = await this.parcellation(m);
          const counts = new Map<number, number>();
          for (const v of values) if (Number.isFinite(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
          return { name: m.name, labels: labels.map((l) => ({ ...l, vertices: counts.get(l.code) ?? 0 })), codes: values };
        }),
      ).then((list) => ({ series: series.map.name, parcellations: list }));
    }
    if (parcel !== undefined) {
      const map = parcellation === undefined ? this.companions.maps.find((m) => m.parcellation) : this.companions.maps.find((m) => m.parcellation && m.name === parcellation);
      if (map === undefined) throw new Error(parcellation === undefined ? "this surface has no parcellation" : `no parcellation ${String(parcellation)} on this surface`);
      return this.parcellation(map).then(async ({ values, labels }) => {
        const label = labels.find((l) => l.code === parcel || l.name === parcel) ?? (typeof parcel === "number" ? { code: parcel, name: String(parcel) } : undefined);
        if (label === undefined) throw new Error(`no label ${String(parcel)} in ${map.name}`);
        const vertices: number[] = [];
        values.forEach((v, i) => v === label.code && vertices.push(i));
        const { mean, sd, count } = await series.parcel(vertices);
        return { series: series.map.name, parcellation: map.name, parcel: label.code, name: label.name, vertices: Math.max(0, ...count), mean, sd };
      });
    }
    if (nearest !== undefined) {
      const point = Array.isArray(nearest) && nearest.length === 3 ? nearest.map(Number) : [];
      if (point.length !== 3 || !point.every(Number.isFinite)) throw new Error("nearest takes a point [x, y, z]");
      const limit = within === undefined ? Infinity : Number(within);
      if (!(limit >= 0)) throw new Error("within takes a distance");
      const found = (this.grid ??= new VertexGrid(this.vertices)).nearest(point, limit);
      if (found === undefined) return { series: series.map.name, vertex: null };
      const position = Array.from(this.vertices.subarray(3 * found.index, 3 * found.index + 3));
      return { series: series.map.name, vertex: this.sourceVertex[found.index], distance: found.distance, position };
    }
    if (vertex !== undefined) {
      if (!Number.isInteger(vertex)) throw new Error(`vertex ${String(vertex)} is not a vertex number`);
      return series.course(vertex as number).then((values) => ({ series: series.map.name, vertex, values }));
    }
    if (time !== undefined) {
      if (!(Number.isInteger(time) && (time as number) >= 0 && (time as number) < series.count)) throw new Error(`time point ${String(time)} is outside 0–${series.count - 1}`);
      series.time = time as number;
    }
    return { series: series.map.name, time: series.time, count: series.count };
  }

  /** A parcellation's codes and labels (a map without a table names each code by its number). */
  private parcellation(map: SurfaceMap): Promise<{ values: Float32Array; labels: SurfaceLabel[] }> {
    let p = this.parcellations.get(map.name);
    if (p === undefined) {
      p = map.load().then(({ values, labels }) => {
        if (labels !== undefined) return { values, labels };
        const codes = [...new Set(Array.from(values).filter(Number.isFinite))].sort((a, b) => a - b);
        return { values, labels: codes.map((code) => ({ code, name: String(code), rgba: [0.5, 0.5, 0.5, 1] as [number, number, number, number] })) };
      });
      this.parcellations.set(map.name, p);
      p.catch(() => this.parcellations.delete(map.name));
    }
    return p;
  }

  /**
   * The surface header as zarr-vectors-tools writes it (`headers/surface`:
   * scalars, label tables), with what only a store made from files can say:
   * the hemisphere's other surfaces (`surfaces`, store URLs relative to this
   * one), every map that can be asked for by name (`maps`), and the time
   * series served a time point at a time (`time_series`: by map name, the
   * file, time points, the first one's time, the step and its unit).
   */
  private async header(): Promise<Record<string, unknown>> {
    const { maps, surfaces } = this.companions;
    const tables: Record<string, unknown> = {};
    await Promise.all(
      maps
        .filter((m) => m.parcellation)
        .map(async (m) => {
          const labels = (await m.load().catch(() => undefined))?.labels;
          if (labels !== undefined) tables[m.name] = labelTable(labels);
        }),
    );
    const own = Object.entries(surfaces).find(([, path]) => path === this.fileName)?.[0];
    const hemi = /^(lh|rh)\./i.exec(this.fileName)?.[1] ?? /(?:^|[._-])(?:hemi-)?(L|R)(?=[._-])/.exec(this.fileName)?.[1];
    return {
      format_name: "surface",
      source: /\.gii$/i.test(this.fileName) ? "gifti" : "freesurfer",
      geometry: own ?? this.name,
      hemispheres:
        hemi === undefined
          ? []
          : [{ object_id: 1, hemisphere: /^l/i.test(hemi) ? "left" : "right", n_vertices: this.sourceVertex.length, n_faces: this.faces.length / 3 }],
      scalars: Object.fromEntries(maps.filter((m) => !m.parcellation).map((m) => [m.name, m.source])),
      label_tables: tables,
      surfaces: Object.fromEntries(Object.entries(surfaces).map(([kind, path]) => [kind, `../${path}/`])),
      maps: maps.map((m) => m.name),
      ...(this.companions.series?.length
        ? { time_series: Object.fromEntries(this.companions.series.map((s) => [s.map.name, { source: s.map.source, n_time_points: s.count, start: s.start, step: s.step, unit: s.unit }])) }
        : {}),
    };
  }

  /** The surface file's own name (lh.white), for the header. */
  get fileName(): string {
    return this.companions.fileName ?? this.name;
  }

  /** Child names (directories end in "/") of a directory key ("" or ending in "/"); undefined when it is not one. */
  list(prefix: string): string[] | undefined {
    const dir = prefix.replace(/\/$/, "");
    if (dir !== "" && !this.directories.has(dir)) return undefined;
    const base = dir === "" ? "" : `${dir}/`;
    const names = new Set<string>(["zarr.json"]);
    for (const d of this.directories) {
      if (d === dir || !d.startsWith(base)) continue;
      names.add(`${d.slice(base.length).split("/")[0]}/`);
    }
    return [...names].sort();
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const extent = Math.max(...this.hi.map((h, k) => h - this.lo[k]));
    const c = this.chunk;
    switch (key) {
      case "zarr.json":
        return json(
          group({
            zarr_vectors: {
              zv_version: "0.9.3",
              format_capabilities: ["fragment_link_groups"],
              chunk_shape: [c, c, c],
              bounds: [this.lo, this.hi],
              coordinate_offset: this.offset,
              geometry_types: ["mesh"],
              ...(this.declared.length > 0 ? { attribute_specs: { vertex: Object.fromEntries(this.declared.map((m) => [m.name, { dtype: "float32" }])) } } : {}),
              links_convention: "explicit",
              object_index_convention: "standard",
              cross_chunk_strategy: "explicit_links",
            },
            multiscales: [
              {
                version: "0.4",
                name: this.name,
                axes: ["x", "y", "z"].map((n) => ({ name: n, type: "space", unit: meshUnit(extent) })),
                datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1] }, { type: "translation", translation: [c / 2, c / 2, c / 2] }] }],
                metadata: { format: "zarr_vectors" },
              },
            ],
          }),
        );
      case "0/zarr.json":
        return json(
          group({
            zarr_vectors_level: {
              level: 0,
              vertex_count: this.vertices.length / 3,
              arrays_present: ["vertices", "links", "object_index", ...(this.declared.length > 0 ? ["vertex_attributes"] : [])],
              object_sparsity: 1,
              coarsening_method: "none",
              parent_level: null,
              fragments_tile: true,
              fragment_link_groups: true,
            },
          }),
        );
      case "0/vertices/zarr.json":
        return json(perCell({ zv_array: "vertices", dtype: "float32", encoding: "raw" }));
      case "0/vertex_fragments/zarr.json":
        return json(perCell({ zv_array: "vertex_fragments", encoding: "fragment_index_v1" }));
      case "0/link_fragments/zarr.json":
        return json(perCell({ zv_array: "link_fragments", encoding: "fragment_index_v1" }));
      case "0/links/0/zarr.json": {
        const n = this.faces.length / 3;
        return json(group({ zv_array: "links_family", level_delta: 0, link_width: 3, directed: false, store: "canonical", sid_ndim: 3, num_links: n, num_physical_records: n }));
      }
      case "0/links/0/0.0.0_0.0.0/zarr.json":
        return json(perCell({ zv_array: "links", dtype: "int32", offsets: [[0, 0, 0], [0, 0, 0]], has_perm: false, link_width: 3, level_delta: 0 }));
      case "0/object_index/zarr.json":
        return json(group({ zv_array: "object_index", num_objects: this.count, num_present: this.count, sid_ndim: 3, layout: "vlen_manifests_v2", object_ids_sorted: true }));
      case "0/object_index/manifests/zarr.json":
        return json(column(this.count, MANIFEST_ROWS, "variable_length_bytes", ""));
      case "0/object_index/object_ids/zarr.json":
        return json(column(this.count, COLUMN_ROWS, "int64", 0));
      case "0/vertices/c/0/0/0":
        return element(bytesOf(this.vertices));
      case "0/vertex_fragments/c/0/0/0":
        return element(fragmentIndex(this.vertexCounts));
      case "0/link_fragments/c/0/0/0":
        return element(fragmentIndex(this.faceCounts));
      case "0/links/0/0.0.0_0.0.0/c/0/0/0":
        return element(bytesOf(this.faces));
    }
    if (this.hasHeader && key === "headers/zarr.json") return json(group());
    if (this.hasHeader && key === "headers/surface/zarr.json") return json(group(await this.header()));
    if (this.companions.maps.length > 0 && key === "0/vertex_attributes/zarr.json") return json(group());
    const attribute = /^0\/vertex_attributes\/([^/]+)\/(zarr\.json|c\/0\/0\/0)$/.exec(key);
    if (attribute !== null) {
      // Any map can be asked for by name (`#attributes=`), declared or not.
      const map = this.companions.maps.find((m) => m.name === attribute[1]);
      if (map === undefined) return undefined;
      if (attribute[2] === "zarr.json") return json(perCell({ zv_array: "attribute", name: map.name, dtype: "float32", row_shape: [] }));
      return this.attribute(map);
    }
    const columnJson = /^0\/object_attributes\/([^/]+)\/zarr\.json$/.exec(key);
    if (columnJson !== null && this.columns.some((col) => col.name === columnJson[1])) {
      return json(column(this.count, COLUMN_ROWS, "float32", "NaN", { zv_array: "object_attribute", name: columnJson[1], dtype: "float32", shape: [this.count], fill_sentinel_meaning: "absent" }));
    }
    if (/^0\/(links|object_attributes)\/zarr\.json$/.test(key)) return json(group());
    const chunk = /^0\/(object_index\/manifests|object_index\/object_ids|object_attributes\/[^/]+)\/c\/(\d+)$/.exec(key);
    if (chunk === null) return undefined;
    const first = Number(chunk[2]) * (chunk[1] === "object_index/manifests" ? MANIFEST_ROWS : COLUMN_ROWS);
    if (first >= this.count) return undefined;
    if (chunk[1] === "object_index/manifests") {
      // Object o is fragment o of cell (0, 0, 0): u32 1 block, int64 x3 cell, u8 mode 0, int64 fragment.
      const rows = Math.min(MANIFEST_ROWS, this.count - first);
      const out = new Uint8Array(4 + 4 * MANIFEST_ROWS + rows * 37);
      const view = new DataView(out.buffer);
      view.setUint32(0, MANIFEST_ROWS, true);
      let at = 4;
      for (let r = 0; r < MANIFEST_ROWS; ++r) {
        if (r >= rows) {
          view.setUint32(at, 0, true);
          at += 4;
          continue;
        }
        view.setUint32(at, 37, true);
        view.setUint32(at + 4, 1, true);
        view.setBigInt64(at + 8 + 25, BigInt(first + r), true);
        at += 4 + 37;
      }
      return out;
    }
    if (chunk[1] === "object_index/object_ids") {
      const ids = new BigInt64Array(COLUMN_ROWS);
      for (let i = 0; i < COLUMN_ROWS && first + i < this.count; ++i) ids[i] = BigInt(first + i + 1);
      return bytesOf(ids);
    }
    const values = this.columns.find((col) => `object_attributes/${col.name}` === chunk[1])?.values;
    if (values === undefined) return undefined;
    const out = new Float32Array(COLUMN_ROWS).fill(Number.NaN);
    out.set(values.subarray(first, first + COLUMN_ROWS));
    return bytesOf(out);
  }
}
