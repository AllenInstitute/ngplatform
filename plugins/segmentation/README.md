# Segmentation

![Three segments drawn on SRB 2026a, the tool bar over the views and the segment list](../../docs/images/plugins/segmentation.png)

Label volumes drawn by hand, as WebKnossos's volume annotation: a tab of
their own (**Segmentation**) and a tool bar over the views. It was the last
section of the Annotations tab; the code moved here whole (the files keep
their history) and that section was taken out of Annotations.

- **A new segmentation layer**: an empty label volume on the grid of an
  image or a segmentation, at one of its levels (the same voxels and
  placement); or a copy of a segmentation's labels at a level, to edit (the
  original is hidden, not changed); or a NIfTI label image opened from this
  computer.
- **The tool bar** over the 2-D views while a volume is edited (centred
  over the top row of 2-D views, so it never covers the 3-D view): Move (the
  views as Neuroglancer moves them; the default), Brush, Erase, Lasso, Fill
  (2-D or 3-D), Pick segment and Quick select (by threshold, or by
  MobileSAM, a Segment Anything model run in the page); the brush's size; the active
  segment and New segment; Undo, Redo, Interpolate, Save; and a button that
  hides it.
- **The segment list**: each segment's colour, name, voxels (and volume, on
  hover) and visibility; the active one marked; Go to, Merge into the
  active segment, Delete. **Segment groups**: named groups (made, renamed,
  coloured, folded, deleted), segments put in one by dragging or by the
  active segment's **Group**, a whole group hidden or shown.
- **Save** as NIfTI or OME-Zarr (only painted chunks written), the whole
  grid or the painted box; at the top of the tab and on the tool bar.
- Each scene shows its own label volumes: the tab and the tool bar follow
  the scene shown.

See the [user page](../../docs/plugins/segmentation.md) and
[the survey](../../docs/plugins/segmentation-survey.md) for how it compares
with WebKnossos.

| File | What |
|---|---|
| `manifest.ts` | The tab, commands, keys (while a volume is edited), context keys |
| `plugin.ts` | Activation: the editor, the tab, the tool bar |
| `editor.ts` | The volumes open and the current one; tools, drawing, segments, new layers (empty, copied, opened), save |
| `panel.ts` | The tab |
| `toolbar.ts`, `icons.ts` | The tool bar over the views, its icons |
| `tools.ts` | The tools, cycling through them, the brush's size steps (pure) |
| `segments.ts` | The segment list's rows, new ids, which segments a layer shows (pure) |
| `segment_groups.ts` | Segment groups: made, renamed, coloured, folded, removed, segments assigned, the list in sections (pure) |
| `painter.ts` | The mouse in the 2-D views: drawing, the brush ring, Alt+wheel, the quick-select box, the lasso's outline |
| `label_volume.ts` | The label volume held in the page: chunks, counts by chunk, a segment's centre, its pyramid, the OME-Zarr store it answers |
| `store_format.ts` | Serving those stores to Neuroglancer through local data (loaded with the catalogue) |
| `session.ts` | A volume being drawn: its layer, history, colours, the image that limits the tools |
| `kernels.ts`, `history.ts` | Brush, fills and their limits, the lasso's inside (`polygonRuns`, `fillOutline`), interpolation between sections (signed distances); strokes, undo and redo (pure) |
| `quick_select.ts` | The quick select interface, the threshold method, the registry other plugins add to |
| `sam.ts` | Around the model (pure): the crop round a prompt, the layer's window, the model's image, prompt coordinates, the mask back on the grid, the parts kept, masks of several sections put together |
| `sam_model.ts` | The AI (MobileSAM) method: the model's files (pinned URLs, size, licence), kept in the browser, the worker it runs in, the embeddings kept by section |
| `sam_worker.ts` | ONNX Runtime Web (loaded from jsDelivr at 1.30.0), WebGPU or WASM; the downloads and Cache Storage; the encoder and the decoder |
| `preview.ts` | Quick select's proposed mask over the 2-D views (its sections, tinted with an outline), until Enter or Escape |
| `save.ts` | NIfTI and OME-Zarr out, the painted box |
| `keep.ts` | Volumes kept in the browser (OPFS) while drawn, brought back after a reload |
| `style.ts` | The tab's and the tool bar's styles |
| `tests/` | `npm test` runs them |

It reads images through Annotations' worker (`../annotations/voxels.ts`, a
`Voxels` of its own) and uses Annotations' geometry and form helpers
(`geometry.ts`, `scene.ts`, `ui.ts`, `style.ts`); Annotations' Statistics
reads the volumes drawn here through the `segmentation.labelVolumes`
service.

## The tools and Neuroglancer

The lasso keeps the points of its outline in the voxels of the section it
started in (the voxel axis nearest the view's normal, at the position
there), a quarter voxel apart or more, while the painter draws the outline
on the screen. When the button is let go the outline closes back to its
start and `fillOutline` paints the voxels whose centres are inside it (the
even-odd rule, row by row), as one stroke: the active segment over what
**Paint over** allows, or (Erase) 0 over what **Erase** allows; with
**Brush, eraser and lasso only within the range** on, only where the
image's values (read for the outline's box in that section) are in range.

Quick select shows its mask before painting it (the tab's **Result**, or
**Preview** / **At once** on the bar, chooses): the mask waits in the
editor (`pending`), `preview.ts` draws its sections over the 2-D views on
a canvas (each view the section along the voxel axis nearest its normal,
at its position; a pixel a voxel, placed by the screen's affine map of the
section's voxels from the view's projection, so it follows panning, zoom
and rotation), and the context key `segmentation.previewing` gives
`Enter` (paint it with the active segment, as **Paint over** says) and
`Escape` (drop it) to the editor. A new prompt replaces it; another tool,
another volume or hiding the bar drops it.

A method that `refines` (the model) keeps the prompts given in a section
(`quickPrompts`: a box, and clicks wanted or not, Shift or Alt marking
the latter) and is handed them all with each click, so each click redraws
the mask; the clicks are drawn over the views as dots (green +, red −) by
`preview.ts`. Accepting, dropping, a box, or a click in another section
starts again. **Spread** (`spread`) takes a mask proposed in one section
and runs the method chosen in the next sections each way, each with the
box round the mask before it (a tenth larger each side) as its prompt,
stopping where the mask is empty or changes size more than four times; the
masks are put together (`stackMasks`) and proposed as one, so Enter paints
them as one stroke and one undo takes them back. It works with any
method that takes boxes (Threshold too).

The editor keeps the tool and whether a volume is edited; `Painter`
(`painter.ts`) takes the mouse in the 2-D views while a tool that draws is
on, and gives everything else to Neuroglancer:

| Neuroglancer's | While a drawing tool is on |
|---|---|
| Left drag in a 2-D view (move the view) | Draws. Hold **Space** to move the view; Move (`M`, `Escape`) gives it back |
| Space (change the layout) | Held back (Space moves the view instead) |
| Shift+left drag in a 2-D view (rotate) | Draws |
| Double-click (select a segment), the click after a stroke | Held back in the 2-D views |
| Alt+wheel (depth of annotations shown) | Brush size, over a 2-D view with Brush or Erase |
| Wheel, Shift+wheel (sections), Ctrl+wheel (zoom), Ctrl+click (annotate), right button (move to the point) | Unchanged |
| The 3-D view | Unchanged: tools draw in the 2-D views only |

While a volume is edited (the tool bar shows), these keys are the tools'
rather than Neuroglancer's or the workspace's: `B` (Neuroglancer: scale
bar), `E` (rotate), `L` (new colours for segments), `V` (default
annotations), `F`, `I`, `M`, `Q`, `W`,
`C`, `Ctrl+Z` and `Ctrl+Y` (the workspace's undo and redo; here the
last stroke or the last workspace change, whichever came last, see
below); `[` and `]`
(time steps) with Brush or Erase; `Escape` (Neuroglancer's tool) with a
drawing tool; `Enter` and `Escape` while quick select's mask waits. Hiding the tool bar (its ×, or **Editing** in the tab) gives
them back.

Strokes have an undo of their own (`history.ts`, chunk copies within a
memory budget), beside the workspace's (state snapshots). While the tool
bar shows, `Ctrl+Z` undoes whichever came last: each stroke is timed when
kept, and `workspace.undoSteps()` says when the workspace's change undo
would take back was made (`chooseUndo`). `Ctrl+Y` redoes whichever of the
two undone came first, so they redo in the order they were undone. The
quiet changes a stroke makes to the layer (its segment's colour, its
visibility) amend the workspace's current step, not a new one; a change of
the user's still settling when a stroke ends is recorded before the stroke
is timed.

A segment's visibility is Neuroglancer's own list of visible segments
(`segments`, with `!id` for one listed but hidden): with nothing hidden the
list is empty and every segment shows; hiding one lists the others and sets
`ignoreNullVisibleSet` to false, so a segment painted later is added as it
is painted.

## Segment groups

A volume's groups are kept in the plugin's slice of the workspace state
(`appState` key `segmentation`): `{ groups: { [volume id]: { groups:
[{ id, name, colour, collapsed? }], of: { [segment]: group id } } } }`,
by the volume's id (`Session.id`, which a volume kept in the browser keeps
through a reload). The slice is per scene, so each scene has its own
groups; it is in the link, and each edit is a workspace undo step (so
`Ctrl+Z` with the tool bar showing undoes it in turn with strokes). A
segment is in one group at most. Hiding a group sets each of its segments
hidden in Neuroglancer's list of visible segments, as one change; a
group's colour is given to each of its segments (their own colours, which
can then be changed one by one). Deleting or merging away a segment takes
it out of its group. A saved OME-Zarr keeps each segment's group as a
property of its label (`image-label` → `properties`, `group`); NIfTI has no
place for it.

## How a label volume reaches Neuroglancer

The volume is held in the page in 64³ chunks, made only where something is
painted (a mask on a whole-brain grid costs what is drawn on it). It answers
as an OME-Zarr store: Zarr v3, raw little-endian chunks, a pyramid whose
coarser levels are made from the level below when asked for (a coarse voxel
takes the first label of the eight under it, so thin strokes still show;
it is placed at their centre, so a stroke one section thick shows in that
section when zoomed out) and kept until a stroke changes them.

Neuroglancer reads it as it reads a file on this computer:

1. The catalogue entry (`plugins/index.ts`) declares a virtual format,
   `*.ngplabels`, whose "worker" is an object in the page
   (`store_format.ts`). Local data hands it every key under such a file.
2. A new volume registers itself under a unique file name and opens an
   empty file of that name with `workspace.local.open`; the dataset's
   source is `zarr3://<app>/local/<id>/<name>.ngplabels/`.
3. After each stroke (a few times a second while it lasts, once when it
   ends) the plugin calls `viewer.reloadData(url)`: Neuroglancer drops
   every chunk it holds from the store and asks for those on screen again,
   which the page answers from memory at once. Metadata is kept.

Painting runs in the page; a dab limited to an image's range first reads
the image's values on the label grid (chunk-sized blocks, cached) from the
worker, so a stroke's dabs are queued in order and keep the settings they
started with. Segment counts are kept per chunk and counted again only for
the chunks a stroke changed.

In a 2-D view the point under the pointer is found from the view's own
projection (`ViewPanelInfo.project`, inverted near the position, so it is
exact and immediate at any zoom); its depth gradient gives the section's
normal in the volume's voxels, so a disc brush and a 2-D fill take the
section shown.

### A copy of a segmentation

**Copy and edit** reads a level of a segmentation layer (anything the volume
view's reader reads: OME-Zarr, NIfTI, MGH, precomputed) into a new label
volume, in blocks of 256 × 256 × 64 voxels as a job that can be cancelled,
up to 512 M voxels; chunks with no label are not made. The type follows the
source's (8 and 16 bits as they are, anything else 32). Labels are read
exactly (`Voxels.labels`: the reader's `exactRegion`, 64-bit floats, which
hold every 32-bit label), so labels above 2²⁴ copy as they are; 64-bit
labels (uint64, int64, precomputed) are narrowed to 32 bits as the volume
view's reader does (`narrow`), and one past 32 bits, or a negative or
fractional value, stops the copy with an error. Names and colours come from the source's lookup table when it has
one, otherwise from its layer's segment colours. The source is hidden and
not changed. Editing a large segmentation in place (copy-on-write over the
source) is not done: see *Large data*.

### Kept in the browser

While a volume is drawn, its painted chunks and description are written to
the browser's origin private file system (`keep.ts`), a moment after
strokes stop. The store's file is opened as a *derived* local file, so its
layer is a dataset known by its name rather than by the visit's URL: after
a reload, a layer whose volume is not in the page is pointed at the kept
copy (served under a new URL) in place, and the workspace keeps one
dataset. Volumes kept but not in the scene are offered under **New**.
**Close** forgets the copy.

### Large data

Today's limits: a label volume costs 256 KB (8-bit) to 1 MB (32-bit) per
painted chunk; undo keeps up to 512 MB of chunk copies; a fill stops at
64 M voxels; a copy or an opened NIfTI is at most 512 M voxels; NIfTI saves
are capped at 2 GB, so for a large grid save the painted box or as OME-Zarr
(painted chunks only).

The plan for data too large for the page is a **sparse edit layer over the
source**: strokes kept as chunks of a Zarr array on the source's grid
(absent chunks meaning "no edit"), written to a folder on this computer as
they are made (with `workspace.local.write`), shown over the source as they
are now, and merged with it (an existing segmentation, or nothing) only on
export, at the resolution asked for. The store and its pyramid already work
chunk by chunk, so the change is where the chunks live, not how they are
drawn.

## What it uses from the platform

`ui.overlay()` (the tool bar, the brush ring, quick select's preview), `viewer.panels()`,
`viewer.onRendered()`, `viewer.cursor()`, `viewer.layerTransform()`,
`viewer.patchState()`, `viewer.setPosition()`, `viewer.lookupTables`,
`viewer.reloadData(url)`, `state` (segment groups), `workspace.local.open/close`,
`workspace.undoSteps()`, `commands.invoke` (`edit.undo`, `edit.redo`), `services`
(`segmentation.quickSelect` and `segmentation.labelVolumes`, which it
provides), `context` (`segmentation.editing`, `segmentation.drawing`,
`segmentation.brushing`, `segmentation.previewing`), `jobs`.

`viewer.reloadData(url)` (`src/sdk/types.ts`, `src/ui/apis.ts`) has
Neuroglancer invalidate every chunk source in its chunk manager whose key
names the URL (each held for two seconds, so the worker's answer never
finds it let go). A finer reload would re-read only the chunks a stroke
changed (today every chunk of the store on screen is read again; from
memory, so it is quick, but a large view flickers for a frame); that needs
a per-chunk invalidation in Neuroglancer's chunk worker, which the fork
does not have yet.

It also uses the volume view's reader (`../volume-view/volume_reader.ts`)
and Registration's writers (`../registration/volume_io.ts`).

## AI quick select (MobileSAM)

**AI (MobileSAM)** is a quick select method registered by the editor
beside Threshold. MobileSAM (Zhang et al. 2023,
[github.com/ChaoningZhang/MobileSAM](https://github.com/ChaoningZhang/MobileSAM),
Apache-2.0) is Segment Anything with a small image encoder (TinyViT, 5.8 M
parameters) in place of SAM's ViT-H, and SAM's own prompt decoder. The
ONNX files are the ones published at
[huggingface.co/Acly/MobileSAM](https://huggingface.co/Acly/MobileSAM)
(an export of those weights; the repository's card says MIT, the weights
are MobileSAM's, Apache-2.0), fetched from a pinned commit:
`mobile_sam_image_encoder.onnx` (28.2 MB; it takes an image of height ×
width × 3 values 0 … 255, its longest side 1024, and normalises and pads
it itself) and `sam_mask_decoder_single.onnx` (16.5 MB; SAM's ONNX
decoder, one mask). Nothing is converted in our build and no weights are
in the repository. Other models looked at: EfficientSAM-Ti (Apache-2.0;
its repository publishes an ONNX encoder, 24.8 MB, and decoder, 16.6 MB,
with a decoder interface of its own), SAM 2.1 tiny (Apache-2.0; ONNX
exports on Hugging Face, but its encoder is 134 MB in 32 bits, 28.5 MB
only at 4 bits), SlimSAM (Apache-2.0; 23.3 + 16.6 MB). MobileSAM was
chosen for SAM's standard ONNX decoder (the inputs SAM's own browser
demo uses) and a small encoder.

The first prompt downloads the two files (44.7 MB) with a progress bar
(the tab and the tool bar) and keeps them in the browser's Cache Storage
(`ngplatform-models`, under their URLs); later visits read them from
there. The tab shows the size kept and **Forget** (deletes them).

The runtime is ONNX Runtime Web 1.30.0, the version chunkmirage's ONNX
stage is built against (`vendor/chunkmirage/web/package.json`); it is not
installed here, so the worker imports it from jsDelivr at that pinned
version when the method first runs (as the Python console loads Pyodide),
and points its `wasmPaths` there too. With a GPU adapter (and **Run on**
left at Auto or set to WebGPU) it loads the WebGPU build
(`ort.webgpu.bundle.min.mjs` and its 27 MB runtime) and builds the
sessions on WebGPU, falling back to WASM if they fail; otherwise the WASM
build (14 MB runtime), with threads when the page is cross-origin
isolated, else one. Calls into the runtime are made one at a time in the
worker, as chunkmirage's `exclusive` does (`vendor/chunkmirage/web/src/onnx.ts`:
its WebGPU build allows one suspended call at a time); its session code
could not be imported as it is, since it imports `onnxruntime-web` as a
package.

A prompt, in a 2-D view (`SamModel.segment`):

1. **The crop** (`cropFor`): a square of the section round the prompt, on
   the label grid, at least **Context** voxels across (256 by default; in
   the tab) and 1.5 times a box's longest side, square in millimetres,
   moved inside the volume where it fits (where it does not, the image
   outside reads as 0).
2. **The image** (`modelImage`): the crop read with `session.imageBox`
   (the reference image's values on the label grid), mapped through the
   layer's window (its `normalized` control's range, set or in its
   shader; else the crop's 0.5 and 99.5 % quantiles) to 0 … 255,
   resampled bilinearly to 1024 × 1024, three equal channels.
3. **The embedding**: the encoder, once per crop; kept in the worker (the
   last 12, about 4 MB each) under a key of the image (store, level,
   placement), section, crop and window. A later prompt in the same
   section whose extent sits in the middle 80 % of a kept crop (not more
   than twice the size a fresh crop would be) uses it: the decoder alone
   runs.
4. **The prompt** (`promptTensors`): clicks as points labelled 1 (wanted)
   or 0 (not), a box as two corners labelled 2 and 3, in the model's
   pixels (`pointToModel`: a voxel's centre, less SAM's half pixel;
   `boxToModel`: the box's edges); without a box a padding point labelled
   -1, as SAM's decoder expects.
5. **The mask** (`maskOnGrid`): the decoder's 256 × 256 low-resolution
   logits, over the 1024 input, sampled bilinearly at each label voxel's
   centre in the crop; above 0 is selected; voxels outside the volume are
   left out. Of its connected parts, those holding a wanted click are
   kept (`keepParts`): the decoder sometimes adds a like structure
   elsewhere (the other ventricle).

It is checked in `tests/sam.test.ts` (the crop, the window, the image
resampled and windowed, prompt coordinates, the mask on the grid for each
axis, a round trip, the parts kept, sections put together). With the
real model, outside the tests (it is not in the repository): a synthetic
section with a disc, a square and an ellipse, each found from a click or
a box with an IoU of 0.996 to 1.

**Timings** (headless Chrome on this machine's CPU: WASM, one thread, as
the page is not cross-origin isolated; there is no real GPU headless, so
WebGPU was not measured): the encoder about 3.8 s per crop, the decoder
about 0.2 s per prompt. Over three runs on SRB 2026a: the first prompt
took 8 to 62 s, nearly all of it the download (4 to 38 s from Hugging
Face, as the network allowed) and one embedding; a second click in the
same crop about 0.2 s (the decoder); a box elsewhere 5 to 7 s (a new
embedding); Spread to 3 sections each way 27 to 91 s (an embedding per
section, and each section's image read over the network). On a GPU through WebGPU the
encoder should take a small fraction of that.

**On SRB 2026a** (the default workspace's image), a click in the left
lateral ventricle's frontal horn (an axial section, the layer's window
0 … 255): the model's mask covered 98 % of the threshold method's mask
from the same click (tolerance 0.1) and was larger (the horn's edges, which
the tolerance leaves out); IoU 0.73. A box round the horn: IoU 0.84
with Threshold's box (Otsu). The masks are in
the run's screenshots (`sam_quick.mjs`, kept outside the repository).

## Adding a quick select method

```ts
import type { QuickSelectService } from "../segmentation/quick_select.js";

const qs = await ctx.services.get<QuickSelectService>("segmentation.quickSelect");
ctx.subscriptions.push(
  qs.register({
    id: "sam",
    title: "Segment Anything",
    prompts: ["box", "point"],
    // request.image: the image's values round the prompt on the label grid;
    // return a mask on that grid (1 = selected).
    async run(request, signal) { /* … */ return { lo: request.image.lo, size: request.image.size, data }; },
  }),
);
```

A method may also use `request.read(lo, hi)` (the image's values over any
box of label voxels), `request.source` (a key naming the image, the
window its layer shows, the label voxel's sides, the grid's size),
`request.context` (how much of the section round the prompt to look at)
and `request.progress(text, fraction)` (shown on the tool bar and in the
tab while it works). With `refines: true`, clicks add to the section's
prompt rather than replacing it, and `request.prompts` holds them all
(and the box), each marked wanted or not. Throwing an `Error` shows its
message; `signal` is aborted by Escape.
