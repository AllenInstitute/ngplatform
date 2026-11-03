/**
 * The collections plugin's manifest: OME-Zarr collections (RFC-8, draft),
 * their members, coordinate systems and transforms, and a scene of them.
 * Its code is ./plugin.ts and ./collection.ts.
 */
import type { Manifest } from "@ngplatform/sdk";

export const COLLECTIONS_PANEL = "collections.panel";
/** The kind of the Collections tab's scene. */
export const COLLECTION_KIND = "collection";

export const COLLECTIONS_MANIFEST: Manifest = {
  id: "org.ngplatform.collections",
  name: "Collections",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  description: "OME-Zarr collections (RFC-8, draft): a Collections tab whose viewer shows a collection's images placed by its transforms, in the coordinate system you choose.",
  guide: `A collection groups OME-Zarr images (and other collections) with the coordinate systems they share and the transforms between them, as RFC-8 of OME-NGFF drafts it ("Collections and Extensibility", under review).

## The Collections tab
With the plugin on, the scene bar has a **Collections** tab beside the scenes. It is a scene of its own whose viewer shows only a collection's images, each placed by its transforms, and the **Collections** panel opens with it.
- **Found**: when an image of the workspace sits in a Zarr group that is a collection (a parent \`zarr.json\` of type collection), it is offered here; in an ordinary scene the panel offers the collections that scene's images belong to, to open in the Collections tab.
- **Open**: a collection document by URL (a \`.json\` file, or a Zarr group whose \`zarr.json\` holds the collection), or **Example** for a small gallery of the SRB 2026a template.
- **Coordinate systems**: a graph of the collection's images (left) and its coordinate systems (right), each transform an arrow. Click a system to view the images in it: each is placed by the chain of transforms to it (walked backwards where needed, inverted); an image with no chain to it is hidden.
- **Members** and **Transforms**: the tree, and every transform as written.

The RFC is a draft; this follows its text of October 2026.`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: COLLECTIONS_PANEL, title: "Collections", slot: "left", order: 75 }],
    sceneKinds: [{ kind: COLLECTION_KIND, title: "Collections", panel: COLLECTIONS_PANEL }],
    appState: { key: "collections", version: 1 },
  },
};
