/**
 * Google sign-in for the whole browser, with several accounts at once: an
 * OAuth access token per account from Google Identity Services' token
 * flow, kept in this browser with its expiry, that reads Google Cloud
 * Storage buckets as `gs+google://bucket/path` (see src/engine/google_gcs.ts).
 * One account is the default; sign-in rules (./sign_in_rules.ts) choose
 * another for a bucket or a folder.  It needs an OAuth client ID registered
 * for this site's address, built in (VITE_GOOGLE_CLIENT_ID) or set in the
 * Settings › Sign-in; docs/guide/signing-in.md says how to make one.
 *
 * Adding an account opens Google's account chooser; signing in again for
 * one passes its email as the hint, so Google goes straight to it.  A popup
 * opens only from a click: data waiting for an account that is signed out
 * or expired waits for the next one (the buttons in Settings › Sign-in, or the button
 * in Neuroglancer's status line).
 */
import { googleAccountFor, type SignInRule } from "../core/sign_in_rules.js";
import { GOOGLE_SIGN_IN } from "../core/source_auth.js";
import type { AuthProvider, AuthService, AuthStatus, Disposer } from "../sdk/types.js";

export const GOOGLE_CLIENT_SCRIPT = "https://accounts.google.com/gsi/client";

/** What the token is asked for, with what each one lets this site do. */
export const GOOGLE_SCOPES: { scope: string; what: string }[] = [
  { scope: "openid", what: "know it is you" },
  { scope: "email", what: "see your email address, to show which account is signed in" },
  { scope: "https://www.googleapis.com/auth/devstorage.read_only", what: "read the Google Cloud Storage buckets your account can read" },
];

/** Where the accounts are kept. */
export const ACCOUNTS_KEY = "ngplatform.google.accounts";
/** Where the one token of the first version was kept (moved into ACCOUNTS_KEY on first read). */
export const OLD_TOKEN_KEY = "ngplatform.google.token";
const CLIENT_KEY = "ngplatform.google.clientId";
/** A token this close to its expiry is taken as expired, so a request never starts with one about to lapse. */
const MARGIN_MS = 60_000;

/** A token of one account. */
export interface GoogleToken {
  accessToken: string;
  /** When it expires, in ms since the epoch. */
  expiresAt: number;
  /** The scopes granted, space-separated (the user may refuse some). */
  scope: string;
  /** The account's email ("" when Google did not say). */
  email: string;
}

/** An account signed in here, now or before. */
export interface GoogleAccount {
  email: string;
  /** Its token; none once signed out. */
  token?: { accessToken: string; expiresAt: number; scope: string };
}

interface Kept {
  default?: string;
  accounts: GoogleAccount[];
}

/** What Google answers a token request with. */
export interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** What a token request may override: `select_account` shows Google's account chooser; `login_hint` names the account. */
export interface GoogleTokenOverrides {
  prompt?: string;
  login_hint?: string;
  /** The older name of `login_hint`. */
  hint?: string;
}

/** The part of Google Identity Services' `google.accounts.oauth2` used here. */
export interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): { requestAccessToken(overrides?: GoogleTokenOverrides): void };
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

/** An account's name in Settings › Sign-in: its email, or a stand-in when Google did not say. */
export function accountLabel(email: string | undefined): string {
  return email === undefined ? "the default account" : email === "" ? "the account signed in before" : email;
}

export class GoogleSignIn {
  private listeners = new Set<() => void>();
  private neededListeners = new Set<(account: string | undefined) => void>();
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
      if (key === null || key === ACCOUNTS_KEY || key === CLIENT_KEY) this.changed();
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

  // ------------------------------------------------------------ accounts

  /** What is kept, the first version's single token moved in. */
  private kept(): Kept {
    const raw = this.env.storage.getItem(ACCOUNTS_KEY);
    if (raw === null) return this.migrate();
    try {
      const kept = JSON.parse(raw);
      const accounts = Array.isArray(kept?.accounts)
        ? (kept.accounts as GoogleAccount[]).filter((a) => typeof a?.email === "string").map((a) => ({ email: a.email, token: validToken(a.token) }))
        : [];
      const fallback = accounts[0]?.email;
      return { default: accounts.some((a) => a.email === kept.default) ? kept.default : fallback, accounts };
    } catch {
      return { accounts: [] };
    }
  }

  /** The first version kept one token under OLD_TOKEN_KEY: it becomes the default account. */
  private migrate(): Kept {
    const raw = this.env.storage.getItem(OLD_TOKEN_KEY);
    if (raw === null) return { accounts: [] };
    let old: { accessToken?: unknown; expiresAt?: unknown; scope?: unknown; email?: unknown } | undefined;
    try {
      old = JSON.parse(raw);
    } catch {
      old = undefined;
    }
    this.env.storage.removeItem(OLD_TOKEN_KEY);
    const token = validToken(old && { accessToken: old.accessToken, expiresAt: old.expiresAt, scope: typeof old.scope === "string" ? old.scope : "" });
    if (token === undefined) return { accounts: [] };
    const email = typeof old?.email === "string" ? old.email : "";
    const kept: Kept = { default: email, accounts: [{ email, token }] };
    this.env.storage.setItem(ACCOUNTS_KEY, JSON.stringify(kept));
    return kept;
  }

  private keep(kept: Kept): void {
    if (kept.default === undefined || !kept.accounts.some((a) => a.email === kept.default)) kept.default = kept.accounts[0]?.email;
    this.env.storage.setItem(ACCOUNTS_KEY, JSON.stringify(kept));
    this.changed();
  }

  /** The accounts signed in here (now or before), in the order they were added. */
  accounts(): GoogleAccount[] {
    return this.kept().accounts;
  }

  /** The default account's email: the one that reads a bucket no rule gives another. */
  defaultAccount(): string | undefined {
    return this.kept().default;
  }

  setDefault(email: string): void {
    const kept = this.kept();
    if (!kept.accounts.some((a) => a.email === email)) return;
    this.keep({ ...kept, default: email });
  }

  /** An account's token kept here, expired or not (undefined: the default account). */
  stored(account?: string): GoogleToken | undefined {
    const kept = this.kept();
    const email = account ?? kept.default;
    const found = kept.accounts.find((a) => a.email === email);
    return found?.token === undefined ? undefined : { ...found.token, email: found.email };
  }

  /** An account's token while it is good to use (undefined: the default account's). */
  token(account?: string): GoogleToken | undefined {
    const token = this.stored(account);
    return token !== undefined && token.expiresAt - this.env.now() > MARGIN_MS ? token : undefined;
  }

  /** An account's state (undefined: the default account's; signed out when there is none). */
  state(account?: string): GoogleState {
    if (this.token(account) !== undefined) return "signed-in";
    if (this.clientId() === undefined) return "unconfigured";
    return this.stored(account) !== undefined ? "expired" : "signed-out";
  }

  /** Whether a token lets this site read Cloud Storage (the user may have refused that scope). */
  readsStorage(token = this.stored()): boolean {
    return token?.scope.split(/\s+/).includes(GOOGLE_SCOPES[2].scope) ?? false;
  }

  /** A token a server refused: its account is kept (and its token, for the email) but taken as expired. */
  markInvalid(accessToken: string): void {
    const kept = this.kept();
    const account = kept.accounts.find((a) => a.token?.accessToken === accessToken);
    if (account?.token === undefined || account.token.expiresAt === 0) return;
    account.token = { ...account.token, expiresAt: 0 };
    this.keep(kept);
  }

  /**
   * A good token of `account` (undefined: the default account, whichever
   * it is by then) other than `refused`, once there is one: at once if
   * there is, else after that account's next sign-in.  Opens nothing: data
   * waiting here tells the user (onNeeded) and waits for their click.
   */
  waitForToken(account: string | undefined, signal?: AbortSignal, refused?: string): Promise<GoogleToken> {
    const ready = () => {
      const token = this.token(account);
      return token !== undefined && token.accessToken !== refused ? token : undefined;
    };
    const now = ready();
    if (now !== undefined) return Promise.resolve(now);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (refused !== undefined) this.markInvalid(refused);
    for (const listener of [...this.neededListeners]) listener(account);
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
   * Signs in: with no account, adds one through Google's account chooser;
   * with one, signs that account in again (its email as the hint, no
   * prompt unless Google needs one).  Call it from a click: Google's window
   * opens before anything is awaited, so the browser allows it.  Resolves
   * with the email of the account that signed in.
   */
  signIn(account?: string): Promise<string> {
    if (this.clientId() === undefined) return Promise.reject(new Error("Set a Google OAuth client ID first (Settings → Sign-in, or see Signing in in the guide)."));
    if (!this.ready() || this.client === undefined) {
      void this.prepare().catch(() => {});
      return Promise.reject(new Error("Google sign-in is still loading: click again in a moment."));
    }
    this.pending?.reject(new Error("Another sign-in was started."));
    let pending: GoogleSignIn["pending"];
    const answer = new Promise<GoogleTokenResponse>((resolve, reject) => {
      this.pending = pending = { resolve, reject };
    });
    this.client.tokens.requestAccessToken(
      account === undefined || account === "" ? { prompt: "select_account" } : { prompt: "", login_hint: account, hint: account },
    );
    return answer
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .then(async (response) => {
        if (response.error !== undefined || typeof response.access_token !== "string") {
          throw new Error(response.error_description ?? response.error ?? "Google answered without a token.");
        }
        const token = {
          accessToken: response.access_token,
          expiresAt: this.env.now() + Number(response.expires_in ?? 3600) * 1000,
          scope: response.scope ?? "",
        };
        const email = (await this.email(token.accessToken)) ?? account ?? "";
        const kept = this.kept();
        // The account signed in before Google said its email becomes this one.
        const accounts = kept.accounts.filter((a) => a.email !== email && !(a.email === "" && account === ""));
        const at = kept.accounts.findIndex((a) => a.email === email || (a.email === "" && account === ""));
        const entry = { email, token };
        if (at === -1) accounts.push(entry);
        else accounts.splice(Math.min(at, accounts.length), 0, entry);
        const wasDefault = kept.default === email || (kept.default === "" && account === "");
        this.keep({ default: wasDefault || kept.default === undefined ? email : kept.default, accounts });
        return email;
      });
  }

  /** Signs one account out: forgets its token here (the account stays listed) and revokes it with Google. */
  async signOut(account?: string): Promise<void> {
    const kept = this.kept();
    const found = kept.accounts.find((a) => a.email === (account ?? kept.default));
    const token = found?.token;
    if (found === undefined || token === undefined) return;
    found.token = undefined;
    this.keep(kept);
    await this.revoke(token.accessToken);
  }

  /** Forgets an account (revoking its token): a rule naming it then waits for it to be added again. */
  async remove(account: string): Promise<void> {
    const kept = this.kept();
    const found = kept.accounts.find((a) => a.email === account);
    if (found === undefined) return;
    this.keep({ default: kept.default === account ? undefined : kept.default, accounts: kept.accounts.filter((a) => a !== found) });
    if (found.token !== undefined) await this.revoke(found.token.accessToken);
  }

  private async revoke(accessToken: string): Promise<void> {
    const oauth2 = await this.env.loadClient();
    await new Promise<void>((resolve) => oauth2.revoke(accessToken, resolve));
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

  // ---------------------------------------------------------- listeners

  onChanged(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called when data waits for an account's sign-in (undefined: the default account, or any first one). */
  onNeeded(listener: (account: string | undefined) => void): Disposer {
    this.neededListeners.add(listener);
    return () => this.neededListeners.delete(listener);
  }

  private changed(): void {
    this.scheduleExpiry();
    for (const waiter of [...this.waiters]) waiter();
    for (const listener of [...this.listeners]) listener();
  }

  /** Tells listeners when a token lapses, so Settings › Sign-in shows it expired. */
  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const now = this.env.now();
    const next = this.accounts()
      .map((a) => a.token?.expiresAt ?? 0)
      .filter((at) => at - MARGIN_MS > now)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    // At most a day ahead: setTimeout overflows past about 24.8 days.
    const delay = Math.min(next - MARGIN_MS - now + 1000, 86_400_000);
    this.expiryTimer = setTimeout(() => this.changed(), delay);
  }
}

function validToken(token: unknown): GoogleAccount["token"] {
  const t = token as { accessToken?: unknown; expiresAt?: unknown; scope?: unknown } | undefined;
  return t && typeof t.accessToken === "string" && typeof t.expiresAt === "number"
    ? { accessToken: t.accessToken, expiresAt: t.expiresAt, scope: typeof t.scope === "string" ? t.scope : "" }
    : undefined;
}

/** An account's status as Settings › Sign-in shows it. */
export function accountStatus(google: GoogleSignIn, account: string): AuthStatus {
  const token = google.stored(account);
  const user = accountLabel(account);
  switch (google.state(account)) {
    case "unconfigured":
      return { state: "unconfigured", user, detail: "Needs a Google OAuth client ID for this site: set one under Google sign-in below." };
    case "signed-out":
      return { state: "signed-out", user };
    case "expired":
      return { state: "expired", user, detail: "The sign-in has expired: sign in again to renew it." };
    default: {
      const until = new Date(token!.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const scopes = google.readsStorage(token) ? "" : "; Cloud Storage was not allowed, so buckets cannot be read: sign out and in again to allow it";
      return { state: "signed-in", user, detail: `until ${until}${scopes}` };
    }
  }
}

/**
 * The Google sign-in as a provider: a service per account (Settings › Sign-in
 * shows them in its Google accounts section), or one to add the first.
 */
export function googleProvider(google: GoogleSignIn): AuthProvider {
  const service = (account: string): AuthService => ({
    id: `google:${account}`,
    title: accountLabel(account),
    detail: google.defaultAccount() === account ? "Google, the default account" : "Google",
    status: async () => accountStatus(google, account),
    signIn: async () => void (await google.signIn(account)),
    signOut: () => google.signOut(account),
  });
  const first: AuthService = {
    id: "google",
    title: "Google",
    detail: "Google Cloud Storage buckets your accounts can read (gs+google://), read-only.",
    async status(): Promise<AuthStatus> {
      return google.clientId() === undefined
        ? { state: "unconfigured", detail: "Needs a Google OAuth client ID for this site: set one under Google sign-in below." }
        : { state: "signed-out" };
    },
    signIn: async () => void (await google.signIn()),
  };
  return {
    id: "google",
    title: "Google",
    description: "Google sign-in for this browser, one or more accounts, for Google Cloud Storage (gs+google://).",
    sourceSignIns: () => [GOOGLE_SIGN_IN],
    services: async () => {
      const accounts = google.accounts();
      return accounts.length === 0 ? [first] : accounts.map((a) => service(a.email));
    },
  };
}

/**
 * The tokens `gs+google://` data reads with (src/engine/google_credentials.ts):
 * per address, the account its rule names, else the default account.
 */
export function googleTokens(google: GoogleSignIn, rules: { list(): SignInRule[] }) {
  return {
    accountFor: (url: string) => googleAccountFor(rules.list(), url, google.defaultAccount()),
    token: (account?: string) => google.token(account),
    waitForToken: (account: string | undefined, signal: AbortSignal | undefined, refused?: string) => google.waitForToken(account, signal, refused),
    markInvalid: (accessToken: string) => google.markInvalid(accessToken),
    clientId: () => google.clientId(),
    signIn: (account?: string) => google.signIn(account),
  };
}
