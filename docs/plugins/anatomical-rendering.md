# Anatomical rendering

![S-21-46 (HiP-CT, 100 µm) path-traced on a workstation's GPU and drawn in the 3-D view](../images/plugins/anatomical-rendering.png)

**Kind:** tool · **Off by default** (offered when you open an OME-Zarr or N5 image; or turn it on in the Plugins panel) · a
**Render** switch beside **Sections** in the 3-D view, and the **Anatomical** panel in the Tools dock ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/anatomical-rendering)

Photorealistic views of an OME-Zarr or N5 image (not precomputed volumes such as EM), path-traced on a GPU and drawn in
Neuroglancer's 3-D view. Light is followed through the tissue as it
scatters, so surfaces get soft shadows and depth and translucent tissue
glows, in the manner of "cinematic rendering". The image is read straight
from its OME-Zarr store; nothing is converted.

It renders in one of two places:

- **On a host**: the runner's **render** service, on a computer with an
  NVIDIA GPU (CUDA): this computer, a workstation or a cluster node reached
  over SSH (see [Jobs on this computer](../guide/local-jobs.md)). Frames come
  back as they refine; the browser only draws them.
- **In this browser**: the same path tracer in WebGPU, on this computer's own
  GPU, for a laptop with a GPU and no host. It holds a coarser level (up to
  64 million voxels) and has no region colours.

## Starting it

Images are OME-Zarr (0.4–0.6) or N5 multiscales (`n5://…`, as the Human
Organ Atlas serves most of its scans; on a host).

1. Where the GPU is, start a runner with the render service, in a Python
   with `numpy`, `zarr` (3), `fsspec`, `aiohttp`, `pillow` and `cupy`:
   ```
   cd ngplatform/runner
   python -m ngplatform_runner --root ~/data \
     --service render="python -m ngplatform_render.server"
   ```
   On another computer, add `--public-url http://localhost:7000` and open the
   tunnel from the computer with the browser:
   `python -m ngplatform_runner tunnel me@workstation` (it prints the pairing
   link). On a cluster, start the runner inside an interactive GPU job and
   tunnel through the login node (`--jump`).
2. Pair the app with that runner: its link, or **Settings › Compute**
   (**This computer**, or **Add a computer (SSH)…**; **Pair a computer…** in
   the panel's **Remote** card opens it). Addresses and tokens are kept
   there, for every function, not per image.
3. Turn the plugin on and open the **Anatomical** panel in the Tools dock. Switch on
   **Render** at the top (also beside **Sections** in the 3-D view); the
   line under it shows work under way (the image loading), or the
   error when something has gone wrong, with **Retry**. **Remote** picks the **Computer**:
   **Automatic** (Compute's choice, else the first computer with the render
   service ready) or one of the paired computers whose runner has the
   render service.

The panel's cards: **Remote** (where it renders), **Rendering** (image,
preset, colours, density, exposure), **Regions** (on a computer), **Quality**
(how much of the image the GPU holds, detail, samples, and what is rendered
now), **Lighting**, **Crops** (a clip facing the camera, clips across x, y
and z, and boxes), **Output** (the size of stills and movies, and stills),
**Movie** (keyframes and rotations) and **Splat**. Each
stays open or closed as you leave it. The row under the switch turns the
view: **Centre** on the tissue, or from each side of the image (see
**View** below).

Before it opens an image, the panel checks its axes. A 2-D image is not
rendered (it says so under **Image**). On a computer, an image with several
channels or time points renders one of each: **Rendering** then has a
**Channel** choice and a **Time point** slider (numbered from 0, as
Neuroglancer numbers them). Choosing another opens a new session on the
computer, kept with the scene as one undo step. This browser's renderer
takes images with one of each only.

## What you can set

- **Preset**: a look per modality: MR T1, HiP-CT, histology (BigBrain), a
  translucent one for any image, and **Regions** (each label in its
  colour). A preset is a transfer function (colour and opacity from the
  image's values) with material and light; its values are percentiles of
  the tissue, so one preset suits scans of different scaling.
- **HiP-CT organs**: a preset for each organ in the Human Organ Atlas (brain,
  heart, lung, kidney, liver, spleen, colon, eye, placenta, prostate, testis,
  uterus), its colours measured on photographs of real organs (each preset
  lists them, with their authors and licences). These presets spread their
  colours over a **Window** of the image's values, as a window is set in a
  viewer. HiP-CT organs lie in a mounting medium (ethanol and agar) that can
  fill most of the scan and be denser or less dense than the tissue, so
  percentiles do not suit them. The host guesses the window: from just past
  the medium (seen in a ring inside the scan's sides), on the side of it
  where the tissue is, with the tissue's commonest value at the window's
  middle. Change the two values if the guess misses; **Guess** goes back to
  it. Each organ preset also records its tissue's histogram on the scan it
  was made on (its percentiles), and on another scan its colours are placed
  at the same percentiles of that scan's tissue (histogram matching): HiP-CT
  values are not calibrated and vary between scans, but an organ's
  histogram keeps its shape (a brain's two peaks, grey and white matter).
  A window set by hand is used as it is. **Hide the jar** renders only a cylinder about the scan's axis, which
  leaves out the jar's wall (as dense as tissue).
- **Colourmap** (on a host, once the image is open): the image's histogram (grey,
  log counts) with the preset's colourmap and opacity curve over it, at
  the image's own values. Drag a control point left or right to move it
  (the stops between its neighbours follow) and up or down to change its
  opacity; double-click it to choose its colour; Ctrl-click to add a point,
  right-click to remove one. **Shift** moves the whole map along the
  values, **Compress** narrows or widens it about its middle. Under the
  histogram, blue triangles hold it at its percentiles: drag them to slide
  and warp the histogram under the colours (the image's values are remapped
  before they are coloured, piecewise linearly between the triangles). The tuning is
  kept per image (with the scene), **Reset** returns to the preset, and
  **Save as a preset file** writes the tuned map (at this image's values)
  to load again.
- **Density** (opacity per mm), **Exposure** and the other settings are
  sliders with their numbers beside them (a budget applies when its slider
  is let go); and the key light's direction
  (set relative to the camera; it then stays fixed to the image as you turn
  the view about it, until you set it again).
- **Lighting** (on a host): a style, **Studio** (a photographer's studio),
  **Soft** (light from all round, faint shadows), **Hard** (one strong light,
  deep shadows) or **Sky** (daylight), or as set by hand: the key light's
  direction (around the view and up, sliders, from the camera when set) and
  the strengths of the key light and of the light from all round.
- **Light map** (on a host): image-based light from an HDR panorama
  (studio, photo studio, sky; CC0 images from [Poly Haven](https://polyhaven.com),
  reduced to 256 × 128), turned about the view's vertical; or the preset's
  sky colours.
- **View** (the row under the switch): turn the 3-D view to look from
  each side of the image. When its OME-Zarr metadata gives each axis an
  anatomical orientation (`"orientation": {"type": "anatomical", "value":
  "left-to-right"}`), the buttons are named by side (L, R, A, P, S, I, and
  D, V and the like for other anatomy) and keep superior up; otherwise they
  are named by axis (**+x**, **−x**, …: from +x looks towards −x; in RAS,
  +x is right, +y anterior and +z superior).
- **Boxes** (Crops): as many as eight, each with a name, a switch, keeping
  its inside or cutting it out (fractions of the volume along x, y and z,
  sliders): what shows is inside any crop that keeps and in none that cuts
  out (in this browser's renderer, only the first that keeps).
- **Camera plane** (Crops): a clip across the view, an offset in mm past the
  position, keeping what lies beyond it; it turns with the camera, or
  **Pin** keeps it at the angle it has now (an oblique clip), and
  **Follow** lets it turn again. A clip turned on starts through the
  point the cursor was last over in the 3-D view (on the rendered tissue),
  and **Move to the cursor** moves the clips that are on there.
- **Axis planes** (Crops): clips through the current position across x, y or z, keeping
  either side, with an offset in mm (a slider or a number). Regions listed under **Kept whole** (Regions)
  stay whole (vessels through a cut brain, say).
- **Regions** (on a host): **Colour by region** with a co-registered OME-Zarr segmentation (its labels'
  FreeSurfer colours), how much of the region's colour to use, regions
  to hide, and regions kept whole through crops. This browser's renderer has no region colours, so the card is hidden there.
- **Whole volume**: how many voxels of the whole image the host holds (400
  million by default: the finest stored level within it). When a store has
  no level near the budget, a level is made by downsampling a finer one as
  it is read (means for images, majority vote for labels) and kept in a
  cache on the host.
- **Finer detail** (on a host; on by default): when the view
  comes close, the region in view is read at a finer stored level and
  rendered from it, while the rest of the volume stays at the whole
  volume's level, so shadows and light scattered from outside the view
  still come from it. The level is the finest whose region fits **Detail**
  (200 million voxels by default) and is no finer than a
  pixel there. The region is what the view meets, with some depth behind
  the surface and a margin; it is read in the background (the line under
  **Samples per pixel** says so) while the whole volume's level is shown, chunk by chunk through
  a cache in the host's memory (8 GB; `NGP_RENDER_CHUNK_CACHE_GB`), so a
  view moved a little reads only the chunks it had not. Reading starts while
  the camera is still moving (from what the view is coming to, planned at
  its full size), and a large region is read at the next coarser level
  first, so the view sharpens in a second or two and again when the finer
  level comes. When a level comes, the picture shown stays until the new
  one has as many samples (up to 24, or 2 s), then fades into it. A view
  that needs no finer level lets the detail go. Stills use the detail held
  for the view; movies use the whole volume's level.
- **The image in the 3-D view** is an object in the view's space, drawn
  in this browser with every frame's camera: it turns, pans and zooms with
  the view at once, and meshes, tracts and sections go behind and in front
  of it as they should. It is one level of the image (up to 32 million
  voxels), with its light path-traced into it in this browser over a few
  seconds after the light, preset or cuts change (**Quality** says how far:
  "light 12 of 47 passes"); until then it is lit more simply. Turning the
  view does not light it again: the light is the object's.
- **Path-traced picture when still** (Quality; off by default): once the
  camera rests, the host's path-traced picture of the view, at the image's
  full detail, comes in over the object, and goes as soon as the camera
  moves. Off, the host renders only stills, movies and splats (lit as the
  object is), and **Finer detail** (which follows the views sent) is not used.
- **Samples per pixel**: when a still view stops refining. Under it, the
  level held and the last frame's samples, size and time a pass.
- **Load…** (beside Preset): a preset (or a list) as JSON, in the form of
  `runner/ngplatform_render/presets/*.json`; it is kept with the scene.
- **Save still (PNG)** (Output): the view now, path-traced on the host at the
  output's size and twice its samples, as a job: its progress in the Output
  card (with **Cancel**) and in Activity; it downloads when done. Width × height × samples is
  kept within 8192² × 256.
- **Movie**: **Add keyframe** as you move, set each one's time (**Go to**
  moves the view back to a keyframe, **Replace** puts the view now in its
  place, the arrows move it earlier or later), then **Preview movie…**: a small, quick version (about 384 pixels, 8
  samples, 12 frames a second) plays in a window. From there **Render the
  movie** starts the movie itself as a job, its progress in the Movie card (with
  **Cancel**) and in Activity; the view stays live while it
  renders (its passes go to the GPU one at a time beside the view's). Every
  frame is path-traced to the sample count and encoded as an MP4 (H.264)
  on the host, and downloads when done. Between keyframes the camera turns
  around the position; clips, density, exposure and the light change smoothly.
- **Rotation** (Movie): a turn about the position from the view now, about
  the vertical or the horizontal, a full or half turn, by a step in
  degrees; **Preview rotation…** works as the movie's preview.
- **Jobs**: stills, movies and splats are listed in their cards and kept
  in this browser: after a reload the list comes back, those still running
  on the computer are followed again (in Activity too), and finished ones
  can be downloaded while the computer keeps them.
- **Splat** (for the web, phones and VR): **Make splat**
  path-traces the look now from all round the position (**views**, each
  **size** pixels along its longer side at **samples**; **from** every side,
  this half, or near this side; a quarter of them closer in), then fits
  3-D Gaussians to them (**fit steps**; 0 makes the views only). It shows
  as a job in the Splat card; **View** opens the result in a sheet (drag to
  turn, right or shift drag to move, wheel to come closer) with downloads
  of the `.splat` and `.ply`, and **Open file…** opens one from
  this device. What would differ from view to view is held still: the
  light where it is now (in world space), no lens blur, no smoothing; cuts
  facing the view stay where they are. A splat is fitted to one scene: a
  change to the preset, colours, light or cuts needs a new one. 256 views
  at 1024 pixels and 512 samples take roughly 50 minutes on an RTX A6000
  for a whole brain, and the fit 15 to 30 minutes more.

  The fit needs torch and gsplat in a Python of their own: start the render
  service with `--splat-python PATH` (or set `NGP_SPLAT_PYTHON`); see
  `runner/README.md` for making that Python (gsplat 1.4.0, which builds its
  CUDA kernels with nvcc the first time, in about 4 minutes). Without
  one, the views are still made, and the folder (images, `cameras.json`,
  nerfstudio's `transforms.json`, `points.ply`) can be fitted later with
  `python -m ngplatform_render.splat.fit FOLDER` or another splat trainer.

## The HiP-CT organ presets

Each organ's tissues were given colours measured on openly licensed
photographs of real organs: 75 photographs from many photographers (4 to 8
an organ) with each tissue marked by boxes, of which 54 are used (not those
with strong casts and nothing neutral, animal fat where human is shown, or
fixed tissue where fresh is shown for a fresh look); photographs with
something neutral in them (a steel table, paper, a white background)
white-balanced on it. Each photograph's own exposure and cast are taken
out by fitting every tissue's colour together with an offset per
photograph (photographs showing two tissues fix the difference between
them, as grey and white matter on one brain slice), and each photograph
counts once. A tissue then has a dark, a middle and a light shade (the
25th, 50th and 75th percentiles of its lightness), spread across its band
of the image's values, and the colour runs smoothly (in Lab) from one
tissue to the next, so the image's own texture shows as shades of the
tissue rather than one flat colour. Each colour was then made into a material colour by
rendering a flat slab of tissue under the renders' light (the photo-studio
map and the key light) and tone curve, and changing the material until the
slab shows the photograph's colour relative to its white. Multiple
scattering darkens and saturates colour, so the material colours are
darker than the photographs'. Each preset lists its photographs (author,
licence, what they show, and caveats) under `reference`, and the colour
measured for each tissue under `measured`.

Few photographs of normal fresh human organs are openly licensed. Animal
organs stand in for the kidney and eye (pig) and the testis (bull). The
brain and uterus are fixed specimens, as HiP-CT organs are. The colon was
measured on colonoscopy views of its lining. The heart, liver and spleen
photographs have warm or pink casts. Tissues no usable photograph shows
were given a colour by hand and are marked "not measured".

| Organ | HiP-CT scan (Human Organ Atlas) | Photographs the colours were measured on | Not measured |
|---|---|---|---|
| brain | LADAF-2021-64 brain | [Human brain frontal (coronal) section.JPG](https://commons.wikimedia.org/wiki/File:Human_brain_frontal_(coronal)_section.JPG) (John A. Beal, PhD, Dept. of Cellular Biology & Anatomy, LSU Health Sciences Center Shreveport, CC BY 2.5, fixed (appearance of a formalin-fixed brain slice; not stated on the file page)) | — |
| heart | LADAF-2021-17 heart | [Пересаженное сердце в грудной клетке реципиента.JPG](https://commons.wikimedia.org/wiki/File:%D0%9F%D0%B5%D1%80%D0%B5%D1%81%D0%B0%D0%B6%D0%B5%D0%BD%D0%BD%D0%BE%D0%B5_%D1%81%D0%B5%D1%80%D0%B4%D1%86%D0%B5_%D0%B2_%D0%B3%D1%80%D1%83%D0%B4%D0%BD%D0%BE%D0%B9_%D0%BA%D0%BB%D0%B5%D1%82%D0%BA%D0%B5_%D1%80%D0%B5%D1%86%D0%B8%D0%BF%D0%B8%D0%B5%D0%BD%D1%82%D0%B0.JPG) (Vasily I. Kaleda, CC BY-SA 3.0, fresh (living, in situ)); [Human heart male adult autopsy.jpg](https://commons.wikimedia.org/wiki/File:Human_heart_male_adult_autopsy.jpg) (Jebulon, CC0 1.0, unknown (autopsy specimen; fixation not stated)) | valves and fibrous tissue |
| lung | LADAF-2020-27 left lung | [Normal lung (3661495238).jpg](https://commons.wikimedia.org/wiki/File:Normal_lung_(3661495238).jpg) (Yale Rosen, CC BY-SA 2.0, formalin-fixed (formalin-perfused, autopsy)); [Lungs filled with air.jpg](https://commons.wikimedia.org/wiki/File:Lungs_filled_with_air.jpg) (Pöllö, CC BY 3.0, fresh) | — |
| kidney | LADAF-2020-27 left kidney | [Pig-kidney.JPG](https://commons.wikimedia.org/wiki/File:Pig-kidney.JPG) (Thor-Rune Hansen, Public domain (PD-self), fresh) | — |
| liver | LADAF-2021-17 liver | [Human Hepar.jpg](https://commons.wikimedia.org/wiki/File:Human_Hepar.jpg) (Suseno, Public domain (PD-self), fresh (autopsy)) | — |
| spleen | LADAF-2020-27 spleen | [Gross pathology of an accessory spleen.jpg](https://commons.wikimedia.org/wiki/File:Gross_pathology_of_an_accessory_spleen.jpg) (Mikael Häggström, M.D., CC0 1.0, partially fixed (fixed grey outer rim, unfixed red-purple centre, per file description)); [Spleen.jpg](https://commons.wikimedia.org/wiki/File:Spleen.jpg) (Hic et nunc, CC BY-SA 3.0, fresh (living, in situ)) | — |
| colon | LADAF-2021-17 colon | [Colonoscopy splenic flexure.jpg](https://commons.wikimedia.org/wiki/File:Colonoscopy_splenic_flexure.jpg) (melvil, CC BY-SA 4.0, fresh (living, colonoscopy)); [Rectum-2016-12.jpg](https://commons.wikimedia.org/wiki/File:Rectum-2016-12.jpg) (melvil, CC BY-SA 4.0, fresh (living, colonoscopy)) | — |
| eye | LADAF-2024-38 right eye | [Eye pig cut open.jpg](https://commons.wikimedia.org/wiki/File:Eye_pig_cut_open.jpg) (Carsten Niehaus, Public domain (PD-self), fresh); [Schweineauge.jpg](https://commons.wikimedia.org/wiki/File:Schweineauge.jpg) (Honge, Public domain (PD-user-de), fresh (2 days after slaughter)) | — |
| placenta | MR-1 placenta | [Human placenta baby side.jpg](https://commons.wikimedia.org/wiki/File:Human_placenta_baby_side.jpg) (Habj, Public domain (PD-self), fresh (minutes after birth)); [Human placenta uterine side.jpg](https://commons.wikimedia.org/wiki/File:Human_placenta_uterine_side.jpg) (Ravedave, Public domain (PD-self), fresh (minutes after birth)) | — |
| prostate | LADAF-2021-17 prostate | [Prostate middle lobe orig.jpg](https://commons.wikimedia.org/wiki/File:Prostate_middle_lobe_orig.jpg) (Steven Fruitsmaak, CC BY-SA 3.0, fresh (surgical specimen)) | glandular tissue, calcification |
| testis | LADAF-2021-17 testis | [Bull testicles Бычий семенник 1.jpg](https://commons.wikimedia.org/wiki/File:Bull_testicles_%D0%91%D1%8B%D1%87%D0%B8%D0%B9_%D1%81%D0%B5%D0%BC%D0%B5%D0%BD%D0%BD%D0%B8%D0%BA_1.jpg) (Jurfeld, CC BY-SA 4.0, fresh) | parenchyma |
| uterus | AUMC-005 uterus | [Uterus in museum.jpg](https://commons.wikimedia.org/wiki/File:Uterus_in_museum.jpg) (Tiia Monto, CC BY-SA 3.0, fixed/preserved museum specimen (method not stated)) | — |

The brain has two presets. **Brain (fixed)** is a formalin-fixed brain, as
HiP-CT's are (tan grey matter, cream white matter). **Brain (fresh frozen)**
shows the same scan as fresh or fresh-frozen tissue looks: pink-tan grey
matter, pink-white white matter and red vessels. It was measured on the
unfixed centres of a part-fixed brain (Häggström, CC0); the cortex takes
the unfixed deep grey matter's colour, and the vessels take blood measured
on the heart photograph. Both brain presets were calibrated on a cut face
(light scattered within the tissue), since their photographs are slices;
the others were calibrated on a surface.

Lungs: at the 0.34 mm of a whole-organ scan the alveoli are finer than a
voxel and the parenchyma has the mounting medium's value, so the lung
preset shows the vessels and airways, with the parenchyma only as a faint
haze.

## How it works

The renderer follows the published methods of Monte Carlo volume
rendering: free paths sampled by delta tracking against a grid of the
largest extinction in each 8³ brick (empty space is skipped), shadow rays by
ratio tracking (Novák et al. 2018); at each collision either surface
scattering with the gradient as normal or volume scattering with a
Henyey–Greenstein phase function, chosen by the gradient's magnitude (Kroes
et al. 2012); a directional key light and a sky-like environment; a thin-lens
camera; a filmic tone curve. Where a preset asks for it (`surface_inset`, in
voxels), a collision takes its colour a voxel or two inwards along the
gradient, on the more opaque side, so a surface shows the tissue beneath it
rather than the values between it and the medium around it (which would
otherwise colour a kidney's capsule as fat). Each pass adds one sample per pixel and the
image is their mean, so it refines while the view is still. Frames made
while the camera moves (see below) are half size, and for the first 12
samples after a change the host smooths the image with an edge-avoiding
wavelet filter guided by the distance to the tissue (about half the error at
4 samples; **Denoise** switches it off).

Each frame comes with the distance along each pixel's ray to where it meets
tissue, and the page draws it as a surface in space (a vertex a pixel) with
the camera it has now, not as a flat picture. While the camera moves
(dragging, the wheel, or the turn that carries on after a drag) the picture
stays where the tissue is and moves with the view, and nothing new is
rendered; when the camera has been still for 200 ms, the view is rendered
again at full size. Only a camera that goes far from the picture's (turned
more than 20°, twice as near or far, or the position near the picture's
edge) gets quick half-size pictures while it moves, each placed in space
too. A frame is never drawn stuck to the screen in place of one placed in
space. While the camera is away from the picture's, a fold's edge shows a
brief gap rather than a stretched skin.

While the camera moves, frames are made for speed, then the still view is
refined, without the picture jumping:

- **Moving** (half size): tracking through dense tissue steps a voxel at a
  time, summing optical depth, and finds the collision by bisection, so a
  pass costs what the voxels crossed cost, not what the density does (a
  little darker than exact tracking: 2–3% at the presets' densities), with
  as many bounces as a still view (fewer made the moving frames darker, a
  change of colour each time the camera stopped).
- **Still**: the first 32 samples are tracked as the moving frames are, then
  exact delta and ratio tracking adds to them, so the image comes several
  times sooner and goes over smoothly to the exact one.
- When the camera stops (or the look changes), the picture shown stays
  until the still view has 12 samples (or 0.4 s), past the smoothing of the
  first frames; then each new frame of the same camera fades in over the one
  before, in the page, over a quarter of a second.
- A pass is one launch over the whole frame, cut short when a new view comes
  (the blocks not yet started return at once). Passes in bands of rows,
  as before, left the GPU idle at the end of every band and took up to
  three times as long.
- Each brick of 4 voxels that empty space is skipped by is bounded by its
  values and the one voxel around it (not its neighbours' whole bricks), so
  a speck of noise in the mounting medium does not slow every ray through
  it.
- Frames come as a JPEG and a deflated alpha plane (the colour divided by
  the alpha on the GPU); the first frame of each view also carries its
  points (every second pixel's distance, as half floats), so a moving view
  costs one request a frame.
- A session no page is waiting on (a closed tab) stops rendering after 5 s,
  and goes on when one asks. The page closes its session when it closes,
  and when another computer is chosen or **Reconnect** is pressed; one
  nothing has asked about for 3 minutes is closed on the host all the same,
  and the page opens a new one if it is still there.
- The render computer shares one GPU budget between every session and job
  (all its tabs and users). **Remote** shows it, with the queue, as
  "GPU: 12.3 of 38 GB in use · 1 job running". When a new session (or a
  larger view) would not fit, the line says "The render computer's GPU is
  busy (needs 900 MB, 300 MB free). Retry, or close another view."; close
  another tab's view or wait for a job, then **Retry**. Nothing is retried
  by itself.
- Stills, movies and splats run one at a time on the render computer. One
  waiting its turn is listed with its place ("Still: waiting, 2 jobs
  ahead"), and at its turn it may wait for GPU memory ("waiting for GPU
  memory (…)"), also in Activity. With 8 waiting already, a new one is
  refused ("Too many jobs waiting on the render computer"); when the
  computer's disk is nearly full it is refused too ("The render computer's
  disk is nearly full (needs 2.0 GB, 900 MB free)"); the line says which,
  with **Retry**. A job too large ever to fit the budget is refused with
  the computer's reason: make it smaller.
- **Splat** shows the computer's warning when its gsplat is not the version
  the fit is written for.
- A session that runs the GPU out of memory stops and lets its memory go;
  the line says so, and **Retry** opens it again (with a smaller **Whole
  volume**, say). A computer that stops answering is asked again less and
  less often for about a minute, then the line says so.
- One request is kept within limits: sides of 8–8192 pixels, up to 4096
  samples, movies at 1–120 frames a second with even sides (H.264), and a
  movie's frames and pixels within what the host allows. Movies need
  `ffmpeg` on the render computer; the panel says so when it has none.

On an RTX A6000, zooming into S-21-46 (HiP-CT, 19.6 µm, its 400-million-voxel
level held whole, finer detail where the view looks) in a 1200 × 800 view:
moving frames about 25–30 ms from the view sent to the frame; still passes
15–50 ms (whole brain to the cut face up close) where they were 15–400 ms;
and the picture shown changes by at most about one grey level in 255 from
one screen refresh to the next while the camera is still (it was 9–17,
from noisy first frames and detail coming in at once).

## Limits

- The image is placed by its OME-Zarr transforms in Neuroglancer's x, y, z
  (as the volume view does); a layer's own transform in the viewer is not
  applied yet.
- One image (and one segmentation) at a time, and one channel and time
  point of it (chosen in **Rendering**, on a computer).
- Rendering is for looking, teaching and figures, not for reading values.
- Finer detail comes from one stored level at a time, and only on a host:
  the browser's renderer holds one level.
