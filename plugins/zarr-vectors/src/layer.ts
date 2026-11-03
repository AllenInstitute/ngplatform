/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Lets a segmentation layer draw the zarr-vectors dense overview.
 *
 * Neuroglancer's segmentation layer knows a fixed set of subsource kinds and
 * rejects the rest.  Rather than patch it, this module registers a subclass
 * under the same `"segmentation"` type name: it draws zarr-vectors' dense
 * subsource itself and hands everything else to the base class unchanged, so
 * saved states keep their layer type and other data behaves exactly as
 * before.  Registration happens when the zarr-vectors datasource loads, which
 * is the only time the subclass is needed.
 */

import type {
  ZarrVectorsGeometryDescription,
  ZarrVectorsSurfaceInfo,
} from "./base.js";
import type { ZarrVectorsDenseDisplayState } from "./dense_frontend.js";
import {
  pickedVertexValues,
  PerspectiveViewZarrVectorsDenseLayer,
  SliceViewPanelZarrVectorsDenseLayer,
  ZarrVectorsMultiscaleGeometrySource,
} from "./dense_frontend.js";
import { ZarrVectorsLazyPropertyMap } from "./frontend.js";
import {
  curvatureShader,
  DIRECTION_SHADER,
  KIND_CAPABILITIES,
} from "./geometry_kind.js";
import {
  registerLayerType,
  registerLayerTypeDetector,
  registerVolumeLayerType,
} from "neuroglancer/unstable/layer/index.js";
import type { LoadedDataSubsource } from "neuroglancer/unstable/layer/layer_data_source.js";
import { SegmentationUserLayer } from "neuroglancer/unstable/layer/segmentation/index.js";
import { SkeletonRenderMode } from "neuroglancer/unstable/skeleton/frontend.js";
import {
  mergeSegmentPropertyMaps,
  PreprocessedSegmentPropertyMap,
} from "neuroglancer/unstable/segmentation_display_state/property_map.js";
import { VolumeType } from "neuroglancer/unstable/sliceview/volume/base.js";
import {
  makeCachedDerivedWatchableValue,
  WatchableValue,
} from "neuroglancer/unstable/trackable_value.js";

/** What `zarrVectorsSurface()` tells the platform's Surface controls. */
export interface ZarrVectorsSurfaceView {
  attributes: {
    id: string;
    name: string;
    components: number;
    labels?: { code: number; name: string; rgba: number[] }[];
  }[];
  surface: ZarrVectorsSurfaceInfo | undefined;
  /** The store's URL (a kvstore URL ending in "/"). */
  storeUrl: string;
  /** An attribute's values on the vertices drawn last in 3-d. */
  values(id: string): number[];
  /** The values of the vertex under the mouse, by attribute id, when this layer drew it. */
  picked(mouseState: unknown): Record<string, number> | undefined;
}

/** Subsource ids that draw selected objects at full resolution. */
const OBJECT_SUBSOURCE_IDS = new Set(["objects", "meshes"]);

function denseSource(subsource: LoadedDataSubsource) {
  const { mesh } = subsource.subsourceEntry.subsource;
  return mesh instanceof ZarrVectorsMultiscaleGeometrySource ? mesh : undefined;
}

export class ZarrVectorsSegmentationUserLayer extends SegmentationUserLayer {
  private objectsDrawnElsewhere = new WatchableValue(false);
  /** Identifies the latest activation, so an earlier one's properties are dropped. */
  private propertiesToken = {};

  constructor(...args: ConstructorParameters<typeof SegmentationUserLayer>) {
    super(...args);
    // The Render tab offers its resolution sliders only where the base
    // class sees one of its own 2-d / 3-d render layers; the dense layers
    // count too. Wrapped rather than rewritten, so whatever the base class
    // counts (it differs between Neuroglancer versions) still counts.
    const layers = { changed: this.layersChanged, value: this.renderLayers };
    const dense = (type: new (...a: any[]) => unknown) =>
      makeCachedDerivedWatchableValue(
        (base: boolean, all: readonly unknown[]) =>
          base || all.some((x) => x instanceof type),
        [this.has2dLayer, layers] as any,
      );
    (this as any).has2dLayer = this.registerDisposer(
      dense(SliceViewPanelZarrVectorsDenseLayer),
    );
    (this as any).has3dLayer = this.registerDisposer(
      dense(PerspectiveViewZarrVectorsDenseLayer),
    );
    // The skeleton controls (points or lines, line width and point size per
    // view, the shader editor) drive the dense layer too, so they are
    // offered for it; the shader editor lists its attributes.
    const hasSkeletons = this.hasSkeletonsLayer;
    (this as any).hasSkeletonsLayer = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (base: boolean, all: readonly unknown[]) =>
          base ||
          all.some((x) => x instanceof PerspectiveViewZarrVectorsDenseLayer),
        [hasSkeletons, layers] as any,
      ),
    );
    const skeletonLayer = this.getSkeletonLayer;
    (this as any).getSkeletonLayer = () =>
      skeletonLayer() ?? this.denseShaderAttributes();
  }

  /**
   * A mesh layer's surface, for the platform's Surface controls: its
   * per-vertex attributes (a parcellation's with its table), the store's
   * surface header and URL, the values drawn (for a control's range) and
   * the values of the vertex under the mouse.  Undefined for other layers.
   */
  zarrVectorsSurface(): ZarrVectorsSurfaceView | undefined {
    for (const layer of this.renderLayers) {
      if (!(layer instanceof PerspectiveViewZarrVectorsDenseLayer)) continue;
      const dense = layer as any;
      const source: ZarrVectorsMultiscaleGeometrySource = dense.options.source;
      const description = source.description;
      if (KIND_CAPABILITIES[description.geometryKind].primitive !== "triangles") {
        return undefined;
      }
      const renderLayers = this.renderLayers;
      return {
        attributes: description.attributes
          .filter((a) => a.objectValue === undefined)
          .map((a) => ({
            id: a.id,
            name: a.name,
            components: a.components,
            labels: a.labels,
          })),
        surface: description.surface,
        storeUrl: source.levels[0]?.parameters.storeUrl ?? "",
        values(id: string) {
          const i = dense.helper.attributes.findIndex(
            (a: { id: string }) => a.id === id,
          );
          const width = dense.helper.attributes[i]?.components ?? 1;
          const out: number[] = [];
          for (const chunk of dense.drawnChunks as {
            attributeValues?: Float32Array[];
            numOwnVertices: number;
          }[]) {
            const values = chunk.attributeValues?.[i];
            if (values === undefined) continue;
            for (let v = 0; v < chunk.numOwnVertices; ++v) out.push(values[v * width]);
          }
          return out;
        },
        picked: (mouseState: unknown) =>
          pickedVertexValues(mouseState as never, renderLayers),
      };
    }
    return undefined;
  }

  /** The dense layer's shader inputs, as the skeleton shader editor lists them. */
  private denseShaderAttributes() {
    for (const layer of this.renderLayers) {
      if (!(layer instanceof PerspectiveViewZarrVectorsDenseLayer)) continue;
      const description: ZarrVectorsGeometryDescription = (layer as any).options
        .source.description;
      const vertexAttributes = [
        { name: "position", glslDataType: "vec3" },
        ...description.attributes.map((a) => ({
          name: a.id,
          glslDataType: a.components === 1 ? "float" : `vec${a.components}`,
        })),
      ];
      if (KIND_CAPABILITIES[description.geometryKind].tangent !== undefined) {
        vertexAttributes.push({ name: "tangent", glslDataType: "vec3" });
      }
      return { vertexAttributes } as any;
    }
    return undefined;
  }

  /**
   * The base class builds its property map from what the subsources hold
   * when they are activated; a {@link ZarrVectorsLazyPropertyMap} holds its
   * properties only later. Rebuilds the map then, as the base class would.
   */
  private refreshPropertiesWhenReady(subsources: LoadedDataSubsource[]) {
    const token = (this.propertiesToken = {});
    const pending = subsources.flatMap((s) => {
      const map = s.subsourceEntry.subsource.segmentPropertyMap;
      return map instanceof ZarrVectorsLazyPropertyMap &&
        map.inlineProperties === undefined
        ? [map.ready]
        : [];
    });
    if (pending.length === 0) return;
    Promise.all(pending).then(
      () => {
        if (this.propertiesToken !== token || this.wasDisposed) return;
        if (this.displayState.linkedSegmentationGroup.root.value !== this) {
          return;
        }
        const maps = subsources.flatMap((s) => {
          const map = s.subsourceEntry.subsource.segmentPropertyMap;
          return map !== undefined && s.activated !== undefined ? [map] : [];
        });
        const merged = mergeSegmentPropertyMaps(maps);
        this.displayState.originalSegmentationGroupState.segmentPropertyMap.value =
          merged === undefined
            ? undefined
            : new PreprocessedSegmentPropertyMap(merged);
      },
      () => {},
    );
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    const rest: LoadedDataSubsource[] = [];
    const dense: LoadedDataSubsource[] = [];
    let objectsElsewhere = false;
    for (const subsource of subsources) {
      if (denseSource(subsource) !== undefined) {
        dense.push(subsource);
        continue;
      }
      if (OBJECT_SUBSOURCE_IDS.has(subsource.subsourceEntry.id)) {
        objectsElsewhere = true;
      }
      rest.push(subsource);
    }
    super.activateDataSubsources(rest);
    this.refreshPropertiesWhenReady(rest);
    this.objectsDrawnElsewhere.value = objectsElsewhere;
    let directionDefault = dense.length > 0;
    for (const loadedSubsource of dense) {
      const source = denseSource(loadedSubsource)!;
      if (
        !KIND_CAPABILITIES[source.description.geometryKind].directionDefault
      ) {
        directionDefault = false;
      }
      loadedSubsource.activate(() => {
        // Inherit everything (including getters) from the layer's display
        // state; override only what differs per subsource.
        const displayState: ZarrVectorsDenseDisplayState = Object.assign(
          Object.create(this.displayState),
          {
            transform: loadedSubsource.getRenderLayerTransform(),
            localPosition: this.localPosition,
            renderScaleTarget2d: this.sliceViewRenderScaleTarget,
            renderScaleHistogram2d: this.sliceViewRenderScaleHistogram,
            objectsDrawnElsewhere: this.objectsDrawnElsewhere,
          },
        );
        const options = {
          chunkManager: this.manager.chunkManager,
          source,
          displayState,
        };
        loadedSubsource.addRenderLayer(
          new PerspectiveViewZarrVectorsDenseLayer(options),
        );
        loadedSubsource.addRenderLayer(
          new SliceViewPanelZarrVectorsDenseLayer(options),
        );
      }, this.displayState.segmentationGroupState.value);
    }
    if (directionDefault) {
      this.adoptDefaultShader(DIRECTION_SHADER);
      this.adoptThinLines();
    }
    // A surface with curvature shows it, as Freeview does.
    for (const loadedSubsource of dense) {
      const { description } = denseSource(loadedSubsource)!;
      if (KIND_CAPABILITIES[description.geometryKind].primitive !== "triangles") continue;
      const curvature = ["curv", "sulc"]
        .map((name) => description.attributes.find((a) => a.name === name && a.components === 1))
        .find((a) => a !== undefined);
      if (curvature !== undefined) this.adoptDefaultShader(curvatureShader(curvature.id));
    }
  }

  /**
   * Tractograms show as plain lines one pixel wide in cross-sections too, as
   * TrackVis and most tractography viewers draw them, rather than
   * Neuroglancer's skeleton default (lines and points, two pixels).  As with
   * the shader, an untouched setting moves with its default.
   */
  private adoptThinLines() {
    const { mode, lineWidth } = this.displayState.skeletonRenderingOptions.params2d;
    const enumDefault = mode as unknown as { defaultValue: SkeletonRenderMode };
    if (mode.value === enumDefault.defaultValue && mode.value !== SkeletonRenderMode.LINES) {
      enumDefault.defaultValue = SkeletonRenderMode.LINES;
      mode.value = SkeletonRenderMode.LINES;
    }
    if (lineWidth.value === lineWidth.defaultValue && lineWidth.value !== 1) {
      lineWidth.defaultValue = 1;
      lineWidth.value = 1;
    }
  }

  /**
   * A kind of data's own shader (curves by direction, a surface's
   * curvature) unless the user has chosen one.  Moving the default with the
   * value keeps an untouched shader out of saved state.
   */
  private adoptDefaultShader(text: string) {
    const { shader } = this.displayState.skeletonRenderingOptions;
    if (shader.value !== shader.defaultValue) return;
    if (shader.value === text) return;
    shader.defaultValue = text;
    shader.value = text;
  }
}

registerLayerType(ZarrVectorsSegmentationUserLayer, "segmentation");
registerVolumeLayerType(
  VolumeType.SEGMENTATION,
  ZarrVectorsSegmentationUserLayer,
);
registerLayerTypeDetector((subsource) => {
  if (subsource.mesh instanceof ZarrVectorsMultiscaleGeometrySource) {
    return { layerConstructor: ZarrVectorsSegmentationUserLayer, priority: 2 };
  }
  return undefined;
});
