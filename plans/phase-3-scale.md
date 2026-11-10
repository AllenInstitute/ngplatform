# Phase 3: Scale

About two weeks. 3A and 3B can run beside 3C and 3D.

Each batch ends with the checks in [README.md](README.md#checks-for-every-batch). Tick an item when it is merged, with the commit: `- [x] … (abc1234)`.

## 3A · Render service

**Goal:** One GPU budget and job queue on the render computer; bounded disk; the service fully tested.

**Files:** runner/ngplatform_render

**Items:** 7 (1 blocker)

- [x] **Blocker** · L · No GPU budget: unlimited sessions, every still/movie/splat uploads its own volume copy (about 0.8 GB). One budget, an admission check, one job at a time, a shared texture (4c92d56, 7c6d42f)  
  `server.py:620, 733, 968, 1059`
- [x] **Major** · M · Disk grows without limit: derived-level cache never evicted (keyed by URL only), movie frames kept, no free-space check (92e18e0, 4c92d56)  
  `volumes.py:308, 635; server.py:636`
- [x] **Major** · M · Splat fit: ignores --device, loads every view onto the GPU, gsplat unpinned, never run (7216b87)  
  `splat/fit.py:70, 85; server.py:787, 825`
- [x] **Major** · S · Movie and splat downloads are read whole into memory: stream with Range (4c92d56)  
  `server.py:1121, 1135`
- [x] **Major** · M · Untested: /still, a movie end to end, a splat with steps 0, fit.py, out-of-memory paths, c/t axes, v2 stores (4c92d56, 7216b87)  
  `runner/tests`
- [x] **Minor** · M · Channel and time silently pinned to index 0: expose them (92e18e0, 7c6d42f)  
  `volumes.py:347`
- [x] **Minor** · S–M · Leaks: pinned host memory per renderer, CuPy's pool, detail arrays; closing a loading session does not stop the load (92e18e0, 4c92d56)  
  `renderer.py:225; detail.py:170; server.py:138`

## 3B · Readers and data formats

**Goal:** Readers handle every image type and size they meet, with bounded memory and visible warnings.

**Files:** plugins/volume-view, plugins/zarr-vectors

**Items:** 9

- [x] **Major** · M · Shared readers: Non-uint8 precomputed images fail through the reader (1d6fcd6)  
  `volume_reader.ts:300; sdk/precomputed.ts:136`
- [x] **Major** · S–M · Shared readers: About 1,500 lines of dead code from the removed Volume plugin (SolidDrawer, bricks, plane reads) (d5487f9)  
  `solid.ts:359; bricks.ts; volume_reader.ts:629`
- [x] **Major** · S · Shared readers: Whole-volume reads have no size limit: refuse with a message instead of crashing the tab (1d6fcd6)  
  `volume_reader.ts:336, 387`
- [x] **Major** · S · Zarr Vectors: A user-facing error still says Jobs → This computer (f519eb7)  
  `src/virtual/vectors/spill.ts:21`
- [x] **Major** · M · Zarr Vectors: Mesh cell reads cannot be cancelled or retried; one failed fragment drops the cell (344baa5)  
  `precomputed_meshes.ts:372, 478`
- [x] **Major** · M · Zarr Vectors: Warnings (newer version, dropped tags, unreadable columns) go only to the console (e5e1ef6)  
  `util.ts:22; store.ts:280; objects.ts:556`
- [x] **Major** · M · Zarr Vectors: Memory budgets are per store and add up past 1.5 GB with three stores (e5e1ef6)  
  `object_reader.ts:349; links.ts:271`
- [x] **Minor** · M · Shared readers: Untested: window, region reads, precomputed through the reader, cancel (1d6fcd6)  
  `plugins/volume-view/tests`
- [x] **Minor** · S · Zarr Vectors: Ids ≥ 2^63 wrap; a quadratic indexOf; inconsistent figures and tab names (344baa5)  
  `precomputed_meshes.ts:286, 460`

## 3C · Plugin performance

**Goal:** Large data (millions of streamlines, 100k segments, 10^5 annotations, thousands of EM cells) stays responsive.

**Files:** plugins/annotations, track-filtering, luxar, segmentation, atlas, collections; src/ui/panels/datasets.ts

**Items:** 17

- [x] **Major** · M · Core app: The Layers list rebuilds whole on every settle (400 ms after navigation): update rows by key (580fdc9)  
  `src/ui/panels/datasets.ts:136, 252`
- [x] **Major** · S–M · OME Collections: Members are placed one by one, each waiting up to 20 s on failure: run them together (7aa3f25)  
  `plugin.ts:412, 464`
- [x] **Major** · S · Track filtering: The region result cache can reach gigabytes: bound it by bytes (0311a96)  
  `roi_client.ts:113`
- [x] **Major** · M · Track filtering: Superseded region tests keep running; the region worker is never restarted after a crash (74215bd)  
  `roi_client.ts:91, 111`
- [x] **Major** · S · Track filtering: Outside Chrome and Edge saves are built in memory, against what the guide says (74215bd)  
  `plugin.ts:219; manifest.ts:22`
- [x] **Major** · M · Track filtering: Per-group stores are written on the main thread, rebuilt on each answer, kept after switching off (74215bd)  
  `plugin.ts:479, 1406`
- [x] **Major** · M · Luxar: Each added segment rebuilds the whole mesh store and re-reads every manifest (0599762)  
  `mesh_layers.ts:40; plugin.ts:120, 309`
- [x] **Major** · S–M · Luxar: One failed manifest fails the layer (2,000 unthrottled reads) (344baa5)  
  `precomputed_meshes.ts:234`
- [x] **Major** · M · Luxar: Signed-in, CAVE and graphene segmentations are missed (a 403 reads as 'no meshes') (0599762)  
  `mesh_layers.ts:52; sdk/sources.ts:4`
- [x] **Major** · L · Luxar: One WebGL context and about 2 GB GPU per layer: a shared 2-D context and a global budget (52c3f35)  
  `view2d.ts:25; view3d.ts:23`
- [x] **Major** · M · Segmentation: Removing the layer in Neuroglancer leaks its session (up to 1 GB) (afb47d9)  
  `editor.ts:269, 708, 894`
- [x] **Major** · M–L · Segmentation: Many segments bloat state and undo; the segment list and toolbar select are not virtualised (db5b0c7)  
  `editor.ts:643, 831; segments.ts:58; panel.ts:423`
- [x] **Major** · M · Atlas: Volumes and 'Only regions in the image' use a coarse level, hiding small regions by default (42743bf, f4ce5f9)  
  `labels.ts:274; plugin.ts:60`
- [x] **Major** · M · Annotations: Every state change (including camera moves) rescans all annotations in four places (32982a7)  
  `annotate.ts:431; table_panel.ts:94; measure_panel.ts:247`
- [x] **Major** · S · Annotations: The Measure table has no row cap (32982a7)  
  `measure_panel.ts:199`
- [x] **Minor** · M · Luxar: Worker reads cannot be cancelled; the 2-D context is not restored after loss; tests for the lifecycle (0599762, 52c3f35, 805b767)  
  `luxar_worker.ts:195; view2d.ts:56`
- [x] **Minor** · M · Segmentation: Big saves on the main thread or in memory; undo forgets silently past 512 MB; the SAM worker never released (5bdb610, 597b35e, f8ce8ee)  
  `editor.ts:55, 552; save.ts:66; sam_model.ts:136`

## 3D · Core robustness

**Goal:** Slow or failing networks, big exports and the service worker behave.

**Files:** src/ui/shell.ts, src/platform/runner.ts, src/platform/hosts.ts, src/sw.ts, src/ui/export.ts, src/ui/docks.ts

**Items:** 4

- [x] **Minor** · S · Two in-flight renders of a lazy panel can leak a disposer (81005fb)  
  `docks.ts:223`
- [x] **Minor** · S · No timeouts on remote state and runner requests (a half-open SSH tunnel hangs); pause host polling in hidden tabs (a637320)  
  `shell.ts:1343; platform/runner.ts:134; hosts.ts:295`
- [x] **Minor** · S · Service worker: /virtual/ matched anywhere, unversioned skipWaiting, timers left running (b252bf2)  
  `src/sw.ts:45, 88, 178`
- [x] **Minor** · M · Large exports build whole zips in memory outside Chrome; share links grow without a limit (5747e36)  
  `export.ts:281; shell.ts:597`
