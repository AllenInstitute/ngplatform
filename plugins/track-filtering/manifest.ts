/** The track filtering plugin's manifest: read without loading its code. */
import type { Manifest } from "@ngplatform/sdk";

export const FILTERING_PANEL = "trackFiltering.panel";
export const FILTERING_STATE_KEY = "trackFiltering";

export const TRACK_FILTERING_MANIFEST: Manifest = {
  id: "org.ngplatform.track-filtering",
  name: "Track filtering",
  version: "0.3.0",
  kind: "tool",
  enabledByDefault: false,
  description: "Groups of the objects that pass through regions: tracts, segments or annotations. Each group is a layer.",
  guide: `TrackVis-style filtering for any dataset that is not an image: Zarr Vectors streamlines, skeletons, graphs or point clouds whose points belong to objects; segmentations; annotation layers. A **group** keeps the objects that pass through its regions, with attributes in range and the tags it keeps, and shows them as a layer of its own, in its own colour.

## Making a group
- **+ New group** in the Filtering panel (the Tools dock, under Vectors), then add regions: **spheres**, **boxes**, **disks** and **masks**, each **AND** (must pass through), **OR** (through one of the OR regions) or **NOT** (must not). With no group, the first region makes one. Alt+Shift+S puts a sphere at the mouse, Alt+Shift+B a box.
- Move a region with its sliders, or type a value in a box beside one: it applies on Enter or on leaving the box. **Move here** puts it at the views' centre, **Go to** takes the views to it; Alt-drag it in a view.
- On streamlines and skeletons a region can instead ask for **either end** or **both ends** of a track in it (TrackVis's endpoint modes).
- **Attributes** (length, FA, …): a minimum and a maximum each, over its histogram.
- **Stored groups** (the store's own groups and categories, as tags): **Keep** keeps only the objects in at least one kept group; **Leave out** drops those in any left-out group.
- The count is first previewed from a coarse level (marked ~), then made exact from level 0.
- Click a group's row to edit it; double-click its name, or the pencil, to rename it.

## Output
- **Export CSV**: the group's objects and their attributes, once the count is exact.
- **Save .trk**: the group's streamlines, whole, as a TrackVis file (all of them, or a level's sample). In Chrome and Edge it is written in batches straight to the file you choose, so a large group takes time (the reading dominates) but not memory; other browsers build the file in memory and download it.
- **Make density map**: how many of the group's streamlines pass through each voxel, at the **Density voxel** size (1 mm for a brain unless you choose another), shown as an image layer; **Save .nii** keeps it as a NIfTI file in the store's RAS+ millimetres.
- **Run on this computer**: with the runner on this computer paired (Settings → Compute), the group goes to a Python job that tests the whole tractogram there and writes a new .trk, a Zarr Vectors store with coarser levels and/or a density map, then opens them here; it shows in Activity. For tractograms too large to save from the browser. Regions (with their end modes), attribute ranges and tags all go with it.
- **Save groups into the store**: for a Zarr Vectors folder opened from this computer (in Chrome or Edge), every group with its exact answer is written into the store itself (level 0's \`groups\`, with names and counts, as zarr-vectors-py writes them), where other tools, and the viewer as tags, see them. A stored group of the same name is replaced; the store has its old groups or the new ones, never a mix.
- **Statistics**: each group's count and an attribute's mean ± SD and median; **Export CSV** gives every attribute's n, mean, SD, median and range for every group.

## How it scales
Regions read only the chunks they overlap, at level 0, cached as they are read, so a small region in a large tractogram is quick; a region covering the whole brain reads all of it. Attributes are held for every object (about 100 bytes each); a group of millions of objects is fine to show and save.`,

  links: [
    { title: "zarr-vectors-tools (convert TRK, TRX, TCK and skeletons)", url: "https://github.com/AllenInstitute/zarr-vectors-tools" },
    { title: "This plugin's source", url: "https://github.com/AllenInstitute/ngplatform/tree/main/plugins/track-filtering" },
  ],
  license: "Apache-2.0",
  requires: { plugins: ["org.ngplatform.zarr-vectors"] },
  activation: ["onView:trackFiltering.panel", "onCommand:trackFiltering.sphereAtMouse", "onCommand:trackFiltering.boxAtMouse"],
  contributes: {
    panels: [{ id: FILTERING_PANEL, title: "Filtering", slot: "left", group: "Vectors", order: 40 }],
    commands: [
      { id: "trackFiltering.show", title: "Show the track groups", group: "Filtering" },
      { id: "trackFiltering.newGroup", title: "New track group", group: "Filtering" },
      { id: "trackFiltering.addSphere", title: "Add a sphere region to the group being edited", group: "Filtering" },
      { id: "trackFiltering.addBox", title: "Add a box region to the group being edited", group: "Filtering" },
      { id: "trackFiltering.sphereAtMouse", title: "A sphere region at the mouse (a new group if none is edited)", group: "Filtering" },
      { id: "trackFiltering.boxAtMouse", title: "A box region at the mouse (a new group if none is edited)", group: "Filtering" },
      { id: "trackFiltering.exportCsv", title: "Export the edited group's objects as CSV", group: "Filtering" },
      { id: "trackFiltering.saveTrk", title: "Save the edited group's streamlines as .trk", group: "Filtering" },
      { id: "trackFiltering.densityMap", title: "Make a density map of the edited group's streamlines", group: "Filtering" },
      { id: "trackFiltering.runOnComputer", title: "Run the edited group on this computer (a job writing a .trk, store or density map)", group: "Filtering" },
      { id: "trackFiltering.exportStatistics", title: "Export every group's statistics as CSV", group: "Filtering" },
    ],
    keybindings: [
      { key: "alt+shift+s", command: "trackFiltering.sphereAtMouse" },
      { key: "alt+shift+b", command: "trackFiltering.boxAtMouse" },
    ],
    appState: { key: FILTERING_STATE_KEY, version: 2 },
  },
};
