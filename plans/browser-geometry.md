# Path-traced geometry in the browser

Meshes, points and lines path traced as exact surfaces by the in-browser
renderer: no voxel grid in between. Asked for on 2026-11-17, after the
voxel stand-in (`plugins/anatomical-rendering/points.ts`) proved slow to
build and limited to a voxel's thickness.

This is the browser half of
[path-traced-geometry.md](path-traced-geometry.md). That plan's MVP put
exact geometry in the render computer (CUDA, `runner/ngplatform_render/
geometry.py`). This one brings the same geometry, in the same layout and
with the same tests, to the renderer that draws inside Neuroglancer's 3-D
view.

## Where things stand

### The browser has two path tracers

| Renderer | Where | API | Used for |
|---|---|---|---|
| Live object | `plugins/anatomical-rendering/live.ts` | WebGL2, in Neuroglancer's own frame | Several layers at once, point clouds and meshes; the live preview of a render computer's picture |
| Local path tracer | `plugins/anatomical-rendering/local/` (`pathtrace.wgsl`) | WebGPU, its own canvas | One image alone, the same kernels as CUDA |

Geometry goes into the **live object** first. It is the one already
drawing geometry today. Drawing inside Neuroglancer's frame keeps
annotations, other layers, the depth buffer and the camera in step without
any copying. The local path tracer gets geometry in step 7, or retires for
scenes with geometry. That decision is listed under open questions.

### What the voxel stand-in does now

1. Luxar's `StoreClient` reads every chunk of one level (`readPoints`).
2. In the main thread, mesh triangles are sampled at a third of a voxel and
   points are taken as they are. Both are written into a distance grid of up
   to 128 M voxels (`splatPoints`).
3. The grid is uploaded as an RG8 3-D texture and marched voxel by voxel
   with the images.

#### Measured cost

| Case | Grid | Read and build |
|---|---|---|
| 4 MICrONS cells | 555 × 271 × 448 = 67 M voxels, 1.4 µm | about 20 s, the main thread blocked for seconds |
| ABC atlas | 505 × 318 × 419 | — |

- **Thickness:** no surface can be thinner than a voxel. Dendrites come out
  about 1.4 µm thick, against a true thickness of about 0.3–1 µm.
- **Cost of a ray:** each ray steps every voxel between surfaces, even where
  the space is empty.

### What the render computer has

`geometry.py` and `meshes.py` already provide the geometry this plan
needs:

- **Primitives:**
  - triangles;
  - round cones (Quilez), for lines;
  - spheres, for points.
- **Acceleration:** a linear BVH (Karras 2012). Primitives are sorted by
  30-bit Morton code, internal nodes come from common prefixes, and boxes
  are filled bottom-up.
- **Layout:** `tris` (n × 9), `kind`, `tobj`, `nodes` ((2n−1) × 6) and
  `kids` ((n−1) × 2). Nodes 0..n−2 are internal and n−1..2n−2 are the
  leaves.
- **Tests:** `runner/tests/test_geometry.py` and `test_objects.py`.
- **Measured:** a MICrONS cell is 0.8–6 M triangles at the finest mesh
  level, and its BVH builds in about 1 s on the GPU.

## Design

### Data path

```
layer (precomputed segmentation / Zarr Vectors)
  └─ Luxar StoreClient (worker): chunks of one level, objects by id     [as now]
       └─ geometry worker: primitives + LBVH (TypeScript, geometry.py's algorithm and layout)
            └─ transferable buffers → live.ts: RGBA32F / RGBA32I data textures
                 └─ GLSL: traversal + intersection in every pass that marches the volume
```

#### Reading

Reading is unchanged:

- **Readers:** `readPoints`' reading part (`StoreClient`, `pointsLevelIndex`,
  `meshStoreUrl` for precomputed meshes).
- **Level:** chosen from a primitive budget, not a point budget.
- **What is dropped:** `splatPoints`, `trianglePoints` and the distance grid
  are removed for meshes, points and lines.

#### Primitives

The primitives are built in a new worker (`geometry_worker.ts`), off the
main thread.

**Meshes:**
- Triangles from `BuiltChunk.vertices` and `triangles`.
- Each triangle carries its object slot, an index into the object table.
- Vertex normals are computed area-weighted per object, because
  precomputed meshes carry none. They are kept for smooth shading.

**Points:**
- A sphere at each point.
- The radius comes from the layer's point size in µm (a new per-layer
  setting, defaulting to the store's own if it has one, else 5 µm).

**Lines** (streamlines, skeletons, SWC, graphs):
- A round cone for each segment.
- The radius at each end comes from the SWC radii, else from the layer's
  line width converted to µm.

#### BVH

The LBVH is built in the same worker:

1. Morton codes.
2. A radix sort of 64-bit keys (code then index), as two 32-bit passes over
   a `Uint32Array` pair.
3. Karras' internal-node pass.
4. A bottom-up box pass.

All of this is plain TypeScript, single-threaded. The expected cost, to be
measured in step 0, is about 0.3–0.6 s per million primitives.

The layout matches `geometry.py`'s exactly, so the shared vectors in
`runner/tests/geometry_vectors.json` test both, as
`class_matching.json` is shared.

#### Upload

Data textures are 4096 wide, read with `texelFetch` only, so no filtering
is needed:

| Texture | Format | Texels per item | Contents |
|---|---|---|---|
| `uPrims` | RGBA32F | 3 per primitive | the 9 floats, plus kind in the spare |
| `uPrimInfo` | RGBA32I | 1 per primitive | kind, object slot, and the 3 vertex indices for normals |
| `uNormals` | RGBA16F | 1 per vertex | the area-weighted normal |
| `uNodes` | RGBA32F | 2 per node | lo xyz plus child a; hi xyz plus child b, with child indices stored as float bits via `floatBitsToInt` |
| `uObjects` | RGBA16F | 2 per object | colour and opacity; roughness, specular, emission and a visible flag |

#### Memory

The first version, binary LBVH with flat triangles, uses about 112 bytes per
triangle:

- primitives: 48 B;
- primitive info: 16 B;
- nodes: about 2 × 32 B.

A 2 M-triangle budget is therefore about 225 MB of GPU memory. Step 6
reduces this.

### In the shader

One new GLSL block (`geometryGlsl()` in `live_geometry.ts`) is spliced into
every program `live.ts` builds:

```glsl
// Nearest unclipped hit in (tmin, tmax): t, primitive (-1: none), barycentrics / cone parameter.
float geoHit(vec3 o, vec3 d, float tmin, float tmax, out int prim, out vec2 uv);
// Any unclipped hit in (tmin, tmax): shadow rays.
bool geoAny(vec3 o, vec3 d, float tmin, float tmax);
// Surface at a hit: world position, shading normal, object slot.
void geoSurface(int prim, vec2 uv, vec3 o, vec3 d, float t, out vec3 n, out int obj);
```

#### Traversal and intersection

Traversal is stack-based:

- `int stack[32]`, enough for an LBVH over 2^30 codes, given Karras' depth
  bound in practice.
- Near child first.
- Bounded by `tmax`, so a hit beyond the volume's next scattering event is
  never searched for.

The intersection functions are direct ports of `trihit`, `spherehit` and
`conehit` from `geometry.py`, with the same epsilons.

#### Cuts and crops

A cut or crop is tested at the hit point inside the leaf test. A clipped
hit is rejected and traversal goes on, so a cut opens a cell exactly:

- `uClips` and `uCropLo`/`uCropHi` are shared with the volume.
- Each geometry layer has its own entries, as images do.
- Cut faces are not capped, so a cut cell shows its inside surface. Capping
  is an open question.

#### Joined to each pass in `live.ts`

| Pass | Function | Change |
|---|---|---|
| Preview, front to back | `FS` `main` | `t_s = geoHit(...)` once per pixel; march the volume to `t_s` as now; if the march reaches `t_s`, composite the shaded surface (opacity from the object table) and stop, or go on through a translucent surface |
| Shadow transmittance | `transmit` | Return 0 if `geoAny` toward the light (or multiply by surface transmission for translucent objects) |
| Free flight | `collide` | Bound by `geoHit`'s t; a surface event when the surface comes first |
| First hit, depth | `firstHit` (path tracer) | `min(volume first hit, t_s)` so Neuroglancer's depth test, annotations and picking see the surface |
| Path tracer bounces | `PT_FS` `main` | A surface event: next-event estimation to the key light (shadow ray: `geoAny`, then `transmit` through the volume); bounce by the surface BRDF (`brdfCos`, diffuse plus GGX, as volume surfaces use) |
| Held light bake | `incoming`, `LIGHT_FS` | Light rays blocked by `geoAny`; bounces off surfaces as in the path tracer. Surfaces themselves are not cells of the light grid |

#### Surface shading in the preview

The held light grid (96³) is too coarse for thin surfaces' shadows.

- A surface hit in the preview takes **one real shadow ray** (`geoAny`, then
  the volume's `transmit`), plus the surroundings' light by its normal
  (`env`), plus the grid's scattered light at the hit.
- That is one BVH traversal per pixel more than the volume alone.
- While the camera moves, the shadow ray is replaced by the grid's
  transmittance, which is cheap and soft.

#### Long frames

The path tracer already traces only every `uRows`-th row per pass. Geometry
cost is folded into the same measure (`msPerPass`), so `uRows` grows when
traversal is slow. That keeps a pass under the GPU watchdog (Windows TDR,
about 2 s).

### Materials

The object table is filled from the layer as Neuroglancer shows it:

- **Colour:** segment colours (`ctx.viewer.segmentColour`), or Zarr Vectors
  group colours (`groupColours`), as now.
- **Visibility:** objects not chosen are hidden, or drawn at
  `notSelectedAlpha` if that is shown.
- **Surface preset per layer:** opacity, roughness, specular and emission.
  This is one new "Surface" field set on the layer's card.

A colour or visibility change rewrites `uObjects` only, with no rebuild.

### LOD and budgets

**Primitive budget:**
- A new setting, Quality › Geometry, default 2 M primitives, range 0.25–8 M.
- It replaces the point budget (`POINTS_MAX`) for geometry layers.
- Mesh level: the finest whose triangle count fits the budget, counted
  across all geometry layers switched on.
- Points and lines: the finest level that fits.

**Stills and movies:** they take a larger budget, as the volume's do.

**Streaming:** the first version rebuilds the whole BVH when the chosen
objects or level change, and keeps drawing the old one until the new one is
uploaded. Streaming blocks with a top-level BVH, as in the parent plan, is
step 6.

### What goes away

For meshes, points and lines:

- `splatPoints`;
- `trianglePoints`;
- `pointsTable`;
- the RG8 label path in `live.ts` (`uLabelled`, `labelAt`).

They are removed in step 5, once the geometry path has replaced them in
the browser.

## Work plan

Each step is its own branch and pull request, with tests, docs and a
CHANGELOG entry. The effort figures are rough working days.

### 0. Measurements (1 day)

- [ ] TypeScript LBVH build time and memory at 0.5, 2 and 8 M triangles (a
      MICrONS cell at each mesh level), in a worker on the desktop
      machine and a laptop.
- [ ] A GLSL traversal prototype: frame time of primary hits only at
      1920 × 1080, on swiftshader in CI and on the GPUs to hand.
- [ ] `MAX_TEXTURE_SIZE` and ANGLE shader compile time with the geometry
      block added, especially on Windows/D3D, where long shaders compile
      slowly. Decide whether geometry gets its own program variants
      (`n` volumes × geometry on/off), as `program()` already caches by key.

**Done when:** budgets and defaults are set from numbers, not guesses, and
they are recorded in this plan.

### 1. Geometry core in TypeScript (2 days)

- [x] `geometry.ts`:
  - primitives from `BuiltChunk`s;
  - meshes, points and lines;
  - object slots;
  - area-weighted normals.
- [x] `lbvh.ts`: Morton codes, radix sort, Karras hierarchy and boxes, in
      `geometry.py`'s layout.
- [x] `geometry_worker.ts`: the build off the main thread, with buffers
      transferred, progress reported through the status line, and
      cancellation when the selection changes.
- [x] `runner/tests/geometry_vectors.json`: a few hundred mixed primitives,
      with the expected node boxes and hits for fixed rays. It is checked by
      `test_geometry.py` (CUDA) and `geometry.test.ts` (a CPU traversal
      reference in TypeScript).

**Done when:** the TypeScript and CUDA builds give the same tree for the
same input, and CPU hits match the vectors.

### 2. Surfaces in the preview (3 days)

- [x] `live_geometry.ts`: the data textures, upload and the GLSL block
      (`geoHit`, `geoAny`, `geoSurface`, the three intersectors and the
      clip test).
- [x] `live.ts` preview `FS`:
  - the surface hit;
  - compositing with the volume;
  - the shadow ray;
  - depth out to Neuroglancer.
- [x] `plugin.ts`:
  - geometry layers send primitives instead of `putLevel`;
  - the status shows "N objects, M triangles";
  - Neuroglancer's own drawing is hidden as now.
- [ ] Golden images on swiftshader: a sphere, a torus mesh and a capsule
      bundle, alone and inside a uniform volume, with a cut through each.

**Done when:** the four MICrONS cells render at the mesh's own thinness
with EM, and a cut plane opens them.

### 3. Surfaces in the path tracer and the held light (3 days)

- [ ] `PT_FS`:
  - surface events;
  - next-event estimation through surfaces and volume;
  - BRDF bounces;
  - `firstHit` with surfaces.
- [ ] `transmit` and `collide` bounded by surfaces.
- [ ] Light bake: surfaces block light and bounce it.
- [ ] Golden images: a sphere's shadow on a volume and a volume's shadow
      on a sphere. The CUDA render of the same scene and view is compared
      within a tolerance; the scenes come from `test_objects.py`.

**Done when:** a still of cells in EM matches the render computer's
picture of the same view within the tolerance.

### 4. Points and lines (2 days)

- [ ] Spheres for point clouds, with point size in µm per layer, through
      the Layers card's existing width slider, scaled.
- [ ] Round cones for streamlines, skeletons and SWC, with radii from the
      store or the line width.
- [ ] `readPoints` stops refusing lines ("needs a render computer").
- [ ] Tests:
  - the ABC atlas as spheres;
  - a `.trk` bundle;
  - an SWC neuron;
  - a group colour change, which must not rebuild.

**Done when:** every Zarr Vectors kind renders in the browser.

### 5. UI, materials and clean-up (2 days)

- [ ] A Surface field set per geometry layer: opacity, roughness, specular
      and emission.
- [ ] Quality › Geometry, the primitive budget.
- [ ] Remove the voxel stand-in (`splatPoints`, `trianglePoints`,
      `pointsTable`, the RG8 label path) and its tests.
- [ ] Docs: `docs/plugins/anatomical-rendering.md` (geometry in the
      browser, budgets, limits) and the CHANGELOG.

### 6. Scale (3–4 days, after use shows the need)

- [ ] Memory:
  - indexed triangles (vertex texture plus index triples, about 18 B per
    triangle instead of 48);
  - collapse the binary LBVH into a 4-wide BVH with 8-bit quantised child
    boxes (Ylitie et al. 2017), so nodes take about a third of the memory
    and traversal makes fewer fetches.
- [ ] Blocks: one BVH per chunk or per object, plus a top-level BVH rebuilt
      as blocks come and go, as in the parent plan's design. Selections
      can then change without a full rebuild, and LOD per block by
      projected size (`mesh_lod.ts`) becomes possible.
- [ ] A surface's object id out of the first hit, so a click selects the
      segment.

### 7. The local (WebGPU) path tracer (2 days, if kept)

- [ ] The same buffers as storage buffers, with the traversal in WGSL
      (`pathtrace.wgsl`). This is close to a line-for-line copy of the
      CUDA, since both have real buffers.
- [ ] Its tests against the shared vectors and golden images.

**Total:** about 2½ weeks for steps 0–5, and 1 week more for steps 6–7.

## Progress

2026-11-17: steps 1 and 2.

**Step 1:**
- `geometry/lbvh.ts` builds the same tree as CUDA, bit for bit, on the shared vectors (240 mixed primitives, 120 rays).
- `geometry/primitives.ts` and `geometry/surfaces.ts` turn mesh chunks into primitives in physical millimetres, using the store's own vertex normals.
- `geometry_worker.ts` builds the BVH off the main thread.

**Step 2:**
- `geometry/live_geometry.ts` holds the data textures and the GLSL. The data texture holds the primitives, nodes and objects, so the surfaces take only two texture units.
- The preview traces the surfaces, with:
  - a shadow ray per pixel;
  - cuts per layer;
  - depth handed to Neuroglancer.
- A layer with only surfaces draws over an empty stand-in volume, because the shaders need at least one volume.
- **Not done:** the golden-image tests (sphere, torus, capsule). They are left for step 3, alongside the CUDA comparison.

**Measured** on the four MICrONS cells (`seg_m1300`, mesh level 1):

| What | Result |
|---|---|
| Size | 2,063,776 triangles |
| BVH build in the worker | 0.85–0.9 s, against seconds of main-thread voxel splatting before |
| Thickness | dendrites at the mesh's own thickness |
| With EM and a cut plane | both cut by the plane, the cells sitting in front of the EM's cut face |

**Limits until step 3:**
- With surfaces drawn, the progressive path tracer is paused: it does not meet surfaces, and its picture would take their pixels. The view is the preview, one ray a pixel, so dendrites thinner than a pixel break up.
- The held light ignores surfaces.

## Risks

| Risk | Effect | Answer |
|---|---|---|
| ANGLE/D3D compile time for one large shader | Seconds of stall when a geometry layer is switched on, on Windows | Separate program variants; geometry functions kept out of passes that don't need them; measured in step 0 |
| LBVH quality worse than SAH | Slower traversal, more node fetches | Step 6's wide quantised BVH; treelet restructuring if needed. SAH would be a second builder and lose CUDA parity |
| GPU watchdog on slow GPUs | Context lost | `uRows` scaling by pass time (exists); the preview budget drops shadow rays while moving |
| Texture memory on laptops (about 225 MB at 2 M triangles) | Out-of-memory, or upload failure | The budget setting; a refusal that says what to lower; step 6's compression |
| Precomputed meshes not watertight | Hollow-looking cuts; nothing for surfaces themselves | Not a problem for surfaces; matters only for the image within objects (parent plan) |

## Decisions taken

- **Exact geometry, not voxelised:** the user, 2026-11-13. Reaffirmed
  2026-11-17 for the browser.
- **The same LBVH algorithm and layout as the render computer**, so both
  are tested by the same vectors. A TypeScript build on the CPU, because
  WebGL2 has no compute.
- **The live object (WebGL2) first**, because it draws in Neuroglancer's
  frame.

## Open questions

- **The local WebGPU tracer:** should it get geometry (step 7), or should
  scenes with geometry always use the live object?
- **Cut faces:** should they be capped, so a cut cell shows a solid face,
  or left open, so it shows a shell? Open is simpler and is the first
  version.
- **Point size:** is the default 5 µm, or a size taken from a store
  attribute (cell volume, say) where one exists?
- **Three-mesh-bvh** (MIT) was considered for the build and traversal. It
  builds SAH trees in a layout of its own, which loses parity with the CUDA
  path. It stays a reference for checking traversal speed in step 0, not a
  dependency.
