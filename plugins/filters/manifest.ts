/**
 * The filters plugin's manifest: an image filtered on the fly (mean,
 * median, Gaussian, Frangi vesselness), as another layer.  Its code is
 * ./plugin.ts; the filtering is the platform's (src/virtual/images/filters.ts).
 */
import type { Manifest } from "@ngplatform/sdk";

export const FILTERS_PANEL = "filters.panel";

export const FILTERS_MANIFEST: Manifest = {
  id: "org.ngplatform.filters",
  name: "Filters",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  description: "An image filtered on the fly (mean, median, Gaussian, Frangi vesselness), at every level, as a layer of its own.",
  guide: `A filtered image is computed as it is viewed: each chunk Neuroglancer asks for is the filter applied to the image's chunks around it, at that level, so nothing is written and zooming in computes only what is in view. The filter's width is kept the same in millimetres from level to level.

## Filters
- **Mean** and **Median** over a box (radius in voxels of the finest level): smoothing; the median keeps edges and removes speckle.
- **Gaussian** (sigma in voxels of the finest level): smoothing.
- **Frangi vesselness**: how much each voxel looks like part of a tube (a vessel, a fibre, an axon) brighter (or darker) than around it, over a range of scales; 0 to 1.

## Using it
Choose an image opened from this computer (NIfTI, FreeSurfer, TIFF, NumPy), a filter and its settings, then **Add filtered view**: a new layer, to compare with the original or to colour with a colour map.`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: FILTERS_PANEL, title: "Filters", slot: "left", order: 80 }],
  },
};
