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

- [ ] **Major** · S · The muted class used for 9 notes does not exist  
  `plugin.ts:561, 1280, 1413`
- [ ] **Major** · M · Private styles, literal colours, about 30 inline styles; the splat window should be a platform sheet  
  `plugin.ts:166, 594; editor.ts:156; splatview.ts:422`
- [ ] **Major** · S · Split the long cards: Regions and Quality out of Rendering; Movie and Splat out of Output  
  `plugin.ts:1297, 1390`
- [ ] **Major** · S · Wording: the status repeats the GPU and says 'off'; labels carry explanations; three unlabelled checkboxes  
  `plugin.ts:1172, 1194, 584, 1207`
- [ ] **Major** · M · Check the image's axes first (time, channels, 2-D); the L/R/A/P/S/I buttons assume RAS  
  `plugin.ts:341, 1285`
- [ ] **Major** · S–M · Splats are offered but have never run: mark them experimental until a real run; test the .ply reader  
  `plugin.ts:1096; splatview.ts:60`
- [ ] **Minor** · S · Dispose leaks: the WebGPU renderer, settle timer, frame bitmaps, old shaders  
  `plugin.ts:1453; draw.ts:193, 310`
- [ ] **Minor** · S · Overlapping connects; preset links from the host go into href unchecked  
  `plugin.ts:303, 441, 1253`
- [ ] **Minor** · S–M · In-browser mode: brick bounds on the main thread, readiness read from status text, region controls shown though unsupported  
  `local.ts:353; plugin.ts:840`
- [ ] **Minor** · M · Stills have no progress or cancel; keyframes cannot be revisited or reordered; jobs are lost on reload  
  `plugin.ts:919, 952`
- [ ] **Minor** · S–M · Tests for the session lifecycle, view scheduling and frame parsing; README and docs names  
  `plugin.ts:668; client.ts:259; README.md:42`
- [ ] **Plan** · S · Splats stay visible, marked In progress (decision 5): a tag on the Splat card and in the docs, until a fit has run end to end  
  `plugins/anatomical-rendering/plugin.ts (Output); docs/plugins/anatomical-rendering.md`
- [ ] **Minor** · S · Anatomical rendering: Tests for the session lifecycle (switch computer, reconnect, page close), with a fake context; the page-close request checked in a browser (found in 1C)  
  `plugin.ts closeSession, connect, pagehide`

## 2D2 · Panel: Track filtering

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/track-filtering

**Items:** 6

- [ ] **Major** · L · One long page with private styling: Dataset, Group, Regions, Attributes, Stored groups, Output and Statistics cards  
  `plugin.ts:283, 2109`
- [ ] **Major** · S · Wording: explanations, a shortcut-list empty state, a status that narrates  
  `plugin.ts:2182, 2191, 2378, 2404`
- [ ] **Major** · M · Tags half supported: the runner refuses them; excludeTags has no control  
  `runner_job.ts:120; plugin.ts:2424`
- [ ] **Major** · M–L · TrackGroups is untested (token races, store lifecycle, .trk header rewrite, density cancel)  
  `plugins/track-filtering/tests`
- [ ] **Major** · S · Docs: stale names, Set vs Apply, missing features and files  
  `manifest.ts:16, 26; README`
- [ ] **Minor** · S–M · CSV export before the exact answer; choosing a group is an undo step, and + Sphere with no group yet makes up to three; non-atomic store save; density maps at a fixed 1 mm  
  `plugin.ts:758, 1567, 1729, 1950`

## 2D3 · Panel: Luxar

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/luxar

**Items:** 5

- [ ] **Major** · M · The 2-D slab is in millimetres (0.5–40): every EM mesh crosses every section  
  `plugin.ts:535; style.ts:48`
- [ ] **Major** · M · Panel not built from the shared parts: no cards, private CSS with a missing token, a 4 px radius  
  `plugin.ts:408, 440, 491, 562`
- [ ] **Major** · S · Wording: explanatory notes, a 30-word empty state, renamed layer rows, a narrating status  
  `plugin.ts:366, 388, 532; layer_view.ts:281`
- [ ] **Major** · M · Redraws the whole panel on any workspace change and writes state while drawing (an undo step from viewing)  
  `plugin.ts:106, 317, 478`
- [ ] **Minor** · S · The toggle command is hidden for images and meshes; the 2,000-segment cap is silent  
  `manifest.ts:40; mesh_layers.ts:40`

## 2D4 · Panel: Registration

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/registration

**Items:** 11

- [ ] **Major** · M · Cards are made by scraping h3 text (renaming loses their state): build card()s directly  
  `plugin.ts:1134`
- [ ] **Major** · M · The whole panel rebuilds on any change: typing a value then Tab loses focus  
  `plugin.ts:775, 935, 1013`
- [ ] **Major** · S · Empty state 'No 3-D layer to move.' sits above a panel of disabled controls  
  `plugin.ts:1017`
- [ ] **Major** · S · Wording: explanatory notes and announcements  
  `plugin.ts:443, 498, 809, 910, 1044, 1086, 1097`
- [ ] **Major** · S / L · Only rank-3 layers: document it (or support 2-D sections, channels, time)  
  `plugin.ts:226`
- [ ] **Major** · S–M · A cubic save can need 8× the source size in memory, beyond the 512 MB cap  
  `volume_io.ts:41, 108; save_worker.ts:171`
- [ ] **Major** · M · The Registration class is untested (mark, refit, Live, Apply, followers, undo, warp, save)  
  `plugins/registration/tests`
- [ ] **Minor** · S · Controls: selects without text-input, private .rg-num, sliders in the selection green, a text ×  
  `plugin.ts:766, 1005, 1066, 1173`
- [ ] **Minor** · S · LTA written without geometry silently; cancel leaves a partial folder; the same file cannot be re-imported  
  `plugin.ts:557, 667, 865`
- [ ] **Minor** · M · No go-to on a pair row; dragging a landmark is not read back  
  `plugin.ts:731`
- [ ] **Minor** · S · Guide and README omit Straighten, Warp and several import formats  
  `manifest.ts:16; README`

## 2D5 · Panel: Filters

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/filters

**Items:** 7

- [ ] **Major** · M · No cards, private helpers and style; --border is not a token so a literal colour applies  
  `filters/plugin.ts:13–34`
- [ ] **Major** · S · Selects and number boxes lack the shared classes; Remove is text unlike the × elsewhere  
  `plugin.ts:194, 225, 271`
- [ ] **Major** · M · Images it cannot filter (2-D, channels, RGB, time) are offered and fail late  
  `plugin.ts:100`
- [ ] **Major** · M · Each tuning adds a new layer: edit the selected filtered layer in place  
  `plugin.ts:153`
- [ ] **Major** · S · No upper bound on radius or sigma (a typo or a link can ask for a huge halo per chunk)  
  `plugin.ts:209; pipeline.ts:101`
- [ ] **Major** · M · plugin.ts is untested  
  `plugins/filters/tests`
- [ ] **Minor** · S · DoG and Python output show white; empty state without action; a race in add(); docs say Filters tab  
  `plugin.ts:152, 172, 293; filters.md:21`

## 2D6 · Panel: Orientations

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/orientations

**Items:** 7

- [ ] **Major** · M · The panel rebuilds on every cursor move and glyph read  
  `plugin.ts:655, 672, 722, 983`
- [ ] **Major** · S · describe() announces store, kind, levels and glyph counts  
  `plugin.ts:908, 970`
- [ ] **Major** · S–M · About 17 controls without cards (Image, Glyphs, Views, Voxel)  
  `plugin.ts:983`
- [ ] **Major** · S · Private controls and CSS; format errors retried every 5 s forever  
  `plugin.ts:402, 932, 1112`
- [ ] **Major** · S–M · A size-1 time axis is refused  
  `ome4.ts:54`
- [ ] **Minor** · S · Empty state without action; unclear names; WebGL context loss; stale docs  
  `plugin.ts:976, 989; overlay.ts:53`
- [ ] **Minor** · M · The plugin logic and GL code are untested  
  `plugins/orientations/tests`

## 2D7 · Panel: Time series

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/time-series

**Items:** 5

- [ ] **Major** · M · Controls are rebuilt on every read, closing selects while playing  
  `plugin.ts:997, 1110`
- [ ] **Major** · S · Images it cannot read are left out silently ('No image with a time axis' while one is shown)  
  `plugin.ts:294, 314`
- [ ] **Major** · S · Explanatory text and a two-sentence empty state  
  `plugin.ts:1051, 1136`
- [ ] **Minor** · S · Hand-drawn transport icons, hand-built controls, a literal cursor colour, no Retry  
  `plugin.ts:34, 187, 1024, 1103`
- [ ] **Minor** · M · Panel logic untested; docs say bottom dock  
  `time-series.md:6`

## 2D8 · Panel: Atlas

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/atlas

**Items:** 4

- [ ] **Major** · S · Go to has no progress or cancel; repeated clicks start parallel passes  
  `plugin.ts:248; label_client.ts:68`
- [ ] **Major** · M · No cards; private stylesheet, inline styles and its own button helper  
  `plugin.ts:18, 352, 438`
- [ ] **Major** · S · Wording: narrating status lines and an instruction; a cancelled count never restarts  
  `plugin.ts:215, 351, 434, 468`
- [ ] **Minor** · S · Unbounded count cache; imports Annotations internals; docs disagree with the UI  
  `plugin.ts:11, 69; manifest.ts:307`

## 2D9 · Panel: Segmentation

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/segmentation

**Items:** 5

- [ ] **Major** · S · Save errors appear only inside the closed Save card  
  `editor.ts:1640, 1816; panel.ts:267`
- [ ] **Major** · S–M · Recent strokes can be lost on close; no persistent storage request  
  `session.ts:66, 140, 144`
- [ ] **Major** · M · Borrows Annotations' private classes; literal colours; errors coloured as warnings  
  `style.ts:5, 24, 79; preview.ts:182`
- [ ] **Major** · S–M · Browser copies pile up unmanaged; Discard without confirm  
  `keep.ts; panel.ts:210, 223`
- [ ] **Major** · S · Wording and docs: narrating status, model and licence paragraph, Save described at the top  
  `panel.ts:254, 268, 578; docs`

## 2D10 · Panel: Annotations

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/annotations

**Items:** 4

- [ ] **Major** · S · Explanations in the panel and empty states without action  
  `annotate_panel.ts:187; measure_panel.ts:177, 194; statistics_panel.ts:224`
- [ ] **Major** · S · Statistics cannot be cancelled  
  `statistics_panel.ts:200`
- [ ] **Minor** · S–M · Controls inconsistent across sections; the colour swatch class is missing; dead CSS  
  `labels.ts:433; style.ts:137, 188; table_panel.ts:337`
- [ ] **Minor** · S · Drawing completion polled every 250 ms; a disabled button without a reason; stale docs  
  `annotate.ts:227; labels.ts:433`

## 2D11 · Panel: OME Collections

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** plugins/collections

**Items:** 6

- [ ] **Major** · S · NGFF 0.6 rotation and mapAxis transforms are not composed (members hidden silently)  
  `collection.ts:103`
- [ ] **Major** · S–M · Every member is added as an image, so label images show grey  
  `plugin.ts:375`
- [ ] **Major** · S · Notes repeat what the graph shows; private radii, inline styles and a private remove button  
  `plugin.ts:119, 614, 770, 992, 1002`
- [ ] **Major** · M · plugin.ts is untested (follow, generations, fromView, discover)  
  `plugins/collections/tests`
- [ ] **Minor** · M · Affine relationships are typed as 12 numbers: a matrix editor  
  `plugin.ts:918`
- [ ] **Minor** · S · download() duplicates downloadBlob; unknown units become mm silently; no timeouts on discovery  
  `plugin.ts:58, 258, 289, 582`

## 2D12 · Panels: Layers, Settings and the shell

**Goal:** Moved onto the shared parts (cards, fields, slider, empty state, status), its wording to the rules, its panel updated in place rather than rebuilt, and its own fixes and tests while the files are open.

**Files:** src/ui/panels, src/ui/sheets.ts, src/ui/runner.ts, src/sw.ts

**Items:** 4

- [ ] **Major** · S · Design system: Inline styles: Anatomical 51 elements, Layers 21, Atlas 3. Move to classes  
  `measured; plugin.ts files`
- [ ] **Major** · S · Core app: Empty states without their action: No data in this scene, No rules, Nothing is served, No jobs, a failed panel without Retry  
  `datasets.ts:136; auth.ts:138; runner.ts:304, 494; docks.ts:233`
- [ ] **Major** · S · Core app: Remaining explanatory notes: local data, plugin URL, Google client ID, Add a computer, Saved with the workspace  
  `sheets.ts:375, 426; misc.ts:116; auth.ts:646; runner.ts:352`
- [ ] **Major** · S · Core app: Old tab names in user-facing strings: Add → Local file, Auth tab, Jobs tab  
  `src/sw.ts:141; engine/google_gcs.ts:84; runner/__main__.py:119`

## 2E · Docs and screenshots

**Goal:** Every guide, README and figure matches the new layout and names.

**Files:** docs/, plugins/*/README.md, manifests' guides, STATUS.md

**Items:** 5

- [ ] **Major** · S–M · Core app: Docs and the numbered interface figure predate the new layout (signing-in, data, from-neuroglancer, from-freeview, local-jobs, runner README, STATUS)  
  `docs/guide/*; docs/images/interface-numbered.png`
- [ ] **Major** · S · All plugins: Docs sweep: 'X tab', 'bottom dock', 'Jobs tab' throughout plugin guides, READMEs and user pages  
  `docs/plugins; plugins/*/README.md; manifests`
- [ ] **Major** · S–M · Zarr Vectors: User doc misses GraphML, Parquet, Arrow, LAS/LAZ, CIFTI and EM meshes; no troubleshooting  
  `docs/plugins/zarr-vectors.md`
- [ ] **Minor** · S · Core app: State the supported browsers (folder access, MP4 and file system access are Chrome and Edge only)  
  `README, docs`
- [ ] **Minor** · S · Core app: Junk and internal files: volume.ts.orig, TODO.md; no SDK reference page  
  `src/virtual/out; docs`
