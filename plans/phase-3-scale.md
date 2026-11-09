# Phase 3: Scale

About two weeks. 3A and 3B can run beside 3C and 3D.

Each batch ends with the checks in [README.md](README.md#checks-for-every-batch). Tick an item when it is merged, with the commit: `- [x] … (abc1234)`.

## 3A · Render service

**Goal:** One GPU budget and job queue on the render computer; bounded disk; the service fully tested.

**Files:** runner/ngplatform_render

**Items:** 7 (1 blocker)

- [ ] **Blocker** · L · No GPU budget: unlimited sessions, every still/movie/splat uploads its own volume copy (about 0.8 GB). One budget, an admission check, one job at a time, a shared texture  
  `server.py:620, 733, 968, 1059`
- [ ] **Major** · M · Disk grows without limit: derived-level cache never evicted (keyed by URL only), movie frames kept, no free-space check  
  `volumes.py:308, 635; server.py:636`
- [ ] **Major** · M · Splat fit: ignores --device, loads every view onto the GPU, gsplat unpinned, never run  
  `splat/fit.py:70, 85; server.py:787, 825`
- [ ] **Major** · S · Movie and splat downloads are read whole into memory: stream with Range  
  `server.py:1121, 1135`
- [ ] **Major** · M · Untested: /still, a movie end to end, a splat with steps 0, fit.py, out-of-memory paths, c/t axes, v2 stores  
  `runner/tests`
- [ ] **Minor** · M · Channel and time silently pinned to index 0: expose them  
  `volumes.py:347`
- [ ] **Minor** · S–M · Leaks: pinned host memory per renderer, CuPy's pool, detail arrays; closing a loading session does not stop the load  
  `renderer.py:225; detail.py:170; server.py:138`

## 3B · Readers and data formats

**Goal:** Readers handle every image type and size they meet, with bounded memory and visible warnings.

**Files:** plugins/volume-view, plugins/zarr-vectors

**Items:** 9

- [ ] **Major** · M · Shared readers: Non-uint8 precomputed images fail through the reader  
  `volume_reader.ts:300; sdk/precomputed.ts:136`
- [ ] **Major** · S–M · Shared readers: About 1,500 lines of dead code from the removed Volume plugin (SolidDrawer, bricks, plane reads)  
  `solid.ts:359; bricks.ts; volume_reader.ts:629`
- [ ] **Major** · S · Shared readers: Whole-volume reads have no size limit: refuse with a message instead of crashing the tab  
  `volume_reader.ts:336, 387`
- [ ] **Major** · S · Zarr Vectors: A user-facing error still says Jobs → This computer  
  `src/virtual/vectors/spill.ts:21`
- [ ] **Major** · M · Zarr Vectors: Mesh cell reads cannot be cancelled or retried; one failed fragment drops the cell  
  `precomputed_meshes.ts:372, 478`
- [ ] **Major** · M · Zarr Vectors: Warnings (newer version, dropped tags, unreadable columns) go only to the console  
  `util.ts:22; store.ts:280; objects.ts:556`
- [ ] **Major** · M · Zarr Vectors: Memory budgets are per store and add up past 1.5 GB with three stores  
  `object_reader.ts:349; links.ts:271`
- [ ] **Minor** · M · Shared readers: Untested: window, region reads, precomputed through the reader, cancel  
  `plugins/volume-view/tests`
- [ ] **Minor** · S · Zarr Vectors: Ids ≥ 2^63 wrap; a quadratic indexOf; inconsistent figures and tab names  
  `precomputed_meshes.ts:286, 460`

## 3C · Plugin performance

**Goal:** Large data (millions of streamlines, 100k segments, 10^5 annotations, thousands of EM cells) stays responsive.

**Files:** plugins/annotations, track-filtering, luxar, segmentation, atlas, collections; src/ui/panels/datasets.ts

**Items:** 17

- [ ] **Major** · M · Core app: The Layers list rebuilds whole on every settle (400 ms after navigation): update rows by key  
  `src/ui/panels/datasets.ts:136, 252`
- [ ] **Major** · S–M · OME Collections: Members are placed one by one, each waiting up to 20 s on failure: run them together  
  `plugin.ts:412, 464`
- [ ] **Major** · S · Track filtering: The region result cache can reach gigabytes: bound it by bytes  
  `roi_client.ts:113`
- [ ] **Major** · M · Track filtering: Superseded region tests keep running; the region worker is never restarted after a crash  
  `roi_client.ts:91, 111`
- [ ] **Major** · S · Track filtering: Outside Chrome and Edge saves are built in memory, against what the guide says  
  `plugin.ts:219; manifest.ts:22`
- [ ] **Major** · M · Track filtering: Per-group stores are written on the main thread, rebuilt on each answer, kept after switching off  
  `plugin.ts:479, 1406`
- [ ] **Major** · M · Luxar: Each added segment rebuilds the whole mesh store and re-reads every manifest  
  `mesh_layers.ts:40; plugin.ts:120, 309`
- [ ] **Major** · S–M · Luxar: One failed manifest fails the layer (2,000 unthrottled reads)  
  `precomputed_meshes.ts:234`
- [ ] **Major** · M · Luxar: Signed-in, CAVE and graphene segmentations are missed (a 403 reads as 'no meshes')  
  `mesh_layers.ts:52; sdk/sources.ts:4`
- [ ] **Major** · L · Luxar: One WebGL context and about 2 GB GPU per layer: a shared 2-D context and a global budget  
  `view2d.ts:25; view3d.ts:23`
- [ ] **Major** · M · Segmentation: Removing the layer in Neuroglancer leaks its session (up to 1 GB)  
  `editor.ts:269, 708, 894`
- [ ] **Major** · M–L · Segmentation: Many segments bloat state and undo; the segment list and toolbar select are not virtualised  
  `editor.ts:643, 831; segments.ts:58; panel.ts:423`
- [ ] **Major** · M · Atlas: Volumes and 'Only regions in the image' use a coarse level, hiding small regions by default  
  `labels.ts:274; plugin.ts:60`
- [ ] **Major** · M · Annotations: Every state change (including camera moves) rescans all annotations in four places  
  `annotate.ts:431; table_panel.ts:94; measure_panel.ts:247`
- [ ] **Major** · S · Annotations: The Measure table has no row cap  
  `measure_panel.ts:199`
- [ ] **Minor** · M · Luxar: Worker reads cannot be cancelled; the 2-D context is not restored after loss; tests for the lifecycle  
  `luxar_worker.ts:195; view2d.ts:56`
- [ ] **Minor** · M · Segmentation: Big saves on the main thread or in memory; undo forgets silently past 512 MB; the SAM worker never released  
  `editor.ts:55, 552; save.ts:66; sam_model.ts:136`

## 3D · Core robustness

**Goal:** Slow or failing networks, big exports and the service worker behave.

**Files:** src/ui/shell.ts, src/platform/runner.ts, src/platform/hosts.ts, src/sw.ts, src/ui/export.ts, src/ui/docks.ts

**Items:** 4

- [ ] **Minor** · S · Two in-flight renders of a lazy panel can leak a disposer  
  `docks.ts:223`
- [ ] **Minor** · S · No timeouts on remote state and runner requests (a half-open SSH tunnel hangs); pause host polling in hidden tabs  
  `shell.ts:1343; platform/runner.ts:134; hosts.ts:295`
- [ ] **Minor** · S · Service worker: /virtual/ matched anywhere, unversioned skipWaiting, timers left running  
  `src/sw.ts:45, 88, 178`
- [ ] **Minor** · M · Large exports build whole zips in memory outside Chrome; share links grow without a limit  
  `export.ts:281; shell.ts:597`
