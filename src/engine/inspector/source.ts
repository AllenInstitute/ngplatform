/**
 * The Source tab: a layer's data sources, each with its URL (completed as
 * Neuroglancer completes it), whether it loaded, its messages, which of its
 * parts (subsources) are on, and its coordinate transform as an editable
 * table. Sources can be added and removed.
 */
import {
  type CoordinateSpace,
  DataType,
  formatScaleWithUnitAsString,
  type LayerDataSource,
  type LoadedDataSubsource,
  type LoadedLayerDataSource,
  LocalDataSource,
  makeCoordinateSpace,
  MeshSource,
  MultiscaleMeshSource,
  MultiscaleVolumeChunkSource,
  parseScale,
  SkeletonSource,
  type UserLayer,
  type WatchableCoordinateSpaceTransform,
} from "../neuroglancer.js";
import { signal } from "./render.js";
import { button, el, growingInput, messagesView, note, type Scope, textInput, type Watch } from "./ui.js";

/** What kind of data a subsource holds, in words. */
export function subsourceKind(subsource: any): string {
  const { volume, mesh } = subsource;
  if (volume instanceof MultiscaleVolumeChunkSource) return `${DataType[volume.dataType].toLowerCase()} volume`;
  if (mesh instanceof MeshSource) return "meshes (single resolution)";
  if (mesh instanceof MultiscaleMeshSource) return "meshes (multiresolution)";
  if (mesh instanceof SkeletonSource) return "skeletons";
  if (subsource.segmentPropertyMap !== undefined) return "segment properties";
  if (subsource.local === LocalDataSource.annotations) return "local annotations";
  if (subsource.local === LocalDataSource.equivalences) return "local segment graph";
  if (subsource.staticAnnotations !== undefined) return "default annotations";
  if (subsource.annotation !== undefined) return "annotations";
  if (subsource.singleMesh !== undefined) return "single mesh";
  if (subsource.segmentationGraph !== undefined) return "segmentation graph";
  return "";
}

export function sourceTab(scope: Scope, layer: UserLayer): HTMLElement[] {
  const list = el("div", { class: "ins-sources" });
  const cards = new Map<LayerDataSource, { element: HTMLElement; scope: Scope; focus: () => void }>();
  let focusNext: LayerDataSource | undefined;
  scope.watchSoon([signal(layer.dataSourcesChanged)], () => {
    const sources = layer.dataSources;
    for (const [source, card] of cards) {
      if (!sources.includes(source)) {
        card.scope.dispose();
        cards.delete(source);
      }
    }
    list.replaceChildren(
      ...sources.map((source, i) => {
        let card = cards.get(source);
        if (card === undefined) {
          const sub = scope.child();
          card = { scope: sub, ...sourceCard(sub, layer, source) };
          cards.set(source, card);
        }
        card.element.dataset.index = String(i + 1);
        return card.element;
      }),
    );
    if (focusNext !== undefined) {
      cards.get(focusNext)?.focus();
      focusNext = undefined;
    }
  });
  const add = button("Add a data source", () => {
    focusNext = layer.addDataSource(undefined);
  }, "Another source of data for this layer (each with its own transform)");
  const layerMessages = messagesView(scope, layer.messages as never);
  return [list, el("div", { class: "ins-actions" }, add), layerMessages];
}

function sourceCard(scope: Scope, layer: UserLayer, source: LayerDataSource): { element: HTMLElement; focus: () => void } {
  const element = el("section", { class: "ins-section ins-source" });
  const url = urlField(scope, layer, source);
  const status = el("p", { class: "ins-note" });
  const body = el("div", { class: "ins-source-body" });
  const remove = button("Remove", () => {
    source.spec = { ...source.spec, url: "" };
  }, "Remove this data source from the layer", "ins-danger");
  element.append(el("div", { class: "ins-section-head" }, el("h4", { class: "ins-section-title" }, "Data source"), el("div", { class: "ins-head-tools" }, remove)), url.element, status, messagesView(scope, source.messages as never), body);

  let loadedFor: unknown = null;
  let loadedScope: Scope | undefined;
  scope.watchSoon([signal(source.changed), signal(layer.dataSourcesChanged)], () => {
    remove.hidden = layer.dataSources.length < 2;
    url.sync();
    const state = source.loadState;
    if (state === loadedFor) return;
    loadedFor = state;
    loadedScope?.dispose();
    loadedScope = undefined;
    body.replaceChildren();
    if (source.spec.url === "") {
      status.textContent = "Type or paste a data source URL above.";
      return;
    }
    if (state === undefined) {
      status.textContent = "Loading…";
      return;
    }
    if (state.error !== undefined) {
      status.textContent = "";
      body.append(el("p", { class: "ins-message sev-2" }, `Could not load: ${(state.error as Error).message ?? String(state.error)}`));
      return;
    }
    status.textContent = "";
    loadedScope = scope.child();
    body.append(...loadedSource(loadedScope, state as LoadedLayerDataSource));
  });
  return { element, focus: () => url.input.focus() };
}

/** The URL box, with Neuroglancer's completions (schemes, buckets, paths) as a list under it. */
function urlField(scope: Scope, layer: UserLayer, source: LayerDataSource) {
  const commit = (value: string) => {
    const existing = source.spec;
    if (value !== "" && value === existing.url) return;
    source.spec = { ...existing, url: value, setManually: true } as never;
  };
  const input = growingInput(source.spec.url, commit, { class: "ins-text ins-grow ins-url", placeholder: "Data source URL, e.g. zarr://https://…", "aria-label": "Data source URL" });
  const menu = el("ul", { class: "ins-completions", role: "listbox" });
  menu.hidden = true;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const registry = (layer.manager as any).dataSourceProviderRegistry;
  const complete = () => {
    controller?.abort();
    const value = input.value;
    const own = (controller = new AbortController());
    registry
      .completeUrl({ url: value, signal: own.signal })
      .then((result: { offset: number; completions: { value: string; description?: string }[] }) => {
        if (own.signal.aborted || document.activeElement !== input) return;
        const items = result.completions.slice(0, 60);
        menu.hidden = items.length === 0;
        menu.replaceChildren(
          ...items.map((c) =>
            el(
              "li",
              {
                class: "ins-completion",
                role: "option",
                onmousedown: (e: MouseEvent) => {
                  e.preventDefault();
                  input.value = value.slice(0, result.offset) + c.value;
                  input.dispatchEvent(new Event("input"));
                  input.focus();
                  complete();
                },
              },
              el("span", {}, c.value),
              c.description ? el("span", { class: "ins-faint" }, c.description) : null,
            ),
          ),
        );
      })
      .catch(() => (menu.hidden = true));
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(complete, 150);
  });
  input.addEventListener("focus", complete);
  input.addEventListener("blur", () => {
    controller?.abort();
    menu.hidden = true;
  });
  scope.add(() => {
    controller?.abort();
    clearTimeout(timer);
  });
  return {
    element: el("div", { class: "ins-url-field" }, input, menu),
    input,
    sync: () => {
      if (document.activeElement !== input) (input as unknown as { setValue(v: string): void }).setValue(source.spec.url);
    },
  };
}

function loadedSource(scope: Scope, loaded: LoadedLayerDataSource): HTMLElement[] {
  const enabledChanged = signal(loaded.enabledSubsourcesChanged);
  const defaults = el("input", { type: "checkbox", class: "ins-check" }) as HTMLInputElement;
  defaults.addEventListener("change", () => {
    if (loaded.enableDefaultSubsources === defaults.checked) return;
    loaded.enableDefaultSubsources = defaults.checked;
    if (defaults.checked) for (const s of loaded.subsources) s.enabled = s.subsourceEntry.default;
    loaded.enabledSubsourcesChanged.dispatch();
  });
  scope.watch(enabledChanged, () => (defaults.checked = loaded.enableDefaultSubsources));
  const parts = el(
    "div",
    { class: "ins-subsources" },
    el("label", { class: "ins-row ins-check-row", title: "The source's own choice of which parts to show" }, defaults, el("span", { class: "ins-label" }, "Default parts")),
    ...loaded.subsources.map((s) => subsourceRow(scope, loaded, s)),
  );
  return [el("h5", { class: "ins-subhead" }, "Parts"), parts, el("h5", { class: "ins-subhead" }, "Transform"), transformTable(scope, loaded.transform)];
}

function subsourceRow(scope: Scope, loaded: LoadedLayerDataSource, s: LoadedDataSubsource): HTMLElement {
  const box = el("input", { type: "checkbox", class: "ins-check" }) as HTMLInputElement;
  box.addEventListener("change", () => {
    if (s.enabled === box.checked) return;
    s.enabled = box.checked;
    loaded.enableDefaultSubsources = false;
    loaded.enabledSubsourcesChanged.dispatch();
  });
  const active = el("span", { class: "ins-dot" });
  scope.watch([signal(loaded.enabledSubsourcesChanged), signal(loaded.activatedSubsourcesChanged)], () => {
    box.checked = s.enabled;
    active.classList.toggle("on", s.activated !== undefined);
    active.title = s.activated !== undefined ? "In use" : s.enabled ? "On, not in use by this layer type" : "Off";
  });
  return el(
    "div",
    { class: "ins-subsource" },
    el("label", { class: "ins-row ins-check-row" }, box, active, el("code", { class: "ins-id" }, s.subsourceEntry.id || "default"), el("span", { class: "ins-faint" }, subsourceKind(s.subsourceEntry.subsource))),
    messagesView(scope, s.messages as never),
  );
}

// --------------------------------------------------------------- transform

/** A scale with its unit, e.g. "1 mm" (Neuroglancer writes 1 mm as "mm"). */
function scaleText(scale: number, unit: string, precision: number): string {
  const text = formatScaleWithUnitAsString(scale, unit, { precision });
  return /^[a-zµ]/i.test(text) ? `1 ${text}` : text;
}

function fmt(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Number(v.toPrecision(6)).toString();
}

function boundsText(space: CoordinateSpace, i: number): string {
  const lo = space.bounds.lowerBounds[i];
  const hi = space.bounds.upperBounds[i];
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return "";
  return `[${fmt(lo)}, ${fmt(hi)})`;
}

/**
 * The source-to-layer transform: one row per output dimension (its name,
 * which may end in ' for a local or ^ for a channel dimension, and its
 * scale), one column per source dimension, and a translation column.
 */
export function transformTable(scope: Scope, t: WatchableCoordinateSpaceTransform): HTMLElement {
  const host = el("div", { class: "ins-transform" });
  const identity = () => {
    const stride = t.value.rank + 1;
    return Float64Array.from({ length: stride * stride }, (_, k) => (k % stride === Math.floor(k / stride) ? 1 : 0));
  };
  const toIdentity = button("Reset to identity", () => (t.transform = identity()), "Identity matrix and no offset; names and scales stay");
  const toDefault = button("Reset to the source's own", () => t.reset(), "The transform, names and scales the source itself gives");
  const editing = () => host.contains(document.activeElement);
  const render = () => {
    if (editing()) return;
    const value = t.value;
    const { rank, inputSpace, outputSpace, transform } = value;
    const stride = rank + 1;
    const cells: HTMLElement[] = [];
    cells.push(el("div", { class: "ins-tx-corner" }, "out \\ in"));
    for (let j = 0; j < rank; ++j) {
      cells.push(
        el(
          "div",
          { class: "ins-tx-in", title: boundsText(inputSpace, j) ? `Source bounds ${boundsText(inputSpace, j)}` : undefined },
          el("span", { class: "ins-tx-name" }, inputSpace.names[j] || `${j}`),
          el("span", { class: "ins-faint" }, scaleText(inputSpace.scales[j], inputSpace.units[j], 2)),
          el("span", { class: "ins-faint ins-tx-bounds" }, boundsText(inputSpace, j)),
        ),
      );
    }
    cells.push(el("div", { class: "ins-tx-in" }, el("span", { class: "ins-tx-name" }, "offset")));
    for (let i = 0; i < rank; ++i) {
      const name = textInput(outputSpace.names[i], (v) => setOutput(t, i, { name: v.trim() }), { class: "ins-text ins-tx-cell", "aria-label": `Name of output dimension ${i + 1}` });
      const scale = textInput(scaleText(outputSpace.scales[i], outputSpace.units[i], 6), (v) => setOutput(t, i, { scale: v.replace(/\s+/g, "") }), {
        class: "ins-text ins-tx-cell",
        "aria-label": `Scale of ${outputSpace.names[i]}`,
      });
      cells.push(el("div", { class: "ins-tx-out" }, name, scale));
      for (let j = 0; j <= rank; ++j) {
        const k = j * stride + i;
        cells.push(
          textInput(fmt(transform[k]), (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return render();
            const next = Float64Array.from(t.value.transform);
            next[k] = n;
            t.transform = next;
          }, { class: "ins-text ins-tx-cell num", "aria-label": `${outputSpace.names[i]} from ${j < rank ? inputSpace.names[j] : "offset"}` }),
        );
      }
    }
    const grid = el("div", { class: "ins-tx-grid" }, ...cells);
    grid.style.gridTemplateColumns = `minmax(90px, 1.3fr) repeat(${rank + 1}, minmax(52px, 1fr))`;
    const id = identity();
    toIdentity.hidden = transform.length === id.length && transform.every((v, k) => v === id[k]);
    toDefault.hidden = t.spec === undefined;
    host.replaceChildren(grid, el("div", { class: "ins-actions" }, toIdentity, toDefault));
  };
  host.addEventListener("focusout", () => setTimeout(() => !editing() && render(), 0));
  scope.watch(t as unknown as Watch<unknown>, render);
  return host;
}

/** Renames or rescales one output dimension. */
function setOutput(t: WatchableCoordinateSpaceTransform, i: number, change: { name?: string; scale?: string }): void {
  const space = t.outputSpace.value;
  const names = [...space.names];
  const scales = Float64Array.from(space.scales);
  const units = [...space.units];
  const timestamps = [...space.timestamps];
  if (change.name !== undefined) {
    if (change.name === "" || names.some((n, k) => k !== i && n === change.name)) return void (t.outputSpace.value = space);
    names[i] = change.name;
  }
  if (change.scale !== undefined) {
    const parsed = parseScale(change.scale);
    if (parsed === undefined) return void (t.outputSpace.value = space);
    scales[i] = parsed.scale;
    units[i] = parsed.unit;
  }
  timestamps[i] = Date.now();
  t.outputSpace.value = makeCoordinateSpace({ ...space, names, scales, units, timestamps, ids: space.ids, boundingBoxes: space.boundingBoxes } as never);
}

export function emptySource(): HTMLElement {
  return note("No data sources.");
}
