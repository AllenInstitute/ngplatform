/** Which image sources the volume view reads, kept apart from the readers so the main thread loads no decoders. */
import { precomputedUrl } from "@ngplatform/sdk/sources";

export { precomputedUrl };

/** A store given to the reader as `precomputed:<url>` is a Neuroglancer precomputed image; others are OME-Zarr. */
export const PRECOMPUTED = "precomputed:";

/** The OME-Zarr store an image layer's source names, as an http(s) URL; undefined for other formats. */
export function omeZarrUrl(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  let url = source.trim();
  const scheme = /^(zarr2?|zarr3):\/\//i.exec(url);
  const pipe = /\|zarr[23]?:?[^|]*$/i.exec(url);
  if (scheme === null && pipe === null && !/\.ome\.zarr\/?$/i.test(url)) return undefined;
  if (scheme) url = url.slice(scheme[0].length);
  if (pipe) url = url.slice(0, pipe.index);
  url = url.replace(/^gs:\/\/([^/]+)\//, "https://storage.googleapis.com/$1/").replace(/^s3:\/\/([^/]+)\//, "https://$1.s3.amazonaws.com/");
  if (!/^https?:\/\//.test(url) && !url.startsWith("/")) return undefined;
  return url.endsWith("/") ? url : `${url}/`;
}

/** The store the reader opens for an image layer: an OME-Zarr URL or `precomputed:<url>`; undefined for formats it does not read. */
export function storeOf(source: string | undefined): string | undefined {
  const pre = precomputedUrl(source);
  return pre !== undefined ? PRECOMPUTED + pre : omeZarrUrl(source);
}
