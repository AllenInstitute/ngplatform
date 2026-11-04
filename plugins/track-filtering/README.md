# Track filtering

![Three track groups of the S-21-46 tractogram](../../docs/images/plugins/track-filtering.png)

TrackVis-style track groups over a Zarr Vectors dataset. Each group keeps
the streamlines that pass through its regions (spheres and boxes, with AND,
OR and NOT) and whose attributes are in range, and shows them as a layer of
its own colour. Groups save to TrackVis `.trk`. Requires the Zarr Vectors
plugin.

| File | What |
|---|---|
| `manifest.ts` | The Filtering tab, its commands and its state slice |
| `plugin.ts` | The tab, the groups, `.trk` saving; provides the `trackFiltering.groups` service (the volume view draws groups through it) |
| `filter.ts`, `roi.ts` | Attribute filters and region tests (pure, unit-tested) |
| `roi_client.ts`, `roi_worker.ts` | Region tests and streamline reads in a worker, against the store |
| `trk.ts` | TrackVis v2 writing |
| `tests/` | `npm test` runs them |

On a tractogram opened from this computer, a group's own streamlines (the
store its layer draws, and **Save .trk**) are read from the file by id
through the store's `curves` message, not from the chunks every streamline
passes through. A group of more than 8 million points is drawn from the
finest sample level that fits, and its note says so; making track files from
such a group at full size is the local runner's filter job (Jobs → This
computer). Regions read only the chunks they touch, a sample level first.
