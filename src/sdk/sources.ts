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

/** A layer's first source as a URL, whatever form its spec gives it in (a string, a list, `{ url }`). */
export function layerSourceUrl(spec: unknown): string | undefined {
  const source = (spec as { source?: unknown } | undefined)?.source;
  const first = Array.isArray(source) ? source[0] : source;
  if (typeof first === "string") return first;
  const url = (first as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? url : undefined;
}
