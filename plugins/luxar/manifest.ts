/** The Luxar rendering plugin's manifest: read without loading its code. */
import type { Manifest } from "@ngplatform/sdk";

export const LUXAR_PANEL = "luxar.panel";
export const LUXAR_STATE_KEY = "luxar";

export const LUXAR_MANIFEST: Manifest = {
  id: "org.ngplatform.luxar",
  name: "Luxar rendering",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  description: "Draws chosen Zarr Vectors layers (and a segmentation's precomputed meshes) the way the Luxar viewer does (glowing HDR lines with mitred joins, tone mapped), in Neuroglancer's own 2-D and 3-D views.",
  guide: `Luxar renders lines and points as light: smooth thick lines with mitred joins, added up in HDR and tone mapped, or as emission and absorption. This plugin draws a Zarr Vectors layer (a tractogram, skeletons, a point cloud, or a \`.trk\`, \`.tck\`, \`.trx\` or SWC file opened in place) that way **in Neuroglancer's own views**: the 3-D view and the 2-D sections, in one viewer, with everything else drawn as before.

## Switching it on
- In the **Luxar** tab, tick a layer. That layer is then drawn by this plugin instead of by Neuroglancer; other layers (the image under a tractogram, say) are untouched, so a Luxar tractogram can sit on a plain or volume-rendered image.
- Or select the layer and run **Luxar rendering of the selected layer on or off** from the command palette.
- A precomputed segmentation with meshes (an EM segmentation such as MICrONS') is listed as **EM meshes: <layer> (N cells)**: ticked, the meshes of the segments the layer shows are drawn, read from its precomputed meshes as a Zarr Vectors mesh store, coarse levels of detail first.
- Hiding the layer hides its Luxar drawing too. Without this plugin, the same link shows the layer drawn by Neuroglancer as usual.

## Settings (per layer)
- **Blending**: *Glow* adds the lines' light up, hidden by what is in front; *Glow through* shows it over everything; *Emission and absorption* also darkens what is behind dense bundles; *Solid tubes* draws opaque shaded lines.
- **Colour**: by direction (x red, y green, z blue), each object its own colour, a vertex attribute through a colormap, or one colour.
- **Width** (pixels), **Brightness** (stops before tone mapping), **Sharpness** (soft to hard edged), **Tone map**.
- **2-D slab**: in a 2-D view, lines within half this distance of the section show, fading away from it.
- **Detail**: about how many vertices to read for a view. Like Neuroglancer, the plugin reads the coarsest level first and finer levels as you zoom in, only the chunks in view.

Nothing is converted and no files are written: the store (or the file read in place) is read directly.`,
  links: [
    { title: "Luxar (royerlab/luxar)", url: "https://github.com/royerlab/luxar" },
    { title: "This plugin's source", url: "https://github.com/AllenInstitute/ngplatform/tree/main/plugins/luxar" },
  ],
  license: "Apache-2.0",
  requires: { plugins: ["org.ngplatform.zarr-vectors"] },
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: LUXAR_PANEL, title: "Luxar", slot: "left", order: 55 }],
    commands: [
      { id: "luxar.toggle", title: "Toggle Luxar for the selected layer", group: "View", when: "sourceFormat == zarr-vectors" },
      { id: "luxar.show", title: "Show the Luxar rendering settings", group: "View" },
    ],
    appState: { key: LUXAR_STATE_KEY, version: 1 },
  },
};
