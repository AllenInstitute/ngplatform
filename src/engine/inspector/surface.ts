/**
 * The Render tab's Surface section, for a Zarr Vectors mesh layer with
 * values on its vertices (a FreeSurfer or GIFTI surface opened from this
 * computer, or a surface store zarr-vectors-tools wrote): Freeview's surface
 * controls.  Which surface of the hemisphere is shown (white, pial,
 * inflated, sphere: the layer's source switches to the sibling file), the
 * curvature in two greys, an overlay with a threshold and colour map, a
 * parcellation in its own colours, and the values under the mouse with the
 * parcel's name.  The choices are written as the layer's shader
 * (../surface_shader.ts), so they are saved and shared with the workspace.
 */
import { overlayRange, SURFACE_COLORMAPS, type SurfaceLook, surfaceLookOf, surfaceShader } from "../surface_shader.js";
import { changeLayerName, type SegmentationUserLayer } from "../neuroglancer.js";
import { button, el, note, row, type Scope, section, select, showWhen, type Watch } from "./ui.js";

interface SurfaceView {
  attributes: { id: string; name: string; components: number; labels?: { code: number; name: string; rgba: number[] }[] }[];
  surface: { geometry: string; alternates: Record<string, string>; surfaces: Record<string, string>; maps: string[]; labelTables: Record<string, unknown> } | undefined;
  storeUrl: string;
  values(id: string): number[];
  picked(mouseState: unknown): Record<string, number> | undefined;
}

/** The surface a Zarr Vectors layer shows, if it is a mesh layer (see the plugin's layer.ts). */
export function surfaceViewOf(layer: unknown): SurfaceView | undefined {
  return (layer as { zarrVectorsSurface?: () => SurfaceView | undefined }).zarrVectorsSurface?.();
}

/** Surfaces in the order Freeview lists them. */
const ORDER = ["white", "pial", "inflated", "sphere", "orig", "smoothwm", "midthickness"];
/** Attributes read as curvature, best first. */
const CURVATURE = ["curv", "sulc"];
/** As many attributes as the layer can show at once (the plugin's MAX_ATTRIBUTES). */
const MAX_SHOWN = 12;

/** The section, rebuilt as the layer loads (its attributes come with its data). */
export function surfaceSection(scope: Scope, l: SegmentationUserLayer): HTMLElement {
  const host = el("div", { class: "ins-deferred" });
  let inner: Scope | undefined;
  let shownFor = "";
  scope.watchSoon([{ value: undefined, changed: (l as any).layersChanged }], () => {
    const view = surfaceViewOf(l);
    const key = view === undefined ? "" : `${view.storeUrl}|${view.attributes.map((a) => a.id).join(",")}`;
    if (key === shownFor) return;
    shownFor = key;
    inner?.dispose();
    inner = undefined;
    host.replaceChildren();
    if (view === undefined || (view.attributes.length === 0 && view.surface === undefined)) return;
    inner = scope.child();
    host.append(build(inner, l, view));
  });
  return host;
}

function build(scope: Scope, l: SegmentationUserLayer, view: SurfaceView): HTMLElement {
  const ds = l.displayState as any;
  const shader = ds.skeletonRenderingOptions.shader as Watch<string>;
  const look = (): SurfaceLook => surfaceLookOf(shader.value) ?? {};
  const write = (next: SurfaceLook) => {
    const text = surfaceShader(next);
    if (text !== shader.value) shader.value = text;
  };
  const scalars = view.attributes.filter((a) => a.components === 1 && a.labels === undefined);
  const parcellations = view.attributes.filter((a) => a.labels !== undefined);
  const shownNames = new Set(view.attributes.map((a) => a.name));
  const tables = view.surface?.labelTables ?? {};
  const unloaded = (view.surface?.maps ?? []).filter((m) => !shownNames.has(m));
  const curvature = CURVATURE.map((c) => scalars.find((a) => a.name === c)).find((a) => a !== undefined);

  // A map the store holds but the layer does not show yet: asked for by
  // name in the source URL (`#attributes=`), which reloads the layer.
  const load = (name: string, then: SurfaceLook) => {
    const source = (l as any).dataSources?.[0];
    if (source === undefined) return;
    const names = [...view.attributes.map((a) => a.name), name].slice(-MAX_SHOWN);
    const base = String(source.spec.url).replace(/#.*$/, "");
    write(then);
    source.spec = { ...source.spec, url: `${base}#attributes=${names.map(encodeURIComponent).join(",")}`, setManually: true };
  };
  const withRange = (next: SurfaceLook): SurfaceLook => {
    if (next.overlay === undefined) return next;
    const values = view.values(next.overlay);
    return values.length === 0 ? next : { ...next, ...overlayRange(values, next.colormap ?? "heat") };
  };
  // An overlay chosen before its values were drawn gets its range once they are.
  // (A map just loaded is drawn a moment after the layer reloads: wait for it, a while.)
  let tries = 0;
  const fillRange = () => {
    const current = look();
    if (scope.disposed || current.overlay === undefined || current.range !== undefined) return;
    if (view.values(current.overlay).length > 0) write(withRange(current));
    else if (++tries < 40) setTimeout(fillRange, 500);
  };
  fillRange();

  const rows: HTMLElement[] = [];

  // Which surface: the hemisphere's siblings, by switching the source.
  const surfaces = Object.entries(view.surface?.surfaces ?? {}).sort((a, b) => rank(a[0]) - rank(b[0]));
  if (surfaces.length > 1) {
    const group = el("div", { class: "segmented" });
    for (const [kind, relative] of surfaces) {
      const b = button(kind, () => {
        const source = (l as any).dataSources?.[0];
        if (source === undefined || kind === view.surface?.geometry) return;
        const store = new URL(relative, view.storeUrl).href;
        // Named for the surface it now shows (lh.white becomes lh.inflated),
        // before the source changes, so the dataset it now shows is too.
        const managed = (l as any).managedLayer;
        const from = view.surface?.geometry ?? "";
        const renamed = String(managed?.name ?? "").replace(new RegExp(`(^|[._ -])${from.replace(/[.]/g, "\\.")}(?=$|[._ -])`), `$1${kind}`);
        if (from !== "" && managed !== undefined && renamed !== managed.name) changeLayerName(managed, renamed);
        source.spec = { ...source.spec, url: String(source.spec.url).replace(/^[^|#]*/, store), setManually: true };
      }, `Show the ${kind} surface (the same vertices, so the same values)`);
      b.setAttribute("aria-pressed", String(kind === view.surface?.geometry));
      group.append(b);
    }
    rows.push(row("Surface", group, "Which of the hemisphere's surfaces is drawn, as Freeview's Surface menu"));
  }
  // Or the other surfaces the store keeps as attributes (zarr-vectors-tools'
  // coords_inflated…): the vertices are drawn at those instead.
  const alternates = Object.entries(view.surface?.alternates ?? {}).filter(([id]) => view.attributes.some((a) => a.id === id && a.components === 3));
  if (surfaces.length <= 1 && alternates.length > 0) {
    const group = el("div", { class: "segmented" });
    const choices: [string | undefined, string][] = [[undefined, view.surface?.geometry || "geometry"], ...alternates.sort((a, b) => rank(a[1]) - rank(b[1]))];
    const buttons = choices.map(([id, kind]) => {
      const b = button(kind, () => write({ ...look(), position: id }), `Draw the ${kind} surface (the same vertices, so the same values)`);
      group.append(b);
      return [id, b] as const;
    });
    scope.watch(shader, () => {
      for (const [id, b] of buttons) b.setAttribute("aria-pressed", String(look().position === id));
    });
    rows.push(row("Surface", group, "Which of the hemisphere's surfaces is drawn, as Freeview's Surface menu"));
  }

  const changed = [shader];
  rows.push(
    row(
      "Colour",
      select<string>(
        scope,
        [
          ...(curvature !== undefined ? [{ value: "curvature", label: `Binary curvature (${curvature.name})` }] : []),
          { value: "layer", label: "Layer colour" },
        ],
        () => (look().curvature !== undefined ? "curvature" : "layer"),
        (v) => write({ ...look(), curvature: v === "curvature" ? curvature?.id : undefined }),
        changed,
      ),
      "Under the overlay: curvature in two greys (sulci dark), as Freeview, or the layer's colour",
    ),
  );

  const overlayOptions = [
    { value: "", label: "None" },
    ...scalars.map((a) => ({ value: a.id, label: a.name })),
    ...unloaded.filter((m) => tables[m] === undefined).map((m) => ({ value: `load:${m}`, label: `${m} (load)` })),
  ];
  rows.push(
    row(
      "Overlay",
      select<string>(
        scope,
        overlayOptions,
        () => look().overlay ?? "",
        (v) => {
          const base = { ...look(), range: undefined, threshold: undefined, max: undefined };
          if (v.startsWith("load:")) {
            const name = v.slice(5);
            load(name, { ...base, overlay: safeId(name), colormap: base.colormap ?? "heat" });
          } else write(withRange({ ...base, overlay: v === "" ? undefined : v, colormap: base.colormap ?? "heat" }));
        },
        changed,
      ),
      "Values drawn in colour where they pass the threshold (thickness, sulcal depth, a statistic)",
    ),
    showWhen(
      scope,
      row(
        "Colour map",
        select<string>(
          scope,
          SURFACE_COLORMAPS.map((m) => ({ value: m.id, label: m.label })),
          () => look().colormap ?? "heat",
          (v) => write(withRange({ ...look(), colormap: v })),
          changed,
        ),
        "Heat is Freeview's: red to yellow above the threshold, blue to cyan below its negative; others run from the threshold to the top",
      ),
      {
        get value() {
          return look().overlay !== undefined;
        },
        changed: shader.changed,
      },
    ),
  );
  rows.push(
    row(
      "Parcellation",
      select<string>(
        scope,
        [
          { value: "", label: "None" },
          ...parcellations.map((a) => ({ value: a.id, label: a.name })),
          ...unloaded.filter((m) => tables[m] !== undefined).map((m) => ({ value: `load:${m}`, label: `${m} (load)` })),
        ],
        () => look().parcellation ?? "",
        (v) => {
          if (v.startsWith("load:")) load(v.slice(5), { ...look(), parcellation: safeId(v.slice(5)) });
          else write({ ...look(), parcellation: v === "" ? undefined : v });
        },
        changed,
      ),
      "A parcellation (.annot, labels) in its own colours, over the rest",
    ),
  );
  const outlines = el("input", { type: "checkbox" }) as HTMLInputElement;
  outlines.addEventListener("change", () => write({ ...look(), outlines: outlines.checked }));
  scope.watch(shader, () => (outlines.checked = look().outlines === true));
  rows.push(row("2-D outlines", el("label", { class: "ins-inline" }, outlines, "coloured by the values"), "The surface's outline on the sections: in the layer's colour (as Freeview), or as in 3-D"));

  // What is under the mouse: each value, and the parcel's name.
  const readout = el("div", { class: "ins-faint ins-surface-readout" }, "—");
  const mouseState = (l as any).manager?.root?.layerSelectedValues?.mouseState ?? (l as any).manager?.layerSelectedValues?.mouseState;
  if (mouseState !== undefined) {
    scope.watchSoon([{ value: undefined, changed: mouseState.changed }], () => {
      const values = view.picked(mouseState);
      if (values === undefined) {
        readout.textContent = "—";
        return;
      }
      readout.textContent = view.attributes
        .filter((a) => values[a.id] !== undefined)
        .map((a) => {
          const v = values[a.id];
          if (a.labels !== undefined) return `${a.name}: ${a.labels.find((x) => x.code === Math.round(v))?.name ?? "none"}`;
          return `${a.name} ${Number(v.toPrecision(4))}`;
        })
        .join(" · ");
    });
  }
  rows.push(row("Under the mouse", readout, "The values of the vertex under the mouse in the 3-D view or on an outline"));

  if (rows.length === 0) return el("div");
  return section(
    "Surface",
    ...rows,
    note("Threshold, top and parcellation opacity are the shader's controls, below."),
  );
}

function rank(kind: string): number {
  const i = ORDER.indexOf(kind);
  return i === -1 ? ORDER.length : i;
}

/** An attribute's shader name, as the plugin makes it (`safeAttributeId`, for names without clashes). */
function safeId(name: string): string {
  let base = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-z]/.test(base)) base = `a_${base}`;
  return base.replace(/__+/g, "_");
}

/**
 * Shows a surface map as the layer's overlay, as the Surface section's
 * Overlay menu does: a map the layer does not show yet is asked for in the
 * source (the layer reloads), and its range is set once its values are
 * drawn.  False when the layer is not a surface.
 */
export function setSurfaceOverlay(l: SegmentationUserLayer, name: string): boolean {
  const view = surfaceViewOf(l);
  if (view === undefined) return false;
  const shader = (l.displayState as any).skeletonRenderingOptions.shader as Watch<string>;
  const look = surfaceLookOf(shader.value) ?? {};
  const next: SurfaceLook = { ...look, overlay: name, range: undefined, threshold: undefined, max: undefined };
  const text = surfaceShader(next);
  if (text !== shader.value) shader.value = text;
  if (!view.attributes.some((a) => a.name === name)) {
    const source = (l as any).dataSources?.[0];
    if (source !== undefined) {
      const names = [...view.attributes.map((a) => a.name), name].slice(-MAX_SHOWN);
      const base = String(source.spec.url).replace(/#.*$/, "");
      source.spec = { ...source.spec, url: `${base}#attributes=${names.map(encodeURIComponent).join(",")}`, setManually: true };
    }
  }
  let tries = 0;
  const fill = () => {
    const current = surfaceLookOf(shader.value);
    const now = surfaceViewOf(l);
    if (current?.overlay !== name || current.range !== undefined) return;
    const values = now?.values(name) ?? [];
    if (values.length > 0) shader.value = surfaceShader({ ...current, ...overlayRange(values, current.colormap ?? "heat") });
    else if (++tries < 40) setTimeout(fill, 500);
  };
  fill();
  return true;
}

