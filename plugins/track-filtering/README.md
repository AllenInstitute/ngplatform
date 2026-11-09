# Track filtering

![Three track groups of the S-21-46 tractogram](../../docs/images/plugins/track-filtering.png)

TrackVis-style track groups over any dataset that is not an image: Zarr
Vectors streamlines, skeletons and points, segmentations and annotation
layers. Each group keeps the objects that pass through its regions
(spheres, boxes, disks and masks, with AND, OR and NOT), whose attributes
are in range and whose tags it keeps, and shows them as a layer of its own
colour. Groups save to TrackVis `.trk`, density maps and CSV, run on this
computer as a filter job, and write into their store. Requires the Zarr
Vectors plugin. The user's guide is
[docs/plugins/track-filtering.md](../../docs/plugins/track-filtering.md).

| File | What |
|---|---|
| `manifest.ts` | The Filtering panel (Tools dock, under Vectors), its commands and keys, its state slice, the guide |
| `plugin.ts` | `TrackGroups`: the groups, their answers, their layers and own stores, saving; the panel, built from the SDK's cards and controls and updated in place; provides the `trackFiltering.groups` service (the volume view draws groups through it) |
| `filter.ts` | Attribute ranges and tags as a mask, counts and statistics (pure, unit-tested) |
| `roi.ts` | Region tests on chunks, and combining regions' answers (pure, unit-tested) |
| `roi_client.ts`, `roi_worker.ts` | Region tests and streamline reads in a worker, against the store |
| `labels.ts`, `labels_client.ts`, `labels_worker.ts` | Region tests on a segmentation's voxels and on precomputed annotations, in a worker |
| `annotation_regions.ts` | Region tests on an annotation layer's own annotations |
| `density.ts` | Track density maps: the grid (a voxel size chosen, or the store's default), counting, the NIfTI file |
| `trk.ts` | TrackVis v2 writing |
| `runner_job.ts` | A group as a filter job for the runner on this computer ("Run on this computer"): its regions and ranges as a zvf-predicate tree, masks as voxels, tags as the objects they choose |
| `zv_groups.ts` | Groups written into a Zarr Vectors store's level 0, the new chunks beside the old and the zarr.json files swapped in last |
| `tests/` | `npm test` runs them; `fake_context.ts` is a context with a fake reader and files, `workspace.ts` one over the real workspace store (for undo steps) |

On a tractogram opened from this computer, a group's own streamlines (the
store its layer draws, and **Save .trk**) are read from the file by id
through the store's `curves` message, not from the chunks every streamline
passes through. A group of more than 8 million points is drawn from the
finest sample level that fits, and its note says so; making track files from
such a group at full size is the runner's filter job (**Run on this
computer**, with the runner paired in Settings › Compute; the job shows in
Activity). Regions read only the chunks they touch, a sample level first.
