/**
 * How a layer's data source signs in.  Neuroglancer picks credentials by
 * the scheme of a source's base address, so choosing a sign-in for a layer
 * is rewriting that address:
 *
 *   gs://bucket/path                        Google Cloud Storage, anonymous
 *   gs+google://bucket/path                 … with the Google sign-in of the Auth tab
 *   gs+ngauth+https://server/bucket/path    … with a token from an ngauth server
 *   https://host/path                       a web server, anonymous
 *   middleauth+https://host/path            … with a middleauth sign-in
 *
 * The rest of a source is kept: a `precomputed://` prefix in front, and
 * pipeline steps such as `|zarr3:` behind.  Pure functions of strings.
 */
import type { SourceSignIn } from "../sdk/types.js";

/** A source URL around its base address: `precomputed://` + `gs://b/p` + `|zarr3:`. */
export function splitSource(url: string): { prefix: string; base: string; rest: string } {
  const bar = url.indexOf("|");
  const first = bar === -1 ? url : url.slice(0, bar);
  const rest = bar === -1 ? "" : url.slice(bar);
  // A data source's name in front of another scheme's address (`zarr2://https://…`).
  const m = first.match(/^([a-z][a-z0-9+.-]*:\/\/)(?=[a-z][a-z0-9+.-]*:\/\/)/i);
  const prefix = m === null ? "" : m[1];
  return { prefix, base: first.slice(prefix.length), rest };
}

export const PUBLIC_GS: SourceSignIn = {
  id: "public",
  title: "None (public)",
  storage: "gs",
  wrap: (plain) => plain,
  unwrap: (address) => (/^gs:\/\/[^/]/.test(address) ? address : undefined),
};

export const PUBLIC_HTTP: SourceSignIn = {
  id: "public",
  title: "None (public)",
  storage: "http",
  wrap: (plain) => plain,
  unwrap: (address) => (/^https?:\/\/[^/]/.test(address) ? address : undefined),
};

/** The Google sign-in of the Auth tab, for buckets (`gs+google://`). */
export const GOOGLE_SIGN_IN: SourceSignIn = {
  id: "google",
  title: "Google",
  storage: "gs",
  wrap: (plain) => plain.replace(/^gs:\/\//, "gs+google://"),
  unwrap: (address) => (/^gs\+google:\/\/[^/]/.test(address) ? address.replace(/^gs\+google:/, "gs:") : undefined),
};

/** Middleauth, for web servers (`middleauth+https://`): the server names its sign-in server. */
export const MIDDLEAUTH_SIGN_IN: SourceSignIn = {
  id: "middleauth",
  title: "Middleauth",
  storage: "http",
  wrap: (plain) => `middleauth+${plain}`,
  unwrap: (address) => address.match(/^middleauth\+(https?:\/\/[^/].*)$/)?.[1],
};

const NGAUTH = /^gs\+ngauth\+(https?):\/\/([^/]+)\/([^/]+.*)$/;

/** The ngauth server (an origin) an address reads through, if it does. */
export function ngauthServerOf(address: string): string | undefined {
  const m = splitSource(address).base.match(NGAUTH);
  return m === null ? undefined : `${m[1]}://${m[2]}`;
}

/** An ngauth server (an origin, `https://host[:port]`), for buckets (`gs+ngauth+https://server/bucket/path`). */
export function ngauthSignIn(server: string): SourceSignIn {
  return {
    id: `ngauth:${server}`,
    title: `ngauth: ${server.replace(/^https:\/\//, "")}`,
    storage: "gs",
    wrap: (plain) => plain.replace(/^gs:\/\//, `gs+ngauth+${server}/`),
    unwrap: (address) => {
      const m = address.match(NGAUTH);
      return m !== null && `${m[1]}://${m[2]}` === server ? `gs://${m[3]}` : undefined;
    },
  };
}

/** The built-in sign-ins an address may already use (any ngauth server), most specific first. */
function builtIn(address: string): SourceSignIn[] {
  const server = ngauthServerOf(address);
  return [GOOGLE_SIGN_IN, MIDDLEAUTH_SIGN_IN, ...(server !== undefined ? [ngauthSignIn(server)] : []), PUBLIC_GS, PUBLIC_HTTP];
}

/**
 * The sign-in a source URL uses, among `signIns` (public ones last, so a
 * specific one wins), and its base address without it.
 */
export function signInOf(url: string, signIns: SourceSignIn[]): { signIn: SourceSignIn; plain: string } | undefined {
  const { base } = splitSource(url);
  const ordered = [...signIns.filter((s) => s.id !== "public"), ...signIns.filter((s) => s.id === "public")];
  for (const signIn of ordered) {
    const plain = signIn.unwrap(base);
    if (plain !== undefined) return { signIn, plain };
  }
  return undefined;
}

/** A source URL read with `target` instead; undefined when it reads another kind of storage. */
export function withSignIn(url: string, target: SourceSignIn, signIns: SourceSignIn[] = []): string | undefined {
  const found = signInOf(url, [...signIns, ...builtIn(url)]);
  if (found === undefined || found.signIn.storage !== target.storage) return undefined;
  const { prefix, rest } = splitSource(url);
  return prefix + target.wrap(found.plain) + rest;
}

/** A source URL with the built-in sign-ins taken out: the same data, read anonymously. */
export function withoutSignIn(url: string): string {
  const found = signInOf(url, builtIn(url));
  if (found === undefined) return url;
  const { prefix, rest } = splitSource(url);
  return prefix + found.plain + rest;
}

/**
 * A layer's `source` (a URL, `{url, …}`, or a list of them) with each URL
 * that reads `target`'s kind of storage read with `target`.
 */
export function sourceWithSignIn(source: unknown, target: SourceSignIn, signIns: SourceSignIn[] = []): unknown {
  const one = (s: unknown): unknown => {
    if (typeof s === "string") return withSignIn(s, target, signIns) ?? s;
    if (typeof s === "object" && s !== null && typeof (s as { url?: unknown }).url === "string") {
      const url = (s as { url: string }).url;
      return { ...s, url: withSignIn(url, target, signIns) ?? url };
    }
    return s;
  };
  return Array.isArray(source) ? source.map(one) : one(source);
}
