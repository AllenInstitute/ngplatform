# Atlas

![FreeSurfer's aparc+aseg in the Atlas tab: the left precentral gyrus shown and gone to](../images/plugins/atlas.png)

**Kind:** tool · **Off by default** (offered when you open a segmentation with a lookup table; or turn it on in the Plugins tab) · the
**Atlas** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/atlas)

The regions of a segmentation (a label image) as a tree, from its lookup
table: the Allen Mouse CCF ontology's hierarchy, FreeSurfer's labels
grouped, or a table's list. Search for a region, show it with all its
parts, go to it, see which region is under the pointer and where it sits
in the hierarchy, and read each region's volume.

## Using it

1. Open a segmentation: a FreeSurfer `aparc+aseg.mgz` or `aseg.mgz`, a
   NIfTI label image, an OME-Zarr or precomputed segmentation.
2. In the Atlas tab choose the **Layer**, and its **Atlas** if it has
   none: the tables that come with the app (FreeSurfer, Schaefer, Yeo,
   Harvard-Oxford) or the Allen Mouse CCFv3 structures, downloaded from the
   Allen Institute when chosen. The table becomes the layer's own (the same
   as Render → Lookup table): its colours and names show in the views and
   the Segments tab.
3. The tree:
   - **Allen CCF**: the ontology's hierarchy (Basic cell groups and regions
     › Cerebrum › Cerebral cortex › … › Isocortex › Somatomotor areas ›
     Primary motor area › Layer 1), with acronyms.
   - **FreeSurfer's labels**: grouped by their codes and names into
     cerebral cortex, cerebral white matter, subcortical grey matter,
     cerebellum, brain stem, ventricles and CSF, and other; each split into
     left and right hemisphere.
   - **Schaefer's parcellations**: by hemisphere, then network.
   - **Other tables** (Harvard-Oxford, Yeo, a file of your own): a flat
     list.

   **Search** filters by name, acronym or label value. **Only regions in
   the image** hides those with no voxels in this label image.
4. Click a region, then:
   - **Show only**: the region and everything under it become the layer's
     visible segments; **Add** adds them to those shown; **Show all** shows
     every segment again.
   - **Go to**: moves the views to the region's voxel nearest its centre.
   - Double-click a region to show it and go to it.
5. **Under the cursor** names the region the pointer is over and its path,
   e.g. "Isocortex › Somatomotor areas › Primary motor area".
6. Volumes: the label image is counted once, in the background (its finest
   level of at most 64 million voxels; the tab says which). Each region's
   volume, with everything under it, shows in the tree; **Save CSV** writes
   every region's voxels and volume, its own and with its parts.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
