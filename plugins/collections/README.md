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
| `plugin.ts` | The panel (found collections, the systems graph, members, transforms) and the Collections tab's layers and placements |
| `collection.ts` | The model: reading the tree, resolving paths, members, transforms as 4 × 4 on x, y, z, a member placed in any system by the chain of transforms (inverted where walked backwards), the groups above an image to look in (pure, unit-tested) |
| `examples/srb_gallery.json` | A small collection: the SRB 2026a template as is, moved and mirrored |
| `tests/` | `npm test` runs them |

The RFC is a draft and has no implementations yet; this follows its text of
October 2026 and reads what it can (scale, translation, affine, identity
and sequences of them; displacement fields and coordinate maps are listed,
not applied). Placements use the Registration plugin's conversion between
millimetre matrices and Neuroglancer's layer transforms.
