/**
 * Everything the platform takes from Neuroglancer, in one place.
 *
 * This is the platform's embed surface: outside src/engine/ nothing imports
 * Neuroglancer (the worker scripts in ./workers/ import its worker halves).
 * After a rebase of the fork, this is the file to fix; when the fork gains
 * its own `embed.ts`, these lines collapse into one import.
 */
import "neuroglancer";

export { makeMinimalViewer } from "neuroglancer/unstable/ui/minimal_viewer.js";
export type { Viewer } from "neuroglancer/unstable/viewer.js";
export {
  getDefaultPerspectivePanelBindings,
  getDefaultSliceViewPanelBindings,
} from "neuroglancer/unstable/ui/default_input_event_bindings.js";
export { EventActionMap } from "neuroglancer/unstable/util/event_action_map.js";
export { urlSafeParse } from "neuroglancer/unstable/util/json.js";
export {
  ManagedUserLayer,
  changeLayerName,
  deleteLayer,
  initializeLayerFromSpecShowErrorStatus,
} from "neuroglancer/unstable/layer/index.js";
export { TabView } from "neuroglancer/unstable/widget/tab_view.js";
export { SegmentationUserLayer } from "neuroglancer/unstable/layer/segmentation/index.js";
export { WatchableValue } from "neuroglancer/unstable/trackable_value.js";
export { ViewerSettingsPanel } from "neuroglancer/unstable/ui/viewer_settings.js";
export { StatisticsPanel } from "neuroglancer/unstable/ui/statistics.js";
export { InputEventBindingHelpDialog } from "neuroglancer/unstable/help/input_event_bindings.js";
export { getStatusMessageContainers } from "neuroglancer/unstable/status.js";
export { setAsyncComputationWorkerFactory, setChunkWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
export type { SidePanelManager } from "neuroglancer/unstable/ui/side_panel.js";
