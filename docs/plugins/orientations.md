# Orientations

![Fibre ODFs from DIPY's Stanford HARDI sample over the 2-D views and on their sections in the 3-D view](../images/plugins/orientations.png)

**Kind:** tool · **Off by default** (switch it on in the Plugins tab) · an
**Orientations** tab, and a **Glyphs** switch beside **Sections** in the
3-D view ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/orientations)

Draws orientation glyphs over an image whose voxels hold directions: fibre
ODFs from spherical harmonics (as DIPY and MRtrix write them), diffusion
tensors as ellipsoids, and peaks or vectors as lines, one glyph per voxel,
as FURY's slicers and MRtrix's `mrview` show them. With a multiscale image
(each level holding coarser values), zoomed out you see the coarse glyphs;
zoom in and the finer level's glyphs load in and take their place.

## Using it

- Open an image with one axis of components per voxel: an OME-Zarr with a
  channel axis `c` (shape c, z, y, x), or a 4-D NIfTI (its fourth axis holds
  the components; read in place, with coarser levels made as means).
  Neuroglancer shows the image itself: the first component.
- Switch on **Orientation glyphs** in the Orientations tab (or **Glyphs** in
  the 3-D view). The first image with components is drawn; **Image** picks
  another.
- **Data** says what the components are. Automatic reads the store's own
  `orientations` attributes, else guesses from their number: 3 a vector,
  6 a tensor, 15, 28, 45 … spherical harmonics, other multiples of 3 peaks.
  Six can also be order-2 harmonics: choose it here.
- **SH basis**: DIPY writes `descoteaux07` (its legacy form unless told
  otherwise), MRtrix3 `tournier07`. A wrong basis gives scrambled glyphs.
- **Tensor order**: FSL (Dxx Dxy Dxz Dyy Dyz Dzz), DIPY (Dxx Dxy Dyy Dxz Dyz
  Dzz) or MRtrix (Dxx Dyy Dzz Dxy Dxz Dyz). **Tensor glyph**: an ellipsoid,
  or a line along the principal direction.
- **Frame**: directions along the voxel axes (DIPY, FSL) or along the
  world's x, y, z (MRtrix). **Flip x, y, z** when glyphs point the wrong
  way.
- **Normalise**: each glyph scaled to its own range (as FURY), or to its
  maximum, or all to the largest in the view so sizes compare.
- **Size** (1 fills a voxel), **Spacing** (glyphs at least this many pixels
  apart: the level is the finest that keeps them so), **Most glyphs per
  view** (beyond it, zoom in).
- **2-D views**, **3-D view**: where glyphs are drawn. In the 3-D view they
  sit on the 2-D views' sections; with only a 3-D view, on three planes
  through the position.
- **Direction colour on the image** sets the image layer's colours to the
  principal direction (red left-right, green front-back, blue up-down),
  weighted by the anisotropy, as Freeview's `-dti` display. Its Render tab
  has a brightness slider.

Glyphs are drawn into screenshots taken with Neuroglancer's screenshot
button.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
