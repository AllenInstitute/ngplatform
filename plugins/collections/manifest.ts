/**
 * The collections plugin's manifest: OME-Zarr collections (RFC-8, draft),
 * their members, coordinate systems and transforms, and a scene of them.
 * Its code is ./plugin.ts and ./collection.ts.
 */
import type { Manifest } from "@ngplatform/sdk";

export const COLLECTIONS_PANEL = "collections.panel";
/** The kind of a collection's tab (a scene). */
export const COLLECTION_KIND = "collection";
/** Opens the sheet that adds a collection's tab (the scene bar's Add collection tab runs it). */
export const ADD_COLLECTION = "collections.add";

export const COLLECTIONS_MANIFEST: Manifest = {
  id: "org.ngplatform.collections",
  name: "OME Collections",
  version: "0.2.0",
  kind: "tool",
  enabledByDefault: false,
  description: "OME-Zarr collections (RFC-8, draft): open one, or make one of a scene's images, in a tab of its own; see how its images relate and build the relationships (coordinate systems, transforms).",
  guide: `A collection groups OME-Zarr images (and other collections) with the coordinate systems they share and the transforms between them, as RFC-8 of OME-NGFF drafts it ("Collections and Extensibility", under review).

## Add collection
With the plugin on, the scene bar has an **Add collection +** tab after the scenes. It opens a sheet:
- **From this scene**: makes a collection of the scene's OME-Zarr images, each a member placed as the scene shows it, in one coordinate system; it opens in a tab of its own with the graph of how they relate.
- **Found**: collections holding the workspace's images (a parent Zarr group whose \`zarr.json\` is a collection).
- **Open**: a collection document by address (a \`.json\` file, or a Zarr group whose \`zarr.json\` holds the collection), or a \`.json\` file from this computer.
- **Example**: a small gallery of the SRB 2026a template.

Each collection is a tab (a scene of its own) whose viewer shows only its images.

## A collection's tab
- **Graph**: its images (left) and coordinate systems (right), each transform an arrow. Click a system to view the images in it: each is placed by the chain of transforms to it (walked backwards where needed, inverted); an image with no chain to it is hidden.
- **Build it**: add or remove members (a dataset of the workspace or an address), coordinate systems, and relationships (identity, translation, scale, affine, displacement field) between a member or system and another. **From the view** writes a member's placement as you have moved it in the viewer (its layer's transform) as its transform into the system viewed.
- **Download** or **Copy** the collection's JSON. Edits are kept with the tab (in the link and the undo history); a collection read from an address is not written back there.

The RFC is a draft; this follows its text of October 2026.`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    commands: [{ id: ADD_COLLECTION, title: "Add a collection…", group: "Collections" }],
    panels: [{ id: COLLECTIONS_PANEL, title: "Collection", slot: "left", order: 75 }],
    sceneKinds: [{ kind: COLLECTION_KIND, title: "Collection", panel: COLLECTIONS_PANEL, add: { title: "Add collection", command: ADD_COLLECTION } }],
    appState: { key: "collections", version: 1 },
  },
};
