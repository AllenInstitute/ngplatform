/** The volume view plugin's manifest: read without loading its code. */
import type { Manifest } from "@ngplatform/sdk";

export const VOLUME_PANEL = "volumeView.panel";
export const VOLUME_STATE_KEY = "volumeView";

export const VOLUME_VIEW_MANIFEST: Manifest = {
  id: "org.ngplatform.volume-view",
  name: "Volume rendering",
  version: "0.2.0",
  kind: "tool",
  enabledByDefault: false,
  description: "Draws an image as a solid in Neuroglancer's 3-D view, cut open at the position so the sections show inside it.",
  guide: `Switch it on with **Volume**, beside **Sections** in the 3-D panel (or in the Volume tab). The first 3-D image in the scene (OME-Zarr, local NIfTI included, or precomputed) is drawn as a solid: a coarse level of it with finer bricks near the camera, ray-marched on this computer's GPU to the tissue surface.

## What you see
- The octant facing the camera is cut away at the current position, so three sections show the inside on the cut's faces: sections of their own, as sharp as the 3-D view's zoom can show, down to the image's finest level (zoom in on the cut to see fine structure over the coarse solid). Where they do not reach, the faces show the coarse volume.
- Everything else in the 3-D view (tracts, meshes, annotations) is drawn with it and hidden where tissue is in front, so tracts show through the cut.
- Hiding the image's layer hides the solid.

## Settings (the Volume tab)
- **Image**: which image layer to draw.
- **Detail**: Automatic draws the whole image from a coarse level with bricks of the finer levels over it, finer near the camera and the cut, sharpening as they load. A chosen level that fits whole (384 voxels on a side) is drawn whole; a larger one is the finest the bricks use.
- **Tissue threshold**: how different from the background a voxel must be to count as tissue. It works for dark backgrounds (MRI) and pale ones (stains): the volume's border decides which.
- **Cut open at the position** (the octant facing the camera): off shows the whole surface.
- **Fine sections on the cut**: on (the default), the faces get three sections of their own (Neuroglancer's layout cross-sections, up to 2048 pixels a side around the position, following the 3-D zoom), and the 3-D view's Sections switch is turned off so the 2-D views' sections do not lie on them. Turning Sections back on returns to the 2-D views' sections (at the 2-D views' zoom, as far as they reach), and turns this off.

Images must be 3-D (no t or c axis yet). Switching it on changes a layout without a 3-D view to xy + 3-D.`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: VOLUME_PANEL, title: "Volume", slot: "left", order: 50 }],
    commands: [{ id: "volumeView.toggle", title: "Toggle volume rendering", group: "View" }],
    appState: { key: VOLUME_STATE_KEY, version: 2 },
  },
};
