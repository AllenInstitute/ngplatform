/**
 * The Google sign-in against a fake browser: storage, a clock, and a fake
 * Google Identity Services whose token client answers when told to.
 */
import { describe, expect, it } from "vitest";
import { type GoogleEnvironment, type GoogleOAuth2, GoogleSignIn, type GoogleTokenResponse, googleProvider } from "../src/platform/google_auth.js";

const HOUR = 3600_000;

function environment() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  const clock = { now: 1_000_000 };
  const requested: { clientId: string; scope: string; overrides?: { prompt?: string; hint?: string } }[] = [];
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
      const auth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify(auth === "Bearer t1" || auth === "Bearer t2" ? { email: "me@example.org" } : {}));
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

  it("signs in from a click once the client is ready, keeping the token, its expiry and email", async () => {
    const { env, map, clock, requested, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    // Before Google's script is loaded, a click cannot open its window.
    await expect(google.signIn()).rejects.toThrow(/still loading/);
    await google.prepare();
    expect(google.ready()).toBe(true);
    const signingIn = google.signIn();
    expect(requested).toEqual([{ clientId: "client", scope: "openid email https://www.googleapis.com/auth/devstorage.read_only", overrides: {} }]);
    answer({ access_token: "t1", expires_in: 3599, scope: "openid email https://www.googleapis.com/auth/devstorage.read_only" });
    await signingIn;
    expect(google.token()).toEqual({ accessToken: "t1", expiresAt: clock.now + 3599_000, scope: expect.any(String), email: "me@example.org" });
    expect(JSON.parse(map.get("ngplatform.google.token")!).accessToken).toBe("t1");
    expect(google.state()).toBe("signed-in");
    expect(google.readsStorage()).toBe(true);
    const status = await (await googleProvider(google).services({ sources: [], manual: [] }))[0].status();
    expect(status).toMatchObject({ state: "signed-in", user: "me@example.org", detail: expect.stringMatching(/^until /) });
  });

  it("takes a token as expired a minute before Google's expiry, and renews it with the next click", async () => {
    const { env, clock, requested, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    await google.prepare();
    const first = google.signIn();
    answer({ access_token: "t1", expires_in: 3600, scope: "openid email" });
    await first;
    expect(google.readsStorage()).toBe(false);
    clock.now += HOUR - 59_000;
    expect(google.token()).toBeUndefined();
    expect(google.state()).toBe("expired");
    const renewing = google.signIn();
    // Renewing asks Google not to prompt, for the same account.
    expect(requested[1].overrides).toEqual({ prompt: "", hint: "me@example.org" });
    answer({ access_token: "t2", expires_in: 3600, scope: "openid email" });
    await renewing;
    expect(google.token()?.accessToken).toBe("t2");
  });

  it("makes data wait for a sign-in, saying it is needed, instead of opening a window", async () => {
    const { env, requested, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    let needed = 0;
    google.onNeeded(() => ++needed);
    const waiting = google.waitForToken();
    expect(needed).toBe(1);
    expect(requested).toEqual([]);
    await google.prepare();
    const signingIn = google.signIn();
    answer({ access_token: "t1", expires_in: 3600, scope: "" });
    await signingIn;
    expect((await waiting).accessToken).toBe("t1");
    // A token a server refused is expired until a new one comes.
    const again = google.waitForToken(undefined, "t1");
    expect(google.state()).toBe("expired");
    expect(google.stored()?.email).toBe("me@example.org");
    const renewing = google.signIn();
    answer({ access_token: "t2", expires_in: 3600, scope: "" });
    await renewing;
    expect((await again).accessToken).toBe("t2");
    // Aborted waits stop.
    const controller = new AbortController();
    const aborted = google.waitForToken(controller.signal, "t2");
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

  it("signs out by forgetting the token and revoking it", async () => {
    const { env, map, revoked, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    await google.prepare();
    const signingIn = google.signIn();
    answer({ access_token: "t1", expires_in: 3600, scope: "" });
    await signingIn;
    await google.signOut();
    expect(map.has("ngplatform.google.token")).toBe(false);
    expect(revoked).toEqual(["t1"]);
    expect(google.state()).toBe("signed-out");
  });

  it("follows a sign-in made in another tab", () => {
    const { env, map, clock, otherTab } = environment();
    const google = new GoogleSignIn(env, "client");
    let changes = 0;
    google.onChanged(() => ++changes);
    map.set("ngplatform.google.token", JSON.stringify({ accessToken: "tab", expiresAt: clock.now + HOUR, scope: "" }));
    otherTab("ngplatform.google.token");
    expect(changes).toBe(1);
    expect(google.token()?.accessToken).toBe("tab");
    otherTab("unrelated");
    expect(changes).toBe(1);
  });
});
