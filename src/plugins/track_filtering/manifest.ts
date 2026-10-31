/** The track filtering plugin's manifest: read without loading its code. */
import type { Manifest } from "../../sdk/types.js";

export const FILTERING_PANEL = "trackFiltering.panel";
export const FILTERING_STATE_KEY = "trackFiltering";

export const TRACK_FILTERING_MANIFEST: Manifest = {
  id: "org.ngplatform.track-filtering",
  name: "Track filtering",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: true,
  description:
    "Filters the objects of a Zarr Vectors dataset (streamlines, skeletons, points) by their attributes and groups, and shows only those that pass, in their own view of the dataset.",
  license: "Apache-2.0",
  requires: { plugins: ["org.ngplatform.zarr-vectors"] },
  activation: ["onView:trackFiltering.panel"],
  contributes: {
    panels: [{ id: FILTERING_PANEL, title: "Filtering", slot: "left", order: 40 }],
    commands: [
      { id: "trackFiltering.show", title: "Show the track filters", group: "Filtering" },
      { id: "trackFiltering.clear", title: "Clear the track filters", group: "Filtering" },
      { id: "trackFiltering.exportCsv", title: "Export the passing objects as CSV", group: "Filtering" },
    ],
    appState: { key: FILTERING_STATE_KEY, version: 1 },
  },
};
