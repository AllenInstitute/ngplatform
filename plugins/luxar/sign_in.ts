/**
 * The sign-in a segmentation's meshes are read with: the same one the
 * layer's source names (`@ngplatform/sdk/sources`' `meshSourceOf`), as the
 * header its reads carry in Luxar's reading worker, which cannot reach the
 * page's storage.  A Google sign-in needs none (the app's own route adds
 * the token); a middleauth one is the token Neuroglancer keeps for the
 * data server's sign-in server; an ngauth one is a token its server hands
 * out for the bucket.  No token yet: no header, and the server's refusal
 * says to sign in.
 */
import type { SourceSignInNeed } from "@ngplatform/sdk/sources";
import type { AuthHeader } from "./precomputed_meshes.js";

/** Neuroglancer's key for a middleauth sign-in server's token. */
const MIDDLEAUTH_TOKEN_PREFIX = "auth_token_v2_";

export interface SignInEnvironment {
  fetch: typeof fetch;
  storage: Pick<Storage, "getItem"> | undefined;
}

export function browserSignIn(): SignInEnvironment {
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
  } catch {
    storage = undefined;
  }
  return { fetch: (input, init) => fetch(input, init), storage };
}

/** A server's address as Settings › Sign-in keeps it: origin and path, without a trailing slash. */
function serverOf(text: string): string | undefined {
  try {
    const url = new URL(text.replace(/^middleauth\+/, ""));
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** The headers a source's reads carry for its sign-in (none when it needs none, or has no token yet). */
export async function signInHeaders(need: SourceSignInNeed | undefined, env: SignInEnvironment = browserSignIn()): Promise<AuthHeader[]> {
  if (need === undefined || need.kind === "google") return [];
  try {
    if (need.kind === "middleauth") {
      // The data server names its sign-in server; the token is kept under that.
      const r = await env.fetch(`${need.app}/auth_info`);
      if (!r.ok) return [];
      const server = serverOf(String((await r.json())?.login_url ?? ""));
      const raw = server === undefined ? null : (env.storage?.getItem(MIDDLEAUTH_TOKEN_PREFIX + server) ?? null);
      const token = raw === null ? undefined : JSON.parse(raw);
      if (typeof token?.accessToken !== "string") return [];
      return [{ prefix: `${need.app}/`, value: `${token.tokenType ?? "Bearer"} ${token.accessToken}` }];
    }
    const r = await env.fetch(`${need.server}/token`, { method: "POST", credentials: "include" });
    if (!r.ok) return [];
    const body = await r.text();
    // ngauth answers the token itself, or JSON naming it.
    let token = body.trim();
    try {
      const json = JSON.parse(body);
      if (typeof json?.token === "string") token = json.token;
    } catch {
      // the plain token
    }
    return token === "" ? [] : [{ prefix: `https://storage.googleapis.com/${need.bucket}/`, value: `Bearer ${token}` }];
  } catch {
    return [];
  }
}
