# Time series

![The time course of the voxel under the mouse, two pinned voxels and a region's mean in a synthetic 4-D brain](../images/plugins/time-series.png)

**Kind:** tool · **Off by default** (switch it on in the Plugins tab) · the
**Time series** tab in the bottom dock, and **Alt+P** to pin ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/time-series)

The values of an image along time: the time course of the voxel under the
mouse, of voxels you pin, and the mean over a region, plotted against time
with the time shown in the views marked; and playing through time. It works
on images with a time axis: a 4-D NIfTI opened from this computer (fMRI,
say: its fourth axis is time, one step every repetition time) and OME-Zarr
images with a `t` axis. Neuroglancer shows time as the dimension `t`, and
`[` and `]` step through it. When a layer shows time as a local
dimension of its own (`t'`, in the layer's position controls rather than
the global ones; the Orientations plugin makes a 4-D image's fourth axis
one), the plot and the play and step buttons use the layer's own position
along it.

## Using it

1. Switch the plugin on, open a 4-D image, and open the **Time series** tab
   at the bottom (drag the dock's top edge up for a taller plot).
2. Choose the **Image** if there are several. Move the mouse over the
   image: the plot shows that voxel's values at every time point. The x
   axis is in the image's time unit (seconds for NIfTI); the yellow line
   is the time the views show.
3. **Pin** (or **Alt+P** with the mouse over the views) keeps the voxel's
   series in a colour of its own; **×** in the legend removes it. Up to
   eight pins; they are kept in the link.
4. For a region, draw a box or an ellipsoid in an annotation layer, choose
   it under the transport buttons and **Pin mean**: the mean, at each time
   point, of the voxels whose centres are inside it. Moving the annotation
   reads it again.
5. Point at the plot to read every series at that time; click it to show
   that time in the views.
6. **Play** steps through time at the chosen rate (time points a second),
   from the start again when **Loop** is on; the other buttons go to the
   first, previous, next and last time point. **Alt+Shift+P** plays and
   pauses. The readout gives the time and the time point (from 0).
   Playing makes no undo steps: undo after playing undoes what you did
   before it (the buttons for one time point are steps, as other moves).
7. **% change** plots each series as its change from its own mean, in
   percent, so series with different baselines can be compared.
8. **Save CSV**: a row per time point (its number and time) and a column
   per plotted series, with the values as read (not the percent change).

To save a movie of the time-lapse, use the camera icon → **Movie…** with a
sweep along `t`.

The finest resolution is read, chunk by chunk along time; the first voxel
in a new part of a long series takes a moment (the tab shows the
progress), and voxels near it are then immediate. When that read is large
(a long series in large chunks), the voxel under the moving mouse is read
coarsely first: a sample of the time points, or a coarser resolution
where that is cheaper. The plot draws it dashed and says **coarse** until
the mouse rests on a voxel for a moment and its full values arrive.

## Time series on surfaces

A GIFTI surface opened from this computer with a CIFTI time series
(`.dtseries.nii`) beside it can be stepped through in time. Choose the
series in **Image** (it reads "surface: name_t (file)"), and in the
surface layer's Render → Surface choose **name_t** as the overlay: it
holds the values at the time point the Time series tab shows, and the play
and step buttons and clicks on the plot change it. Stepping is not an undo
step and is not kept in the link. The time courses of vertices are not
plotted yet.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
