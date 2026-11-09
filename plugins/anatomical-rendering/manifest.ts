/** The anatomical rendering plugin's manifest: read without loading its code. */
import type { Manifest } from "@ngplatform/sdk";

export const RENDER_PANEL = "anatomicalRendering.panel";
export const RENDER_STATE_KEY = "anatomicalRendering";

export const ANATOMICAL_RENDERING_MANIFEST: Manifest = {
  id: "org.ngplatform.anatomical-rendering",
  name: "Anatomical rendering",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  description:
    "Photorealistic views of an OME-Zarr image in the 3-D view, path-traced on a GPU: on this computer or on another reached over SSH, through the runner.",
  guide: `Path-traced ("cinematic") rendering of an OME-Zarr image, read straight from its store: light is followed through the tissue as it scatters, so surfaces get soft shadows and depth, and translucent tissue glows. It reads OME-Zarr and N5 images (not precomputed volumes). It runs on a GPU with CUDA, through the runner's **render** service: on this computer, or on a workstation or cluster node reached over SSH (see *Jobs on this computer*). Frames come back as they refine and are drawn in Neuroglancer's 3-D view, hiding what is behind the tissue.

## Starting it
1. Start a runner with the render service where the GPU is (\`--service render="python -m ngplatform_render.server"\`), and pair with it (Settings › Compute, or the link it prints; over SSH, \`python -m ngplatform_runner tunnel HOST\`).
2. In the **Anatomical** tool: **Remote** picks the computer; switch on **Render** at the top (also beside **Sections** in the 3-D panel). **Rendering** has the image, preset and region colours; **Lighting**, **Crops** (a clip facing the camera, clips across x, y, z, and boxes) and **Output** (stills, movies, splats) follow.

While the camera moves, the last picture stays in place in 3-D and moves with the view; it is rendered again when the camera stops (or, moving far, at half size).

## Settings
- **Preset**: a look per modality (MR, HiP-CT, histology, translucent) or by region (each label in its colour). **Density**, **Exposure** and the light's direction adjust it.
- **Crops**: a clip facing the camera (pinned or following), clips across x, y or z through the position, and boxes. Regions marked *kept* stay whole through them.
- **Detail**: how many voxels the GPU holds; levels the store does not have are made by downsampling and kept on the host.
- **Movie**: add keyframes from the view, then render a movie on the host (frames path-traced to a sample count, encoded as MP4).

Rendering is for looking, teaching and figures, not for reading values.`,
  links: [
    { title: "Kroes, Post & Botha 2012: Exposure Render", url: "https://doi.org/10.1371/journal.pone.0038586" },
    { title: "Novák et al. 2018: Monte Carlo methods for volumetric light transport", url: "https://doi.org/10.1111/cgf.13383" },
  ],
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: RENDER_PANEL, title: "Anatomical", slot: "left", order: 52 }],
    commands: [{ id: "anatomicalRendering.toggle", title: "Toggle anatomical rendering", group: "View" }],
    appState: { key: RENDER_STATE_KEY, version: 1 },
  },
};
