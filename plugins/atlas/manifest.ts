/**
 * The atlas plugin's manifest: a segmentation's regions as a tree (the
 * Allen ontology's hierarchy, FreeSurfer's labels grouped), searched, shown
 * and gone to, and the region under the cursor.  Its code is ./plugin.ts;
 * the tree is ./hierarchy.ts, the label counts ./labels.ts (in a worker).
 */
import type { Manifest } from "@ngplatform/sdk";

export const ATLAS_PANEL = "atlas.panel";

export const ATLAS_MANIFEST: Manifest = {
  id: "org.ngplatform.atlas",
  name: "Atlas",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  description: "An atlas's regions as a tree (Allen CCF, FreeSurfer, Schaefer…): search a region, show it with its children, go to it, read the region under the cursor, and each region's volume.",
  guide: `The Atlas panel works on a segmentation layer (a label image) and its lookup table, the names and colours of its values.

## Atlas
- **Layer**: a segmentation layer in the scene.
- **Atlas**: the layer's own lookup table (Render › Lookup table), or one to give it: those that come with the app (FreeSurfer, Schaefer, Yeo, Harvard-Oxford), or the Allen Mouse CCFv3 ontology, downloaded from the Allen Institute when chosen.

## Regions
- **Under the cursor** names the region the pointer is over, with its path in the tree ("Isocortex › Somatomotor areas › Primary motor area").
- The tree: the Allen ontology's hierarchy, with acronyms; FreeSurfer's labels grouped (cerebral cortex, cerebral white matter, subcortical grey matter, cerebellum, brain stem, ventricles and CSF, other), each by hemisphere; Schaefer's parcellations by hemisphere, then network; other tables as a flat list. The caret opens a region. By keyboard: Up and Down move, Right and Left open and close, a letter jumps, Enter chooses.
- **Search** filters the tree by name, acronym or value. **Only regions in the image** hides regions with no voxels in the label image.

## Region
Click a region in the tree to choose it:
- **Show only**: it and all its descendants become the layer's visible segments; **Add to shown** adds them to those shown; **Show all** shows every segment again, meshes in 3-D too.
- **Go to**: moves to the region's voxel nearest its centre, with its progress and **Cancel**; a new Go to stops the last.
- Double-click a region: Show only and Go to.

## Volumes
The label image is counted once, in the background (at its finest level of at most 64 million voxels; Activity shows it, with Cancel): each region's volume, with its descendants', shows in the tree, and **Save CSV** writes them all. A count cancelled starts again with **Count again**, or when Go to needs it.`,
  license: "Apache-2.0",
  permissions: { network: ["https://api.brain-map.org"] },
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: ATLAS_PANEL, title: "Atlas", slot: "left", group: "Labels", order: 85 }],
    appState: { key: "atlas", version: 1 },
  },
};
