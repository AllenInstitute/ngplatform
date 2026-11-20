# Adaptive multiscale images in the browser's path tracers: plan

*Written 2026-11-19.* The Rendering card's **Resolution** chart (`resolution.ts`) shows the problem: in this browser
each image is drawn at **one level throughout**, the finest whose whole volume fits the budget. The FO-20-155 lung
column (6.5 µm, 3870 × 3870 × 21897 at s0) is drawn entirely at s4 (104 µm, 242 × 242 × 1369): its next level, s3,
is 641 M voxels against a 64 M budget. Detail where you look is thrown away to keep the parts you cannot see sharp.

The goal: each part of an image drawn at the level its size on screen calls for. Fine near the camera and the
centre of view, coarse far away and off screen, within the same memory. The views fill in from coarse to fine as
bricks arrive, and the chart shows the real mix of levels.

## What there is now

| | WebGL 2 (`live.ts`: preview, held light, path tracer) | WebGPU (`local/local.ts`, `pathtrace.wgsl`) |
|---|---|---|
| An image | One `R8` 3-D texture of one level (`readLevel`, values windowed to 0…255) | One `texture_3d<f32>` of the same level |
| Budget | `LIVE_VOXELS` 64 M voxels shared by up to `MAX_VOLUMES` (5) images; `MAX_SIDE` 2048 | As WebGL |
| Empty space and majorant | An occupancy texture of 8³ bricks (`brickBounds`, `occupancy`) | A majorant per 4³ brick (`maj`, `bounds`) |
| Sampling | `tex(k, v)` (trilinear), `grad` (central differences, ±1 voxel), `FINEST` steps by the finest voxel at a point | `texval`, the same |

The image reader can already read any box of any level (`VolumeClient.volume(level, …, region)`). Chunks are shared
through the image chunk worker's cache (`shared_chunks.ts`), for OME-Zarr, precomputed and N5. The render computer
does a two-level version (`runner/ngplatform_render/detail.py`: the whole image at one level, plus a finer region
where the view looks). The design below generalises that to any number of levels in any number of places.

## Design

### Bricks, a brick pool and a two-level page table

- **Brick**: 32³ voxels of one level, stored with a one-voxel apron (34³) copied from its neighbours, so trilinear
  sampling and the ±1-voxel gradient never read outside it.
- **Region**: a brick of the **coarsest** level an image is read at, as a 3-D grid over the image. Each region is
  drawn at one level ℓ (the level choice is per region). At level ℓ it holds (2^(c−ℓ))³ bricks, where c is the
  coarsest level.
- **Brick pool**: one `R8` 3-D texture shared by every image, of 34³-voxel slots, sized to the budget. 64 M voxels
  is about 1,950 bricks of 32³. A 60 × 32 × 1-slot layout (2040 × 1088 × 34 texels, 75 M bytes) holds 1,920 of
  them within WebGL's 2048-a-side limit. Slots are filled with `texSubImage3D` as bricks arrive and evicted
  least-recently-used.
- **Page table A** (per image, an `RGBA16UI` 3-D texture at the region grid, small): the region's level ℓ, the index
  of its first entry in table B, and its greatest windowed value (the region's majorant, and empty-space skipping).
- **Page table B** (shared, an `R32UI` 2-D texture used as an array): for each brick of a region at its level, the
  pool slot holding it, or a coarser brick standing in while it is read (so nothing is ever a hole), and the
  brick's greatest value.

A sample at image voxel `v` (finest-level coordinates):

1. The region at `floor(v / regionVoxels)`: fetch table A, giving the level ℓ, the table-B base and the majorant.
2. The brick within the region at level ℓ: fetch table B, giving the slot.
3. Sample the pool at the slot origin, plus 1, plus the point's position within the brick at level ℓ (trilinear).

That is two dependent integer fetches before the sample. `grad` takes its six samples inside one brick (the apron),
so it does the lookup once, not six times.

### Choosing the levels (pure: `adaptive/select.ts`)

- **Target voxel per region**: the region's nearest point to the camera, its distance d, and the pixel's size there
  (`2 · d · tan(fov / 2) / viewport height`), times a quality factor (1 at Quality's default). The level wanted is
  the coarsest whose voxel is no larger than that.
- **Budget**: start from the coarsest level everywhere (today's picture, always resident). Then refine the region
  with the largest error per added voxel (its voxel size over its target, weighted by being on screen and in front of
  the cuts) while the budget allows. This is a priority queue, the same greedy that `allocateLevels` and `lodChunks`
  use for meshes.
- **Off screen and cut away**: regions outside the view frustum, or fully removed by the crops and cuts, stay at the
  coarsest level (the path tracer's bounces still need them for light).
- **Empty**: regions whose coarse brick is all below the transfer function's threshold (occupancy) are never refined.
- **Hysteresis**: a region refines when its target is 1.5× finer than its level and coarsens at 2× coarser, so a
  still camera's choice settles and a small move does not churn bricks.
- **Several images**: one queue over all of them, so the budget goes where the error is largest whichever image it
  is in.

### Reading bricks (`volume-view`: `brick_source.ts`, in the image reader's worker)

- `readBrick(level, b)`: the 34³ box at level `level` (with its apron, clamped at the image's edge), windowed to
  0…255 with the image's window, from the shared chunk cache (so a chunk read once serves every brick it touches).
  It returns the bytes and the brick's minimum and greatest values.
- A **priority queue** of the bricks wanted, nearest and coarsest first. Bricks no longer wanted are cancelled (the
  same abort the reader's reads take).
- Concurrency as the reader's (`concurrencyFor`); N5, OME-Zarr and precomputed alike.

### Drawing (WebGL first)

- `tex(k, v)` and `grad(k, v)` become the virtual lookup above. `FINEST` and `NEXT_IN` step by the voxel of the
  **level drawn there** (from table A), so coarse regions are marched with long steps and fine ones short.
- Delta tracking's majorant and empty-space skipping come from table A (per region) and table B (per brick), in place
  of the occupancy texture. The light held (`bakeSome`) is unchanged: its grid is in world space.
- **Seams**: neighbouring regions at different levels can show a slight step where they meet. Use at most one level
  of difference between neighbours (the selector enforces it). A later refinement, if seams show, samples both
  levels across the last voxel and blends.
- **Restarts**: bricks arriving change the picture. As with the meshes' stages (`settling`), the light and the path
  tracer start once the selection for a resting camera has been read. The preview shows each brick as it comes.
- **Fallback**: a setting, **Adaptive levels** (on by default once proven), with off drawing one level as today, for
  comparison and for GPUs that refuse the pool's size.

### WebGPU

The same tables as storage buffers (`array<u32>`), the pool as a `texture_3d<f32>`, the same lookup in WGSL
(`texval`, `maj` per brick from table B). This comes after WebGL; `local.ts` shares `adaptive/select.ts` and the
brick source.

### The chart

`resolutionUse` takes, per level, the share of the image's regions drawn at it (weighted by their volume), so the
Resolution bars show the real mix ("s0 over 3 %, s1 over 12 %, s2 over 25 %, s4 over the rest").

## Progress

- 2026-11-19: phases 1 to 4 begun for WebGL, behind **Multiscale** (beside Render). `adaptive.ts` (finer levels over the base, regions' bricks, the greedy choice, shares; tested); `live.ts` (the pool, the table, `tex`, `grad`, `occupied` and `FINEST` through it; planning at rest; bricks read by the image's own reader, coarse to fine; a region switched once its bricks are held). Regions are 8³ base voxels (16³ waited too long for a level 16 times finer: 512 bricks a region). The WebGPU picture is not used while Multiscale is on.
- 2026-11-19: phase 5 begun. The bricks moved out of `live.ts` into `adaptive_bricks.ts` (one `Multiscale` for the page, with a reader of its own per image), so WebGL and WebGPU share the reads. `local.ts` and `pathtrace.wgsl`: the table at binding 7 (the depth moved into the picture's buffer), the pool at binding 11, `texval` and the gradient through them, and the majorants widened from the finer bricks' least and greatest values. With Multiscale on, one image goes to WebGPU again when there is one. When the path-traced picture at rest is on, WebGPU chooses the levels for its view; otherwise the object (WebGL) does. Either way both draw the same regions. Checked on SwiftShader on the lung column: WebGPU reads about 15 bricks a second (WebGL, tracing on the CPU too, about 1) and refines to s2, s1 and s0 near the camera. Tests: `tests/adaptive_bricks.test.ts`.

- 2026-11-20: hardening. Pinned tables (no mixed samples between restarts), the one-level neighbour rule and hysteresis in `chooseLevels`, eviction of bricks no region draws or waits for (a full pool stalled the lung column's refinement), one pool on the GPU when WebGPU draws, and `tableSample` (the shaders' lookup on the CPU) tested against each level's values. Still to do: phase-0 benchmarks on a real GPU, a pixel golden of the shaders (SwiftShader e2e for now), docs.

## Phases

| | Work | Checks | Effort |
|---|---|---|---|
| 0 | **Benchmarks**: four scenes (FO-20-155 lung column N5, SRB 2026a 100 µm, a HiP-CT 2.2 µm VOI, MICrONS EM precomputed). Time to first picture, to settled, to 128 samples; GPU memory; preview frame time; a sharpness measure against the finest level over a crop. Run here on SwiftShader for correctness, on a GPU by the user for speed (never the display GPU here) | The numbers for today's single level, kept in this file | 1 day |
| 1 | **Brick source** in the image reader's worker: `readBrick` with apron and window, the priority queue, cancellation | Unit tests: apron at edges and between chunks, window, N5 and OME-Zarr fixtures, cancellation | 2 days |
| 2 | **Selector** (`adaptive/select.ts`, pure): targets, budget greedy, frustum and cuts, empty regions, hysteresis, one-level neighbours, several images | Unit tests on synthetic pyramids and cameras: budget never exceeded, a nearer region never coarser than a farther one, a still camera's choice stable | 2 days |
| 3 | **WebGL pool and page tables**: allocation, `texSubImage3D` uploads, LRU eviction, coarse stand-ins; the lookup in `tex`, `grad`, `FINEST`, the majorants | A golden test against today's single-level picture when every region is at one level (the same pixels); a two-level synthetic volume whose levels differ by colour, so the chosen levels can be seen | 4 days |
| 4 | **Progressive refinement**: coarse first then finer, `settling` for the light and the path tracer, the chart's shares, the Adaptive levels setting | SwiftShader e2e on the lung column: finer levels near the camera, the picture complete at every moment, no restart after settling | 2 days |
| 5 | **WebGPU parity** | The WGSL golden as in 3 | 2 days |
| 6 | **Docs and tuning**: the plugin README and user guide, the quality factor, the budget's default | The benchmarks of phase 0 again | 1 day |

About **two and a half weeks** in all. Each phase lands behind the setting, so the single-level picture stays as it
is until phase 4 passes.

## Risks

- **Per-sample cost**: two dependent fetches per sample. The path tracer samples a lot. Expect the preview and each
  pass to be 1.3 to 2 times slower per sample, paid back by not having to draw a coarse level everywhere. Measured
  in phase 0 and phase 4.
- **GPU memory and texture limits**: the pool is sized to the budget, with a smaller pool on a GPU that refuses it,
  and Adaptive levels off as the last fallback.
- **Seams** between levels: limited by the one-level rule; blending if they show.
- **Reading cost**: more, smaller reads than one whole level. The shared chunk cache and the coarse-first queue keep
  the picture complete while it refines. For far-away regions it reads less than today.
- **Not in scope**: label volumes for Regions (one level as now); the render computer (it keeps its two-level
  detail; it could share the selector later).
