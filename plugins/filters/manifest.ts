/**
 * The filters plugin's manifest: an image computed as it is viewed (a
 * pipeline of filters run by chunkmirage's browser engine), as another
 * layer.  Its code is ./plugin.ts and ./pipeline.ts.
 */
import type { Manifest } from "@ngplatform/sdk";

export const FILTERS_PANEL = "filters.panel";

export const FILTERS_MANIFEST: Manifest = {
  id: "org.ngplatform.filters",
  name: "Filters",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  description: "Any image filtered as it is viewed (Gaussian, mean, median, difference of Gaussians, Frangi vesselness, threshold, morphology), run by chunkmirage's engine in the page, as a layer of its own.",
  guide: `A filtered image is computed as it is viewed, by [chunkmirage](https://github.com/JaneliaSciComp/chunkmirage)'s browser engine: each chunk Neuroglancer asks for is the pipeline run on the image's voxels around it, at the level shown, so nothing is written and zooming in computes only what is in view. Sizes are in voxels of the level computed, so a zoomed-out view is a preview of the full-resolution result. Chunks the viewer stops waiting for are dropped.

## Steps
- **Gaussian** (sigma) and **Mean** (radius): smoothing.
- **Median** (radius): smoothing that keeps edges and removes speckle.
- **Difference of Gaussians** (sigma): blobs and edges about that size.
- **Frangi vesselness** (sigma from, to): how much each voxel looks like part of a tube (a vessel, a fibre, an axon) brighter (or darker) than around it, 0 to 1.
- **Threshold** (from, below): a mask, shown as a segmentation.
- **Morphology** (open or close, radius): cleans a mask.

Median and Frangi run Python (SciPy, scikit-image) in the page, loaded the first time one is viewed.

## Using it
Choose an image (any image layer: a file on this computer, or an OME-Zarr, N5 or precomputed volume at a URL), add steps, then **Add filtered view**: a new layer, whose link carries the whole pipeline.`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: FILTERS_PANEL, title: "Filters", slot: "left", order: 80 }],
  },
};
