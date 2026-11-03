# Luxar rendering

![The HCP-1065 tractogram drawn Luxar-style over the SRB 2026a template: glowing in a 2-D section, and in the 3-D view inside the volume-rendering plugin's cut-open solid](../../docs/images/plugins/luxar.png)

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
| `fork/draws-after-sections.patch` | A proposed Neuroglancer change (not applied): layers that draw after the 3-D view's sections |
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
  it (ACES filmic on the brightest channel, keeping the colour where many
  lines add up, the default; ACES per channel, as three.js does, which
  turns bright light white; Reinhard; or a clamp), Luxar's "luminous" (depth-tested)
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
2. adds the lines' light up there, and draws the lines once more into a
   depth texture of its own: the nearest line at each pixel;
3. tone maps the light onto Neuroglancer's colour output (colour
   attachment only, so pick ids are untouched);
4. where the tone-mapped light is clear (15 % or more), writes the nearest
   line's depth into Neuroglancer's depth buffer and its depth output (pick
   id 0), so the sections Neuroglancer draws after the opaque layers do not
   paint over lines in front of them, and the pointer's 3-D position lands
   on the lines; faint glow writes none;
5. puts back every piece of GL state it changed.

The image underneath is Neuroglancer's (sections, or the volume-view
plugin's solid, which writes depth): the tractogram composites on it.

**The sections.** Neuroglancer draws its cross-sections in the 3-D view
*after* the opaque layers, and `draw3d` draws with the opaque layers. So
where lines are in front of a section, the section is kept out by their
depth, and the lines show over the background rather than over the
section: bright where lines crowd, but a dim line over a pale section
reads as a dark streak. With **Sections** off in the 3-D view (common for
tractography) this does not arise. The proper fix is in Neuroglancer: let
a layer draw after the sections, so light adds over them. That is
[`fork/draws-after-sections.patch`](fork/draws-after-sections.patch)
(against the fork's `src/perspective_view/`, 30 lines: a
`drawsAfterSections` flag on render layers, drawn right after
`drawSliceViews`, with `renderContext.sectionsDrawn` set). The platform
side is already here: `Drawer3d.afterSections` (this plugin sets it) and
`Frame3d.sectionsDrawn`; with an unpatched Neuroglancer the flag is
ignored and nothing changes. Built against a patched copy, the glow adds
over the sections as in the 2-D views.

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

### Brightness

Light that adds up depends on how many lines there are: a whole brain at a
fine level turns white, and coarse levels of a tractogram (which keep a
sample of the streamlines, `object_sparsity`, a tenth per level in the
HCP-1065 store) look dim. *Automatic brightness* (on by default) measures
how many times over the drawn lines would cover the view (their length on
screen, from each chunk's total segment length and the view's pixels per
unit, times their width, over the view's area; for a 2-D view, times the
slab's share of a chunk's depth) and dims each line by
`1 / max(1, cover)`. So a dense view glows where bundles gather,
a sparse one is left alone, and the picture keeps about the same
brightness as levels come and go. A correction by each level's share of
the objects was tried first: it makes a sparse sample's few lines glare.
*Brightness* is in stops on top.

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

- **Meshes** (Zarr Vectors `mesh` stores) are drawn as their vertices
  (points): the reader's dense chunks (`LevelPipeline.download`) carry no
  faces, which soft-shaded triangles need (the decoder has them, as
  `DecodedChunk.faces`; exposing them is a change to the Zarr Vectors
  reader). Point clouds and every line kind are drawn fully.
- **Selections**: the layer's selected segments are not honoured; the
  layer is drawn whole. A track-filtering group layer is drawn right once
  track filtering has given it a store of its own (streamline groups get
  one a moment after their exact answer); before that it reads the whole
  dataset. Both use temporary segment sets, so a group's next answer can
  bring Neuroglancer's own drawing back until the layer's source changes.
  Drawing groups from track filtering's `trackFiltering.groups` service
  (`curves(id, n)`) would avoid that.
- **Bloom** (Luxar's glow around bright light) is not done.
- **Free line ends** are square: Luxar's soft cap would need to know which
  chunk-boundary ends continue in the next chunk (the reader's
  `linkedVertices`), or caps would brighten every chunk face.
- A 2-D view reads whole chunks for a thin slab, so it reads (and draws,
  though the vertex shader drops what is outside the slab at once) many
  more lines than show. A store chunked finer, or reading only the
  vertex rows near the plane, would cut that.

## Gaussian splats

An image layer with Luxar on is drawn as Gaussian splats in place of
Neuroglancer's own drawing of it, in the 3-D view and the 2-D views. The
splats are made from the voxels as they are read, not fitted: each 32³
block of a level is cut into cells of 4³ voxels, and each cell above the
threshold becomes one Gaussian with the cell's moments (centre, covariance)
and its intensity as the weight (`splats.ts`, in `splat_worker.ts`). Each
level of the image's pyramid gives its own, so a file read in place (a
TIFF as virtual Zarr) is splatted at every resolution.

- **3-D** (`splat_view.ts`): each splat an instanced quad, its covariance
  projected through the view's Jacobian (EWA), light and optical depth
  added in a float target (no depth sort), tone mapped onto the view.
- **2-D** (`splat_view2d.ts`): each splat cut by the section (the
  conditional Gaussian: its peak there, its centre and covariance in the
  plane), widened three times in area with its total kept so the cells read
  as one image, and clamped rather than tone mapped, so a section shows the
  image's own values (on the SRB template, 0.99 of Neuroglancer's drawing).
  Only blocks within a slab around each section are read.
- Neuroglancer's drawing of the image is hidden while its splats are on
  (`viewer.hideLayerDrawing`: its opacity 0, not saved in the link), and
  the 2-D views' background is black (`viewer.setTemporaryBackground`), as
  under the image.

Fitted splats (Luxar's `luxar fit`, which optimises the Gaussians against
the voxels on a GPU and writes a new archive) would be sharper at the same
count; that is an offline step that makes new files, not done here.

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
