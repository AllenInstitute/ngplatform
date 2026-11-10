# Phase 5: Release

One to two weeks.

Each batch ends with the checks in [README.md](README.md#checks-for-every-batch). Tick an item when it is merged, with the commit: `- [x] … (abc1234)`.

## 5A · CI and tests

**Goal:** Few, meaningful CI runs; a browser test that waits on state, not time; UI modules tested.

**Files:** .github/workflows, tests/, vitest config

**Items:** 4

- [x] **Major** · S–M · CI runs by hand only: typecheck, vitest and the runner's pytest on every pull request; npm ci; a bundle-size budget (d84eff8)  
  `.github/workflows/ci.yml`
- [x] **Major** · M · The browser smoke test waits on fixed timeouts and live servers; make it wait on state, use local fixtures, cover Settings, the start card, pairing, Share and keyboard use (6f899df, e6c8ad2)  
  `tests/e2e/smoke.mjs`
- [x] **Major** · M · No unit tests for any UI module (shell, docks, sheets, panels): add a DOM test environment (e92bd3c, 01459a7)  
  `vitest config`
- [x] **Plan** · S · Few CI runs (decision 2): on pull requests and by hand only, `[skip ci]` on work-in-progress pushes; the zarr-vectors and runner suites included (25c0e1b)  
  `.github/workflows/ci.yml`

## 5B · Security and release

**Goal:** CSP, tokens, versions, a changelog, a deploy workflow, a reproducible build.

**Files:** index.html, src/platform, package.json, .github/workflows

**Items:** 5

- [x] **Major** · M · Security: no CSP while sign-in and runner tokens sit in localStorage and URL plugins share the origin; debug globals in production (8e853c2)  
  `index.html; google_auth.ts:212; runner.ts:289; main.ts:57`
- [x] **Major** · M · Release process: a deploy workflow, changelog, tags, an About with versions; the app should check the runner's version (8e853c2, 72e9358, a921029)  
  `shell.ts:171; platform/runner.ts:20`
- [x] **Major** · M · Reproducible build: Neuroglancer from a sibling checkout, caret ranges, a beta geotiff, no linter; 111 casts into Neuroglancer internals (94f58a5, 8140fe3)  
  `package.json; src/engine/inspector`
- [x] **Minor** · S · Fonts from Google and Pyodide from jsDelivr; no app shell offline (8e853c2)  
  `index.html:8; python.ts:13; sw.ts`
- [x] **Minor** · S · Boot: no loading state while 2.25 MB of startup code loads (a 954 KB chunk) (8e853c2)  
  `index.html; dist/assets`
