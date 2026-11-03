/**
 * The credentials behind gs+google://: each store's bucket and folder get
 * their account's token, a 401 expires only that account, a 403 asks once
 * more (a rule may have changed) and then says which account was refused,
 * and an answer older than RECHECK_MS is asked for again.
 */
import { describe, expect, it, vi } from "vitest";
import type { SignInRule } from "../src/core/sign_in_rules.js";
import { GoogleCredentialsProvider, type GoogleTokens } from "../src/engine/google_credentials.js";
import { fetchWithGoogle, folderOf, type GoogleCredentials, RECHECK_MS } from "../src/engine/google_gcs.js";
import { googleAccountFor } from "../src/core/sign_in_rules.js";

// Neuroglancer's status line needs a page; here it says nothing.
vi.mock("neuroglancer/unstable/status.js", () => ({
  StatusMessage: class {
    element = { append() {} };
    setText() {}
    dispose() {}
  },
}));

function tokens(rules: SignInRule[]) {
  const good = new Map<string, string>([
    ["one@example.org", "t1"],
    ["two@example.org", "t2"],
  ]);
  const t: GoogleTokens & { good: Map<string, string>; invalid: string[] } = {
    good,
    invalid: [],
    accountFor: (url) => googleAccountFor(rules, url, "one@example.org"),
    token: (account) => {
      const token = good.get(account ?? "one@example.org");
      return token === undefined ? undefined : { accessToken: token, email: account };
    },
    waitForToken: () => new Promise(() => {}),
    markInvalid: (token) => {
      t.invalid.push(token);
      for (const [a, v] of good) if (v === token) good.delete(a);
    },
    // No client ID: the status line offers no button (there is no page here).
    clientId: () => undefined,
    signIn: async () => undefined,
  };
  return t;
}

describe("gs+google:// credentials", () => {
  it("asks per folder", () => {
    expect(folderOf("img/0/1_2_3")).toBe("img/0/");
    expect(folderOf("info")).toBe("");
  });

  it("answers each bucket with its rule's account, else the default, at each request", async () => {
    const rules: SignInRule[] = [{ prefix: "gs://bucket-b/", signIn: "google", account: "two@example.org" }];
    const t = tokens(rules);
    const a = new GoogleCredentialsProvider(t, { bucket: "bucket-a", path: "img/" });
    const b = new GoogleCredentialsProvider(t, { bucket: "bucket-b", path: "img/" });
    expect((await a.get()).credentials.accessToken).toBe("t1");
    expect((await b.get()).credentials.accessToken).toBe("t2");
    // A rule changed: the next request follows it.
    rules[0] = { prefix: "gs://bucket-b/", signIn: "google", account: "one@example.org" };
    expect((await b.get()).credentials.accessToken).toBe("t1");
  });

  it("expires only the refused account on a 401, and not at all on a 403", async () => {
    const rules: SignInRule[] = [{ prefix: "gs://bucket-b/", signIn: "google", account: "two@example.org" }];
    const t = tokens(rules);
    const b = new GoogleCredentialsProvider(t, { bucket: "bucket-b", path: "" });
    const first = await b.get();
    const forbidden = await b.get({ generation: first.generation, credentials: { ...first.credentials, refused: 403 } });
    expect(forbidden.credentials.accessToken).toBe("t2");
    expect(t.invalid).toEqual([]);
    const stale = await b.get({ generation: first.generation, credentials: { ...first.credentials, refused: "stale" } });
    expect(stale.credentials.accessToken).toBe("t2");
    let settled = false;
    void b.get({ generation: first.generation, credentials: { ...first.credentials, refused: 401 } }).then(() => (settled = true));
    await Promise.resolve();
    expect(t.invalid).toEqual(["t2"]);
    expect(t.good.has("one@example.org")).toBe(true);
    // Account two now waits for its sign-in.
    expect(settled).toBe(false);
  });
});

describe("fetching with an account's token", () => {
  function provider(answers: string[]) {
    const asked: (GoogleCredentials["refused"] | undefined)[] = [];
    let generation = 0;
    let now = 0;
    const p = {
      asked,
      setNow: (n: number) => (now = n),
      now: () => now,
      get: async (invalid?: { credentials: GoogleCredentials }) => {
        asked.push(invalid?.credentials.refused);
        const token = answers[Math.min(asked.length - 1, answers.length - 1)];
        return { generation: ++generation, credentials: { tokenType: "Bearer", accessToken: token, email: `${token}@example.org`, checkAfter: now + RECHECK_MS } };
      },
    };
    return p;
  }

  it("asks again after a 403 and uses another account's token when a rule now names it", async () => {
    const p = provider(["t1", "t2"]);
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization")!;
      seen.push(auth);
      return new Response("x", { status: auth === "Bearer t2" ? 200 : 403 });
    });
    const fetchOk = fetchWithGoogle(p as never, p.now);
    const r = await fetchOk("https://storage.googleapis.com/x");
    expect(r.status).toBe(200);
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
    expect(p.asked).toEqual([undefined, 403]);
    vi.unstubAllGlobals();
  });

  it("gives up on a second 403 with the same token, naming the account", async () => {
    const p = provider(["t1"]);
    vi.stubGlobal("fetch", async () => new Response("no", { status: 403 }));
    const fetchOk = fetchWithGoogle(p as never, p.now);
    await expect(fetchOk("https://storage.googleapis.com/x")).rejects.toThrow(/t1@example.org.*may not read this/);
    expect(p.asked).toEqual([undefined, 403]);
    vi.unstubAllGlobals();
  });

  it("asks again before a request once an answer is older than RECHECK_MS", async () => {
    const p = provider(["t1"]);
    vi.stubGlobal("fetch", async () => new Response("ok"));
    // The provider's answer (cached in a worker) says when to check again.
    const cached = await p.get();
    const stale = { get: async (invalid?: { credentials: GoogleCredentials }) => (invalid === undefined ? cached : p.get(invalid)) };
    p.asked.length = 0;
    p.setNow(RECHECK_MS + 1);
    await fetchWithGoogle(stale as never, p.now)("https://storage.googleapis.com/x");
    expect(p.asked).toEqual(["stale"]);
    vi.unstubAllGlobals();
  });
});
