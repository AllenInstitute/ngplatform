/**
 * Google sign-in for the whole browser: an OAuth access token from Google
 * Identity Services' token flow, kept in this browser with its expiry, that
 * reads Google Cloud Storage buckets as `gs+google://bucket/path` (see
 * src/engine/google_gcs.ts).  It needs an OAuth client ID registered for
 * this site's address, built in (VITE_GOOGLE_CLIENT_ID) or set in the Auth
 * tab; docs/guide/signing-in.md says how to make one.
 *
 * A popup opens only from a click: signing in again after the token
 * expires waits for the next one (the Auth tab's button, or the button in
 * Neuroglancer's status line while data waits for it).
 */
import { GOOGLE_SIGN_IN } from "../core/source_auth.js";
import type { AuthProvider, AuthService, AuthStatus, Disposer } from "../sdk/types.js";

export const GOOGLE_CLIENT_SCRIPT = "https://accounts.google.com/gsi/client";

/** What the token is asked for, with what each one lets this site do. */
export const GOOGLE_SCOPES: { scope: string; what: string }[] = [
  { scope: "openid", what: "know it is you" },
  { scope: "email", what: "see your email address, to show who is signed in" },
  { scope: "https://www.googleapis.com/auth/devstorage.read_only", what: "read the Google Cloud Storage buckets your account can read" },
];

const TOKEN_KEY = "ngplatform.google.token";
const CLIENT_KEY = "ngplatform.google.clientId";
/** A token this close to its expiry is taken as expired, so a request never starts with one about to lapse. */
const MARGIN_MS = 60_000;

export interface GoogleToken {
  accessToken: string;
  /** When it expires, in ms since the epoch. */
  expiresAt: number;
  /** The scopes granted, space-separated (the user may refuse some). */
  scope: string;
  email?: string;
}

/** What Google answers a token request with. */
export interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** The part of Google Identity Services' `google.accounts.oauth2` used here. */
export interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): { requestAccessToken(overrides?: { prompt?: string; hint?: string }): void };
  revoke(token: string, done?: () => void): void;
}

/** What the Google sign-in needs from the browser; tests give fakes. */
export interface GoogleEnvironment {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  fetch: typeof fetch;
  now(): number;
  /** Loads Google Identity Services (its script, once). */
  loadClient(): Promise<GoogleOAuth2>;
  /** Changes other tabs make to this browser's storage (the key, or null when all was cleared). */
  onStorage(listener: (key: string | null) => void): Disposer;
}

export function browserGoogleEnvironment(): GoogleEnvironment {
  let loading: Promise<GoogleOAuth2> | undefined;
  type WithGoogle = { google?: { accounts?: { oauth2?: GoogleOAuth2 } } };
  return {
    storage: localStorage,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    loadClient: () =>
      (loading ??= new Promise<GoogleOAuth2>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = GOOGLE_CLIENT_SCRIPT;
        script.async = true;
        script.onload = () => {
          const api = (window as WithGoogle).google?.accounts?.oauth2;
          if (api !== undefined) resolve(api);
          else reject(new Error("Google sign-in loaded without its OAuth 2 API."));
        };
        script.onerror = () => {
          loading = undefined;
          script.remove();
          reject(new Error("Could not load Google sign-in from accounts.google.com."));
        };
        document.head.append(script);
      })),
    onStorage: (listener) => {
      const handle = (e: StorageEvent) => listener(e.key);
      window.addEventListener("storage", handle);
      return () => window.removeEventListener("storage", handle);
    },
  };
}

export type GoogleState = "unconfigured" | "signed-out" | "expired" | "signed-in";

export class GoogleSignIn {
  private listeners = new Set<() => void>();
  private neededListeners = new Set<() => void>();
  private waiters = new Set<() => void>();
  private client: { id: string; tokens: ReturnType<GoogleOAuth2["initTokenClient"]> } | undefined;
  private preparing: Promise<void> | undefined;
  /** The sign-in under way: Google's answer settles it. */
  private pending: { resolve: (response: GoogleTokenResponse) => void; reject: (error: Error) => void } | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly env: GoogleEnvironment,
    /** The client ID built in (VITE_GOOGLE_CLIENT_ID), used unless one is set in this browser. */
    readonly builtInClientId?: string,
  ) {
    env.onStorage((key) => {
      if (key === null || key === TOKEN_KEY || key === CLIENT_KEY) this.changed();
    });
    this.scheduleExpiry();
  }

  // ------------------------------------------------------------ client ID

  /** The client ID set in this browser, if any. */
  clientIdSetting(): string | undefined {
    return this.env.storage.getItem(CLIENT_KEY)?.trim() || undefined;
  }

  clientId(): string | undefined {
    return this.clientIdSetting() ?? (this.builtInClientId?.trim() || undefined);
  }

  /** Sets this browser's client ID ("" goes back to the built-in one). */
  setClientId(id: string): void {
    const trimmed = id.trim();
    if (trimmed === "") this.env.storage.removeItem(CLIENT_KEY);
    else this.env.storage.setItem(CLIENT_KEY, trimmed);
    this.changed();
  }

  // --------------------------------------------------------------- tokens

  /** The token kept in this browser, expired or not. */
  stored(): GoogleToken | undefined {
    try {
      const raw = this.env.storage.getItem(TOKEN_KEY);
      const token = raw === null ? undefined : JSON.parse(raw);
      return token && typeof token.accessToken === "string" && typeof token.expiresAt === "number" ? token : undefined;
    } catch {
      return undefined;
    }
  }

  /** The token, while it is good to use. */
  token(): GoogleToken | undefined {
    const token = this.stored();
    return token !== undefined && token.expiresAt - this.env.now() > MARGIN_MS ? token : undefined;
  }

  state(): GoogleState {
    if (this.token() !== undefined) return "signed-in";
    if (this.clientId() === undefined) return "unconfigured";
    return this.stored() !== undefined ? "expired" : "signed-out";
  }

  /** Whether the token lets this site read Cloud Storage (the user may have refused that scope). */
  readsStorage(token = this.stored()): boolean {
    return token?.scope.split(/\s+/).includes(GOOGLE_SCOPES[2].scope) ?? false;
  }

  /** A token a server refused: it is kept (for its email) but taken as expired. */
  markInvalid(accessToken: string): void {
    const token = this.stored();
    if (token?.accessToken !== accessToken || token.expiresAt === 0) return;
    this.save({ ...token, expiresAt: 0 });
  }

  /**
   * A good token other than `refused`, once there is one: at once if there
   * is, else after the next sign-in.  Opens nothing: data waiting here
   * tells the user (onNeeded) and waits for their click.
   */
  waitForToken(signal?: AbortSignal, refused?: string): Promise<GoogleToken> {
    const ready = () => {
      const token = this.token();
      return token !== undefined && token.accessToken !== refused ? token : undefined;
    };
    const now = ready();
    if (now !== undefined) return Promise.resolve(now);
    if (refused !== undefined) this.markInvalid(refused);
    for (const listener of [...this.neededListeners]) listener();
    return new Promise((resolve, reject) => {
      const check = () => {
        const token = ready();
        if (token === undefined) return;
        this.waiters.delete(check);
        signal?.removeEventListener("abort", abort);
        resolve(token);
      };
      const abort = () => {
        this.waiters.delete(check);
        reject(signal!.reason);
      };
      this.waiters.add(check);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  // -------------------------------------------------------- signing in

  /** Loads Google's sign-in script and makes the token client, ahead of a click. */
  prepare(): Promise<void> {
    const id = this.clientId();
    if (id === undefined) return Promise.reject(new Error("No Google OAuth client ID is set."));
    if (this.client?.id === id) return Promise.resolve();
    return (this.preparing ??= this.env
      .loadClient()
      .then((oauth2) => {
        const tokens = oauth2.initTokenClient({
          client_id: id,
          scope: GOOGLE_SCOPES.map((s) => s.scope).join(" "),
          callback: (response) => this.pending?.resolve(response),
          error_callback: (error) =>
            this.pending?.reject(
              new Error(
                error.type === "popup_closed"
                  ? "The sign-in window was closed before signing in."
                  : error.type === "popup_failed_to_open"
                    ? "The sign-in window was blocked: allow pop-ups for this site and try again."
                    : (error.message ?? "Google sign-in failed."),
              ),
            ),
        });
        this.client = { id, tokens };
      })
      .finally(() => {
        this.preparing = undefined;
      }));
  }

  /** Whether a click can sign in now (the token client is ready). */
  ready(): boolean {
    const id = this.clientId();
    return id !== undefined && this.client?.id === id;
  }

  /**
   * Signs in, or renews an expired sign-in.  Call it from a click: Google's
   * window opens before anything is awaited, so the browser allows it.
   */
  signIn(): Promise<void> {
    if (this.clientId() === undefined) return Promise.reject(new Error("Set a Google OAuth client ID first (below, or see Signing in in the guide)."));
    if (!this.ready() || this.client === undefined) {
      void this.prepare().catch(() => {});
      return Promise.reject(new Error("Google sign-in is still loading: click again in a moment."));
    }
    this.pending?.reject(new Error("Another sign-in was started."));
    const previous = this.stored();
    let pending: GoogleSignIn["pending"];
    const answer = new Promise<GoogleTokenResponse>((resolve, reject) => {
      this.pending = pending = { resolve, reject };
    });
    // Renewing passes no prompt, so Google asks again only if it must.
    this.client.tokens.requestAccessToken(previous !== undefined ? { prompt: "", hint: previous.email } : {});
    return answer
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .then(async (response) => {
        if (response.error !== undefined || typeof response.access_token !== "string") {
          throw new Error(response.error_description ?? response.error ?? "Google answered without a token.");
        }
        const token: GoogleToken = {
          accessToken: response.access_token,
          expiresAt: this.env.now() + Number(response.expires_in ?? 3600) * 1000,
          scope: response.scope ?? "",
          email: previous?.email,
        };
        token.email = (await this.email(token.accessToken)) ?? token.email;
        this.save(token);
      });
  }

  /** Forgets the token here and revokes it with Google. */
  async signOut(): Promise<void> {
    const token = this.stored();
    this.env.storage.removeItem(TOKEN_KEY);
    this.changed();
    if (token === undefined) return;
    const oauth2 = await this.env.loadClient();
    await new Promise<void>((resolve) => oauth2.revoke(token.accessToken, resolve));
  }

  private async email(accessToken: string): Promise<string | undefined> {
    try {
      const r = await this.env.fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
      const info = r.ok ? await r.json() : {};
      return typeof info.email === "string" ? info.email : undefined;
    } catch {
      return undefined;
    }
  }

  private save(token: GoogleToken): void {
    this.env.storage.setItem(TOKEN_KEY, JSON.stringify(token));
    this.changed();
  }

  // ---------------------------------------------------------- listeners

  onChanged(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called when data waits for a sign-in (none, or one that expired). */
  onNeeded(listener: () => void): Disposer {
    this.neededListeners.add(listener);
    return () => this.neededListeners.delete(listener);
  }

  private changed(): void {
    this.scheduleExpiry();
    for (const waiter of [...this.waiters]) waiter();
    for (const listener of [...this.listeners]) listener();
  }

  /** Tells listeners when the token lapses, so the Auth tab shows it expired. */
  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const token = this.token();
    if (token === undefined) return;
    // At most a day ahead: setTimeout overflows past about 24.8 days.
    const delay = Math.min(token.expiresAt - MARGIN_MS - this.env.now() + 1000, 86_400_000);
    this.expiryTimer = setTimeout(() => this.changed(), delay);
  }
}

/** The Google sign-in as the Auth tab lists it: always, being for the whole browser. */
export function googleProvider(google: GoogleSignIn): AuthProvider {
  const service: AuthService = {
    id: "google",
    title: "Google",
    detail: "Google Cloud Storage buckets your account can read (gs+google://), read-only.",
    async status(): Promise<AuthStatus> {
      const token = google.stored();
      switch (google.state()) {
        case "unconfigured":
          return { state: "unconfigured", detail: "Needs a Google OAuth client ID for this site: set one under Google sign-in below." };
        case "signed-out":
          return { state: "signed-out" };
        case "expired":
          return { state: "expired", user: token?.email, detail: "The sign-in has expired: sign in again to renew it." };
        default: {
          const until = new Date(token!.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const scopes = google.readsStorage(token) ? "" : "; Cloud Storage was not allowed, so buckets cannot be read: sign out and in again to allow it";
          return { state: "signed-in", user: token!.email, detail: `until ${until}${scopes}` };
        }
      }
    },
    signIn: () => google.signIn(),
    signOut: () => google.signOut(),
  };
  return {
    id: "google",
    title: "Google",
    description: "Google sign-in for this browser, for Google Cloud Storage (gs+google://).",
    sourceSignIns: () => [GOOGLE_SIGN_IN],
    services: async () => [service],
  };
}
