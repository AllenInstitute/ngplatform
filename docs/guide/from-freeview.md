# Coming from Freeview

Freeview is FreeSurfer's desktop viewer. ngplatform does many of the same
things in a browser, on data far larger than fits in memory, and shares a
view as a link. This page maps one onto the other, including what is not
there yet.

## Where things are

| In Freeview | In ngplatform |
|---|---|
| File → Load Volume | **Open → Open from device**, or **Add → Local** (NIfTI, TIFF; `.mgz` coming) |
| File → Load Surface | **Add → Local**: FreeSurfer surfaces, GIFTI, OBJ, STL, PLY |
| File → Load Tract | **Add → Local**: `.trk`, `.tck`, `.trx` |
| Layer panel (left) | **Datasets** tab, and the **Layer** tab on the right for the selected one |
| Colour map, window/level | Layer → **Render → Colour map** (grayscale, heat, jet, GE colour, NIH, PET, binary colour and more) and the contrast slider |
| Lookup table (FreeSurferColorLUT) | Layer → **Render → Lookup table**: FreeSurfer's and other atlases' tables, or a file |
| Viewport layouts 1×1, 2×2, 1&3 | the layout buttons, or the command palette's *Set the layout* |
| Coordinates / Info panel | the position at the top left of the views; each layer's value under the mouse |
| Tools → Transform Volume | the **Registration** plugin (same controls, plus landmark fitting) |
| File → Save Screenshot | the camera icon in the top bar |
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

- `.mgz` / `.mgh` volumes, in and out.
- Values on surfaces (curvature, thickness, overlays, `.annot`, `.label`),
  and surface outlines drawn on the slices.
- Voxel editing: drawing and erasing labels, fills, recon edits.
- Measuring: lengths, areas, region and label statistics, line profiles.
- Diffusion displays: direction-colour maps, tensor and ODF glyphs.
- Volume filters (mean, median, Gaussian…), movies and GIFs.
