# Build plan: the Neuroglancer editor as its own repository

*Fourth document in the series. Read with:*
- `neuroglancer_pyodide_platform_review.md`: why the platform is shaped this way;
- `zarr_vectors_filtering_wasm_plan.md`: the filter engine (C0–C8) and its adversarial review;
- `build_guide_platform_and_trackvis.md`: the build order (Phase 1 platform, Phase 2 TrackVis parity).

*This document answers "should the editor be a separate repository?" (yes), says what lives where, how the repositories depend on one another, and turns the build guide into a sequence of pull requests per repository. It also records what C0 and gate G1 found, because G1 changes the engine decision. No timelines.*

---

## 0. Decisions in one page

1. **The editor is a new repository: `Andrew-Keenlyside/ngplatform`** (the build guide's name). The shell's first cut is built, and its GitHub Pages deploy is the review link.
2. **Four repositories, each with one job.**
   - The **Neuroglancer fork** renders, and owns everything that runs inside Neuroglancer's workers.
   - **zarr-vectors-py** owns the format.
   - **zarr-vectors-tools** owns offline work and ground truth: converters, the filter oracle, filter-ready indexing.
   - **ngplatform** owns everything a user sees or does.
3. **ngplatform depends on the fork by commit, not by submodule.** Neuroglancer already supports `npm install <github-repo>#<sha>`: its `prepare` script builds the package on install. A local checkout can be linked for co-development, as shown in the fork's own `examples/`. This replaces the build guide's submodule (§1 of the guide).
4. **The repositories meet at five versioned contracts:**
   - the fork's `src/embed.ts`;
   - the `{ng, app}` URL state;
   - the `zvf-predicate` filter JSON (version 1, now defined in zarr-vectors-tools);
   - golden filter answers produced by the oracle;
   - the store's filter-ready columns.

   Each contract has a test on both sides (§3).
5. **G1 is measured (§5), with a split answer.**
   - numpy under Pyodide is enough for column filters, boolean algebra, statistics and publishing.
   - It is borderline for exact region tests on your 0.1 mm data.
   - Holding level 0 whole in the browser fails on memory and start-up in any language.

   So the browser engine evaluates regions chunk by chunk over a filter-ready store, and only the per-segment region test is a candidate for compiled code (TypeScript first, then Rust if needed).
6. **Pyodide is self-hosted from day one.** This session could not reach the jsdelivr CDN at all, and the build guide already asks for self-hosting for reproducibility.

---

## 1. Why a separate repository

The build guide sketched one monorepo with the fork as a submodule. Splitting it is cleaner, for four concrete reasons.

- **Release cadences differ.**
  - The fork should change rarely and narrowly, so that rebases onto upstream stay cheap. The build guide's rule is that `embed.ts` is the only file to fix after a rebase.
  - The editor will change daily.
  - The Python packages release on PyPI on their own schedule.
- **Toolchains differ.** The fork has Neuroglancer's own build (rspack, vitest workspace, oxlint/eslint, `tsgo`). Pulling that inside a pnpm/Vite app repo means fighting two build systems in one tree. As a dependency, the fork is just a built package.
- **Upstreaming stays possible.** Fork changes such as `setupEngine`, ObjectMask and the `memory://` provider stay reviewable as Neuroglancer patches. They are not tangled with app code.
- **Permissions and CI cost.** The fork's CI (Neuroglancer's full test suite) does not need to run on every editor PR, and the editor's e2e suite does not need to run on every fork PR.

**What it costs, and the mitigation.**

| Cost | Mitigation |
|---|---|
| A change that spans the fork and the editor (ObjectMask, `memory://`) needs two PRs. | Merge the fork PR first, then bump the pinned commit in ngplatform in a PR whose e2e suite exercises the change. Fork changes are rare by design. |
| Installing the fork from git builds it, which takes minutes. | Cache the built package in CI, keyed by fork commit. For local co-development, link a local checkout (`pnpm link ../neuroglancer`) and skip the install-time build. |
| Contracts can drift silently between repos. | Each contract has a test in both repos (§3), and golden files are versioned with the format they encode. |

---

## 2. What lives where

| Piece | Repository | Why there |
|---|---|---|
| Format spec, readers/writers, async API (`aopen`, `aread`) | zarr-vectors-py | owns the format |
| Converters (TRK/TCK/TRX…), pyramids | zarr-vectors-tools | existing home |
| **Filter oracle, `zvf-predicate` JSON v1, synthetic fixtures, G1 harness** | zarr-vectors-tools (`zarr_vectors_tools.filtering`, `benchmarks/filtering`) | **done in C0**; it must run natively to define truth |
| `zvtools index`: filter-ready columns and fragment owners | zarr-vectors-tools | offline, heavy, Python; core already has `write_fragment_owner_column` |
| Golden filter answers (tree JSON plus expected rows per fixture) | produced by zarr-vectors-tools, consumed by ngplatform | the oracle defines them |
| Rendering, datasources incl. zarr-vectors, `embed.ts`, `setupEngine` (#1147), ObjectMask, `memory://` kvstore provider | Neuroglancer fork | must run in NG's frontend and chunk workers, and touches the WebGL pipeline |
| App shell, ViewerBridge, command façade, state I/O and undo, plugin host and SDK, compute runtime (worker pool, Pyodide), first-party plugins (tractography), e2e, deployment | **ngplatform** | product code |
| `zvf-core` (Rust), if built | ngplatform `crates/` at first; its own repo once a second consumer appears | see §5 for whether it is needed |

**Rule of thumb.**
- Code that runs inside Neuroglancer's workers or the WebGL pipeline belongs in the fork.
- Code that must agree with the format byte for byte, or that defines a correct answer, belongs in the Python repositories.
- Everything else belongs in ngplatform.

### ngplatform layout

The build guide's layout, with three changes:
- `packages/neuroglancer` (submodule) becomes a dependency;
- `python/oracle` goes away, because the oracle lives in zarr-vectors-tools;
- `fixtures/` holds only small generated fixtures and golden answers.

```
ngplatform/
├─ package.json            # "neuroglancer": "github:Andrew-Keenlyside/neuroglancer#<sha>"
├─ packages/
│  ├─ platform-core/       # ViewerBridge, commands, state I/O + undo, plugin host
│  ├─ platform-ui/         # shell, docks, Lit components, tokens
│  ├─ compute/             # worker pool, typed RPC, Pyodide runtime, wasm loader
│  ├─ plugin-sdk/          # manifest schema, PlatformContext types, test harness
│  └─ app/                 # Vite app; bundles first-party plugins
├─ plugins/
│  ├─ example-layer-stats/
│  └─ tractography/
├─ python/zvfilter/        # vendored zarr_vectors_tools.filtering at a pinned commit (sync script)
├─ fixtures/golden/        # oracle answers, regenerated by script, small
├─ pyodide/                # lockfile + fetch script for the self-hosted distribution
├─ e2e/                    # Playwright
└─ docs/
```

**Why vendor the filtering subpackage instead of `micropip install zarr-vectors-tools`.** zarr-vectors-tools depends on an *unreleased* core (`zarr_vectors.building`; see its `pyproject.toml`), so it cannot be installed from PyPI into Pyodide today. The filtering subpackage imports only numpy and itself, so it can be copied as is; the G1 harness already does exactly that. A sync script pins the source commit, and the golden tests catch drift.

---

## 3. Contracts between the repositories

| # | Contract | Defined in | Tested in the producer by | Tested in the consumer by |
|---|---|---|---|---|
| K1 | `src/embed.ts`: `setupEngine`, `Viewer` types, `commandRegistry`, annotation/layer helpers, `registerKvStoreProvider` | fork | a smoke test that mounts a chrome-less viewer | ngplatform type-check + e2e on every fork bump |
| K2 | URL/app state `{ng, app}`; `ng` alone opens in plain Neuroglancer | ngplatform | round-trip of the gallery URLs | — |
| K3 | `zvf-predicate` JSON v1 (`{"format","version","tree"}`; regions sphere/box/slab/disk/mask; leaves passes/column/group; and/or/not) | zarr-vectors-tools `filtering/predicates.py` | JSON round-trip and refusal tests (`tests/test_filtering_predicates.py`) | the TS model parses every golden tree and re-serialises it identically |
| K4 | Golden answers: `{store fixture, tree JSON, accepted rows, summary}` | zarr-vectors-tools (generator script, to add) | regenerated in CI and diffed | every engine in ngplatform (Pyodide, TS, wasm) must match exactly |
| K5 | Filter-ready store profile: `object_attributes/{length, n_vertices, bbox_min/max, endpoint_a/b}` + `fragment_attributes/object_id` | zarr-vectors-tools `zvtools index` (to add) | a test that an indexed store answers like the oracle | ngplatform detects the profile and shows "filter-ready / basic" |

**K3 is the hinge.** The region semantics are written down precisely in the `predicates` module docstring:
- all sets are closed;
- the disk angle is measured to the normal *axis*;
- a mask is sampled at the vertices plus `ceil(len/spacing) − 1` interior points, the scheme `select_streamlines` already uses;
- an absent value passes no comparison, `!=` included.

Any engine that disagrees with the oracle on a golden file is wrong by definition.

---

## 4. Build order as pull requests

Each step is one PR (or a small series) with its own acceptance test. Steps in different repositories can run in parallel where their dependencies allow.

### zarr-vectors-tools
- **Z0 (done, on `claude/new-session-f9c16u`; push blocked, see the status note).** C0: the filtering subpackage (predicates + JSON, oracle, indexed engine, synthetic fixtures, `load_tractogram`), 78 tests, the G1 harness and its results.
  - It also fixes `select_streamlines`: it missed streamlines crossing a region near a chunk face (§6).
  - *Accept:* CI green; the store property test fails if the fix is reverted (checked).
- **Z1 `zvtools index`, now before T2 (G1).** Write K5's columns and the fragment owner column, using core's `write_fragment_owner_column`.
  - *Accept:* `load_tractogram` on an indexed store reads the columns instead of computing them, and every answer is unchanged.
- **Z2 golden export.** A script writes K4 files for the known-answer cases and for 200 random trees over two synthetic stores.
  - *Accept:* deterministic output (byte-identical on rerun).

### Neuroglancer fork
- **F1.** Rebase `zarr_vectors_working` onto upstream master (command registry #1072), carry #1147, add `src/embed.ts`, tag `v<ng>-zv.1`.
  - *Accept:* the smoke test mounts a chrome-less viewer and renders a zarr-vectors layer identical to standalone.
- **F2 (gate G3 spike).** A `memory://` kvstore provider reachable from the chunk worker, behind a flag.
  - *Accept:* a buffer written from the page displays as an image layer and as a zarr-vectors layer.
  - Fallback if it fails: Service-Worker `/mem/` URLs.
  - Do this early: it decides the designs of T4 and T5.
- **F3 ObjectMask** (filter plan B3 Stage 2), when T3 needs it or G2 fails.

### ngplatform (new)
- **P0 bootstrap (a first cut exists).** pnpm workspace, TS strict, Vite app mounting the fork via K1, Vitest, Playwright (Chromium + Firefox, WebGL via SwiftShader), CI with the fork build cached by commit.
  - What exists: a single-package Vite app; the fork consumed as source; vitest; a headless smoke test; a CI workflow pinned to fork commit `6ecceea`.
  - Still to do: the split into packages.
  - *Accept:* CI opens a state URL with a zarr-vectors layer and matches a reference screenshot.
- **P1 shell, state, commands, undo** (build guide 1.2–1.4). **Previewed:**
  - Open: a Neuroglancer link, state JSON, a remote state URL, or a data URL, which is added as a layer;
  - `{ng, app}` links in the address bar;
  - copying plain Neuroglancer JSON;
  - undo/redo, the command palette, layout switching;
  - docks: workspace with zarr-vectors store facts, inspector, activity.

  Not yet: the gallery round-trip test, and the full ViewerBridge API.
  - *Accept:* gallery URLs round-trip.
- **P2 compute runtime** (guide 1.6 without `memory://`). Self-hosted Pyodide trimmed to core + numpy + lockfile, worker RPC with progress and cancel, vendored `zvfilter`.
  - *Accept:* the golden files pass inside the browser's Pyodide worker.
- **P3 plugin system + example plugin** (guide 1.5).
- **T1 → T8** as the build guide orders them, with T2's engine chosen by §5.

### First four PRs, in order
1. Z0 (ready on this branch).
2. F1.
3. P0, which needs F1's `embed.ts`.
4. Z2, which P2 needs.

---

## 5. What gate G1 found

Measured with `zarr-vectors-tools/benchmarks/filtering` (C0's harness):
- the same numpy engine under CPython and under Pyodide 314.0.7 in Node;
- level 0 held in memory with a grid index and per-leaf cache;
- every answer checked against the oracle.

| | synth 10⁵ | HiP-CT hemisphere (79,648 / 39.4 M vertices) | synth 10⁶ |
|---|---|---|---|
| P1 column filter (Pyodide) | 1.0 ms | 1.0 ms | out of memory |
| P3 operator flip (Pyodide) | 0.6 ms | 0.6 ms | out of memory |
| publish (Pyodide) | 1.1 ms | 0.4 ms | out of memory |
| 5 mm sphere, median / p90 (Pyodide) | 4.5 / 10 ms | **78 / 146 ms** | 22 / 55 ms (CPython) |
| disk / 10 mm mask / 2 mm slab (Pyodide) | 4 / 17 / 95 ms | **130 / 306 / 121 ms** | — |
| segments tested per second (Pyodide / CPython) | 2.6 M / 3.3 M | 1.3 M / 3.0 M | — / 4.4 M |
| index build (Pyodide) | 5.2 s | 33.6 s | 4 GB heap exhausted (433 MiB for 113 M filings) |
| peak memory (Pyodide) | 1.0 GB | 2.6 GB | > 4 GB |

**Verdict.** The guide asks: if numpy-in-Pyodide meets the gates, ship P1/P3 in Pyodide and keep Rust for P2 and density only. The answer splits three ways.

1. **P1, P3, statistics, publish: numpy in Pyodide, decided.** These pass by one to two orders of magnitude.
2. **P2 (exact region tests): numpy is borderline on real data.** The sphere median passes; p90, disk, mask and slab do not. A compiled kernel is justified for this step only. It is a tight loop over typed arrays, so try it in **TypeScript in the filter worker first**. That costs no new toolchain, and JIT-compiled loops over typed arrays should beat numpy-in-wasm comfortably (*unmeasured*). Go to Rust/wasm SIMD only if TypeScript misses the gate. Either way, the C0 harness measures it on the same sets, and K4's golden files judge it.
3. **"Hold level 0 whole and index it in the browser" is out, whatever the language.** It fails on memory (the 10⁶ set cannot be indexed inside 4 GB) and on start-up (34 s on the real hemisphere). The browser engine must:
   - evaluate region leaves **chunk by chunk**, using the store's chunk grid as the spatial index;
   - keep geometry in a byte-bounded cache;
   - read per-streamline columns from a **filter-ready store** (Z1, `zvtools index`) instead of computing them on open.

   That is the filter plan's own B1–B4 design. G1 has confirmed it, so the build guide's "full zvf-core" fallback is not needed.

**Effect on the build order.**
- T2 starts with P1/P3 in Pyodide on the vendored `zvfilter`, and P2 per chunk.
- G2 (`temporaryVisibleSegments` scale) is measured during T2, as planned.
- Z1 (filter-ready columns) moves before T2.

---

## 6. Lessons from C0 that the plan absorbs

- **The oracle found a real bug on its first store run.** `select_streamlines` read only the chunks a region touches, with segment-level cropping. So a streamline that crosses the region with no vertex inside it, with one end in an untouched chunk, was missed.
  - The module's docstring claimed the only possible miss was a segment with *both* ends outside.
  - Fixed with a `reach` parameter (default: one chunk on every side). On the HiP-CT hemisphere it costs about 3× in time for a 5 mm box. `reach=0.25` (above the 0.1 mm step) gave the same answers for no extra cost.
  - **Implication for the browser engine:** its P2 candidate set must include the segments that *leave* the candidate chunks (the filter plan's B2 step 5 says so). The golden files include this case.
- **numpy under Pyodide is a 32-bit-`intp` numpy.** `np.repeat` and `np.bincount` refuse int64 counts there, while CPython accepts them.
  - Python plugin code must be tested *under Pyodide*, not only under CPython.
  - The G1 harness (`pyodide_worker.mjs`) is the pattern: Node + a self-hosted distribution, and no browser needed.
- **Real data is denser than the plan assumed.** The HiP-CT iFOD2 hemisphere has a 0.1 mm step: 79,648 streamlines, 39.4 M vertices, a median of 543 vertices each. A whole brain at that step would be hundreds of millions of vertices. This is why level 0 cannot be held whole in a wasm32 heap, and why the filter plan's chunk-streamed GeomCache, not an in-memory engine, is the browser design.

- **Hosting constraints, learnt by trying.**
  - A claude.ai Artifact cannot host the app with data: it serves only standard web file types (zarr chunk keys have no extension) and blocks every other host.
  - The app therefore deploys as a static site. Your bucket answers any origin (`Access-Control-Allow-Origin: *`), so any static host can stream the full tractogram.
- **The static host must answer missing files with 404.** The zarr-vectors reader probes for optional arrays. Vite's preview server's SPA fallback returns `index.html` instead, which the reader parses as data and fails.
- **Fork limitations found on the way** (to fix in the fork, not work around in the app):
  - zarr-vectors sources given as `gs://` find no `zarr.json` through the GCS kvstore; `https://storage.googleapis.com/…` works;
  - over HTTPS, one S3-style listing probe is refused cross-origin and logs a console error, though the layer still loads;
  - `npm install` of the fork from a sibling directory runs its `prepare` script, which rewrites the fork's `package.json` in place. `node build_tools/postpack.ts` undoes it.
- **Headless CI cannot check rendering.** SwiftShader's WebGL fails one of Neuroglancer's framebuffer configurations: the fork's standalone build shows the same black views. Pixel checks need a GPU runner or a real-browser service; the smoke test checks everything else.

---

## 7. Decisions that are yours

| Decision | Options | Suggestion |
|---|---|---|
| Name and owner of the editor repo | **decided: `Andrew-Keenlyside/ngplatform`** | it can move to the AllenInstitute org later (GitHub keeps redirects) |
| Licence | Apache-2.0 (Neuroglancer's) / BSD-3-Clause (zarr-vectors') | Apache-2.0: it matches the engine it embeds, and its patent grant suits a platform |
| Where the fork lives | your fork vs an org fork | the org, alongside the editor, so both can share CI secrets and permissions |
| Hosting | static (GitHub Pages / GCS bucket / Cloudflare) | a GCS bucket next to the data, with a COOP/COEP-free profile first (filter plan D8) |
| Upstreaming | push `embed.ts`'s needs and ObjectMask upstream, or keep fork-only | upstream #1147 support; keep ObjectMask in `datasource/zarr-vectors/` until it has proven itself |
