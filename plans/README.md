# Plans: production polish

The work that takes ngplatform and its plugins from a working prototype to
something colleagues can use without help: fixes for data loss and crashes,
one consistent style, scale, accessibility and a release process.

It comes from an audit of `5c986ab` (branch `anatomical-rendering`, 9 November 2026):
- the computed styles of every visible element in 34 panels and sheets, with
  all 12 tool plugins on;
- three read-only code audits (core app and runner; render service and image
  plugins; vector and label plugins).

Item line numbers are from that commit and move as the code changes.

## Decisions

| | Decision |
|---|---|
| Corners | Square everywhere (`--r: 0`); pills only for status chips. |
| CI | As few runs as possible: on pull requests and by hand, `[skip ci]` on work-in-progress pushes. |
| Errors | Kept locally: in Activity, and a log Settings › Developer can save. No remote reporter. |
| Theme | Dark only. |
| Splats | Shown, marked *In progress*, until a fit has run end to end. |
| Browsers | Chrome and Edge fully; Firefox and Safari work, without folder access. |

## The style every panel converges on

| | Target |
|---|---|
| Type | Four sizes as tokens: 11 (captions, labels), 12 (body), 13 (sheet controls), 15 (sheet titles). Every control in IBM Plex Sans; numbers and paths in Plex Mono. |
| Buttons | Primary, outline, quiet and icon; 24 px in docks, 28 px in sheets; at most one primary per panel. |
| Fields | One field and one select, as high as the buttons beside them; one slider-with-number control. |
| Grouping | A panel longer than a screen is cards (`card()`); the first open, the rest remember their state. One uppercase label style inside a card; no private headings. |
| On / off | A switch turns a feature on (Render, a plugin, a layer's drawing); a checkbox picks items or options. |
| Colour | Tokens only, including danger and hover. `--faint` raised to 4.5:1 contrast. Green reserved for selection and on. |
| Words | A control has a label. Explanations go behind an info control that keyboard and touch can reach. An empty state is one line plus its action. Status lines report progress and errors only. |
| Neuroglancer | Its 3-D toggles, panel buttons, layer tabs and view settings restyled with the same tokens; its settings shown with units; chunk statistics as a table. |

## How a batch runs

1. One batch at a time per area of files. Batches that share no files may
   run in parallel, each in its own worktree, and are merged one at a time.
2. A minor item is fixed in the batch that already has its file open.
3. One commit series per batch, ending with the checks below. Nothing is
   pushed or deployed without asking; pushes carry `[skip ci]` unless they
   are meant to run CI.
4. Tick the item here when it is merged, with its commit: `- [x] … (abc1234)`.

### Checks for every batch

- `npx tsc --noEmit -p .`
- `npm test`: every suite, the Zarr Vectors one included once Phase 0 is done.
- The render service's tests, for any change under `runner/`:
  `python -m pytest runner/tests`, in the render environment.
- `npm run ui:audit -- <app address>` against a build (as `npm run e2e`):
  screenshots and style measurements, compared with
  [ui-audit-baseline.json](ui-audit-baseline.json); it fails when a measure
  is worse. A batch that improves them records its run as the new baseline
  (`UI_AUDIT_BASELINE=1`).
- For a panel batch: its screenshots looked at, at 1440 × 900 and 1280 × 760.

### Style baseline and targets

| Measure (across all panels and sheets) | Baseline (5c986ab) | After Phase 2 | Target |
|---|---|---|---|
| Font sizes | 9 | 5 | 4 |
| Button styles (size, height, radius, fill, border) | 22 | 13 | 6 or fewer |
| Input and select styles | 17 | 5 | 4 or fewer |
| Heading styles | 8 | 3 | 3 |
| Corner radii on a square theme | 8 | 2 (status dots, Google button) | 0 (pills for status chips only) |
| Text in the browser's default font (elements) | 63 | 0 | 0 |
| Elements with inline styles | 90 | 0 | Only computed geometry |
| On/off controls not made with the SDK's toggle or checkbox (was: panels mixing switches and checkboxes, 1) | 60 (at 2B) | 0 | 0 |

## Batches

188 items (170 done). Phases run in order; within a phase, batches as each file says.

| Phase | Batch | Items | Blockers |
|---|---|---|---|
| Phase 0 | [0 · Checks](phase-0-checks.md#0--checks) | 3 | 1 |
| Phase 1 | [1A · Readers](phase-1-blockers.md#1a--readers) | 3 | 2 |
| Phase 1 | [1B · Plugin crashes](phase-1-blockers.md#1b--plugin-crashes) | 7 | 5 |
| Phase 1 | [1C · Render](phase-1-blockers.md#1c--render) | 12 | 2 |
| Phase 1 | [1D · Core](phase-1-blockers.md#1d--core) | 4 | 3 |
| Phase 2 | [2A · Base styles and tokens](phase-2-one-style.md#2a--base-styles-and-tokens) | 10 |  |
| Phase 2 | [2B · Shared parts](phase-2-one-style.md#2b--shared-parts) | 10 |  |
| Phase 2 | [2C · Neuroglancer's controls](phase-2-one-style.md#2c--neuroglancers-controls) | 2 |  |
| Phase 2 | [2D1 · Panel: Anatomical rendering](phase-2-one-style.md#2d1--panel-anatomical-rendering) | 13 |  |
| Phase 2 | [2D2 · Panel: Track filtering](phase-2-one-style.md#2d2--panel-track-filtering) | 6 |  |
| Phase 2 | [2D3 · Panel: Luxar](phase-2-one-style.md#2d3--panel-luxar) | 5 |  |
| Phase 2 | [2D4 · Panel: Registration](phase-2-one-style.md#2d4--panel-registration) | 11 |  |
| Phase 2 | [2D5 · Panel: Filters](phase-2-one-style.md#2d5--panel-filters) | 7 |  |
| Phase 2 | [2D6 · Panel: Orientations](phase-2-one-style.md#2d6--panel-orientations) | 7 |  |
| Phase 2 | [2D7 · Panel: Time series](phase-2-one-style.md#2d7--panel-time-series) | 5 |  |
| Phase 2 | [2D8 · Panel: Atlas](phase-2-one-style.md#2d8--panel-atlas) | 4 |  |
| Phase 2 | [2D9 · Panel: Segmentation](phase-2-one-style.md#2d9--panel-segmentation) | 5 |  |
| Phase 2 | [2D10 · Panel: Annotations](phase-2-one-style.md#2d10--panel-annotations) | 4 |  |
| Phase 2 | [2D11 · Panel: OME Collections](phase-2-one-style.md#2d11--panel-ome-collections) | 6 |  |
| Phase 2 | [2D12 · Panels: Layers, Settings and the shell](phase-2-one-style.md#2d12--panels-layers-settings-and-the-shell) | 4 |  |
| Phase 2 | [2E · Docs and screenshots](phase-2-one-style.md#2e--docs-and-screenshots) | 5 |  |
| Phase 3 | [3A · Render service](phase-3-scale.md#3a--render-service) | 7 | 1 |
| Phase 3 | [3B · Readers and data formats](phase-3-scale.md#3b--readers-and-data-formats) | 9 |  |
| Phase 3 | [3C · Plugin performance](phase-3-scale.md#3c--plugin-performance) | 17 |  |
| Phase 3 | [3D · Core robustness](phase-3-scale.md#3d--core-robustness) | 4 |  |
| Phase 4 | [4 · Accessibility](phase-4-accessibility.md#4--accessibility) | 9 |  |
| Phase 5 | [5A · CI and tests](phase-5-release.md#5a--ci-and-tests) | 4 |  |
| Phase 5 | [5B · Security and release](phase-5-release.md#5b--security-and-release) | 5 |  |

Rough effort for one person: Phase 0 half a day, Phase 1 a week, Phase 2
two to three weeks, Phase 3 two weeks, Phase 4 a week, Phase 5 one to two
weeks. Effort per item: S under half a day, M one to three days, L more.
The render service's GPU budget is a blocker but large, so it is in 3A; until
then, Phase 1's input limits keep one request from exhausting the GPU.
