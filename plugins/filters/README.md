# Filters

![Gaussian smoothing and Frangi vesselness of a T1, computed as viewed](../../docs/images/plugins/filters.png)

An image filtered on the fly, as a layer of its own: mean, median,
Gaussian, or Frangi's vesselness. Nothing is written. Each chunk
Neuroglancer asks for is the filter applied to the source's chunks around
it (a margin as wide as the filter reaches), at that level, with the
filter's width kept the same in millimetres from level to level.

| File | What |
|---|---|
| `manifest.ts` | The Filters tab |
| `plugin.ts` | The tab: an image opened from this computer, a filter, its settings; adds the filtered layer |

The filtering is the platform's (`src/virtual/images/filters.ts`): a
filtered image is a file made in the page holding the image's own bytes,
named `<file>~<filter>.vfilter`, which the image worker opens as the image
with the filter applied chunk by chunk (`FilteredStore`). Tests:
`tests/filters.test.ts` (each kernel, and every chunk against the filter on
the whole image, so there are no seams; big-endian sources).

Sources are images opened from this computer for now (NIfTI, FreeSurfer,
TIFF, NumPy); remote OME-Zarr needs the same store over a remote reader.
