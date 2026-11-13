# Path-traced geometry and images within objects

Two things the anatomical renderer does not do yet, asked for on 2026-11-13:

1. **Exact geometry.** Any Zarr Vectors dataset (meshes, streamlines,
   polylines, skeletons and graphs, point clouds) path traced as geometry:
   lit, shadowed and seen through the volume as the volume is, in this
   browser and on the render computer. This covers everything the platform
   already presents as Zarr Vectors: `.trk`/`.tck`/`.trx`, SWC, point
   tables, surfaces, and a precomputed segmentation's meshes (the MICrONS
   cells, through `zarr-vectors/src/virtual/precomputed_meshes.ts`).
2. **An image at full resolution within objects, no bounding box.** The
   MICrONS EM rendered only inside chosen axons or cells, at the finest
   level, with memory spent only where the objects are. It comes from a
   *dynamic* (virtual) Zarr store: the image masked by the objects, whose
   chunks are made when read and exist only where an object is.

Both renderers (`runner/ngplatform_render`, CUDA through CuPy, and
`plugins/anatomical-rendering/local`, WGSL) are kept in step. Each step
ships to both, or is marked as one-sided with a reason.

## What exists to build on

| Part | Where | Use here |
|---|---|---|
| Delta tracking through a 3-D texture, 4³ majorant bricks, next-event light, cuts and boxes | `kernels.py` (`trace`, `firsthit`, `majorant`), `pathtrace.wgsl` | The volume half of every path; geometry joins it |
| A finer region beside the coarse whole volume | `detail.py` (`plan`, `read_region`, `DetailLoader`) | Replaced by sparse bricks (step 3); its loader and chunk cache stay |
| Zarr Vectors reading in the browser: levels, chunks, objects whole by id, mesh LOD | `plugins/zarr-vectors/src` (`reader.ts`, `object_reader.ts`, `mesh_lod.ts`), Luxar's worker (`plugins/luxar`) | The geometry the browser renderer builds from |
| Precomputed meshes as a virtual Zarr Vectors store | `zarr-vectors/src/virtual/precomputed_meshes.ts` | MICrONS cells as meshes, unchanged |
| Virtual image stores made as read | `src/virtual/computed.ts` (chunkmirage pipelines under `<app>/virtual/ngp/…`) | The masked image in the browser (step 4) |
| Precomputed images on the render computer | `runner/ngplatform_render/precomputed.py` | The EM, at any scale |
| Zarr Vectors in Python | the `zarr-vectors` package (`zarr-vectors-tools` uses it) | The geometry the render computer builds from |

## Design

### Geometry in the path tracer

**Primitives.** Three, so every geometry kind maps to one:

| Kind | Primitive |
|---|---|
| `mesh` | triangle |
| `line`, `streamline`, `polyline`, `skeleton`, `graph` | round cone (a capsule whose radius changes along it): a segment between two vertices with a radius at each (a layer's line width, or SWC radii) |
| `point_cloud` | sphere |

**Acceleration.** One LBVH (Karras 2012: Morton-sorted primitives, the
tree built in parallel) per *block*, built on the GPU by the same algorithm
in CUDA and in a WGSL compute pass, so the two renderers trace the same
trees. A block is one Zarr Vectors chunk at one level, or one object read
whole. A top-level BVH over the blocks' bounds is rebuilt each time a block
comes or goes (hundreds to a few thousand boxes: cheap). Blocks stream in
and out under a GPU budget, as the volume's chunks do. If LBVH quality
costs too much traversal time, treelet restructuring is a later step; SAH
on the CPU is not planned (it would be two implementations).

**In a path.** A ray first finds its nearest surface (`t_s`, the BVH),
then tracks the volume from `t0` to `t_s` as now. If the volume scatters
first, the path goes on as now; else it hits the surface. A shadow ray's
transmittance is the volume's times 0 if any surface blocks it (or times
a surface's transmission, for translucent material). Cuts and boxes clip
surfaces as they clip the volume: a cut-away hit is skipped and the ray
goes on.

**Materials.** Per object, from the layer as Neuroglancer shows it:
- **Colour:** its segment colour, or a colour by attribute (as Luxar takes it from the layer's style).
- **Visibility:** chosen, or shown at `notSelectedAlpha`.
- **Surface:** opacity, roughness and specular, as one "surface" preset per layer. The first cut is diffuse plus GGX, translucent by opacity.
- **Emission:** an optional strength for the glow look.

Materials sit in a table indexed by (block, object slot), as Luxar's
`segments.ts` does for drawing.

**LOD.**
- **Meshes:** a level per block by projected size (`mesh_lod.ts`'s choice, made where the renderer is).
- **Lines:** the level whose spacing is under a pixel.
- **Stills and movies:** a finer budget, as the volume has one.

**Picking and depth.** The first-hit pass returns the surface's depth and
object id, so the live picture places as it does now and a click can
select an object.

### The image within objects

**Dynamic store.** A virtual OME-Zarr, the image *within* a set of
objects:
- **Levels:** the image's own.
- **Chunks:** a chunk is made from the image's chunk and the objects. Voxels outside every object are 0 (the fill value), and a chunk no object meets is absent (not made, not stored, not read).
- **Occupancy:** a sidecar per level, the `occupancy` key (a bitset of chunks), so a reader never probes for the absent ones. It is made from the objects' block bounds, then refined by the exact test.

The store is defined by a pipeline: image, objects (a Zarr Vectors store
and object ids, or a segmentation and label ids), inside or outside, and
a dilation in µm. It is served in two places:
- **This browser:** a chunkmirage-style op in `src/virtual/computed.ts`, so Neuroglancer can show it in 2-D too, as any computed image.
- **The render computer:** `masked.py`, the same function in Python, with the same chunk keys and bytes, and shared test vectors.

The zarr-image-processing-wrapper proxy noted in memory is the third
option for serving it, if it is wanted later.

**The inside test.**
- **Meshes (the default, exact):** the voxel centre is inside a closed mesh by the parity of a ray's crossings, through the same block BVHs the tracer uses, run as a compute pass over the chunk's voxels. Meshes that are not watertight (precomputed fragments are, per segment, nearly) use generalised winding numbers over the BVH (Barill 2018) above a threshold.
- **Lines:** the voxel is inside if it is within a round cone's radius.
- **Labels:** the voxel's label is in the set. Precomputed `compressed_segmentation` is decoded on the render computer too (new); the browser decodes it already.

**Sparse bricks in the renderers.** In place of one dense texture of a
region (`detail.py`), each renderer holds:
- **The page table:** a grid, one entry per brick (32³ voxels), giving the brick's place in an atlas, or empty.
- **The atlas:** a 3-D texture of the bricks that are present.
- **Majorants:** one per brick, 0 for an empty one, so delta tracking steps over empty space at once.

The coarse whole volume stays as context. Inside the objects the finest
level is used where the budget allows, chosen per brick by the voxel's
size on screen. Only bricks the occupancy marks are read and uploaded, so
memory goes with the objects' volume, not their bounding box. For scale,
1000 µm³ of axon at 8 × 8 × 40 nm is about 160 M voxels, under the
default budget.

**Modes**, per render:
- **Image within objects:** the EM shaded as now, only inside.
- **Objects as surfaces over the image:** geometry plus the volume.
- **Both:** surfaces translucent, the tissue inside them seen through.
- **Image outside objects:** cut them out.

## Work plan

Batches as in `plans/README.md`: each is a branch off `live-object`, its
own checks, merged one at a time. Effort is rough.

### 0. Measurements (1–2 days)
- MICrONS: the triangles of a cell at each mesh LOD; an axon's length and volume; how many 32³ bricks its interior and shell meet at 8, 16 and 32 nm.
- LBVH build and trace on the GPU (both renderers) at 1, 10 and 50 M triangles.
- Whether WebGPU's limits allow the atlas size needed (`maxTextureDimension3D`, storage buffer size) on the GPUs in hand; what falls back.

### 1. Geometry core (1–2 weeks)
- Primitive intersection (triangle, round cone, sphere) and LBVH build and traversal, CUDA and WGSL, with shared test vectors (`runner/tests/geometry_vectors.json`, as `class_matching.json` is shared).
- Surface hits joined to delta tracking, shadow rays, cuts and boxes, first-hit depth and object id.
- Materials table; one surface preset per layer.
- Golden-image tests: a sphere, a torus mesh, a capsule bundle in a uniform medium; each renderer against the other within a tolerance.

### 2. Zarr Vectors as geometry (1–2 weeks)
- **Render computer:** reading a store's chunks and objects by id (the `zarr-vectors` package as an optional `render` dependency, or a reader of our own if it pulls in too much). Blocks streamed under the GPU budget.
- **This browser:** blocks built from the Zarr Vectors reader's chunks in a worker (Luxar's `client.ts`/`chunk_build.ts` paths), uploaded to the WebGPU renderer.
- LOD per block by projected size; the layer's chosen objects and colours followed live.
- **Panel:** an Objects card listing the scene's geometry layers, each with a switch to path trace it, its surface preset, and opacity.
- **Tests:** a `.trk` bundle, an SWC neuron, a surface and a precomputed segmentation's meshes rendered both places.

### 3. Sparse bricks (1–2 weeks)
- Page table, atlas and per-brick majorants in both renderers; tracking through the page table; the coarse whole volume kept for context.
- A brick loader (from `detail.py`'s), chosen per brick by screen size, streaming as the view moves; eviction under budget.
- The dense detail region retired once sparse bricks do its job (one code path).

### 4. The image within objects (1–2 weeks)
- The pipeline definition and its occupancy; `masked.py` and the browser op, with matching chunk bytes on shared fixtures.
- **Inside tests:** mesh parity and winding through the block BVHs; round cones; labels (with `compressed_segmentation` on the render computer).
- Neuroglancer shows the masked store as a layer (for checking, and for 2-D).

### 5. Modes, UI and the MICrONS case (1 week)
- The four modes; dilation; inside/outside.
- One flow from the panel: pick the objects (selected segments of a layer, or a Zarr Vectors layer's chosen objects), then render the image within them.
- **An EM preset:** membranes dark and cytoplasm light, as the EM shows it.
- **Docs:**
  - the user guide's rendering page, with a MICrONS axon figure;
  - this plan's items ticked;
  - the CHANGELOG.

### 6. Speed and limits (ongoing)
- Traversal cost against volume-only frames.
- LBVH quality, treelets if needed.
- Budgets in `limits.ts`.
- Refusals that say what to change.

## Decisions taken

- **Exact geometry, not voxelised:** user, 2026-11-13.
- **Fine detail within objects only, no bounding box, through a dynamic Zarr store:** user, 2026-11-13.

## Open questions

- **Precomputed meshes:** they are simplified against the segmentation. The default inside test is the mesh, as asked; labels are offered where a segmentation is in the scene. Should labels be the default when both are there?
- **Translucent surfaces:** a simple opacity first. Refraction is not planned.
- **Geometry in the Python package:** if the `zarr-vectors` package is too heavy for the render service, a reader of our own for chunks and object manifests only.
