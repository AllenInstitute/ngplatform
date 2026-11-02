/**
 * Capturing the views frame by frame, for pictures and movies: the canvas
 * enlarged by a scale factor (Neuroglancer's screenshot machinery, which
 * keeps the field of view), each frame drawn once the data in view has
 * loaded (or a timeout passes), cropped to the views or one of them, with
 * the platform's overlays (labels) painted in.  Between frames the view
 * moves: a dimension's position (slices, time) or the 3-D view's
 * orientation (a turntable).  At the end the view is put back as it was.
 */
import type { CaptureFrame, Quaternion } from "../core/capture.js";
import { calculatePanelViewportBounds, type Viewer } from "./neuroglancer.js";

export interface CapturePanel {
  /** Index into Neuroglancer's panels, ordered top left first. */
  index: number;
  kind: "2d" | "3d";
  label: string;
}

export interface CaptureOptions {
  /** Pixels per screen pixel (1 to 4, say); large canvases are capped by Neuroglancer. */
  scale: number;
  /** One view, or all of them (undefined). */
  panel?: number;
  /** Longest wait for a frame's data, ms. */
  timeout: number;
}

export interface CapturedFrame {
  canvas: HTMLCanvasElement;
  /** False when the timeout passed before all the data in view had loaded. */
  complete: boolean;
}

export interface CaptureHost {
  viewer: Viewer;
  /** Holds the workspace's change listeners until the returned function is called (no undo steps for each frame). */
  holdStateChanges(): () => void;
  /** Paints the platform's overlays over a capture (in the canvas's pixels). */
  paintOverlays(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void;
}

interface PanelLike {
  element: HTMLElement;
  sliceView?: unknown;
  renderViewport: { width: number; height: number };
  canvasRelativeClippedLeft: number;
  canvasRelativeClippedTop: number;
  visible: boolean;
}

/** The data panels shown, top left first. */
function dataPanels(viewer: Viewer): PanelLike[] {
  const panels = [...viewer.display.panels].filter((p) => {
    const any = p as unknown as PanelLike;
    return any.renderViewport !== undefined && any.element?.isConnected && any.visible !== false && "canvasRelativeClippedLeft" in any;
  }) as unknown as PanelLike[];
  const at = (p: PanelLike) => p.element.getBoundingClientRect();
  return panels.sort((a, b) => at(a).top - at(b).top || at(a).left - at(b).left);
}

export function capturePanels(viewer: Viewer): CapturePanel[] {
  let slices = 0;
  return dataPanels(viewer).map((p, index) => {
    const kind = p.sliceView !== undefined ? "2d" : "3d";
    return { index, kind, label: kind === "3d" ? "3-D view" : `Cross-section ${++slices}` };
  });
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export class CaptureSession {
  private readonly release: () => void;
  private readonly saved: { position: Float32Array; orientation: number[]; crossSectionScale: number; projectionScale: number };
  private ended = false;

  constructor(
    private readonly host: CaptureHost,
    private readonly options: CaptureOptions,
  ) {
    const { viewer } = host;
    this.release = host.holdStateChanges();
    this.saved = {
      position: Float32Array.from(viewer.position.value),
      orientation: Array.from(viewer.perspectiveNavigationState.pose.orientation.orientation),
      crossSectionScale: viewer.crossSectionScale.value,
      projectionScale: viewer.projectionScale.value,
    };
    const manager = viewer.screenshotManager;
    // Preview mode keeps the canvas at the size it is given.
    manager.previewScreenshot();
    if (options.scale !== 1) manager.screenshotScale = options.scale;
  }

  /** The scale Neuroglancer allowed (it caps the canvas's area). */
  get scale(): number {
    return this.host.viewer.screenshotManager.screenshotScale;
  }

  /** Moves the view to a frame. */
  apply(frame: CaptureFrame): void {
    const { viewer } = this.host;
    if (frame.kind === "position") {
      const position = Float32Array.from(viewer.position.value);
      position[frame.dimension] = frame.value;
      viewer.position.value = position;
    } else if (frame.kind === "orientation") {
      viewer.perspectiveNavigationState.pose.orientation.restoreState(Array.from(frame.orientation));
    }
  }

  /** The 3-D view's orientation now. */
  orientation(): Quaternion {
    return Array.from(this.host.viewer.perspectiveNavigationState.pose.orientation.orientation) as Quaternion;
  }

  /**
   * Waits until the views have drawn everything in view (twice running, so
   * a chunk arriving between checks is drawn), or the timeout, then grabs
   * the canvas.
   */
  async grab(signal?: { cancelled: boolean }): Promise<CapturedFrame> {
    const { viewer } = this.host;
    const started = performance.now();
    let readyRuns = 0;
    let complete = false;
    // At least two frames, so a change just made is drawn.
    for (let i = 0; ; ++i) {
      viewer.display.scheduleRedraw();
      await nextFrame();
      if (signal?.cancelled) break;
      readyRuns = viewer.isReady() ? readyRuns + 1 : 0;
      if (i >= 1 && readyRuns >= 2) {
        complete = true;
        break;
      }
      if (performance.now() - started > this.options.timeout) break;
    }
    // Draw now and copy at once, while the drawing buffer holds this frame.
    viewer.display.draw();
    const bounds = calculatePanelViewportBounds(viewer.display.panels);
    let box = bounds.totalRenderPanelViewport;
    if (this.options.panel !== undefined) {
      const panel = dataPanels(viewer)[this.options.panel];
      if (panel !== undefined) {
        box = {
          left: panel.canvasRelativeClippedLeft,
          top: panel.canvasRelativeClippedTop,
          right: panel.canvasRelativeClippedLeft + panel.renderViewport.width,
          bottom: panel.canvasRelativeClippedTop + panel.renderViewport.height,
          panelType: "",
        } as typeof box;
      }
    }
    const left = Math.max(0, Math.round(box.left));
    const top = Math.max(0, Math.round(box.top));
    const width = Math.max(1, Math.round(box.right - box.left));
    const height = Math.max(1, Math.round(box.bottom - box.top));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.drawImage(viewer.display.canvas, left, top, width, height, 0, 0, width, height);
    context.save();
    context.translate(-left, -top);
    try {
      this.host.paintOverlays(context, viewer.display.canvas);
    } finally {
      context.restore();
    }
    return { canvas, complete };
  }

  /** Puts the view back, the canvas at its size, and lets the workspace see changes again. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    const { viewer } = this.host;
    const manager = viewer.screenshotManager;
    try {
      if (manager.screenshotScale !== 1) manager.screenshotScale = 1;
      manager.cancelScreenshot();
      viewer.position.value = this.saved.position;
      viewer.perspectiveNavigationState.pose.orientation.restoreState(this.saved.orientation);
      viewer.crossSectionScale.value = this.saved.crossSectionScale;
      viewer.projectionScale.value = this.saved.projectionScale;
    } finally {
      this.release();
    }
  }
}

/** The global dimensions, for sweeps: names, units, bounds (voxel edges) and where the view is. */
export function captureDimensions(viewer: Viewer): { name: string; unit: string; scale: number; lower: number; upper: number; position: number; displayed: boolean }[] {
  const space = viewer.coordinateSpace.value;
  const displayed = new Set(Array.from(viewer.navigationState.displayDimensionRenderInfo.value.displayDimensionIndices).filter((i) => i >= 0));
  return space.names.map((name, i) => ({
    name,
    unit: space.units[i],
    scale: space.scales[i],
    lower: space.bounds.lowerBounds[i],
    upper: space.bounds.upperBounds[i],
    position: viewer.position.value[i],
    displayed: displayed.has(i),
  }));
}
