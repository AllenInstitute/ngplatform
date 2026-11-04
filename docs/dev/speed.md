# Speed: startup, bundle, first image, memory, drawing

*2026-11-04.* How long the app takes to start and to show data, how much it
downloads and holds in memory, and what drawing costs, measured on the
build before this work (`bbd2bee`) and after it, with what was changed and
what is left.

## Method

Both builds were made with `vite build` and served from a RAM disk by
`python3 -m http.server` on localhost (no compression: the gzip sizes below
are computed with zlib at level 9, which is what a server that compresses
sends). Each run opens a fresh browser profile (empty cache, no service
worker yet) in headless Chrome 1600 × 950 px, through
[`tests/e2e/speed.mjs`](https://github.com/AllenInstitute/ngplatform/blob/main/tests/e2e/speed.mjs);
[`tests/e2e/bundle.mjs`](https://github.com/AllenInstitute/ngplatform/blob/main/tests/e2e/bundle.mjs)
lists what a page fetches before its code runs:

    npm run build && (cd dist && python3 -m http.server 4174 &)
    node tests/e2e/bundle.mjs dist
    CHROME=/opt/google/chrome/chrome SWIFTSHADER=1 node tests/e2e/speed.mjs 'http://127.0.0.1:4174/#!%7B%7D' load
    CHROME=/opt/google/chrome/chrome SWIFTSHADER=1 node tests/e2e/speed.mjs http://127.0.0.1:4174/ draw out.json

(As for `tests/e2e/smoke.mjs`, playwright must be reachable, through
`NODE_PATH` if it is installed elsewhere. With SwiftShader, `CHROME` must
point at Chrome's own directory, where its SwiftShader driver is, not at
`/usr/bin/google-chrome`, or the browser can hang probing the GPU driver.
Without `SWIFTSHADER=1` it uses the machine's GPU.)

Scenes:

- **Empty**: `#!{}`, an empty workspace (5 runs per build).
- **Example**: the default page, the S-21-46 example (3.3 million
  streamlines from a public bucket over the SRB 2026a template, with three
  Track filtering groups) (3 runs).
- **Image**: the same example with every layer but the template image
  removed once it has loaded (3 runs): drawing that software WebGL keeps up
  with.

Measures:

- **Ready**: from navigation to the status saying the scene has loaded (or is
  empty).
- **First chunk**: to the first visible chunk of any layer in memory
  (Neuroglancer's chunk statistics).
- **View complete**: to Neuroglancer's `viewer.isReady()`: every visible
  chunk loaded and drawn.
- **Long tasks**: main-thread tasks over 50 ms until the view is complete.
- **Memory**: the main thread's JS heap and its array buffers after a forced
  garbage collection (`Runtime.getHeapUsage`), and the resident memory of the
  renderer process (main thread and workers); after load and after 60 s of
  dragging.
- **Drawing**: 30 s dragging in the 2-D panel (pans) and 30 s in the 3-D
  panel (rotates): frame intervals from `requestAnimationFrame`, and the main
  thread's script and task time per frame (`Performance.getMetrics`).

Each figure is the median of the runs. Where the main thread's work was
changed, CPU profiles (`Profiler`, 1 ms sampling, unminified builds) and heap
snapshots of the example after load were compared too.

**Machine.** 64 cores, 1 TB memory, no GPU in the headless browser: WebGL is
SwiftShader (software). The machine was shared with other builds and tests:
the load average is given with each set of runs. SwiftShader makes anything
that waits on drawing slow and noisy: on the example, drawing 3.3 million
streamlines takes seconds per frame and the main thread blocks in WebGL calls
(a buffer upload or a shader compile) while the GPU process is busy, so
**view complete** and the example's frame times varied by 2× between runs
and say little about a real GPU. They are given, but not compared.

## Before and after

Medians; "before" is `bbd2bee`, "after" this work. Start-up rows marked
(A/B) were run alternately, before and after, under the same load
(load average 21–25); the others in two sets (load average 3.5–33).

| Measure | Before | After |
|---|---|---|
| **Bundle** | | |
| JavaScript the page runs at start (raw / gzip) | 2,057 / 625 KiB | 2,020 / 612 KiB |
| … fetched in | two waves (Zarr Vectors' module after the main bundle has run) | one wave |
| CSS (raw / gzip) | 139 / 26 KiB | 139 / 26 KiB |
| Python tab, capture sheet, history menu | at start | on first use (41 KB minified) |
| **Start-up** | | |
| Empty workspace: ready (A/B, 6 runs each; spread 256–314 ms) | 285 ms | 298 ms |
| Empty workspace at 40 ms latency, 20 Mbit/s: ready (A/B, 5 each) | 1,160 ms | 1,119 ms |
| Example: ready (A/B, 6 each; spread 2.9–10 s) | 3,557 ms | 3,404 ms |
| Example: first visible chunk (A/B, 6 each) | 2,701 ms | 2,777 ms |
| Example: main-thread time building segment id tables (profile) | 1.9 s per layer, 3 layers | 31 ms in all |
| Example: main-thread time filling Track filtering's visible sets (profile) | 282 ms | 137 ms |
| Example: view complete (SwiftShader-bound, not compared) | 107 s | 160 s |
| **Memory** | | |
| Empty workspace: JS heap / array buffers / renderer | 5.3 / 3.9 / 227 MiB | 5.3 / 3.9 / 227 MiB |
| Example after load: main-thread array buffers (3 runs each) | 536 MiB | 408 MiB |
| Example at first chunk + 3 s: array buffers (A/B, 6 each) | 262 MiB | 134 MiB |
| Example: heap snapshot, all objects and buffers | 650 MiB | 521 MiB |
| Example: JS heap after load | 11.7 MiB | 11.5 MiB |
| Example: renderer process after load (noisy) | 2,374 MiB | 2,169 MiB |
| Example after 60 s dragging: array buffers / renderer | 536 / 2,337 MiB | 408 / 2,441 MiB |
| **Drawing** (template image alone, 3 runs each) | | |
| 2-D pan: frame interval median / 95th percentile | 16.7 / 33.4 ms | 16.7 / 33.4 ms |
| 2-D pan: script / all main-thread tasks per frame | 0.6 / 2.1 ms | 0.5 / 1.9 ms |
| 3-D rotate: frame interval median / 95th percentile | 16.7 / 33.4 ms | 16.7 / 33.3 ms |
| 3-D rotate: script / all main-thread tasks per frame | 0.5 / 1.6 ms | 0.4 / 1.6 ms |
| Example (3.3 million streamlines): frames drawn in 30 s, 2-D / 3-D (SwiftShader-bound, not compared) | 4 / 6 | 3 / 2 |

The start-up times are unchanged within their spread on localhost; the
preload saves about one round trip on a slower connection. The memory
saved is the three id tables (128 MiB); the time saved is their 1.9 s each
on the main thread, which on the example fell between the first chunk and
the view being complete, so it shows in neither of those times here (both
are dominated by software drawing).

## What changed

**Segment properties of large Zarr Vectors stores.** Neuroglancer's `PreprocessedSegmentPropertyMap` builds a hash
table from segment id to row when it is made, on the main thread. For the
example's 3.3 million streamlines that took about 1.9 s and 32 MiB, once
for each layer showing the store: the tractogram and each Track filtering
group, three tables, 128 MiB in all. The ids Zarr Vectors writes into the
properties are in ascending order, so the plugin's own subclass
(`plugins/zarr-vectors/src/sorted_property_map.ts`) finds a row by binary
search instead, with no table; ids out of order still get Neuroglancer's
table, built the first time one is looked up. Lookups are made only for what
is on screen (the segment under the mouse, the segment list's rows), about
22 comparisons each. Tested against Neuroglancer's table for the same ids.

**A plugin's temporary visible set.** Showing a Track filtering
group's streamlines adds hundreds of thousands of ids to Neuroglancer's
temporary visible set, a hash table that doubled and rehashed as it filled.
It is now sized once for the whole set (`Uint64Set.reserve`), here and in the
worker's copy: on the example 282 → 137 ms of main-thread time, rehashing
189 → 66 ms.

**Start-up code.** The Python tab, the capture sheet (with its
GIF and MP4 writers) and the history menu are loaded the first time they are
used (41 KB of minified code less before the app starts). Zarr Vectors' Neuroglancer
module, which is on by default and which `main.ts` waits for before it builds
the shell, is now listed as a module preload in the page, so it downloads
with the main bundle instead of after it has run: one round trip less before
the app starts.

**Measurement tools** (`tests/e2e/speed.mjs`, `tests/e2e/bundle.mjs`), to
repeat these measurements, and with `CHROME=` on a machine with a GPU.

## What the measurements show, unchanged

- **Start-up code is mostly Neuroglancer.** Of the JavaScript the page runs
  at start, about four fifths (by size before minification) is Neuroglancer
  and the libraries it uses; CodeMirror, used only by its state and shader
  editors, is about an eighth. On an empty workspace the app is ready about
  0.3 s after navigation; the largest part of the main thread's work then is
  creating the WebGL context (0.27 s with SwiftShader).
- **Shaders compile on the main thread at the first draw.** On the example
  1.6 s of the first 2 s (SwiftShader) went to compiling shaders, which
  holds up the metadata requests that follow; with a GPU this is shorter but
  still serial.
- **Drawing costs the app little.** With the template alone, frames ran at
  the display rate (median 16.7 ms) in 2-D and 3-D, with 0.5–0.7 ms of
  script per frame: the platform's listeners (state, history, address bar)
  are already deferred to one call per frame or debounced.
- **Memory on the example is mostly data.** After the changes, of the
  521 MiB in the heap snapshot: about 175 MiB are streamlines Track
  filtering has read (its curve cache, kept for the volume view and a `.trk`
  save, and its groups' stores), about 100 MiB the segment properties (3.3
  million rows: the ids and six columns), about 100 MiB chunks Neuroglancer
  keeps on the CPU while they are on the GPU (so that it can upload them
  again), and the rest smaller. Workers and the GPU process hold their own
  copies.
- The template's first chunk arrived about 2.7 s after navigation on the
  example; the store's listing request (`?list-type=2`, Neuroglancer's S3
  listing) fails on Google Cloud Storage (CORS) and shows a console error.

## Left

| What | Hours |
|---|---|
| Measure on a machine with a GPU (`CHROME=… node tests/e2e/speed.mjs`): shader compile time, chunk upload, frame times on the full tractogram | 2 |
| Compile shaders in parallel (`KHR_parallel_shader_compile`) in the Neuroglancer fork, so the first draw does not block the main thread | 6 |
| Load CodeMirror (≈ 0.4 MiB) only when a state or shader editor is opened (fork change: the state editor and the shader widget import it) | 4 |
| A byte budget for Track filtering's curve cache (it keeps up to six groups' streamlines, 150 MiB for one group of the example) | 2 |
| Upload a very large chunk to the GPU over several frames, if a real GPU shows the stall seen here | 4 |
| List Google Cloud Storage directories through its JSON API in Neuroglancer's kvstore, not the S3 call that fails | 2 |
| Start Neuroglancer's chunk worker before the viewer exists (it now starts about 0.1 s after) | 1 |
