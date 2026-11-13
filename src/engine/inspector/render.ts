/**
 * The Display tab: how a layer is drawn, for each layer type the same
 * controls as Neuroglancer's own tab (its `LAYER_CONTROLS` and shader), in
 * the platform's rows. Resolution controls keep Neuroglancer's histogram of
 * the resolutions being drawn; they are components, not panels.
 */
import {
  AnnotationUserLayer,
  ChannelDimensionsWidget,
  ImageUserLayer,
  RenderScaleWidget,
  SegmentationUserLayer,
  SingleMeshUserLayer,
  type UserLayer,
  VolumeRenderingModes,
  VolumeRenderingRenderScaleWidget,
} from "../neuroglancer.js";
import { colormapControl } from "./colormap.js";
import { lookupTableControl } from "./lookup.js";
import { hasOutlines, setOutlines } from "../outlines.js";
import { shaderSection } from "./shader.js";
import { colourBySection } from "./colour_by.js";
import { surfaceSection } from "./surface.js";
import {
  button,
  checkRow,
  colour,
  el,
  embed,
  enumSelect,
  note,
  row,
  type Scope,
  section,
  showWhen,
  slider,
  type Watch,
} from "./ui.js";

const DOCS = "https://github.com/google/neuroglancer/blob/master/src";

/** A watchable computed from others. */
export function derived<T>(sources: Watch<unknown>[], f: () => T): Watch<T> {
  return {
    get value() {
      return f();
    },
    set value(_v: T) {
      throw new Error("derived values are read-only");
    },
    changed: {
      add(listener: () => void) {
        const offs = sources.map((s) => s.changed.add(listener));
        return () => offs.forEach((off) => off());
      },
    },
  };
}

/** A signal, as a watchable with no value. */
export function signal(s: { add(listener: () => void): () => void }): Watch<undefined> {
  return { value: undefined, changed: s };
}

function renderScale(scope: Scope, histogram: unknown, target: unknown, Widget: typeof RenderScaleWidget = RenderScaleWidget): HTMLElement {
  const widget = scope.ng.registerDisposer(new Widget(histogram as never, target as never));
  return embed(widget.element, "ins-render-scale");
}

export function renderTab(scope: Scope, layer: UserLayer): HTMLElement[] {
  if (layer instanceof ImageUserLayer) return imageRender(scope, layer);
  if (layer instanceof SegmentationUserLayer) return segmentationRender(scope, layer);
  if (layer instanceof AnnotationUserLayer) return annotationRender(scope, layer);
  if (layer instanceof SingleMeshUserLayer) return meshRender(scope, layer);
  return [note("This layer type has no rendering settings.")];
}

// ------------------------------------------------------------------ image

function imageRender(scope: Scope, l: ImageUserLayer): HTMLElement[] {
  const mode = l.volumeRenderingMode as unknown as Watch<number> & { enumType: Record<string, number> };
  const on = derived([mode], () => mode.value === VolumeRenderingModes.ON);
  const any = derived([mode], () => mode.value !== VolumeRenderingModes.OFF);
  const channels = scope.ng.registerDisposer(new ChannelDimensionsWidget(l.channelCoordinateSpaceCombiner));
  return [
    section(
      "Display",
      row("Resolution (slice)", renderScale(scope, l.sliceViewRenderScaleHistogram, l.sliceViewRenderScaleTarget), "Target resolution of the 2-D views, in screen pixels per voxel"),
      row("Blending (slice)", enumSelect(scope, l.blendMode as never)),
      row("Opacity (slice)", slider(scope, l.opacity)),
      row("Volume rendering", enumSelect(scope, mode), "Experimental: draw the volume in the 3-D view"),
      showWhen(scope, row("Gain (3D)", slider(scope, l.volumeRenderingGain, { min: -10, max: 10, step: 0.1 })), on),
      showWhen(
        scope,
        row("Resolution (3D)", renderScale(scope, l.volumeRenderingChunkResolutionHistogram, l.volumeRenderingDepthSamplesTarget, VolumeRenderingRenderScaleWidget as never)),
        any,
      ),
    ),
    showWhen(
      scope,
      section("Channels", embed(channels.element, "ins-channels")),
      derived([l.channelCoordinateSpaceCombiner.combined as Watch<{ rank: number }>], () => (l.channelCoordinateSpaceCombiner.combined.value.rank ?? 0) > 0),
    ),
    shaderSection(scope, l, {
      fragmentMain: l.fragmentMain,
      shaderError: l.shaderError,
      shaderControlState: l.shaderControlState,
      codeVisible: l.codeVisible,
      hideInactive: l.hideInactiveShaderControls,
      legendShaderOptions: l.getLegendShaderOptions(),
      help: `${DOCS}/sliceview/image_layer_rendering.md`,
      rows: [row("Colour map", colormapControl(scope, l), "Writes the shader for a colour map with a contrast control; Custom keeps your own shader")],
    }),
  ];
}

// ----------------------------------------------------------- segmentation

/** Link this layer's segments (or colours) to another layer's, or unlink. */
function linkedGroup(scope: Scope, group: any): HTMLElement {
  const host = el("div", { class: "ins-linked" });
  const watches = [signal(group.changed), signal(group.linkedLayersChanged), signal(group.layerManager.layersChanged)];
  scope.watchSoon(watches, () => {
    if (group.linkedLayers.size > 0) {
      host.replaceChildren(
        ...[...group.linkedLayers].map((other: any) =>
          el("span", { class: "ins-chip" }, other.managedLayer.name, button("×", () => group.getGroup(other).isolate(), "Unlink this layer", "icon ins-remove")),
        ),
        button("Unlink all", () => group.isolate()),
      );
      return;
    }
    const names: string[] = [];
    for (const managed of group.layerManager.managedLayers) {
      const user = managed.layer;
      if (user == null || user === group.layer || !group.predicate(user)) continue;
      names.push(managed.name);
    }
    const sel = el("select", { class: "text-input" }, el("option", { value: "" }, "Not linked"), ...names.map((n) => el("option", { value: n }, n))) as HTMLSelectElement;
    sel.value = group.toJSON() ?? "";
    sel.disabled = names.length === 0;
    sel.addEventListener("change", () => {
      if (sel.value === "") group.isolate();
      else group.linkByName(sel.value);
    });
    host.replaceChildren(sel);
  });
  return host;
}

/** Filled or outlined in the 2-D views (see ../outlines.ts). */
function outlineToggle(scope: Scope, l: SegmentationUserLayer): HTMLElement {
  const name = () => l.managedLayer.name;
  const note = el("span", { class: "ins-faint" });
  const set = (on: boolean) => {
    try {
      setOutlines(name(), on);
      note.textContent = "";
    } catch (e) {
      note.textContent = (e as Error).message;
    }
  };
  const group = el(
    "div",
    { class: "segmented" },
    button("Filled", () => set(false), "Fill each segment with its colour"),
    button("Outlines", () => set(true), "Draw each segment's outline in its colour; the outline layer's shader sets the width, and can fill faintly too"),
  );
  const lm = (l.manager as any).layerManager;
  scope.watchSoon([signal(lm.layersChanged), signal(lm.specificationChanged)], () => {
    const on = hasOutlines(name());
    group.children[0].setAttribute("aria-pressed", String(!on));
    group.children[1].setAttribute("aria-pressed", String(on));
  });
  return el("div", { class: "ins-inline" }, group, note);
}

function segmentationRender(scope: Scope, l: SegmentationUserLayer): HTMLElement[] {
  const ds = l.displayState as any;
  const fixed = ds.segmentDefaultColor as Watch<Float32Array | undefined>;
  const byFixed = derived([fixed], () => fixed.value !== undefined);
  const byHash = derived([fixed], () => fixed.value === undefined);
  const seed = ds.segmentColorHash as Watch<number>;
  const seedBox = el("input", { type: "number", class: "text-input num-input wide", step: 1, min: 0 }) as HTMLInputElement;
  seedBox.addEventListener("change", () => {
    const v = Number(seedBox.value);
    if (Number.isInteger(v) && v >= 0) seed.value = v >>> 0;
  });
  scope.watch(seed, () => (seedBox.value = String(seed.value)));
  const mode = el(
    "div",
    { class: "segmented" },
    button("By id", () => (fixed.value = undefined), "Colour each segment from a hash of its id"),
    button("Fixed", () => (fixed.value = Float32Array.of(1, 0, 0)), "One colour for every segment without its own"),
  );
  scope.watch(fixed, () => {
    mode.children[0].setAttribute("aria-pressed", String(fixed.value === undefined));
    mode.children[1].setAttribute("aria-pressed", String(fixed.value !== undefined));
  });
  const has2d = l.has2dLayer as Watch<boolean>;
  const has3d = l.has3dLayer as Watch<boolean>;
  const hasSkeletons = l.hasSkeletonsLayer as Watch<boolean>;
  const skeleton = ds.skeletonRenderingOptions;
  const skeletonShader = el("div", { class: "ins-deferred" });
  let shaderScope: Scope | undefined;
  scope.watch(hasSkeletons, () => {
    shaderScope?.dispose();
    shaderScope = undefined;
    skeletonShader.replaceChildren();
    if (!hasSkeletons.value) return;
    shaderScope = scope.child();
    skeletonShader.append(
      shaderSection(shaderScope, l, {
        fragmentMain: skeleton.shader,
        shaderError: ds.shaderError,
        shaderControlState: skeleton.shaderControlState,
        codeVisible: l.codeVisible,
        hideInactive: skeleton.hideInactiveShaderControls,
        help: `${DOCS}/sliceview/image_layer_rendering.md`,
        properties: () =>
          (l.getSkeletonLayer()?.vertexAttributes ?? []).slice(1).map((a: { name: string; glslDataType: string }) => ({ name: a.name, type: a.glslDataType })),
      }),
    );
  });
  return [
    section(
      "Links",
      row("Segments linked to", linkedGroup(scope, ds.linkedSegmentationGroup), "Share visible segments with another segmentation layer"),
      row("Colours linked to", linkedGroup(scope, ds.linkedSegmentationColorGroup), "Share segment colours with another segmentation layer"),
    ),
    section(
      "Colour",
      row("Lookup table", lookupTableControl(scope, l), "Colours and names for the label values, from an atlas's lookup table"),
      row("Colour by", mode),
      showWhen(scope, row("Seed", el("div", { class: "ins-inline" }, seedBox, button("Randomise", () => ds.segmentationColorGroupState.value.segmentColorHash.randomize()))), byHash),
      showWhen(scope, row("Colour", colour(scope, fixed)), byFixed),
      row("Saturation", slider(scope, ds.saturation), "Saturation of segment colours"),
    ),
    showWhen(
      scope,
      section(
        "2-D views",
        row("Draw", outlineToggle(scope, l), "Filled, or as outlines in each segment's colour (an image layer above this one draws them)"),
        row("Opacity (on)", slider(scope, ds.selectedAlpha), "Opacity of selected segments in the 2-D views"),
        row("Opacity (off)", slider(scope, ds.notSelectedAlpha), "Opacity of segments that are not selected"),
        row("Resolution (slice)", renderScale(scope, l.sliceViewRenderScaleHistogram, l.sliceViewRenderScaleTarget)),
      ),
      has2d,
    ),
    showWhen(
      scope,
      section(
        "3-D view",
        row("Opacity (3D)", slider(scope, ds.objectAlpha), "Opacity of meshes and skeletons"),
        row("Silhouette (3D)", slider(scope, ds.silhouetteRendering, { min: 0, max: 10, step: 0.1 }), "Above 0, faces seen edge-on become more transparent"),
        row("Resolution (mesh)", renderScale(scope, ds.renderScaleHistogram, ds.renderScaleTarget)),
      ),
      has3d,
    ),
    surfaceSection(scope, l),
    colourBySection(scope, l),
    section(
      "Segments",
      checkRow(scope, "Hide segment id 0", ds.hideSegmentZero, "Neither show nor select segment id 0"),
      checkRow(scope, "Colour base segments individually", ds.baseSegmentColoring),
      checkRow(scope, "Show all when none are selected", ds.ignoreNullVisibleSet),
      checkRow(scope, "Highlight on hover", ds.hoverHighlight),
    ),
    showWhen(
      scope,
      section(
        "Skeletons",
        row("Mode (2D)", enumSelect(scope, skeleton.params2d.mode)),
        row("Line width (2D)", slider(scope, skeleton.params2d.lineWidth, { min: 1, max: 40, step: 1 })),
        row("Mode (3D)", enumSelect(scope, skeleton.params3d.mode)),
        row("Line width (3D)", slider(scope, skeleton.params3d.lineWidth, { min: 1, max: 40, step: 1 })),
      ),
      hasSkeletons,
    ),
    skeletonShader,
  ];
}

// ------------------------------------------------------------- annotation

function annotationRender(scope: Scope, l: AnnotationUserLayer): HTMLElement[] {
  const ads = l.annotationDisplayState as any;
  const processed = ads.shaderControls.processedFragmentMain as Watch<string>;
  const usesDefault = derived([processed], () => /\bdefaultColor\b/.test(processed.value));
  return [
    section(
      "Display",
      showWhen(scope, row("Annotation colour", colour(scope, ads.color), "The colour defaultColor() gives in the shader"), usesDefault),
      showWhen(scope, note("The shader sets the colours; call defaultColor() in it to choose one here."), derived([processed], () => !usesDefault.value)),
    ),
    shaderSection(scope, l, {
      fragmentMain: ads.shader,
      shaderError: ads.shaderError,
      shaderControlState: ads.shaderControls,
      codeVisible: l.codeVisible,
      hideInactive: l.hideInactiveShaderControls,
      help: `${DOCS}/annotation/rendering.md`,
      properties: () => (ads.annotationProperties.value ?? []).map((p: { identifier: string; type: string }) => ({ name: `prop_${p.identifier}`, type: p.type })),
      propertiesChanged: [ads.annotationProperties],
    }),
  ];
}

// ------------------------------------------------------------ single mesh

function meshRender(scope: Scope, l: SingleMeshUserLayer): HTMLElement[] {
  const ds = l.displayState as any;
  const attributes = l.vertexAttributes as Watch<{ name: string; numComponents: number; min?: number; max?: number }[] | undefined>;
  return [
    shaderSection(scope, l, {
      fragmentMain: ds.fragmentMain,
      shaderError: ds.shaderError,
      shaderControlState: ds.shaderControlState,
      codeVisible: l.codeVisible,
      hideInactive: l.hideInactiveShaderControls,
      help: `${DOCS}/sliceview/image_layer_rendering.md`,
      properties: () =>
        (attributes.value ?? []).map((a) => ({
          name: a.name,
          type: a.numComponents > 1 ? `vec${a.numComponents}` : "float",
          range: a.min !== undefined && a.max !== undefined ? `${a.min.toPrecision(6)} to ${a.max.toPrecision(6)}` : undefined,
        })),
      propertiesChanged: [attributes],
    }),
  ];
}
