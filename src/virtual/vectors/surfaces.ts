/**
 * A surface's companions: the files beside it that hold values on its
 * vertices (FreeSurfer's `surf/lh.thickness`, `../label/lh.aparc.annot`,
 * GIFTI shape and label files) and the other surfaces of the same
 * hemisphere (lh.pial beside lh.white).
 *
 * Local data finds them once per surface (`surfaceRelated`, by name only,
 * nothing read) and hands them to the worker with each request, unread; the
 * worker's store reads what it is asked for (`SurfaceMaps`): a few bytes of
 * each to check its vertex count when the store opens, a file's values when
 * that attribute is first asked for.
 */
import { gunzipHead, isGzip } from "../images/store.js";
import { MGH_HEADER } from "../images/mgh.js";
import { FREESURFER_SURFACE } from "./mesh_files.js";
import {
  annotCount,
  combineLabels,
  giftiCount,
  mghCount,
  morphCount,
  parseAnnot,
  parseGiftiValues,
  parseLabelVertices,
  parseMghValues,
  parseMorph,
  type SurfaceLabel,
  type SurfaceValues,
} from "./surface_values.js";

/** Surfaces offered to switch between, in Freeview's order. */
export const SURFACE_KINDS = ["white", "pial", "inflated", "sphere", "orig", "smoothwm", "midthickness"];

/** A FreeSurfer surface's hemisphere and kind ("lh", "white"), or undefined. */
export function freeSurferSurface(name: string): { hemi: string; kind: string } | undefined {
  if (!FREESURFER_SURFACE.test(name)) return undefined;
  const dot = name.indexOf(".");
  return { hemi: name.slice(0, dot).toLowerCase(), kind: name.slice(dot + 1) };
}

/** Files beside a FreeSurfer surface that are not values on it. */
const NOT_VALUES = /\.(patch|reg|nofix|dat|lta|xfm|txt|log|json|stats|ctab|gii|nii|nii\.gz|mgz|mgh|annot|label)$|^[lr]h\.(defect_|.*\.(patch|reg)\b)/i;

/** A GIFTI file's hemisphere, from the usual spellings (hemi-L, .L., _lh_, lh.). */
function giftiHemisphere(name: string): string | undefined {
  const m = /(?:^|[._-])(?:hemi-)?(L|R|lh|rh|left|right)(?=[._-])/i.exec(name);
  return m === null ? undefined : m[1][0].toUpperCase();
}

const join = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`);
const parentOf = (dir: string) => (dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "");

/**
 * The files a surface's store reads besides the surface, as paths relative
 * to the surface's folder: for a FreeSurfer surface the same hemisphere's
 * morphometry, overlays and other surfaces in its folder, and its
 * annotations and labels in `../label` (or the same folder); for a GIFTI
 * surface the same hemisphere's other GIFTI files in its folder.
 * `list(folder)` names the files in a folder (a path from the root).
 */
export async function surfaceRelated(path: string, list: (folder: string) => Promise<string[]>): Promise<string[]> {
  const name = path.split("/").pop()!;
  const dir = path.slice(0, path.length - name.length).replace(/\/$/, "");
  const here = (await list(dir)).filter((f) => f !== name);
  const fs = freeSurferSurface(name);
  if (fs !== undefined) {
    const prefix = `${fs.hemi}.`;
    const out = here.filter((f) => f.toLowerCase().startsWith(prefix) && (FREESURFER_SURFACE.test(f) || !NOT_VALUES.test(f) || /\.(mgh|mgz|annot|label)$/i.test(f)));
    const labelDir = /(^|\/)surf$/.test(dir) ? join(parentOf(dir), "label") : undefined;
    if (labelDir !== undefined) {
      for (const f of await list(labelDir)) {
        if (f.toLowerCase().startsWith(prefix) && /\.(annot|label)$/i.test(f)) out.push(`../label/${f}`);
      }
    }
    return out;
  }
  if (/\.gii$/i.test(name)) {
    const hemi = giftiHemisphere(name);
    return here.filter((f) => /\.gii$/i.test(f) && (hemi === undefined || giftiHemisphere(f) === hemi));
  }
  return [];
}

/** A map of values on the surface's vertices, read when first asked for. */
export interface SurfaceMap {
  /** Its attribute name (GLSL-friendly: letters, digits, _). */
  name: string;
  /** The file (or files) it comes from, for the header. */
  source: string;
  /** A parcellation (its codes name labels), not a continuous value. */
  parcellation: boolean;
  load(): Promise<SurfaceValues>;
}

const MAP_ORDER = ["curv", "sulc", "thickness", "area", "aparc", "aparc_a2009s", "labels", "volume"];
/** Maps exposed without being asked for (the reader shows at most 8 by default). */
export const DEFAULT_MAPS = 8;

function attributeName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  // Shader names start with a lower-case letter (BA becomes ba).
  if (/^[A-Z]/.test(s)) s = s.toLowerCase();
  if (!/^[a-z]/.test(s)) s = `m_${s}`;
  return s;
}

async function head(file: Blob, n: number): Promise<Uint8Array> {
  const start = new Uint8Array(await file.slice(0, n).arrayBuffer());
  return isGzip(start) ? gunzipHead(file, n) : start;
}

async function whole(file: Blob): Promise<Uint8Array> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isGzip(bytes)) return bytes;
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

function once<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
}

/** What a surface's store knows of its companions. */
export interface SurfaceCompanions {
  /** Every map with this surface's vertex count, the defaults first. */
  maps: SurfaceMap[];
  /** Other surfaces of the hemisphere, by kind, as paths relative to this one's folder. */
  surfaces: Record<string, string>;
  /** Files left out, and why. */
  skipped: string[];
  /** The surface's own file name. */
  fileName?: string;
}

/**
 * The maps among a surface's related files with `vertexCount` values each
 * (each checked by its first bytes), named as FreeSurfer names them
 * (thickness, aparc, aparc_a2009s; `labels` for the `.label` files
 * together), and the other surfaces of the hemisphere.
 */
export async function surfaceCompanions(surfaceName: string, related: Record<string, File>, vertexCount: number): Promise<SurfaceCompanions> {
  const maps: SurfaceMap[] = [];
  const surfaces: Record<string, string> = {};
  const skipped: string[] = [];
  const used = new Set<string>();
  const unique = (raw: string) => {
    let name = attributeName(raw);
    for (let i = 2; used.has(name); ++i) name = `${attributeName(raw)}_${i}`;
    used.add(name);
    return name;
  };
  const stem = (path: string) => path.split("/").pop()!.replace(/^(lh|rh)\./i, "");
  const labelFiles: [string, File][] = [];
  const own = freeSurferSurface(surfaceName);
  if (own !== undefined) surfaces[own.kind] = surfaceName;
  await Promise.all(
    Object.entries(related).map(async ([path, file]) => {
      const base = path.split("/").pop()!;
      try {
        const fs = freeSurferSurface(base);
        if (fs !== undefined) {
          if (SURFACE_KINDS.includes(fs.kind)) surfaces[fs.kind] = path;
          return;
        }
        if (/\.label$/i.test(base)) {
          labelFiles.push([path, file]);
          return;
        }
        if (/\.annot$/i.test(base)) {
          if (annotCount(await head(file, 4)) !== vertexCount) throw new Error("another vertex count");
          maps.push({ name: stem(path).replace(/\.annot$/i, ""), source: path, parcellation: true, load: once(async () => parseAnnot(await whole(file))) });
          return;
        }
        if (/\.mg[hz]$/i.test(base)) {
          if (mghCount(await head(file, MGH_HEADER)) !== vertexCount) throw new Error("another vertex count");
          maps.push({ name: stem(path).replace(/\.mg[hz]$/i, ""), source: path, parcellation: false, load: once(async () => parseMghValues(await whole(file))) });
          return;
        }
        if (/\.gii$/i.test(base)) {
          if (/\.surf\.gii$/i.test(base)) return;
          const start = new TextDecoder().decode(await head(file, 65536));
          if (!/<GIFTI[\s>]/.test(start) || /NIFTI_INTENT_POINTSET/.test(start)) return;
          if (giftiCount(start) !== vertexCount) throw new Error("another vertex count");
          const arrays = await parseGiftiValues(await file.text(), base.replace(/\.(shape|func|label|time)?\.gii$/i, "").replace(/(?:^|[._-])(?:hemi-)?(L|R|lh|rh|left|right)(?=[._-]|$)/gi, "").replace(/^[._-]+/, "") || "values");
          for (const a of arrays) maps.push({ name: a.name, source: path, parcellation: a.data.labels !== undefined, load: () => Promise.resolve(a.data) });
          return;
        }
        // Morphometry, the rest of a FreeSurfer hemisphere's files.
        if (morphCount(await head(file, 15)) !== vertexCount) throw new Error("not a morphometry file of this surface");
        maps.push({ name: stem(path), source: path, parcellation: false, load: once(async () => parseMorph(await whole(file))) });
      } catch (e) {
        skipped.push(`${path} (${e instanceof Error ? e.message : e})`);
      }
    }),
  );
  if (labelFiles.length > 0) {
    labelFiles.sort((a, b) => a[0].localeCompare(b[0]));
    maps.push({
      name: "labels",
      source: labelFiles.map(([p]) => p).join(", "),
      parcellation: true,
      load: once(async () =>
        combineLabels(
          vertexCount,
          await Promise.all(labelFiles.map(async ([p, f]) => ({ name: stem(p).replace(/\.label$/i, ""), vertices: parseLabelVertices(await f.text()) }))),
        ),
      ),
    });
  }
  const rank = (m: SurfaceMap) => {
    const i = MAP_ORDER.indexOf(attributeName(m.name));
    return i === -1 ? MAP_ORDER.length : i;
  };
  maps.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  for (const m of maps) m.name = unique(m.name);
  return { maps, surfaces, skipped, fileName: surfaceName };
}

/** A parcellation's table as zarr-vectors-tools writes it in `headers/surface`: code → name and colour. */
export function labelTable(labels: SurfaceLabel[]): Record<string, { name: string; rgba: number[] }> {
  return Object.fromEntries(labels.map((l) => [String(l.code), { name: l.name, rgba: l.rgba }]));
}
