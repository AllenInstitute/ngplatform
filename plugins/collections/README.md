# Collections

OME-Zarr collections as RFC-8 of OME-NGFF drafts them ("Collections and
Extensibility", under review): a tree of nodes (collections, multiscale
images, other kinds) with coordinate systems and the transforms between
them. The Collections tab opens one, lists its members, systems and
transforms, and shows its images in a scene of their own, each placed by
its transform into the collection's space.

| File | What |
|---|---|
| `manifest.ts` | The Collections tab and the state slice |
| `plugin.ts` | The tab, and the scene of a collection's images |
| `collection.ts` | The model: reading the tree, resolving paths, members and where they are placed, transforms as 4 × 4 on x, y, z (pure, unit-tested) |
| `examples/srb_gallery.json` | A small collection: the SRB 2026a template as is, moved and mirrored |
| `tests/` | `npm test` runs them |

The RFC is a draft and has no implementations yet; this follows its text of
October 2026 and reads what it can (scale, translation, affine, identity
and sequences of them; displacement fields and coordinate maps are listed,
not applied). Placements use the Registration plugin's conversion between
millimetre matrices and Neuroglancer's layer transforms.
