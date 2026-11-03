# Track filtering

![Filtering tab with three groups of the S-21-46 tractogram](../images/plugins/track-filtering.png)

**Kind:** tool · **On by default** · the **Filtering** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/track-filtering)

TrackVis-style track groups. A group keeps the objects that pass through its
regions (spheres, boxes and disks, combined with AND, OR and NOT) and whose
properties are in range, and shows them as a layer of its own colour. It
works on any dataset that is not an image: Zarr Vectors streamlines,
skeletons and points (local `.trk` files included), precomputed
segmentations, and annotation layers.

## Using it

1. Pick the dataset at the top of the Filtering tab.
2. **+ New group**, then **+ Sphere** or **+ Box**. Move a region with its
   sliders or typed values, **Here** (to the position) or **Go** (the view to
   it).
3. On streamlines and skeletons, a region can ask for *passes through*,
   *either end in it* or *both ends in it*.
4. **+ Disk** is TrackVis's disk: a flat region across x, y or z that a
   track must cross within its radius. An *angle limit* keeps only the
   tracks that cross it within that angle of its normal (90° or more: any).
   On segmentations and annotations it is tested as a flat box a quarter
   of its radius thick.
5. The count updates as you move: a quick preview from a coarse level, then
   the exact answer.
6. Rename a group with the pencil icon or by double-clicking its name.

Per group: **Save .trk** (the whole streamlines, as TrackVis), **Density
map** (streamlines per 1 mm voxel, shown as a heat map and saved as NIfTI)
and **CSV** (count and each property's mean, SD, median and range).

## Speed

The first exact answer in a new area takes seconds (the download); moving a
region around an area already read is exact at 10–20 updates a second. The
corpus callosum box on S-21-46 (3.3 M streamlines) is exact in about 20 s
from a cold start.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
