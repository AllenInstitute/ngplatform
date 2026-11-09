# OME Collections

**Kind:** tool · **Off by default** (offered when you open an image inside an OME collection; or turn it on in the Plugins tab) · the
**Add collection +** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/collections)

An OME-Zarr collection groups images (and other collections) with the
coordinate systems they share and the transforms between them. This plugin
reads and builds collections as [RFC-8](https://ngff.openmicroscopy.org/rfc/8/) of
OME-NGFF drafts them ("Collections and Extensibility", under review in
October 2026), each shown in a tab of its own beside the scenes.

## Add collection

With the plugin on, the scene bar has an **Add collection +** tab after the
scenes. No collection is open until you add one; the tab opens a sheet:

- **From this scene**: a collection of the scene's OME-Zarr images, the ones
  you tick. Each is a member, placed by a transform into one coordinate
  system (its unit chosen there) as the scene shows it now: as the image
  places itself, an identity; moved in the viewer, a translation, scale or
  affine. Layers that are not OME-Zarr are left out.
- **Holding this workspace's images**: when an image in the workspace sits
  in a Zarr group that is a collection (a parent `zarr.json` of type
  `collection`), it is offered here.
- **Open**: a collection by its URL (a `.json` document, or a Zarr group
  whose `zarr.json` holds it), or a `.json` file on this computer (its paths
  must then be full URLs).
- **Example**: a small gallery of the SRB 2026a template placed three times
  (as is, moved, and mirrored).

Each collection opens in a new tab named after it, whose viewer shows only
its images, with the **Collection** panel beside it. Add as many as you like;
close a tab like any scene.

## A collection's tab

- **Graph**: the collection's images (left) and its coordinate systems
  (right), each transform an arrow. Click a system (or **View in it**) to
  view the images in it: each is placed by the chain of transforms leading
  to it (a transform walked backwards is inverted); an image with no chain
  to it is hidden, and says why under **Members**.
- **Members**: the tree (each node's type, name and where it is). Add a
  member, one of the workspace's OME-Zarr datasets or an address; it stays
  hidden until a relationship places it. Remove one with its × button, and
  its transforms go with it. A label image (`image-label` in its metadata,
  or an image in a `labels` group) is shown as a segmentation and tagged
  **labels**. **From the view** writes where a member's layer is
  now (after moving it in the viewer, with the layer's Source → Details transform or the
  Registration plugin) as its transform into the system viewed, replacing
  the one there was.
- **Coordinate systems**: add one (a name and a unit; axes z, y, x), or
  remove one with its transforms. A unit OME-NGFF does not name is read as
  a millimetre, and the system says so ("unit 'pixel' read as mm").
- **Relationships**: every transform as written, and a new one between a
  member or system and another: identity, translation or scale (x y z, in
  the target's units), affine (a 3 × 4 grid, rows x, y, z, each a b c t;
  or paste twelve numbers in that order to fill it) or a displacement
  field (its Zarr group's address).
- **Rename** the collection by its name at the top; **Download JSON** or
  **Copy JSON** to keep it.

Edits are kept with the tab, in the link and the undo history (Ctrl+Z
undoes one). A collection read from an address is not written back there:
download it and put it where it belongs.

- **Displacement fields**: when the chain from an image to the chosen
  system holds a displacement field (OME-NGFF 0.6's `displacements`: a
  field of shifts stored as a Zarr array, often after an affine from a
  registration), the image is shown resampled through it, computed as you
  view it, and marked **warped** in the graph (dashed) and under
  **Members**. A field written from the system to the image (as
  registration tools write it) is applied as it is; one written the other
  way is inverted by iteration. A chain may go through up to three fields.
  A coordinate map (`coordinates`) written from the system to the image is
  applied too; one written the other way needs its inverse given (a
  `bijection`). Limits: a field is looked up trilinearly whatever its
  `interpolation` says, past its edge the edge's displacement holds, and the
  warped image is cut to the member's own grid.
- **Transforms read**: identity, scale, translation, rotation, `mapAxis`,
  affine, sequences of them, `bijection`, displacement fields and
  coordinate maps. A member whose chain needs another kind (such as
  `byDimension`) is hidden, and its line under **Members** names the kind.
- Only images with x, y and z alone are placed; one with channels or time
  is hidden, and its line under **Members** says why. A label image is not
  warped through a displacement field (it would be blended); it is hidden
  in a system that needs one.
- A collection, or an image's metadata, that does not answer within 15
  seconds is given up, and the panel says so.

The tab keeps its collection and chosen system, like any scene, in the
link. An image's own coordinate systems and transforms (OME-Zarr 0.4 to
0.6) are also shown in its Layer → **Source** tab, under the layer's
transform.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
