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
export { setNamedPanelOrientation } from "neuroglancer/unstable/data_panel_layout.js";
export { SegmentationUserLayer } from "neuroglancer/unstable/layer/segmentation/index.js";
export { WatchableValue } from "neuroglancer/unstable/trackable_value.js";
export { ViewerSettingsPanel } from "neuroglancer/unstable/ui/viewer_settings.js";
export { StatisticsPanel } from "neuroglancer/unstable/ui/statistics.js";
export { InputEventBindingHelpDialog } from "neuroglancer/unstable/help/input_event_bindings.js";
export { getStatusMessageContainers } from "neuroglancer/unstable/status.js";
export { setAsyncComputationWorkerFactory, setChunkWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
export type { SidePanelManager } from "neuroglancer/unstable/ui/side_panel.js";

// The native layer inspector (./inspector/): the layer models it binds its
// controls to, the few rich editors it embeds as components (shader code,
// resolution histograms, contrast and transfer-function editors), and the
// segment-query and annotation helpers Neuroglancer's own tabs use.
export type { UserLayer } from "neuroglancer/unstable/layer/index.js";
export type { LayerDataSource, LoadedDataSubsource, LoadedLayerDataSource } from "neuroglancer/unstable/layer/layer_data_source.js";
export { ImageUserLayer } from "neuroglancer/unstable/layer/image/index.js";
export { AnnotationUserLayer } from "neuroglancer/unstable/layer/annotation/index.js";
export { SingleMeshUserLayer } from "neuroglancer/unstable/layer/single_mesh/index.js";
export { RefCounted } from "neuroglancer/unstable/util/disposable.js";
export { WatchableVisibilityPriority } from "neuroglancer/unstable/visibility_priority/frontend.js";
export { ShaderCodeWidget } from "neuroglancer/unstable/widget/shader_code_widget.js";
export { RenderScaleWidget, VolumeRenderingRenderScaleWidget } from "neuroglancer/unstable/widget/render_scale_widget.js";
export { ChannelDimensionsWidget } from "neuroglancer/unstable/widget/channel_dimensions_widget.js";
export { channelInvlerpLayerControl } from "neuroglancer/unstable/widget/layer_control_channel_invlerp.js";
export { propertyInvlerpLayerControl } from "neuroglancer/unstable/widget/layer_control_property_invlerp.js";
export { transferFunctionLayerControl } from "neuroglancer/unstable/widget/transfer_function.js";
export { getShaderSelectOptionLabel, type ShaderControlState } from "neuroglancer/unstable/webgl/shader_ui_controls.js";
export { VolumeRenderingModes } from "neuroglancer/unstable/volume_rendering/trackable_volume_rendering_mode.js";
export { makeCoordinateSpace, type CoordinateSpace, type WatchableCoordinateSpaceTransform } from "neuroglancer/unstable/coordinate_transform.js";
export { formatScaleWithUnitAsString, parseScale } from "neuroglancer/unstable/util/si_units.js";
export {
  changeTagConstraintInSegmentQuery,
  executeSegmentQuery,
  forEachQueryResultSegmentIdGenerator,
  parseSegmentQuery,
  unparseSegmentQuery,
  updatePropertyHistograms,
  type FilterQuery,
  type PreprocessedSegmentPropertyMap,
  type PropertyHistogram,
  type QueryResult,
} from "neuroglancer/unstable/segmentation_display_state/property_map.js";
export { getBaseObjectColor } from "neuroglancer/unstable/segmentation_display_state/frontend.js";
export { packColor, serializeColor } from "neuroglancer/unstable/util/color.js";
export { restoreLegacyTool } from "neuroglancer/unstable/ui/tool.js";
export { AnnotationSource, AnnotationType, annotationTypeHandlers, type Annotation } from "neuroglancer/unstable/annotation/index.js";
export { transformPoint } from "neuroglancer/unstable/util/matrix.js";
export { MessageSeverity, type MessageList } from "neuroglancer/unstable/util/message_list.js";
export { MeshSource, MultiscaleMeshSource } from "neuroglancer/unstable/mesh/frontend.js";
export { SkeletonSource } from "neuroglancer/unstable/skeleton/frontend.js";
export { MultiscaleVolumeChunkSource } from "neuroglancer/unstable/sliceview/volume/frontend.js";
export { LocalDataSource } from "neuroglancer/unstable/datasource/local.js";
export { DataType } from "neuroglancer/unstable/util/data_type.js";

// Drawing in the 3-D panel, for plugins (./draw3d.ts).
export { PerspectiveViewRenderLayer } from "neuroglancer/unstable/perspective_view/render_layer.js";
export type { PerspectiveViewRenderContext } from "neuroglancer/unstable/perspective_view/render_layer.js";
export { OffscreenTextures, setPerspectiveSectionClip } from "neuroglancer/unstable/perspective_view/panel.js";
export { addPerspectivePanelToggle } from "neuroglancer/unstable/data_panel_layout.js";
export { TrackableBoolean } from "neuroglancer/unstable/trackable_boolean.js";
export { setScreenshotOverlay } from "neuroglancer/unstable/util/screenshot_manager.js";
