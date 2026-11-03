# Coming from Freeview

Freeview is FreeSurfer's desktop viewer. ngplatform does many of the same
things in a browser, on data far larger than fits in memory, and shares a
view as a link. This page maps one onto the other, including what is not
there yet.

## Where things are

| In Freeview | In ngplatform |
|---|---|
| File → Load Volume | **Open → Open from device**, **Add → Local**, or drop files on the window (NIfTI, `.mgz`/`.mgh`, TIFF, `.npy`); a FreeSurfer subject folder opens as its T1, aparc+aseg and white and pial surfaces |
| File → Load Surface | **Add → Local**: FreeSurfer surfaces, GIFTI, OBJ, STL, PLY; a surface brings the curvature, thickness, overlays (`.mgh`/`.mgz`), `.annot` and `.label` files beside it |
| Surface panel: main surface (white, pial, inflated, sphere) | Layer → **Render → Surface → Surface** |
| Curvature (binary colour) | on by default for a surface with `?h.curv`; **Render → Surface → Colour** |
| Overlay: Configure (threshold, max, heat, colour wheel…) | **Render → Surface → Overlay** and **Colour map** (heat as Freeview's, jet, viridis and more); the threshold and top are sliders in the shader's controls |
| Annotation (`aparc`, `aparc.a2009s`), label | **Render → Surface → Parcellation**, in the annotation's colours; the `.label` files together as `labels` |
| Surface outlines on the slices (edge colour) | drawn by default, white yellow, pial red; **2-D outlines** can colour them by the overlay |
| Vertex info (curvature, overlay, annotation name) | **Render → Surface → Under the mouse** |
| File → Load Tract | **Add → Local**: `.trk`, `.tck`, `.trx` |
| Layer panel (left) | **Datasets** tab, and the **Layer** tab on the right for the selected one |
| Colour map, window/level | Layer → **Render → Colour map** (grayscale, heat, jet, GE colour, NIH, PET, binary colour and more) and the contrast slider |
| Lookup table (FreeSurferColorLUT) | Layer → **Render → Lookup table**: FreeSurfer's and other atlases' tables, or a file |
| Show as outline (label volumes) | Layer → **Render → 2-D views → Draw: Outlines** |
| Viewport layouts 1×1, 2×2, 1&3 | the layout buttons, or the command palette's *Set the layout* |
| Coordinates / Info panel | the position at the top left of the views; each layer's value under the mouse |
| Tools → Transform Volume | the **Registration** plugin (same controls, plus landmark fitting) |
| File → Save Screenshot (`-ss`, magnification, auto-trim) | the camera icon → **Picture…**: magnification and trim |
| File → Save Movie Frames, Save GIF | the camera icon → **Movie…**: a slice or time sweep, or a 3-D turn, as GIF, WebM, MP4 or PNG frames |
| File → Save Volume As | Datasets → the row's ⋯ → **Export as…**: NIfTI, `.mgz`/`.mgh` or OME-Zarr |
| View → Neurological View | Settings → **Which way up the views are**: radiological (as Freeview, the default for anatomy) or neurological |
| Viewport 2 × 2 | four panels: axial, sagittal, coronal and 3-D bottom right |
| `freeview -v a.nii b.nii` | a link: the address bar holds the whole workspace |

## What ngplatform adds

- Data of any size, streamed (OME-Zarr, precomputed), from the cloud or
  your disk, without loading it whole.
- Slices at any angle (++shift++ + drag in a cross-section).
- Track filtering on millions of streamlines (TrackVis-style groups).
- Scenes as tabs, and links that share the whole workspace.
- Plugins, and a Python console in the page.

## Not there yet

These are on the [work plan](https://github.com/AllenInstitute/ngplatform/blob/main/TODO.md):

- Surfaces: an overlay's mid point, truncate and inverse, custom colour
  scales and the colour wheel; several overlays at once; label outlines;
  the inflated surfaces moved apart as Freeview places them; a surface
  switch for Zarr Vectors stores that keep other surfaces as `coords_*`
  attributes.
- Voxel editing: drawing and erasing labels, fills, recon edits.
- Measuring: lengths, areas, region and label statistics, line profiles.
- Diffusion displays: direction-colour maps, tensor and ODF glyphs.
- Volume filters (mean, median, Gaussian…).
