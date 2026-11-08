# Anatomical rendering

![S-21-46 (HiP-CT, 100 µm) path-traced on a workstation's GPU and drawn in the 3-D view](../images/plugins/anatomical-rendering.png)

**Kind:** tool · **Off by default** (offered when you open an image; or turn it on in the Plugins tab) · a
**Render** switch beside **Sections** in the 3-D view, and a **Render** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/anatomical-rendering)

Photorealistic views of an OME-Zarr image, path-traced on a GPU and drawn in
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
2. Pair the app with that runner (its link, or Jobs → **Add a computer…**).
3. Turn the plugin on, open the **Render** tab: the **Host** list shows the
   paired computers whose runner has the render service. Choose the image,
   then switch on **Render** (also beside **Sections** in the 3-D view).

## What you can set

- **Preset**: a look per modality: MR T1, HiP-CT, histology (BigBrain), a
  translucent one for any image, and **Regions** (each label in its
  colour). A preset is a transfer function (colour and opacity from the
  image's values) with material and light; its values are percentiles of
  the tissue, so one preset suits scans of different scaling.
- **Density** (opacity per mm), **Exposure**, and the key light's direction
  (relative to the camera, so the light follows as you turn the view).
- **Cuts**: planes through the current position across x, y or z, keeping
  either side, with an offset. Regions listed under **Kept through cuts**
  stay whole (vessels through a cut brain, say).
- **Regions**: colour by a co-registered OME-Zarr segmentation (its labels'
  FreeSurfer colours), how much of the region's colour to use, and regions
  to hide.
- **Detail**: how many voxels the host holds (400 million by default: the
  finest stored level within it). When a store has no level near the
  budget, a level is made by downsampling a finer one as it is read (means
  for images, majority vote for labels) and kept in a cache on the host.
- **Samples per pixel**: when a still view stops refining.
- **Movie**: **Add keyframe from the view** as you move, set each one's
  time, then **Render movie on the host**: every frame is path-traced to the
  sample count and the frames are encoded as an MP4 (H.264) on the host,
  then **Download**. Between keyframes the camera turns around the position;
  cuts, density, exposure and the light change smoothly.

## How it works

The renderer follows the published methods of Monte Carlo volume
rendering: free paths sampled by delta tracking against a grid of the
largest extinction in each 8³ brick (empty space is skipped), shadow rays by
ratio tracking (Novák et al. 2018); at each collision either surface
scattering with the gradient as normal or volume scattering with a
Henyey–Greenstein phase function, chosen by the gradient's magnitude (Kroes
et al. 2012); a directional key light and a sky-like environment; a thin-lens
camera; a filmic tone curve. Each pass adds one sample per pixel and the
image is their mean, so it refines while the view is still. While the
camera moves, frames are rendered at half size.

On an RTX A6000 a 834 × 684 view of a 135-million-voxel brain takes about
45 ms a pass (some 200 samples in 10 s); with region colours and a cut,
about 100–150 ms.

## Limits

- The image is placed by its OME-Zarr transforms in Neuroglancer's x, y, z
  (as the volume view does); a layer's own transform in the viewer is not
  applied yet.
- One image (and one segmentation) at a time; images with t or c axes are
  not rendered.
- Rendering is for looking, teaching and figures, not for reading values.
