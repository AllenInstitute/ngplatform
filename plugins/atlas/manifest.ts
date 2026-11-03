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
  guide: `The Atlas tab works on a segmentation layer (a label image) and its lookup table, the names and colours of its values.

## Choosing the atlas
- **Layer**: a segmentation layer in the scene.
- **Atlas**: the layer's own lookup table (Render → Lookup table), or one to give it: those that come with the app (FreeSurfer, Schaefer, Yeo, Harvard-Oxford), or the Allen Mouse CCFv3 ontology, fetched from the Allen Institute when chosen.

## The tree
- **Allen CCF**: the ontology's hierarchy (grey matter › cerebrum › cortex › isocortex › …), each structure with its acronym.
- **FreeSurfer's labels**: grouped by their codes and names: cerebral cortex, cerebral white matter, subcortical grey matter, cerebellum, brain stem, ventricles and CSF, other; each split into left and right hemisphere.
- **Schaefer's parcellations**: by hemisphere, then network.
- **Other tables**: a flat list.

**Search** filters the tree by name, acronym or value. **Only in the image** hides regions with no voxels in the label image.

## A region
Click a region to choose it:
- **Show only**: it and all its descendants become the layer's visible segments; **Add** adds them to those shown; **Show all** clears the choice.
- **Go to**: moves to the region's voxel nearest its centre.

**Under the cursor** names the region the pointer is over, with its path in the tree ("Isocortex › Somatomotor areas › Primary motor area").

## Volumes
The label image is counted once (in the background, at its finest level of at most 64 million voxels): each region's volume, its own voxels and its descendants', shows in the tree, and **Save CSV** writes them all.`,
  license: "Apache-2.0",
  permissions: { network: ["https://api.brain-map.org"] },
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: ATLAS_PANEL, title: "Atlas", slot: "left", order: 85 }],
    appState: { key: "atlas", version: 1 },
  },
};
