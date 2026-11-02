/** Which image sources the volume view reads, kept apart from the readers so the main thread loads no decoders. */

/** A store given to the reader as `precomputed:<url>` is a Neuroglancer precomputed image; others are OME-Zarr. */
export const PRECOMPUTED = "precomputed:";

/** The http(s) URL, ending in "/", of a `precomputed://` source; undefined for other sources. */
export function precomputedUrl(source: string | undefined): string | undefined {
  const m = /^precomputed:\/\/(.+)$/i.exec(source?.trim() ?? "");
  if (m === null) return undefined;
  let url = m[1].replace(/\|.*$/, "");
  url = url.replace(/^gs:\/\/([^/]+)\/?/, "https://storage.googleapis.com/$1/").replace(/^s3:\/\/([^/]+)\/?/, "https://$1.s3.amazonaws.com/");
  if (!/^https?:\/\//.test(url)) return undefined;
  return url.endsWith("/") ? url : `${url}/`;
}
