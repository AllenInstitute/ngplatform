/**
 * Sign-in: the middleauth provider against a fake browser (fetch, storage,
 * a sign-in window that posts its token), and the registry.
 */
import { describe, expect, it } from "vitest";
import { type AuthEnvironment, AuthRegistry, MIDDLEAUTH_TOKEN_PREFIX, middleauthApps, middleauthProvider, normaliseServer } from "../src/platform/auth.js";

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
  const env: AuthEnvironment = {
    storage,
    fetch: (async (input: string, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      requests.push({ url, auth });
      if (url === `${APP}/auth_info`) return new Response(JSON.stringify({ login_url: LOGIN }));
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
  const post = (data: unknown, source: unknown = popup) => {
    for (const l of [...listeners]) l({ data, source } as MessageEvent);
  };
  return { env, storage, opened, popup, post, requests };
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

describe("the registry", () => {
  it("keeps servers added by hand, normalised, and tells listeners", () => {
    const storage = memoryStorage();
    const auth = new AuthRegistry(storage);
    let changes = 0;
    auth.onChanged(() => ++changes);
    const off = auth.register({ id: "p", title: "P", accepts: () => true, services: async () => [] });
    auth.addManual("data.example.org/");
    auth.addManual("middleauth+https://data.example.org");
    expect(auth.manual()).toEqual(["https://data.example.org"]);
    auth.removeManual("https://data.example.org");
    expect(auth.manual()).toEqual([]);
    expect(() => auth.addManual("ftp://x")).toThrow();
    expect(() => auth.register({ id: "p", title: "again", services: async () => [] })).toThrow();
    off();
    expect(auth.list()).toEqual([]);
    expect(changes).toBe(5);
  });

  it("normalises addresses", () => {
    expect(normaliseServer(" https://a.org/x/ ")).toBe("https://a.org/x");
    expect(normaliseServer("a.org")).toBe("https://a.org");
    expect(normaliseServer("")).toBeUndefined();
  });
});
