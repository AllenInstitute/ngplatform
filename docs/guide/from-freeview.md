# Coming from Freeview

Freeview is FreeSurfer's desktop viewer. ngplatform does many of the same
things in a browser, on data far larger than fits in memory, and shares a
view as a link. This page maps one onto the other, including what is not
there yet.

## Where things are

| In Freeview | In ngplatform |
|---|---|
| File → Load Volume | **Open → Open a file…**, **+ → Local file or folder…** in the Layers panel, or drop files on the window (NIfTI, `.mgz`/`.mgh`, TIFF, `.npy`); a FreeSurfer subject folder opens as its T1, aparc+aseg and white and pial surfaces |
| File → Load Surface | **+ → Local file or folder…**: FreeSurfer surfaces, GIFTI, OBJ, STL, PLY; a surface brings the curvature, thickness, overlays (`.mgh`/`.mgz`), `.annot` and `.label` files beside it |
| Surface panel: main surface (white, pial, inflated, sphere) | the layer's **Display → Surface → Surface** |
| Curvature (binary colour) | on by default for a surface with `?h.curv`; **Display → Surface → Colour** |
| Overlay: Configure (threshold, max, heat, colour wheel…) | **Display → Surface → Overlay** and **Colour map** (heat as Freeview's, jet, viridis and more); the threshold and top are sliders in the shader's controls |
| Annotation (`aparc`, `aparc.a2009s`), label | **Display → Surface → Parcellation**, in the annotation's colours; the `.label` files together as `labels` |
| Surface outlines on the slices (edge colour) | drawn by default, white yellow, pial red; **2-D outlines** can colour them by the overlay |
| Vertex info (curvature, overlay, annotation name) | **Display → Surface → Under the mouse** |
| File → Load Tract | **+ → Local file or folder…**: `.trk`, `.tck`, `.trx` |
| Layer panel (left) | the **Layers** panel (left dock): the datasets above, the selected one's controls below |
| Colour map, window/level | the layer's **Display → Shader → Colour map** (grayscale, heat, jet, GE colour, NIH, PET, binary colour and more) and the contrast slider |
| Lookup table (FreeSurferColorLUT) | the layer's **Display → Colour → Lookup table**: FreeSurfer's and other atlases' tables, or a file |
| Show as outline (label volumes) | the layer's **Display → 2-D views → Draw: Outlines** |
| Viewport layouts 1×1, 2×2, 1&3 | the layout buttons, or the command palette's *Set the layout* |
| Coordinates / Info panel | the position at the top left of the views; each layer's value under the mouse |
| Tools → Transform Volume | the **Registration** plugin (same controls, plus landmark fitting) |
| File → Save Screenshot (`-ss`, magnification, auto-trim) | the camera icon → **Picture…**: magnification and trim |
| File → Save Movie Frames, Save GIF | the camera icon → **Movie: sweep slices or time…** or **Movie: turn the 3-D view…**: a slice or time sweep, or a 3-D turn, as GIF, WebM, MP4 or PNG frames |
| File → Save Volume As | Layers → the dataset's **⋯** → **Export as…**: NIfTI, `.mgz`/`.mgh` or OME-Zarr |
| View → Neurological View | Settings › View → **Orientation of the views…**: radiological (as Freeview, the default for anatomy) or neurological. The 3-D view starts in the same convention: radiological from the front, superior up and the patient's right on the left (neurological from behind); **Reset the rotation** goes back to it |
| Viewport 2 × 2 | four panels: axial, sagittal, coronal and 3-D bottom right |
| `freeview -v a.nii b.nii` | a link: the address bar holds the whole workspace |

## What ngplatform adds

- Data of any size, streamed (OME-Zarr, precomputed), from the cloud or
  your disk, without loading it whole.
- Slices at any angle (++shift++ + drag in a cross-section).
- Track filtering on millions of streamlines (TrackVis-style groups).
- Scenes as tabs, and links that share the whole workspace.
- Plugins, and a Python console in the page.

Freeview's other tools are plugins here, off until you turn them on in
the Plugins panel: voxel editing ([Segmentation](../plugins/segmentation.md)),
measuring and statistics ([Annotations](../plugins/annotations.md)),
direction-colour maps, tensors and ODF glyphs
([Orientations](../plugins/orientations.md)), volume filters
([Filters](../plugins/filters.md)) and Transform Volume
([Registration](../plugins/registration.md)).

## Not there yet

- Surfaces: an overlay's mid point, truncate and inverse, custom colour
  scales and the colour wheel; several overlays at once; label outlines;
  the inflated surfaces moved apart as Freeview places them.
- Recon edits (FreeSurfer's control points and brush edits for a
  recon-all run).
