/** What can be exported, and as what (see export_worker.ts). */

export type ImageFormat = "nii.gz" | "nii" | "mgz" | "mgh" | "zarr";
export type GeometryFormat = "trk" | "tck" | "obj" | "stl" | "ply" | "csv" | "graphml";
export type ExportFormat = ImageFormat | GeometryFormat;

/** What a file on this computer is, for exporting: by its name. */
export function exportKind(name: string): "image" | "streamlines" | "mesh" | "points" | "graph" | undefined {
  if (/\.(nii(\.gz)?|hdr|mg[hz]|npy|tiff?)$/i.test(name)) return "image";
  if (/\.(trk|tck|trx)$/i.test(name)) return "streamlines";
  if (/\.(obj|stl|ply|gii)$/i.test(name) || /^[lr]h\.[a-z0-9_.-]+$/i.test(name)) return "mesh";
  if (/\.graphml$/i.test(name) || /(^|[_\-. ])edges?\.(csv|tsv)$/i.test(name)) return "graph";
  if (/\.(csv|tsv|xyz|swc|las|laz|parquet|feather|arrow)$/i.test(name)) return "points";
  return undefined;
}
