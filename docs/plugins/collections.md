# Collections

**Kind:** tool · **Off by default** (offered when you open an image inside an OME collection; or turn it on in the Plugins tab) · the
**Collections** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/collections)

An OME-Zarr collection groups images (and other collections) with the
coordinate systems they share and the transforms between them. This plugin
reads collections as [RFC-8](https://ngff.openmicroscopy.org/rfc/8/) of
OME-NGFF drafts them ("Collections and Extensibility", under review in
October 2026) and shows them in a **Collections** tab of their own, beside
the scenes.

## The Collections tab

With the plugin on, the scene bar has a **Collections** tab (dashed until
first opened). It is a scene whose viewer shows only a collection's images,
each placed by its transforms, with the **Collections** panel beside it.

- **Found above your data**: when an image in the workspace sits in a Zarr
  group that is a collection (a parent `zarr.json` of type `collection`),
  the panel offers it. In an ordinary scene it offers the collections that
  scene's images belong to, to open in the Collections tab.
- **Open** a collection by its URL: a `.json` document, or a Zarr group
  whose `zarr.json` holds it. **Example** opens a small gallery of the SRB
  2026a template placed three times (as is, moved, and mirrored).
- **Coordinate systems**: a graph of the collection's images (left) and its
  coordinate systems (right), each transform an arrow. Click a system to
  view the images in it: each is placed by the chain of transforms leading
  to it (a transform walked backwards is inverted); an image with no chain
  to it is hidden.
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
  `bijection`).
- **Members** and **Transforms**: the tree (each node's type, name and
  where it is) and every transform as written.

The tab keeps its collection and chosen system, like any scene, in the
link. An image's own coordinate systems and transforms (OME-Zarr 0.4 to
0.6) are also shown in its Layer → **Source** tab, under the layer's
transform.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
