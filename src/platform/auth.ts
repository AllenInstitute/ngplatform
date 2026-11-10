/**
 * Sign-in.  Providers say which services the workspace needs signing in to
 * (from its data sources and the servers added by hand in Settings › Sign-in);
 * Settings › Sign-in shows each one's status and signs in and out.  Built in are
 * Google (./google_auth.ts), middleauth (the Google-backed sign-in CAVE and
 * similar servers use) and ngauth (tokens for Google Cloud Storage from a
 * server); plugins add others through `context.auth.register`.
 *
 * Providers also say how a layer reads its data with their sign-in (a URL
 * scheme: see ../core/source_auth.ts), for the drop-down per layer there.
 *
 * Tokens are kept where Neuroglancer keeps them, so a sign-in here is the
 * one the viewer uses, and one the viewer asked for shows here.
 */
import { MIDDLEAUTH_SIGN_IN, ngauthSignIn, PUBLIC_GS, PUBLIC_HTTP } from "../core/source_auth.js";
import type { AuthProvider, AuthService, AuthStatus, Disposer, SourceSignIn } from "../sdk/types.js";

/** What the providers need from the browser; tests give fakes. */
export interface AuthEnvironment {
  fetch: typeof fetch;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
  /** Opens the sign-in window (synchronously, from the click). */
  openWindow(url: string): Window | null;
  /** Messages posted to this window. */
  onMessage(listener: (event: MessageEvent) => void): Disposer;
  /** This page's origin, which an ngauth server must allow. */
  origin: string;
}

export function browserAuthEnvironment(): AuthEnvironment {
  return {
    fetch: (input, init) => fetch(input, init),
    storage: localStorage,
    openWindow: (url) => {
      const width = 420;
      const height = 650;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const left = window.screenX + (window.outerWidth - width) / 2;
      return window.open(url, "_blank", `popup,width=${width},height=${height},top=${top},left=${left}`);
    },
    onMessage: (listener) => {
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
    origin: location.origin,
  };
}

const MANUAL_KEY = "ngplatform.auth.servers";

/** A server added by hand, and the provider it was added for. */
export interface ManualServer {
  provider: string;
  server: string;
}

export class AuthRegistry {
  private providers = new Map<string, { provider: AuthProvider; owner?: string }>();
  private listeners = new Set<() => void>();

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">) {}

  register(provider: AuthProvider, owner?: string): Disposer {
    if (this.providers.has(provider.id)) throw new Error(`auth provider ${provider.id} is already registered`);
    this.providers.set(provider.id, { provider, owner });
    this.changed();
    return () => {
      if (this.providers.get(provider.id)?.provider === provider) {
        this.providers.delete(provider.id);
        this.changed();
      }
    };
  }

  list(): AuthProvider[] {
    return [...this.providers.values()].map((p) => p.provider);
  }

  /** Servers added by hand, kept in this browser. */
  manualServers(): ManualServer[] {
    try {
      const list = JSON.parse(this.storage.getItem(MANUAL_KEY) ?? "[]");
      if (!Array.isArray(list)) return [];
      // A plain address is from before servers named their provider: middleauth was the only one.
      return list
        .map((e) => (typeof e === "string" ? { provider: "middleauth", server: e } : e))
        .filter((e): e is ManualServer => typeof e?.provider === "string" && typeof e?.server === "string");
    } catch {
      return [];
    }
  }

  /** The servers added by hand for one provider. */
  manual(provider: string): string[] {
    return this.manualServers()
      .filter((e) => e.provider === provider)
      .map((e) => e.server);
  }

  /** The providers that take a server typed in, by the address. */
  accepting(server: string): AuthProvider[] {
    const url = normaliseServer(server);
    return url === undefined ? [] : this.list().filter((p) => p.accepts?.(url));
  }

  /** Adds a server for `provider` (by default the first that takes it); returns the provider's id. */
  addManual(server: string, provider?: string): string {
    const url = normaliseServer(server);
    if (url === undefined) throw new Error(`Not a server address: ${server}`);
    const takers = this.accepting(url);
    const taker = provider === undefined ? takers[0] : takers.find((p) => p.id === provider);
    if (taker === undefined) throw new Error(`No sign-in method takes ${url}`);
    const list = this.manualServers();
    if (!list.some((e) => e.provider === taker.id && e.server === url)) {
      this.storage.setItem(MANUAL_KEY, JSON.stringify([...list, { provider: taker.id, server: url }]));
    }
    this.changed();
    return taker.id;
  }

  removeManual(server: string, provider?: string): void {
    const kept = this.manualServers().filter((e) => e.server !== server || (provider !== undefined && e.provider !== provider));
    this.storage.setItem(MANUAL_KEY, JSON.stringify(kept));
    this.changed();
  }

  /**
   * The ways a layer can read its data: anonymously, or with each
   * provider's sign-ins (Google, an ngauth server, middleauth…).
   */
  sourceSignIns(sources: string[]): SourceSignIn[] {
    const all = [PUBLIC_GS, PUBLIC_HTTP];
    for (const provider of this.list()) {
      try {
        for (const signIn of provider.sourceSignIns?.({ sources, manual: this.manual(provider.id) }) ?? []) {
          if (!all.some((s) => s.storage === signIn.storage && s.id === signIn.id)) all.push(signIn);
        }
      } catch (e) {
        console.error(`${provider.id}: sourceSignIns failed`, e);
      }
    }
    return all;
  }

  onChanged(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** A server address as https://host[:port][/path], without a trailing slash. */
export function normaliseServer(text: string): string | undefined {
  let t = text.trim().replace(/^(middleauth|gs\+ngauth)\+/, "");
  // Not an address: blank, or with spaces (Chrome's URL parser accepts "not a url" as a host).
  if (t === "" || /\s/.test(t)) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `https://${t}`;
  try {
    const url = new URL(t);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (!/^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/i.test(url.hostname)) return undefined;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ middleauth

/** Neuroglancer's key for a middleauth server's token. */
export const MIDDLEAUTH_TOKEN_PREFIX = "auth_token_v2_";

interface MiddleAuthToken {
  tokenType: string;
  accessToken: string;
  url: string;
  appUrls: string[];
}

function readToken(storage: AuthEnvironment["storage"], server: string): MiddleAuthToken | undefined {
  try {
    const raw = storage.getItem(MIDDLEAUTH_TOKEN_PREFIX + server);
    const token = raw === null ? undefined : JSON.parse(raw);
    return token && typeof token.accessToken === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}

/** The app origins of a workspace's middleauth data sources (`middleauth+https://…`). */
export function middleauthApps(sources: string[]): string[] {
  const apps = new Set<string>();
  for (const source of sources) {
    const m = source.match(/middleauth\+(https?:\/\/[^/|\s"]+)/);
    if (m === null) continue;
    try {
      apps.add(new URL(m[1]).origin);
    } catch {
      // not a URL: Neuroglancer will say so
    }
  }
  return [...apps];
}

/**
 * Middleauth: a data server ("app") names its sign-in server at
 * `/auth_info`; signing in opens `<server>/api/v1/authorize`, which posts
 * the token back.  A server typed into Settings › Sign-in may be either.
 */
export function middleauthProvider(env: AuthEnvironment): AuthProvider {
  const loginUrls = new Map<string, Promise<string | undefined>>();
  /** An app's sign-in server, or undefined when it does not answer as an app. */
  const loginUrlOf = (app: string) => {
    let pending = loginUrls.get(app);
    if (pending === undefined) {
      pending = env
        .fetch(`${app}/auth_info`)
        .then(async (r) => (r.ok ? normaliseServer(String((await r.json()).login_url ?? "")) : undefined))
        .catch(() => {
          // Not reached (offline, say): asked again next time rather than taken as "not an app" for the visit.
          loginUrls.delete(app);
          return undefined;
        });
      loginUrls.set(app, pending);
    }
    return pending;
  };

  const service = (server: string, users: string[], manual: string[]): AuthService => ({
    id: `middleauth:${server}`,
    title: new URL(server).host,
    detail: users.length > 0 ? `Sign-in for ${users.join(", ")}` : server,
    manual,
    async status(signal) {
      const token = readToken(env.storage, server);
      if (token === undefined) return { state: "signed-out" };
      const unverified = users.filter((app) => app !== server && !token.appUrls.includes(app));
      const note = unverified.length > 0 ? `not yet approved for ${unverified.join(", ")}` : undefined;
      try {
        const r = await env.fetch(`${server}/api/v1/user/cache`, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal });
        if (r.status === 401 || r.status === 403) return { state: "expired", detail: "The sign-in has expired: sign in again." };
        if (!r.ok) return { state: "signed-in", detail: [`Signed in (the server did not say as whom: ${r.status})`, note].filter(Boolean).join("; ") };
        const user = await r.json().catch(() => ({}));
        const name = [user.email, user.name].find((v) => typeof v === "string" && v !== "");
        return { state: "signed-in", user: name, detail: note };
      } catch (e) {
        if (signal?.aborted) throw e;
        return { state: "signed-in", detail: [`Signed in; could not check with the server (${(e as Error).message})`, note].filter(Boolean).join("; ") };
      }
    },
    signIn() {
      return signInWindow(env, `${server}/api/v1/authorize`, (event) => {
        const data = event.data as { token?: unknown; app_urls?: unknown };
        if (typeof data?.token !== "string") return new Error("The sign-in window answered without a token.");
        const token: MiddleAuthToken = {
          tokenType: "Bearer",
          accessToken: data.token,
          url: server,
          appUrls: Array.isArray(data.app_urls) ? data.app_urls.map(String) : [],
        };
        env.storage.setItem(MIDDLEAUTH_TOKEN_PREFIX + server, JSON.stringify(token));
        return true;
      });
    },
    async signOut() {
      env.storage.removeItem(MIDDLEAUTH_TOKEN_PREFIX + server);
    },
  });

  return {
    id: "middleauth",
    title: "Middleauth",
    description: "Google sign-in through a middleauth server (as CAVE uses), for middleauth+https:// data.",
    accepts: (server) => normaliseServer(server) !== undefined,
    sourceSignIns: () => [{ ...MIDDLEAUTH_SIGN_IN, title: "Middleauth (CAVE, CATMAID…)" }],
    async services({ sources, manual }) {
      // Sign-in servers, and what uses each.
      const users = new Map<string, Set<string>>();
      const typed = new Map<string, string[]>();
      const use = (server: string, user?: string) => {
        let set = users.get(server);
        if (set === undefined) users.set(server, (set = new Set()));
        if (user !== undefined) set.add(user);
      };
      // An address typed in is an app if it names a sign-in server, else a sign-in server.
      const apps = middleauthApps(sources);
      await Promise.all([
        ...apps.map(async (app) => {
          const login = await loginUrlOf(app);
          if (login !== undefined) use(login, app);
        }),
        ...manual.map(async (address) => {
          const login = await loginUrlOf(address);
          const server = login ?? address;
          use(server, login !== undefined ? address : undefined);
          typed.set(server, [...(typed.get(server) ?? []), address]);
        }),
      ]);
      // Servers already holding a token (signed in here or by the viewer).
      for (let i = 0; i < env.storage.length; ++i) {
        const key = env.storage.key(i);
        if (key?.startsWith(MIDDLEAUTH_TOKEN_PREFIX)) {
          const server = normaliseServer(key.slice(MIDDLEAUTH_TOKEN_PREFIX.length));
          if (server !== undefined) use(server);
        }
      }
      return [...users]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([server, set]) => service(server, [...set].sort(), typed.get(server) ?? []));
    },
  };
}

/**
 * Opens a server's sign-in window and waits for it to post its answer.
 * `answer` takes each message from the window: true when signed in, an
 * Error when the sign-in failed, false to keep waiting.  The window is
 * opened before anything is awaited, so the browser counts it as the
 * click's.
 */
function signInWindow(env: AuthEnvironment, url: string, answer: (event: MessageEvent) => boolean | Error): Promise<void> {
  const popup = env.openWindow(url);
  if (popup === null) return Promise.reject(new Error("The sign-in window was blocked: allow pop-ups for this site and try again."));
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      off();
      clearInterval(poll);
      if (error) reject(error);
      else resolve();
    };
    const off = env.onMessage((event) => {
      if (event.source !== popup) return;
      const result = answer(event);
      if (result === false) return;
      if (result === true) popup.close();
      done(result === true ? undefined : result);
    });
    const poll = setInterval(() => {
      if (popup.closed) done(new Error("The sign-in window was closed before signing in."));
    }, 500);
  });
}

// ---------------------------------------------------------------- ngauth

/** An ngauth server's address: its origin, as `gs+ngauth+https://server/bucket/…` names it. */
export function ngauthOrigin(server: string): string | undefined {
  const url = normaliseServer(server);
  return url === undefined ? undefined : new URL(url).origin;
}

/** The ngauth servers of a workspace's data sources, with the buckets read through each. */
export function ngauthUses(sources: string[]): Map<string, Set<string>> {
  const uses = new Map<string, Set<string>>();
  for (const source of sources) {
    for (const m of source.matchAll(/gs\+ngauth\+(https?:\/\/[^/|\s"]+)\/([^/|\s"]+)/g)) {
      const server = ngauthOrigin(m[1]);
      if (server === undefined) continue;
      if (!uses.has(server)) uses.set(server, new Set());
      uses.get(server)!.add(`gs://${m[2]}`);
    }
  }
  return uses;
}

/**
 * ngauth: a server that signs in with Google and hands out tokens for the
 * Google Cloud Storage buckets it serves (`gs+ngauth+https://server/bucket/…`).
 * The sign-in is the server's cookie; Neuroglancer asks the server for a
 * token itself, so signing in here is all it needs.  Signing out is done on
 * the server's own page.
 */
export function ngauthProvider(env: AuthEnvironment): AuthProvider {
  const service = (server: string, buckets: string[], manual: string[]): AuthService => ({
    id: `ngauth:${server}`,
    title: new URL(server).host,
    detail: `${buckets.length > 0 ? `Google Cloud Storage for ${buckets.join(", ")}` : server}; sign out at ${server}/`,
    manual,
    async status(signal) {
      try {
        const r = await env.fetch(`${server}/token`, { method: "POST", credentials: "include", signal });
        if (r.ok) return { state: "signed-in" };
        if (r.status === 401) return { state: "signed-out" };
        if (r.status === 403) return { state: "error", detail: `The server does not take sign-ins from ${env.origin}: its administrator can add it.` };
        return { state: "error", detail: `The server answered ${r.status}.` };
      } catch (e) {
        if (signal?.aborted) throw e;
        return { state: "error", detail: `Could not reach the server (${(e as Error).message}).` };
      }
    },
    signIn() {
      return signInWindow(env, `${server}/login?origin=${encodeURIComponent(env.origin)}`, (event) => {
        if (event.origin !== server) return false;
        if (event.data === "badorigin") return new Error(`The server does not take sign-ins from ${env.origin}: its administrator can add it.`);
        return typeof (event.data as { token?: unknown })?.token === "string" ? true : new Error("The sign-in window answered without a token.");
      });
    },
  });

  /** Servers from the data and added by hand, with the buckets and addresses that led to each. */
  const servers = (sources: string[], manual: string[]) => {
    const found = new Map([...ngauthUses(sources)].map(([server, buckets]) => [server, { buckets: [...buckets].sort(), manual: [] as string[] }]));
    for (const address of manual) {
      const server = ngauthOrigin(address);
      if (server === undefined) continue;
      if (!found.has(server)) found.set(server, { buckets: [], manual: [] });
      found.get(server)!.manual.push(address);
    }
    return [...found].sort(([a], [b]) => a.localeCompare(b));
  };

  return {
    id: "ngauth",
    title: "ngauth",
    description: "Google Cloud Storage through an ngauth server, for gs+ngauth+https:// data.",
    accepts: (server) => normaliseServer(server) !== undefined,
    sourceSignIns: ({ sources, manual }) => servers(sources, manual).map(([server]) => ngauthSignIn(server)),
    async services({ sources, manual }) {
      return servers(sources, manual).map(([server, use]) => service(server, use.buckets, use.manual));
    },
  };
}

/** A status's one-word label. */
export function statusLabel(status: AuthStatus | undefined): string {
  switch (status?.state) {
    case "signed-in":
      return "Signed in";
    case "signed-out":
      return "Signed out";
    case "expired":
      return "Expired";
    case "unconfigured":
      return "Not set up";
    case "error":
      return "Error";
    case "unknown":
      return "Unknown";
    default:
      return "Checking…";
  }
}
