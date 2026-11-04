/**
 * Time series on surfaces: a CIFTI `.dtseries.nii` beside a GIFTI surface
 * opened from this computer.  The surface's store (src/virtual/vectors)
 * serves the series a time point at a time as one vertex attribute
 * (`<stem>_t`), lists it in its header (`headers/surface`, `time_series`),
 * and takes the time point in a message (`WorkspaceApi.local.send`); it
 * also finds the vertex nearest a point, answers a vertex's values at
 * every time point, its parcellations, a parcel's mean and SD at every
 * time point, and how far apart its vertices are.  Plain code, without
 * the page.
 */
import type { LayerTransform } from "@ngplatform/sdk";
import type { TimeAxis } from "./series.js";
import type { LayerMap } from "./space.js";

/** A series a surface's store serves, as its header describes it. */
export interface SurfaceSeries {
  /** The vertex attribute holding the values at the time point chosen. */
  name: string;
  /** The CIFTI file. */
  source: string;
  count: number;
  /** The first time point's time and the step, in `unit` ("second"). */
  start: number;
  step: number;
  unit: string;
}

/** The store a Zarr Vectors layer source reads ("…/lh.white.surf.gii/|zarr-vectors:#attributes=…" → "…/lh.white.surf.gii/"). */
export function zarrVectorsStore(source: string | undefined): string | undefined {
  if (source === undefined || !/\|zarr-vectors:/.test(source)) return undefined;
  const base = source.replace(/\|.*$/, "").replace(/^zarr-vectors:\/\//, "");
  if (!/^https?:\/\//.test(base)) return undefined;
  return base.endsWith("/") ? base : `${base}/`;
}

/** The time series a surface store's header (`headers/surface/zarr.json`) lists; none when it lists none. */
export function surfaceSeriesOf(headerJson: unknown): SurfaceSeries[] {
  const attributes = (headerJson as { attributes?: { time_series?: Record<string, unknown> } })?.attributes;
  const listed = attributes?.time_series;
  if (listed === undefined || typeof listed !== "object") return [];
  const out: SurfaceSeries[] = [];
  for (const [name, value] of Object.entries(listed)) {
    const v = value as { source?: unknown; n_time_points?: unknown; start?: unknown; step?: unknown; unit?: unknown };
    const count = Number(v.n_time_points);
    if (!(Number.isInteger(count) && count > 0)) continue;
    const step = Number(v.step);
    out.push({
      name,
      source: typeof v.source === "string" ? v.source : name,
      count,
      start: Number.isFinite(Number(v.start)) ? Number(v.start) : 0,
      step: Number.isFinite(step) && step !== 0 ? step : 1,
      unit: typeof v.unit === "string" ? v.unit : "",
    });
  }
  return out;
}

/** Units a CIFTI series may give, as the plot shows them. */
const LABELS: Record<string, string> = { second: "s", hertz: "Hz", meter: "m", radian: "rad" };

/** A surface series' time axis, as the plot and the transport use it (no dimension of the views: `dim` and `input` are -1). */
export function surfaceAxis(series: SurfaceSeries): TimeAxis {
  return { count: series.count, dim: -1, input: -1, start: series.start, step: series.step, unit: { label: LABELS[series.unit] ?? series.unit, seconds: 1 } };
}

/** How near a vertex the pointer must be for that vertex's time course to be plotted, in millimetres, when the store does not say how far apart its vertices are. */
export const VERTEX_REACH_MM = 4;

/** How near a vertex the pointer must be, in the surface's median edge lengths. */
export const REACH_EDGES = 3;

/**
 * How near a vertex the pointer must be, in the store's coordinates: three
 * of the surface's median edge lengths (so a coarse mesh, fsaverage5's
 * 4–5 mm edges say, leaves no gaps between its vertices, and a fine one
 * does not reach past its neighbours), else VERTEX_REACH_MM.
 */
export function vertexReach(medianEdge: number | undefined, transform: LayerTransform): number {
  return medianEdge !== undefined && medianEdge > 0 ? REACH_EDGES * medianEdge : storeDistance(transform, VERTEX_REACH_MM);
}

/** A parcellation a surface's store has: its labels (how many vertices each) and each vertex's code. */
export interface Parcellation {
  name: string;
  labels: { code: number; name: string; vertices: number }[];
  /** Each vertex's label code, by the surface file's vertex numbers. */
  codes: Float32Array;
}

/** The store's answer to `{ series, parcellations: true }`: those with a label on some vertex. */
export function parcellationsOf(answer: unknown): Parcellation[] {
  const list = (answer as { parcellations?: unknown })?.parcellations;
  if (!Array.isArray(list)) return [];
  const out: Parcellation[] = [];
  for (const p of list as { name?: unknown; labels?: unknown; codes?: unknown }[]) {
    if (typeof p?.name !== "string" || !(p.codes instanceof Float32Array) || !Array.isArray(p.labels)) continue;
    const labels = (p.labels as { code?: unknown; name?: unknown; vertices?: unknown }[])
      .filter((l) => typeof l?.code === "number" && typeof l.name === "string" && Number(l.vertices) > 0)
      .map((l) => ({ code: l.code as number, name: l.name as string, vertices: Number(l.vertices) }));
    if (labels.length > 0) out.push({ name: p.name, labels, codes: p.codes });
  }
  return out;
}

/** The label a vertex has in a parcellation, if any. */
export function parcelAt(parcellation: Parcellation, vertex: number): { code: number; name: string } | undefined {
  const code = parcellation.codes[vertex];
  return parcellation.labels.find((l) => l.code === code);
}

/** The store's answer to `{ series, parcellation, parcel }`: the parcel's mean and SD at every time point. */
export function parcelCourseOf(answer: unknown): { mean: Float32Array; sd: Float32Array; vertices: number; name: string } | undefined {
  const a = answer as { mean?: unknown; sd?: unknown; vertices?: unknown; name?: unknown } | undefined;
  return a?.mean instanceof Float32Array && a.sd instanceof Float32Array ? { mean: a.mean, sd: a.sd, vertices: Number(a.vertices) || 0, name: String(a.name ?? "") } : undefined;
}

/** A parcel as the legend names it: "precentral (aparc mean)" (its SD is the band around it). */
export function parcelLabel(name: string, parcellation: string): string {
  return `${name} (${parcellation} mean)`;
}

/**
 * `mm` millimetres as a distance in a surface layer's source coordinates
 * (its store's: the surface file's, less `coordinate_offset`), from the
 * scale of its first dimension; a source without a unit in metres is taken
 * to count millimetres.
 */
export function storeDistance(transform: LayerTransform, mm: number): number {
  const scale = transform.input.scales[0];
  return transform.input.units[0] === "m" && scale > 0 ? (mm * 1e-3) / scale : mm;
}

/**
 * The point in a surface store's coordinates at a position in the views'
 * space: through the inverse of the layer's transform (`map`), which holds
 * the store's `coordinate_offset` and any move made since.  Undefined when
 * the transform has no inverse.
 */
export function storePoint(map: LayerMap, position: ArrayLike<number>): number[] | undefined {
  const point = map.toInput(position)?.slice(0, 3);
  return point !== undefined && point.length === 3 && point.every(Number.isFinite) ? point : undefined;
}

/** The store's answer to `{ series, nearest }`: the vertex, or undefined when none is near enough. */
export function nearestOf(answer: unknown): { vertex: number; distance: number } | undefined {
  const a = answer as { vertex?: unknown; distance?: unknown } | undefined;
  return Number.isInteger(a?.vertex) && typeof a?.distance === "number" ? { vertex: a.vertex as number, distance: a.distance } : undefined;
}

/** A vertex as the legend names it. */
export function vertexLabel(vertex: number): string {
  return `vertex ${vertex}`;
}
