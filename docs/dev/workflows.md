# Workflows: ten tasks, counted

Ten common tasks, each done in headless Chrome the way a user would do it,
every interaction counted; then quicker paths built for the worst ones, and
the same tasks counted again (November 2026, TODO D4).

## How it was counted

Each task is a script (Playwright, on a fresh browser profile with only
Zarr Vectors on, as a new user has it) that clicks, types and presses keys
through a small harness that counts each one:

- **click**: a button, a menu item, a tab, a click or Ctrl+click in a view;
- **key**: a key or shortcut (Alt+F, Ctrl+V);
- **type**: a field typed into (with its Enter);
- **choose**: a drop-down list picked;
- **drag**: a brush stroke or other drag;
- **drop**: files dropped on the window;
- **dialog**: the system's save dialog, where the page asks for one (a
  plain download asks nothing in Chrome by default and is not counted);
- **scroll**: a control below its panel's fold, scrolled to first.

Waiting is not counted. Where the task needs something the screen does
not say, it is noted as *must know*. Test data: a small synthetic T1
(64³, NIfTI), a moved copy of it, a 4-D NIfTI (20 time points), the
`ras.trk` tractogram from `plugins/zarr-vectors/testdata`, a public
two-channel OME-Zarr (IDR `6001240`), and the same T1 as a local
OME-Zarr. The scripts are kept in the session's scratchpad (`d4/flows`).

## Before and after

| # | Task | Before | After | Must know, before |
|---|---|---:|---:|---|
| 1 | Open a local `.trk`, keep the streamlines through two spheres, save a `.trk` | 11 | **8** | A region starts at the views' centre: right-click the place first |
| 2 | Open a two-channel OME-Zarr by URL, set each channel's contrast to 1–99 % | 10 | **5** | — |
| 3 | Copy a link to the current view | 2 | 2 | — |
| 4 | On an image, mark three points and save them as CSV | 10 | **7** | Annotations is offered only once an annotation layer exists; a new layer's Point tool is on, and picking it turns it off |
| 5 | On an image, paint a label and save it as NIfTI | 9 | **7** | Segmentation is offered only for a segmentation: turn it on in the Plugins tab |
| 6 | Two images: three landmark pairs, save the transform (LTA) | 10 | **9** | — |
| 7 | A 4-D image: pin two voxels' time courses, save the CSV | 5 | 5 | — |
| 8 | Draw a tractogram the Luxar way | 3 | 3 | — |
| 9 | Smooth an image and threshold it into a mask (a view) | 4 | 4 | — |
| 10 | Compare two looks of an image: a copy of the scene with another colour map, switch between them | 7 | 7 | Duplicate is in the scene tab's right-click menu |
| | **All ten** | **71** | **57** | 5 things to know → 1 (task 10) |

## Each task

### 1. Streamlines through two regions, saved as `.trk`

**Before (11):** drop `ras.trk` · *Turn on* (Track filtering's offer) ·
**+ New group** · right-click region A (moves the views' centre there) ·
**+ Sphere** · type the radius · right-click region B · **+ Sphere** · type
the radius · **Save .trk** · save dialog.

**After (8):** drop `ras.trk` · *Turn on* · point at region A and press
++alt+shift+s++ (a sphere at the mouse; the first makes the group) · type
the radius · ++alt+shift+s++ over region B · type the radius · **Save
.trk** · save dialog.

**What changed.** ++alt+shift+s++ and ++alt+shift+b++ put a sphere or a
box at the mouse (at the views' centre when the mouse is elsewhere), in
the group being edited or a new one, and show the Filtering tab. The
empty group list says so, and offers **+ Sphere** and **+ Box** itself
(a region makes the group). Building this found a bug: a layer added
while the mouse was over a view (the group's layer, from the key) threw
in Neuroglancer's reading of the values under the mouse, which reached a
layer still being made, and the state restore failed. The values are now
read from the layers that are made, leaving out one still being made
(`src/engine/selected_values.ts`). (The
group's count differs, 2 against 1 streamline, because a right-click
snaps the position to a voxel centre and the key uses the mouse's exact
point.)

### 2. A remote OME-Zarr, contrast 1–99 %

**Before (10):** **Add** · *Dataset from a URL…* · paste into Source ·
**Add** · Render tab · scroll to the contrast control · **1-99%** · the
Dapi channel · Render tab again (the other channel opened on Source) ·
**1-99%**.

**After (5):** ++ctrl+v++ on the window · Render tab · **1-99%** · the
Dapi channel · **1-99%**.

**What changed.**

- A data URL pasted on the window (not in a text field) is added to the
  scene at once when it plainly is one (a format prefix, a bucket, or a
  path ending in `.zarr`, `.n5`, `.nii.gz`, `.trk` and the like); another
  web address is asked about first; a pasted Neuroglancer link or state
  asks whether to open it (it replaces the workspace) or open it as a new
  scene (`pasteAction` in `src/core/state_io.ts`). The start card over
  an empty scene says so ("Or drop files here").
- The Display tab (once Render) shows the shader's controls (contrast, colour) above the
  shader's code, so the contrast is in view without scrolling.
- Picking another view of a dataset in the Layers tab's header keeps the
  tab you are on.
- A bug: until the histogram and the colour bar first draw, their
  canvases keep the default 300 × 150 size and lay over the **Min-Max**,
  **1-99%** and **5-95%** buttons, so a click on them set the range by
  the histogram instead (seen in headless Chrome, where the histogram
  does not draw). They are clipped to their panels now.

### 3. Copy a link

**2, unchanged:** **Share** · *Copy workspace link*. The address bar
holds the same link at all times. A key was considered and left out:
every Ctrl+Shift+letter is one of Neuroglancer's tool keys, and browsers
take several of the others.

### 4. Three points on an image, saved as CSV

**Before (10):** drop the image · **Add** · *New annotation layer* (the
only way to get Annotations offered) · *Turn on* · **Point** (as the hint
says; it was already on, so this turns it off) · **Point** again · three
Ctrl+clicks · **Save CSV**.

**After (7):** drop the image · **Annotations** under *Tools for this
data* · **Point** (with no layer yet, it makes one) · three Ctrl+clicks ·
**Save CSV** (the table opens with the first point).

**What changed.** Annotations and Segmentation are listed under *Tools
for this data* for any image, in the Layers tab only (no toast: a use
worth offering, not pressing). Offers can now say "list only"
(`plugins/offers.ts`). The tool that is on is highlighted and named under
the tools: "Point is on: Ctrl+click a point in a view. Pick it again to
stop."

### 5. Paint a label on an image, saved as NIfTI

**Before (9):** drop the image · Plugins tab · scroll to Segmentation ·
its switch · **Create** · two brush strokes · **Save** · save dialog.

**After (7):** drop the image · **Segmentation** under *Tools for this
data* · **Create** · two strokes · **Save** · save dialog.

### 6. Landmark registration, transform saved

**Before (10):** drop both images · **Registration** under *Tools for this
data* · choose the moving layer · ++alt+f++ / ++alt+m++ three times (six
keys) · **Save transform**.

**After (9):** the same without choosing the moving layer: until one is
chosen it is the image added last (with two images or more), and the
first change made keeps it chosen, so a layer added later does not take
its place. The transform and image formats chosen for saving are
remembered in this browser.

### 7. Time courses (5, unchanged)

Drop the 4-D image · *Turn on* (Time series' offer; its tab opens) ·
++alt+p++ over one voxel · ++alt+p++ over another · **Save CSV**. Nothing
to cut.

### 8. Luxar (3, unchanged)

Drop the `.trk` · **Luxar rendering** under *Tools for this data* (its tab
opens) · tick the layer.

### 9. Filter an image (4, unchanged)

**Filters** under *Tools for this data* · **Add step** · choose
*Threshold* · **Add filtered view** (Gaussian is the first step by
default, threshold 100). Two gaps found here were fixed in E1: a local
NIfTI could not be filtered (its virtual store listed the axes x, y, z,
and chunkmirage asks for z, y, x), so this task used an OME-Zarr; and a
filtered view could not be saved as a file (Export now saves it).

### 10. Compare two scenes (7, unchanged)

Drop the image · right-click the scene tab · *Duplicate* · Render tab ·
*Colour map: Viridis* · Scene 1 tab · Scene 2 tab.

## Left, with estimates

| Idea | Task | Hours |
|---|---|---:|
| Luxar turned on from its offer draws the scene's one Zarr Vectors layer at once | 8 | 1 |
| Contrast 1–99 % for every channel of a dataset at once (the dataset's ⋯ menu) | 2 | 2 |
| Two scenes side by side, positions linked, for comparing | 10 | 6 |
| **+** beside the scene tabs: a menu with *Empty* and *Copy of this scene* | 10 | 0.5 |
| Landmarks by clicking: a mode where clicks alternate fixed and moving points | 6 | 2 |
| Track filtering: a region's radius by Alt+wheel over it | 1 | 2 |
| A key for *Copy workspace link* that clashes with neither Neuroglancer nor browsers | 3 | 0.5 |
| Count a job on the local runner (needs the runner started in the test) | — | 1 |
