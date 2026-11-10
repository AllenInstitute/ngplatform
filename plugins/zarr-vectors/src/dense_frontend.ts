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
 * @file The dense overview of a zarr-vectors store: every object in view,
 * drawn from spatial chunks, inside an ordinary segmentation layer.
 *
 * Neuroglancer's skeleton layer draws one segment per draw call, which cannot
 * show a whole-brain tractogram.  This layer draws a whole chunk per call and
 * looks each vertex's segment up on the GPU, the way the volume segmentation
 * renderer colours voxels: the layer's ordinary segment state (selected
 * segments, segment colours, colour seed, `selectedAlpha` /
 * `notSelectedAlpha` / `objectAlpha`, `ignoreNullVisibleSet`) decides what
 * shows and how.  The layer's skeleton shader and its controls apply, with
 * the same `prop_<attribute>()` and `segmentColor()` API, so one shader serves
 * this layer and the full-resolution per-object skeletons.
 */

import { ChunkState } from "neuroglancer/unstable/chunk_manager/base.js";
import type { ChunkManager } from "neuroglancer/unstable/chunk_manager/frontend.js";
import {
  ChunkRenderLayerFrontend,
  WithParameters,
} from "neuroglancer/unstable/chunk_manager/frontend.js";
import type {
  ZarrVectorsChunkSpecification,
  ZarrVectorsGeometryDescription,
} from "./base.js";
import {
  ZARR_VECTORS_DENSE_RENDER_LAYER_RPC_ID,
  ZARR_VECTORS_DENSE_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  ZarrVectorsGeometryChunkSourceParameters,
} from "./base.js";
import {
  emitsPremultipliedAlpha,
  glslZvEmit,
  linesDrawVertexDiscs,
} from "./blending.js";
import {
  addStringShaderSupport,
  setShaderControls,
} from "./compat.js";
import {
  dense3dBudget,
  denseLayerDraws,
  denseLevelSpacing,
  DRAWS_2D,
  DRAWS_3D,
  perChunkLevels,
  selectDense3dChunks,
  selectDenseLevel,
  setNodePosition,
} from "./dense_lod.js";
import type { DrawAttribute, DrawChunkData } from "./dense_pack.js";
import {
  drawBytesPerVertex,
  drawChunkBytes,
  drawLayout,
  JOINS_PREVIOUS,
  OBJECT_SLOT_MASK,
} from "./dense_pack.js";
import { KIND_CAPABILITIES, positionAttribute } from "./geometry_kind.js";
import { shaderObjectValues } from "./objects.js";
import type { HashMapUint64 } from "neuroglancer/unstable/gpu_hash/hash_table.js";
import { GPUHashTable, HashSetShaderManager } from "neuroglancer/unstable/gpu_hash/shader.js";
import { WithSharedKvStoreContext } from "neuroglancer/unstable/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "neuroglancer/unstable/kvstore/frontend.js";
import type {
  LayerView,
  MouseSelectionState,
  VisibleLayerInfo,
} from "neuroglancer/unstable/layer/index.js";
import type { DisplayDimensionRenderInfo } from "neuroglancer/unstable/navigation_state.js";
import type { PerspectiveViewRenderContext } from "neuroglancer/unstable/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "neuroglancer/unstable/perspective_view/render_layer.js";
import type { RenderLayerTransformOrError } from "neuroglancer/unstable/render_coordinate_transform.js";
import { get3dModelToDisplaySpaceMatrix } from "neuroglancer/unstable/render_coordinate_transform.js";
import type { RenderScaleHistogram } from "neuroglancer/unstable/render_scale_statistics.js";
import type { RenderLayer } from "neuroglancer/unstable/renderlayer.js";
import {
  SegmentColorShaderManager,
  SegmentStatedColorShaderManager,
} from "neuroglancer/unstable/segment_color.js";
import { getVisibleSegments } from "neuroglancer/unstable/segmentation_display_state/base.js";
import type { SegmentationDisplayState3D } from "neuroglancer/unstable/segmentation_display_state/frontend.js";
import { registerRedrawWhenSegmentationDisplayState3DChanged } from "neuroglancer/unstable/segmentation_display_state/frontend.js";
import { SharedWatchableValue } from "neuroglancer/unstable/shared_watchable_value.js";
import type { SkeletonRenderingOptions } from "neuroglancer/unstable/skeleton/frontend.js";
import { SkeletonRenderMode } from "neuroglancer/unstable/skeleton/frontend.js";
import { forEachVisibleVolumetricChunk } from "neuroglancer/unstable/sliceview/base.js";
import type {
  FrontendTransformedSource,
  SliceViewSingleResolutionSource,
} from "neuroglancer/unstable/sliceview/frontend.js";
import {
  getVolumetricTransformedSources,
  serializeAllTransformedSources,
  SliceViewChunk,
  SliceViewChunkSource,
} from "neuroglancer/unstable/sliceview/frontend.js";
import type { SliceViewPanelRenderContext } from "neuroglancer/unstable/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "neuroglancer/unstable/sliceview/renderlayer.js";
import type { WatchableValueInterface } from "neuroglancer/unstable/trackable_value.js";
import {
  makeCachedDerivedWatchableValue,
  registerNested,
  WatchableValue,
} from "neuroglancer/unstable/trackable_value.js";
import type { Uint64Map } from "neuroglancer/unstable/uint64_map.js";
import { DataType } from "neuroglancer/unstable/util/data_type.js";
import type { Borrowed } from "neuroglancer/unstable/util/disposable.js";
import { RefCounted } from "neuroglancer/unstable/util/disposable.js";
import {
  mat3,
  mat3FromMat4,
  mat4,
  scaleMat3Output,
  vec3,
} from "neuroglancer/unstable/util/geom.js";
import type { AnyConstructor } from "neuroglancer/unstable/util/mixin.js";
import { GLBuffer } from "neuroglancer/unstable/webgl/buffer.js";
import {
  defineCircleShader,
  drawCircles,
  initializeCircleShader,
} from "neuroglancer/unstable/webgl/circles.js";
import { glsl_COLORMAPS } from "neuroglancer/unstable/webgl/colormaps.js";
import type { GL } from "neuroglancer/unstable/webgl/context.js";
import type { WatchableShaderError } from "neuroglancer/unstable/webgl/dynamic_shader.js";
import {
  parameterizedEmitterDependentShaderGetter,
  shaderCodeWithLineDirective,
} from "neuroglancer/unstable/webgl/dynamic_shader.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
} from "neuroglancer/unstable/webgl/lines.js";
import type { ShaderBuilder, ShaderProgram } from "neuroglancer/unstable/webgl/shader.js";
import { glsl_uint64 } from "neuroglancer/unstable/webgl/shader_lib.js";
import type { ShaderControlsBuilderState } from "neuroglancer/unstable/webgl/shader_ui_controls.js";
import {
  addControlsToBuilder,
  getFallbackBuilderState,
  parseShaderUiControls,
} from "neuroglancer/unstable/webgl/shader_ui_controls.js";

import {
  computeTextureFormat,
  OneDimensionalTextureAccessHelper,
  setOneDimensionalTextureData,
  TextureFormat,
} from "neuroglancer/unstable/webgl/texture_access.js";
import { defineVertexId, VertexIdHelper } from "neuroglancer/unstable/webgl/vertex_id.js";

// ------------------------------------------------------------ chunks

const POSITION_FORMAT = computeTextureFormat(
  new TextureFormat(),
  DataType.FLOAT32,
  3,
);
// Segment ids are uploaded as two uint32 words per object, low word first,
// which is the layout of a UINT64 texel.
const SEGMENT_FORMAT = computeTextureFormat(
  new TextureFormat(),
  DataType.UINT64,
  1,
);
// One word per vertex: its object's slot, and whether it joins the last.
const VERTEX_WORD_FORMAT = computeTextureFormat(
  new TextureFormat(),
  DataType.UINT32,
  1,
);

/** `uChunkFlags`: edges between runs of rows follow from the vertex words. */
const SEQUENTIAL_FLAG = 1;
/** `uChunkFlags`: each vertex is its own object; there are no vertex words. */
const OBJECT_PER_VERTEX_FLAG = 2;

export class ZarrVectorsDenseChunk extends SliceViewChunk {
  numVertices = 0;
  numOwnVertices = 0;
  /** Edges listed (with `sequential`, the bridges only). */
  numEdges = 0;
  numFaces = 0;
  sequential = false;
  objectPerVertex = false;
  /**
   * The chunk as uploaded, kept while the chunk is (to upload again once
   * the GPU has let it go, as Neuroglancer does), and for picking: it is
   * a position and a word per vertex, the rest per object.
   */
  private uploads: DrawChunkData | undefined;
  /** Whether the GPU holds the chunk's data (an empty chunk has none to hold). */
  hasGPUData = false;
  positionTexture: WebGLTexture | null = null;
  vertexObjectTexture: WebGLTexture | null = null;
  objectIdTexture: WebGLTexture | null = null;
  attributeTextures: (WebGLTexture | null)[] = [];
  /** Layout entries (bits) that have a per-object texture. */
  objectValueMask = 0;
  edgeBuffer: GLBuffer | undefined;
  faceBuffer: GLBuffer | undefined;
  /** A mesh's vertex normals, for shading its faces in 3-d. */
  normalTexture: WebGLTexture | null = null;
  /** Normals of other surfaces of the same vertices, by attribute index, made when first drawn. */
  private alternateNormals = new Map<number, WebGLTexture | null>();

  get flags(): number {
    return (
      (this.sequential ? SEQUENTIAL_FLAG : 0) |
      (this.objectPerVertex ? OBJECT_PER_VERTEX_FLAG : 0)
    );
  }

  /** The normals for vertices placed by attribute `position` (-1: their positions). */
  normalTextureFor(gl: GL, position: number): WebGLTexture | null {
    if (position === -1) return this.normalTexture;
    let texture = this.alternateNormals.get(position);
    if (texture === undefined) {
      const coords = this.uploads?.attributes[position];
      const faces = this.uploads?.faces;
      texture = null;
      if (coords !== undefined && faces !== undefined) {
        texture = gl.createTexture();
        gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
        setOneDimensionalTextureData(
          gl,
          POSITION_FORMAT,
          vertexNormals(coords, faces, this.numVertices),
        );
        gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
      }
      this.alternateNormals.set(position, texture);
    }
    return texture;
  }

  /** The object slot of vertex `v`. */
  private slotOf(v: number): number | undefined {
    if (this.objectPerVertex) return v;
    const word = this.uploads?.vertexObjects[v];
    return word === undefined ? undefined : word & OBJECT_SLOT_MASK;
  }

  /** The segment id of vertex `v`, for picking. */
  segmentIdOf(v: number): bigint | undefined {
    const slot = this.slotOf(v);
    const ids = this.uploads?.objectIds;
    if (slot === undefined || ids === undefined || 2 * slot + 1 >= ids.length) {
      return undefined;
    }
    return BigInt(ids[2 * slot]) | (BigInt(ids[2 * slot + 1]) << 32n);
  }

  /**
   * Layout entry `i`'s value (its first component) at vertex `v`, where the
   * CPU keeps it: object values, and a mesh's per-vertex values.
   */
  valueOf(i: number, v: number): number | undefined {
    const values = this.uploads?.attributes[i];
    if (values === undefined) return undefined;
    const layout = (this.source as ZarrVectorsGeometryChunkSource).layout[i];
    if (layout?.kind === "object") {
      const slot = this.slotOf(v);
      return slot === undefined ? undefined : values[slot];
    }
    return values[v * (layout?.components ?? 1)];
  }

  constructor(source: SliceViewChunkSource, x: any) {
    super(source, x);
    const data = x.data as DrawChunkData | undefined;
    if (data !== undefined) {
      this.numVertices = data.numVertices;
      this.numOwnVertices = data.numOwnVertices;
      this.numEdges = data.edges.length / 2;
      this.numFaces = data.faces.length / 3;
      this.sequential = data.sequential;
      this.objectPerVertex = data.objectPerVertex;
      this.uploads = data;
      (source as ZarrVectorsGeometryChunkSource).knownBytes.set(
        x.id,
        drawChunkBytes(data).gpu,
      );
    }
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    const uploads = this.uploads;
    this.hasGPUData = true;
    if (uploads === undefined) return;
    const texture = (
      format: TextureFormat,
      data: Float32Array | Uint32Array | undefined,
    ) => {
      if (data === undefined || data.length === 0) return null;
      const t = gl.createTexture();
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, t);
      setOneDimensionalTextureData(gl, format, data);
      return t;
    };
    this.positionTexture = texture(POSITION_FORMAT, uploads.positions);
    this.vertexObjectTexture = texture(VERTEX_WORD_FORMAT, uploads.vertexObjects);
    this.objectIdTexture = texture(SEGMENT_FORMAT, uploads.objectIds);
    const source = this.source as ZarrVectorsGeometryChunkSource;
    const formats = source.attributeFormats;
    this.attributeTextures = uploads.attributes.map((a, i) =>
      texture(formats[i], a),
    );
    this.objectValueMask = 0;
    source.layout.forEach((a, i) => {
      if (a.kind === "object" && uploads.attributes[i] !== undefined) {
        this.objectValueMask |= 1 << i;
      }
    });
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
    if (this.numEdges > 0) {
      this.edgeBuffer = GLBuffer.fromData(
        gl,
        uploads.edges,
        WebGL2RenderingContext.ARRAY_BUFFER,
        WebGL2RenderingContext.STATIC_DRAW,
      );
    }
    if (this.numFaces > 0) {
      this.faceBuffer = GLBuffer.fromData(
        gl,
        uploads.faces,
        WebGL2RenderingContext.ARRAY_BUFFER,
        WebGL2RenderingContext.STATIC_DRAW,
      );
      this.normalTexture = texture(
        POSITION_FORMAT,
        vertexNormals(uploads.positions, uploads.faces, this.numVertices),
      );
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
    }
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    for (const t of [
      this.positionTexture,
      this.vertexObjectTexture,
      this.objectIdTexture,
      this.normalTexture,
      ...this.attributeTextures,
    ]) {
      gl.deleteTexture(t);
    }
    this.positionTexture = this.vertexObjectTexture = null;
    this.objectIdTexture = this.normalTexture = null;
    for (const t of this.alternateNormals.values()) gl.deleteTexture(t);
    this.alternateNormals.clear();
    this.attributeTextures = [];
    this.edgeBuffer?.dispose();
    this.edgeBuffer = undefined;
    this.faceBuffer?.dispose();
    this.faceBuffer = undefined;
    this.hasGPUData = false;
  }
}

/**
 * Each vertex's normal: the sum of its faces' normals weighted by their
 * areas (the cross product's length), normalised, so a surface shades
 * smoothly; faces wound either way give the same light (shading uses the
 * normal's absolute cosine).
 */
export function vertexNormals(
  positions: Float32Array,
  faces: Uint32Array,
  numVertices: number,
): Float32Array {
  const out = new Float32Array(3 * numVertices);
  for (let f = 0; f + 3 <= faces.length; f += 3) {
    const a = 3 * faces[f];
    const b = 3 * faces[f + 1];
    const c = 3 * faces[f + 2];
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      out[v] += nx;
      out[v + 1] += ny;
      out[v + 2] += nz;
    }
  }
  for (let v = 0; v < out.length; v += 3) {
    const length = Math.hypot(out[v], out[v + 1], out[v + 2]);
    if (length > 0) {
      out[v] /= length;
      out[v + 1] /= length;
      out[v + 2] /= length;
    }
  }
  return out;
}

class ZarrVectorsGeometryChunkSourceBase extends SliceViewChunkSource<ZarrVectorsChunkSpecification> {
  getChunk(x: any): SliceViewChunk {
    return new ZarrVectorsDenseChunk(this, x);
  }
}

export class ZarrVectorsGeometryChunkSource extends WithParameters(
  WithSharedKvStoreContext(ZarrVectorsGeometryChunkSourceBase),
  ZarrVectorsGeometryChunkSourceParameters,
) {
  private attributeFormats_: TextureFormat[] | undefined;
  private layout_: DrawAttribute[] | undefined;
  /** GPU bytes of each chunk received so far, by key, for the 3-d view's budget. */
  knownBytes = new Map<string, number>();

  /** The values the shader reads per vertex, as chunks carry them. */
  get layout(): DrawAttribute[] {
    return (this.layout_ ??= drawLayout(this.parameters.description));
  }

  get isMesh(): boolean {
    return (
      KIND_CAPABILITIES[this.parameters.description.geometryKind].primitive ===
      "triangles"
    );
  }

  get attributeFormats(): TextureFormat[] {
    if (this.attributeFormats_ === undefined) {
      this.attributeFormats_ = this.layout.map(
        (a) =>
          computeTextureFormat(
            new TextureFormat(),
            DataType.FLOAT32,
            a.components,
          ),
      );
    }
    return this.attributeFormats_;
  }
}

/** The per-vertex attributes a chunk's shader reads, in order. */
export function attributeLayout(
  description: ZarrVectorsGeometryDescription,
): DrawAttribute[] {
  return drawLayout(description);
}

/** All levels of a store, as one multiscale slice-view source. */
export class ZarrVectorsMultiscaleGeometrySource extends RefCounted {
  constructor(
    public chunkManager: Borrowed<ChunkManager>,
    public sharedKvStoreContext: SharedKvStoreContext,
    public description: ZarrVectorsGeometryDescription,
    public levels: {
      spec: ZarrVectorsChunkSpecification;
      parameters: ZarrVectorsGeometryChunkSourceParameters;
    }[],
    /** Vertices per unit volume each level's view draws (finest first). */
    public densities: number[],
    /**
     * The levels each level's view draws: itself, and the coarser levels an
     * additive level adds to (`levelChain`).
     */
    public chains: number[][],
  ) {
    super();
  }

  get rank() {
    return 3;
  }

  /**
   * Each level's chunk source. `objectValues`, the object values a shader
   * reads (see {@link shaderObjectValues}), are part of a source's
   * parameters: a shader that reads another one gets sources that read it.
   */
  getSources(
    objectValues?: readonly string[],
  ): SliceViewSingleResolutionSource<ZarrVectorsGeometryChunkSource>[][] {
    return [
      this.levels.map(({ spec, parameters }) => ({
        chunkSource: this.chunkManager.getChunkSource(
          ZarrVectorsGeometryChunkSource,
          {
            sharedKvStoreContext: this.sharedKvStoreContext,
            spec,
            parameters:
              objectValues === undefined
                ? parameters
                : Object.assign(
                    new ZarrVectorsGeometryChunkSourceParameters(),
                    parameters,
                    { objectValues: [...objectValues] },
                  ),
          },
        ),
        chunkToMultiscaleTransform: identityTransform(spec.rank),
      })),
    ];
  }
}

function identityTransform(rank: number) {
  const out = new Float32Array((rank + 1) ** 2);
  for (let i = 0; i <= rank; ++i) out[i * (rank + 1) + i] = 1;
  return out;
}

// ------------------------------------------------------------ render layer

export interface ZarrVectorsDenseDisplayState
  extends Omit<
    SegmentationDisplayState3D,
    "selectedAlpha" | "notSelectedAlpha"
  > {
  skeletonRenderingOptions: SkeletonRenderingOptions;
  shaderError: WatchableShaderError;
  selectedAlpha: WatchableValueInterface<number>;
  notSelectedAlpha: WatchableValueInterface<number>;
  ignoreNullVisibleSet: WatchableValueInterface<boolean>;
  localPosition: WatchableValueInterface<Float32Array>;
  /** `crossSectionRenderScale`: target pixels between vertices in 2-D. */
  renderScaleTarget2d: WatchableValueInterface<number>;
  /** The "Resolution (slice)" histogram; 3-d views use `renderScaleHistogram`. */
  renderScaleHistogram2d: RenderScaleHistogram;
  /**
   * Whether the layer also draws the selected objects at full resolution
   * through Neuroglancer's skeleton layer; then they are left out here.
   */
  objectsDrawnElsewhere: WatchableValueInterface<boolean>;
}

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitDefault();
}
`;

const SHOW_ALL_FLAG = 1;
const HIDE_VISIBLE_FLAG = 2;

const tempMat4 = mat4.create();
const tempMat3 = mat3.create();
const tempLight = new Float32Array(4);

interface DenseAttachmentState {
  transform: RenderLayerTransformOrError;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  modelMatrix: mat4 | undefined;
  sources: { readonly value: FrontendTransformedSource[][] };
}

class DenseRenderHelper extends RefCounted {
  private textureAccess = new OneDimensionalTextureAccessHelper("vertexData");
  private vertexIdHelper: VertexIdHelper;
  private visibleSegments = new HashSetShaderManager("visibleSegments");
  private segmentColor = new SegmentColorShaderManager("segmentColorHash");
  private statedColors = new SegmentStatedColorShaderManager("statedColor");
  readonly attributes: DrawAttribute[];
  readonly primitive: "lines" | "points";
  edgeShaderGetter;
  nodeShaderGetter;
  /** A mesh in a cross-section: each triangle as the segment where it crosses the section. */
  sectionShaderGetter;
  /** A mesh in 3-d: its faces, filled and lit. */
  faceShaderGetter;
  readonly triangles: boolean;
  /** Per attribute (in `attributes` order), a parcellation's table, if it is one. */
  readonly labelTables: ({ code: number; name: string; rgba: number[] }[] | undefined)[];

  constructor(
    private gl: GL,
    private displayState: ZarrVectorsDenseDisplayState,
    description: ZarrVectorsGeometryDescription,
    private targetIsSliceView: boolean,
    fallbackParameters: WatchableValueInterface<ShaderControlsBuilderState>,
  ) {
    super();
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(gl));
    this.attributes = attributeLayout(description);
    this.primitive =
      KIND_CAPABILITIES[description.geometryKind].primitive === "lines"
        ? "lines"
        : "points";
    this.triangles =
      KIND_CAPABILITIES[description.geometryKind].primitive === "triangles";
    this.labelTables = this.attributes.map(
      (a) =>
        description.attributes.find((d) => d.id === a.id && a.components === 1)
          ?.labels,
    );
    const common = {
      fallbackParameters,
      parameters:
        displayState.skeletonRenderingOptions.shaderControlState.builderState,
      shaderError: displayState.shaderError,
    };
    this.edgeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      gl,
      {
        memoizeKey: {
          type: "zarr-vectors/dense/edge",
          attributes: this.attributes,
          slice: targetIsSliceView,
        },
        ...common,
        defineShader: (
          builder: ShaderBuilder,
          state: ShaderControlsBuilderState,
        ) => this.defineShader(builder, state, true),
      },
    );
    this.nodeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      gl,
      {
        memoizeKey: {
          type: "zarr-vectors/dense/node",
          attributes: this.attributes,
          slice: targetIsSliceView,
        },
        ...common,
        defineShader: (
          builder: ShaderBuilder,
          state: ShaderControlsBuilderState,
        ) => this.defineShader(builder, state, false),
      },
    );
    this.sectionShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      gl,
      {
        memoizeKey: {
          type: "zarr-vectors/dense/section",
          attributes: this.attributes,
          slice: targetIsSliceView,
        },
        ...common,
        defineShader: (
          builder: ShaderBuilder,
          state: ShaderControlsBuilderState,
        ) => this.defineShader(builder, state, true, true),
      },
    );
    this.faceShaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      gl,
      {
        memoizeKey: {
          type: "zarr-vectors/dense/faces",
          attributes: this.attributes,
          labels: this.labelTables,
          slice: targetIsSliceView,
        },
        ...common,
        defineShader: (
          builder: ShaderBuilder,
          state: ShaderControlsBuilderState,
        ) => this.defineShader(builder, state, false, false, true),
      },
    );
  }

  private fadeFactor() {
    return this.targetIsSliceView
      ? "(clamp(1.0 - 2.0 * abs(0.5 - gl_FragCoord.z), 0.0, 1.0))"
      : "(1.0)";
  }

  private defineShader(
    builder: ShaderBuilder,
    state: ShaderControlsBuilderState,
    edges: boolean,
    sections = false,
    faces = false,
  ) {
    if (state.parseResult.errors.length !== 0) {
      throw new Error("Invalid UI control specification");
    }
    defineVertexId(builder);
    builder.addUniform("highp mat4", "uProjection");
    builder.addUniform("highp uint", "uPickID");
    builder.addUniform("highp uint", "uFlags");
    builder.addUniform("highp float", "uVisibleAlpha");
    builder.addUniform("highp float", "uHiddenAlpha");
    builder.addUniform("highp float", "uSaturation");
    builder.addUniform("highp vec4", "uDefaultColor");
    builder.addUniform("highp uint", "uHasDefaultColor");
    builder.addUniform("highp uint", "uHasStatedColors");
    this.textureAccess.defineShader(builder);
    builder.addUniform("highp uint", "uNumOwnVertices");
    builder.addUniform("highp uint", "uChunkFlags");
    builder.addUniform("highp uint", "uObjectValueMask");
    builder.addTextureSampler("sampler2D", "uPositions", positionSampler);
    builder.addTextureSampler("usampler2D", "uVertexObjects", vertexObjectSampler);
    builder.addTextureSampler("usampler2D", "uSegments", segmentSampler);
    builder.addVertexCode(
      this.textureAccess.getAccessor(
        "readPosition",
        "uPositions",
        DataType.FLOAT32,
        3,
      ),
    );
    builder.addVertexCode(glsl_uint64);
    builder.addVertexCode(
      this.textureAccess.getAccessor(
        "readObjectId",
        "uSegments",
        DataType.UINT64,
        1,
      ),
    );
    builder.addVertexCode(
      this.textureAccess.getAccessor(
        "readVertexWord",
        "uVertexObjects",
        DataType.UINT32,
        1,
      ),
    );
    // A vertex's object is a slot in the chunk's list of objects (or the
    // vertex itself), and its word says whether an edge joins it to the
    // vertex before (`dense_pack.ts`).
    builder.addVertexCode(`
highp uint zvObjectSlot(highp uint i) {
  return (uChunkFlags & ${OBJECT_PER_VERTEX_FLAG}u) != 0u
      ? i : (readVertexWord(i).value & ${OBJECT_SLOT_MASK}u);
}
bool zvJoinsPrevious(highp uint i) {
  return (uChunkFlags & ${SEQUENTIAL_FLAG | OBJECT_PER_VERTEX_FLAG}u) == ${SEQUENTIAL_FLAG}u &&
      i > 0u && i < uNumOwnVertices &&
      (readVertexWord(i).value & ${JOINS_PREVIOUS}u) != 0u;
}
uint64_t readSegment(highp uint i) {
  return readObjectId(zvObjectSlot(i));
}
`);
    this.attributes.forEach((a, i) => {
      builder.addTextureSampler(
        "sampler2D",
        `uAttribute${i}`,
        attributeSampler(i),
      );
      const raw = a.kind === "vertex" ? `readAttribute${i}` : `readStored${i}`;
      builder.addVertexCode(
        this.textureAccess.getAccessor(
          raw,
          `uAttribute${i}`,
          DataType.FLOAT32,
          a.components,
        ),
      );
      if (a.kind === "object") {
        // Once per object; no value where the chunk carries none.
        builder.addVertexCode(`
highp float readAttribute${i}(highp uint i) {
  if ((uObjectValueMask & ${(1 << i) >>> 0}u) == 0u) return uintBitsToFloat(0x7fc00000u);
  return readStored${i}(zvObjectSlot(i));
}
`);
      } else if (a.kind === "tangent") {
        // Along a run of rows, from the neighbours' positions as the
        // worker's walk tangents are; stored for the far ends of bridges,
        // and for every vertex of other chunks.
        builder.addVertexCode(`
highp vec3 readAttribute${i}(highp uint i) {
  if ((uChunkFlags & ${SEQUENTIAL_FLAG}u) == 0u) return readStored${i}(i);
  if (i >= uNumOwnVertices) return readStored${i}(i - uNumOwnVertices);
  highp uint previous = zvJoinsPrevious(i) ? i - 1u : i;
  highp uint next = zvJoinsPrevious(i + 1u) ? i + 1u : i;
  highp vec3 d = readPosition(next) - readPosition(previous);
  highp float n = length(d);
  return n > 0.0 ? d / n : vec3(0.0);
}
`);
      }
    });
    // Where vertices are drawn: their positions, or another surface of the
    // same vertices kept as a vec3 attribute (`coords_inflated`), as the
    // shader names it.
    const position = positionAttribute(
      state.parseResult.code,
      this.attributes,
    );
    builder.addVertexCode(`
highp vec3 zvPosition(highp uint i) {
  return ${position === -1 ? "readPosition(i)" : `readAttribute${position}(i)`};
}
`);
    builder.addVarying("highp uvec2", "vSegment", "flat");
    if (!faces) builder.addVarying("highp uint", "vPickID", "flat");
    let vertexMain: string;
    // How each attribute's varying is set: from `vertexIndex`, unless a
    // pass says otherwise.
    let readAttributes = (i: number) =>
      `vAttribute${i} = readAttribute${i}(vertexIndex);\n`;
    if (faces) {
      // Instanced: one triangle per instance, its corner from gl_VertexID.
      // Values are interpolated across the face; a parcellation's code is
      // the nearest corner's (its three as a flat vec3), so its borders
      // stay sharp.  The picked vertex is the nearest corner too.
      builder.addAttribute("highp uvec3", "aTriangle");
      builder.addUniform("highp mat3", "uNormalMatrix");
      builder.addUniform("highp vec4", "uLightDirection");
      builder.addTextureSampler("sampler2D", "uNormals", normalSampler);
      builder.addVertexCode(
        this.textureAccess.getAccessor(
          "readNormal",
          "uNormals",
          DataType.FLOAT32,
          3,
        ),
      );
      builder.addVarying("highp vec3", "vNormal");
      builder.addVarying("highp vec3", "vBarycentric");
      builder.addVarying("highp uvec3", "vCorners", "flat");
      vertexMain = `
highp uint corner = uint(gl_VertexID);
highp uint vertexIndex = corner == 0u ? aTriangle.x : (corner == 1u ? aTriangle.y : aTriangle.z);
gl_Position = uProjection * vec4(zvPosition(vertexIndex), 1.0);
vNormal = uNormalMatrix * readNormal(vertexIndex);
vBarycentric = vec3(corner == 0u ? 1.0 : 0.0, corner == 1u ? 1.0 : 0.0, corner == 2u ? 1.0 : 0.0);
vCorners = aTriangle;
vSegment = readSegment(vertexIndex).value;
`;
      builder.addFragmentCode(`
highp uint zvNearestCorner() {
  return vBarycentric.x >= vBarycentric.y && vBarycentric.x >= vBarycentric.z
      ? vCorners.x
      : (vBarycentric.y >= vBarycentric.z ? vCorners.y : vCorners.z);
}
float zvNearest(vec3 values) {
  return vBarycentric.x >= vBarycentric.y && vBarycentric.x >= vBarycentric.z
      ? values.x
      : (vBarycentric.y >= vBarycentric.z ? values.y : values.z);
}
#define vPickID (uPickID + zvNearestCorner())
`);
      readAttributes = (i: number) =>
        this.labelTables[i] !== undefined
          ? `vAttribute${i} = vec3(readAttribute${i}(aTriangle.x), readAttribute${i}(aTriangle.y), readAttribute${i}(aTriangle.z));\n`
          : `vAttribute${i} = readAttribute${i}(vertexIndex);\n`;
    } else if (sections) {
      // A triangle's crossing with the section (clip z = 0 in a
      // cross-section): the two points where its edges cross it, drawn as a
      // line; a triangle that does not cross it is put outside the view.
      defineLineShader(builder);
      builder.addAttribute("highp uvec3", "aTriangle");
      builder.addUniform("highp float", "uLineWidth");
      vertexMain = `
highp vec3 p0 = zvPosition(aTriangle.x);
highp vec3 p1 = zvPosition(aTriangle.y);
highp vec3 p2 = zvPosition(aTriangle.z);
highp float d0 = (uProjection * vec4(p0, 1.0)).z;
highp float d1 = (uProjection * vec4(p1, 1.0)).z;
highp float d2 = (uProjection * vec4(p2, 1.0)).z;
highp vec3 ends[2];
ends[0] = p0;
ends[1] = p0;
// Each end's edge and how far along it, so values are those at the crossing.
highp uvec2 edgeOf[2];
edgeOf[0] = aTriangle.xy;
edgeOf[1] = aTriangle.xy;
highp float along[2];
along[0] = 0.0;
along[1] = 0.0;
int found = 0;
if ((d0 < 0.0) != (d1 < 0.0)) { along[found] = d0 / (d0 - d1); edgeOf[found] = aTriangle.xy; ends[found] = mix(p0, p1, along[found]); ++found; }
if ((d1 < 0.0) != (d2 < 0.0)) { along[found] = d1 / (d1 - d2); edgeOf[found] = aTriangle.yz; ends[found] = mix(p1, p2, along[found]); ++found; }
if (found < 2 && (d2 < 0.0) != (d0 < 0.0)) { along[found] = d2 / (d2 - d0); edgeOf[found] = aTriangle.zx; ends[found] = mix(p2, p0, along[found]); ++found; }
emitLine(uProjection, ends[0], ends[1], uLineWidth);
if (found < 2) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
int end = int(getLineEndpointIndex());
highp uvec2 edge = edgeOf[end];
highp float t = along[end];
highp uint vertexIndex = t < 0.5 ? edge.x : edge.y;
vSegment = readSegment(aTriangle.x).value;
vPickID = uPickID + vertexIndex;
`;
      readAttributes = (i: number) =>
        this.labelTables[i] !== undefined
          ? `vAttribute${i} = readAttribute${i}(vertexIndex);\n`
          : `vAttribute${i} = mix(readAttribute${i}(edge.x), readAttribute${i}(edge.y), t);\n`;
    } else if (edges) {
      defineLineShader(builder);
      builder.addAttribute("highp uvec2", "aVertexIndex");
      builder.addUniform("highp float", "uLineWidth");
      // Runs of rows are drawn without an index buffer: instance i is the
      // edge from vertex i to i + 1, put outside the view unless they join.
      builder.addUniform("highp uint", "uSequentialDraw");
      vertexMain = `
highp uvec2 edge = uSequentialDraw != 0u
    ? uvec2(uint(gl_InstanceID), uint(gl_InstanceID) + 1u)
    : aVertexIndex;
highp vec3 vertexA = zvPosition(edge.x);
highp vec3 vertexB = zvPosition(edge.y);
emitLine(uProjection, vertexA, vertexB, uLineWidth);
if (uSequentialDraw != 0u && !zvJoinsPrevious(edge.y)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
highp uint endpoint = getLineEndpointIndex();
highp uint vertexIndex = edge.x * (1u - endpoint) + edge.y * endpoint;
vSegment = readSegment(edge.x).value;
vPickID = uPickID + edge.x;
`;
    } else {
      defineCircleShader(builder, this.targetIsSliceView);
      builder.addUniform("highp float", "uNodeDiameter");
      vertexMain = `
highp uint vertexIndex = uint(gl_InstanceID);
emitCircle(uProjection * vec4(zvPosition(vertexIndex), 1.0), uNodeDiameter, 0.0);
vSegment = readSegment(vertexIndex).value;
vPickID = uPickID + vertexIndex;
`;
    }
    this.attributes.forEach((a, i) => {
      const type = a.components === 1 ? "float" : `vec${a.components}`;
      if (faces && this.labelTables[i] !== undefined) {
        builder.addVarying("highp vec3", `vAttribute${i}`, "flat");
        builder.addFragmentCode(
          `#define prop_${a.id}() zvNearest(vAttribute${i})\n`,
        );
      } else {
        builder.addVarying(`highp ${type}`, `vAttribute${i}`);
        builder.addFragmentCode(`#define prop_${a.id}() vAttribute${i}\n`);
      }
      vertexMain += readAttributes(i);
      const table = this.labelTables[i];
      if (table !== undefined) {
        builder.addFragmentCode(labelColourFunction(a.id, table));
      }
    });
    builder.setVertexMain(vertexMain);

    builder.addFragmentCode(glsl_uint64);
    this.visibleSegments.defineShader(builder);
    this.segmentColor.defineShader(builder);
    this.statedColors.defineShader(builder);
    const alpha = edges ? `getLineAlpha() * ${this.fadeFactor()}` : "1.0";
    builder.addFragmentCode(
      glslZvEmit(emitsPremultipliedAlpha(this.targetIsSliceView)),
    );
    builder.addFragmentCode(`
float zvAlpha;
vec4 zvColor;
void zvResolveSegment() {
  uint64_t id;
  id.value = vSegment;
  bool visible = (uFlags & ${SHOW_ALL_FLAG}u) != 0u ||
      ${this.visibleSegments.hasFunctionName}(id);
  zvAlpha = visible ? uVisibleAlpha : uHiddenAlpha;
  if (visible && (uFlags & ${HIDE_VISIBLE_FLAG}u) != 0u) zvAlpha = 0.0;
  vec4 rgba = vec4(0.0);
  bool stated = uHasStatedColors != 0u && ${this.statedColors.getFunctionName}(id, rgba);
  if (!stated) {
    rgba = uHasDefaultColor != 0u ? vec4(uDefaultColor.rgb, 0.0)
                                 : vec4(segmentColorHash(id), 0.0);
  }
  zvColor = vec4(mix(vec3(1.0), rgba.rgb, uSaturation), zvAlpha);
}
vec4 segmentColor() {
  return zvColor;
}
`);
    if (faces) {
      builder.addFragmentCode(`
vec3 zvShade(vec3 color) {
  // Neuroglancer's mesh lighting (ambient, and a light from the viewer,
  // either side of the face), with a faint highlight as Freeview has.
  vec3 normal = normalize(vNormal);
  float cosine = abs(dot(normal, uLightDirection.xyz));
  float facing = abs(dot(normal, normalize(uLightDirection.xyz)));
  return color * (cosine + uLightDirection.w) + vec3(0.12 * pow(facing, 24.0));
}
void emitRGBA(vec4 color) {
  zvEmit(zvShade(color.rgb), color.a, vPickID);
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, zvAlpha));
}
void emitDefault() {
  emitRGBA(zvColor);
}
`);
    } else if (edges) {
      builder.addFragmentCode(`
void emitRGBA(vec4 color) {
  // The object's opacity times the line's coverage of this fragment (its
  // feathered edge; in a cross-section, its fade away from the section).
  zvEmit(color.rgb, color.a * ${alpha}, vPickID);
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, zvAlpha));
}
void emitDefault() {
  emitRGBA(zvColor);
}
`);
    } else {
      builder.addFragmentCode(`
void emitRGBA(vec4 color) {
  vec4 circle = getCircleColor(color, color);
  zvEmit(circle.rgb, circle.a, vPickID);
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, zvAlpha));
}
void emitDefault() {
  emitRGBA(zvColor);
}
`);
    }
    builder.addFragmentCode(glsl_COLORMAPS);
    // So a shader can draw a surface's outline on the sections apart from
    // its faces in 3-d (`#ifdef ZV_SECTION`).
    if (sections) builder.addFragmentCode("#define ZV_SECTION 1\n");
    addControlsToBuilder(state, builder);
    addStringShaderSupport(builder);
    builder.addFragmentCode(`
void zvUserMain();
`);
    const userMain = shaderCodeWithLineDirective(
      state.parseResult.code,
    ).replace(/\bvoid\s+main\s*\(\s*\)/, "void zvUserMain()");
    // Bare attribute names too, as Neuroglancer's skeleton layer has them,
    // so one shader serves this layer and `objects`; defined after the
    // layer's own code so they cannot rename anything in it.
    builder.addFragmentCode(
      this.attributes.map((a) => `#define ${a.id} prop_${a.id}()\n`).join(""),
    );
    builder.addFragmentCode(userMain);
    builder.setFragmentMain(`
zvResolveSegment();
if (zvAlpha <= 0.0) discard;
zvUserMain();
`);
  }

  private gpuVisible: GPUHashTable<any> | undefined;
  private gpuStated: GPUHashTable<HashMapUint64> | undefined;
  private statedMap: Uint64Map | undefined;

  /** Sets the per-layer uniforms and binds the segment hash tables. */
  beginLayer(
    shader: ShaderProgram,
    modelViewProjection: mat4,
    visibleAlpha: number,
  ) {
    const { gl, displayState } = this;
    gl.uniformMatrix4fv(
      shader.uniform("uProjection"),
      false,
      modelViewProjection,
    );
    this.vertexIdHelper.enable();
    const groupState = displayState.segmentationGroupState.value;
    const visible = getVisibleSegments(groupState);
    let flags = 0;
    if (
      visible.hashTable.size === 0 &&
      displayState.ignoreNullVisibleSet.value
    ) {
      flags |= SHOW_ALL_FLAG;
    } else if (displayState.objectsDrawnElsewhere.value) {
      flags |= HIDE_VISIBLE_FLAG;
    }
    gl.uniform1ui(shader.uniform("uFlags"), flags);
    gl.uniform1f(shader.uniform("uVisibleAlpha"), visibleAlpha);
    gl.uniform1f(
      shader.uniform("uHiddenAlpha"),
      displayState.notSelectedAlpha.value,
    );
    gl.uniform1f(shader.uniform("uSaturation"), displayState.saturation.value);
    if (
      this.gpuVisible === undefined ||
      this.gpuVisible.hashTable !== visible.hashTable
    ) {
      this.gpuVisible?.dispose();
      this.gpuVisible = GPUHashTable.get(gl, visible.hashTable);
    }
    this.visibleSegments.enable(gl, shader, this.gpuVisible);
    this.segmentColor.enable(gl, shader, displayState.segmentColorHash.value);
    const defaultColor = displayState.segmentDefaultColor.value;
    gl.uniform1ui(
      shader.uniform("uHasDefaultColor"),
      defaultColor === undefined ? 0 : 1,
    );
    if (defaultColor !== undefined) {
      gl.uniform4f(
        shader.uniform("uDefaultColor"),
        defaultColor[0],
        defaultColor[1],
        defaultColor[2],
        1,
      );
    }
    const stated = displayState.segmentStatedColors.value;
    gl.uniform1ui(
      shader.uniform("uHasStatedColors"),
      stated.size === 0 ? 0 : 1,
    );
    if (this.gpuStated === undefined || this.statedMap !== stated) {
      this.gpuStated?.dispose();
      this.gpuStated = GPUHashTable.get(gl, stated.hashTable);
      this.statedMap = stated;
    }
    this.statedColors.enable(gl, shader, this.gpuStated);
  }

  endLayer(shader: ShaderProgram) {
    const { gl } = this;
    this.visibleSegments.disable(gl, shader);
    this.statedColors.disable(gl, shader);
    this.vertexIdHelper.disable();
  }

  bindChunk(
    shader: ShaderProgram,
    chunk: ZarrVectorsDenseChunk,
    position = -1,
  ) {
    const { gl } = this;
    const bind = (symbol: symbol, texture: WebGLTexture | null) => {
      gl.activeTexture(
        WebGL2RenderingContext.TEXTURE0 + shader.textureUnit(symbol),
      );
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
    };
    bind(positionSampler, chunk.positionTexture);
    bind(vertexObjectSampler, chunk.vertexObjectTexture);
    bind(segmentSampler, chunk.objectIdTexture);
    gl.uniform1ui(shader.uniform("uNumOwnVertices"), chunk.numOwnVertices);
    gl.uniform1ui(shader.uniform("uChunkFlags"), chunk.flags);
    gl.uniform1ui(shader.uniform("uObjectValueMask"), chunk.objectValueMask);
    if (shader.textureUnit(normalSampler) !== undefined) {
      bind(normalSampler, chunk.normalTextureFor(gl, position));
    }
    chunk.attributeTextures.forEach((t, i) => bind(attributeSampler(i), t));
  }

  disposed() {
    this.gpuVisible?.dispose();
    this.gpuStated?.dispose();
    super.disposed();
  }
}

/** Where the mouse state keeps the dense layer's picked vertex. */
const PICKED_VERTEX = Symbol("zarr-vectors.pickedVertex");

/**
 * The values of the vertex under the mouse, when one of `renderLayers`
 * drew it: each attribute's (the first component of a wide one) by id.
 */
export function pickedVertexValues(
  mouseState: MouseSelectionState,
  renderLayers: readonly unknown[],
): Record<string, number> | undefined {
  const pick = (mouseState as any)[PICKED_VERTEX] as
    | { renderLayer: any; chunk: ZarrVectorsDenseChunk; vertex: number }
    | undefined;
  if (
    pick === undefined ||
    !mouseState.active ||
    (mouseState as any).pickedRenderLayer !== pick.renderLayer ||
    !renderLayers.includes(pick.renderLayer)
  ) {
    return undefined;
  }
  const layout: { id: string; components: number }[] =
    pick.renderLayer.helper.attributes;
  const out: Record<string, number> = {};
  layout.forEach((a, i) => {
    const v = pick.chunk.valueOf(i, pick.vertex);
    if (v !== undefined) out[a.id] = v;
  });
  return out;
}

const positionSampler = Symbol("zarr-vectors.positions");
const normalSampler = Symbol("zarr-vectors.normals");

/**
 * A parcellation's colours as a GLSL function of its code, `lut_<id>(code)`
 * (r, g, b, a; transparent for a code not in the table, such as -1): an
 * array lookup when the codes run on from the first, else a search.
 */
export function labelColourFunction(
  id: string,
  table: readonly { code: number; rgba: readonly number[] }[],
): string {
  const f = (v: number) => {
    const t = String(Number(Math.min(1, Math.max(0, v)).toFixed(4)));
    return t.includes(".") ? t : `${t}.0`;
  };
  const sorted = [...table].sort((a, b) => a.code - b.code);
  const n = sorted.length;
  if (n === 0) return `vec4 lut_${id}(float code) { return vec4(0.0); }\n`;
  const colours = sorted
    .map((l) => `vec4(${[0, 1, 2, 3].map((k) => f(l.rgba[k] ?? 1)).join(", ")})`)
    .join(",\n    ");
  const first = sorted[0].code;
  const contiguous = sorted.every((l, i) => l.code === first + i);
  if (contiguous) {
    return `vec4 lut_${id}(float code) {
  const vec4 colours[${n}] = vec4[${n}](
    ${colours});
  int i = int(floor(code + 0.5)) - (${first});
  if (i < 0 || i >= ${n}) return vec4(0.0);
  return colours[i];
}
`;
  }
  const codes = sorted.map((l) => String(l.code)).join(", ");
  return `vec4 lut_${id}(float code) {
  const int codes[${n}] = int[${n}](${codes});
  const vec4 colours[${n}] = vec4[${n}](
    ${colours});
  int c = int(floor(code + 0.5));
  for (int i = 0; i < ${n}; ++i) {
    if (codes[i] == c) return colours[i];
  }
  return vec4(0.0);
}
`;
}
const segmentSampler = Symbol("zarr-vectors.segments");
const vertexObjectSampler = Symbol("zarr-vectors.vertexObjects");
const attributeSamplers: symbol[] = [];
function attributeSampler(i: number) {
  while (attributeSamplers.length <= i) {
    attributeSamplers.push(
      Symbol(`zarr-vectors.attribute${attributeSamplers.length}`),
    );
  }
  return attributeSamplers[i];
}

export interface ZarrVectorsDenseLayerOptions {
  chunkManager: ChunkManager;
  source: ZarrVectorsMultiscaleGeometrySource;
  displayState: ZarrVectorsDenseDisplayState;
}

/** The {@link DenseDrawState} of a view, from the layer's display state. */
function denseDrawState(
  displayState: ZarrVectorsDenseDisplayState,
  isSliceView: boolean,
) {
  const groupState = displayState.segmentationGroupState.value;
  return {
    visibleAlpha: isSliceView
      ? displayState.selectedAlpha.value
      : displayState.objectAlpha.value,
    notSelectedAlpha: displayState.notSelectedAlpha.value,
    numVisibleSegments: getVisibleSegments(groupState).hashTable.size,
    ignoreNullVisibleSet: displayState.ignoreNullVisibleSet.value,
    objectsDrawnElsewhere: displayState.objectsDrawnElsewhere.value,
  };
}

/** Shared state of the 2-D and 3-D render layers of one subsource. */
export class ZarrVectorsDenseLayer extends RefCounted {
  backend: ChunkRenderLayerFrontend;
  /**
   * Which views this layer draws anything in (`DRAWS_3D` | `DRAWS_2D`),
   * shared with the worker so a layer that shows nothing loads nothing.
   */
  drawMask = new WatchableValue(DRAWS_3D | DRAWS_2D);
  fallbackShaderParameters = new WatchableValue(
    getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN)),
  );
  redrawNeeded;

  constructor(
    public options: ZarrVectorsDenseLayerOptions,
    layerChunkProgressInfo: any,
    redrawNeeded: any,
  ) {
    super();
    this.redrawNeeded = redrawNeeded;
    const { chunkManager, displayState } = options;
    const rpc = chunkManager.rpc!;
    const updateMask = () => {
      this.drawMask.value =
        (denseLayerDraws(denseDrawState(displayState, false)) ? DRAWS_3D : 0) |
        (denseLayerDraws(denseDrawState(displayState, true)) ? DRAWS_2D : 0);
    };
    for (const value of [
      displayState.objectAlpha,
      displayState.selectedAlpha,
      displayState.notSelectedAlpha,
      displayState.ignoreNullVisibleSet,
      displayState.objectsDrawnElsewhere,
    ]) {
      this.registerDisposer(value.changed.add(updateMask));
    }
    this.registerDisposer(
      registerNested((context, groupState) => {
        for (const value of [
          groupState.visibleSegments,
          groupState.temporaryVisibleSegments,
          groupState.useTemporaryVisibleSegments,
        ]) {
          context.registerDisposer(value.changed.add(updateMask));
        }
        updateMask();
      }, displayState.segmentationGroupState),
    );
    const backend = (this.backend = this.registerDisposer(
      new ChunkRenderLayerFrontend(layerChunkProgressInfo),
    ));
    backend.RPC_TYPE_ID = ZARR_VECTORS_DENSE_RENDER_LAYER_RPC_ID;
    backend.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      drawMask: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.drawMask),
      ).rpcId,
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, displayState.localPosition),
      ).rpcId,
      renderScaleTarget2d: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(
          rpc,
          displayState.renderScaleTarget2d,
        ),
      ).rpcId,
      renderScaleTarget3d: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(
          rpc,
          displayState.renderScaleTarget,
        ),
      ).rpcId,
      densities: options.source.densities,
      chains: options.source.chains,
    });
  }
}

function DenseRenderLayer<
  TBase extends AnyConstructor<
    PerspectiveViewRenderLayer | SliceViewPanelRenderLayer
  >,
>(Base: TBase, targetIsSliceView: boolean) {
  class C extends (Base as AnyConstructor<PerspectiveViewRenderLayer>) {
    shared: ZarrVectorsDenseLayer;
    helper: DenseRenderHelper;
    /** The chunks last drawn, for the values a control's range comes from. */
    drawnChunks: ZarrVectorsDenseChunk[] = [];
    declare backend: ChunkRenderLayerFrontend;

    constructor(...args: any[]) {
      super();
      const options = args[0] as ZarrVectorsDenseLayerOptions;
      const { displayState, source, chunkManager } = options;
      this.shared = this.registerDisposer(
        new ZarrVectorsDenseLayer(
          options,
          this.layerChunkProgressInfo,
          this.redrawNeeded,
        ),
      );
      this.backend = this.shared.backend;
      this.helper = this.registerDisposer(
        new DenseRenderHelper(
          chunkManager.chunkQueueManager.gl,
          displayState,
          source.description,
          targetIsSliceView,
          this.shared.fallbackShaderParameters,
        ),
      );
      registerRedrawWhenSegmentationDisplayState3DChanged(
        displayState as unknown as SegmentationDisplayState3D,
        this,
      );
      // The Display tab's resolution slider shows the levels this draws.
      this.registerDisposer(this.histogram.visibility.add(this.visibility));
      const redraw = () => this.redrawNeeded.dispatch();
      const options3d = displayState.skeletonRenderingOptions;
      for (const value of [
        options3d.shader,
        options3d.params2d.mode,
        options3d.params2d.lineWidth,
        options3d.params3d.mode,
        options3d.params3d.lineWidth,
        displayState.selectedAlpha,
        displayState.notSelectedAlpha,
        displayState.ignoreNullVisibleSet,
        displayState.objectsDrawnElsewhere,
        displayState.renderScaleTarget2d,
        displayState.renderScaleTarget,
      ]) {
        this.registerDisposer(value.changed.add(redraw));
      }
      this.registerDisposer(
        options3d.shader.changed.add(() => {
          displayState.shaderError.value = undefined;
        }),
      );
    }

    get options() {
      return this.shared.options;
    }

    private get histogram(): RenderScaleHistogram {
      const { displayState } = this.options;
      return targetIsSliceView
        ? displayState.renderScaleHistogram2d
        : displayState.renderScaleHistogram;
    }

    get gl() {
      return this.options.chunkManager.chunkQueueManager.gl;
    }

    /**
     * Opaque (depth-tested, the nearest curve wins) unless something is
     * drawn partly transparent, as Neuroglancer's skeleton layer decides:
     * the transparent pass blends every overlapping curve's colour, which
     * in a dense bundle reads as a change of hue rather than a fade.
     */
    get isTransparent() {
      if (targetIsSliceView) return true;
      const { objectAlpha, notSelectedAlpha } = this.options.displayState;
      const hidden = notSelectedAlpha.value;
      return objectAlpha.value < 1 || (hidden > 0 && hidden < 1);
    }

    attach(attachment: VisibleLayerInfo<LayerView, DenseAttachmentState>) {
      super.attach(attachment);
      const { displayState, source } = this.options;
      // Only the object values the shader reads are read (as one string,
      // so an edit that reads the same ones keeps the sources).
      const objectValues = attachment.registerDisposer(
        makeCachedDerivedWatchableValue(
          (shader: string) =>
            shaderObjectValues(source.description, shader).join(","),
          [displayState.skeletonRenderingOptions.shader],
        ),
      );
      const sources = attachment.registerDisposer(
        registerNested(
          (
            context: RefCounted,
            transform: RenderLayerTransformOrError,
            displayDimensionRenderInfo: DisplayDimensionRenderInfo,
            used: string,
          ) => {
            const transformed = getVolumetricTransformedSources(
              displayDimensionRenderInfo,
              transform,
              () => source.getSources(used === "" ? [] : used.split(",")),
              attachment.messages,
              this,
            );
            for (const scales of transformed) {
              for (const tsource of scales)
                context.registerDisposer(tsource.source);
            }
            attachment.view.flushBackendProjectionParameters();
            this.backend.rpc!.invoke(
              ZARR_VECTORS_DENSE_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
              {
                layer: this.backend.rpcId,
                view: attachment.view.rpcId,
                displayDimensionRenderInfo,
                isSliceView: targetIsSliceView,
                sources: serializeAllTransformedSources(transformed),
              },
            );
            this.redrawNeeded.dispatch();
            return transformed;
          },
          displayState.transform,
          attachment.view.displayDimensionRenderInfo,
          objectValues,
        ),
      );
      attachment.state = {
        transform: displayState.transform.value,
        displayDimensionRenderInfo:
          attachment.view.displayDimensionRenderInfo.value,
        modelMatrix: undefined,
        sources,
      };
    }

    private modelMatrix(
      attachment: VisibleLayerInfo<LayerView, DenseAttachmentState>,
      displayDimensionRenderInfo: DisplayDimensionRenderInfo,
    ): mat4 | undefined {
      const state = attachment.state!;
      const transform = this.options.displayState.transform.value;
      if (
        state.modelMatrix === undefined ||
        state.transform !== transform ||
        state.displayDimensionRenderInfo !== displayDimensionRenderInfo
      ) {
        state.transform = transform;
        state.displayDimensionRenderInfo = displayDimensionRenderInfo;
        state.modelMatrix = undefined;
        if (transform.error !== undefined) return undefined;
        const m = mat4.create();
        try {
          get3dModelToDisplaySpaceMatrix(
            m,
            displayDimensionRenderInfo,
            transform,
          );
        } catch {
          return undefined;
        }
        state.modelMatrix = m;
      }
      return state.modelMatrix;
    }

    /** The chunks to draw: the target level where loaded, else the coarsest. */
    private chunksToDraw(
      projectionParameters: any,
      transformed: FrontendTransformedSource[],
    ): {
      ready: boolean;
      chunks: ZarrVectorsDenseChunk[];
      /** For the resolution histogram: chunks drawn and missing, by level. */
      levels: { level: number; present: number; missing: number }[];
    } {
      const { displayState, source } = this.options;
      const renderScaleTarget = targetIsSliceView
        ? displayState.renderScaleTarget2d.value
        : displayState.renderScaleTarget.value;
      if (!targetIsSliceView && perChunkLevels(transformed, source.chains)) {
        return this.chunksToDraw3d(
          projectionParameters,
          transformed,
          renderScaleTarget,
        );
      }
      const target = selectDenseLevel(
        projectionParameters,
        transformed,
        source.densities,
        renderScaleTarget,
        targetIsSliceView,
      );
      const localPosition = displayState.localPosition.value;
      const chunks: ZarrVectorsDenseChunk[] = [];
      // The target, and the coarser levels an additive target adds to: what
      // they have loaded is drawn, coarse content as well as fine.
      const drawn = source.chains[target] ?? [target];
      const base = drawn[drawn.length - 1];
      const missing: Float32Array[] = [];
      let ready = true;
      // The view is the target's chain as a whole, so one histogram row.
      const view = { level: target, present: 0, missing: 0 };
      const levels = [view];
      for (const level of drawn) {
        const tsource = transformed[level];
        forEachVisibleVolumetricChunk(
          projectionParameters,
          localPosition,
          tsource,
          () => {
            const key = tsource.curPositionInChunks.join();
            const chunk = (
              tsource.source as unknown as ZarrVectorsGeometryChunkSource
            ).chunks.get(key) as ZarrVectorsDenseChunk | undefined;
            if (
              chunk !== undefined &&
              chunk.state === ChunkState.GPU_MEMORY &&
              chunk.hasGPUData
            ) {
              chunks.push(chunk);
              ++view.present;
            } else {
              ready = false;
              ++view.missing;
              // The last level of the chain is complete on its own; a
              // missing chunk of it leaves a hole the coarsest level fills.
              if (level === base) {
                missing.push(Float32Array.from(tsource.curPositionInChunks));
              }
            }
          },
        );
      }
      if (missing.length > 0 && base !== transformed.length - 1) {
        // Stand in with the coarsest level's chunk covering each missing one.
        const tsource = transformed[base];
        const coarse = transformed[transformed.length - 1];
        const targetSize = tsource.source.spec.chunkDataSize;
        const coarseSource = coarse.source;
        const coarseSize = coarseSource.spec.chunkDataSize;
        const seen = new Set<string>();
        const standIn = {
          level: transformed.length - 1,
          present: 0,
          missing: 0,
        };
        levels.push(standIn);
        for (const position of missing) {
          const coords = Array.from(position, (c, d) =>
            Math.floor(((c + 0.5) * targetSize[d]) / coarseSize[d]),
          );
          const key = coords.join();
          if (seen.has(key)) continue;
          seen.add(key);
          const chunk = coarseSource.chunks.get(key) as
            | ZarrVectorsDenseChunk
            | undefined;
          if (
            chunk !== undefined &&
            chunk.state === ChunkState.GPU_MEMORY &&
            chunk.hasGPUData
          ) {
            chunks.push(chunk);
            ++standIn.present;
          }
        }
      }
      return { ready, chunks, levels };
    }

    /**
     * A 3-d view's chunks, a level per chunk (`selectDense3dChunks`): under
     * each of the coarsest level's chunks, the finer chunks chosen once all
     * are loaded, else that coarse chunk while they load.
     */
    private chunksToDraw3d(
      projectionParameters: any,
      transformed: FrontendTransformedSource[],
      renderScaleTarget: number,
    ) {
      const { displayState, source, chunkManager } = this.options;
      const roots = selectDense3dChunks(
        projectionParameters,
        displayState.localPosition.value,
        transformed,
        source.densities,
        renderScaleTarget,
        dense3dBudget(
          chunkManager.chunkQueueManager.capacities.gpuMemory.sizeLimit.value,
        ),
        drawBytesPerVertex(source.description),
        (level, position) => {
          const tsource = transformed[level];
          setNodePosition(tsource, position);
          return (
            tsource.source as unknown as ZarrVectorsGeometryChunkSource
          ).knownBytes.get(tsource.curPositionInChunks.join());
        },
      );
      const loaded = (level: number, position: Float32Array) => {
        const tsource = transformed[level];
        setNodePosition(tsource, position);
        const chunk = (
          tsource.source as unknown as ZarrVectorsGeometryChunkSource
        ).chunks.get(tsource.curPositionInChunks.join()) as
          | ZarrVectorsDenseChunk
          | undefined;
        return chunk !== undefined &&
          chunk.state === ChunkState.GPU_MEMORY &&
          chunk.hasGPUData
          ? chunk
          : undefined;
      };
      const chunks: ZarrVectorsDenseChunk[] = [];
      const counts = new Map<number, { level: number; present: number; missing: number }>();
      const count = (level: number) => {
        let c = counts.get(level);
        if (c === undefined) counts.set(level, (c = { level, present: 0, missing: 0 }));
        return c;
      };
      let ready = true;
      for (const { root, leaves } of roots) {
        const found = leaves.map((l) => loaded(l.level, l.position));
        leaves.forEach((l, i) => {
          if (found[i] !== undefined) ++count(l.level).present;
          else ++count(l.level).missing;
        });
        if (found.every((c) => c !== undefined)) {
          chunks.push(...(found as ZarrVectorsDenseChunk[]));
          continue;
        }
        ready = false;
        const standIn = loaded(root.level, root.position);
        if (standIn !== undefined) chunks.push(standIn);
        else for (const c of found) if (c !== undefined) chunks.push(c);
      }
      return { ready, chunks, levels: [...counts.values()] };
    }

    draw(
      renderContext: PerspectiveViewRenderContext | SliceViewPanelRenderContext,
      attachment: VisibleLayerInfo<any, any>,
    ) {
      if (
        !renderContext.emitColor &&
        (renderContext as any).alreadyEmittedPickID
      ) {
        return;
      }
      const { displayState } = this.options;
      const visibleAlpha = targetIsSliceView
        ? displayState.selectedAlpha.value
        : displayState.objectAlpha.value;
      if (!denseLayerDraws(denseDrawState(displayState, targetIsSliceView))) {
        return;
      }
      const { projectionParameters } = renderContext;
      const modelMatrix = this.modelMatrix(
        attachment,
        projectionParameters.displayDimensionRenderInfo,
      );
      if (modelMatrix === undefined) return;
      const transformed = attachment.state!.sources.value;
      if (transformed.length === 0 || transformed[0].length === 0) return;
      const { chunks, levels } = this.chunksToDraw(
        projectionParameters,
        transformed[0],
      );
      const { histogram } = this;
      histogram.begin(
        this.options.chunkManager.chunkQueueManager.frameNumberCounter
          .frameNumber,
      );
      const spacing = (level: number) =>
        denseLevelSpacing(
          projectionParameters,
          transformed[0],
          this.options.source.densities,
          level,
          targetIsSliceView,
        );
      for (const { level, present, missing } of levels) {
        const { physicalSpacing, pixelSpacing } = spacing(level);
        histogram.add(physicalSpacing, pixelSpacing, present, missing);
      }
      // Every other level as a marker (display only, as Neuroglancer's
      // skeleton layer marks its grid levels), so each can be found on the
      // slider: setting the target at a level's marker draws that level.
      for (let level = 0; level < transformed[0].length; ++level) {
        if (levels.some((l) => l.level === level)) continue;
        const { physicalSpacing, pixelSpacing } = spacing(level);
        histogram.add(physicalSpacing, pixelSpacing, 0, 1, true);
      }
      void (attachment as VisibleLayerInfo<LayerView, DenseAttachmentState>);
      this.drawnChunks = chunks;
      if (chunks.length === 0) return;
      if (targetIsSliceView && (this.shared.drawMask.value & DRAWS_2D) === 0)
        return;

      const { helper, gl } = this;
      const renderOptions = targetIsSliceView
        ? displayState.skeletonRenderingOptions.params2d
        : displayState.skeletonRenderingOptions.params3d;
      const lineWidth = renderOptions.lineWidth.value;
      // Points follow the width slider, 5 px at each view's default width
      // (2 in cross-sections, 1 in 3-d), so they can be made smaller too.
      const pointDiameter =
        helper.primitive === "points"
          ? (5 * lineWidth) / (targetIsSliceView ? 2 : 1)
          : renderOptions.mode.value === SkeletonRenderMode.LINES_AND_POINTS
            ? Math.max(5, lineWidth * 2)
            : lineWidth;
      const mvp = mat4.multiply(
        tempMat4,
        projectionParameters.viewProjectionMat,
        modelMatrix,
      );
      const { shaderControlState } = displayState.skeletonRenderingOptions;
      const passes: {
        shader: ShaderProgram;
        edges: boolean;
        sections?: boolean;
        faces?: boolean;
      }[] = [];
      if (helper.triangles && !targetIsSliceView) {
        // A mesh's faces, filled and lit as Neuroglancer lights its meshes.
        const { shader, parameters } = helper.faceShaderGetter(
          renderContext.emitter,
        );
        if (shader === null) return;
        shader.bind();
        setShaderControls(
          gl,
          shader,
          shaderControlState,
          parameters.parseResult,
        );
        const { lightDirection, ambientLighting, directionalLighting } =
          renderContext as PerspectiveViewRenderContext;
        vec3.scale(tempLight as unknown as vec3, lightDirection, directionalLighting);
        tempLight[3] = ambientLighting;
        gl.uniform4fv(shader.uniform("uLightDirection"), tempLight);
        mat3FromMat4(tempMat3, modelMatrix);
        scaleMat3Output(
          tempMat3,
          tempMat3,
          projectionParameters.displayDimensionRenderInfo.canonicalVoxelFactors,
        );
        mat3.invert(tempMat3, tempMat3);
        mat3.transpose(tempMat3, tempMat3);
        gl.uniformMatrix3fv(shader.uniform("uNormalMatrix"), false, tempMat3);
        passes.push({ shader, edges: false, faces: true });
      }
      if (helper.triangles && targetIsSliceView) {
        const { shader, parameters } = helper.sectionShaderGetter(
          renderContext.emitter,
        );
        if (shader === null) return;
        shader.bind();
        setShaderControls(
          gl,
          shader,
          shaderControlState,
          parameters.parseResult,
        );
        gl.uniform1f(shader.uniform("uLineWidth"), lineWidth);
        initializeLineShader(shader, projectionParameters, 1.0);
        passes.push({ shader, edges: true, sections: true });
      } else if (helper.primitive === "lines") {
        const { shader, parameters } = helper.edgeShaderGetter(
          renderContext.emitter,
        );
        if (shader === null) return;
        shader.bind();
        setShaderControls(
          gl,
          shader,
          shaderControlState,
          parameters.parseResult,
        );
        gl.uniform1f(shader.uniform("uLineWidth"), lineWidth);
        initializeLineShader(
          shader,
          projectionParameters,
          targetIsSliceView ? 1.0 : 0.0,
        );
        passes.push({ shader, edges: true });
      }
      // Lines alone draw their vertices' discs only where nothing blends.
      const vertexDiscs =
        helper.primitive !== "lines" ||
        linesDrawVertexDiscs({
          linesAndPoints:
            renderOptions.mode.value === SkeletonRenderMode.LINES_AND_POINTS,
          targetIsSliceView,
          transparent: this.isTransparent,
        });
      if (!(helper.triangles && targetIsSliceView) && vertexDiscs) {
        const { shader, parameters } = helper.nodeShaderGetter(
          renderContext.emitter,
        );
        if (shader === null) return;
        shader.bind();
        setShaderControls(
          gl,
          shader,
          shaderControlState,
          parameters.parseResult,
        );
        gl.uniform1f(shader.uniform("uNodeDiameter"), pointDiameter);
        initializeCircleShader(shader, projectionParameters, {
          featherWidthInPixels: targetIsSliceView ? 1.0 : 0.0,
        });
        passes.push({ shader, edges: false });
      }
      const position = positionAttribute(
        displayState.skeletonRenderingOptions.shader.value,
        helper.attributes,
      );
      for (const { shader, edges, sections, faces } of passes) {
        shader.bind();
        helper.beginLayer(shader, mvp, visibleAlpha);
        for (const chunk of chunks) {
          const pickID = renderContext.emitPickID
            ? renderContext.pickIDs.register(this, chunk.numVertices, 0n, chunk)
            : 0;
          gl.uniform1ui(shader.uniform("uPickID"), pickID);
          helper.bindChunk(shader, chunk, position);
          if (faces) {
            if (chunk.faceBuffer === undefined) continue;
            const aTriangle = shader.attribute("aTriangle");
            chunk.faceBuffer.bindToVertexAttribI(
              aTriangle,
              3,
              WebGL2RenderingContext.UNSIGNED_INT,
            );
            gl.vertexAttribDivisor(aTriangle, 1);
            gl.drawArraysInstanced(
              WebGL2RenderingContext.TRIANGLES,
              0,
              3,
              chunk.numFaces,
            );
            gl.vertexAttribDivisor(aTriangle, 0);
            gl.disableVertexAttribArray(aTriangle);
          } else if (sections) {
            if (chunk.faceBuffer === undefined) continue;
            const aTriangle = shader.attribute("aTriangle");
            chunk.faceBuffer.bindToVertexAttribI(
              aTriangle,
              3,
              WebGL2RenderingContext.UNSIGNED_INT,
            );
            gl.vertexAttribDivisor(aTriangle, 1);
            drawLines(gl, 1, chunk.numFaces);
            gl.vertexAttribDivisor(aTriangle, 0);
            gl.disableVertexAttribArray(aTriangle);
          } else if (edges) {
            const aVertexIndex = shader.attribute("aVertexIndex");
            if (chunk.sequential && chunk.numOwnVertices > 1) {
              // Runs of rows: no index buffer (the attribute is a constant
              // the shader does not read, of the type it declares).
              gl.uniform1ui(shader.uniform("uSequentialDraw"), 1);
              gl.disableVertexAttribArray(aVertexIndex);
              gl.vertexAttribI4ui(aVertexIndex, 0, 0, 0, 0);
              drawLines(gl, 1, chunk.numOwnVertices - 1);
            }
            if (chunk.edgeBuffer === undefined) continue;
            gl.uniform1ui(shader.uniform("uSequentialDraw"), 0);
            chunk.edgeBuffer.bindToVertexAttribI(
              aVertexIndex,
              2,
              WebGL2RenderingContext.UNSIGNED_INT,
            );
            gl.vertexAttribDivisor(aVertexIndex, 1);
            drawLines(gl, 1, chunk.numEdges);
            gl.vertexAttribDivisor(aVertexIndex, 0);
            gl.disableVertexAttribArray(aVertexIndex);
          } else {
            // A mesh's chunk with faces has them drawn instead.
            if (helper.triangles && chunk.faceBuffer !== undefined) continue;
            drawCircles(gl, 1, chunk.numOwnVertices);
          }
        }
        helper.endLayer(shader);
      }
    }

    isReady(
      renderContext: { projectionParameters: any },
      attachment: VisibleLayerInfo<any, any>,
    ) {
      const transformed = attachment.state?.sources.value;
      if (transformed === undefined || transformed.length === 0) return true;
      return this.chunksToDraw(
        renderContext.projectionParameters,
        transformed[0],
      ).ready;
    }

    updateMouseState(
      mouseState: MouseSelectionState,
      _pickedValue: bigint,
      pickedOffset: number,
      data: any,
    ) {
      const chunk = data as ZarrVectorsDenseChunk;
      const id = chunk.segmentIdOf(pickedOffset);
      if (id === undefined) return;
      mouseState.pickedValue = id;
      // The vertex itself, for its values (`pickedVertexValues`).
      (mouseState as any)[PICKED_VERTEX] = {
        renderLayer: this,
        chunk,
        vertex: pickedOffset,
      };
    }
  }
  return C as unknown as AnyConstructor<RenderLayer> & {
    new (options: ZarrVectorsDenseLayerOptions): InstanceType<TBase> & {
      shared: ZarrVectorsDenseLayer;
    };
  };
}

export const PerspectiveViewZarrVectorsDenseLayer = DenseRenderLayer(
  PerspectiveViewRenderLayer,
  false,
);
export const SliceViewPanelZarrVectorsDenseLayer = DenseRenderLayer(
  SliceViewPanelRenderLayer,
  true,
);
