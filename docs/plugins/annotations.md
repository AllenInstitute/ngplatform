# Annotations

![Labels pinned to structures, in 2-D and 3-D](../images/plugins/labels.png)

**Kind:** tool · **On by default** · the **Annotations** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/annotations)

Everything you add to annotate a dataset, in one tab with three sections:
**Labels** for figures, **Measure** and **Statistics**. Each section folds;
the tab remembers which are open. Label volumes drawn by hand, once a fourth
section here, have a tab of their own: see [Segmentation](segmentation.md).
(This plugin was called *Labels*; links made then still open.)

## Labels

Labels on the views for figures, as an anatomy atlas draws them: a pin on
what is named, a thin leader line, and the name beside it or lined up at the
view's side.

- **+ At the position** pins a label at the current position; **+ Track
  groups** labels every group; **+ Annotations** labels the annotations of
  an annotation layer that have a description.
- Each label: text, colour, placement (beside the pin or at the side), and
  whether it shows in 2-D, 3-D or both. Drag labels in the views to move
  them; drag a corner or use the size slider to resize them; double-click
  puts one back.
- Labels are kept in the link and painted into screenshots (camera icon).

## Measure

![Measuring a line, a box and an ellipse; a line profile and statistics](../images/plugins/annotations-measure.png)

- **Line**, **Polyline**, **Box**, **Ellipsoid** pick Neuroglancer's own
  annotation tool in a *measurements* layer (made the first time). Then
  ++ctrl++ + click in a view: twice for a line or a box, the centre then the
  extent for an ellipsoid, points ending with a double-click for a
  polyline. Pick the tool again to stop.
- Every line and polyline in the scene's annotation layers is listed with
  its **length**, every box and ellipsoid with its **volume** (an **area**
  when it is flat), in physical units through the layer's transform. Click a
  row to go to it; **Save as CSV** writes them all.
- **Line profile**: choose a line (or polyline) and an image, then
  **Profile**: the image's values along it, about one sample a voxel
  (nearest voxel or trilinear), as a plot that reads out the value under
  the pointer. **Save profile as CSV** writes distance, position, voxel and
  value.

## Statistics

As Freeview's label statistics: choose an **image** and a **region** (a box
or ellipsoid annotation, a segment of a layer drawn in the
[Segmentation](segmentation.md) tab, or a label
of any segmentation layer whose voxels can be read, such as an atlas in
NIfTI or OME-Zarr, by its number), then
**Compute**: the voxel count, volume (mm³), mean, standard deviation
(n − 1), minimum, maximum and median of the image inside. The finest level
of the image whose box round the region fits the **memory** chosen is read
(the result says which). Results gather as cards; **Save as CSV** writes
them.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
