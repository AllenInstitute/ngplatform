# Volume rendering

![A template drawn as a solid, cut open at the position](../images/plugins/volume-rendering.png)

**Kind:** tool · **Off by default** (switch it on in the Plugins tab) · a
**Volume** switch beside **Sections** in the 3-D view ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/volume-view)

Draws an image as a solid in Neuroglancer's 3-D view, ray-marched from its
pyramid, with the octant facing the camera cut away at the position so the
sections show on the cut faces. Tracts and annotations are drawn in the same
view, depth-tested against it.

## Using it

- Switch the plugin on, then **Volume** in the 3-D panel.
- It draws the selected image: an OME-Zarr image (local NIfTI included) or a
  precomputed one.
- Detail follows the zoom, or a chosen level. A level over 384 voxels a side
  is drawn as a 256-voxel box around the position, which follows it, inside
  the whole image from the finest level that fits (so the rest of the brain
  stays, coarser).
- The cut's faces show three sections of their own, as sharp as the 3-D
  view's zoom can show, down to the image's finest level: zoom into the cut
  to see fine structure over the coarse solid. **Fine sections on the cut**
  in the Volume tab turns this off, to show the 2-D views' sections instead
  (as does switching **Sections** back on in the 3-D view).

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
