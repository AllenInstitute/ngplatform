# Track filtering at scale: review and plan

*Written 2026-11-20*, from a review of the Filtering plugin (`plugins/track-filtering`) on S-21-46's FibreGraph
streamlines. That store is 3.3 GB: 10.3 M streamlines, 3.0 G points at level 0, 6 levels. Stores of 50 to 150 GB
are coming: 15 to 50 times this one, so roughly 150 M to 500 M streamlines.

Measured in headless Chrome (SwiftShader) against the GCS store, a sphere of radius 42.7 k units, 38 k streamlines passing.

## What happens now, and what it costs

| Step | Where | This store | Grows with |
|---|---|---|---|
| Object attributes (`bridge_oid`, `length`) read into Neuroglancer's segment properties | main thread | **215 s** before the shard fix below, **31 s** after; heap **630 MB** at its peak | objects × columns |
| Row index (`rowIndex`), one mask per group (`Uint8Array(n)`), the attribute mask | main thread | ms (ids are 0…n−1) | objects |
| Region test, exact, level 0, only the chunks the region touches | worker | 4 chunks, **2 to 4 s** | region size × point density |
| Preview, a coarse level | worker | under 1 s | the same, at the coarse level |
| The group drawn whole: a `.trk` of its streamlines, read and written in the worker, opened as a store | worker, then the page | before: **out of memory** (level 1, 744 M points); after: level 4, a few seconds | the level's points (see below) |
| The passing ids as the layer's temporary visible set | main thread, Neuroglancer | 38 k ids | streamlines passing |

Nothing else waits on the network: the region test reads level 0 near the region and is fast. The two problems
are the attributes, which are all read into the page before anything is counted, and drawing the group whole.

## Bugs found and fixed (uncommitted)

1. **"A.getArg is not a function"** (the error in the panel). numcodecs' WebAssembly zstd decoder, once a large array
   leaves it aborted, fails every later decode with this message, so Retry cannot recover. zstd now goes through a
   handler of ours: the WebAssembly decoder first, `fzstd` (JavaScript) when it fails and from then on
   (`zarr-vectors/src/zstd_decode.ts`, `zstd_bytes.ts`).
2. **Attributes read one inner chunk at a time.** Each column is sharded (about 10 files of 1.7 MB) with
   65,536-row inner chunks, and each inner chunk was its own request, two at a time. `readRows` now reads each
   shard's chunks in one request: 215 s down to 31 s (`zarr_array.ts`).
3. **Drawing a group ran the page out of memory.** The level was chosen by the group's estimated points (passing
   objects × the mean points per object), but reading a streamline decodes every chunk it passes through, whole.
   Streamlines chosen by a region run across the brain, so the read costs about the whole level: level 1's 744 M
   points, about 9 GB decoded. Now a level is used only if it holds at most 16 M points
   (`GROUP_STORE_LEVEL_POINTS`), here level 4 (`plugin.ts`, tested in `groups.test.ts`).
4. "~0% of the points" now says "~0.39%".

Seen but not reproduced in three later runs: the page reloading after the group's store opened, then reading
every attribute again. It happened while the page was near 800 MB to 1 GB and unresponsive. Memory pressure is the
likeliest cause, and fix 3 removes most of it.

## The store

- **No axis units.** The store declares none ("shown unitless"), and the scene puts it at 1.5 M "mm": the scale
  bar reads 300 m, region sizes read in kilometres, and the link's 3-D view (256 units across) shows almost
  nothing of a brain about 1.5 M units wide. FibreGraph should write `axis_units` and scales (µm, or 50 µm voxels).
- **Very dense level-0 chunks.** 206 chunks hold 3.0 G points: about 14 M points a chunk, roughly 240 MB decoded.
  The region worker's cache is 320 MB, about one chunk, so a region moved a little reads its chunks again. For
  the big stores, choose chunk shapes for **1 to 4 M points a chunk** (64 to 128 units here, not 256).
- **Coarse levels keep 25% of the objects** (`object_sparsity` 0.25 per level). A group drawn from level 4 shows
  a sample of its streamlines, as the note in the panel says.
- **Level-0 manifests are 415 MB** in 10 shards: what reading whole streamlines by id pays first.

## At 50 to 150 GB

| Step | Projected | Verdict |
|---|---|---|
| Attributes into the page | 150 to 500 M objects × 2+ columns: 3 to 10 GB in the main thread | **Will not work.** A tab has about 4 GB |
| Masks and the row index in the page | 150 to 500 MB per group | Too much with several groups |
| Region test at level 0 | the same chunks per region, if chunks stay 1 to 4 M points | Fine, if chunks are sized as above |
| A group drawn whole | from the coarsest level of at most 16 M points: a small sample of a big group | Works, sparse |
| The visible set | millions of ids for a broad group | Heavy in Neuroglancer |
| Save .trk | written as it is read, on disk (Chrome, the runner) | Fine |

## Plan

1. **Regions without the attributes** (small). A group with no attribute ranges or tags does not wait for the
   attribute columns: its regions are tested at once, and the attributes come later (only for the panel's
   statistics). Today every group waits for every column before anything is counted.
2. **Attributes and masks in the worker** (medium). The region worker reads only the attribute columns a group
   filters on, and keeps the masks there, as bitsets (1 bit an object: 60 MB at 500 M objects, not 500 MB). The
   page receives counts, statistics and the passing ids, never the columns. Neuroglancer's segment properties are
   read only when the store is small enough (the Segments tab's table), not as the filter's source.
3. **Groups on the runner for big stores** (medium; the job exists). Past a size (say 20 M objects, or 10 GB),
   the exact count runs as the runner's filter job (`runner_job.ts`, `tasks/filter.py`: zarr-vectors-tools over
   the whole store). The page keeps the preview from a coarse level, so moving a region still answers at once,
   and takes the exact answer as a bitset from the job.
4. **Drawing a big group** (medium). At this scale the group is drawn from the dataset's own levels with its
   visible set (what Neuroglancer reads for the view anyway), and a store of its own is made only when it is
   small, or by the runner (which can afford level 0 and serves the result as a store). The visible set for
   millions of objects should become a bitset the zarr-vectors layer tests per object, not a hash set of ids.
5. **Chunk and cache sizes** (small). The region worker's cache sized by memory available, and a warning in the
   panel when a store's level-0 chunks are over about 8 M points ("region tests will be slow: rewrite with
   smaller chunks").
6. **A benchmark** (small). This store and a synthetic 50 GB one (or a real one when it exists): time to the first
   count, to exact, to drawn; peak heap; requests. Run on SwiftShader here for correctness, on a real machine for
   speed.

Order: 1 and 5 first (days), then 2 (about a week), then 3 and 4 with the runner (a week or two). Without 2 or 3, a
store of 150 M objects cannot be filtered in the page at all.
