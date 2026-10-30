# Status

*As of 2026-10-30. The plan this follows is
[`docs/editor_repo_plan.md`](docs/editor_repo_plan.md), the fourth document
in the platform series.*

## Where things stand

| Piece | State |
|---|---|
| **This repo: the shell** (build guide P0–P1) | First cut built and tested. Live at https://andrew-keenlyside.github.io/ngplatform/ once GitHub Pages serves the `gh-pages` branch. No plugins yet. |
| **Filter oracle and engines, step C0** | Done, in `zarr-vectors-tools`, but not pushed there: the session has no access to the AllenInstitute organisation. Parked as patches in [`pending/zarr-vectors-tools/`](pending/zarr-vectors-tools/). |
| **Gate G1** (is numpy in Pyodide fast enough?) | Measured. The answer is split; see below. |
| **Neuroglancer fork** | Unchanged. Three limitations found and listed below. Step F1 (rebase, `setupEngine`, `embed.ts`) not started. |

## The shell

What it does:

- **Open** a Neuroglancer link, a state JSON, a remote state URL, or a data
  URL (added as a layer). It says which before opening.
- The **address bar** always holds the workspace, as `#!{"ng": …, "app": …}`.
  **Share** copies that link; **Copy state** gives plain Neuroglancer JSON for
  any Neuroglancer.
- **Undo / redo** over settled states.
- A **command palette** (Ctrl/⌘ K): every action is a command.
- **Layouts:** 4 panels, XY + 3D, 3D, XY.
- **Docks:**
  - Workspace: layers, and the facts of each zarr-vectors store (objects,
    levels, extent, chunk, format);
  - Plugins: what is coming;
  - Inspector: the selected layer, the pointer position, and the values
    under the pointer;
  - Activity: a log, with Jobs and Python tabs as placeholders.
- **Examples:**
  - the HiP-CT right-hemisphere tractogram streamed from GCS (default);
  - a bundled 1,947-streamline excerpt of it;
  - Neuroglancer's FIB-25 EM example.

How it is checked:

- `npm test`: 17 unit tests (state parsing, undo history, palette ranking).
- `npm run typecheck`.
- `node e2e/smoke.mjs`: drives the built app in headless Chromium and loads
  both tractogram examples. Software WebGL there cannot draw Neuroglancer's
  views, and the fork's standalone build fails the same way, so drawing
  itself is checked only by eye on a real GPU.

## Gate G1

Pyodide 314.0.7, on the HiP-CT hemisphere (79,648 streamlines, 39.4 M
vertices at 0.1 mm):

| Measurement | Result | Gate |
|---|---|---|
| Column filter, operator flip, publish | about 1 ms each | pass |
| 5 mm sphere, median / p90 | 78 / 146 ms | 100 ms: borderline |
| Disk / 10 mm mask | 130 / 306 ms | fail |
| Index build / peak memory | 34 s / 2.6 GB | fail |

At 10⁶ synthetic streamlines the index does not fit the 4 GB wasm heap.
What follows from it:

- numpy in Pyodide is enough for column filters, algebra, statistics and
  publishing.
- Only the per-segment region test wants compiled code. Try TypeScript in
  the filter worker first.
- The browser engine evaluates regions chunk by chunk over a filter-ready
  store, never by holding level 0 whole.

## Known limits (fork)

- zarr-vectors sources given as `gs://` find no `zarr.json`. Use
  `https://storage.googleapis.com/…`.
- Over HTTPS, one S3-style listing probe is refused cross-origin and logs a
  console error. The layer still loads.
- Installing the fork from `../neuroglancer` runs its `prepare` script, which
  rewrites the fork's `package.json` in place. Undo it with
  `node build_tools/postpack.ts && rm -rf lib` in the fork.

## Next

In the order of the plan's §4:

1. Land the parked C0 patches on `zarr-vectors-tools`.
2. **Z1** `zvtools index`: filter-ready columns. G1 moved this ahead of T2.
3. **F1** in the fork: rebase onto upstream (command registry), carry #1147,
   add `src/embed.ts`.
4. **F2**: a `memory://` kvstore spike (gate G3).
5. **Z2**: golden filter answers for the browser engines.
6. **T1**: tractography display parity, the first plugin.

## Needs you

- **AllenInstitute access for Claude.** An org owner installs the Claude
  GitHub App on `AllenInstitute/zarr-vectors-tools`, or applies the parked
  patches by hand.
- **GitHub Pages**, if the site does not appear on its own: Settings → Pages
  → Deploy from a branch → `gh-pages` / root.
