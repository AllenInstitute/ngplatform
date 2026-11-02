/** Recognising data sources by their URL, for plugins (light: no readers). */

/** The http(s) URL, ending in "/", of a `precomputed://` source; undefined for other sources. */
export function precomputedUrl(source: string | undefined): string | undefined {
  const m = /^precomputed:\/\/(.+)$/i.exec(source?.trim() ?? "");
  if (m === null) return undefined;
  let url = m[1].replace(/\|.*$/, "");
  url = url.replace(/^gs:\/\/([^/]+)\/?/, "https://storage.googleapis.com/$1/").replace(/^s3:\/\/([^/]+)\/?/, "https://$1.s3.amazonaws.com/");
  if (!/^https?:\/\//.test(url)) return undefined;
  return url.endsWith("/") ? url : `${url}/`;
}
