/**
 * Sign-in: the middleauth and ngauth providers against a fake browser
 * (fetch, storage, a sign-in window that posts its token), and the
 * registry with its lists.
 */
import { describe, expect, it, vi } from "vitest";
import { GOOGLE_SIGN_IN, PUBLIC_GS } from "../src/core/source_auth.js";
import {
  type AuthEnvironment,
  AuthRegistry,
  MIDDLEAUTH_TOKEN_PREFIX,
  middleauthApps,
  middleauthProvider,
  ngauthProvider,
  ngauthUses,
  normaliseServer,
} from "../src/platform/auth.js";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const LOGIN = "https://auth.example.org/sticky_auth";
const APP = "https://data.example.org";
const NGAUTH = "https://ngauth.example.org";
const HERE = "https://app.example.org";

function environment() {
  const storage = memoryStorage();
  const listeners = new Set<(e: MessageEvent) => void>();
  const opened: string[] = [];
  const popup = {
    closed: false,
    close() {
      popup.closed = true;
    },
  } as { closed: boolean; close(): void };
  const requests: { url: string; auth?: string }[] = [];
  /** Whether the ngauth server has its sign-in cookie. */
  const ngauth = { signedIn: false };
  const env: AuthEnvironment = {
    storage,
    origin: HERE,
    fetch: (async (input: string, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      requests.push({ url, auth });
      if (url === `${APP}/auth_info`) return new Response(JSON.stringify({ login_url: LOGIN }));
      if (url === `${NGAUTH}/token` && init?.method === "POST" && init.credentials === "include") {
        return ngauth.signedIn ? new Response("user-token") : new Response("Not logged in", { status: 401 });
      }
      if (url === `${LOGIN}/api/v1/user/cache`) {
        return auth === "Bearer good" ? new Response(JSON.stringify({ email: "me@example.org", name: "Me" })) : new Response("", { status: 401 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch,
    openWindow: (url) => {
      opened.push(url);
      return popup as unknown as Window;
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const post = (data: unknown, source: unknown = popup, origin = "") => {
    for (const l of [...listeners]) l({ data, source, origin } as MessageEvent);
  };
  return { env, storage, opened, popup, post, requests, ngauth };
}

describe("middleauth", () => {
  it("finds the sign-in server of each middleauth data source", async () => {
    expect(middleauthApps([`precomputed://middleauth+${APP}/seg`, "gs://public/x", `middleauth+${APP}/other|zarr:`])).toEqual([APP]);
    const { env } = environment();
    const services = await middleauthProvider(env).services({ sources: [`precomputed://middleauth+${APP}/seg`], manual: [] });
    expect(services.map((s) => [s.id, s.title, s.detail])).toEqual([[`middleauth:${LOGIN}`, "auth.example.org", `Sign-in for ${APP}`]]);
  });

  it("reports signed out, then signs in through the server's window and keeps the token where Neuroglancer looks", async () => {
    const { env, storage, opened, post } = environment();
    const [service] = await middleauthProvider(env).services({ sources: [`middleauth+${APP}/x`], manual: [] });
    expect((await service.status()).state).toBe("signed-out");
    const signingIn = service.signIn!();
    expect(opened).toEqual([`${LOGIN}/api/v1/authorize`]);
    // A message from elsewhere is ignored.
    post({ token: "bad" }, {});
    post({ token: "good", app_urls: [APP] });
    await signingIn;
    expect(JSON.parse(storage.getItem(MIDDLEAUTH_TOKEN_PREFIX + LOGIN)!)).toEqual({ tokenType: "Bearer", accessToken: "good", url: LOGIN, appUrls: [APP] });
    expect(await service.status()).toEqual({ state: "signed-in", user: "me@example.org", detail: undefined });
    await service.signOut!();
    expect(storage.getItem(MIDDLEAUTH_TOKEN_PREFIX + LOGIN)).toBeNull();
  });

  it("says when a token has expired, or is not approved for an app yet", async () => {
    const { env, storage } = environment();
    storage.setItem(MIDDLEAUTH_TOKEN_PREFIX + LOGIN, JSON.stringify({ tokenType: "Bearer", accessToken: "old", url: LOGIN, appUrls: [] }));
    const [service] = await middleauthProvider(env).services({ sources: [`middleauth+${APP}/x`], manual: [] });
    expect((await service.status()).state).toBe("expired");
    storage.setItem(MIDDLEAUTH_TOKEN_PREFIX + LOGIN, JSON.stringify({ tokenType: "Bearer", accessToken: "good", url: LOGIN, appUrls: [] }));
    expect((await service.status()).detail).toBe(`not yet approved for ${APP}`);
  });

  it("lists servers added by hand (an app or a sign-in server) and servers holding a token", async () => {
    const { env, storage } = environment();
    storage.setItem(MIDDLEAUTH_TOKEN_PREFIX + "https://other.example.org/auth", JSON.stringify({ accessToken: "x", appUrls: [] }));
    const services = await middleauthProvider(env).services({ sources: [], manual: [APP, "https://plain.example.org"] });
    expect(services.map((s) => [s.title, s.manual])).toEqual([
      ["auth.example.org", [APP]],
      ["other.example.org", []],
      ["plain.example.org", ["https://plain.example.org"]],
    ]);
  });

  it("fails clearly when the window is blocked or closed", async () => {
    const { env, popup } = environment();
    const [service] = await middleauthProvider({ ...env, openWindow: () => null }).services({ sources: [], manual: [LOGIN] });
    await expect(service.signIn!()).rejects.toThrow(/blocked/);
    const [again] = await middleauthProvider(env).services({ sources: [], manual: [LOGIN] });
    const signing = again.signIn!();
    popup.closed = true;
    await expect(signing).rejects.toThrow(/closed/);
  });
});

describe("ngauth", () => {
  it("finds the servers of gs+ngauth+https:// sources with their buckets, and those added by hand", async () => {
    expect([...ngauthUses([`precomputed://gs+ngauth+${NGAUTH}/bucket/seg`, `{"url":"gs+ngauth+${NGAUTH}/other/x"}`, "gs://public/x"])]).toEqual([
      [NGAUTH, new Set(["gs://bucket", "gs://other"])],
    ]);
    const { env } = environment();
    const provider = ngauthProvider(env);
    const services = await provider.services({ sources: [`gs+ngauth+${NGAUTH}/bucket/seg`], manual: ["https://typed.example.org/some/path"] });
    expect(services.map((s) => [s.id, s.manual])).toEqual([
      [`ngauth:${NGAUTH}`, []],
      ["ngauth:https://typed.example.org", ["https://typed.example.org/some/path"]],
    ]);
    expect(services[0].detail).toMatch(/gs:\/\/bucket/);
    expect(provider.sourceSignIns!({ sources: [`gs+ngauth+${NGAUTH}/bucket/seg`], manual: [] }).map((s) => s.id)).toEqual([`ngauth:${NGAUTH}`]);
  });

  it("asks the server whether its cookie signs in, and signs in through its login window", async () => {
    const { env, opened, post, ngauth } = environment();
    const [service] = await ngauthProvider(env).services({ sources: [], manual: [NGAUTH] });
    expect((await service.status()).state).toBe("signed-out");
    const signingIn = service.signIn!();
    expect(opened).toEqual([`${NGAUTH}/login?origin=${encodeURIComponent(HERE)}`]);
    // Only the server's own answer counts.
    post({ token: "x" }, undefined, "https://elsewhere.example.org");
    ngauth.signedIn = true;
    post({ token: "temporary" }, undefined, NGAUTH);
    await signingIn;
    expect((await service.status()).state).toBe("signed-in");
  });

  it("says when the server does not take this site", async () => {
    const { env, post } = environment();
    const [service] = await ngauthProvider(env).services({ sources: [], manual: [NGAUTH] });
    const signingIn = service.signIn!();
    post("badorigin", undefined, NGAUTH);
    await expect(signingIn).rejects.toThrow(/does not take sign-ins from https:\/\/app\.example\.org/);
  });
});

describe("the registry", () => {
  it("keeps servers added by hand, normalised, for the provider they were added for, and tells listeners", () => {
    const storage = memoryStorage();
    const auth = new AuthRegistry(storage);
    let changes = 0;
    auth.onChanged(() => ++changes);
    const off = auth.register({ id: "p", title: "P", accepts: () => true, services: async () => [] });
    const other = auth.register({ id: "q", title: "Q", accepts: (s) => s.includes("q."), services: async () => [] });
    expect(auth.addManual("data.example.org/")).toBe("p");
    auth.addManual("middleauth+https://data.example.org");
    expect(auth.addManual("https://q.example.org", "q")).toBe("q");
    expect(auth.manual("p")).toEqual(["https://data.example.org"]);
    expect(auth.manual("q")).toEqual(["https://q.example.org"]);
    expect(auth.accepting("q.example.org").map((p) => p.id)).toEqual(["p", "q"]);
    auth.removeManual("https://data.example.org");
    expect(auth.manual("p")).toEqual([]);
    expect(() => auth.addManual("ftp://x")).toThrow();
    expect(() => auth.addManual("https://data.example.org", "q")).toThrow(/No sign-in method/);
    expect(() => auth.register({ id: "p", title: "again", services: async () => [] })).toThrow();
    off();
    other();
    expect(auth.list()).toEqual([]);
    expect(changes).toBe(8);
  });

  it("reads servers added before they named their provider as middleauth's", () => {
    const storage = memoryStorage();
    storage.setItem("ngplatform.auth.servers", JSON.stringify(["https://cave.example.org"]));
    expect(new AuthRegistry(storage).manual("middleauth")).toEqual(["https://cave.example.org"]);
  });

  it("lists the ways a layer can read its data: anonymously, then each provider's sign-ins", () => {
    const storage = memoryStorage();
    const auth = new AuthRegistry(storage);
    const { env } = environment();
    auth.register({ id: "google", title: "Google", sourceSignIns: () => [GOOGLE_SIGN_IN], services: async () => [] });
    auth.register(middleauthProvider(env));
    auth.register(ngauthProvider(env));
    // A plugin's that fails is left out, and logged.
    auth.register({ id: "broken", title: "Broken", sourceSignIns: () => { throw new Error("no"); }, services: async () => [] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    auth.addManual(NGAUTH, "ngauth");
    const list = auth.sourceSignIns([`gs+ngauth+https://other.example.org/b/x`]);
    expect(list.map((s) => [s.storage, s.id])).toEqual([
      ["gs", "public"],
      ["http", "public"],
      ["gs", "google"],
      ["http", "middleauth"],
      ["gs", `ngauth:${NGAUTH}`],
      ["gs", "ngauth:https://other.example.org"],
    ]);
    expect(list[0]).toBe(PUBLIC_GS);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("normalises addresses", () => {
    expect(normaliseServer(" https://a.org/x/ ")).toBe("https://a.org/x");
    expect(normaliseServer("a.org")).toBe("https://a.org");
    expect(normaliseServer("")).toBeUndefined();
    // Not addresses, though a browser's URL parser may take them.
    expect(normaliseServer("not a url")).toBeUndefined();
    expect(normaliseServer("https://bad_host!/")).toBeUndefined();
    expect(normaliseServer("http://localhost:8080/auth")).toBe("http://localhost:8080/auth");
    expect(normaliseServer("http://[::1]:9000")).toBe("http://[::1]:9000");
  });
});
