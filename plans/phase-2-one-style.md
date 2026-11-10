# Phase 2: One style

Two to three weeks. 2A–2C first and in that order (they change what every panel builds on); then the panel batches, most-used first, any two of which can run in parallel; 2E last.

Each batch ends with the checks in [README.md](README.md#checks-for-every-batch). Tick an item when it is merged, with the commit: `- [x] … (abc1234)`.

## 2A · Base styles and tokens

**Goal:** One central change to the stylesheet: type scale, controls in the UI font, two control sizes, square corners, tokens only.

**Files:** src/ui/styles.css

**Items:** 10

- [x] **Major** · M · Type scale: 9 font sizes in use; settle on 4 (11 caption, 12 body, 13 control text in sheets, 15 sheet title), as tokens (b5e0802)  
  `styles.css; measured across 34 panels`
- [x] **Major** · S · 63 form controls render in the browser's default sans-serif: make every select, input and button inherit the UI font (b5e0802)  
  `styles.css (button, input, select, textarea)`
- [x] **Major** · M · Buttons: 22 distinct styles (heights 17 to 28 px). Converge on 3 kinds (primary, outline, quiet/icon) in 2 sizes (24 px in panels, 28 px in sheets) (b5e0802)  
  `styles.css .btn; plugin STYLE blocks`
- [x] **Major** · S · Inputs and selects: 17 distinct styles, 24 px in panels but 32 px in sheets; one height per context and one select style (b5e0802)  
  `styles.css .text-input; sdk select()`
- [x] **Major** · S · Headings: 8 styles, uppercase labels at three letter-spacings. Keep two: the card title and one section label inside a card (b5e0802)  
  `styles.css .section-title, .card-title, plugin h3/h4`
- [x] **Major** · S · Corners: the theme is square (--r: 0) but 8 radii are in use (cards 6 px, collections 6/4/3, splat window 8, Luxar 4, pills). Square everywhere, pills only for status chips (b5e0802)  
  `styles.css:974, collections/plugin.ts:119, luxar, splatview.ts`
- [x] **Major** · S · Raise --faint (#636363 on #121212 is about 3.1:1) to about #8a8a8a for 4.5:1 on small text (b5e0802)  
  `styles.css:16`
- [x] **Major** · M · Tokens for type size, spacing, danger and hover; remove about 39 literal colours after :root (b5e0802)  
  `styles.css`
- [x] **Minor** · S · 15 distinct text colours in panels, some from Neuroglancer's own palette; map them to tokens (b5e0802)  
  `measured`
- [x] **Plan** · S · Dark only (decision 4): remove the dead light-theme rule and say so in the docs (bfc9cad)  
  `styles.css:527; docs/guide/interface.md`

## 2B · Shared parts

**Goal:** The SDK gives plugins everything a panel needs, so they stop keeping private copies.

**Files:** src/sdk/dom.ts, src/ui/shell.ts, src/ui/panels/python.ts, plugins/starter_ts, plugins/starter_py

**Items:** 10

- [x] **Major** · S · Design system: On/off controls: switches in Plugins and Render, plain checkboxes elsewhere. Rule: a switch turns a feature on, a checkbox picks items or options (98d90ff)  
  `anatomical, luxar, orientations, track-filtering, Settings › View`
- [x] **Major** · M · Design system: Every panel built from the same parts: card() for groups, field() for labels, one slider+number, one empty-state and one status pattern (0e2992e)  
  `src/sdk/dom.ts`
- [x] **Major** · M · Core app: Explanations moved into title= are unreachable by keyboard and touch: an info control with aria-describedby (0e2992e)  
  `src/sdk/dom.ts:117; auth.ts:286`
- [x] **Major** · M · All plugins: A shared slider+number control and an icon helper in the SDK (four slider variants in Anatomical, private ones in Registration and Orientations) (0e2992e)  
  `src/sdk/dom.ts`
- [x] **Major** · M · All plugins: An update-in-place pattern: Orientations, Time series, Registration and Luxar rebuild whole panels on state changes, closing selects and breaking drags (0e2992e)  
  `see each plugin`
- [x] **Major** · S · All plugins: Manifest panels name their Tools group (now a table keyed by title); Python panels are not moved to Tools (a5426a6)  
  `shell.ts:74, 316; panels/python.ts:335`
- [x] **Major** · S · All plugins: Promote shared classes (row, grid, hint, faint, status) so plugins stop keeping private copies (an-*, at-*, sg-*, lx-*) (0e2992e)  
  `styles.css`
- [x] **Major** · S · Starter templates: starter_ts teaches the old way (createElement, old classes, no card, an announcing status, no empty-state action) (6d7fed7)  
  `starter_ts/plugin.ts:22, 39`
- [x] **Major** · S · Starter templates: starter_py's panel lands in the Layers dock (a5426a6)  
  `src/ui/panels/python.ts:190, 338`
- [x] **Minor** · S · Starter templates: No Tools group; no panel or disposal test to copy; docs say tab (6d7fed7)  
  `starter_ts/manifest.ts:27; README`

## 2C · Neuroglancer's controls

**Goal:** Neuroglancer's own controls look like the rest of the app.

**Files:** src/engine (overlays, inspector), src/ui/styles.css, Settings › View and Developer

**Items:** 2

- [x] **Major** · M · Design system: Neuroglancer's chrome does not match: the 3-D view toggles (Glyphs, Render, Sections), the panel corner buttons, Settings › View (raw byte counts, right-aligned checkboxes) and chunk statistics (raw JSON rows) (13e126b, 3c8d696)  
  `engine overlays, Settings › View/Developer`
- [x] **Major** · M–L · Core app: Duplicate control sets: the inspector's .ins-btn/.ins-number/.ins-select (148 rules) beside .btn/.text-input; button.link and .linkish (b6673de)  
  `styles.css; src/engine/inspector`

## 2D1 · Panel: Anatomical rendering

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/anatomical-rendering

**Items:** 13

- [x] **Major** · S · The muted class used for 9 notes does not exist (89244e9)  
  `plugin.ts:561, 1280, 1413`
- [x] **Major** · M · Private styles, literal colours, about 30 inline styles; the splat window should be a platform sheet (89244e9)  
  `plugin.ts:166, 594; editor.ts:156; splatview.ts:422`
- [x] **Major** · S · Split the long cards: Regions and Quality out of Rendering; Movie and Splat out of Output (89244e9)  
  `plugin.ts:1297, 1390`
- [x] **Major** · S · Wording: the status repeats the GPU and says 'off'; labels carry explanations; three unlabelled checkboxes (89244e9)  
  `plugin.ts:1172, 1194, 584, 1207`
- [x] **Major** · M · Check the image's axes first (time, channels, 2-D); the L/R/A/P/S/I buttons assume RAS (fe57a13)  
  `plugin.ts:341, 1285`
- [x] **Major** · S–M · Splats are offered but have never run: mark them experimental until a real run; test the .ply reader (89244e9)  
  `plugin.ts:1096; splatview.ts:60`
- [x] **Minor** · S · Dispose leaks: the WebGPU renderer, settle timer, frame bitmaps, old shaders (c4a5ac5)  
  `plugin.ts:1453; draw.ts:193, 310`
- [x] **Minor** · S · Overlapping connects; preset links from the host go into href unchecked (c4a5ac5)  
  `plugin.ts:303, 441, 1253`
- [x] **Minor** · S–M · In-browser mode: brick bounds on the main thread, readiness read from status text, region controls shown though unsupported (c4a5ac5)  
  `local.ts:353; plugin.ts:840`
- [x] **Minor** · M · Stills have no progress or cancel; keyframes cannot be revisited or reordered; jobs are lost on reload (213a477)  
  `plugin.ts:919, 952`
- [x] **Minor** · S–M · Tests for the session lifecycle, view scheduling and frame parsing; README and docs names (89244e9, e10e332)  
  `plugin.ts:668; client.ts:259; README.md:42`
- [x] **Plan** · S · Splats stay visible, marked In progress (decision 5): a tag on the Splat card and in the docs, until a fit has run end to end (89244e9)  
  `plugins/anatomical-rendering/plugin.ts (Output); docs/plugins/anatomical-rendering.md`
- [x] **Minor** · S · Anatomical rendering: Tests for the session lifecycle (switch computer, reconnect, page close), with a fake context; the page-close request checked in a browser (found in 1C) (89244e9)  
  `plugin.ts closeSession, connect, pagehide`

## 2D2 · Panel: Track filtering

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/track-filtering

**Items:** 6

- [x] **Major** · L · One long page with private styling: Dataset, Group, Regions, Attributes, Stored groups, Output and Statistics cards (1cfaba4)  
  `plugin.ts:283, 2109`
- [x] **Major** · S · Wording: explanations, a shortcut-list empty state, a status that narrates (1cfaba4)  
  `plugin.ts:2182, 2191, 2378, 2404`
- [x] **Major** · M · Tags half supported: the runner refuses them; excludeTags has no control (1cfaba4, f467d1f)  
  `runner_job.ts:120; plugin.ts:2424`
- [x] **Major** · M–L · TrackGroups is untested (token races, store lifecycle, .trk header rewrite, density cancel) (1cfaba4)  
  `plugins/track-filtering/tests`
- [x] **Major** · S · Docs: stale names, Set vs Apply, missing features and files (07c22b2)  
  `manifest.ts:16, 26; README`
- [x] **Minor** · S–M · CSV export before the exact answer; choosing a group is an undo step, and + Sphere with no group yet makes up to three; non-atomic store save; density maps at a fixed 1 mm (1d77aeb, c2e2c63, 1cfaba4)  
  `plugin.ts:758, 1567, 1729, 1950`

## 2D3 · Panel: Luxar

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/luxar

**Items:** 5

- [x] **Major** · M · The 2-D slab is in millimetres (0.5–40): every EM mesh crosses every section (671e0ea)  
  `plugin.ts:535; style.ts:48`
- [x] **Major** · M · Panel not built from the shared parts: no cards, private CSS with a missing token, a 4 px radius (78e7124)  
  `plugin.ts:408, 440, 491, 562`
- [x] **Major** · S · Wording: explanatory notes, a 30-word empty state, renamed layer rows, a narrating status (78e7124)  
  `plugin.ts:366, 388, 532; layer_view.ts:281`
- [x] **Major** · M · Redraws the whole panel on any workspace change and writes state while drawing (an undo step from viewing) (78e7124)  
  `plugin.ts:106, 317, 478`
- [x] **Minor** · S · The toggle command is hidden for images and meshes; the 2,000-segment cap is silent (78e7124)  
  `manifest.ts:40; mesh_layers.ts:40`

## 2D4 · Panel: Registration

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/registration

**Items:** 11

- [x] **Major** · M · Cards are made by scraping h3 text (renaming loses their state): build card()s directly (d3c31a9)  
  `plugin.ts:1134`
- [x] **Major** · M · The whole panel rebuilds on any change: typing a value then Tab loses focus (d3c31a9)  
  `plugin.ts:775, 935, 1013`
- [x] **Major** · S · Empty state 'No 3-D layer to move.' sits above a panel of disabled controls (d3c31a9)  
  `plugin.ts:1017`
- [x] **Major** · S · Wording: explanatory notes and announcements (d3c31a9)  
  `plugin.ts:443, 498, 809, 910, 1044, 1086, 1097`
- [x] **Major** · S / L · Only rank-3 layers: document it (or support 2-D sections, channels, time) (d3c31a9)  
  `plugin.ts:226`
- [x] **Major** · S–M · A cubic save can need 8× the source size in memory, beyond the 512 MB cap (2b5724c)  
  `volume_io.ts:41, 108; save_worker.ts:171`
- [x] **Major** · M · The Registration class is untested (mark, refit, Live, Apply, followers, undo, warp, save) (d3c31a9)  
  `plugins/registration/tests`
- [x] **Minor** · S · Controls: selects without text-input, private .rg-num, sliders in the selection green, a text × (d3c31a9)  
  `plugin.ts:766, 1005, 1066, 1173`
- [x] **Minor** · S · LTA written without geometry silently; cancel leaves a partial folder; the same file cannot be re-imported (2b5724c, d3c31a9)  
  `plugin.ts:557, 667, 865`
- [x] **Minor** · M · No go-to on a pair row; dragging a landmark is not read back (d3c31a9)  
  `plugin.ts:731`
- [x] **Minor** · S · Guide and README omit Straighten, Warp and several import formats (3657135)  
  `manifest.ts:16; README`

## 2D5 · Panel: Filters

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/filters

**Items:** 7

- [x] **Major** · M · No cards, private helpers and style; --border is not a token so a literal colour applies (e548517)  
  `filters/plugin.ts:13–34`
- [x] **Major** · S · Selects and number boxes lack the shared classes; Remove is text unlike the × elsewhere (e548517)  
  `plugin.ts:194, 225, 271`
- [x] **Major** · M · Images it cannot filter (2-D, channels, RGB, time) are offered and fail late (e548517)  
  `plugin.ts:100`
- [x] **Major** · M · Each tuning adds a new layer: edit the selected filtered layer in place (e548517)  
  `plugin.ts:153`
- [x] **Major** · S · No upper bound on radius or sigma (a typo or a link can ask for a huge halo per chunk) (ee5edcf)  
  `plugin.ts:209; pipeline.ts:101`
- [x] **Major** · M · plugin.ts is untested (e548517)  
  `plugins/filters/tests`
- [x] **Minor** · S · DoG and Python output show white; empty state without action; a race in add(); docs say Filters tab (e548517, 372ea63)  
  `plugin.ts:152, 172, 293; filters.md:21`

## 2D6 · Panel: Orientations

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/orientations

**Items:** 7

- [x] **Major** · M · The panel rebuilds on every cursor move and glyph read (55fe78a)  
  `plugin.ts:655, 672, 722, 983`
- [x] **Major** · S · describe() announces store, kind, levels and glyph counts (55fe78a)  
  `plugin.ts:908, 970`
- [x] **Major** · S–M · About 17 controls without cards (Image, Glyphs, Views, Voxel) (55fe78a)  
  `plugin.ts:983`
- [x] **Major** · S · Private controls and CSS; format errors retried every 5 s forever (55fe78a)  
  `plugin.ts:402, 932, 1112`
- [x] **Major** · S–M · A size-1 time axis is refused (d0acf3f)  
  `ome4.ts:54`
- [x] **Minor** · S · Empty state without action; unclear names; WebGL context loss; stale docs (a47fdb1, 278c6b6)  
  `plugin.ts:976, 989; overlay.ts:53`
- [x] **Minor** · M · The plugin logic and GL code are untested (55fe78a, a47fdb1)  
  `plugins/orientations/tests`

## 2D7 · Panel: Time series

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/time-series

**Items:** 5

- [x] **Major** · M · Controls are rebuilt on every read, closing selects while playing (7a7f855)  
  `plugin.ts:997, 1110`
- [x] **Major** · S · Images it cannot read are left out silently ('No image with a time axis' while one is shown) (7a7f855)  
  `plugin.ts:294, 314`
- [x] **Major** · S · Explanatory text and a two-sentence empty state (7a7f855)  
  `plugin.ts:1051, 1136`
- [x] **Minor** · S · Hand-drawn transport icons, hand-built controls, a literal cursor colour, no Retry (7a7f855)  
  `plugin.ts:34, 187, 1024, 1103`
- [x] **Minor** · M · Panel logic untested; docs say bottom dock (7a7f855, c92c91c)  
  `time-series.md:6`

## 2D8 · Panel: Atlas

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/atlas

**Items:** 4

- [x] **Major** · S · Go to has no progress or cancel; repeated clicks start parallel passes (55e46f9)  
  `plugin.ts:248; label_client.ts:68`
- [x] **Major** · M · No cards; private stylesheet, inline styles and its own button helper (55e46f9)  
  `plugin.ts:18, 352, 438`
- [x] **Major** · S · Wording: narrating status lines and an instruction; a cancelled count never restarts (55e46f9)  
  `plugin.ts:215, 351, 434, 468`
- [x] **Minor** · S · Unbounded count cache; imports Annotations internals; docs disagree with the UI (55e46f9, 4d82bc4)  
  `plugin.ts:11, 69; manifest.ts:307`

## 2D9 · Panel: Segmentation

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/segmentation

**Items:** 5

- [x] **Major** · S · Save errors appear only inside the closed Save card (aa6b6a3)  
  `editor.ts:1640, 1816; panel.ts:267`
- [x] **Major** · S–M · Recent strokes can be lost on close; no persistent storage request (4d3ce21)  
  `session.ts:66, 140, 144`
- [x] **Major** · M · Borrows Annotations' private classes; literal colours; errors coloured as warnings (aa6b6a3)  
  `style.ts:5, 24, 79; preview.ts:182`
- [x] **Major** · S–M · Browser copies pile up unmanaged; Discard without confirm (4d3ce21, aa6b6a3)  
  `keep.ts; panel.ts:210, 223`
- [x] **Major** · S · Wording and docs: narrating status, model and licence paragraph, Save described at the top (aa6b6a3, 1dd5e3f)  
  `panel.ts:254, 268, 578; docs`

## 2D10 · Panel: Annotations

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/annotations

**Items:** 4

- [x] **Major** · S · Explanations in the panel and empty states without action (bfdb86a)  
  `annotate_panel.ts:187; measure_panel.ts:177, 194; statistics_panel.ts:224`
- [x] **Major** · S · Statistics cannot be cancelled (bfdb86a)  
  `statistics_panel.ts:200`
- [x] **Minor** · S–M · Controls inconsistent across sections; the colour swatch class is missing; dead CSS (bfdb86a, e131648)  
  `labels.ts:433; style.ts:137, 188; table_panel.ts:337`
- [x] **Minor** · S · Drawing completion polled every 250 ms; a disabled button without a reason; stale docs (76a2b5a, e90b709)  
  `annotate.ts:227; labels.ts:433`

## 2D11 · Panel: OME Collections

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/collections

**Items:** 6

- [x] **Major** · S · NGFF 0.6 rotation and mapAxis transforms are not composed (members hidden silently) (4ea9ebe)  
  `collection.ts:103`
- [x] **Major** · S–M · Every member is added as an image, so label images show grey (4ea9ebe)  
  `plugin.ts:375`
- [x] **Major** · S · Notes repeat what the graph shows; private radii, inline styles and a private remove button (4ea9ebe)  
  `plugin.ts:119, 614, 770, 992, 1002`
- [x] **Major** · M · plugin.ts is untested (follow, generations, fromView, discover) (4ea9ebe)  
  `plugins/collections/tests`
- [x] **Minor** · M · Affine relationships are typed as 12 numbers: a matrix editor (4ea9ebe)  
  `plugin.ts:918`
- [x] **Minor** · S · download() duplicates downloadBlob; unknown units become mm silently; no timeouts on discovery (4ea9ebe, 4ea4516)  
  `plugin.ts:58, 258, 289, 582`

## 2D12 · Panels: Layers, Settings and the shell

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** src/ui/panels, src/ui/sheets.ts, src/ui/runner.ts, src/sw.ts

**Items:** 4

- [x] **Major** · S · Design system: Inline styles: Anatomical 51 elements, Layers 21, Atlas 3. Move to classes (691ffbe, b42b9db)  
  `measured; plugin.ts files`
- [x] **Major** · S · Core app: Empty states without their action: No data in this scene, No rules, Nothing is served, No jobs, a failed panel without Retry (4966ae9)  
  `datasets.ts:136; auth.ts:138; runner.ts:304, 494; docks.ts:233`
- [x] **Major** · S · Core app: Remaining explanatory notes: local data, plugin URL, Google client ID, Add a computer, Saved with the workspace (1b32cd8, 4966ae9)  
  `sheets.ts:375, 426; misc.ts:116; auth.ts:646; runner.ts:352`
- [x] **Major** · S · Core app: Old tab names in user-facing strings: Add → Local file, Auth tab, Jobs tab (dfd6b21)  
  `src/sw.ts:141; engine/google_gcs.ts:84; runner/__main__.py:119`

## 2E · Docs and screenshots

**Goal:** Every guide, README and figure matches the new layout and names.

**Files:** docs/, plugins/*/README.md, manifests' guides, STATUS.md

**Items:** 5

- [x] **Major** · S–M · Core app: Docs and the numbered interface figure predate the new layout (signing-in, data, from-neuroglancer, from-freeview, local-jobs, runner README, STATUS) (1bc85cc)  
  `docs/guide/*; docs/images/interface-numbered.png`
- [x] **Major** · S · All plugins: Docs sweep: 'X tab', 'bottom dock', 'Jobs tab' throughout plugin guides, READMEs and user pages (e0e65c4, 88eb567)  
  `docs/plugins; plugins/*/README.md; manifests`
- [x] **Major** · S–M · Zarr Vectors: User doc misses GraphML, Parquet, Arrow, LAS/LAZ, CIFTI and EM meshes; no troubleshooting (4d22df7)  
  `docs/plugins/zarr-vectors.md`
- [x] **Minor** · S · Core app: State the supported browsers (folder access, MP4 and file system access are Chrome and Edge only) (1bc85cc)  
  `README, docs`
- [x] **Minor** · S · Core app: Junk and internal files: volume.ts.orig, TODO.md; no SDK reference page (86068ed)  
  `src/virtual/out; docs`
