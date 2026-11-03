# Collections

OME-Zarr collections as RFC-8 of OME-NGFF drafts them ("Collections and
Extensibility", under review): a tree of nodes (collections, multiscale
images, other kinds) with coordinate systems and the transforms between
them. The plugin adds a **Collections** tab to the scene bar (a scene kind,
`contributes.sceneKinds`): a scene whose viewer shows only a collection's
images, each placed by the chain of transforms to the coordinate system
chosen in the panel's graph. The panel also offers collections found above
the workspace's images (a parent Zarr group whose `zarr.json` is an OME
collection).

| File | What |
|---|---|
| `manifest.ts` | The Collections panel, the Collections scene kind and the state slice (per scene: the collection's URL and the system it is viewed in) |
| `plugin.ts` | The panel (found collections, the systems graph, members, transforms, which members are warped or hidden) and the Collections tab's layers and placements |
| `collection.ts` | The model: reading the tree, resolving paths, members, transforms as 4 × 4 on x, y, z, a member placed in any system by the chain of transforms (inverted where walked backwards), chains through a displacement field and the warp that shows them, the groups above an image to look in (pure, unit-tested) |
| `examples/srb_gallery.json` | A small collection: the SRB 2026a template as is, moved and mirrored |
| `tests/` | `npm test` runs them |

The RFC is a draft and has no implementations yet; this follows its text of
October 2026 and reads what it can: scale, translation, affine, identity,
sequences of them, and displacement fields (below). Coordinate maps
(`coordinates`) are listed, not applied. Placements use the Registration
plugin's conversion between millimetre matrices and Neuroglancer's layer
transforms.

## Displacement fields

What OME-NGFF 0.6 (RFC-5, the spec's draft of October 2026) says of a
`displacements` transform:

- It is `{"type": "displacements", "path": ..., "input", "output"}`, with
  an optional `interpolation` (`linear` by default; `nearest`,
  `bspline-cubic`) for looking the field up between its samples. `path` is
  "the location of the multiscale group in this (or another) container";
  the spec suggests a `coordinateTransformations` group beside the images.
  Here it is resolved against the document the transform is written in
  (`coll.zarr/zarr.json` + `coordinateTransformations/swirl`).
- The field is an OME-Zarr multiscale image with one axis more than the
  input system: an axis of `"type": "displacement"` (`discrete: true`),
  placed after a time axis and before the spatial axes (`c, z, y, x`), of
  length N (the number of axes). Component i is the displacement along the
  i-th axis of the output system. Its own `coordinateTransformations` (a
  scale, a translation) place its samples in the input system.
- Like every transform it maps points forwards, input to output: a point x
  of the input goes to x + D(x), D looked up (interpolated) at x. It is
  not invertible in closed form; implementations may estimate the inverse.
  To render an image into a fixed space, the transform the spec expects is
  the one from the fixed space to the image (registration tools write that
  one), applied directly.

How the plugin uses it: for the system chosen, a member whose chain of
transforms holds a displacement field (alone, or in a sequence with
affines) is not placed by a layer transform. `chainInto` finds the chain
(affines and up to three fields, `MAX_FIELDS`, either way round);
`fieldWarp` turns it into a layer computed as it is viewed
(`workspace.computed.url` with a `{kind: "field"}` warp, or `{kind:
"fields"}` with a part per field, applied in turn, src/virtual/warp.ts): on the member's own grid,
placed by the chain's affines (the field left out), each voxel taken back
through the chain to the member (the affines undone, then the field) and
the member sampled there. A field walked as written (fixed to member, the
usual case) is applied directly; one walked against its direction (member
to fixed) is inverted by iteration (x ← q − D(x)). The panel marks such
members **warped**. The warped layer is float32; it takes the image's
contrast (its omero window, or its integer type's range).

Limits: the field is looked up trilinearly whatever `interpolation` says;
past its edge the edge's displacement holds; the displacement axis must
come before z, y, x (the order the spec now asks for; an earlier draft had
it last), and component values are read in the field's spatial unit. A
chain needing more than three fields and `coordinates` maps are not
applied. A
transform walked backwards is read as its inverse (`inverseOf`): a sequence
reversed, each part inverted, and a `bijection`, alone or inside a
sequence, by its stated `inverse`. The warped layer keeps the member's grid, so a
part pushed by the field beyond that grid is cut off.
