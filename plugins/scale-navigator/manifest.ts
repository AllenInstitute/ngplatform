/** The scale navigator's manifest: read without loading its code. */
import type { Manifest } from "@ngplatform/sdk";

export const SCALE_NAVIGATOR_STATE_KEY = "scaleNavigator";

export const SCALE_NAVIGATOR_MANIFEST: Manifest = {
  id: "org.ngplatform.scale-navigator",
  name: "Scale navigator",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: true,
  description: "Moves between image layers that nest in space, as a HiP-CT overview and its zooms do: a breadcrumb and the pyramid level in the status line, and boxes in the views where finer layers lie.",
  guide: `For images that lie inside one another, at finer resolutions: a HiP-CT whole organ at 20 µm with local zooms at 6.5, 2 or 1 µm inside it, or any layers that nest in space. It reads only where each image layer lies and how fine its voxels are, from the layers themselves.

## Breadcrumb
On the right of the status line, below the views: the image layers whose boxes hold the position, coarse to fine, each with its voxel size (\`organ 19.6 µm › VOI-01 6.5 µm › VOI-01a 2 µm\`). The layer the views are on (the selected one, else the finest shown) is in the strong white, hidden layers quiet. Click one to frame it: the views centre on it and zoom to fit it, and it becomes the selected layer. A long chain is cut short at its left; its tooltip holds all of it.

## Level
Beside the breadcrumb: the level of the selected image layer's pyramid (else the finest shown one's) that Neuroglancer draws in the sections at this zoom, and its voxel size: \`level 3/6 · 313 µm\` is the fourth of six levels, counted from 0, the finest, as the stores name them (s0, s1…). It is read from Neuroglancer's own resolution histogram, as **Resolution (slice)** in the layer's Rendering tab shows it; while a finer level is loading, its tooltip says so. When no section draws the layer (a 3-D view without sections), the level is worked out from the zoom as Neuroglancer would choose it, and marked \`≈\`.

## Zoom boxes
In the 2-D and 3-D views, a grey box where each image layer lies inside a coarser one, labelled with its name and voxel size, while a layer it lies in is shown and the box is more than a few pixels across. Point at one to highlight it; click its line or its label to frame that layer. **Zoom boxes** beside **Sections** in the 3-D view shows or hides them.

## Keys
- **Alt+↑**: frame the next coarser layer at the position (the one the views' layer lies in).
- **Alt+↓**: frame the next finer one; outside every zoom, the nearest zoom inside the layer the views are on.
- *Frame the selected layer* is in the command palette.

Nothing is read from a dataset's own metadata about other datasets: two scans nest when their boxes do in the scene. Zooms that carry no registration to their overview start at the origin, as it does, so they sit in its corner until they are placed where they were scanned (a layer's transform).`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    commands: [
      { id: "scaleNavigator.coarser", title: "Go to the coarser layer of the hierarchy", group: "View" },
      { id: "scaleNavigator.finer", title: "Go to a finer layer of the hierarchy", group: "View" },
      { id: "scaleNavigator.frame", title: "Frame the selected layer", group: "View" },
      { id: "scaleNavigator.boxes", title: "Show or hide zoom boxes", group: "View" },
    ],
    keybindings: [
      { key: "alt+arrowup", command: "scaleNavigator.coarser" },
      { key: "alt+arrowdown", command: "scaleNavigator.finer" },
    ],
    appState: { key: SCALE_NAVIGATOR_STATE_KEY, version: 1 },
  },
};
