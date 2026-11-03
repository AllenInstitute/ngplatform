# Filters

![Gaussian smoothing and Frangi vesselness of a T1, computed as viewed](../images/plugins/filters.png)

**Kind:** tool · **Off by default** (switch it on in the Plugins tab) · the
**Filters** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/filters)

An image filtered as you view it, added as a layer of its own beside the
original. Nothing is saved: each piece of the view is computed when it is
needed, at the resolution being shown, so zooming in computes only what is
in view, and the filter's width stays the same in millimetres at every
zoom.

## Using it

1. Open an image from this computer (NIfTI, FreeSurfer `.mgz`, TIFF, NumPy).
2. In the Filters tab choose it, a filter and its settings:
   - **Gaussian** (sigma) and **Mean** (radius): smoothing.
   - **Median** (radius): removes speckle and keeps edges.
   - **Frangi vesselness** (scales, contrast, bright or dark): how much each
     voxel looks like part of a tube (vessels, fibres, axons), 0 to 1.
3. **Add filtered view**. Colour it with a colour map (Render → Shader), or
   export it with **Export as…**.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
