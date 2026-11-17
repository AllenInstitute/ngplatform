/**
 * Plugins drawing in Neuroglancer's 3-D view: a render layer added to a
 * user layer, so it draws while that layer is visible, in the 3-D panel's
 * opaque pass, depth-tested with everything else there.  The plugin gets
 * the WebGL2 context and the frame's matrices, and writes the panel's three
 * outputs itself (colour, depth, pick id).
 *
 * A drawer may pick segments (Frame3d.registerPicks): each segmentation
 * layer it picks in gets a render layer that draws nothing, against which
 * the segments' pick IDs are registered, so Neuroglancer takes a picked ID
 * as that layer's segment.
 */
import type { Drawer3d, Frame3d } from "../sdk/types.js";
import {
  type ManagedUserLayer,
  OffscreenTextures,
  PerspectiveViewRenderLayer,
  type PerspectiveViewRenderContext,
  setPerspectiveSectionClip,
  type UserLayer,
  type Viewer,
} from "./neuroglancer.js";

/** The frame as a plugin sees it, without the context. */
function frameOf(renderContext: PerspectiveViewRenderContext): Omit<Frame3d, "gl"> {
  const p = renderContext.projectionParameters;
  const info = p.displayDimensionRenderInfo;
  const names: string[] = [];
  const scales: number[] = [];
  const units: string[] = [];
  for (let i = 0; i < 3; ++i) {
    const dim = info.displayDimensionIndices[i];
    names.push(dim === -1 ? "" : info.globalDimensionNames[dim]);
    scales.push(info.displayDimensionScales[i]);
    units.push(info.displayDimensionUnits[i]);
  }
  const position = [0, 1, 2].map((i) => {
    const dim = info.displayDimensionIndices[i];
    return dim === -1 ? 0 : (p.globalPosition[dim] ?? 0);
  }) as [number, number, number];
  return {
    viewProjection: p.viewProjectionMat as Float32Array,
    invViewProjection: p.invViewProjectionMat as Float32Array,
    dimensions: { names, scales, units },
    position,
    width: p.width,
    height: p.height,
    outputs: { color: OffscreenTextures.COLOR, z: OffscreenTextures.Z, pick: OffscreenTextures.PICK },
    moving: renderContext.isContinuousCameraMotionInProgress,
    // Set by a Neuroglancer that draws `drawsAfterSections` layers after its sections.
    sectionsDrawn: (renderContext as { sectionsDrawn?: boolean }).sectionsDrawn === true,
  };
}

/** Render layers that drew, by the frame and projection they drew in: whose section clip applies. */
const drewIn = new Map<PluginRenderLayer, { frame: number; projection: unknown }>();

setPerspectiveSectionClip((renderContext) => {
  for (const [layer, drew] of drewIn) {
    if (drew.frame !== renderContext.frameNumber || drew.projection !== renderContext.projectionParameters) continue;
    const box = layer.sectionClip(renderContext);
    if (box !== undefined) return box;
  }
  return undefined;
});

/** A render layer that draws nothing: the segments a drawer picks are its layer's through it. */
class PickRenderLayer extends PerspectiveViewRenderLayer {
  isReady(): boolean {
    return true;
  }

  draw(): void {}
}

class PluginRenderLayer extends PerspectiveViewRenderLayer {
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly drawer: Drawer3d,
    private readonly picker?: (renderContext: PerspectiveViewRenderContext, layer: string, segments: readonly bigint[]) => number,
  ) {
    super();
    // Read by a Neuroglancer that can draw a layer after its sections; others ignore it.
    (this as { drawsAfterSections?: boolean }).drawsAfterSections = drawer.afterSections === true;
  }

  isReady(): boolean {
    return this.drawer.isReady?.() ?? true;
  }

  draw(renderContext: PerspectiveViewRenderContext): void {
    // Only the colour pass: the drawer writes all three outputs at once.
    if (!renderContext.emitColor) return;
    const { gl } = this;
    const picker = this.picker;
    const frame: Frame3d = { gl, ...frameOf(renderContext), ...(picker ? { registerPicks: (layer: string, segments: readonly bigint[]) => picker(renderContext, layer, segments) } : {}) };
    drewIn.set(this, { frame: renderContext.frameNumber, projection: renderContext.projectionParameters });
    try {
      this.drawer.draw(frame);
    } finally {
      gl.bindVertexArray(null);
      gl.useProgram(null);
    }
  }

  sectionClip(renderContext: PerspectiveViewRenderContext) {
    return this.drawer.sectionClip?.(frameOf(renderContext));
  }

  disposed(): void {
    drewIn.delete(this);
    this.drawer.dispose?.();
    super.disposed();
  }
}

/**
 * Keeps a drawer's render layer on the layer named `name`, following the
 * layer when Neuroglancer replaces its user layer, until disposed.
 */
export function draw3d(viewer: Viewer, name: string, drawer: Drawer3d): { redraw(): void; dispose(): void } {
  let managed: ManagedUserLayer | undefined;
  let attached: { user: UserLayer; layer: PluginRenderLayer } | undefined;
  let offManaged: (() => void) | undefined;
  // The pick layers added for this drawer, by the user layer they are in.
  const pickers = new Map<UserLayer, PickRenderLayer>();
  const picker = (renderContext: PerspectiveViewRenderContext, name: string, segments: readonly bigint[]): number => {
    const ids = (renderContext as { pickIDs?: { registerUint64(l: unknown, x: bigint, count?: number): number } }).pickIDs;
    const user = viewer.layerManager.getLayerByName(name)?.layer ?? undefined;
    if (ids === undefined || user == null || segments.length === 0) return 0;
    const pl = pickers.get(user);
    if (pl === undefined || !user.renderLayers.includes(pl)) {
      // Added between frames (not while this one is drawn): picked from the next.
      if (pl === undefined) {
        const made = new PickRenderLayer();
        pickers.set(user, made);
        queueMicrotask(() => {
          if (pickers.get(user) === made && !user.wasDisposed) user.addRenderLayer(made);
        });
      }
      return 0;
    }
    // Consecutive: one ID a segment.
    const first = ids.registerUint64(pl, segments[0]);
    for (let i = 1; i < segments.length; ++i) ids.registerUint64(pl, segments[i]);
    return first;
  };
  // The drawer outlives each render layer: only the last one disposes it.
  const keep: Drawer3d = {
    draw: (f) => drawer.draw(f),
    isReady: () => drawer.isReady?.() ?? true,
    sectionClip: (f) => drawer.sectionClip?.(f),
    afterSections: drawer.afterSections,
  };
  const detach = () => {
    if (attached === undefined) return;
    const { user, layer } = attached;
    attached = undefined;
    if (user.renderLayers.includes(layer)) user.removeRenderLayer(layer);
  };
  const sync = () => {
    const next = viewer.layerManager.getLayerByName(name);
    if (next !== managed) {
      offManaged?.();
      managed = next;
      offManaged = managed?.layerChanged.add(sync);
    }
    const user = managed?.layer ?? undefined;
    if (attached?.user === user) return;
    detach();
    if (user == null) return;
    const layer = new PluginRenderLayer(viewer.display.gl as unknown as WebGL2RenderingContext, keep, picker);
    // Before adding it: adding it changes the layer, which calls sync again.
    attached = { user, layer };
    user.addRenderLayer(layer);
  };
  const offLayers = viewer.layerManager.layersChanged.add(sync);
  sync();
  return {
    redraw: () => attached?.layer.redrawNeeded.dispatch(),
    dispose: () => {
      offLayers();
      offManaged?.();
      detach();
      for (const [user, pl] of pickers) if (!user.wasDisposed && user.renderLayers.includes(pl)) user.removeRenderLayer(pl);
      pickers.clear();
      drawer.dispose?.();
    },
  };
}
