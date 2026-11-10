/**
 * Security and release: the Content Security Policy and the page it goes
 * in, the debugging objects kept off production pages, the Google tokens
 * kept in the tab, the runner's version checked, the files the service
 * worker keeps for the app to open offline, the build's facts for About,
 * and the Neuroglancer pin.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, CSP_DIRECTIVES } from "../src/platform/csp.js";
import { debugGlobalsAllowed, exposeForDebugging } from "../src/platform/debug.js";
import { ACCOUNTS_KEY, type GoogleEnvironment, GoogleSignIn, TOKENS_KEY } from "../src/platform/google_auth.js";
import { compareVersions, MIN_RUNNER_VERSION, runnerVersionWarning } from "../src/platform/runner.js";
import { type BuiltFile, shellFiles, shellPageKey, shellRequest } from "../src/sw_parts.js";
import { buildFacts } from "../src/ui/about.js";
// @ts-expect-error: a plain script, without type declarations.
import { neuroglancerCheck } from "../scripts/neuroglancer_pin.mjs";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("the Content Security Policy", () => {
  const directive = (name: string) => CSP_DIRECTIVES[name].sources;

  it("runs no inline script and no plugin content, and keeps the page's base", () => {
    expect(directive("script-src")).not.toContain("'unsafe-inline'");
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'self'"]);
    expect(directive("default-src")).toEqual(["'self'"]);
    expect(directive("font-src")).not.toContain("https:");
  });

  it("allows what the app needs: WebAssembly, workers, data from any https server, the runner over http", () => {
    expect(directive("script-src")).toEqual(expect.arrayContaining(["'self'", "'wasm-unsafe-eval'", "'unsafe-eval'", "blob:", "https:"]));
    expect(directive("worker-src")).toEqual(expect.arrayContaining(["'self'", "blob:"]));
    expect(directive("connect-src")).toEqual(expect.arrayContaining(["https:", "http:", "blob:", "data:"]));
    for (const { why } of Object.values(CSP_DIRECTIVES)) expect(why.length).toBeGreaterThan(10);
  });

  it("is one header value, a directive each", () => {
    const policy = contentSecurityPolicy();
    expect(policy.split("; ")).toHaveLength(Object.keys(CSP_DIRECTIVES).length);
    expect(policy).toMatch(/^default-src 'self'; script-src 'self' /);
  });

  it("governs a page with no inline script, no remote style or font, and a loading screen", () => {
    const html = read("index.html");
    // The one script is the entry module, by its file.
    expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script type="module" src="./src/main.ts">']);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(html).toMatch(/<div id="boot" class="boot"/);
    expect(read("public/fonts/plex.css")).not.toMatch(/https?:/);
  });
});

describe("the debugging objects on window", () => {
  const env = { dev: false, search: "", webdriver: false };

  it("are kept off a production page unless asked for", () => {
    expect(debugGlobalsAllowed(env)).toBe(false);
    expect(debugGlobalsAllowed({ ...env, search: "?debug" })).toBe(true);
    expect(debugGlobalsAllowed({ ...env, search: "?x=1&debug=1" })).toBe(true);
    expect(debugGlobalsAllowed({ ...env, search: "?debugger" })).toBe(false);
    expect(debugGlobalsAllowed({ ...env, dev: true })).toBe(true);
    // The smoke test and the style audit (Playwright) reach the app through them.
    expect(debugGlobalsAllowed({ ...env, webdriver: true })).toBe(true);
  });

  it("are put there only when allowed", () => {
    const g = globalThis as Record<string, unknown>;
    expect(exposeForDebugging("ngpTestGlobal", 1, env)).toBe(false);
    expect(g.ngpTestGlobal).toBeUndefined();
    expect(exposeForDebugging("ngpTestGlobal", 2, { ...env, search: "?debug" })).toBe(true);
    expect(g.ngpTestGlobal).toBe(2);
    delete g.ngpTestGlobal;
  });
});

describe("Google tokens kept in the tab", () => {
  const HOUR = 3600_000;
  function storage() {
    const map = new Map<string, string>();
    return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
  }
  function environment(browser = storage(), tab = storage()) {
    let answer: ((r: { access_token?: string; expires_in?: number; scope?: string }) => void) | undefined;
    const env: GoogleEnvironment = {
      storage: browser,
      tokenStorage: tab,
      now: () => 1_000_000,
      fetch: (async () => new Response(JSON.stringify({ email: "one@example.org" }))) as unknown as typeof fetch,
      loadClient: async () => ({
        initTokenClient: (config) => {
          answer = config.callback;
          return { requestAccessToken: () => {} };
        },
        revoke: (_t, done) => done?.(),
      }),
      onStorage: () => () => {},
    };
    return { env, browser, tab, answer: (r: Parameters<NonNullable<typeof answer>>[0]) => answer!(r) };
  }

  it("keeps the account in the browser and its token only in the tab", async () => {
    const { env, browser, tab, answer } = environment();
    const google = new GoogleSignIn(env, "client");
    await google.prepare();
    const signing = google.signIn();
    answer({ access_token: "t1-secret", expires_in: 3600, scope: "openid" });
    await signing;
    expect(google.token()?.accessToken).toBe("t1-secret");
    expect(browser.map.get(ACCOUNTS_KEY)).not.toContain("t1-secret");
    expect(JSON.parse(browser.map.get(ACCOUNTS_KEY)!)).toEqual({ default: "one@example.org", accounts: [{ email: "one@example.org" }] });
    expect(tab.map.get(TOKENS_KEY)).toContain("t1-secret");
    // Another tab (or this one reopened): the account is known, its token is not.
    const other = new GoogleSignIn(environment(browser).env, "client");
    expect(other.accounts().map((a) => a.email)).toEqual(["one@example.org"]);
    expect(other.token()).toBeUndefined();
    expect(other.state()).toBe("signed-out");
  });

  it("moves a token an earlier version kept in the browser into the tab", () => {
    const { env, browser, tab } = environment();
    browser.setItem(ACCOUNTS_KEY, JSON.stringify({ default: "a@x.org", accounts: [{ email: "a@x.org", token: { accessToken: "old", expiresAt: 1_000_000 + HOUR, scope: "" } }] }));
    const google = new GoogleSignIn(env, "client");
    expect(google.token()?.accessToken).toBe("old");
    expect(browser.map.get(ACCOUNTS_KEY)).not.toContain("old");
    expect(tab.map.get(TOKENS_KEY)).toContain("old");
  });

  it("drops the tab's token when the account signs out", async () => {
    const { env, tab } = environment();
    const google = new GoogleSignIn(env, "client");
    tab.setItem(TOKENS_KEY, JSON.stringify({ "one@example.org": { accessToken: "t", expiresAt: 1_000_000 + HOUR, scope: "" } }));
    env.storage.setItem(ACCOUNTS_KEY, JSON.stringify({ default: "one@example.org", accounts: [{ email: "one@example.org" }] }));
    expect(google.token()?.accessToken).toBe("t");
    await google.signOut("one@example.org");
    expect(tab.map.has(TOKENS_KEY)).toBe(false);
  });
});

describe("the runner's version", () => {
  it("compares versions by their numbers", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.0.9", "0.1.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
    expect(compareVersions("0.2.0-dev1", "0.2.0")).toBe(0);
  });

  it("warns of a runner older than the app needs, in plain words with what to do", () => {
    expect(runnerVersionWarning(MIN_RUNNER_VERSION)).toBeUndefined();
    expect(runnerVersionWarning("9.0.0")).toBeUndefined();
    const warning = runnerVersionWarning("0.0.5", "0.1.0")!;
    expect(warning).toMatch(/0\.0\.5.*older than this app needs \(0\.1\.0 or later\)/);
    expect(warning).toMatch(/start it again/);
    expect(runnerVersionWarning(undefined)).toMatch(/unknown version/);
  });

  it("asks no more than the runner in this repository is", () => {
    const runner = /__version__ = "([^"]+)"/.exec(read("runner/ngplatform_runner/__init__.py"))![1];
    expect(compareVersions(runner, MIN_RUNNER_VERSION)).toBeGreaterThanOrEqual(0);
  });
});

describe("the app shell kept by the service worker", () => {
  const scope = "https://example.org/app/";

  it("keeps the app's pages and built files, not data or the dev server's modules", () => {
    const at = (path: string, mode = "cors") => shellRequest(new URL(path, scope), scope, mode);
    expect(at("./", "navigate")).toBe("page");
    expect(at("./index.html?x=1", "navigate")).toBe("page");
    expect(at("./neuroglancer.html", "navigate")).toBe("page");
    expect(at("./assets/main-abc.js")).toBe("asset");
    expect(at("./assets/jxl_decoder-x.wasm")).toBe("asset");
    expect(at("./fonts/IBMPlexSans-latin.woff2")).toBe("asset");
    expect(at("./assets/main-abc.js.map")).toBeUndefined();
    expect(at("./local/abc/brain.nii.gz")).toBeUndefined();
    expect(at("./data/brain.zarr/zarr.json")).toBeUndefined();
    expect(at("./src/main.ts")).toBeUndefined();
    expect(at("./other.html", "navigate")).toBeUndefined();
    expect(shellRequest(new URL("https://example.org/assets/x.js"), scope, "cors")).toBeUndefined();
    expect(shellRequest(new URL("https://cdn.example/app/assets/x.js"), scope, "cors")).toBeUndefined();
  });

  it("keeps ./ and ./index.html as one page", () => {
    expect(shellPageKey(new URL("./", scope), scope)).toBe(`${scope}index.html`);
    expect(shellPageKey(new URL("./index.html?debug", scope), scope)).toBe(`${scope}index.html`);
    expect(shellPageKey(new URL("./neuroglancer.html", scope), scope)).toBe(`${scope}neuroglancer.html`);
  });

  it("precaches the startup code, its styles and Neuroglancer's workers, not every plugin", () => {
    const files: BuiltFile[] = [
      { fileName: "assets/main-1.js", type: "chunk", isEntry: true, facadeModuleId: "/x/index.html", imports: ["assets/viewer-2.js"], css: ["assets/main-1.css"] },
      { fileName: "assets/viewer-2.js", type: "chunk", imports: ["assets/main-1.js"], css: ["assets/viewer-2.css"] },
      { fileName: "assets/register_default-3.js", type: "chunk", isDynamicEntry: true, facadeModuleId: "/x/plugins/zarr-vectors/src/register_default.ts", imports: ["assets/store-4.js"] },
      { fileName: "assets/store-4.js", type: "chunk" },
      { fileName: "assets/plugin-5.js", type: "chunk", isDynamicEntry: true, facadeModuleId: "/x/plugins/luxar/plugin.ts" },
      { fileName: "assets/plain-6.js", type: "chunk", isEntry: true, facadeModuleId: "/x/neuroglancer.html" },
      { fileName: "assets/chunk_worker.bundle-7.js", type: "asset" },
      { fileName: "assets/async_worker-8.js", type: "asset" },
      { fileName: "assets/luxar_worker-9.js", type: "asset" },
    ];
    expect(shellFiles(files, ["favicon.svg"])).toEqual([
      "./",
      "assets/async_worker-8.js",
      "assets/chunk_worker.bundle-7.js",
      "assets/main-1.css",
      "assets/main-1.js",
      "assets/register_default-3.js",
      "assets/store-4.js",
      "assets/viewer-2.css",
      "assets/viewer-2.js",
      "favicon.svg",
      "index.html",
    ]);
  });
});

describe("the build's facts", () => {
  it("names the version, the commits and when", () => {
    const facts = Object.fromEntries(
      buildFacts({ version: "1.2.3", commit: "abcdef012345", date: "2026-11-10T12:00:00.000Z", neuroglancer: { commit: "435cdcb012ec", pin: "435cdcb012ec" } }),
    );
    expect(facts).toEqual({ Version: "1.2.3", Commit: "abcdef012345", Built: "2026-11-10 12:00:00 UTC", Neuroglancer: "435cdcb012ec" });
    const off = Object.fromEntries(buildFacts({ version: "1", commit: "x", date: "", neuroglancer: { commit: "111111111111+changes", pin: "435cdcb012ec" } }));
    expect(off.Neuroglancer).toBe("111111111111+changes (pinned: 435cdcb012ec)");
    expect(off.Built).toBe("unknown");
  });

  it("pins one Neuroglancer commit, the one CI builds against", () => {
    const check = neuroglancerCheck(new URL(".", root).pathname);
    expect(check.pin).toMatch(/^[0-9a-f]{40}$/);
    if (check.ciPin !== undefined) expect(check.ciPin).toBe(check.pin);
  });
});
