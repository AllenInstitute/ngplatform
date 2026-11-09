# Anatomical rendering: the plan for the remaining features

Every feature from the Cinematic Anatomy survey (`cinematic-anatomy-survey.md`,
the Cinematic Playground manual, Siemens' pages and papers) that Anatomical
rendering does not have yet, in the order to build them.

Sizes:
- **S** is up to half a day.
- **M** is one to two days.
- **L** is three to five days.
- **XL** is more than a week.

Every item keeps two rules that hold now:
- It works within 12 GB of VRAM.
- It passes the render tests (`runner/tests/test_render.py`) and the
  TypeScript tests.

## Where the code changes

| Layer | Files | What changes there |
|---|---|---|
| Kernel | `runner/ngplatform_render/kernels.py`, `params.json` | The path tracer: tracking, `cut()`, materials, the camera |
| Renderer | `renderer.py`, `detail.py`, `volumes.py` | GPU buffers, passes, levels and regions |
| Service | `server.py`, `movie.py`, `presets.py` | Sessions, views, movies, presets, new endpoints |
| Plugin | `plugins/anatomical-rendering/*.ts` | The Render tab, the frame drawn in the 3-D view, the editor |
| Runner jobs | `runner/` | Long work: segmentation, splat training, batch renders |

## Phase 0: shared foundations

Several features need the same groundwork, so it comes first.

**0.1 A scene of several volumes (L).**
- Today `Scene` holds one volume, its transfer function and majorant
  grid, an optional label volume and the detail region.
- It becomes an array of up to four *channels*. Each channel has:
  - its own texture, affine, transfer-function table and material table;
  - its own majorant grid, detail region and emission scale.
- Tracking uses the sum of the channels' majorants. At a collision, a
  channel is chosen in proportion to its extinction (the standard
  approach for mixtures of media).
- One channel costs exactly what it costs now.
- Needed by fusion (5.1), two-channel material maps (5.2), 4-D (5.3) and
  presets per region (4.2).

**0.2 Materials per tissue band (M).**
- `material_table` already gives specular and roughness per stop.
- It gains:
  - the phase function's anisotropy `g`;
  - the scattering albedo;
  - a surface/volume bias;
  - a **keep through cuts** flag;
  - a **glass** flag.
- Every field is interpolated with the stops the same way.
- The stops' `tissue` field names the material, so a preset's materials
  can be read and edited by tissue.
- Needed by 3.1, 3.3 and 3.4.

**0.3 An overlay over the 3-D view (M).**
- A canvas over the frame, drawn with the camera of the view.
- The plugin already keeps that camera (inverse view-projection) for
  reprojection.
- It holds handles, the orientation cube, labels with leader lines, and
  the brush cursor.
- It has its own hit-testing and dragging.
- It has a **Hide graphics** switch.
- Needed by 2.1–2.4 and 6.2.

**0.4 A render scene as a document (S).**
- The whole render state is one JSON value with a version:
  - preset and tuning;
  - window and lighting;
  - cuts, crops and camera;
  - quality.
- The link already carries most of it; this makes it a value that can be
  saved, loaded and compared.
- Needed by bookmarks (2.5), export (2.6), batch renders (7.1) and
  movies.

**0.5 Quality profiles (S).**
- **Interactive** and **final** become separate settings, each with:
  - samples;
  - number of bounces;
  - detail budget;
  - whether to use fast tracking.
- Stills, movies and batch renders use final; the view uses interactive.

## Phase 1: quick wins (about a week)

**1.1 Depth of field (S).**
- The kernel's thin lens (`APERTURE`, `FOCUS`) and the server's `aperture`
  and `focus` already exist.
- Add to the Render tab:
  - an aperture slider (0 means none);
  - a focus-distance slider;
  - **Focus here**, which takes the distance of the last cursor point
    along the view ray (the plugin already keeps `lastCursor` and the
    distance channel).
- Keyframes interpolate focus.
- Test: a pinhole render is unchanged; with aperture > 0, the plane in
  focus is sharper than planes in front of and behind it (gradient
  energy).

**1.2 Thick slab (S).**
- A slab is a plane (centre and normal) plus a thickness. `cut()` keeps
  `|n·(x−c)| ≤ t/2`.
- `cutinterval()` already narrows rays to the kept interval, so a thin
  slab is fast.
- Its normal can be one of:
  - an axis;
  - **facing the view**, reusing the view-facing cut's code;
  - **fixed**.
- The slab's centre moves with a slider or the cursor.
- **Sweep** in movies (1.5) moves the slab through the volume, like a
  stack of gross sections.
- Test: voxels outside the slab never collide; render time scales with
  thickness.

**1.3 Windowing by mouse drag (S).**
- With a modifier, such as Alt plus the middle button, a drag over the 3-D
  view changes the window: horizontal for its centre, vertical for its
  width, as on a CT console.
- It writes to the same per-image window as the sliders.

**1.4 Interactive and final quality (S).** Builds on 0.5:
- two rows of sliders;
- **Render final**, which sends the view to the host at final quality and
  keeps it until the view moves.

**1.5 Clip-range movies and preview (M).**
- A movie mode that sweeps one of these from start to end in N frames:
  - a cut;
  - the slab (1.2);
  - a crop's face.
- The direction is anatomical, read from the image's axes.
- The camera can stay still or orbit at the same time.
- **Preview** plays the sweep at interactive quality in the 3-D view
  before the final render.
- `movie.py` already interpolates keyframes; a sweep is keyframes that
  move only the cut.

**1.6 Poster stills (M).**
- A still larger than the GPU's budget for one frame, rendered as tiles.
- Each tile has its own projection window, with a seam overlap blended
  across tiles.
- The seed is fixed per tile, so the tiles match.
- Sizes go up to 16k × 16k as PNG.
- The detail region is planned for the whole frame, at the pixel size of
  the final image.

## Phase 2: interaction in the view (about two weeks)

**2.1 Handles for crops and cuts (M).** On the overlay (0.3):
- Each crop box gets corner and face handles.
- A cut plane gets a centre handle that moves it along its normal, and a
  ring that turns it.
- Dragging maps the mouse to the handle's axis or plane in world space
  and writes to the same state as the sliders.
- A new plane starts at the tissue's centre, facing the camera, as in
  Playground.

**2.2 Orientation cube and realign (S).**
- A small cube in the corner of the 3-D view, labelled from the image's
  axes (R/L, A/P, S/I).
- Clicking a face, edge or corner turns the view there.
- **Realign** snaps the nearest standard view.

**2.3 Labels with leader lines (M).**
- Neuroglancer point annotations, and region names from a segmentation,
  are drawn as labels at the sides of the view, with lines to their
  points.
- A point hidden behind tissue is greyed. Whether it is hidden comes from
  comparing its depth with the distance channel the host already sends.
- The labels are placed so they do not overlap (sorted by angle, then
  spaced along each side).

**2.4 Hide graphics (S).** One switch for the overlay and Neuroglancer's
box and axis lines in the 3-D view.

**2.5 Bookmarks (M).**
- **Bookmark** saves the render scene (0.4) with a thumbnail (the current
  frame at 128 px).
- Bookmarks are kept per image, in the workspace (so in the link) or in
  the browser.
- A strip of thumbnails restores any of them.
- **Play bookmarks** makes a movie that moves between them, which also
  covers teaching sequences.

**2.6 Export and import of scenes (S).**
- **Save scene** downloads the render scene as `.render.json`.
- **Load scene** reads one back. A preset file stays a preset; a scene
  file holds everything.
- DICOM export (Secondary Capture stills and movies) is left out unless
  wanted; see the decisions below.

## Phase 3: materials and colour (about two weeks)

**3.1 Phase function and scattering per tissue (M).**
- On 0.2, the kernel reads `g`, the albedo and the surface bias from the
  material table at the collision's value, instead of the preset's single
  values.
- In the editor, double-clicking a point opens its material: gloss,
  roughness, `g` and albedo, beside its colour.
- Test: two bands with different `g` give different back-lit
  appearances.

**3.2 Several curves per preset (M).**
- A preset may hold up to four curves, each with its own stops, for
  example one for tissue and one for vessels.
- They are combined into the one table the kernel reads:
  - opacities as `1 − Π(1 − aᵢ)`;
  - colours weighted by opacity.
- The editor shows each curve in its own colour, with a switch per curve.
- The kernel does not change.

**3.3 Cuts that spare tissues (S).**
- On 0.2's **keep through cuts** flag, `cut()` keeps a point the cut
  removes when its value falls in a band with the flag set.
- It works like labels' "Kept through cuts", but by value.
- `cutinterval()` cannot skip the removed part when any band is kept;
  labels already have the same exception.

**3.4 Glass-like context (M).**
- For bands with the **glass** flag, opacity is scaled by
  `mix(f, 1, (1 − |n·v|)^p)`.
- `n` is the gradient, `v` the ray, and `f` and `p` are sliders.
- Faces seen square-on become faint, and edges and silhouettes stay
  visible.
- Colour can be desaturated toward white.
- This needs the gradient in the opacity during tracking, which costs
  speed. So it is computed only for glass bands, and their majorant is
  left at full.

**3.5 Two-channel material maps (S, after 5.1).**
- Two co-registered images (two scans, two energies, or an image and a
  derived map) are rendered as two channels.
- The second channel gets a single-colour preset, such as iodine red.

## Phase 4: segmentations (about two weeks)

**4.1 Segmentation organiser (M).**
- Up to four label volumes at once, in place of one.
- Each label volume has:
  - an on/off switch;
  - **invert** (it shows everything except its labels);
  - a priority, where the highest active one at a point wins.
- The label lookup in `cut()` and the colour already loop per point; this
  adds an outer loop.
- Shown as a list like the crops.

**4.2 A preset per region (L).**
- Each region (label id) may have its own preset, instead of a tint of
  the shared one.
- On 0.1, presets are stacked into a table of up to 64 rows plus the
  default. The label's row is chosen at each collision.
- The colour is still blended across the 8 nearest label voxels; only
  the row is chosen by the nearest one.
- The majorant per brick becomes the maximum over the rows present in the
  brick, worked out from a brick → label-set summary computed at load.
- UI:
  - in the region list, a preset picker per region;
  - the editor edits the chosen region's curve.
- Test: two regions with different presets, and their boundary blends
  without seams.

**4.3 Segmentation from the viewer (L).**
- **Segment…** runs a runner job and adds the result as a segmentation
  layer (OME-Zarr labels).
- The model depends on the data:
  - **Brain at about 1 mm:** SynthSeg (already used; label → name
    mapping in place).
  - **HiP-CT organs:**
    - bands from the preset's histogram-matched bands, split into
      connected components;
    - a learned model when one is available, such as the anatomix
      features already used.
  - **Vessels:** a Frangi-type vesselness filter at a chosen scale,
    thresholded.
- Progress and Cancel appear in the Jobs tab.
- The job runs on the computer chosen in the Remote tab.

## Phase 5: several volumes (about two weeks)

**5.1 Fusion with emitted light (L).** On 0.1:
- A second image (PET, a lesion map, a vessel probability, another scan)
  is a channel with:
  - its own preset;
  - an opacity scale;
  - **emit light**: emission added at each step through it, weighted by
    its opacity and colour.
- Each crop and cut has **applies to both / only the first**.
- Emission is added along the path (in the collision estimator, the
  emission term at each collision), so a glowing channel lights the
  tissue around it through scattering.
- Test: an emitting channel brightens nearby tissue with the key light
  off.

**5.2 Detail for each channel (M).**
- The multiresolution detail (`detail.py`) planned per channel, sharing
  one budget.
- A fused channel that is coarse can keep its whole volume only.

**5.3 4-D rendering (L).**
- Images with a `t` axis (OME-Zarr) play over time.
- The host loads frames at the whole-volume level into a ring of
  textures (as many as fit in a third of the budget).
- It renders frame t while loading t+1.
- In the view, the time is Neuroglancer's `t`; the time-series plugin's
  Play moves it.
- Movies interpolate time between keyframes; a frame is not blended with
  the next.
- The detail region is turned off while playing.

## Phase 6: geometry and dissection (about three weeks)

**6.1 Meshes in the path tracer (XL).**
- Surface geometry takes part in the light transport.
- Sources:
  - Neuroglancer mesh layers;
  - Zarr Vectors meshes;
  - an uploaded STL or OBJ;
  - simple shapes (sphere, cylinder for a needle, torus, cube).
- On the host, a BVH over the triangles (built with a SAH sweep in
  Python, or with `cupy`).
- A ray is traced against the BVH for its nearest hit. Delta tracking
  runs only up to that distance; if it gets there, the ray scatters off
  the surface.
- Each mesh has a material: colour, gloss, opacity, emission.
- Meshes are moved with the handles from 2.1.
- Budget: about 10 M triangles in 12 GB, with no texture for meshes.
- Test: a sphere inside a uniform medium casts the right shadow, and
  emitting meshes light the tissue.

**6.2 Carving (L).**
- A brush in the 3-D view removes tissue.
- The brush is a sphere at the cursor's surface point, with a chosen
  radius.
- It writes into a carve mask: one bit per voxel at the whole-volume
  level, kept on the host and the GPU.
- `cut()` also checks the mask. The majorant grid is recomputed only for
  the bricks a stroke touches.
- **Undo** reverts the last stroke; **Restore all** clears the mask.
- The mask is saved with the scene, compressed (RLE plus deflate), so a
  dissection can be shared.
- An option carves only selected bands, using 3.3's flags.

## Phase 7: navigation and batch work (about three weeks)

**7.1 Batch renders (L).** On 0.4:
- A render task is a scene plus a type: still, spin, tumble, or a
  clip-range movie.
- It has a match rule over store metadata:
  - organ;
  - modality;
  - voxel size;
  - a path pattern.
- Rules work for HiP-CT's paths and OME-Zarr's `omero` and `multiscales`
  metadata.
- **Render a batch…** runs the tasks over chosen stores as a runner job,
  writing the outputs and a gallery page (an HTML index of thumbnails).
- **Watch a folder** runs the tasks when a new store appears.

**7.2 Automatic preset by organ (M).**
- First, by metadata: the HiP-CT path names the organ, which picks
  `hipct-organs.json`'s preset (histogram matching already fits it to
  the scan).
- Then, without metadata: a small classifier over the scan's histogram
  shape and a coarse view, trained on the HiP-CT open data the colour
  tests used (about 30 scans across 8 organs).
- A suggestion shows when the classifier is unsure.

**7.3 Fly-through (virtual endoscopy) (XL).**
- A **Fly** view takes over the 3-D panel (`ctx.ui.view`), with:
  - a camera inside the volume;
  - a wide field of view (90–120°);
  - a light at the camera (a headlight) plus the environment.
- Controls:
  - mouse look;
  - WASD keys;
  - speed scaled by the distance to the nearest tissue (from the
    distance channel), so the camera slows near walls.
- The kernel needs the near-plane and `firsthit` checked for an eye
  inside the box.
- Detail planning works around the camera. Its depth cap already uses
  the distance to the tissue.
- **Paths:**
  - waypoints clicked in the 2-D views;
  - or a centreline from a segmentation of a lumen (ventricles, a
    vessel): skeletonised as a runner job, then smoothed.
- A path becomes a movie with the camera looking along it.

## Phase 8: displays (about two weeks)

**8.1 Stereo (M).**
- Two cameras with a chosen separation.
- **Side-by-side** and **anaglyph** for stills, movies and the view.
- Twice the cost per frame, so the view halves its samples.

**8.2 VR in the browser (L).**
- WebXR in the plugin: the host renders a wide frame per eye with its
  distance channel.
- The headset reprojects them (the mesh reprojection in `draw.ts`) at the
  headset's rate, while the host refines.
- This works for small head movements. Large ones wait on the host,
  about 100 ms over a tunnel.
- The answer to that is the splats (9.3).

**8.3 Presentation mode (S).**
- Full screen, with the panels and graphics hidden.
- Bookmarks or a movie play in a loop, for a lecture hall or a large
  display.

## Phase 9: learned methods (about four weeks)

**9.1 A learned denoiser (M).**
- Intel Open Image Denoise (CUDA build) on the host.
- The kernel writes two more buffers on the first hit: albedo and normal.
- It runs on the interactive frames while samples are few, and fades out
  as they grow.
- It replaces the current smoothing of the first frames.

**9.2 Temporal reuse on the host (M).**
- When the camera moves only a little, the accumulation buffer is
  reprojected rather than cleared: the same reprojection as in the page,
  but of the HDR sums.
- History is rejected where the distance changes.
- The view sharpens during slow orbits instead of starting again.

**9.3 Splats for viewing without a GPU (XL).** Started: capture, fit
(`runner/ngplatform_render/splat/`) and the plugin's viewer are written;
not yet run end to end. Not a learned model: the Gaussians are fitted to
one scene's renders, with nothing trained beforehand.
- A render-service job (in the Jobs tab):
  - renders N views (a sphere of cameras, final quality) with depth;
  - trains 3-D Gaussian splats on them with `gsplat`, on the host's GPU;
  - writes a `.splat` file.
- A splat viewer (WebGL) in the plugin and on the public site shows it
  at 60 fps on phones and in VR.
- Lighting and cuts are baked in, so each scene needs its own training
  run.
- Scope: a set of showcase scenes per organ.

**9.4 Fitting colours to the photos (L).**
- The colourmap's stops, materials and window are fitted to the annotated
  reference photos (`photos2/`).
- Each step renders crops of the design scan with the real path tracer
  at low samples, and scores them against the photos' tissue patches:
  Lab colour distributions plus texture statistics.
- The fit is CMA-ES over about 40 parameters, rather than a separate
  differentiable renderer, so it optimises what is actually shown.
- About 2,000 renders of 128² at 32 spp, roughly an hour per preset on
  the A6000.
- First target: the grey/white matter contrast of the brain presets.

## Order and effort

| Phase | Contents | Effort | Depends on |
|---|---|---|---|
| 0 | Foundations | ~1.5 weeks | – |
| 1 | DoF, slab, drag windowing, quality, clip movies, posters | ~1 week | 0.4, 0.5 |
| 2 | Handles, cube, labels, bookmarks, scene files | ~2 weeks | 0.3, 0.4 |
| 3 | Materials, multi-curve, sparing cuts, glass | ~2 weeks | 0.2 |
| 4 | Organiser, preset per region, segmentation jobs | ~2 weeks | 0.1 |
| 5 | Fusion, detail per channel, 4-D | ~2 weeks | 0.1 |
| 6 | Meshes, carving | ~3 weeks | 0.3, 2.1 |
| 7 | Batch, auto preset, fly-through | ~3 weeks | 0.4, 1.5 |
| 8 | Stereo, VR, presentation | ~2 weeks | 2.5, 9.3 for good VR |
| 9 | Denoiser, temporal reuse, splats, colour fitting | ~4 weeks | – |

The total is about 22 weeks of work in sequence. Phases 3–5 and 9 are
independent once Phase 0 is done.

The suggested order runs most visible first for HiP-CT:
1. Phase 0.4–0.5 and Phase 1, so DoF, the slab and clip movies come
   early.
2. 9.4, since the brain colours are the weakest point now.
3. The rest of Phase 0.
4. Phase 2.
5. Phases 3, 4 and 5.
6. 7.3, the fly-through.
7. Phase 6.
8. Phases 7.1–7.2, 8, and 9.1–9.3.

## Decisions wanted

Defaults shown in bold.

- **DICOM export:** **leave out**, or add Secondary Capture stills and
  movies via `pydicom`.
- **VR hardware:** **WebXR on Quest 3 in the browser**, or the Vision Pro.
- **Mesh sources first:** **Neuroglancer mesh layers and STL**, or Zarr
  Vectors meshes.
- **Segmentation models:** **SynthSeg, band components and vesselness**,
  or a trained HiP-CT model added later.
- **4-D data to test on:** none is in hand. An OME-Zarr time series is
  needed, or a synthetic one is made for the tests.
