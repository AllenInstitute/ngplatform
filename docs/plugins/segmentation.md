# Segmentation

![Three segments drawn on SRB 2026a, the tool bar over the views and the segment list](../images/plugins/segmentation.png)

**Kind:** tool · **On by default** · the **Segmentation** tab and a tool
bar over the views ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/segmentation)

Label volumes drawn by hand, as in WebKnossos's volume annotation: a new
segmentation layer on an image's grid (or a copy of a segmentation to
edit), painted with a brush, fills and quick select, its segments named,
coloured, hidden, merged and deleted, and saved as NIfTI or OME-Zarr. (It
was the last section of the Annotations tab.) See
[the survey](segmentation-survey.md) for how it compares with WebKnossos.

## A new segmentation layer

In the Segmentation tab, under **New segmentation layer**:

- **On the grid of**: an image or a segmentation in the scene, and a
  **Level** of it. The new layer has the same voxels and placement.
- On an image's grid (or **Start: Empty** on a segmentation's), the layer
  starts empty; choose **Labels**: 8-bit (segments up to 255), 16-bit (up
  to 65,535) or 32-bit. **Create** makes it.
- On a segmentation's grid, **Start: A copy of its labels** and **Copy and
  edit** copy its labels at that level into the new layer, with the names
  and colours of its lookup table if it has one. The original is hidden and
  not changed. Copies are limited to 512 million voxels: choose a coarser
  level for a larger segmentation.
- **Open NIfTI…** reads a label image from your computer to edit.

The new layer opens with the tool bar shown and the brush chosen. Each
scene has its own segmentation layers; the tab shows the scene you are in.

## The tool bar

While a segmentation layer is edited, a tool bar shows at the top of the
2-D views (in a layout with a 3-D view, such as xy-3d, it stays over the
2-D view). Hover a button for its name and key.

| Tool | Key | What it does |
|---|---|---|
| **Move** | ++m++ | The views as usual: drag to move, wheel through sections. ++escape++ comes back here |
| **Brush** | ++b++ | The left button paints the active segment: a disc in the section (or a ball). A ring shows its size |
| **Erase** | ++e++ | Paints 0: any segment, or only the active one |
| **Fill** | ++f++, ++shift+f++ | Fills the region clicked with the active segment: **2-D** in its section (++f++), or **3-D** in a box round the click (++shift+f++) |
| **Pick segment** | ++i++ | The segment clicked becomes the active one |
| **Quick select** | ++q++ | Drag a box round a structure in a 2-D view (Otsu's threshold inside it), or click it (values near the one clicked) |

- **Brush size**: ++alt++ + wheel over a 2-D view, ++bracket-left++ and
  ++bracket-right++, or **−** and **+** on the tool bar. The size is in
  voxels by default (in mm or µm in the tab).
- ++w++ and ++shift+w++ step through the tools.
- Hold ++space++ to move the view with the left button while a drawing
  tool is on.
- The tools draw in the 2-D views only; the 3-D view rotates as usual.
- On the right of the bar: the **active segment** (its colour, a list of
  the others) and **New segment** (++c++); **Undo** (++ctrl+z++) and
  **Redo** (++ctrl+y++); **Interpolate** (++v++); **Save**; and **×**,
  which hides the bar. **Edit** in the tab shows it again.

**Undo and redo** while the tool bar shows: ++ctrl+z++ undoes whichever
came last, the last stroke or the last change to the workspace (a layer
hidden, the view moved, a segment hidden), so strokes and other changes
undo as one history; ++ctrl+y++ (or ++ctrl+shift+z++) redoes them in the
order they were undone. Hover **Undo** on the bar to see what it will
take back. Merge, Delete, fills, quick select and interpolation are
strokes too.

**Interpolate**: draw the active segment in two sections a few apart (in
the same 2-D view), then press ++v++: each section between gets a shape
between the two drawn. Check the result, as with any interpolation.

While the tool bar shows, the keys above are the tools'. Some are
Neuroglancer's otherwise (++b++ scale bar, ++e++ rotate, ++v++ default
annotations, ++space++ layout, ++escape++, ++alt++ + wheel); hide the tool
bar to have them back.

## Segments

The **Segments** list shows each segment of the layer: whether it shows
(the eye), its colour, id, name and voxels (hover for the volume). The
active segment, the one the tools paint, is marked; its name can be typed
in its row.

- Click a row to paint with that segment; **+ New segment** (++c++) makes
  one with the next id (one more than the largest used).
- The colour square changes its colour.
- **Go to** moves the views to the segment (its voxel nearest its centre).
- **Merge** gives a segment's voxels to the active segment; **Delete**
  erases them. Both can be undone.

## Tool settings and image values

Under **Tool**, the active tool's settings: the brush's radius, unit and
shape and whether it **paints over** other segments or only empty voxels;
what a fill follows (the segment clicked, or a range of the image's
values) and a 3-D fill's reach; quick select's method and tolerance.

**Image values**: the image whose values limit the tools (by default the
one the grid came from), a **range**, and whether the brush and eraser keep
to it. **Range from the cursor** sets it round the value under the pointer.

## Saving

**Save** is at the top of the tab (and on the tool bar): NIfTI (.nii.gz,
marked as labels) or an OME-Zarr folder (in a zip where the browser cannot
write folders). **Only the painted box** saves the box round what is
painted, placed where it was. OME-Zarr writes only the painted chunks, so
it suits large grids, and carries the segments' names and colours; NIfTI
holds every voxel.

!!! warning "Save before you leave"
    A segmentation layer drawn here lives in the page until saved. While you
    draw it is also kept in this browser, so a reload brings it back into
    its layer, and one whose page was closed is offered again under **New…**
    (*Kept in this browser*: Open or Discard). That copy is not a save: the
    browser may clear it, and the link does not carry it to another
    computer. **Close** forgets it.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
