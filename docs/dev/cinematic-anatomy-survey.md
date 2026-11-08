# Cinematic Anatomy: what it does, and where Anatomical rendering stands

Siemens Healthineers' Cinematic Anatomy (with JKU Linz) is a teaching
application built on Cinematic Rendering (Monte Carlo volumetric path
tracing). It reads CT and MR as DICOM and runs on a PC, with stereo glasses,
on 8K walls (JKU's medSPACE) and in VR; the Apple Vision Pro app is
"Cinematic Reality". One Siemens page says it is no longer offered as an
independent application. Its sibling Cinematic Playground (a syngo.via
Frontier research application) has a public instructions-for-use document;
syngo.via's own Cinematic VRT is described in a white paper and datasheets.
No Cinematic Anatomy manual is public. What follows is from those sources
(listed at the end), gathered 2026-11-08, not from using the software.

| Function | Cinematic Anatomy and its siblings | Anatomical rendering (ngplatform) |
|---|---|---|
| Data | DICOM CT and MR folders, dragged in; a content library of prepared cases | OME-Zarr (0.4–0.6) read where it is (local, http, GCS, S3); scenes as cases |
| Rendering | Monte Carlo path tracing, HDR light maps, soft shadows, ambient occlusion, volumetric scattering, thin-lens camera (depth of field), tone mapping; progressive refinement | The same family: delta and ratio tracking, surface/volume scattering by gradient, key light plus HDR light maps (three CC0 panoramas) or a sky-like environment, thin lens in the service API (no control in the tab yet), filmic tone curve, progressive |
| Presets | Tissue-specific transfer functions, grouped by anatomical category (Academy talk); a preset is "the transfer function setting as well as material classifications and fixed clip planes" (Niedermayr et al. 2024); one to three per dataset; presets added from files, removed, starred (Playground) | Presets by modality (MR, HiP-CT, histology, translucent) and by region; values as tissue percentiles, so one preset suits scans of different scaling; presets loaded from JSON files. Not yet: grouping, favourites, fixed clip planes inside a preset |
| Transfer function editing | Window centre and width with the mouse (middle-drag in Playground); syngo.via edits the transfer function's curves and trapezoids and saves it as a new preset | Density, exposure, light; a preset file. Not yet: an editor in the page, window by mouse drag |
| Region colours | Not in the Vision Pro study ("does not yet include … segmentations"); syngo.via colours through presets and segmentation tools (bone removal, punching) | Colours from a co-registered segmentation's labels (FreeSurfer table), regions hidden, regions kept through cuts, colours blended between label voxels |
| Clip planes | Up to three, axial, sagittal and coronal, each with a slider (Academy tutorial); a movable, rotatable plane with handles (Playground); "clip plane slab" in syngo.via | Three cuts through the position across x, y, z, either side, offsets in mm with sliders. Not yet: an oblique plane, handles in the view, a slab |
| Clip box, carve, crop | Clip box from six directions with handles (Playground, syngo.via); "carve and crop" for virtual dissection (Siemens) | A clip box as fractions of the volume (six sliders). Not yet: handles in the view, carving |
| Navigation | Mouse (pan, rotate, zoom at the edge); anatomical view buttons and an orientation cube; realign; gamepad (zoom, pan, rotate, slice); gaze and pinch on Vision Pro | Neuroglancer's mouse and keys; Left, Right, Anterior, Posterior, Superior, Inferior buttons. Not yet: orientation cube, gamepad |
| Animation | Keyframes ("the built-in animation system"; initial keyframes set in Cinematic Rendering, Ars Electronica); an animation view with an output resolution (Frontier prototype) | Keyframes from the view with times; steady or eased camera; cuts, density, light and exposure blended between keyframes; rendered on the host |
| Export | Ranges: rotation about the horizontal or vertical axis, half or full circle, a step in degrees, a preview, images saved to a folder; a snapshot in a chosen format (Playground); movies with export (syngo.via "Movie (incl. export)") | Rotation ranges (axis, half or full, step); MP4 (H.264) or PNG frames on the host, downloaded in the page; stills as PNG at a chosen size and sample count. Not yet: a preview before rendering |
| Annotations | Added to structures (flyer) | Neuroglancer's annotations, drawn with the render's depth |
| Stereo, VR, walls | Stereo glasses, VR headsets, 8K wall with active shutter glasses, Vision Pro | Not yet |
| Speed | Rendering on the PC or headset; Siemens' denoising and temporal reuse (Martschinke 2019, Hofmann 2020) | CUDA on a host (an A6000: 45–65 ms a pass at 834 × 684 for a 135-million-voxel brain, 100–330 ms with labels and cuts), or WebGPU in the page; frames at half size while moving; an edge-avoiding wavelet denoiser for the first samples. Not yet: a learned denoiser, reprojection between frames |

## How its colours are made

Nothing public says Siemens derives colours from photographs. What is
documented:

- **A preset is drawn by hand.** The Preset Editor (Cinematic Playground 1.0,
  2025) shows a piecewise-linear transfer function over the data's
  histogram: control points with a colour and an opacity, over HU for CT or
  raw intensity for MR, several curves to a preset, saved under a new name.
  A preset also holds material classifications and fixed clip planes
  (Niedermayr et al. 2024). The Vision Pro study credits the realism to
  "Siemens Healthineers' dedicated team working extensively to perfect the
  transfer functions for each specific use case", and rescaled its data to
  fit Siemens' presets rather than editing them.
- **CT is calibrated, MR is not.** HU fixes air, fat, water, muscle, contrast
  and bone, so one CT preset gives each tissue its colour on any scanner. MR
  intensity has no fixed scale and does not follow tissue colour, which is
  why most published Cinematic Rendering is CT.
- **Each region gets its own preset.** Playground 1.0 segments the volume (or
  reads DICOM SEG) and gives every region a preset of its own, such as
  `CT_MSK_Transp_Skin_small` or `CT_Lung_Airways`, with a priority order,
  inversion, and hiding ("punching"). This is Siemens' "semantic cinematic
  volume rendering" patent (US 2017/0061672, Zhou, Engel et al.): the
  transfer function depends on the place's tissue class, and each material
  has its own phase function from a database.
- **Light does much of the work.** HDR light maps photographed in real places,
  light passing through some tissue layers and scattering in deeper ones,
  then tone mapping.

How Anatomical rendering differs, as of 2026-11-08:

- It uses one transfer function for the whole volume, and a region's colour is a flat tint on it
  (`label_mix`). It is not the region's own transfer function and material.
- The MR, HiP-CT and histology colours were chosen by eye, on percentiles.
- The albedo is the transfer function's colour and the extinction is grey.
  Over n bounces the colour goes as albedo^n, so it saturates and darkens.
  In real tissue, absorption depends on the wavelength: haemoglobin takes
  blue and green, so red light goes deeper.

Open work on this:

- **Presets per region:** a label table that names a material per label.
- **Colours measured from photographs** of registered real tissue. Candidates
  are the Visible Human colour cryosections and NextBrain's dissection
  photographs; fixed tissue needs its own photographs. The albedo would be
  fitted so that a rendered slab matches the photographed colour.
- **Extinction per colour channel.**
- **A transfer-function editor** in the manner of Playground's.

NiiVue's cinematic mode (PR #473) maps MR labels' CSF, grey and white matter
medians to 0, 100 and 200 so that one table fits every scanner, and
modulates the transfer function by label. That is a class-based
normalisation, where Anatomical rendering uses percentiles.

## Sources

- Siemens Healthineers, [Anatomical lectures with Cinematic Anatomy](https://www.siemens-healthineers.com/perspectives/cinematic-anatomy): windowing, clip planes, carve and crop, gamepad, stereo, VR.
- Siemens Healthineers, [Cinematic Playground: instructions for use, 0.7.5.0](https://marketplace.teamplay.siemens-healthineers.com/api/download/media/Siemens%20Healthcare%20GmbH/Frontier/Cinematic%20Playground/0.7.5.0/Instruction%20for%20Use%20Cinematic%20Playground_0.pdf) (2021): navigation, presets from files, clip box, clip plane, hide graphics, export of ranges and images, configuration.
- Siemens Healthineers Academy: [image viewer and manipulation in Cinematic Anatomy](https://theta.academy.siemens.knowledgeanywhere.com/_/en-us/image-viewer-window-and-advanced-manipulation-features), [expert talk: Cinematic Anatomy in lectures](https://academy.siemens-healthineers.com/_/en-us/expert-talk-cinematic-anatomy-in-lectures), [syngo.via Frontier Cinematic Rendering](https://academy.siemens-healthineers.com/_/en-us/-syngo-via-frontier-cinematic-rendering).
- [Cinematic Rendering for Medical Imaging, white paper](https://cdn0.scrvt.com/39b415fb07de4d9656c7b516d8e2d907/1800000004349360/6658a1860496/DI_SY_CinematicRendering_1800000004349360.pdf) (2017) and the [syngo.via VB40A datasheet](https://cdn0.scrvt.com/39b415fb07de4d9656c7b516d8e2d907/1800000007083216/c1c4e00a1bc0/sy_syngo_via_vb40a_datasheet_1800000007083216.pdf): presets, the VRT gallery, editable transfer functions, clip plane slab, clip box, punching, movie export.
- Niedermayr, Neuhauser, Petkov, Engel, Westermann, [Novel view synthesis for Cinematic Anatomy on mobile and immersive displays](https://arxiv.org/abs/2404.11285) (2024): what a preset holds, the animation system, render times.
- Luijten et al., [Cinematic Reality on the Apple Vision Pro](https://www.frontiersin.org/journals/virtual-reality/articles/10.3389/frvir.2025.1666614/full), Frontiers in VR (2025): presets, clipping planes and boxes, light map settings; no segmentation or measurement.
- Niedermair et al., [On the added benefit of virtual anatomy for dissection-based skills](https://anatomypubs.onlinelibrary.wiley.com/doi/10.1002/ase.2234), Anat Sci Educ (2023): Cinematic Anatomy VA70A on JKU's 8K wall with a controller.
- Ars Electronica Futurelab, [Cinematic Anatomy x Deep Space](https://ars.electronica.art/futurelab/en/projects-virtual-anatomy/): keyframes set in Cinematic Rendering, Unreal Engine through its SDK, stereo on walls.
- Siemens Healthineers, [Cinematic Playground: instructions for use, 1.0](https://marketplace.teamplay.siemens-healthineers.com/api/download/media/Siemens%20Healthcare%20GmbH/1.0/Instruction_for_use_1.0.pdf) (2025): the Preset Editor, presets per segmented region, the DICOM segmentation organiser, render tasks.
- Zhou, Engel, Liu, Yu, Geiger, Lay, [Semantic cinematic volume rendering](https://patents.google.com/patent/US20170061672A1/en), US 2017/0061672 (Siemens).
- Undark, [Cinematic rendering: medical images go to the movies](https://undark.org/2016/07/01/medical-imaging-cinematic-rendering/) (2016): light maps photographed in real places.
- NiiVue, [cinematic render mode for CT and MR](https://github.com/niivue/mono/pull/473): label-modulated presets, MR tissue normalisation.
- Devkota et al., [Reference based colour transfer for medical volume rendering](https://arxiv.org/abs/2210.08083) (2022), and Azkue et al., [True-colour 3D rendering from cryosection data](https://onlinelibrary.wiley.com/doi/10.1111/joa.13647), J Anat (2022): colour from the Visible Human cryosections.
