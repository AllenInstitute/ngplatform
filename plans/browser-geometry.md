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

- [x] `PT_FS`:
  - surface events;
  - next-event estimation through surfaces and volume;
  - BRDF bounces;
  - `firstHit` with surfaces.
- [x] `transmit` and `collide` bounded by surfaces.
- [x] Light bake: surfaces block light and bounce it.
- [x] The shader's traversal against the CPU reference on a GPU (`npm run e2e:geometry`): every ray's hit and distance, shadow rays, hidden objects and cuts. *Done in place of the golden images below.*
- [ ] Golden images: a sphere's shadow on a volume and a volume's shadow
      on a sphere. The CUDA render of the same scene and view is compared
      within a tolerance; the scenes come from `test_objects.py`.

**Done when:** a still of cells in EM matches the render computer's
picture of the same view within the tolerance.

### 4. Points and lines (2 days)

- [x] Spheres for point clouds. *Changed:* their size is a per-layer **Size** (× a natural radius, a quarter of the points' mean spacing) in the Rendering card, not the Layers card's pixel width.
- [x] Round cones for streamlines, skeletons and SWC, with radii from the store (a `radius`/`radii` vertex attribute) or a sixth of a segment's length, × Size.
- [x] `readPoints` stops refusing lines.
- [ ] Tests:
  - [x] the ABC atlas as spheres, in the browser;
  - [x] a tractogram as tubes, in the browser (`hcp1065_whole_brain`);
  - [x] points, groups and lines (with and without radii) to primitives (`geometry_read.test.ts`);
  - [ ] an SWC neuron in the browser (no store with radii to hand);
  - [ ] a group colour change without a rebuild. *Not so:* points' and lines' colours are fixed when they are made, and a change of the layer's groups reads them again.

**Done when:** every Zarr Vectors kind renders in the browser.

### 5. UI, materials and clean-up (2 days)

- [x] A Surface field set per geometry layer: opacity, roughness, specular
      and emission.
- [x] Quality › Geometry, the primitive budget.
- [x] Remove the voxel stand-in (`splatPoints`, `trianglePoints`,
      `pointsTable`, the RG8 label path) and its tests.
- [x] Docs: `docs/plugins/anatomical-rendering.md` (geometry in the
      browser, budgets, limits) and the CHANGELOG.

### 6. Scale (3–4 days, after use shows the need)

- [x] Memory:
  - indexed triangles (vertex texture plus index triples, about 18 B per
    triangle instead of 48);
  - collapse the binary LBVH into a 4-wide BVH with 8-bit quantised child
    boxes (Ylitie et al. 2017), so nodes take about a third of the memory
    and traversal makes fewer fetches.
- [x] Blocks: one BVH per chunk or per object, plus a top-level BVH rebuilt
      as blocks come and go, as in the parent plan's design. Selections
      can then change without a full rebuild, and LOD per block by
      projected size (`mesh_lod.ts`) becomes possible.
- [x] A surface's object id out of the first hit, so a click selects the
      segment.

### 7. The local (WebGPU) path tracer (2 days, if kept)

- [x] The same buffers as storage buffers, with the traversal in WGSL
      (`pathtrace.wgsl`). This is close to a line-for-line copy of the
      CUDA, since both have real buffers.
- [x] Its tests against the shared vectors and golden images.

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

Step 2's two limits, the paused path tracer and the held light ignoring surfaces, are lifted by step 3.

2026-11-17: step 3, except the CUDA golden-image comparison.

**The path tracer:**
- A path meets the surfaces and the volumes in order (`scatterEvent`).
- At a surface:
  - the key light, shadowed by surfaces and through the volumes (`transmit`);
  - then a bounce, glossy or diffuse (`geoBounce`).
- The pixel's depth is the nearer of the volume's first hit and the surface.

**The held light:**
- Surfaces block light and bounce it.
- A cell's light is averaged over points in it, so a dendrite thinner than a cell shades it partly, not wholly.

**Composite:**
- The path-traced picture is blended by coverage on the colour output only (`OES_draw_buffers_indexed`), so sub-pixel dendrites fade in as samples arrive instead of dropping out.

**A ray leaving a surface:**
- It starts 2e-5 of the scene away from it.
- At 1e-6 the MICrONS cells showed self-shadowing stripes in float32.

**Checked:**

| What | Result |
|---|---|
| `npm run e2e:geometry` (SwiftShader) | 9,216 of 9,216 rays agree with the CPU |
| The four MICrONS cells, alone | path-traced (38 samples): shadowed by one another, glossy, dendrites as lit tubes |
| The cells with EM and a cut plane | path-traced together |

**Not done:** the CUDA comparison of the same still, the plan's "done when". It needs the same scene in both renderers; it waits for a fixture both can read.

2026-11-17: step 4.

**Points and lines:** points are traced as spheres and lines as round cones, through `geometry/from_read.ts`.

**Colours:**
- A mesh's objects take their segments' colours each frame.
- Points' and lines' colours are fixed when the primitives are made: by group as the layer colours them, else by object.

**Measured:**

| Data | Primitives | BVH build |
|---|---|---|
| ABC atlas, level 1 | 10,672 spheres | 46 ms |
| HCP-1065 tractogram, level 2 (5,031 streamlines) | 995,524 tubes | 445 ms |

**Not yet:** the ABC atlas's finer level is over the 1.5 M-point read budget. The Quality › Geometry budget (step 5) is where to raise it.

2026-11-17: step 5.

**Materials:** each geometry layer has its own opacity, roughness, specular and emission (`uGeoMat`, per layer), set in the Rendering card. A change redraws without a rebuild.
- Opacity is stochastic: a ray passes a primitive with the chance it is clear (a hash of the ray and the primitive). The path tracer's samples average to the opacity; the moving view shows a fixed dither.
- `npm run e2e:geometry` checks that a clear layer is passed and a half-opaque one stops about half the rays reaching it (134 of 236).

**Budget:** Quality › Geometry, 2 M primitives unless set (0.25–8 M), shared equally by the geometry layers on; a mesh's level is chosen at two triangles a vertex.

**Removed:** `splatPoints`, `trianglePoints`, `pointsTable`, `gridVoxel`, the RG8 label path (`uLabelled`, `labelAt`, `Level8.labels`) and `putLevel`. Geometry layers are no longer opened as volumes, so they no longer take a share of the images' voxels.

**Measured:** the ABC atlas at a 4 M budget reads its finer level: 85,570 spheres of the 3 classes shown (against 10,672), BVH in 290 ms.

**Not done:** a larger budget for stills and movies; the budget is shared equally rather than by each layer's need.

2026-11-17: step 6.

**Memory:**
- Primitives are indexed: one RGBA32UI texture holds the vertices (xyz, and a normal or radius), the primitives (three vertices, kind and object), the wide nodes and the objects. One texture unit, not two.
- The binary LBVH (still the render computer's, bit for bit) is collapsed into a 4-wide BVH with 8-bit child boxes (`geometry/wide.ts`): a node is 64 B and its four children's boxes come from one fetch; each stored box is checked to contain the true one in float32.
- Measured: 79 MB for 1,447,668 MICrONS triangles (55 B each) and 63 MB for 995,524 HCP tubes (63 B), against 128 B before.

**Blocks:** each segment's mesh, and each Zarr Vectors layer, is a block with its own BVH, built in the worker and kept. The blocks are packed under a top tree over their boxes (a median split, collapsed the same way) whenever one comes or goes: 40–80 ms on the main thread for 1.4 M triangles.
- A segment switched off is taken out without reading; one switched on is read alone (8 s for a MICrONS cell).
- A mesh layer's levels are shared out between its segments once their sizes are known (`allocateLevels`: the cheapest finer level that fits, in turn). The four MICrONS cells come in at 1.45 M triangles, against 0.84 M with equal shares.
- LOD per block by projected size is not done: blocks are per segment, not per chunk.

**Picking:** `Frame3d.registerPicks` (engine): a segmentation layer gets a render layer that draws nothing, against which the drawer registers a pick ID a segment each frame. The preview writes the surface's ID where it is the first thing met; the path-traced picture keeps the first hit's object in its aux texture (now RGBA32F) and writes it in the composite. Hovering a MICrONS cell picks its segment.

**Checked:** `npm run e2e:geometry` (two blocks under a top tree, 8 of 8); unit tests of the collapse (boxes contain the truth; every primitive once) and of tracing one and three packed blocks against testing every primitive.

2026-11-17: step 7, and surfaces less than opaque.

**The WebGPU tracer** (`local/`) traces the scene's surfaces:
- `local/geometry.wgsl`: the WebGL traversal and intersectors in WGSL, over one storage buffer holding the packed surfaces after a block of numbers (where the regions are, each layer's material, cuts and crop). One buffer, not two, as a stage has at most 8 storage buffers and the tracer has 7.
- `pathtrace.wgsl`: `trace` meets surfaces and the volume in order (the volume tracked up to the nearest surface); a volume point's shadow ray stops at surfaces; `firsthit` takes a surface's depth.
- One image with geometry layers now uses it for the picture at rest (the live object still draws the moving view); geometry alone, or several images, the live object as before.
- Checked: `npm run e2e:geometry` runs the same scene through the WGSL in a compute shader (WebGPU on SwiftShader): 9 of 9 checks, as WebGL's. EM with the four MICrONS cells (1.45 M triangles) and a cut, path-traced on SwiftShader's WebGPU, 64 samples at about 3–5 s a pass.
- **Not done:** golden images against CUDA, as in step 3: no fixture both read yet.

**Surfaces less than opaque** (reported: slow, and drawn incompletely):
- Before, every ray passed such a surface by chance: the moving view showed a fixed dither (at opacity 0.15, dendrites as specks) and the picture at rest filled in slowly.
- The moving view now meets them as solid and blends up to three, front to back, at their opacities, the volumes marched between them; its colour is blended by their coverage where nothing opaque is met. The nearest takes a shadow ray; those behind, the held light.
- The path tracer's camera ray meets them as solid too: each adds its light at its opacity (its shadow ray now and then, weighted), then the path goes on through as often as it is clear (not a bounce) or bounces off it. Bounces and shadow rays still pass by chance (cheaper: no traversal begun again).
- Measured (four MICrONS cells, 0.5 M triangles, SwiftShader, 90 s): opaque, 17 samples; opacity 0.15, 10 samples, drawn as faint continuous branches (before: 17 samples of specks).

2026-11-17: after step 7: the CUDA comparison, stills here, detail by distance, groups without a rebuild.

**Against the render computer** (`npm run e2e:golden`, the "done when" of steps 3 and 7): `runner/tests/golden_scene.py` writes an empty volume and a Zarr Vectors mesh (a sphere and a torus); the app draws them in this browser (the WebGPU tracer's picture at rest), and the same view spec is rendered by the render computer's CUDA. Their depths, as world points: the outline the same at 135,936 of 136,068 pixels; where both meet the mesh, 98.8% within 0.05 mm (median 0.07 µm; the rest at grazing edges). Shading is not compared: the two shade by design apart. Needs `NGP_RENDER_PYTHON` (the runner's render dependencies and `zarr_vectors`, zarr 3: Python 3.11 or later).

**Stills here:** Save still in this browser path-traces the view (the live object's tracer, into textures of its own at the output's size, after the light is held), the geometry read at four times its budget meanwhile. MICrONS cells: 2.6 M triangles, 320 × 240 at 16 samples, about 3 minutes on SwiftShader. Movies and splats remain the render computer's.

**Detail by distance** (`geometry/lod.ts`): a mesh segment's chunks chosen across its store's levels, finer near the camera, within the vertices its level share allows, where the levels' chunk grids nest (MICrONS: 2,048 to 16,384 a side, doubling); chosen again when the camera comes to rest a fifth of its distance away. Chunks read are kept, so a new choice reads only those it lacks; the segment's block is built again.

**Groups:** points and lines grouped by the layer's Vertex colour keep every group as an object; the frame's look hides and colours them. Choosing groups or their colours reads and builds nothing (ABC atlas: 34 classes, one shown, block unchanged).

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

- **Cut faces:** should they be capped, so a cut cell shows a solid face,
  or left open, so it shows a shell? Open is simpler and is the first
  version.
- **Point size:** is the default 5 µm, or a size taken from a store
  attribute (cell volume, say) where one exists?
- **Three-mesh-bvh** (MIT) was considered for the build and traversal. It
  builds SAH trees in a layout of its own, which loses parity with the CUDA
  path. It stays a reference for checking traversal speed in step 0, not a
  dependency.
