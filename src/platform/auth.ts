/**
 * Sign-in.  Providers say which services the workspace needs signing in to
 * (from its data sources and the servers added by hand in the Auth tab);
 * the tab shows each one's status and signs in and out.  Middleauth (the
 * Google-backed sign-in CAVE and similar servers use) is built in; plugins
 * add others through `context.auth.register`.
 *
 * Tokens are kept where Neuroglancer keeps them, so a sign-in here is the
 * one the viewer uses, and one the viewer asked for shows here.
 */
import type { AuthProvider, AuthService, AuthStatus, Disposer } from "../sdk/types.js";

/** What the providers need from the browser; tests give fakes. */
export interface AuthEnvironment {
  fetch: typeof fetch;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
  /** Opens the sign-in window (synchronously, from the click). */
  openWindow(url: string): Window | null;
  /** Messages posted to this window. */
  onMessage(listener: (event: MessageEvent) => void): Disposer;
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
  };
}

const MANUAL_KEY = "ngplatform.auth.servers";

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
  manual(): string[] {
    try {
      const list = JSON.parse(this.storage.getItem(MANUAL_KEY) ?? "[]");
      return Array.isArray(list) ? list.map(String) : [];
    } catch {
      return [];
    }
  }

  addManual(server: string): void {
    const url = normaliseServer(server);
    if (url === undefined) throw new Error(`Not a server address: ${server}`);
    if (!this.list().some((p) => p.accepts?.(url))) throw new Error(`No sign-in method takes ${url}`);
    const list = this.manual();
    if (!list.includes(url)) this.storage.setItem(MANUAL_KEY, JSON.stringify([...list, url]));
    this.changed();
  }

  removeManual(server: string): void {
    this.storage.setItem(MANUAL_KEY, JSON.stringify(this.manual().filter((s) => s !== server)));
    this.changed();
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
  let t = text.trim().replace(/^middleauth\+/, "");
  if (t === "") return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `https://${t}`;
  try {
    const url = new URL(t);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
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
 * the token back.  A server typed into the Auth tab may be either.
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
        .catch(() => undefined);
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
      // Opened before anything is awaited, so the browser counts it as the click's.
      const popup = env.openWindow(`${server}/api/v1/authorize`);
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
          const data = event.data as { token?: unknown; app_urls?: unknown };
          if (typeof data?.token !== "string") {
            done(new Error("The sign-in window answered without a token."));
            return;
          }
          const token: MiddleAuthToken = {
            tokenType: "Bearer",
            accessToken: data.token,
            url: server,
            appUrls: Array.isArray(data.app_urls) ? data.app_urls.map(String) : [],
          };
          env.storage.setItem(MIDDLEAUTH_TOKEN_PREFIX + server, JSON.stringify(token));
          popup.close();
          done();
        });
        const poll = setInterval(() => {
          if (popup.closed) done(new Error("The sign-in window was closed before signing in."));
        }, 500);
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

/** A status's one-word label. */
export function statusLabel(status: AuthStatus | undefined): string {
  switch (status?.state) {
    case "signed-in":
      return "Signed in";
    case "signed-out":
      return "Signed out";
    case "expired":
      return "Expired";
    case "error":
      return "Error";
    case "unknown":
      return "Unknown";
    default:
      return "Checking…";
  }
}
