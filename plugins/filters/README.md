# Filters

![Gaussian smoothing and Frangi vesselness of a T1, computed as viewed](../../docs/images/plugins/filters.png)

Any image filtered as it is viewed, as a layer of its own: a pipeline of
steps (Gaussian, mean, median, difference of Gaussians, Frangi's
vesselness, threshold, morphology) run by
[chunkmirage](https://github.com/JaneliaSciComp/chunkmirage)'s browser
engine in the page. Nothing is written. Each chunk Neuroglancer asks for is
the pipeline run on the image's voxels around it, at the level shown, so a
zoomed-out view is a preview; chunks the viewer stops waiting for are
dropped. The image can be any image layer: a file on this computer, or an
OME-Zarr, N5 or precomputed volume at a URL. The new layer's source carries
the whole pipeline, so its link works wherever the image can be read.

| File | What |
|---|---|
| `manifest.ts` | The Filters tab |
| `pipeline.ts` | Steps as chunkmirage ops: its own (`gaussian`, `uniform`, `dog`, `threshold`, `morphology`), median and Frangi as `python` ops (SciPy, scikit-image) whose code is the plugin's, their settings as the code's sliders and their `#halo` set from them, and a Python step of one's own (the code as written); ops back to steps (`stepsOf`), and steps read back from the workspace (`readSteps`) |
| `plugin.ts` | The tab: an image, the steps, **Add filtered view**; the new layer keeps the image's shader and range when the steps only smooth. The image and steps are kept in the workspace (`appState` `filters`), so a reload, undo or link brings them back; a link without them reads the steps of its newest filtered layer. Redrawn only when the image layers change, the control in use keeping its focus and caret |
| `tests/pipeline.test.ts` | Steps to ops and back |

The engine is the platform's (`workspace.computed`, `src/virtual/computed.ts`).
A file on this computer (NIfTI, MGH, NumPy, TIFF) is read through its
store's z, y, x view (`src/virtual/images/zyx.ts`), as chunkmirage reads
only images whose last axes are z, y, x, and the filtered layer is placed
by the file's own affine.
Sizes are in voxels of the level computed (chunkmirage runs each level's own
voxels), not millimetres kept from level to level as the earlier filters
were; old `.vfilter` layers still open.
