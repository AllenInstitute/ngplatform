# Work plan

What has been asked for or agreed and is not built yet, newest first. Ticked
items are done (and say where); the rest are in rough order of work.
`STATUS.md` says what exists.

## Overnight plan (approved 2026-11-03, 23:00 GMT)

Run in waves of up to three worktree agents; each merged after tests, build
and headless checks; deploy after major features. Summary to Andrew at
07:00 CET (06:00 GMT). Keep going past the end of a night; expand the list
when it runs out. Proofreading and axon segmentation last.

**Wave A (large data)**
- [ ] A1. Images: dynamic pyramids for huge TIFF/BigTIFF/NIfTI with a small, bounded cache (only the coarse levels worth keeping, a cap such as a few % of the source, LRU; finer levels recomputed), a streaming background build (Jobs, cancel), a TIFF's own reduced pages as levels, Export → OME-Zarr from it; compared with tifffile's `aszarr`, bioformats2raw, ngff-zarr / ome-zarr-py, kerchunk / VirtualiZarr, refkv; measured on a generated multi-GB BigTIFF.
- [x] A2. (Merged: runner/ `ngplatform_runner`, Jobs → This computer, Track filtering's Run on this computer, large tractograms served or converted; the filter task lives in the runner, not zvtools, as the agent could not commit there.) Local job runner: a Python process on this computer (`ngplatform-runner`, bound to 127.0.0.1, paired by a token) that the app's Jobs panel talks to: jobs with their PID, log, progress, cancel; job kinds: zarr-vectors-tools filtering of a tractogram into a new `.trk` or Zarr Vectors store, conversion with a filter-ready index, `zvtools virtual serve` for files too large for the browser; brainhops usable there if the user installs it (no redistribution).
- [ ] A3. Zarr Vectors at scale in the browser: tractograms binned by streaming in bounded memory (capped spill), meshes in spatial cells with simplified levels; past the browser's limits, the app offers the local runner; aim: a 20 GB tractogram usable for interactive fibre tracing (regions, groups) with jobs to write the results.

**Wave B**
- [ ] B1. History as a provenance tree (branches kept after going back, a tree to jump in, changes named by scene and dataset).
- [ ] B2. Editing a large segmentation in place (copy-on-write).
- [ ] B3. AI quick select (a SAM-style model in the page, ONNX Runtime Web).

**Wave C**
- [ ] C1. Ray-cast SH ODF glyphs; Luxar glow on folded surfaces; region and parcel time courses on surfaces; vertex reach by mesh spacing.
- [ ] C2. Defaults: every plugin off except Zarr Vectors, with one-click offers when data a plugin handles is opened.
- [ ] C3. Plugin-by-plugin audit (bugs, half-done features, verbose UI), scorecards.

**Wave D**
- [ ] D1. UI tidy (shorter text, consistent controls, empty and error states).
- [ ] D2. Speed (startup, bundle, time to first image, memory, drawing), before and after.
- [ ] D3. Code review (shared helpers in the SDK, dead code, test gaps).
- [ ] D4. UX workflows: about ten common tasks, interactions counted, quicker paths built, counted again.
- [ ] D5. Examples report (every feature, screenshots, measurements).

**Last**: proofreading; axon segmentation and tracing.

## Asked for on 2026-11-03

- [x] chunkmirage (JaneliaSciComp, pinned as `vendor/chunkmirage`) as the engine for computed images: one service worker (local data, chunkmirage's relay, gs+google:// for the engine), pipelines carried in their links, Python from a link run only once allowed in a dialog that shows it, a fresh engine when Pyodide loads without its packages; the Filters tab as a pipeline of steps over any image, a Python step of one's own; one Pyodide (0.28.3) for the Python panel and the engine.
- [x] Segmentation as its own plugin and tab (tool bar, segment list, new layers on a grid or a copy).
- [x] Annotations as Neuroglass and WebKnossos organise them: an annotation table, groups, values from lists or ontologies, comments, search, CSV; a renamed layer keeps its record; the table's dock has room; edits wait while an annotation is being drawn.
- [x] Auth tab: Google sign-in, gs+google:// buckets, ngauth and middleauth servers, a sign-in per layer; Neuroglancer links say what they will not show.
- [x] Collections tab beside the scenes (a scene kind plugins contribute), images placed in the coordinate system chosen from a graph (checked with two systems), collections found above the data.
- [x] Local data after a reload: no 410 (reads wait for remembered folders), several dropped items remembered, a note for layers whose files are gone, reconnected when reopened.
- [x] Luxar: lines no longer move when the scene's scale differs from the store's; images as splats in the 2-D views too, in place of Neuroglancer's drawing (hidden for a while, not in the link).
- [x] Zarr Vectors: opacity fades colour without darkening, lines alone show no vertex dots (and the fork's skeleton layer, 435cdcb0).
- [x] Segmentation gaps: tool bar over the 2-D views only, Ctrl+Z with the workspace's undo, labels past 2^24, quick select preview, lasso, segment groups.
- [x] Time series gaps: a layer's local time axis, coarse levels while moving, playing without undo steps, CIFTI time series on surfaces.
- [x] Luxar gaps: only a layer's chosen segments, track groups by id then from their stores, bloom, meshes (lit in 3-D, outlines in 2-D). Left: fitted splats; reading only the chosen objects (few chosen read whole chunks); `notSelectedAlpha`.
- [x] Time series: a surface vertex's CIFTI time course under the mouse, pinned, CSV (the nearest vertex by a grid over the surface).
- [x] Luxar: a layer's few chosen objects read whole by id at full resolution (a sample of whole objects past the Detail), the others at `notSelectedAlpha`, a smooth hand-over to Track filtering's own stores.
- [x] Auth: several Google accounts (Google's account chooser, its pill button), sign-in rules by bucket, folder or web address choosing the sign-in and the Google account, kept in the browser, never in links.
- [ ] Left, smaller: ray-cast SH ODF glyphs (Orientations); Luxar glow saturating on folded surfaces; AI quick select (the interface exists) and proofreading (Segmentation).
- [ ] brainhops (neuroscales/brainhops) for reading non-linear warp files (ANTs, FSL, SPM, NiftyReg…) in the page: no licence in its repository yet, not on PyPI; a Pyodide feasibility test is ready in the scratchpad, waiting for Andrew.
- [ ] Waiting on Andrew: a Google OAuth client ID; the Allen CATMAID address; S-21-46's source data and leave to upload a rebuild with even coarse levels; copy-on-write editing of a large segmentation (agree first).
- [x] Collections: an image whose chain holds a displacement field (RFC-5) resampled through it, computed as it is viewed (a warp kind `field`; checked against numpy). Left: `coordinates` transforms, chains with two fields.
- [x] Registration: Warp through the pairs (a thin-plate spline from landmark pairs, a layer computed by chunkmirage's engine; `src/virtual/warp.ts`).
- [x] Time series: a CIFTI series shown as the overlay with a button (`viewer.setSurfaceOverlay`), its time point kept in the link. Atlas: a file's hierarchy kept in the link.
- [ ] Not done, smaller: local formats still served by the platform's own stores, not `Engine.serve`; very large local meshes in cells with simplified levels (deferred: surfaces and most meshes are fine whole).

## The plan agreed on 2026-11-02, evening

Worked through A, then B, then C. Estimates are rough focused days.
Priorities within that: virtual Zarr, then reading and exporting local data,
then the Luxar plugin and drawing labels by hand.

### Housekeeping
- [x] Docs: MkDocs site for Read the Docs (`mkdocs.yml`, `.readthedocs.yaml`, `docs/`): the idea, the window tab by tab, loading and exporting data, coming from Freeview / Neuroglancer, a user page per plugin with *Notes from users*, plugin ideas, contributing; a figure at the top of each plugin README; `CONTRIBUTING.md` and issue templates. The Read the Docs project itself is to be created (import the repository at readthedocs.org).
- [ ] Commit attribution: 28 commits on main and 11 gh-pages deploys carry an email GitHub links to another account (Andrew-K-K). Either move that email to the Andrew-Keenlyside account in GitHub's settings (no history change) or rewrite and force-push. Andrew to choose.
- [ ] A `LICENSE` file: `package.json` says Apache-2.0 but there is no licence text; the AllenInstitute org may have its own policy. Andrew to decide.
- [x] Track groups showed only their regions, no streamlines: a group was drawn from the dataset's own levels, and S-21-46's coarse levels keep a 10% sample of the objects per level (level 4 about 330 of 3.3 M), so zoomed out a group mostly vanished. A streamline group is now drawn from a store of its own whole streamlines, made in the page once its exact answer settles (a `.trk` read as a virtual Zarr Vectors store; at most 8 M points, else the finest sample level that fits), listed under its dataset (`DERIVED_LOCAL`). The three example groups draw in about 2 min headless; the corpus callosum (52,731) is most of it.
- [x] Group stores: a big group shows first from a sample level (up to about a million points), then whole.

### Asked for during the night
- [x] Four panels with the 3-D view bottom right (axial, sagittal, coronal, 3-D), as Freeview's 2 × 2.
- [x] OME-Zarr images listing their axes z, y, x show x, y, z in that order.
- [ ] Mesh and point-table levels (A4's remainder), and saving large data (A5b).
- [x] Views the right way up for anatomy: Neuroglancer's panels put +y and +z down, so RAS data showed axial anterior-down, coronal upside down, sagittal on its side. Now radiological (as Freeview) for x, y, z in mm or µm, Neuroglancer's for EM; Settings → Which way up the views are. Needs the fork's `setNamedPanelOrientation` (FORK_SHA bumped). Data placement itself was right (NIfTI/MGH against nibabel and FreeSurfer, .trk against nibabel).
- [x] A `working` branch for review; main only after Andrew's QC.
- [x] A history menu beside undo and redo (the ⋯ button, or *History of changes…* in the palette): every change in the workspace, newest at the top, with a few words saying what it was (worked out from the two states: "Layout: 3d", "Hid SRB 2026a", "Track filtering") and the time; undone changes greyed until redone; choosing a row goes back or forward to it. Up to 200 changes, scrollable. What a plugin does on the user's behalf (a track group's layer, its regions' annotations) and what follows opening before the user's first input join the current step instead of adding their own.
- [ ] The history as a provenance tree: keep branches when a change is made after going back, show them, and name changes per scene and per dataset. To flesh out with Andrew first.
- [x] The 3-D view's feel: it keeps turning after a drag, slowing down (src/engine/momentum.ts); a touch stops it; a palette command turns it off. Panning and zoom momentum: not yet.

### A. Local data
- [x] A1. A core `src/virtual/` module for all local read-in and write-out: `local_data.ts`, `images/`, `vectors/`, `out/` (README there).
- [x] A2. Drag-and-drop of files and folders anywhere in the window.
- [ ] A3. Formats to match zarr-vectors-tools (done: `.mgz`/`.mgh`, `.npy`, LAS, a FreeSurfer subject folder; images named as labels open as segmentations; Parquet, GraphML and edge lists; LAZ, surface morphometry and `.annot` (the Surfaces work), CIFTI dense scalars, labels and time series (mean and SD) on GIFTI surfaces; Feather (Arrow IPC, LZ4 and ZSTD); stepping through a CIFTI time series and its vertices' time courses since 2026-11-03): `.mgz`/`.mgh`, LAS/LAZ, Parquet/Feather, GraphML and edge lists, `.npy`/`.npz`, CIFTI, a FreeSurfer subject folder (with thickness, curv, sulc, area, aparc). 4–6 d
- [ ] A4. Coarse levels for every virtual vector store (done: streamlines, nested levels of 1 in 10, 100, 1000 while each keeps about 2,000; points. Deferred: meshes, which are served as one cell and drawn whole, enough for surfaces and most local meshes; cells with simplified levels when very large meshes need them): streamlines 2–3 levels, meshes in cells with simplified levels, points subsampled, all within a time budget so opening stays fast. 3–4 d
- [x] A5. **Export as** for local data (done except TIFF and `.trx` out): images to `.nii`, `.nii.gz`, `.mgz`, `.mgh`, OME-Zarr, TIFF; vectors to `.trk`, `.tck`, `.trx`, OBJ, STL, PLY, CSV. 3–4 d
- [ ] A5b. (Done: (a) a level or a box within a size limit; (b) every level of a local image written into a folder chunk by chunk, gzipped; painted labels saved as OME-Zarr write only painted chunks. Left: (c) editing an existing large segmentation copy-on-write (chunks read from the original until edited; the in-page store answering asynchronously, coarse levels from the original's pyramid, every tool loading the original's chunks before writing, undo included), most of a day and touches the Annotations painting code, so to agree with Andrew first; (d) zvtools for very large jobs.) Saving large data: (a) a region or level within a size limit, (b) a whole pyramid written chunk by chunk into a local folder, (c) edits only, as a small layer over the read-only source; (d) zvtools for very large jobs. 3–5 d
- [x] A6. Datasets list: no type shown for remote data; "Local" for local data.
- [x] A7. Tractograms (any Zarr Vectors streamlines) show as lines, 1 px, in cross-sections too.

### B. Display
- [x] B8. (Lookup tables in Render: FreeSurferColorLUT and its Desikan/Destrieux/Yeo subsets, Schaefer 2018, Harvard-Oxford bundled with their licences; Allen CCF fetched on demand; JHU, AAL3, Brainnetome by File… only, for their licences; any table file loads.) `data/lookup-tables/`: FreeSurferColorLUT, Allen CCF, Harvard-Oxford, JHU, AAL, Brainnetome, Schaefer as `.txt` (each table's licence checked), applied to segmentations by name and colour. 2–3 d
- [x] B9. (17 maps in Render → Shader → Colour map.) A colormap menu in Render → Shader: grayscale, heat (min/mid/max), jet, GE colour, NIH, PET, binary, viridis and others. 1–2 d
- [x] B10. (Render → 2-D views → Draw: Outlines, without a fork change; a fork patch for a native outline is in `docs/fork-patches/`.) Segmentations filled or as outlines (the fork's segmentation shader). 3–5 d
- [x] B19. (Done: surfaces drawn as their outlines on the sections, in Freeview's colours; per-vertex values, `.annot`, `.label`, CIFTI, filled surfaces in 3-D with overlays and parcellations.) Surface data: per-vertex values, `.annot` and `.label` coloured by colormap or lookup table; surface outlines on the slices. 5–8 d

### C. Plugins
- [x] Volume rendering: the sections on the cut faces from the full-resolution data the 2-D views already draw, not the solid's coarse level, so zooming into the cut shows fine structure over a coarse solid.
- [x] C11 (revised 2026-11-02, night; done as the Luxar rendering plugin: Luxar's line drawing, glow, emission/absorption and tone maps for chosen Zarr Vectors layers inside Neuroglancer's 2-D and 3-D views, per layer, on the fly from the stores' levels. Left: meshes as filled triangles, honouring selections, bloom and soft line caps, applying `plugins/luxar/fork/draws-after-sections.patch` so glow adds over the 3-D sections, Gaussian splats (an offline fit; see the plugin README).) **Luxar inside the Neuroglancer views, not a separate viewer.** When the plugin is on, a dataset can be drawn the Luxar way (smooth HDR lines, points, meshes, splats; additive and emission/absorption blending) in Neuroglancer's own 2-D and 3-D panels, chosen per dataset: say a Luxar tractogram over a standard or volume-rendered OME-Zarr image. 2-D panels draw the geometry near the section (a slab), as Luxar slices hidden dimensions. Through the fork's draw hooks, one viewer.
- [x] C11a. (Superseded by C11: inside Neuroglancer's views.) Luxar: a Luxar view (layer mode, its own three.js scene) with the camera following Neuroglancer's 3-D view. 3–4 d
- [x] C11b. (Read straight from Zarr Vectors chunks instead.) Luxar: Zarr Vectors to Luxar's format on the fly, in memory, no new files; our levels as its progressive levels. 7–10 d
- [x] C11c. (Done: the volume view draws the whole image from a coarse level with bricks of the finer levels over it, 32³ in one 3-D texture through a page table per level, finer near the camera and the cut, within 128 MB, nearest first, least recently wanted given up; a finer box around the position where the GPU cannot hold them. Bricks hidden behind the near surface are left out (rays through the coarse level, 2026-11-03). Left: levels past 4M page entries are left out.) Luxar: multiscale OME-Zarr voxels drawn on the fly in the same scene; one level first, then bricks from several levels. 4 + 10–15 d
- [ ] C11d. (Splats made on the fly from the voxels are done, 3-D and 2-D; left: fitted splats, Luxar's GPU fit, which makes new files.) Luxar: Gaussian splats; this makes new files (a GPU fit). Try on SRB 2026a; ask where the files go first. 2–3 d + GPU time
- [x] C12. (Measure: lengths, areas and volumes, line profiles with CSV; Statistics in boxes, ellipsoids and labels.) Annotations (Labels renamed): labels, measuring (lengths, areas, line profiles), contours, statistics per label or region. 5–7 d
- [x] C13. (The scaffold and more: label volumes on an image's grid or from a NIfTI, brush (disc or ball), erase, 2-D/3-D fill, intensity-limited painting, quick select by Otsu or tolerance, interpolation between sections, undo/redo, save NIfTI or OME-Zarr (whole or the painted box), kept in the browser across reloads; the WebKnossos survey in `docs/plugins/segmentation-survey.md`. Since: lasso, quick-select preview, segment groups, exact labels past 2^24, one undo history with the workspace. Left: AI quick select (the interface exists), proofreading.) Segmentation, in Annotations: a WebKnossos survey (brush, lasso, fill, quick select by threshold and AI, interpolation, proofreading, AI jobs), then a scaffold: an editable label layer, sphere brush add/erase, threshold-limited brush, 2-D/3-D fill, undo, save to local. 0.5 + 8–10 d
- [x] C14. (Done, off by default; tensor ellipsoids ray-cast and tensor levels log-Euclidean since; left: ray-casting the ODFs themselves, see `plugins/orientations/README.md`.) Orientations: vector fields, DTI ellipsoids and FA colour, spherical-harmonic ODF glyphs (as FURY draws them), multiscale: coarse levels' ODFs replaced by finer ones as you zoom. 15–20 d
- [x] C15. (The Filters plugin, on chunkmirage's engine since 2026-11-03: any image, a pipeline of steps.) Filters: mean, median, Gaussian, Frangi, on the fly as a virtual store over any OME-Zarr, per chunk and per level. 8–10 d
- [x] C16. (Done: apply to all visible volumes, save without cropping, `.mgz`/`.mgh` out, MNI `.xfm` in, the OME coordinate systems in the Source tab. landmarks to axes, B-spline cubic, `register.dat`, FSL and ANTs `.mat` in, OME-Zarr at full resolution in blocks and NIfTI/MGH in streamed slabs, however large.) Registration: apply to all visible volumes; straightening with landmarks alone (Freeview's landmarks-to-axes); save without cropping; `.mgz`; B-spline cubic; `.dat`/`.xfm`/FSL `.mat`; levels over 512 MB in blocks. The Source tab shows an OME-Zarr's coordinate systems and transforms (0.6, RFC-5) under the layer's transform. 6–8 d
- [x] C17. (The Collections plugin, following RFC-8's draft of October 2026.) Collections: a tab beside the scenes for an OME-Zarr collection (RFC-8): its images, coordinate systems and transforms, with a viewer. 5 d
- [x] C18. (Picture, slice/time sweeps and 3-D turns as GIF, WebM, MP4 or PNG frames; magnification and trim.) Capture (screenshots expanded): GIF, video (WebM / MP4), movie frames, slice sweeps, 3-D rotations, magnification and trimming. 4–6 d

Possible future plugins (neuron tracing and review as CATMAID, proofreading,
atlas, surfaces, tract statistics, connectome, time series, spatial
transcriptomics, probe tracks, DICOM, side by side, quality control, AI
models, story): `docs/plugins/ideas.md`.

## Asked for on 2026-11-02, afternoon
- [x] Registration: Freeview's Transform Volume controls: Rotate, Translate, Scale and Flip tabs along X (L-R), Y (P-A), Z (I-S), each a slider (the layer moves as it is dragged) and a typed value; rotate about the volume's centre or the cursor; Move centre to cursor; Restore to original. Composed as Freeview's `LayerMRI::DoTransform` (flip, scale, rotate x, y, z, translate), checked against its own steps.
- [x] Registration: save the moved image on this computer as NIfTI (`.nii.gz`, `.nii`) or OME-Zarr (into a chosen folder in Chrome and Edge, else a zip); resampled (nearest, trilinear, cubic; onto its own grid or another image's) or the voxels unchanged with the new placement in the header. Checked against FreeSurfer's `mri_vol2vol`.
- [x] Registration: save the new affine as a FreeSurfer `.lta` (RAS to RAS with both volumes' geometry, as Freeview's Save Reg); `lta_convert` reads it. Freeview's VOX to VOX LTAs import.
- [x] The default template: SRB 2026a (the HiP-CT template, 100 µm, MNI 2009b space) from Andrew's GCS bucket, in place of MNI152 2009a; black outside the brain (transparent, its edge showed as an outline).
- [x] The default tractogram: S-21-46 (50 µm HiP-CT, BRIDGE anatomically constrained, MNI space; 3.3 M streamlines) converted to zarr-vectors (`zvtools convert`, as HCP-1065: RAS mm, five levels keeping the longest tenth each, length, orientation, tortuosity) and hosted beside it on GCS; HCP-1065 stays as an example.
- [x] Track filtering: a rename (pencil) button on each group; a new group's name is selected, ready to type over.
- [x] README logo: black word mark (it showed white on GitHub's light theme when the computer was in dark mode).
- [x] Registration: saving segmentations held as uint64 or int64 (read as 32-bit; a label past 32 bits is refused).

## From the review of 2026-11-02

### Top bar, Open, scenes
- [x] An **Open in Neuroglancer** button in the top bar: the scene in Google's Neuroglancer in a new tab. When the scene has zarr-vectors (or data on this computer), say that plain Neuroglancer will show only the images.
- [x] Half-width window: keep the camera and settings icons; let the side panels be dragged wider or narrower.
- [x] **Open from device**: the system file picker, then the chosen NIfTI (or other local file) opens as a dataset.
- [x] Open: an **Examples and templates** section whose first entry is **Blank viewer** (an empty scene).
- [x] An × on each scene tab (on hover and on the active tab). Closing the last scene opens a blank one, so there is always a scene.

### Look and wording
- [x] Logo: the earlier mark, overlapping and slightly off-angle, with straight lines, and a darker light grey.
- [x] Plugin switches: the standard pill-shaped slider (round ends, round knob), green on, grey off. Switches only for plugins.
- [x] Elsewhere, tick boxes, as in Neuroglancer: **Selections** (and Volume) beside Sections in the 3-D panel, and other on/off buttons.
- [x] Plugins panel spacing: Add no longer sits on the first plugin; even gaps throughout.
- [x] Pop-ups: softer grey and border, rounded corners.
- [x] Shorter text throughout (descriptions, hints, empty states); keep Read more. *(The plugin guides, behind Read more, keep their detail.)*

### Track filtering
- [x] "Show all objects" (no bracketed note), off by default.
- [x] Dataset: a drop-down of the scene's annotation, segmentation and zarr-vectors datasets.
- [x] Filtering applies to anything that is not an image:
  - [x] zarr-vectors (streamlines, points, skeletons, meshes): as now;
  - [x] local annotation layers (points, lines, boxes, ellipsoids);
  - [x] segmentation volumes (precomputed, zarr, e.g. MICrONS): segments present in the region;
  - [x] precomputed annotations (read by their spatial index, in the worker);
  - [x] precomputed skeletons: through the segmentation's volume (a segmentation layer showing skeletons filters by its volume, as MICrONS does); a skeleton-only source has no spatial index, and the panel now says so and why;
  - [x] tractograms opened from disk (virtual zarr-vectors, below).
- [x] No "no zarr-vectors in this scene" message when other filterable data is there.
- [x] Groups belong to the dataset they filter: a scene with other data no longer lists (or counts against) another dataset's groups. Save .trk only for streamlines.

### Volume rendering
- [x] The Volume switch does nothing on the EM image-only examples: make it draw them.
- [x] NIfTI (virtual Zarr) in the volume view: types other than uint8, and the transpose codec.

### Neuroglancer fork
- [x] Resolution histograms: every level of every layer laid out across the full width all the time; only the marker of what is loading moves.

### Virtual zarr-vectors
- [x] A `virtual` module in zarr-vectors-tools: a standard file read as a zarr-vectors store on demand, without converting it. *(Two twins: TypeScript in the Zarr Vectors plugin (`plugins/zarr-vectors/src/virtual/`), which the browser runs, and Python in zarr-vectors-tools (`zarr_vectors_tools.virtual`, `zvtools virtual serve`, branch `working`); every key byte-identical between the two on every test file; valid by zarr-vectors-py's level-3 validation.)*
  - [x] `.trk` (TrackVis) first;
  - [x] `.tck` (MRtrix), `.trx`;
  - [x] meshes and surfaces: `.obj`, `.stl`, `.ply`, GIFTI, FreeSurfer *(very large meshes sit in one cell; split into cells next)*;
  - [x] points and skeletons: `.swc` (one object per tree), point tables `.csv`/`.tsv`/`.xyz` (each point an object up to 250,000, so they filter; larger tables in cells about eight across, drawn but not grouped; a folder of SWC files as one store, each neuron's file a property) *(Python twin byte-identical, the 300,000-point table's 247 keys included)*.
  - [x] Python twin speed: 200,000 streamlines in 5.9 s (was 17 s; the browser takes 3.4 s).
- [x] Linked to the Zarr Vectors data type: these files open only when it is on.

### Repository hygiene
- [x] No Claude authorship or trailers in new commits; repo text cleaned (`docs/editor_repo_plan.md`).
- [ ] Rewrite the history of ngplatform (main, platform-gui, gh-pages) and the fork's `ngplatform-upstream`: `~/scripts/rewrite-history.sh --push` (a force-push, waiting for Andrew).
- [ ] Decide: the same for AllenInstitute/zarr-vectors-tools and zarr-vectors-py (shared repos; many branches and PR descriptions), and the fork's collaborative `zarr_vectors_*` branches.

## Open questions from earlier rounds
- [ ] The rest of "In general, implement the…" (a message cut short).
- [ ] A Cinematic Anatomy reference image, for the volume rendering's look.
- [ ] Registration and Volume rendering: on by default?

## Earlier items not yet done
- [ ] Run the browser smoke test on a machine with a GPU (pixel checks).
- [x] External plugins from a URL, with a consent dialog (Plugins → Add → From a URL…; the manifest is shown before any code runs; remembered until removed).
- [x] Track filtering: endpoint modes. Each region of a streamline or skeleton store can ask for either end, or both ends, in it instead of passing through (ends found chunk by chunk: a fragment's first or last vertex unless a link carries the line on; HCP-1065: 785 of the 25,734 callosal tracts end in the midline slab).
- [x] Track filtering: density maps. A group's streamlines counted once per voxel (1 mm for a brain), shown at once as a heat-map layer over the anatomy and saved as NIfTI (Save .nii); HCP-1065's left corticospinal group: 2,913 streamlines in 5–20 s. Plugins can open a file they make as local data (`workspace.local.open`).
- [x] Track filtering: statistics per group (count, and an attribute's mean ± SD and median, in a Statistics section; CSV of every attribute's n, mean, SD, median and range for every group).
- [x] Track filtering: disk regions with an angle limit; mask regions (a label volume, or an image above a threshold).
- [x] Virtual Zarr: TIFF stacks (TIFF/BigTIFF, strips or tiles, LZW/deflate/PackBits, OME and ImageJ hyperstacks and pixel sizes).
- [x] A new scene fits its first dataset (centre and zoom, in the data's own units), and image layers take their contrast from the source's OME window (the virtual stores now write one).
- [x] Virtual Zarr: RGB and RGBA (TIFF, NIfTI RGB24/RGBA32), packed one uint32 a voxel and shown in colour.
- [x] Virtual Zarr: `.hdr`/`.img` pairs (NIfTI and Analyze 7.5), joined without copying the image.
- [x] Virtual Zarr: `.nii.gz` kept decompressed between visits (OPFS, the six most recently used, by name, size and date).
- [x] Virtual Zarr: TIFF floating-point predictor; 16-bit RGB (shown by each sample's top 8 bits).
- [x] Data made in the page shown as a layer, for images: `await ngp.show(array, …)` in the Python console (image or labels), and track density maps; both are NIfTI files made in memory and read as virtual Zarr (`workspace.local.open` for plugins).
- [x] Beyond images from Python: `ngp.show_points`, `ngp.show_lines`, `ngp.show_mesh` (served as virtual Zarr Vectors) and `ngp.annotate`.
- [ ] zarr-vectors-tools Z1: `zvtools index`, filter-ready columns (length, bounding box, endpoints, fragment owner), so a region reads only the fragments near it.

## The build guide's tracks, not started
- **P (platform):** rebase the fork onto upstream master (command registry), `embed.ts`, gallery round-trip test, plugin lint in CI, a worker pool with jobs and cancel, self-hosted Pyodide, an OPFS cache, a docs site, release.
- **Z:** golden filter answers (Z2–Z3), along-track means (Z4), region-limited pyramid rebuild (Z5), converters for MERFISH, SWC, connectomes and cellfinder (Z6), displacement fields in zvtools (Z7; the browser applies them since 2026-11-03).
- **FE:** vendored `zvfilter` in Pyodide, store profile and cost estimate, object masks in the fork (FE6), the `zvf` Python API.
- **T (TrackVis parity):** shader presets and the TrackVis keymap (T1), multi-view (T6), movies and `.scene` import (T7), validation (T8).
- **R (registration):** (landmark thin-plate spline warps and displacement fields applied on the fly: done 2026-11-03) the warp hook in the fork, image resampling, elastix (ITK-Wasm), QC views, provenance.
- **A** atlas hub, **S** spatial transcriptomics, **C** connectome explorer, **M** morphology, **CM** cell mapper, **L** Lead-DBS suite, **E** axon editing: plans only.
