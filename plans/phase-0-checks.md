# Phase 0: Checks

Half a day. Makes the later work measurable: every suite runs, the style is measured, old links are pinned by fixtures.

Each batch ends with the checks in [README.md](README.md#checks-for-every-batch). Tick an item when it is merged, with the commit: `- [x] … (abc1234)`.

## 0 · Checks

**Goal:** Make every later batch measurable before changing anything.

**Files:** package.json, plugins/zarr-vectors/vitest.config.ts, tests/e2e, src/core/workspace.ts, src/core/app_state.ts

**Items:** 3 (1 blocker)

- [x] **Blocker** · S · Zarr Vectors: Its 313 tests cannot run here: the vitest file-access list misses the symlinked node_modules, so npm test fails at this step (88405e5)  
  `plugins/zarr-vectors/vitest.config.ts:17`
- [x] **Major** · S–M · Core app: Link and state versioning: readPlatform ignores version; a slice without migrate resets silently; no old-link fixtures (01aedd2)  
  `core/workspace.ts:143; core/app_state.ts:40`
- [x] **Plan** · S · A repeatable `npm run ui:audit`: screenshots of every scene, dock, tool and sheet with all plugins on, and the computed-style measurements per panel, written to a report; the baseline recorded in this folder (01f211e)  
  `tests/e2e/ui_audit.mjs (from the audit's gallery script)`
