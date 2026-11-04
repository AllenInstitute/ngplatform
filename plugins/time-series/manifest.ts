/**
 * The time series plugin's manifest: the time course of the voxel under the
 * mouse in an image with a time axis, pinned voxels and regions beside it,
 * and playing through time.  Its code is ./plugin.ts.
 */
import type { Manifest } from "@ngplatform/sdk";

export const TIME_SERIES_PANEL = "timeSeries.panel";

export const TIME_SERIES_MANIFEST: Manifest = {
  id: "org.ngplatform.time-series",
  name: "Time series",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  description: "Plots the time course of the voxel under the mouse in an image with a time axis (a 4-D NIfTI, OME-Zarr with t), keeps pinned voxels and region means, and plays through time; on a surface with a CIFTI time series, the vertex under the mouse, pinned vertices and the mean (with its SD) over a parcel.",
  guide: `The **Time series** tab (in the bottom dock) plots an image's values along time: at the voxel under the mouse, at pinned voxels, and as the mean over a region. Images with a time axis are 4-D NIfTI files (their fourth axis is time, in the header's unit, one step every pixdim[4]) and OME-Zarr images with a \`t\` axis; Neuroglancer shows time as the dimension \`t\`.

## Plotting
- Choose the **Image**. Move the mouse over it in the views: the plot shows that voxel's values at every time point (the finest level, as stored). The vertical line is the time shown in the views; the x axis is in the image's time unit.
- Point at the plot to read every series at a time; click it to show that time.
- **% change** plots each series as its change from its own mean, in percent.

## Pinning
- **Pin** (or **Alt+P** over the views) keeps the voxel under the mouse as a series of its own, in its own colour, until removed (**×**). Up to eight pins.
- **Region**: a box or ellipsoid drawn in an annotation layer; **Pin mean** keeps the mean, at each time point, of the image's voxels whose centres are inside it.
- Pins are kept in the link.

## Playing
- **Play** steps through time at the chosen rate (time points a second), looping when **Loop** is on; the buttons beside it go to the first, previous, next and last time point. **Alt+Shift+P** plays and pauses. Neuroglancer's \`[\` and \`]\` also step through time.
- The readout gives the time shown, in seconds (or the image's unit) and as a time point.

## Surfaces
- A GIFTI surface opened from this computer with a CIFTI time series (\`.dtseries.nii\`) beside it: choose the series in **Image** ("surface: name_t (file)") and press **Show name_t as the overlay**. The play and step buttons change the time point the surface shows.
- Move the mouse onto the surface: the plot shows the nearest vertex's values (within 4 mm of the mouse). **Pin**, **Alt+P**, **% change** and **Save CSV** work as for voxels. A vertex on the medial wall has no values.
- **Parcels**: with a parcellation beside the surface (an \`.annot\` file or \`.label\` files in FreeSurfer's \`label\` folder, or a CIFTI \`.dlabel.nii\`), choose a parcel and **Pin mean**, or press **Its parcel** (**Alt+Shift+M**) with the mouse on the surface for the parcel of the vertex under it. The plot shows the mean over the parcel's vertices at each time point, with a band of ± one standard deviation across them; the CSV has a column for the mean and one for the SD. The legend names the parcel the vertex under the mouse is in.

## Saving
- **Save CSV**: a row per time point (its index and time), a column per plotted series, with the values as read.
- A movie of the time-lapse: the camera icon → **Movie…**, a sweep along \`t\`.`,
  license: "Apache-2.0",
  activation: [`onView:${TIME_SERIES_PANEL}`, "onCommand:timeSeries.pin", "onCommand:timeSeries.play", "onCommand:timeSeries.pinParcel"],
  contributes: {
    panels: [{ id: TIME_SERIES_PANEL, title: "Time series", slot: "bottom", order: 50 }],
    commands: [
      { id: "timeSeries.pin", title: "Time series: pin the voxel or vertex under the mouse", group: "Time series" },
      { id: "timeSeries.play", title: "Time series: play or pause", group: "Time series" },
      { id: "timeSeries.pinParcel", title: "Time series: pin the mean over the parcel of the vertex under the mouse", group: "Time series" },
      { id: "timeSeries.saveCsv", title: "Time series: save the plotted series as CSV", group: "Time series" },
    ],
    keybindings: [
      { key: "alt+p", command: "timeSeries.pin" },
      { key: "alt+shift+p", command: "timeSeries.play" },
      { key: "alt+shift+m", command: "timeSeries.pinParcel" },
    ],
    appState: { key: "timeSeries", version: 1 },
  },
};
