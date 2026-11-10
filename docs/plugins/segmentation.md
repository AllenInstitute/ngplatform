# Segmentation

![Three segments drawn on SRB 2026a, the tool bar over the views and the segment list](../images/plugins/segmentation.png)

**Kind:** tool · **Off by default** (offered when you open a segmentation, and listed under *Tools for this data* for an image; or turn it on in the Plugins panel) · the **Segmentation** panel in the
Tools dock and a tool bar over the views ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/segmentation)

Label volumes drawn by hand, as in WebKnossos's volume annotation: a new
segmentation layer on an image's grid (or a copy of a segmentation to
edit, or a segmentation of any size edited in place), painted with a brush, fills and quick select, its segments named,
coloured, hidden, merged and deleted, and saved as NIfTI or OME-Zarr. See
[the survey](segmentation-survey.md) for how it compares with WebKnossos.

## A new segmentation layer

In the Segmentation panel, under **New segmentation layer** (shown when no
layer is being edited, or after **New…**):

- **On the grid of**: an image or a segmentation in the scene, and a
  **Level** of it. The new layer has the same voxels and placement.
- On an image's grid (or **Start: Empty** on a segmentation's), the layer
  starts empty; choose **Labels**: 8-bit (segments up to 255), 16-bit (up
  to 65,535) or 32-bit. **Create** makes it.
- On a segmentation's grid, **Start: A copy of its labels** and **Copy and
  edit** copy its labels at that level into the new layer, with the names
  and colours of its lookup table if it has one. The original is hidden and
  not changed. Copies are limited to 512 million voxels; at a level larger
  than that the button becomes **Edit in place** (below). Labels copy
  exactly up to 4,294,967,295 (32 bits; 64-bit labels within that range
  too); a label past 32 bits stops the copy with an error.
- On a segmentation's grid, **Start: Edit it in place** (or a level too
  large to copy) and **Edit in place** edit the segmentation itself, at its
  finest level, without copying it: see below.
- **Open NIfTI…** reads a label image from your computer to edit.
- **Open edits…** opens edits saved earlier (a folder saved with **Save →
  Edits only**) over the segmentation they were made on.

The new layer opens with the tool bar shown and the brush chosen. Each
scene has its own segmentation layers; the panel shows the scene you are in.

With no image or segmentation in the scene, the card says so, with
**Open data…** beside it.

## The tool bar

While a segmentation layer is edited, a tool bar shows at the top of the
2-D views (in a layout with a 3-D view, such as xy-3d, it stays over the
2-D view). Hover a button for its name and key.

| Tool | Key | What it does |
|---|---|---|
| **Move** | ++m++ | The views as usual: drag to move, wheel through sections. ++escape++ comes back here |
| **Brush** | ++b++ | The left button paints the active segment: a disc in the section (or a ball). A ring shows its size |
| **Erase** | ++e++ | Paints 0: any segment, or only the active one |
| **Lasso** | ++l++ | Hold the left button and draw round a structure in a 2-D view: when you let go, the outline closes and its inside is painted with the active segment in that section (as **Paint over** says, and within the image's range when that is on). **Erase** on the bar erases inside it instead |
| **Fill** | ++f++, ++shift+f++ | Fills the region clicked with the active segment: **2-D** in its section (++f++), or **3-D** in a box round the click (++shift+f++) |
| **Pick segment** | ++i++ | The segment clicked becomes the active one |
| **Quick select** | ++q++ | Drag a box round a structure in a 2-D view, or click it. **Threshold** (on the bar): Otsu's threshold inside the box, or values near the one clicked. **AI (MobileSAM)**: a Segment Anything model run in the page; ++shift++ + click or ++alt++ + click marks what is not wanted (see below). The mask shows first, tinted with its outline: ++enter++ (or ✓ on the bar) paints it with the active segment, ++escape++ (or ×) drops it; pressed while it is still being worked out, they apply as soon as it is |

- **Brush size**: ++alt++ + wheel over a 2-D view, ++bracket-left++ and
  ++bracket-right++, or **−** and **+** on the tool bar. The size is in
  voxels by default (in mm or µm in the panel).
- ++w++ and ++shift+w++ step through the tools.
- Hold ++space++ to move the view with the left button while a drawing
  tool is on.
- The tools draw in the 2-D views only; the 3-D view rotates as usual.
- On the right of the bar: the **active segment** (its colour, and a
  search box: type an id or part of a name to list the segments found,
  at most 50 at a time; ++enter++ takes the first, or the id typed) and
  **New segment** (++c++); **Undo** (++ctrl+z++) and
  **Redo** (++ctrl+y++); **Interpolate** (++v++); **Save**; and **×**,
  which hides the bar. **Edit** in the panel shows it again.

**Undo and redo** while the tool bar shows: ++ctrl+z++ undoes whichever
came last, the last stroke or the last change to the workspace (a layer
hidden, the view moved, a segment hidden), so strokes and other changes
undo as one history; ++ctrl+y++ (or ++ctrl+shift+z++) redoes them in the
order they were undone. Hover **Undo** on the bar to see what it will
take back. Merge, Delete, fills, quick select and interpolation are
strokes too. Strokes are the volume's own and are not in the workspace's
history tree (the ⋯ beside redo): going to another branch there changes
the workspace's state and leaves the painted voxels as they are.

**Quick select** shows its mask before painting it, as WebKnossos does:
check it, then ++enter++ paints it and ++escape++ drops it; a new box or
click replaces it, and the active segment can be changed (++c++, or the
list) before ++enter++. **Preview** / **At once** on the bar (or
**Result** in the panel) switches to painting at once, as before; undo
takes a mask painted at once back.

### AI quick select

**AI (MobileSAM)**, chosen on the bar or under **Method** in the panel,
segments with [MobileSAM](https://github.com/ChaoningZhang/MobileSAM), a
small Segment Anything model (Apache-2.0), run in this page with ONNX
Runtime Web.

- **First use**: the model (44.7 MB: an image encoder and a prompt
  decoder, from [Hugging Face](https://huggingface.co/Acly/MobileSAM)) is
  downloaded with a progress bar and kept in this browser; the panel shows
  the size kept and **Forget**, or **Download now** before the first
  prompt. The runtime (ONNX Runtime Web 1.30.0, MIT, 14 MB, or 27 MB with
  WebGPU) comes from jsDelivr.
- **Click** what you want in a 2-D view; ++shift++ + click or ++alt++ +
  click what you do not; each click redraws the mask in that section
  (green and red dots show the clicks). Or **drag a box** round it.
- The first prompt in a region computes the image's embedding ("Computing
  the image's embedding…" on the bar): a few seconds on the CPU, much less
  on a GPU. Further clicks near it take a fraction of a second.
- Half a minute after you leave Quick select (another tool, or editing
  stopped), the model is let go from memory with its embeddings; the next
  prompt loads it again from this browser.
- The model sees the section round the prompt, at least **Context**
  voxels across (256; in the panel), with the image's values as its layer
  shows them (the layer's window).
- **Run on** (in the panel): WebGPU when there is a GPU, else WASM (the
  CPU); the panel shows which, and the last timings.
- ++escape++ drops the clicks and the mask; ++enter++ paints it.

**Spread** (on the bar while a mask shows, or **Spread to sections** in
the panel): the mask is proposed in the next sections each way too, each
section prompted with the box round the mask in the one before; it stops
where nothing is found or the size jumps. ++enter++ paints all the
sections as one stroke, which one undo takes back. It works with
Threshold too.

**Interpolate**: draw the active segment in two sections a few apart (in
the same 2-D view), then press ++v++: each section between gets a shape
between the two drawn. Check the result, as with any interpolation.

While the tool bar shows, the keys above are the tools'. Some are
Neuroglancer's otherwise (++b++ scale bar, ++e++ rotate, ++l++ new segment
colours, ++v++ default
annotations, ++space++ layout, ++escape++, ++alt++ + wheel); hide the tool
bar to have them back.

## Editing a segmentation in place

For a segmentation too large to copy (an OME-Zarr or precomputed
segmentation at a URL, or one opened from your computer, of any size),
**Edit in place** makes a new layer over it in which nothing is copied
first:

- The new layer reads the segmentation's chunks (blocks of 64 × 64 × 64
  voxels) as they are shown, and shows them as they are. When zoomed out it
  shows the segmentation's own coarser levels.
- The first time you change a chunk, it is copied (as the segmentation has
  it) and the copy is changed. Only changed chunks are kept: in the page
  (up to 512 MB), and in this browser's storage a moment after each stroke;
  past 512 MB the oldest are read back from the browser's storage when
  needed. The **Save** card says how many chunks are changed and where they are.
- The original layer is hidden and never written.
- Every tool works. Before a tool paints, it reads the chunks it can reach,
  which can take a moment on a slow connection. A tool reads at most
  256 MB of chunks at once: a 2-D fill stays in a square about 1,000
  voxels wide round the click at 32 bits (2,000 at 8 bits), a 3-D fill as far as its
  **Reach** within that; a fill that stops at that edge says so, and you
  can fill again from beyond it. A lasso or quick select box larger than
  that is refused with a message.
- Undo and redo work as usual; undoing the first change to a chunk makes it
  the segmentation's again.
- The segment list counts voxels in the changed chunks only. **+ New
  segment** gives one more than the largest label seen so far (in the
  changed chunks and those read); **Delete** and **Merge** act on the
  changed chunks. Hiding a segment hides the segmentation's other segments
  too (those not in the list).

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
- A long list (a copied segmentation can have 100,000 segments) draws only
  the rows in view as it scrolls. A layer opened with more than 1,000
  segments keeps Neuroglancer's own colours for them, not one each in the
  link; past 1,000 segments, those hidden are kept by the plugin (in the
  link, as a short list) rather than the layer listing every other one.
  Neuroglancer's own Segments tab then does not show which are hidden.

**Groups**, as in WebKnossos's segment list:

- **+ New group** makes an empty group (*Group 1*, …); type in its name to
  rename it.
- Drag a segment's row onto a group to put it there (onto *No group* to
  take it out), or choose the active segment's group under the list. A
  segment is in one group at most.
- The group's eye hides or shows all its segments; its colour square gives
  them all that colour; ▾ folds its rows away; the bin deletes the group
  (its segments stay, in no group).
- Groups belong to the scene, are kept in the link, and can be undone like
  other changes. A saved OME-Zarr keeps each segment's group, with its
  name and colour; a NIfTI file has no place for them.

## Tool settings and image values

Under **Tool**, the active tool's settings: the brush's radius, unit and
shape and whether it **paints over** other segments or only empty voxels;
what a fill follows (the segment clicked, or a range of the image's
values) and a 3-D fill's reach; whether the lasso paints or erases
inside, and over what; quick select's method, tolerance, result
(preview first, or paint at once) and what it paints over.

**Image values**: the image whose values limit the tools (by default the
one the grid came from), a **range**, and whether the brush, eraser and
lasso keep to it. **Range from the cursor** sets it round the value under the pointer.

## Saving

The **Save** card, near the end of the panel, saves to your computer; so do
the tool bar's save button and the command *Save the label volume*. Its title shows how many
changes are not saved yet. Choose the **Format**: NIfTI (.nii.gz, marked
as labels) or an OME-Zarr folder (in a zip where the browser cannot write
folders). **Only the painted box** saves the box round what is painted,
placed where it was. OME-Zarr writes only the painted chunks, so it suits
large grids, and carries the segments' names and colours; NIfTI holds
every voxel.

Saves are compressed off the page's main thread and written as they are
made: a NIfTI a few sections at a time straight into its file, an
OME-Zarr folder a chunk at a time, so a large volume is never held whole
twice and the page stays responsive. (A zip, where the browser cannot
write folders, and a NIfTI downloaded rather than written into a file
chosen, are built in memory, compressed.)

While it saves, the panel's status line shows how far it has got. A save
done is said in a message and in Activity. A save that fails says why in
the status line, with **Save again**, opens the Save card, and is also
said in a message and in Activity (so a save from the tool bar with
the panel hidden is not missed).

A segmentation edited in place saves as OME-Zarr in one of two ways:

- **Edits only**: the changed chunks, on the segmentation's grid and
  levels, and a note of where the segmentation is (its URL). It is small.
  **Open edits…** (under **New…**) opens it over the segmentation again;
  if the segmentation is no longer at that URL (or has changed size), it
  says so. On its own, the folder shows the changed chunks and nothing
  else.
- **The whole volume**: every chunk, the segmentation's copied a block at
  a time and the changed ones as changed, written into a folder you
  choose, as a job (in Activity, where it can be cancelled). Edits made
while it runs may or may not be in it. It can take long
  for a large segmentation, and needs a browser that can write folders
  (Chrome, Edge).

## Kept in this browser

While you draw, a segmentation layer is also kept in this browser, a
moment after each stroke and at once when the page is hidden or closed
(another tab, the window minimised), so a reload brings it back into its
layer. The first time something is kept, the app asks the browser to keep
it for good rather than clear it when short of space; if the browser
refuses, a message says so.

Removing a segmentation layer in Neuroglancer's layer list closes its
volume once it is kept, to free the memory it held (a large volume and its
undo history can take a gigabyte); Activity says so. Undo brings the layer
back from the copy kept here. If the browser could not keep it (its
storage full), the volume stays open and Activity says that instead.

One whose page was closed, or whose layer was removed, is listed in the
**Kept in this browser** card,
with its size and how long ago it was kept; its title shows the total.
**Open** opens it again as a new layer; **Remove…** (or **Remove all…**)
deletes it from the browser, after asking. Under the list: how much this
site holds in the browser's storage and how much it may.

!!! warning "Save before you leave"
    A copy kept in this browser is not a save: the browser may clear it,
    and the link does not carry it to another computer. **Close** forgets
    it. A segmentation edited in place is kept the same way (its changed
    chunks, and where the segmentation is).

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
