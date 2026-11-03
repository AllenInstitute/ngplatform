# Volume view

![A template drawn as a solid, cut open at the position](../../docs/images/plugins/volume-rendering.png)

In place of Neuroglancer's 3-D panel: a solid brain ray-marched in WebGL2
from an OME-Zarr pyramid, with the octant facing the camera cut away at the
current position, sections from finer levels on the cut faces, and the
visible track groups drawn through the cut.

The cut's faces show three sections of the plugin's own: Neuroglancer
`crossSections` in the layout (xy, xz and yz through the position), whose
zoom follows the 3-D view's down to the image's finest voxel, within 2048
pixels a side (`sections.ts`). Neuroglancer loads their data at the level
that zoom needs, as for any section, so zooming into the cut shows fine
structure while the solid stays coarse. Without them (the Volume tab's
**Fine sections on the cut** off, or Sections switched on in the 3-D view),
the faces show the 2-D views' own sections, which Neuroglancer draws at the
2-D views' zoom and only as far as those views reach (in the xy-3d layout,
only the xy one). Volumes: BigBrain (in MNI) or
the MNI ICBM152 2009a template, or any uint8 OME-Zarr 0.4 to 0.6 (zarr v3).

The solid is the whole image from the finest level up to 384 voxels a side,
with bricks of the finer levels over it (`bricks.ts`): boxes of 32³ voxels
with a voxel of apron each side, in slots of one 3-D texture (the atlas,
up to 128 MB and `MAX_3D_TEXTURE_SIZE` a side), and a page table per level
(packed into one RGBA8UI 3-D texture) whose entry for each brick gives its
slot, or its value when it is one value throughout (no slot; the ray steps
over it), or that it is not held. The ray samples, at each point, the finest
brick held there from the finest level allowed, steps and shades at its
voxel size, and takes the whole level where no brick is held.

Bricks are chosen a moment after the view settles: those in the frustum,
not inside the cut-away octant, with tissue near them in the whole level and
background or the cut near them too (a ray stops at the first tissue it
meets, so the inside of the tissue is seen only on the cut), and not hidden
behind the tissue's near surface: a brick is left out when every ray from
the camera to its centre and corners meets tissue first in the whole level
(outside the cut-away octant; not done with the camera inside tissue). From
the coarsest brick level, a brick is split into the next finer level's bricks
while its voxels show larger than a pixel at its nearest corner (bricks on
the cut's faces count as twice as near), the most needed first, while the
atlas has slots. They are read through the worker (`client.volume` on a
brick's box), six at a time, nearest first; a brick no longer wanted stops
loading. A new brick takes a free slot, else the slot of the brick least
recently wanted. Levels whose page tables do not fit (over 4M entries, or
over the texture size) are left out, finest first.

The Detail menu: Automatic draws bricks down to the finest level. A fixed
level that fits whole (384 voxels a side) is drawn whole, without bricks; a
larger one is the finest level bricks are drawn from. Where the atlas cannot
be made (the texture size, or no GPU memory), the panel says so, and a
large level is drawn as before: a 256³ box of it around the position inside
the whole level.

| File | What |
|---|---|
| `manifest.ts` | The Volume tab, commands and state slice |
| `plugin.ts` | The tab, the Volume switch, presets; which levels it loads (a level whole, the bricks of the finer ones, or without bricks a finer box around the position) |
| `sections.ts` | The fine sections on the cut: their zoom and size |
| `solid.ts` | WebGL2 in Neuroglancer's 3-D view: the solid, the cut, the atlas and page table, depth for the tracts and sections |
| `bricks.ts` | Bricks: which a view wants, the page table's layout and entries, slots and eviction |
| `ome.ts` | OME-Zarr multiscales to voxel-to-RAS transforms |
| `volume_reader.ts`, `volume_client.ts`, `volume_worker.ts` | Reading levels and sections in a worker |
| `tools/mni_template_to_omezarr.py` | How the hosted MNI template was made |
| `tests/` | `npm test` runs them |
