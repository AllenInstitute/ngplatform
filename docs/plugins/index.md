# Plugins

Everything in ngplatform beyond viewing is a plugin: a folder in
[`plugins/`](https://github.com/AllenInstitute/ngplatform/tree/main/plugins)
with a manifest (what the platform shows before loading any code) and its
code. The **Plugins** panel (left dock) lists them by what they do, each with a one-line
description, a switch and an *About* guide.

Only Zarr Vectors is on by default. The others stay out of the way until
you need them: open data one works with and it is offered (below), or turn
it on in the Plugins panel.

## Two kinds

- **Data types** teach Neuroglancer a new format. They run inside
  Neuroglancer's workers and add a source prefix (for example
  `|zarr-vectors:`). They can also declare files they read in place from
  your computer, as virtual stores.
- **Tools** add panels, commands, overlays and views around Neuroglancer: track
  filtering, annotations, segmentation, registration, volume rendering. They work through the
  platform's SDK (`@ngplatform/sdk`): the workspace, the viewer, the docks,
  jobs, storage and sign-in.

## The plugins

| Plugin | Kind | Offered when you open | What it does |
|---|---|---|---|
| [Zarr Vectors](zarr-vectors.md) | data type | (on by default) | Points, streamlines, skeletons, graphs and meshes from Zarr Vectors stores, and local tractograms, meshes, neurons and point tables as virtual stores. |
| [Track filtering](track-filtering.md) | tool | a tractogram or Zarr Vectors store | TrackVis-style groups of the objects that pass through regions. |
| [Annotations](annotations.md) | tool | an annotation layer | Labels on the views for figures, measurements, and statistics in a region. |
| [Segmentation](segmentation.md) | tool | a segmentation (label volume) | Label volumes drawn by hand, as in WebKnossos: a new segmentation layer on an image's grid or a copy of a segmentation, a tool bar over the views, a segment list, saving as NIfTI or OME-Zarr. |
| [Registration](registration.md) | tool | two images | Move a layer by hand (as Freeview) or by landmarks; save the transform or the moved image. |
| [Anatomical rendering](anatomical-rendering.md) | tool | an image | Photorealistic, path-traced views of an image on a GPU: this computer, another over SSH, or WebGPU in the page. |
| [Filters](filters.md) | tool | an image | An image filtered on the fly (mean, median, Gaussian, Frangi vesselness) as a layer of its own. |
| [OME Collections](collections.md) | tool | an image inside an OME collection | OME-Zarr collections (RFC-8, draft): open one or make one of a scene's images, each in a tab; see and build how its images relate. |
| [Luxar rendering](luxar.md) | tool | a tractogram or Zarr Vectors store | Chosen Zarr Vectors layers drawn as Luxar draws lines (HDR glow, mitred joins), in the 2-D and 3-D views. |
| [Orientations](orientations.md) | tool | a tensor, SH or peaks image | ODF glyphs from spherical harmonics, tensor ellipsoids and peak lines over an image, finer as you zoom in; direction colour. |
| [Atlas](atlas.md) | tool | a segmentation with a lookup table | A segmentation's regions as a tree (Allen CCF hierarchy, FreeSurfer grouped): search, show a region with its parts, go to it, the region under the cursor, volumes. |
| [Time series](time-series.md) | tool | a 4-D image, or a CIFTI series on a surface | The time course of the voxel under the mouse, pinned voxels and region means in a 4-D image; playing through time; CSV. |

## Switching, adding and writing plugins

- **Turn on** a plugin in the Plugins panel, or from an offer: a tool comes
  on at once, without a reload, and its panel opens in the Tools dock. Turning one off reloads
  the page with the same link, so your workspace stays. The choice is kept
  in this browser.
- **Offers.** When you open data a plugin that is off works with, the
  Layers panel lists it under *Tools for this data*: click it to turn it on,
  or × for "Not now" (remembered in this browser). Track filtering,
  Annotations, Segmentation, Atlas, Time series, Orientations and
  Collections are also offered once in a toast. Settings › View → *Offer tools that are off when
  the data suits them* turns all offers off (ticking it again brings back
  those you said "Not now" to).
- **Shared links.** A link whose workspace uses a plugin that is off (track
  groups, annotation groups and comments, a Luxar style) says "This
  workspace uses Track filtering, which is off", with **Turn on**. Its
  state is kept in the workspace whether or not you turn it on.
- **The examples.** The S-21-46 and HCP-1065 examples turn Track filtering
  on for the browser tab, for their track groups, unless you turned it off; the
  Plugins panel then offers to *Keep it on*.
- **Try** a plugin without building the app: Plugins → **Add** loads a
  JavaScript module or a Python file from your computer, and reloads it
  after each edit. A plugin from a URL shows its manifest and asks before
  any of its code runs.
- **Write** one: copy the folder of the plugin closest to what you need, give
  it a unique id, and add one line to `plugins/index.ts`. The full guide,
  with the manifest, the SDK and examples, is
  [`plugins/README.md`](https://github.com/AllenInstitute/ngplatform/blob/main/plugins/README.md);
  the [SDK reference](sdk.md) lists what a plugin can import.

## Plugin pages

Each plugin has a page here, written for users: what it is for, how to use
it, and a **Notes from users** section at the end. Anyone can add tips,
workflows, problems and figures there; the edit (pencil) icon at the top
of each page opens it on GitHub. New plugins start from the
[page template](template.md). For what might come next, see
[Ideas for new plugins](ideas.md).
