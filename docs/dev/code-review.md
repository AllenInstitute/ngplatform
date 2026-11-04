# Code review: shared helpers, dead code, bugs, tests

*2026-11-04.* A review of the platform (`src/`) and the plugins
(`plugins/`) from `a1b99ee`: small helpers that several places had their
own copies of, now one each in the SDK (or `src/core`); code and styles
nothing used; bugs found by reading, beyond those in
[the audit](audit.md) and [its second part](audit-2.md); and tests for
logic that had none.

In numbers: code 734 lines added and 1,059 removed (325 fewer, with the new
SDK modules and the fixes counted in); about 20 kinds of helper merged,
some 55 copies removed; 27 bugs fixed (20 entries below); 29 tests added
(799 → 828 in the app, 89 → 92 test files; Zarr Vectors' 309 unchanged). Coverage was not
measured: `@vitest/coverage-v8` is not installed, and nothing was
installed for this.

The files two other pieces of work were changing at the same time were
left alone, or touched only where an import changed: Filters
(`plugins/filters`), the image and vector stores (`src/virtual/images`,
`src/virtual/vectors`), `src/virtual/computed.ts`, `src/sw.ts`, Zarr
Vectors' link reading, and the export and overview panels
(`src/ui/export.ts`, `src/ui/overview.ts`).

## Merged into the SDK

New SDK modules, for plugins (and the shell, which uses the same ones):

| Module | What | Copies it replaces |
|---|---|---|
| `@ngplatform/sdk/dom` | `el` (elements: attributes, listeners, children; `value` set last, as the property) | 10 plugins' `el` (in three variants), the inspector's `el`, the shell's `h` (now a name for `el`) |
| | `button`, `select`, `numberInput`, `field` | Annotations' `ui.ts`, which Segmentation and Atlas imported from another plugin |
| | `downloadBlob`, `safeFileName`, `svgEl`, `append`, `clear` | 9 downloads (Annotations, Atlas, Registration, Time series, Track filtering × 4, Capture); 3 file-name cleaners; 2 plot `svg` helpers |
| `@ngplatform/sdk/format` | `csv`, `csvField` | Annotations' `csv`, Time series' `csvField`, Track filtering's two `quote`s (which did not quote a carriage return) |
| | `ticks` | Annotations' and Time series' (Annotations' lacked the rounding tolerance: 0.3 / 3 gave no 0.3 tick) |
| | `mmText`, `bytesText` | Orientations' and Volume view's `mm`; the runner panel's sizes (now "KB" as the overview panel writes it) |
| `@ngplatform/sdk/worker_rpc` | `WorkerRpc`: requests to a worker by id, progress and interim messages, cancel, and a worker that fails (all its requests fail, and later ones fail or start a new worker) | the request code of seven clients: Time series, Registration's saving, Track filtering's segment regions, Orientations, Volume view, Atlas, Annotations |
| `@ngplatform/sdk/tensors` | `eigenSym3` (the NIfTI reader's) | Orientations' copy, 111 lines, kept equal by a test |
| `@ngplatform/sdk/precomputed` | `httpJson`, `gunzip` (now exported) | 3 readers' `readJson` (Orientations, Time series, Volume view); Segmentation's `gunzip` |
| `@ngplatform/sdk/sources` | `layerSourceUrl` | Annotations' and Registration's `sourceUrl` |

In the platform and between plugins:

- `src/core/idb.ts`: one IndexedDB connection for local plugins and local
  data, which each had their own copy of the schema and opened a new
  connection on every request (never closed).
- `src/core/zip.ts` writes every zip: Export's `zipFiles` (and Segmentation
  and Registration through it) used a second writer with its own CRC
  table. The file-count limit is checked for both, and a file's size before
  its CRC.
- `readerCache` in Volume view's reader: the Annotations and Atlas workers'
  reader caches (Annotations' never let a reader go: see the bugs).
- Luxar's `columnMajor`, once in `view_math.ts`.

Left as they are on purpose: number formatters that differ in what they
show (`fmt` in eight places, to 4 significant figures, 2 decimals, or with
an exponent at different points), the three `invert4`s (different
layouts and singularity thresholds), Segmentation's own icon set, and
hex colour helpers on 0–1 and 0–255 scales.

## Removed

- Unused imports and locals (`tsc --noUnusedLocals` is now clean), two
  functions nothing called (`propertyIndex` in Annotations, the
  inspector's `emptySource`), a shell field never read.
- 22 lines of CSS for classes no element has any more: the old layout
  buttons, position and source lines, `eyebrow`, `explain` notes, and
  Track filtering's `tf-intro`. Annotations' `an-num` became the SDK's
  `num-input` (in the platform's styles).
- No files were unused, and every command a manifest declares is
  registered; no plugin declares settings. 276 exports are used only in
  their own file; the `export`s were left (harmless, and a large diff).

## Bugs found and fixed

Platform:

1. `workspace.renameLayer` returned another layer's name when the name was
   taken (Neuroglancer makes it unique, "cells1"), or the old name for one
   with spaces around it; Track filtering kept that name for its group's
   layer. It now returns the name the layer got.
2. Redo straight after an edit (within the 400 ms the edit takes to
   settle) threw the edit away; it is recorded first, as for Undo.
3. A lookup table from a file lost words in its link: names were written
   as `value name` and read back by the table parser, which drops a
   trailing number ("Brodmann area 4" → "Brodmann area") and commas. The
   link now writes `value<TAB>name`; older links read as before.
4. Waiting for a Google token with a signal already aborted never ended.
5. A local plugin's Reload clicked twice failed ("already loaded") while
   the plugin ran; Remove during a load left the plugin registered. Loads
   of one plugin now join, and Remove waits.
6. The segment inspector's Copy buttons could keep the label "Copied".
7. Local plugins and local data opened an IndexedDB connection per
   request (above).
8. The plugin host kept every overlay, view toggle and 3-D drawer a plugin
   had made and disposed itself (with the drawer, and so a Luxar layer's
   data), and disposed them again when the plugin stopped.

Plugins:

9. Track filtering: a late preview could replace the exact answer (the
   exact one is cached and can come first), leaving the count at "~" and
   Save .trk and the density map off.
10. Track filtering: a mask whose every level is over the budget read the
   finest level, not the coarsest.
11. Track filtering: polyline annotations never met a region.
12. Track filtering's segment regions, Time series and Registration's
    saving had no handler for a worker that fails to start or dies: their
    requests waited for ever. Track filtering's region reader (its store
    stayed "Opening…") and both Luxar readers (screenshots waited) now say
    so too.
13. Registration's worker, on close, left its requests waiting.
14. Segmentation: Escape while quick select read its image was lost, and
    the mask was painted anyway.
15. Segmentation: changes that could not be kept in the browser's storage
    (full) were dropped from the list to keep, so a reload brought back
    less; they are kept with the next change, and the log says so once.
16. Luxar: a splat view whose drawing threw (a shader this GPU cannot
    compile) threw again every frame; it now says why once.
17. Luxar: a disposed layer kept its chosen objects' chunks (up to
    512 MiB) and its splat blocks.
18. Annotations: its worker kept a reader (up to 128 MB of chunks) for
    every store it ever read; it keeps three.
19. Atlas: a count of a layer's old source, finishing last, was applied
    to the new one.
20. Annotations' profile plot ticks and Track filtering's CSV quoting
    (above).

All of these were found by reading and checked against the code paths;
the tests below cover 1, 2, 3, 8, 11 and the worker failures.

## Tests added

- `tests/worker_rpc.test.ts`: `WorkerRpc` against a stand-in worker
  (answers by id, progress, interim messages, cancel, a worker that fails
  with and without restarting, an unreadable answer, dispose).
- `tests/helpers.test.ts`: CSV fields, ticks, lengths and sizes, file
  names, precomputed URLs and layer sources, 4 × 4 matrices, the panels'
  formatting, export kinds, the zip writer read back entry by entry (and
  its limits), and `el`, the controls and `downloadBlob` against a
  stand-in document.
- `tests/plugins.test.ts`: handles a plugin disposes itself are disposed
  once.
- `tests/store.test.ts`: `renameLayer`'s name; Redo with an edit settling
  (fails without the fix).
- `tests/lookup_table.test.ts`: names with commas and trailing numbers
  through a link; older links.
- `plugins/orientations/tests/zarr2.test.ts`: Zarr v2 metadata as v3
  (types, order, endianness, compressors, what is refused) and the store
  wrapper.
- Track filtering: polylines in regions.

## Left, with estimates

| What | Hours |
|---|---:|
| Filters and Export (`src/ui/export.ts`): the same `el`/`downloadBlob`, and a `WorkerRpc` for the export worker, which has no error handler | 1 |
| `src/ui/overview.ts`'s `sizeText` is `bytesText`: use it | 0.25 |
| `src/virtual/vectors`: four copies of `element`/`bytesOf`/`group`/`json`, two of `column`; `inflate` in TIFF and mesh files; the images' two `cacheName`s; three unused spill functions (`onSpillSettings`, `openSpill`, `freeStorage`) | 1.5 |
| Local data's format workers: no error handler (a crashed worker is kept, and reads wait for the service worker's timeout) | 1 |
| Volume view: switching it off keeps the brick atlas and volume textures (~180 MB of GPU memory); the old image's solid is drawn until the new one loads, and when it fails; the solid ignores the layer's transform (Registration's moves) | 4 |
| Orientations and Volume view: an `open` that is superseded can still set the reader's levels (no sequence number in the worker) | 2 |
| Volume view: Zarr v2 arrays in Fortran order read the wrong chunks when an axis has several | 1 |
| Luxar: reading whole objects can switch between two levels for ever when a level is measured too large (the measurement is cleared with the level) | 2 |
| Segmentation: a queued fill reads the volume and settings when it runs, not those at the click | 1.5 |
| Annotations: Open CSV with a field named like a built-in column (Type, Description…) | 1 |
| Atlas: the tree collapses on every state change while the saved layer is missing | 0.5 |
| Collections: two reads (or a placement poll) can overlap and the older one win | 1.5 |
| Orientations: a glyph read that fails is tried again every 120 ms | 0.5 |
| The runner client: overlapping status fetches after re-pairing | 1 |
| Turntable movies of less than a turn stop one step short of the angle (360° loops need that; a partial turn may not) | 0.25 |
| 276 exports used only in their own file: drop the `export`s | 1 |
| Coverage numbers (`@vitest/coverage-v8`, a dev dependency) | 0.5 |
