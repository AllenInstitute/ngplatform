/**
 * Sign-in rules: matching an address (longest prefix, gs vs https, trailing
 * slashes), the Google account per bucket, rewriting sources by rule, the
 * service worker's token table, the rules kept in this browser, and rules
 * applied to layers as they appear.
 */
import { describe, expect, it } from "vitest";
import {
  bucketPrefix,
  covers,
  googleAccountFor,
  googleTokenTable,
  normalisePrefix,
  plainAddress,
  ruleFor,
  type SignInRule,
  sourceWithRules,
  tokenFromTable,
} from "../src/core/sign_in_rules.js";
import { GOOGLE_SIGN_IN, MIDDLEAUTH_SIGN_IN, ngauthSignIn, PUBLIC_GS, PUBLIC_HTTP } from "../src/core/source_auth.js";
import type { Json } from "../src/core/workspace.js";
import { applyRulesToNewLayers, RULES_KEY, SignInRules } from "../src/platform/sign_in_rules.js";

const ALL = [PUBLIC_GS, PUBLIC_HTTP, GOOGLE_SIGN_IN, MIDDLEAUTH_SIGN_IN, ngauthSignIn("https://ngauth.example.org")];

function memory() {
  const map = new Map<string, string>();
  return { map, storage: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) } };
}

describe("rule addresses", () => {
  it("normalises a prefix typed in to a plain address ending in a slash", () => {
    expect(normalisePrefix("gs://bucket")).toBe("gs://bucket/");
    expect(normalisePrefix("gs://bucket/")).toBe("gs://bucket/");
    expect(normalisePrefix("  gs://Bucket/path  ")).toBe("gs://bucket/path/");
    expect(normalisePrefix("my-bucket")).toBe("gs://my-bucket/");
    expect(normalisePrefix("gs+google://b/p.zarr|zarr3:")).toBe("gs://b/p.zarr/");
    expect(normalisePrefix("gs+ngauth+https://ngauth.example.org/b/p")).toBe("gs://b/p/");
    expect(normalisePrefix("precomputed://gs://b/img")).toBe("gs://b/img/");
    expect(normalisePrefix("HTTPS://Host.Example.org/data?x=1")).toBe("https://host.example.org/data/");
    expect(normalisePrefix("middleauth+https://cave.example.org/seg")).toBe("https://cave.example.org/seg/");
    expect(normalisePrefix("https://host.example.org")).toBe("https://host.example.org/");
    expect(normalisePrefix("ftp://x/")).toBeUndefined();
    expect(normalisePrefix("")).toBeUndefined();
  });

  it("reduces any source to the plain address rules compare", () => {
    expect(plainAddress("zarr://gs+google://b/x.zarr/|zarr3:")).toBe("gs://b/x.zarr/");
    expect(plainAddress("gs://b")).toBe("gs://b/");
    expect(plainAddress("local://annotations")).toBeUndefined();
  });

  it("covers a folder and what is under it, never a longer name beside it", () => {
    expect(covers("gs://b/path/", "gs://b/path")).toBe(true);
    expect(covers("gs://b/path/", "gs://b/path/")).toBe(true);
    expect(covers("gs://b/path/", "gs://b/path/x/y.zarr")).toBe(true);
    expect(covers("gs://b/pa/", "gs://b/path/x")).toBe(false);
    expect(covers("gs://bucket/", "gs://bucket-2/x")).toBe(false);
  });

  it("picks the rule with the longest prefix, by kind of storage", () => {
    const rules: SignInRule[] = [
      { prefix: "gs://b/", signIn: "google", account: "one@example.org" },
      { prefix: "gs://b/private/", signIn: "google", account: "two@example.org" },
      { prefix: "gs://b/private/open/", signIn: "public" },
      { prefix: "https://b/", signIn: "middleauth" },
    ];
    expect(ruleFor(rules, "gs://b/x")?.account).toBe("one@example.org");
    expect(ruleFor(rules, "precomputed://gs+google://b/private/img")?.account).toBe("two@example.org");
    expect(ruleFor(rules, "gs://b/private/open/img")?.signIn).toBe("public");
    expect(ruleFor(rules, "gs://b/privatex/img")?.account).toBe("one@example.org");
    // gs://b/ is a bucket; https://b/ a web server: neither covers the other.
    expect(ruleFor(rules, "https://b/data")?.signIn).toBe("middleauth");
    expect(ruleFor(rules, "https://storage.googleapis.com/b/x")).toBeUndefined();
    expect(ruleFor(rules, "gs://c/x")).toBeUndefined();
    // The order rules are listed in does not matter.
    expect(ruleFor([...rules].reverse(), "gs://b/private/img")?.account).toBe("two@example.org");
  });

  it("chooses the Google account per bucket: its rule's, else the default", () => {
    const rules: SignInRule[] = [
      { prefix: "gs://bucket-a/", signIn: "google", account: "one@example.org" },
      { prefix: "gs://bucket-b/", signIn: "google", account: "two@example.org" },
      { prefix: "gs://bucket-c/", signIn: "google" },
      { prefix: "gs://bucket-d/", signIn: "public" },
    ];
    expect(googleAccountFor(rules, "gs://bucket-a/img/", "def@example.org")).toBe("one@example.org");
    expect(googleAccountFor(rules, "gs://bucket-b/", "def@example.org")).toBe("two@example.org");
    expect(googleAccountFor(rules, "gs://bucket-c/x/", "def@example.org")).toBe("def@example.org");
    expect(googleAccountFor(rules, "gs://bucket-d/x/", "def@example.org")).toBe("def@example.org");
    expect(googleAccountFor(rules, "gs://elsewhere/", "def@example.org")).toBe("def@example.org");
    expect(googleAccountFor(rules, "gs://elsewhere/", undefined)).toBeUndefined();
  });

  it("names a bucket or a host for Use for all of", () => {
    expect(bucketPrefix("precomputed://gs+google://b/x/y")).toBe("gs://b/");
    expect(bucketPrefix("middleauth+https://cave.example.org/seg/table")).toBe("https://cave.example.org/");
  });
});

describe("rewriting sources by rule", () => {
  const rules: SignInRule[] = [
    { prefix: "gs://a/", signIn: "google", account: "one@example.org" },
    { prefix: "gs://a/open/", signIn: "public" },
    { prefix: "gs://n/", signIn: "ngauth:https://ngauth.example.org" },
    { prefix: "https://cave.example.org/", signIn: "middleauth" },
  ];

  it("gives each URL its rule's scheme, keeping the rest of the source", () => {
    expect(sourceWithRules("precomputed://gs://a/img", rules, ALL)).toBe("precomputed://gs+google://a/img");
    expect(sourceWithRules("gs+google://a/open/img.zarr/|zarr3:", rules, ALL)).toBe("gs://a/open/img.zarr/|zarr3:");
    expect(sourceWithRules("gs://n/x", rules, ALL)).toBe("gs+ngauth+https://ngauth.example.org/n/x");
    expect(sourceWithRules({ url: "https://cave.example.org/seg", transform: 1 }, rules, ALL)).toEqual({ url: "middleauth+https://cave.example.org/seg", transform: 1 });
    expect(sourceWithRules(["gs://a/x", "gs://other/y"], rules, ALL)).toEqual(["gs+google://a/x", "gs://other/y"]);
  });

  it("returns the same object when no rule changes it", () => {
    const source = { url: "gs+google://a/x" };
    expect(sourceWithRules(source, rules, ALL)).toBe(source);
    expect(sourceWithRules("local://annotations", rules, ALL)).toBe("local://annotations");
  });

  it("makes an ngauth server a rule names even when no source lists it yet", () => {
    expect(sourceWithRules("gs://n/x", rules, [PUBLIC_GS, GOOGLE_SIGN_IN])).toBe("gs+ngauth+https://ngauth.example.org/n/x");
  });
});

describe("the service worker's tokens", () => {
  it("picks the token of the bucket's account, the longest prefix first", () => {
    const rules: SignInRule[] = [
      { prefix: "gs://bucket-a/", signIn: "google", account: "one@example.org" },
      { prefix: "gs://bucket-b/", signIn: "google", account: "two@example.org" },
      { prefix: "gs://bucket-b/shared/", signIn: "google", account: "one@example.org" },
      { prefix: "gs://bucket-c/", signIn: "public" },
    ];
    const tokens: Record<string, string> = { "one@example.org": "t1", "two@example.org": "t2" };
    const table = googleTokenTable(rules, "t0", (a) => tokens[a]);
    expect(table.rules).toHaveLength(3);
    expect(tokenFromTable(table, "bucket-a", "img/0/0")).toBe("t1");
    expect(tokenFromTable(table, "bucket-b", "img/info")).toBe("t2");
    expect(tokenFromTable(table, "bucket-b", "shared/img/info")).toBe("t1");
    expect(tokenFromTable(table, "bucket-c", "x")).toBe("t0");
    expect(tokenFromTable(table, "bucket-ab", "x")).toBe("t0");
    // An account that is signed out has no token: its bucket waits rather than using another's.
    expect(tokenFromTable(googleTokenTable(rules, "t0", () => undefined), "bucket-a", "x")).toBeNull();
  });
});

describe("rules kept in this browser", () => {
  it("adds, replaces by prefix, removes, and follows other tabs", () => {
    const { map, storage } = memory();
    let other: ((key: string | null) => void) | undefined;
    const rules = new SignInRules(storage, (listener) => {
      other = listener;
      return () => {};
    });
    let changes = 0;
    rules.onChanged(() => ++changes);
    expect(rules.set({ prefix: "gs://b", signIn: "google", account: "one@example.org" })).toEqual({ prefix: "gs://b/", signIn: "google", account: "one@example.org" });
    rules.set({ prefix: "gs://b/", signIn: "google", account: "two@example.org" });
    rules.set({ prefix: "https://cave.example.org", signIn: "middleauth", account: "ignored" });
    expect(rules.list()).toEqual([
      { prefix: "gs://b/", signIn: "google", account: "two@example.org" },
      { prefix: "https://cave.example.org/", signIn: "middleauth" },
    ]);
    expect(() => rules.set({ prefix: "ftp://x", signIn: "public" })).toThrow(/Not a bucket/);
    rules.remove("gs://b/");
    expect(rules.list().map((r) => r.prefix)).toEqual(["https://cave.example.org/"]);
    expect(changes).toBe(4);
    map.set(RULES_KEY, JSON.stringify([{ prefix: "gs://x/", signIn: "public" }, { junk: 1 }]));
    other!(RULES_KEY);
    expect(changes).toBe(5);
    expect(rules.list()).toEqual([{ prefix: "gs://x/", signIn: "public" }]);
  });
});

describe("rules applied to layers as they appear", () => {
  function fakeStore(layers: Json[]) {
    const listeners = new Set<() => void>();
    const store = {
      ngState: { layers } as Json,
      opened: 0,
      calls: [] as Map<string, unknown>[],
      ng: () => store.ngState,
      state: () => ({ activeScene: "s1" }),
      onChange: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      setLayerSources: (sources: Map<string, unknown>) => {
        store.calls.push(sources);
        store.ngState = { layers: (store.ngState.layers as Json[]).map((l) => (sources.has(l.name as string) ? { ...l, source: sources.get(l.name as string) } : l)) };
        listeners.forEach((l) => l());
      },
      change: (next: Json[]) => {
        store.ngState = { layers: next };
        listeners.forEach((l) => l());
      },
    };
    return store;
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("applies to the layers a workspace opens with and to a layer added, once each", async () => {
    const { storage } = memory();
    const rules = new SignInRules(storage);
    rules.set({ prefix: "gs://bucket-a/", signIn: "google", account: "one@example.org" });
    const store = fakeStore([
      { name: "a", source: "precomputed://gs://bucket-a/img" },
      { name: "other", source: "gs://elsewhere/x" },
    ]);
    applyRulesToNewLayers(store, rules, () => ALL);
    await tick();
    expect(store.calls).toHaveLength(1);
    expect([...store.calls[0]]).toEqual([["a", "precomputed://gs+google://bucket-a/img"]]);
    // A layer added from bucket A picks up the rule.
    store.change([...(store.ngState.layers as Json[]), { name: "a2", source: "zarr://gs://bucket-a/two.zarr" }]);
    await tick();
    expect(store.calls).toHaveLength(2);
    expect([...store.calls[1]]).toEqual([["a2", "zarr://gs+google://bucket-a/two.zarr"]]);
    // The user choosing None for it afterwards is kept (the dataset was seen)...
    store.change((store.ngState.layers as Json[]).map((l) => (l.name === "a2" ? { ...l, source: "zarr://gs://bucket-a/two.zarr" } : l)));
    await tick();
    expect(store.calls).toHaveLength(2);
    // ...until the workspace is opened again.
    store.opened++;
    store.change(store.ngState.layers as Json[]);
    await tick();
    expect(store.calls).toHaveLength(3);
    expect([...store.calls[2]]).toEqual([["a2", "zarr://gs+google://bucket-a/two.zarr"]]);
  });
});
