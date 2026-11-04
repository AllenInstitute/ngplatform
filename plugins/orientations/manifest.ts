/** The orientations plugin's manifest: read without loading its code. */
import type { Manifest } from "@ngplatform/sdk";

export const ORIENTATIONS_PANEL = "orientations.panel";
export const ORIENTATIONS_STATE_KEY = "orientations";

export const ORIENTATIONS_MANIFEST: Manifest = {
  id: "org.ngplatform.orientations",
  name: "Orientations",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  description: "Draws orientation glyphs over an OME-Zarr image: ODFs from spherical harmonics, diffusion tensors as ellipsoids, and peaks or vectors as lines, finer as you zoom in.",
  guide: `Open an image whose voxels hold orientations: an OME-Zarr with a channel axis \`c\` (or a 4-D NIfTI, whose fourth axis holds them), then switch on **Orientations** (in its tab, or **Glyphs** beside **Sections** in the 3-D panel). Neuroglancer still shows the image itself (the first component); the plugin draws a glyph per voxel over it.

## What it reads
- **Spherical harmonics**: 6, 15, 28, 45, 66 or 91 coefficients per voxel (orders 2 to 12), drawn as ODF glyphs (exact: each pixel's ray meets the ODF's surface), coloured by direction. Choose the basis: DIPY writes \`descoteaux07\` (its legacy form unless told otherwise), MRtrix3 writes \`tournier07\`.
- **Tensors**: 6 components, drawn as ellipsoids (exact: each pixel's ray meets the ellipsoid, so they are smooth at any size and quick in their thousands) or as a line along the principal direction, coloured by the principal direction and dimmed where the anisotropy is low. Choose the order the file stores them in (FSL, DIPY or MRtrix); a NIfTI whose header says symmetric matrix is DIPY's.
- **Vectors and peaks**: 3 components per direction, drawn as lines through the voxel.

The plugin guesses the kind from the number of components (6 is taken as a tensor) and from the store's \`orientations\` attributes, when it has them.

## Glyphs
- **SH glyph**: the ODF's shape, or lines along its peaks.
- **Hide below anisotropy**: leave out glyphs whose GFA (spherical harmonics) or FA (tensors) is lower.
- **Size** (1 fills a voxel), **Spacing** (pixels between glyphs, which picks the level), **Most glyphs per view**.

## Under the cursor
The tab says what the voxel under the cursor holds: a tensor's FA, MD, eigenvalues and principal direction; an ODF's GFA and peaks; a vector's direction and length.

## As you zoom
Each 2-D view shows one glyph per voxel of the level whose voxels are at least **Spacing** pixels apart on the screen. Zoom in and the next finer level's glyphs load and replace the coarser ones; the coarser stay until they arrive. Only the voxels on the section and in view are read.

For tensors the coarser levels should be log-Euclidean means (a plain mean swells crossing tensors into fat discs). A NIfTI opened from this computer gets them from the app: when its header says symmetric matrix, or once the plugin draws it as tensors (in the **Tensor order** chosen). The tab says which its coarser levels are.

## In the 3-D view
The glyphs of the 2-D views' sections are drawn on those sections in the 3-D view, in front of them and hidden behind other things there; with no 2-D views, three planes through the position.

## Direction
- **Frame**: directions along the voxel axes (DIPY, FSL) or along the world's x, y and z (MRtrix).
- **Flip x, y, z**: when glyphs point the wrong way (a common bvec problem), flip an axis, as in mrview or DSI Studio.

## Direction colour
**Direction colour on the image** sets the image layer's shader to show the principal direction as colour (red left-right, green front-back, blue up-down), weighted by the anisotropy, as Freeview's \`-dti\` display does. For spherical harmonics the direction comes from the order-2 terms.`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  links: [
    { title: "FURY: odf_slicer and tensor_slicer", url: "https://fury.gl" },
    { title: "DIPY: spherical harmonic bases", url: "https://docs.dipy.org/stable/theory/sh_basis.html" },
    { title: "MRtrix3: spherical harmonics", url: "https://mrtrix.readthedocs.io/en/latest/concepts/spherical_harmonics.html" },
  ],
  provides: { services: ["orientations.status"] },
  contributes: {
    panels: [{ id: ORIENTATIONS_PANEL, title: "Orientations", slot: "left", order: 55 }],
    commands: [{ id: "orientations.toggle", title: "Orientation glyphs on or off", group: "View" }],
    appState: { key: ORIENTATIONS_STATE_KEY, version: 1 },
  },
};
