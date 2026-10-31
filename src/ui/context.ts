/** Context-key helpers. */

const FORMATS = ["zarr-vectors", "precomputed", "zarr3", "zarr2", "zarr", "n5", "nifti", "deepzoom", "graphene", "boss", "dvid", "render", "vtk", "obj", "ngauth"];

/**
 * The data format a source URL names: "zarr-vectors", "precomputed", "zarr",
 * "nifti"…, from its scheme (`precomputed://…`) or its last adapter
 * (`…|zarr-vectors:`).  Undefined when the URL leaves it to detection.
 */
export function contextKeyFor(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const adapters = [...url.matchAll(/\|([a-z][a-z0-9-]*):/gi)].map((m) => m[1].toLowerCase());
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1].toLowerCase();
  for (const candidate of [...adapters.reverse(), scheme]) {
    if (candidate !== undefined && FORMATS.includes(candidate)) return candidate;
  }
  if (/\.zarrvectors\/?($|\|)/i.test(url)) return "zarr-vectors";
  if (/\.nii(\.gz)?$/i.test(url)) return "nifti";
  return undefined;
}
