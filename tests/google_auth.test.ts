/**
 * The Google sign-in, with several accounts, against a fake browser:
 * storage, a clock, and a fake Google Identity Services whose token client
 * answers when told to (the fake userinfo endpoint names the account by
 * its token: t1… one@, t2… two@).
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNTS_KEY,
  type GoogleEnvironment,
  type GoogleOAuth2,
  GoogleSignIn,
  type GoogleTokenOverrides,
  type GoogleTokenResponse,
  googleProvider,
  googleTokens,
  OLD_TOKEN_KEY,
} from "../src/platform/google_auth.js";
import type { SignInRule } from "../src/core/sign_in_rules.js";

const HOUR = 3600_000;
const STORAGE = "openid email https://www.googleapis.com/auth/devstorage.read_only";

function environment() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  const clock = { now: 1_000_000 };
  const requested: { clientId: string; scope: string; overrides?: GoogleTokenOverrides }[] = [];
  const revoked: string[] = [];
  let answer: ((response: GoogleTokenResponse) => void) | undefined;
  let fail: ((error: { type?: string }) => void) | undefined;
  const oauth2: GoogleOAuth2 = {
    initTokenClient: (config) => {
      answer = config.callback;
      fail = config.error_callback;
      return { requestAccessToken: (overrides) => void requested.push({ clientId: config.client_id, scope: config.scope, overrides }) };
    },
    revoke: (token, done) => {
      revoked.push(token);
      done?.();
    },
  };
  const storageListeners = new Set<(key: string | null) => void>();
  const env: GoogleEnvironment = {
    storage,
    now: () => clock.now,
    fetch: (async (_input: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization ?? "";
      const email = auth.startsWith("Bearer t1") ? "one@example.org" : auth.startsWith("Bearer t2") ? "two@example.org" : undefined;
      return new Response(JSON.stringify(email !== undefined ? { email } : {}));
    }) as typeof fetch,
    loadClient: async () => oauth2,
    onStorage: (listener) => {
      storageListeners.add(listener);
      return () => storageListeners.delete(listener);
    },
  };
  return {
    env,
    map,
    clock,
    requested,
    revoked,
    answer: (r: GoogleTokenResponse) => answer!(r),
    fail: (e: { type?: string }) => fail!(e),
    otherTab: (key: string) => storageListeners.forEach((l) => l(key)),
  };
}

/** Signs in from a "click", Google answering with `token`. */
async function signIn(google: GoogleSignIn, answer: (r: GoogleTokenResponse) => void, token: string, account?: string, scope = STORAGE) {
  const signing = google.signIn(account);
  answer({ access_token: token, expires_in: 3600, scope });
  return signing;
}

describe("Google sign-in", () => {
  it("is not set up without a client ID, built in or set in this browser", async () => {
    const { env } = environment();
    const google = new GoogleSignIn(env);
    expect(google.state()).toBe("unconfigured");
    await expect(google.signIn()).rejects.toThrow(/client ID/);
    expect((await (await googleProvider(google).services({ sources: [], manual: [] }))[0].status()).state).toBe("unconfigured");
    google.setClientId("  set.apps.googleusercontent.com ");
    expect(google.clientId()).toBe("set.apps.googleusercontent.com");
    expect(google.state()).toBe("signed-out");
    const built = new GoogleSignIn(env, "built.apps.googleusercontent.com");
    expect(built.clientId()).toBe("set.apps.googleusercontent.com");
    built.setClientId("");
    expect(built.clientId()).toBe("built.apps.googleusercontent.com");
  });

  it("adds an account through Google's account chooser, keeping its token, expiry and email", async () => {
    const { env, map, clock, requested, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    // Before Google's script is loaded, a click cannot open its window.
    await expect(google.signIn()).rejects.toThrow(/still loading/);
    await google.prepare();
    expect(google.ready()).toBe(true);
    const signingIn = google.signIn();
    expect(requested).toEqual([{ clientId: "client", scope: STORAGE, overrides: { prompt: "select_account" } }]);
    answer({ access_token: "t1", expires_in: 3599, scope: STORAGE });
    expect(await signingIn).toBe("one@example.org");
    expect(google.token()).toEqual({ accessToken: "t1", expiresAt: clock.now + 3599_000, scope: STORAGE, email: "one@example.org" });
    expect(JSON.parse(map.get(ACCOUNTS_KEY)!)).toMatchObject({ default: "one@example.org", accounts: [{ email: "one@example.org", token: { accessToken: "t1" } }] });
    expect(google.state()).toBe("signed-in");
    expect(google.readsStorage()).toBe(true);
    const status = await (await googleProvider(google).services({ sources: [], manual: [] }))[0].status();
    expect(status).toMatchObject({ state: "signed-in", user: "one@example.org", detail: expect.stringMatching(/^until /) });
  });

  it("keeps several accounts, the first the default until another is made it", async () => {
    const { env, requested, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    await google.prepare();
    await signIn(google, answer, "t1");
    await signIn(google, answer, "t2");
    expect(requested.map((r) => r.overrides)).toEqual([{ prompt: "select_account" }, { prompt: "select_account" }]);
    expect(google.accounts().map((a) => a.email)).toEqual(["one@example.org", "two@example.org"]);
    expect(google.defaultAccount()).toBe("one@example.org");
    expect(google.token()?.accessToken).toBe("t1");
    expect(google.token("two@example.org")?.accessToken).toBe("t2");
    google.setDefault("two@example.org");
    expect(google.token()?.accessToken).toBe("t2");
    google.setDefault("nobody@example.org");
    expect(google.defaultAccount()).toBe("two@example.org");
    const services = await googleProvider(google).services({ sources: [], manual: [] });
    expect(services.map((s) => s.id)).toEqual(["google:one@example.org", "google:two@example.org"]);
  });

  it("expires each account on its own, a minute before Google's expiry, and renews it straight to that account", async () => {
    const { env, clock, requested, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    await google.prepare();
    await signIn(google, answer, "t1", undefined, "openid email");
    expect(google.readsStorage()).toBe(false);
    clock.now += HOUR / 2;
    await signIn(google, answer, "t2");
    clock.now += HOUR / 2 - 59_000;
    expect(google.state("one@example.org")).toBe("expired");
    expect(google.state("two@example.org")).toBe("signed-in");
    // Signing in again names the account and asks Google not to prompt.
    await signIn(google, answer, "t1b", "one@example.org");
    expect(requested[2].overrides).toEqual({ prompt: "", login_hint: "one@example.org", hint: "one@example.org" });
    expect(google.token("one@example.org")?.accessToken).toBe("t1b");
    expect(google.accounts().map((a) => a.email)).toEqual(["one@example.org", "two@example.org"]);
  });

  it("marks only the account whose token was refused as expired", async () => {
    const { env, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    await google.prepare();
    await signIn(google, answer, "t1");
    await signIn(google, answer, "t2");
    google.markInvalid("t2");
    expect(google.state("two@example.org")).toBe("expired");
    expect(google.state("one@example.org")).toBe("signed-in");
    expect(google.stored("two@example.org")?.email).toBe("two@example.org");
  });

  it("makes data wait for its account's sign-in, saying which, instead of opening a window", async () => {
    const { env, requested, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    const needed: (string | undefined)[] = [];
    google.onNeeded((account) => needed.push(account));
    // Waiting for the default account, with none yet: the first one added.
    const waiting = google.waitForToken(undefined);
    expect(needed).toEqual([undefined]);
    expect(requested).toEqual([]);
    await google.prepare();
    await signIn(google, answer, "t1");
    expect((await waiting).accessToken).toBe("t1");
    // Waiting for another account: the default's sign-in does not end it.
    let done = false;
    const second = google.waitForToken("two@example.org").then((t) => {
      done = true;
      return t;
    });
    expect(needed).toEqual([undefined, "two@example.org"]);
    await signIn(google, answer, "t1c", "one@example.org");
    await Promise.resolve();
    expect(done).toBe(false);
    await signIn(google, answer, "t2");
    expect((await second).accessToken).toBe("t2");
    // A token a server refused is expired until a new one comes.
    const again = google.waitForToken("two@example.org", undefined, "t2");
    expect(google.state("two@example.org")).toBe("expired");
    await signIn(google, answer, "t2b", "two@example.org");
    expect((await again).accessToken).toBe("t2b");
    // Aborted waits stop.
    const controller = new AbortController();
    const aborted = google.waitForToken("two@example.org", controller.signal, "t2b");
    controller.abort(new Error("gone"));
    await expect(aborted).rejects.toThrow("gone");
  });

  it("reports a closed window or a refusal", async () => {
    const { env, answer, fail } = environment();
    const google = new GoogleSignIn(env, "client");
    await google.prepare();
    const closed = google.signIn();
    fail({ type: "popup_closed" });
    await expect(closed).rejects.toThrow(/closed/);
    const refused = google.signIn();
    answer({ error: "access_denied" });
    await expect(refused).rejects.toThrow("access_denied");
    expect(google.state()).toBe("signed-out");
  });

  it("signs one account out (revoking its token, keeping it listed) and removes another", async () => {
    const { env, revoked, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    await google.prepare();
    await signIn(google, answer, "t1");
    await signIn(google, answer, "t2");
    await google.signOut("one@example.org");
    expect(revoked).toEqual(["t1"]);
    expect(google.state("one@example.org")).toBe("signed-out");
    expect(google.state("two@example.org")).toBe("signed-in");
    expect(google.accounts().map((a) => a.email)).toEqual(["one@example.org", "two@example.org"]);
    expect(google.defaultAccount()).toBe("one@example.org");
    await google.remove("one@example.org");
    expect(google.accounts().map((a) => a.email)).toEqual(["two@example.org"]);
    // The default moves to an account still here.
    expect(google.defaultAccount()).toBe("two@example.org");
    await google.remove("two@example.org");
    expect(revoked).toEqual(["t1", "t2"]);
    expect(google.state()).toBe("signed-out");
  });

  it("moves the single token of the first version into the accounts, as the default", () => {
    const { env, map, clock } = environment();
    map.set(OLD_TOKEN_KEY, JSON.stringify({ accessToken: "old", expiresAt: clock.now + HOUR, scope: STORAGE, email: "me@example.org" }));
    const google = new GoogleSignIn(env, "client");
    expect(google.accounts()).toEqual([{ email: "me@example.org", token: { accessToken: "old", expiresAt: clock.now + HOUR, scope: STORAGE } }]);
    expect(google.defaultAccount()).toBe("me@example.org");
    expect(google.token()?.accessToken).toBe("old");
    expect(map.has(OLD_TOKEN_KEY)).toBe(false);
    expect(JSON.parse(map.get(ACCOUNTS_KEY)!).default).toBe("me@example.org");
  });

  it("moves an old token without an email, which the next sign-in for it names", async () => {
    const { env, map, clock, requested, answer } = environment();
    map.set(OLD_TOKEN_KEY, JSON.stringify({ accessToken: "old", expiresAt: clock.now - 1, scope: STORAGE }));
    const google = new GoogleSignIn(env, "client");
    expect(google.accounts().map((a) => a.email)).toEqual([""]);
    expect(google.state()).toBe("expired");
    await google.prepare();
    await signIn(google, answer, "t1", "");
    // Its email unknown, Google's chooser is shown.
    expect(requested[0].overrides).toEqual({ prompt: "select_account" });
    expect(google.accounts().map((a) => a.email)).toEqual(["one@example.org"]);
    expect(google.defaultAccount()).toBe("one@example.org");
  });

  it("ignores a broken old token and follows changes made in another tab", () => {
    const { env, map, clock, otherTab } = environment();
    map.set(OLD_TOKEN_KEY, "{not json");
    const google = new GoogleSignIn(env, "client");
    expect(google.accounts()).toEqual([]);
    let changes = 0;
    google.onChanged(() => ++changes);
    map.set(ACCOUNTS_KEY, JSON.stringify({ default: "tab@example.org", accounts: [{ email: "tab@example.org", token: { accessToken: "tab", expiresAt: clock.now + HOUR, scope: "" } }] }));
    otherTab(ACCOUNTS_KEY);
    expect(changes).toBe(1);
    expect(google.token()?.accessToken).toBe("tab");
    otherTab("unrelated");
    expect(changes).toBe(1);
  });

  it("gives gs+google:// data the token of each bucket's account", async () => {
    const { env, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    await google.prepare();
    await signIn(google, answer, "t1");
    await signIn(google, answer, "t2");
    const rules: SignInRule[] = [{ prefix: "gs://bucket-b/", signIn: "google", account: "two@example.org" }];
    const tokens = googleTokens(google, { list: () => rules });
    expect(tokens.accountFor("gs://bucket-a/img/")).toBe("one@example.org");
    expect(tokens.accountFor("gs://bucket-b/img/")).toBe("two@example.org");
    expect(tokens.token(tokens.accountFor("gs://bucket-b/img/"))?.accessToken).toBe("t2");
    expect(tokens.token(tokens.accountFor("gs://bucket-a/img/"))?.accessToken).toBe("t1");
  });
});
