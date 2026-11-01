/** The volume view plugin's manifest: read without loading its code. */
import type { Manifest } from "../../sdk/types.js";

export const VOLUME_PANEL = "volumeView.panel";
export const VOLUME_STATE_KEY = "volumeView";

export const VOLUME_VIEW_MANIFEST: Manifest = {
  id: "org.ngplatform.volume-view",
  name: "Volume view",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: true,
  description:
    "A solid 3-D view of a brain volume (an OME-Zarr image pyramid) in place of Neuroglancer's 3-D panel: low resolution for the solid, the octant facing you cut away at the current position, its faces showing sections at full resolution, and the track groups drawn through the cut. Runs in the browser on the laptop's own GPU.",
  license: "Apache-2.0",
  activation: [`onView:${VOLUME_PANEL}`, "onCommand:volumeView.toggle"],
  contributes: {
    panels: [{ id: VOLUME_PANEL, title: "Volume", slot: "left", order: 50 }],
    commands: [
      { id: "volumeView.toggle", title: "Show or hide the volume view (in place of the 3-D panel)", group: "View" },
      { id: "volumeView.resetCamera", title: "Reset the volume view's camera", group: "View" },
    ],
    appState: { key: VOLUME_STATE_KEY, version: 1 },
  },
};
