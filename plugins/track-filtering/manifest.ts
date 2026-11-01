/** The track filtering plugin's manifest: read without loading its code. */
import type { Manifest } from "@ngplatform/sdk";

export const FILTERING_PANEL = "trackFiltering.panel";
export const FILTERING_STATE_KEY = "trackFiltering";

export const TRACK_FILTERING_MANIFEST: Manifest = {
  id: "org.ngplatform.track-filtering",
  name: "Track filtering",
  version: "0.3.0",
  kind: "tool",
  enabledByDefault: true,
  description:
    "TrackVis-style track groups over a Zarr Vectors dataset: each group keeps the objects that pass through its regions (spheres and boxes, with AND, OR and NOT) and whose attributes are in range, and shows them as a layer of its own, in its own colour, switched on and off like any layer.",
  license: "Apache-2.0",
  requires: { plugins: ["org.ngplatform.zarr-vectors"] },
  activation: ["onView:trackFiltering.panel"],
  contributes: {
    panels: [{ id: FILTERING_PANEL, title: "Filtering", slot: "left", order: 40 }],
    commands: [
      { id: "trackFiltering.show", title: "Show the track groups", group: "Filtering" },
      { id: "trackFiltering.newGroup", title: "New track group", group: "Filtering" },
      { id: "trackFiltering.addSphere", title: "Add a sphere region to the group being edited", group: "Filtering" },
      { id: "trackFiltering.addBox", title: "Add a box region to the group being edited", group: "Filtering" },
      { id: "trackFiltering.exportCsv", title: "Export the edited group's objects as CSV", group: "Filtering" },
      { id: "trackFiltering.saveTrk", title: "Save the edited group's streamlines as .trk", group: "Filtering" },
    ],
    keybindings: [{ key: "alt+shift+s", command: "trackFiltering.addSphere" }],
    appState: { key: FILTERING_STATE_KEY, version: 2 },
  },
};
