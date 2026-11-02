# Annotations

![Labels pinned to structures, in 2-D and 3-D](../images/plugins/labels.png)

**Kind:** tool · **On by default** · the **Annotations** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/annotations)

Everything you add to annotate a dataset, in one tab with four sections:
**Labels** for figures, **Measure**, **Statistics** and **Segmentation**
(label volumes drawn by hand). Each section folds; the tab remembers which
are open. (This plugin was called *Labels*; links made then still open.)

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
or ellipsoid annotation, or a label of a label volume drawn here), then
**Compute**: the voxel count, volume (mm³), mean, standard deviation
(n − 1), minimum, maximum and median of the image inside. The finest level
of the image whose box round the region fits the **memory** chosen is read
(the result says which). Results gather as cards; **Save as CSV** writes
them.

## Segmentation

![Drawing labels on SRB 2026a: brush, fill, quick select](../images/plugins/annotations-segmentation.png)

Label volumes drawn by hand, as in WebKnossos, ITK-SNAP or Freeview's voxel
edit (see [the survey](segmentation-survey.md) for what is here and what
is to come).

- **New**: choose an image and one of its levels: the label volume has the
  same voxels and placement. 8-bit labels go to 255, 16-bit to 65,535.
  **Open NIfTI…** reads a label image from your computer to edit.
- **Draw in the views** turns drawing on: the left button draws with the
  tool, everything else stays Neuroglancer's (the wheel moves through
  sections); hold ++space++ to move the view with the left button.
  ++escape++ stops drawing.
- Tools (keys while drawing):
    - **Brush** (++b++): a disc in the section, or a ball; its radius in mm
      (round in space whatever the voxels) or in voxels; ++bracket-left++
      and ++bracket-right++ change it. **Paint over** any label, or only
      unlabelled voxels.
    - **Erase** (++e++): any label, or only the active one.
    - **Fill 2-D** (++f++) fills the region clicked in its section; **Fill
      3-D** (++shift+f++) in a box a chosen reach round the click. A fill
      follows the label clicked (fill inside an outline) or an intensity
      range of the image.
    - **Pick** (++i++) takes the label clicked.
    - **Quick select** (++q++): drag a box round a structure in a 2-D view
      (Otsu's threshold inside it; the side its middle is on) or click one
      (values within the tolerance of the one clicked). Other methods (an
      AI model) can be added by plugins.
- **Interpolate** (++v++): draw a label in two sections a few apart (in
  the same 2-D view), then fill the sections between: each takes a shape
  between the two drawn (shape-based interpolation), on unlabelled voxels
  only. Check the result, as with any interpolation.
- **Image values**: the image whose values limit the tools (by default the
  one the grid came from), a **range**, and whether the brush and eraser
  keep to it. **Range from the cursor** sets it round the value under the
  pointer.
- **Undo** and **Redo** strokes: ++ctrl+z++ and ++ctrl+shift+z++ while
  drawing (the workspace's own undo otherwise).
- **Labels** lists the labels painted, with voxels and volume; click one to
  draw with it. Choose each label's colour and name beside the label number;
  **New label** takes the next unused one.
- **Save**: NIfTI (.nii.gz, marked as labels) or an OME-Zarr folder (in a
  zip where the browser cannot write folders). **Only the painted box**
  saves the box round what is painted, placed where it was. OME-Zarr writes
  only the painted chunks, so it suits large grids; NIfTI holds every voxel.

!!! warning "Save before you leave"
    A label volume lives in the page until saved. The workspace link names
    it, but it does not reopen on another visit.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
