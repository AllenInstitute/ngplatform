# Time series

![The time course of the voxel under the mouse, two pinned voxels and a region's mean in a synthetic 4-D brain](../images/plugins/time-series.png)

**Kind:** tool · **Off by default** (offered when you open a 4-D image or a CIFTI series; or turn it on in the Plugins tab) · the
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

To save a movie of the time-lapse, use the camera icon → **Movie: sweep slices or time…** with a
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
(`.dtseries.nii`) beside it can be stepped through in time, and its
vertices' time courses plotted. Choose the series in **Image** (it reads
"surface: name_t (file)"), and press **Show name_t as the overlay** (or
choose it in the surface layer's Render → Surface): it holds the values at
the time point the Time series tab shows, and the play and step buttons
and clicks on the plot change it. The time point is kept in the link
(shown again when the workspace opens) and each step is an undo step, as
for images; playing makes none until it stops.

Move the mouse onto the surface, in the 3-D view or near its outline in a
2-D one: the plot shows the values of the nearest vertex at every time
point, if one is within three of the surface's typical edge lengths of
the mouse (its median; so a coarse mesh such as fsaverage5 has no gaps
between vertices), and the legend names the vertex by its number in the
surface file (and the parcel it is in, when the surface has a
parcellation). Off the surface, the last vertex stays
plotted. **Pin** (or **Alt+P**) keeps the vertex, **Save CSV** saves the
plotted vertices, and **% change** works as for voxels; pins are kept in
the link with the surface and the vertex number. A vertex on the medial
wall has no values in the file: the legend says so and nothing is drawn.
The surface layer may be moved (Registration, the Source tab's transform):
the vertex is the one shown under the mouse.

### Parcels

With a parcellation beside the surface (an `.annot` file, or `.label`
files, in FreeSurfer's `label` folder; a CIFTI `.dlabel.nii`), the tab
offers its parcels (with how many vertices each has; a parcellation menu
when there are several). **Pin mean** pins the parcel chosen; **Its
parcel** (or **Alt+Shift+M** over the views) pins the parcel of the vertex
under the mouse. A parcel is plotted as the mean over its vertices at each
time point, with a shaded band of ± one standard deviation across them;
**Save CSV** writes the mean and, in the next column, the SD. Vertices
with no values (the medial wall) are left out. Parcel pins are kept in the
link.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
