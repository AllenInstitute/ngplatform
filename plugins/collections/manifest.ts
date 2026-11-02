/**
 * The collections plugin's manifest: OME-Zarr collections (RFC-8, draft),
 * their members, coordinate systems and transforms, and a scene of them.
 * Its code is ./plugin.ts and ./collection.ts.
 */
import type { Manifest } from "@ngplatform/sdk";

export const COLLECTIONS_PANEL = "collections.panel";

export const COLLECTIONS_MANIFEST: Manifest = {
  id: "org.ngplatform.collections",
  name: "Collections",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  description: "OME-Zarr collections (RFC-8, draft): their images, coordinate systems and transforms, and a scene showing them together.",
  guide: `A collection groups OME-Zarr images (and other collections) with the coordinate systems they share and the transforms between them, as RFC-8 of OME-NGFF drafts it ("Collections and Extensibility", under review).

## The Collections tab
- **Open**: a collection document by URL (a \`.json\` file, or a Zarr group whose \`zarr.json\` holds the collection), or **Example** for a small gallery of the SRB 2026a template.
- **Members**: the tree of the collection, each image with where the collection puts it.
- **Coordinate systems and transforms**: every system (with its axes) and every transform (what kind, from which system to which).
- **Show in a new scene**: a scene of its own with every image of the collection, each placed by its transform into the collection's space, ready to look at and compare.

The RFC is a draft; this follows its text of October 2026.`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: COLLECTIONS_PANEL, title: "Collections", slot: "left", order: 75 }],
    appState: { key: "collections", version: 1 },
  },
};
