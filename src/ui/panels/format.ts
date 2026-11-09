/** Formatting shared by the panels. */

export function fmt(n: number, digits = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** A data URL as a person reads it: gs:// for Google buckets, bundled files by name. */
export function shortSource(url: string): string {
  return url
    .replace(/^https:\/\/storage\.googleapis\.com\//, "gs://")
    .replace(/^.*\/examples\//, "bundled: examples/")
    .replace(/\|zarr-vectors:$/, " (zarr-vectors)");
}

/** A data URL by where it is and its file's name ("gs://bucket/…/brain.ome.zarr"), for a list; the whole URL goes in its tooltip. */
export function sourceName(url: string): string {
  const short = shortSource(url.replace(/^[a-z0-9+-]+:\/\/(?=[a-z0-9+-]+:\/\/)/i, "").replace(/\|.*$/, "")).replace(/\/+$/, "");
  const m = /^([a-z0-9+-]+:\/\/[^/]+)\/(.*\/)?([^/]+)$/i.exec(short);
  if (m === null) return short;
  return m[2] ? `${m[1]}/…/${m[3]}` : `${m[1]}/${m[3]}`;
}

const KINDS: Record<string, string> = {
  image: "image",
  segmentation: "segmentation",
  annotation: "annotations",
  mesh: "mesh",
  "single_mesh": "mesh",
  "zarr-vectors": "zarr-vectors",
  new: "loading",
  auto: "auto",
};

export function kindLabel(kind: string | undefined): string {
  if (kind === undefined) return "";
  return KINDS[kind] ?? kind.replace(/_/g, " ");
}

/** A coordinate in physical units, with a readable unit: [value, unit]. */
export function physical(value: number, unit: string, scale: number): [string, string] {
  if (unit === "m" && Number.isFinite(value)) {
    const metres = value * scale;
    const abs = Math.abs(metres);
    if (abs >= 1e-3 || abs === 0) return [fmt(metres * 1e3, 2), "mm"];
    if (abs >= 1e-6) return [fmt(metres * 1e6, 2), "µm"];
    return [fmt(metres * 1e9, 1), "nm"];
  }
  return [Number.isFinite(value) ? fmt(value, 2) : "–", unit || ""];
}

/** A length in metres, readably: "1.2 mm", "350 nm". */
export function length(metres: number): string {
  const abs = Math.abs(metres);
  if (!Number.isFinite(abs)) return "–";
  if (abs >= 1) return `${fmt(metres, 3)} m`;
  if (abs >= 1e-3) return `${fmt(metres * 1e3, 3)} mm`;
  if (abs >= 1e-6) return `${fmt(metres * 1e6, 3)} µm`;
  return `${fmt(metres * 1e9, 3)} nm`;
}
