# Luxar rendering

![The HCP-1065 tractogram drawn Luxar-style over the SRB 2026a template, in a 2-D section and the 3-D view](../../docs/images/plugins/luxar.png)

Draws chosen Zarr Vectors layers the way the [Luxar](https://github.com/royerlab/luxar)
viewer draws lines and points (light added up in HDR and tone mapped,
smooth thick lines with mitred joins, emission and absorption) **inside
Neuroglancer's own 2-D and 3-D views**. One viewer: the Luxar look is
switched on per layer, and everything else in the scene (the image under a
tractogram, plain or volume rendered, annotations, other layers) is drawn
by Neuroglancer as before and composited with it.

It reads the data in place: multiscale Zarr Vectors stores, and the files
the platform serves as Zarr Vectors stores (`.trk`, `.tck`, `.trx`, SWC,
point tables). Nothing is converted and no files are written.

| File | What |
|---|---|
| `manifest.ts` | The Luxar tab, its commands and state slice |
| `plugin.ts` | The tab; which layers are drawn; setting Neuroglancer's own drawing of them aside |
| `layer_view.ts` | One layer drawn Luxar-style: its worker, its 3-D and 2-D drawing, the uniforms from its style |
| `view3d.ts` | The 3-D view, through `viewer.draw3d`: the float target, tone mapping, depth |
| `view2d.ts` | The 2-D views, on a canvas over them (the platform's overlay), with each panel's camera |
| `render_gl.ts` | WebGL2: the line and point shaders, upload, the tone-mapping composite |
| `chunks.ts` | Levels of detail and which chunks a view reads and draws; the per-context GPU cache |
| `client.ts`, `luxar_worker.ts` | Reading a store's chunks with the Zarr Vectors reader, in a worker |
| `chunk_build.ts` | A decoded chunk made ready to draw: a vertex texture and (previous, start, end, next) segments |
| `view_math.ts` | Matrices, frustum and slab tests, level choice |
| `camera.ts` | Optional momentum on rotating the 3-D view |
| `style.ts` | The per-layer style kept in the workspace |
| `tests/` | `npm test` runs them |

## Why a renderer in Luxar's style, not Luxar's viewer

Luxar's viewer (`@luxar/viewer`) is a three.js application that reads only
its own compiled `.luxar.zarr` archives, draws only in 3-D, and owns its
canvas and camera. Using it would mean a second viewer beside Neuroglancer
(what the user did not want) and converting the data first. Its rendering
ideas are small enough to carry over instead, so this plugin is a renderer
in Luxar's style working inside Neuroglancer's frame, reading Neuroglancer's
data formats directly:

- **Lines** are one instanced quad per segment, widened in screen space to
  a width in pixels. At a joint between two segments the quad's end edge is
  turned onto the mitre line (where the two segments' offset edges meet),
  so the quads tile with no wedge on the outside of a bend and no
  double-bright lens inside it. Both segments compute the mitre from the
  same three projected points, so they agree exactly. Past a 120° turn
  both square off, as Luxar's mitre limit does.
- **The cross-section** is Luxar's shifted, truncated super-Gaussian:
  `max(exp(-K p^β) - C, 0) / (1 - C)`, `K = ln 100`, `C = 0.01`,
  `β = 2^(6s - 2)` for sharpness `s` (0.5 is a Gaussian, 1 a hard edge).
  Points are round sprites with the same profile. A line thinner than
  1.5 px is drawn that wide and dimmer, so its light is kept.
- **Blending**: *glow* adds light in a float (RGBA16F) target and tone maps
  it (ACES filmic, Reinhard or a clamp), Luxar's "luminous" (depth-tested)
  and "additive" (over everything) modes; *emission and absorption* adds
  emission and optical depth in the same target and composites with
  Luxar's self-screening `(1 - e^-τ)/τ` and transmittance `e^-τ`. Luxar
  sorts lines back to front for this; adding both terms up is the
  order-independent approximation, which needs no sort and is exact where
  bundles do not overlap in depth; *solid* draws opaque, shaded tubes.
- **Colour** by direction (RGB of |tangent|, in the layer's physical x, y,
  z, smoothed across joints), by object (a hashed hue per object id), by a
  vertex attribute through a colormap (viridis, magma, inferno, plasma,
  turbo, grey; polynomial fits), or one colour.
- **2-D views**: Luxar slices the dimensions it does not show by
  proximity. Here a 2-D view shows the lines within half the slab's
  thickness of its section, fading with distance (the same 1% Gaussian
  window), the thickness being a per-layer control.

`@luxar/viewer` is not a dependency: nothing of three.js is bundled.

### How it sits in Neuroglancer's frame (3-D)

`viewer.draw3d` calls the drawer in the 3-D panel's opaque pass, with
Neuroglancer's offscreen framebuffer bound. The drawer:

1. reads the framebuffer's depth-stencil renderbuffer and attaches it to a
   float target of its own, so lines are depth-tested against everything
   drawn before them (a volume-rendered solid, meshes) without writing it;
2. adds the lines' light up there, then tone maps it onto Neuroglancer's
   colour output (colour attachment only, so pick ids are untouched);
3. draws the lines' cores once more into Neuroglancer's depth buffer and
   its depth and pick outputs (pick id 0), so the sections Neuroglancer
   draws after the opaque layers neither paint over lines in front of them
   nor show through lines behind them, and the pointer's 3-D position
   lands on the lines;
4. puts back every piece of GL state it changed.

The image underneath is Neuroglancer's (sections, or the volume-view
plugin's solid, which writes depth): the tractogram composites on it.

### How it sits over the 2-D views

There is no SDK hook to draw inside a 2-D panel, so the plugin draws on a
canvas over the views (`ui.overlay()`), after each frame Neuroglancer draws
(`viewer.onRendered`). A panel's camera is measured through `panels()`'
`project`: its map from global positions to pixels and depth is affine, so
four projections give it exactly. The canvas is blended over the views
with CSS `mix-blend-mode: plus-lighter` for glow (light added to the image
beneath, as in 3-D) and normally for emission and solid. Screenshots get
the canvas painted in (`ui.screenshotOverlay`).

### Levels of detail

As Neuroglancer's own dense layer does: the view reads the finest level
whose chunks in view hold about the *Detail* budget of vertices (vertices
taken as spread evenly over a level's chunks), and only the chunks in view
(the frustum in 3-D; the slab around the section in 2-D), nearest the
view's centre first. The coarsest level's chunks in view are read first so
something shows at once, and stand in for a finer chunk until it arrives
(the finest coarser level that has all of its box). Chunks are read with
`LevelPipeline.download(…, { bridges: true })`, so lines continue across
chunk faces. Built chunks are kept on the main thread (384 MiB) and on each
GPU context (768 MiB for 3-D, 512 MiB for 2-D), least recently drawn first
out.

Coarse levels of a tractogram usually keep a sample of the streamlines
(`object_sparsity`), so they look dimmer when the light adds up. *Brighten
coarse levels* raises their gain by the square root of the share they
keep; off by default, because a full correction makes a sparse sample's
lines glare white.

### Setting Neuroglancer's own drawing aside

While a layer is drawn here, its segments are shown as a temporary set
naming no object (`setTemporaryVisibleSegments`). Neuroglancer then neither
draws the layer's overview nor reads chunks for it (the dense layer reads
nothing when nothing it would draw is visible), and temporary sets are not
saved: a link with Luxar layers opened without this plugin shows the layers
drawn by Neuroglancer. The layer itself stays visible, which keeps the
3-D drawer (a render layer of that layer) drawing; hiding the layer hides
both.

The cost: a layer whose segments are being chosen by another tool through
a temporary set (track filtering's group layers) cannot be drawn here
without losing that choice; see *What is left*.

### Momentum

*Momentum when rotating the 3-D view* (off by default) measures the
orientation Neuroglancer's own drag gives in the last tenth of a second
before release and keeps turning, damped as Luxar's orbit controls are (a
quarter of the speed lost per 60 Hz frame). Any press, wheel or key stops
it. It is kept inside this plugin and switchable, so it can give way to
momentum in the engine.

## What is left

- **Meshes** (Zarr Vectors `mesh` stores) are not drawn Luxar-style yet:
  their chunks hold faces, and soft-shaded triangles need a third program
  and per-face normals. Point clouds and every line kind are drawn.
- **Selections**: the layer's selected segments and track filtering's
  groups are not honoured; the layer is drawn whole. Groups could be drawn
  from track filtering's `trackFiltering.groups` service (`curves(id, n)`
  gives each group's whole streamlines), each in its colour.
- **Bloom** (Luxar's glow around bright light) is not done.
- **Free line ends** are square: Luxar's soft cap would need to know which
  chunk-boundary ends continue in the next chunk (the reader's
  `linkedVertices`), or caps would brighten every chunk face.
- An oblique 2-D view's chunk test uses the slab's bounding box, which can
  read more chunks than the slab needs.

## Gaussian splats (not done)

Luxar renders image volumes as fitted anisotropic Gaussians. That is a
fit, not a view: `luxar fit` optimises positions, covariances, colours and
opacities against the voxels on a GPU (CUDA or Apple MPS, with a
cross-validated splat budget), then builds levels of detail, and writes a
new archive. For an OME-Zarr image here it would take:

1. an offline step (Python, GPU) running Luxar's `cal → fit → lod` on the
   image (or one of its levels), per time point and channel, writing the
   splats beside it, for example as a Zarr Vectors point store with
   per-point covariance (6 floats), colour and opacity attributes, so this
   plugin's reader and levels of detail apply unchanged;
2. a splat program here: each point an instanced quad sized from its
   projected 2-D covariance, the Gaussian evaluated per fragment, depth
   sorted back to front per chunk (or the same order-independent
   emission–absorption sum used for lines);
3. for the 2-D views, slicing each 3-D Gaussian by the section plane (a
   conditional Gaussian) rather than by distance.

The fitting is the expensive part (minutes to hours per volume on a GPU)
and makes new files, which is why it is not done here.

## Credits

The line cross-section, mitre limit, blending modes, emission–absorption
screening and camera damping follow Luxar's viewer
(<https://github.com/royerlab/luxar>), BSD 3-Clause License, Copyright (c)
2024-2026, Loic A. Royer and Luxar Contributors. The shaders here are
written for this plugin (no Luxar source is copied); the constants (the
1% floor, `K = ln 100`, `β = 2^(6s − 2)`, the 120° mitre limit, the 0.75
damping per frame) are Luxar's. The colormap polynomials are Matt Zucker's
fits of matplotlib's colormaps (CC0) and Google's fit of Turbo
(Apache-2.0). ACES filmic is Krzysztof Narkowicz's fit.

Looked after by the ngplatform maintainers.
