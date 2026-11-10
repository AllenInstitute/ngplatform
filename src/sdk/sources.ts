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

/** The sign-in a data source's reads need, as its URL's scheme says. */
export type SourceSignInNeed = { kind: "google" } | { kind: "middleauth"; app: string } | { kind: "ngauth"; server: string; bucket: string };

/**
 * Where a segmentation's meshes are read from: `volume`, the volume's
 * http(s) URL ending in "/" (`graphene+https://…/` for a graphene one,
 * whose manifests come from its meshing server), and the sign-in its reads
 * need, if any.  For `precomputed://` and `graphene://` sources, with the
 * sign-in schemes Neuroglancer takes: `gs+google://` (read through the
 * app's own signed-in route under `base`, `gcs-google/`),
 * `gs+ngauth+https://server/`, and `middleauth+https://`.  Undefined for
 * other sources.
 */
export function meshSourceOf(source: string | undefined, base: string = defaultBase()): { volume: string; signIn?: SourceSignInNeed } | undefined {
  const m = /^(precomputed|graphene):\/\/(.+)$/i.exec(source?.trim() ?? "");
  if (m === null) return undefined;
  const graphene = m[1].toLowerCase() === "graphene";
  let url = m[2].replace(/\|.*$/, "");
  let signIn: SourceSignInNeed | undefined;
  let g: RegExpExecArray | null;
  if ((g = /^gs\+google:\/\/(.+)$/.exec(url)) !== null) {
    url = `${base}gcs-google/${g[1]}`;
    signIn = { kind: "google" };
  } else if ((g = /^gs\+ngauth\+(https?:\/\/[^/]+)\/([^/]+)\/?(.*)$/.exec(url)) !== null) {
    url = `https://storage.googleapis.com/${g[2]}/${g[3]}`;
    signIn = { kind: "ngauth", server: g[1], bucket: g[2] };
  } else if ((g = /^middleauth\+(https?:\/\/.+)$/.exec(url)) !== null) {
    url = g[1];
    signIn = { kind: "middleauth", app: new URL(url).origin };
  }
  url = url.replace(/^gs:\/\/([^/]+)\/?/, "https://storage.googleapis.com/$1/").replace(/^s3:\/\/([^/]+)\/?/, "https://$1.s3.amazonaws.com/");
  if (!/^https?:\/\//.test(url)) return undefined;
  if (!url.endsWith("/")) url = `${url}/`;
  return { volume: graphene ? `graphene+${url}` : url, ...(signIn ? { signIn } : {}) };
}

/** The app's base URL (where its signed-in routes are), or none outside a page. */
function defaultBase(): string {
  const href = (globalThis as { location?: { href?: string } }).location?.href;
  return href === undefined ? "/" : new URL(".", href).href;
}
