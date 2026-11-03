# Filters

![Gaussian smoothing and Frangi vesselness of a T1, computed as viewed](../images/plugins/filters.png)

**Kind:** tool · **Off by default** (switch it on in the Plugins tab) · the
**Filters** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/filters)

Any image filtered as you view it, added as a layer of its own beside the
original. Nothing is saved: each piece of the view is computed when it is
needed, at the resolution being shown, by
[chunkmirage](https://github.com/JaneliaSciComp/chunkmirage)'s engine
running in the page, so zooming in computes only what is in view. Sizes are
in voxels of the resolution shown, so a zoomed-out view is a preview of the
full-resolution result.

## Using it

1. Add an image: a file from this computer (NIfTI, FreeSurfer `.mgz`,
   TIFF, NumPy) or an OME-Zarr, N5 or precomputed volume at a URL.
2. In the Filters tab choose it, then one or more steps, run in order:
   - **Gaussian** (sigma) and **Mean** (radius): smoothing.
   - **Median** (radius): removes speckle and keeps edges.
   - **Difference of Gaussians** (sigma): blobs and edges about that size.
   - **Frangi vesselness** (sigma from, to; bright or dark): how much each
     voxel looks like part of a tube (vessels, fibres, axons), 0 to 1.
   - **Threshold** (from, below): a mask, added as a segmentation.
   - **Morphology** (open or close, radius): cleans a mask.
3. **Add filtered view**. The layer's link carries the steps, so it opens
   wherever the image can be read. Median and Frangi load Python (SciPy,
   scikit-image) in the page the first time, which takes a few seconds.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
