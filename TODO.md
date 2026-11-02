# Work plan

What has been asked for or agreed and is not built yet, newest first. Ticked
items are done (and say where); the rest are in rough order of work.
`STATUS.md` says what exists.

## The plan agreed on 2026-11-02, evening

Worked through A, then B, then C. Estimates are rough focused days.
Priorities within that: virtual Zarr, then reading and exporting local data,
then the Luxar plugin and drawing labels by hand.

### Housekeeping
- [x] Docs: MkDocs site for Read the Docs (`mkdocs.yml`, `.readthedocs.yaml`, `docs/`): the idea, the window tab by tab, loading and exporting data, coming from Freeview / Neuroglancer, a user page per plugin with *Notes from users*, plugin ideas, contributing; a figure at the top of each plugin README; `CONTRIBUTING.md` and issue templates. The Read the Docs project itself is to be created (import the repository at readthedocs.org).
- [ ] Commit attribution: 28 commits on main and 11 gh-pages deploys carry an email GitHub links to another account (Andrew-K-K). Either move that email to the Andrew-Keenlyside account in GitHub's settings (no history change) or rewrite and force-push. Andrew to choose.
- [ ] A `LICENSE` file: `package.json` says Apache-2.0 but there is no licence text; the AllenInstitute org may have its own policy. Andrew to decide.
- [ ] The S-21-46 track groups did not show their streamlines in the 3-D view in a headless run (2-D fine); check in a real browser.

### A. Local data
- [ ] A1. A core `src/virtual/` module for all local read-in and write-out (the image and vector virtual stores in one place). 2–3 d
- [ ] A2. Drag-and-drop of files and folders anywhere in the window. 0.5 d
- [ ] A3. Formats to match zarr-vectors-tools: `.mgz`/`.mgh`, LAS/LAZ, Parquet/Feather, GraphML and edge lists, `.npy`/`.npz`, CIFTI, a FreeSurfer subject folder (with thickness, curv, sulc, area, aparc). 4–6 d
- [ ] A4. Coarse levels for every virtual vector store: streamlines 2–3 levels, meshes in cells with simplified levels, points subsampled, all within a time budget so opening stays fast. 3–4 d
- [ ] A5. **Export as** for local data: images to `.nii`, `.nii.gz`, `.mgz`, `.mgh`, OME-Zarr, TIFF; vectors to `.trk`, `.tck`, `.trx`, OBJ, STL, PLY, CSV. 3–4 d
- [ ] A5b. Saving large data: (a) a region or level within a size limit, (b) a whole pyramid written chunk by chunk into a local folder, (c) edits only, as a small layer over the read-only source; (d) zvtools for very large jobs. 3–5 d
- [ ] A6. Datasets list: no type shown for remote data; "Local" for local data. <0.5 d
- [ ] A7. `.trk` and other tractograms open as lines, thickness 1. <0.5 d

### B. Display
- [ ] B8. `data/lookup-tables/`: FreeSurferColorLUT, Allen CCF, Harvard-Oxford, JHU, AAL, Brainnetome, Schaefer as `.txt` (each table's licence checked), applied to segmentations by name and colour. 2–3 d
- [ ] B9. A colormap menu in Render → Shader: grayscale, heat (min/mid/max), jet, GE colour, NIH, PET, binary, viridis and others. 1–2 d
- [ ] B10. Segmentations filled or as outlines (the fork's segmentation shader). 3–5 d
- [ ] B19. Surface data: per-vertex values, `.annot` and `.label` coloured by colormap or lookup table; surface outlines on the slices. 5–8 d

### C. Plugins
- [ ] C11a. Luxar: a Luxar view (layer mode, its own three.js scene) with the camera following Neuroglancer's 3-D view. 3–4 d
- [ ] C11b. Luxar: Zarr Vectors to Luxar's format on the fly, in memory, no new files; our levels as its progressive levels. 7–10 d
- [ ] C11c. Luxar: multiscale OME-Zarr voxels drawn on the fly in the same scene; one level first, then bricks from several levels. 4 + 10–15 d
- [ ] C11d. Luxar: Gaussian splats; this makes new files (a GPU fit). Try on SRB 2026a; ask where the files go first. 2–3 d + GPU time
- [ ] C12. Annotations (Labels renamed): labels, measuring (lengths, areas, line profiles), contours, statistics per label or region. 5–7 d
- [ ] C13. Segmentation, in Annotations: a WebKnossos survey (brush, lasso, fill, quick select by threshold and AI, interpolation, proofreading, AI jobs), then a scaffold: an editable label layer, sphere brush add/erase, threshold-limited brush, 2-D/3-D fill, undo, save to local. 0.5 + 8–10 d
- [ ] C14. Orientations: vector fields, DTI ellipsoids and FA colour, spherical-harmonic ODF glyphs (as FURY draws them), multiscale: coarse levels' ODFs replaced by finer ones as you zoom. 15–20 d
- [ ] C15. Filters: mean, median, Gaussian, Frangi, on the fly as a virtual store over any OME-Zarr, per chunk and per level. 8–10 d
- [ ] C16. Registration: apply to all visible volumes; straightening with landmarks alone (Freeview's landmarks-to-axes); save without cropping; `.mgz`; B-spline cubic; `.dat`/`.xfm`/FSL `.mat`; levels over 512 MB in blocks. The Source tab shows an OME-Zarr's coordinate systems and transforms (0.6, RFC-5) under the layer's transform. 6–8 d
- [ ] C17. Collections: a tab beside the scenes for an OME-Zarr collection (RFC-8): its images, coordinate systems and transforms, with a viewer. 5 d
- [ ] C18. Capture (screenshots expanded): GIF, video (WebM / MP4), movie frames, slice sweeps, 3-D rotations, magnification and trimming. 4–6 d

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
- [ ] Registration, next: Freeview's "Apply to all visible volumes"; saving segmentations held as uint64; levels finer than 512 MB in blocks.

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
- [ ] Track filtering, next: disk regions with an angle limit, mask regions (a painted or thresholded volume).
- [x] Virtual Zarr: TIFF stacks (TIFF/BigTIFF, strips or tiles, LZW/deflate/PackBits, OME and ImageJ hyperstacks and pixel sizes).
- [x] A new scene fits its first dataset (centre and zoom, in the data's own units), and image layers take their contrast from the source's OME window (the virtual stores now write one).
- [x] Virtual Zarr: RGB and RGBA (TIFF, NIfTI RGB24/RGBA32), packed one uint32 a voxel and shown in colour.
- [x] Virtual Zarr: `.hdr`/`.img` pairs (NIfTI and Analyze 7.5), joined without copying the image.
- [x] Virtual Zarr: `.nii.gz` kept decompressed between visits (OPFS, the six most recently used, by name, size and date).
- [ ] Virtual Zarr, next: TIFF floating-point predictor; RGB with more than 8 bits a sample.
- [x] Data made in the page shown as a layer, for images: `await ngp.show(array, …)` in the Python console (image or labels), and track density maps; both are NIfTI files made in memory and read as virtual Zarr (`workspace.local.open` for plugins).
- [ ] `memory://` beyond images: meshes, points and annotations made in the page.
- [ ] zarr-vectors-tools Z1: `zvtools index`, filter-ready columns (length, bounding box, endpoints, fragment owner), so a region reads only the fragments near it.

## The build guide's tracks, not started
- **P (platform):** rebase the fork onto upstream master (command registry), `embed.ts`, gallery round-trip test, plugin lint in CI, a worker pool with jobs and cancel, self-hosted Pyodide, an OPFS cache, a docs site, release.
- **Z:** golden filter answers (Z2–Z3), along-track means (Z4), region-limited pyramid rebuild (Z5), converters for MERFISH, SWC, connectomes and cellfinder (Z6), displacement fields (Z7).
- **FE:** vendored `zvfilter` in Pyodide, store profile and cost estimate, object masks in the fork (FE6), the `zvf` Python API.
- **T (TrackVis parity):** shader presets and the TrackVis keymap (T1), multi-view (T6), movies and `.scene` import (T7), validation (T8).
- **R (registration):** local warps (RBF), the warp hook in the fork, image resampling, elastix (ITK-Wasm), QC views, provenance.
- **A** atlas hub, **S** spatial transcriptomics, **C** connectome explorer, **M** morphology, **CM** cell mapper, **L** Lead-DBS suite, **E** axon editing: plans only.
