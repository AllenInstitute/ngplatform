# Work plan

What has been asked for or agreed and is not built yet, newest first. Ticked
items are done (and say where); the rest are in rough order of work.
`STATUS.md` says what exists.

## From the review of 2026-11-02

### Top bar, Open, scenes
- [ ] An **Open in Neuroglancer** button in the top bar: the scene in Google's Neuroglancer in a new tab. When the scene has zarr-vectors (or data on this computer), say that plain Neuroglancer will show only the images.
- [ ] Half-width window: keep the camera and settings icons; let the side panels be dragged wider or narrower.
- [ ] **Open from device**: the system file picker, then the chosen NIfTI (or other local file) opens as a dataset.
- [ ] Open: an **Examples and templates** section whose first entry is **Blank viewer** (an empty scene).
- [ ] An × on each scene tab (on hover and on the active tab). Closing the last scene opens a blank one, so there is always a scene.

### Look and wording
- [ ] Logo: the earlier mark, overlapping and slightly off-angle, with straight lines, and a darker light grey.
- [ ] Plugin switches: the standard pill-shaped slider (round ends, round knob), green on, grey off. Switches only for plugins.
- [ ] Elsewhere, tick boxes, as in Neuroglancer: **Selections** (and Volume) beside Sections in the 3-D panel, and other on/off buttons.
- [ ] Plugins panel spacing: Add no longer sits on the first plugin; even gaps throughout.
- [ ] Pop-ups: softer grey and border, rounded corners.
- [ ] Shorter text throughout (descriptions, hints, empty states); keep Read more.

### Track filtering
- [ ] "Show all objects" (no bracketed note), off by default.
- [ ] Dataset: a drop-down of the scene's annotation, segmentation and zarr-vectors datasets.
- [ ] Filtering applies to anything that is not an image:
  - [ ] zarr-vectors (streamlines, points, skeletons, meshes): as now;
  - [ ] local annotation layers (points, lines, boxes, ellipsoids);
  - [ ] segmentation volumes (precomputed, zarr, e.g. MICrONS): segments present in the region;
  - [ ] precomputed annotations and skeletons: read as virtual zarr-vectors;
  - [ ] tractograms opened from disk (virtual zarr-vectors, below).
- [ ] No "no zarr-vectors in this scene" message when other filterable data is there.

### Volume rendering
- [ ] The Volume switch does nothing on the EM image-only examples: make it draw them.
- [ ] NIfTI (virtual Zarr) in the volume view: types other than uint8, and the transpose codec.

### Neuroglancer fork
- [ ] Resolution histograms: every level of every layer laid out across the full width all the time; only the marker of what is loading moves.

### Virtual zarr-vectors
- [ ] A `virtual` module in zarr-vectors-tools: a standard file read as a zarr-vectors store on demand, without converting it. Used by ngplatform for files on this computer, and by `zvtools` for serving to any Neuroglancer.
  - [ ] `.trk` (TrackVis) first;
  - [ ] `.tck` (MRtrix), `.trx`;
  - [ ] meshes: `.obj`, `.stl`, `.ply`, GIFTI surfaces, EM meshes;
  - [ ] points and skeletons: `.swc`, CSV points.
- [ ] Linked to the Zarr Vectors data type: these files open only when it is on.

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
- [ ] External plugins from a URL, with a consent dialog.
- [ ] Track filtering, next: endpoint modes (either or both ends in a region), disk regions with an angle limit, mask regions (a painted or thresholded volume), statistics per group with CSV, density maps exported as NIfTI.
- [ ] Virtual Zarr, next: TIFF stacks; `.nii.gz` kept decompressed between visits (OPFS); `.hdr`/`.img` pairs; RGB.
- [ ] `memory://` layers (gate G3): data made in the page (Python, a filter result) shown as a layer.
- [ ] zarr-vectors-tools Z1: `zvtools index`, filter-ready columns (length, bounding box, endpoints, fragment owner), so a region reads only the fragments near it.

## The build guide's tracks, not started
- **P (platform):** rebase the fork onto upstream master (command registry), `embed.ts`, gallery round-trip test, plugin lint in CI, a worker pool with jobs and cancel, self-hosted Pyodide, an OPFS cache, a docs site, release.
- **Z:** golden filter answers (Z2–Z3), along-track means (Z4), region-limited pyramid rebuild (Z5), converters for MERFISH, SWC, connectomes and cellfinder (Z6), displacement fields (Z7).
- **FE:** vendored `zvfilter` in Pyodide, store profile and cost estimate, object masks in the fork (FE6), the `zvf` Python API.
- **T (TrackVis parity):** shader presets and the TrackVis keymap (T1), multi-view (T6), movies and `.scene` import (T7), validation (T8).
- **R (registration):** local warps (RBF), the warp hook in the fork, image resampling, elastix (ITK-Wasm), QC views, provenance.
- **A** atlas hub, **S** spatial transcriptomics, **C** connectome explorer, **M** morphology, **CM** cell mapper, **L** Lead-DBS suite, **E** axon editing: plans only.
