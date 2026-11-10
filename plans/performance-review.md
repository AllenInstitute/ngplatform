# Performance review: Zarr Vectors and OME-Zarr

A review of the fundamentals (speed, stability, scale, memory) of reading
and drawing Zarr Vectors and OME-Zarr, at c97fc28 (10 November 2026), after
Phases 0–5. Measured, not only read. Nothing was changed.

**Method:**
- **Browser runs:** a production build in headless Chrome (SwiftShader) over CDP, with every request logged from the page and its workers. Each run recorded Neuroglancer's chunk statistics, heap and process memory, and CPU profiles, with injected latency, bandwidth limits and failures.
- **Node benchmarks:** the decode paths.
- **Data:** read-only, real:
  - SRB 2026a (192³ unsharded);
  - S-21-46 50 µm (256³ unsharded);
  - the 20 µm deep-brain store (64³ chunks in 512³ shards);
  - MICrONS EM;
  - the S-21-46 Zarr Vectors store (3.3 M streamlines, 420 M vertices, 7.2 GB);
  - local .trk files of 689 MB and 5.05 GB.

**What is not measured fairly:** GPU Chrome hangs on this machine, so frame times and texture uploads are CPU-bound under SwiftShader. Network, decoding, request counts, bytes and memory are not affected. Raw results and harnesses are in the session scratchpad (`review-zv/`, `review-omezarr/`).

## The answer

Yes: the fundamentals can be improved a long way, mostly in the stores themselves rather than the code.

- **OME-Zarr:**
  - **Chunk shape:** the example stores are 192³ and 256³ unsharded. A 2-D view reads whole 3-D chunks, so these cost 3.7–5.9× the bytes and about 3.4× the GPU memory of 64³-in-shards. BRIDGE already writes 64³ in shards.
  - **Panning:** with these stores, fast panning re-downloads data it has evicted (36% of 4.6 GB in two minutes). It also cancels 74–91% of its requests.
- **Zarr Vectors:**
  - **Compression:** the store's per-chunk arrays are uncompressed. zstd makes them about 14× smaller.
  - **Cell size:** level-0 cells reach 79 MB, because one cell size is used at every level.
  - **Ghost reads:** 70% of vertex bytes in a 2-D session are reads of neighbouring cells for line ends that are never drawn.
  - **A stability bug:** a failed network read is taken as "no data" and cached, so parts of a view stay empty for the session.
- **The code is otherwise sound:** decoding is off the main thread, caches are bounded, memory stays flat over long sessions, and cancellation reaches the network.

## Ranked improvements

Effort: S = under half a day, M = 1–3 days, L = more. "Store" items need the data rewritten; "Fork" items change the Neuroglancer fork (most could go upstream).

### 1. Stability first

| # | Where | Change | Evidence | Effort |
|---|---|---|---|---|
| 1 | App (Zarr Vectors) | **A failed read must not read as empty.** Neuroglancer maps a network `TypeError` to status 0, which the reader treats as 404. The cell is then cached as empty, column chunks are filled with zeros, and a missing `segment_id` cell triggers a scan of every manifest at that level (55 MB at level 0). Treat a missing key that must exist as an error, with retry and backoff; never cache it. | With 10% injected failures the view never completed: one chunk stayed failed, several were drawn empty, and two full manifest scans ran. `store.ts:166`, `zarr_array.ts:1110` | S–M |

### 2. Store layout (biggest gains, no code)

| # | Where | Change | Gain | Effort |
|---|---|---|---|---|
| 2 | Store (OME-Zarr) | Rewrite SRB 2026a, S-21-46 50 µm and the BigBrain chunkreg exports as **64³ chunks in shards**, index at the start (`index_location: "start"`), zstd level 9 or higher. Repoint the example. Make this the rule for every store written for viewing; `export_warped_for_gcs.py` still writes 256³ unsharded. | 3.7–5.9× fewer bytes and ~3.4× less GPU memory per view. A full-resolution SRB view at 50 Mbit/s goes from 29 s to about 9 s. No re-download thrash. One round trip less per new shard. No 404s for empty chunks. | S per store |
| 3 | Store (Zarr Vectors) | **Compress the per-chunk arrays with zstd** (vertices 13.8×, fragments 6×, segment ids 8.8×). Fix the writer's "blosc" preset (bitshuffle gives only 2.1× here). Optionally store uint16 quantised vertices: 25×, 0.16 µm error. | The 7.2 GB store becomes ~0.6 GB; level-0 reads are ~14× smaller. | S in zarr-vectors-tools, plus a rewrite |
| 4 | Store (Zarr Vectors) | **A chunk grid per level** (`chunk_scale_factors = 2`), with a halved level-0 cell, and shards once there are many cells. The in-browser .trk converter already does this. | Level-0 cells of 1–3 MB raw instead of up to 79 MB (1.5 s decode, 263 MB on the GPU in one upload). Fewer tiny link requests at coarse levels. | S in the writer, plus a rewrite |
| 5 | Store (Zarr Vectors) | **Links as one cell per chunk, with the far endpoint's xyz stored.** Today each level has 26 offset arrays, and the far end must be read from the neighbour. Also, write no identity `object_ids` column (3.4 MB in 202 chunks that gate the first draw). | Removes ghost reads in 2-D and 3-D (item 6) and ~85% of link requests, for about 12 B per link. | M |

### 3. App code

| # | Change | Evidence | Gain | Effort |
|---|---|---|---|---|
| 6 | **Zarr Vectors ghost reads in slice views:** take line ends only from neighbour cells already cached or requested; drop the rest, which lie off the plane (`chunk_pipeline.ts` `ghostPositions`). | 193 of 275 MB of vertex bytes in a 2-D session (446 requests); 4.3× the bytes drawn at level 1 | About half of all session bytes, now, without a store rewrite | S–M |
| 7 | **Zarr Vectors opening:** don't await the whole `object_ids` table before the first draw (infer identity, or read it lazily). Attach only the object columns the shader uses, once, as a per-object texture. | Geometry waits 3.5 s behind 202 requests; ~28–70 MB of columns read on open, twice under throttling | Seconds off the first draw; ~25% less GPU and CPU memory per vertex | S each |
| 8 | **`VolumeReader` (the tools' OME-Zarr reader):** range reads with `cache: "no-store"` in Chrome, and concurrency by chunk size (about 32 for small chunks). | Chromium serialises cached range reads to one shard URL: 5–7 s against 0.7–1.2 s for 32 ranges | ~1.7× from the cache mode, ~3–4× with concurrency, for Measure, Segmentation, Registration and in-browser rendering | S |
| 9 | **Zarr Vectors decode:** typed, preallocated loops in `walkTangents` and `sequentialEdges`; no full re-copy in `assembleChunk` when there are no ghosts. | 13 MB cell: 214–248 ms; 79 MB cell: 1.5 s | ~7× faster decode | S |
| 10 | **3-D level choice in Zarr Vectors:** pick a level per chunk from distance and screen spacing, or at least clip the frustum to the data's bounds. | The 3-D view stays on the coarsest level down to a 6 mm field of view (0.06% of the vertices) | Real detail when zoomed in, in 3-D | M–L |
| 11 | **Zarr Vectors GPU bytes:** derive tangents in the shader; no index buffer for sequential lines; ids and values per object; keep on the CPU only what picking needs. | 53 B per vertex on the GPU (12 B fetched), plus a CPU copy of all of it | 2.5–3.5× less GPU and CPU memory | M–L |
| 12 | **One budget for all reader caches:** charge `vertexCells` (256 MB), `neighbourAttributes` (64 MB) and `RangeCache` (256 MB per store) to the shared 768 MB budget, and abort whole-cell reads nobody waits for. Give the tools' OME-Zarr readers one shared worker and cache, instead of 128–256 MB each (up to ~1.4 GB alongside Neuroglancer's 2 GB). | Caches outside the budget; duplicate reads across workers | Bounded, lower memory | S–M |
| 13 | Smaller: use `zarr3://` sources and drop the extra metadata probes (404s). Repoint the SRB example after item 2. Hint when GPU memory is full. Size the memory limits by `navigator.deviceMemory`. | Extra 404s, defaults at Neuroglancer's 1 GB GPU memory | Tidier, fewer requests | S |

### 4. Neuroglancer fork

| # | Change | Evidence | Gain | Effort |
|---|---|---|---|---|
| 14 | **Limit downloads by bytes, not count.** Today the limit is 100 at once, with no byte limit. | At 50 Mbit/s all 35 big chunks share the link and land together (median 27.5 s); with 8 at once the median is 6.6 s and the view fills progressively | First tiles ~4× sooner on slow links | S–M |
| 15 | **Movement-aware requests in 2-D:** one level coarser while the view moves; don't cancel a download that's mostly done. | Fast pans abort 74–91% of requests; at the end of a 12 s pan only 10–20 of ~225 visible chunks were on the GPU | ~10× fewer requests while navigating, no wasted partial downloads | M (behind a setting first) |
| 16 | **Coalesce adjacent reads inside a shard.** Port `coalesceRangeReads` from the Zarr Vectors reader. | 7 byte-adjacent GETs for 7 sub-chunks of one shard | Fewer requests for 3-D and coarse levels | M |
| 17 | **Host memory:** cap the decode pool at 4–6 workers, and reset the zstd WASM heap after a very large decode. Optionally, drop the CPU copy after GPU upload. | ~0.6–1.1 GB of extra RSS with big chunks; system memory always equals GPU memory | Less RSS | S (the copy: L) |
| 18 | **A persistent byte cache** (Cache Storage or OPFS), keyed by URL, range and GCS generation. Meanwhile, use `https://` sources for public unsharded stores: `gs://` adds a random parameter that defeats the HTTP cache. | Nothing survives a reload; evicted chunks are downloaded again | Fast reloads and revisits | S now, M–L for the cache |

### 5. Render service

| # | Change | Evidence | Gain | Effort |
|---|---|---|---|---|
| 19 | Read whole shards in one GET and decode locally (or use tensorstore); cache stored levels on disk by the content stamp it already computes. | Sharded reads at 32 MB/s against 140 MB/s unsharded; stored levels re-read for every job | ~4× faster loads; repeat renders skip the network | M |

## Suggested order

1. **Item 1** (stability) and **items 6–9** (app code, all small): ship without touching any store.
2. **Item 2** (OME-Zarr store layout): rewrite the example stores and set the writing rule for BRIDGE exports. This is the largest single gain and needs no code.
3. **Items 3–5** (the Zarr Vectors format): change zarr-vectors-tools, then rewrite the S-21-46 store. This is decided with the format's spec, since readers must keep reading old stores.
4. **Items 14–15** in the fork, behind a setting; then 12, 18, 19, 10, 11 as the data grows.

## Already good (leave it)

- **Decoding:** zstd and blosc decode in WASM workers, gzip with `DecompressionStream`; buffers are transferred, not copied.
- **Memory and caches:**
  - Memory limits hold through two minutes of the worst panning, with flat memory.
  - No leaks over six zoom cycles; growth stays within bounded caches.
  - Caches are bounded by bytes, never evict loads in flight, and revisits cost no requests.
- **Requests:**
  - Cancellation reaches the network.
  - Shard indexes are cached.
  - Server errors (503) are retried: 0 failed OME-Zarr chunks at 20% injected failures.
- **Level choice:**
  - In 2-D, Neuroglancer picks the right level.
  - Volume rendering asks only for the coarsest level.
  - Zarr Vectors loads a coarse stand-in first and requests nothing for a view that draws nothing.
- **Local data:**
  - Local and virtual stores are already 64³.
  - The .trk converter streams through an OPFS spill (1.12× the file) and doubles its cells per level: 3.3 M streamlines in 24 s.
- **Where it doesn't matter:** `zarr://https` works on sharded stores now (the fork's one-byte GET when a HEAD is blocked).
