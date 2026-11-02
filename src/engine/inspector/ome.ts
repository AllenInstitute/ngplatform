/**
 * An OME-Zarr image's own description of where it is, for the Source tab:
 * its coordinate systems (0.6, RFC-5: named spaces and their axes) and the
 * transforms between them, and each level's transform.  Read from the
 * store's `zarr.json` (0.5, 0.6) or `.zattrs` (0.4); Neuroglancer folds all
 * of this into the layer's one transform, which this shows the parts of.
 */

export interface OmeSummary {
  version: string;
  name?: string;
  systems: { name: string; axes: string }[];
  transforms: { from: string; to: string; what: string }[];
  levels: { path: string; what: string }[];
}

const short = (v: number) => (Number.isInteger(v) ? String(v) : String(+v.toPrecision(5)));
const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "number" ? short(x) : String(x))).join(", ") : "");

/** One transform, in a few words: "scale 2, 2, 2", "affine (3 × 4)", "sequence: scale …; translation …". */
export function describeTransform(t: any): string {
  if (t === null || typeof t !== "object") return "";
  switch (t.type) {
    case "identity":
      return "identity";
    case "scale":
      return t.scale !== undefined ? `scale ${list(t.scale)}` : `scale (${t.path ?? "from a file"})`;
    case "translation":
      return t.translation !== undefined ? `translation ${list(t.translation)}` : `translation (${t.path ?? "from a file"})`;
    case "affine": {
      const m = t.affine;
      if (!Array.isArray(m)) return `affine (${t.path ?? "from a file"})`;
      return Array.isArray(m[0]) ? `affine (${m.length} × ${m[0].length}): ${m.map((row: number[]) => `[${list(row)}]`).join(" ")}` : `affine ${list(m)}`;
    }
    case "rotation":
      return `rotation ${Array.isArray(t.rotation) ? t.rotation.map((row: number[]) => `[${list(row)}]`).join(" ") : ""}`;
    case "sequence":
      return `sequence: ${(t.transformations ?? []).map(describeTransform).join("; ")}`;
    case "mapAxis":
      return `map axes ${JSON.stringify(t.mapAxis ?? t.mapping ?? "")}`;
    default:
      return String(t.type ?? "unknown");
  }
}

const ref = (r: unknown) => (typeof r === "string" ? r : r && typeof r === "object" ? String((r as any).id ?? (r as any).name ?? "") : "");

/** The summary of a group's attributes (`zarr.json`'s `attributes`, or `.zattrs`); undefined when it is no OME image. */
export function summariseOme(attributes: any): OmeSummary | undefined {
  const ome = attributes?.ome ?? attributes;
  const ms = ome?.multiscales?.[0];
  if (ms === undefined) return undefined;
  const version = String(ome.version ?? ms.version ?? "0.4");
  const axisText = (axes: any[]) => (axes ?? []).map((a: any) => (typeof a === "string" ? a : `${a.name}${a.unit ? ` (${a.unit})` : ""}`)).join(", ");
  const systems: OmeSummary["systems"] = Array.isArray(ms.coordinateSystems)
    ? ms.coordinateSystems.map((c: any) => ({ name: String(c.name ?? c.id ?? ""), axes: axisText(c.axes) }))
    : ms.axes !== undefined
      ? [{ name: "(the image's axes)", axes: axisText(ms.axes) }]
      : [];
  const transforms: OmeSummary["transforms"] = (ms.coordinateTransformations ?? []).map((t: any) => ({ from: ref(t.input) || "levels", to: ref(t.output) || "physical", what: describeTransform(t) }));
  const levels: OmeSummary["levels"] = (ms.datasets ?? []).map((d: any) => ({ path: String(d.path), what: (d.coordinateTransformations ?? []).map(describeTransform).join("; ") }));
  return { version, name: ms.name, systems, transforms, levels };
}

/** Where a layer source's OME metadata is: its store's base URL (zarr://, zarr2://, zarr3://, gs://), or undefined. */
export function omeBase(url: string): string | undefined {
  const m = /^(zarr[23]?):\/\/(.+?)\/?(\|.*)?$/.exec(url.trim());
  if (m === null) return undefined;
  return m[2].replace(/^gs:\/\/([^/]+)\//, "https://storage.googleapis.com/$1/").replace(/\/$/, "");
}
