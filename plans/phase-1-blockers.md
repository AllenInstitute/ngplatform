# Phase 1: Data loss and crashes

About a week. Four batches with no shared files, so they can run in parallel and merge one at a time.

Each batch ends with the checks in [README.md](README.md#checks-for-every-batch). Tick an item when it is merged, with the commit: `- [x] … (abc1234)`.

## 1A · Readers

**Goal:** Every image tool can read Zarr v2 / OME-Zarr 0.4 and images with size-1 time or channel axes.

**Files:** plugins/volume-view (shared readers), plugins/orientations/zarr2.ts (moved)

**Items:** 3 (2 blockers)

- [x] **Blocker** · S · Zarr v2 / OME-Zarr 0.4 arrays cannot be read: measuring, Segmentation, Registration save and in-browser rendering all fail on them (2f1a010, ff1922b)  
  `volume-view/volume_reader.ts:217`
- [x] **Blocker** · M · Size-1 t and c axes are refused (tczyx with t = c = 1, the bioformats2raw default) (ff1922b)  
  `volume-view/ome.ts:176`
- [x] **Minor** · S · Errors name the removed tool; non-zero fill values wrap; one failed chunk does not stop the rest; cm and Å units missing (ff1922b)  
  `volume_reader.ts:55, 201, 336; ome.ts:90`

## 1B · Plugin crashes

**Goal:** No data loss or crash in Segmentation, the EM mesh store, Luxar or Track filtering.

**Files:** plugins/segmentation, plugins/zarr-vectors/src/virtual/precomputed_meshes.ts, plugins/luxar/plugin.ts, plugins/track-filtering/plugin.ts

**Items:** 7 (5 blockers)

- [x] **Blocker** · S–M · Track filtering: Recomputed results and density shaders flood undo and the link (undo removes them, they come straight back) (cf72f89)  
  `plugin.ts:1543, 1554, 1733`
- [x] **Blocker** · M · Track filtering: Every progress tick re-histograms every attribute over all objects: stalls at millions of streamlines (cf72f89)  
  `plugin.ts:1191, 1377, 2439, 2651`
- [x] **Blocker** · S · Luxar: Switching Luxar off while a segmentation's info loads leaks workers and WebGL contexts and leaves the layer hidden (a3ec0c6)  
  `plugin.ts:140`
- [x] **Blocker** · S · Segmentation: Saving again into the same folder brings erased labels back (old chunk files stay) (e77ecb0)  
  `editor.ts:1741, 1843; save.ts:76`
- [x] **Blocker** · S · Segmentation: The toolbar throws past about 100k segments (Math.max spread) (e77ecb0)  
  `toolbar.ts:197`
- [x] **Major** · S · Zarr Vectors: The precomputed-mesh cache's byte count drifts negative, so its limit stops working (7b0c104)  
  `src/virtual/precomputed_meshes.ts:501`
- [x] **Major** · S · Zarr Vectors: Math.min(...cells) throws past about 100k cells (7b0c104)  
  `precomputed_meshes.ts:302`

## 1C · Render

**Goal:** The render computer cannot be run out of memory or left with leaked sessions by one page or one request.

**Files:** plugins/anatomical-rendering/plugin.ts, runner/ngplatform_render/server.py

**Items:** 12 (2 blockers)

- [x] **Blocker** · S · Anatomical rendering: GPU sessions leak on the host when switching computer, reconnecting or closing the page (845fa7b, 3b95a51)  
  `plugin.ts:370, 747`
- [x] **Blocker** · M · Render service: A still is path-traced inside the HTTP request (up to 8192² × 4096 samples) with no cancel: make it a job or cap it (3b95a51, 845fa7b)  
  `server.py:1059`
- [x] **Major** · S · Anatomical rendering: A new session reuses the old one's cameras and distances (845fa7b)  
  `plugin.ts:743`
- [x] **Major** · S–M · Anatomical rendering: Errors stick: no Retry, a dropped session is polled forever, the status shows only its last line (845fa7b)  
  `plugin.ts:373, 674, 789, 1194`
- [x] **Major** · S · Anatomical rendering: Unchecked inputs: window step for 0–1 images, movie sizes and fps (the full movie needs even sizes), the 8-box limit (845fa7b)  
  `plugin.ts:648, 1385, 1392`
- [x] **Major** · S · Render service: The render loop retries out-of-memory every 0.5 s forever: mark the session failed, free it, tell the page (3b95a51)  
  `server.py:518`
- [x] **Major** · S · Render service: PUT /view sizes and samples are unbounded: clamp as /still does (3b95a51)  
  `server.py:330, 360, 987`
- [x] **Major** · S · Render service: Movie inputs unchecked: fps 0 divides by zero; frames × pixels unbounded (3b95a51)  
  `server.py:624`
- [x] **Major** · S · Render service: ffmpeg is looked for only after every frame is rendered; check at start and in /info; keep its errors (3b95a51, 845fa7b)  
  `server.py:656, 660`
- [x] **Major** · S · Render service: H.264 needs even sizes: fails after the whole render (3b95a51)  
  `server.py:627`
- [x] **Major** · S · Render service: Jobs can overwrite files in data folders: a fresh subfolder per job (3b95a51)  
  `server.py:889`
- [x] **Minor** · S · Render service: Small things: query decoding and 400s, list pruning without the lock, ffmpeg kept on DELETE, an optional source allow-list (3b95a51)  
  `server.py:951, 992, 1088, 1132, 883`

## 1D · Core

**Goal:** The app always boots, errors are visible, and dialogs opened from dialogs work.

**Files:** src/main.ts, src/engine/plugins.ts, src/ui/overlays.ts

**Items:** 4 (3 blockers)

- [x] **Blocker** · S · A failed plugin import leaves a blank page: catch per plugin, boot anyway, reload once on a stale chunk after a redeploy (bb943a2)  
  `src/main.ts:42, src/engine/plugins.ts:17`
- [x] **Blocker** · S–M · No error reporting: a global error / unhandledrejection handler to Activity and a toast, an opt-in reporter, hidden source maps (bb943a2; no reporter, decision 3)  
  `src/`
- [x] **Blocker** · M · Opening a dialog from Settings closes Settings, and a second confirm cancels the first: a sheet stack (4fd8b78)  
  `src/ui/overlays.ts:10, 136; remote.ts:59; runner.ts:349`
- [x] **Plan** · S · Errors are kept locally (decision 3): Activity gets them, and Settings › Developer can save the log as a file; no remote reporter (4e4a376)  
  `src/ui/panels/activity.ts; Settings › Developer`
