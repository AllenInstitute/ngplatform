/**
 * The layer inspector: a layer's settings as the platform's own interface,
 * in a dataset's card in the Layers panel.
 *
 * The tabs are the layer's own (Neuroglancer decides which a layer has:
 * Rendering, Source, Segments, Annotations, Schema…), Rendering first, and the
 * selected tab is kept in the layer's state as Neuroglancer keeps it.  A
 * layer first shown here opens on Rendering, unless its tab was chosen. Each tab is built
 * here from the layer's models; a tab this file does not know (a plugin's,
 * or the graph tab of a graphene layer) is shown as Neuroglancer draws it.
 */
import { AnnotationUserLayer, SegmentationUserLayer, type UserLayer } from "../neuroglancer.js";
import { annotationsTab, schemaTab } from "./annotations.js";
import { renderTab } from "./render.js";
import { segmentsTab } from "./segments.js";
import { sourceTab } from "./source.js";
import { el, embed, Scope, type Watch } from "./ui.js";

type Builder = (scope: Scope, layer: UserLayer) => HTMLElement[];

const NATIVE: Record<string, { label: string; build: Builder }> = {
  source: { label: "Source", build: sourceTab },
  rendering: { label: "Rendering", build: renderTab },
  segments: {
    label: "Segments",
    build: (scope, layer) => (layer instanceof SegmentationUserLayer ? segmentsTab(scope, layer) : []),
  },
  annotations: { label: "Annotations", build: (scope, layer) => annotationsTab(scope, layer as AnnotationUserLayer) },
  schema: {
    label: "Schema",
    build: (scope, layer) => (layer instanceof AnnotationUserLayer ? schemaTab(scope, layer) : []),
  },
};

interface TabOption {
  label: string;
  order?: number;
  hidden?: Watch<boolean>;
  getter: () => { element: HTMLElement; visibility: { value: number }; dispose(): void };
}

/** Layers shown here already: a layer opens on Display the first time only, so the tab chosen after stays. */
const seen = new WeakSet<UserLayer>();

export function mountInspector(host: HTMLElement, layer: UserLayer): () => void {
  const scope = new Scope();
  const options = (layer as any).tabs.options as Map<string, TabOption>;
  const annotationStates = (layer as any).annotationStates as { states: unknown[]; changed: { add(f: () => void): () => void } } | undefined;
  const selected = (layer as any).panels.panels[0].selectedTab as Watch<string | undefined>;

  const strip = el("div", { class: "ins-tabs", role: "tablist" });
  const content = el("div", { class: "ins-content", role: "tabpanel" });
  const root = el("div", { class: "ins-root" }, strip, content);
  host.append(root);

  /** The tabs shown: the layer's own, in their order, Rendering first (Annotations always, as Neuroglancer shows it). */
  const tabs = () =>
    [...options]
      .filter(([, o]) => !(o.hidden?.value ?? false))
      .sort(([a, x], [b, y]) => (a === "rendering" ? -1 : 0) - (b === "rendering" ? -1 : 0) || (x.order ?? 0) - (y.order ?? 0))
      .map(([id, o]) => ({ id, label: NATIVE[id]?.label ?? o.label }));
  // Neuroglancer opens a layer on Source; here it opens on Rendering, the controls used most,
  // without changing the layer's state (that would be a change to undo) until a tab is clicked.
  let override: string | undefined;
  if (!seen.has(layer)) {
    seen.add(layer);
    if ((selected.value === undefined || selected.value === "source") && options.has("rendering") && layer.dataSources.some((s) => s.spec.url !== "")) override = "rendering";
  }

  let shown: { id: string; scope: Scope } | undefined;
  const show = () => {
    const list = tabs();
    let id = override !== undefined && list.some((t) => t.id === override) ? override : selected.value;
    if (!list.some((t) => t.id === id)) {
      id = list[0]?.id;
      if (id !== undefined && selected.value !== id) {
        selected.value = id;
        return; // `selected` changed: show() runs again.
      }
    }
    strip.replaceChildren(
      ...list.map((t) =>
        el(
          "button",
          {
            type: "button",
            role: "tab",
            class: "tab",
            "aria-selected": String(t.id === id),
            onclick: () => {
              override = undefined;
              if (selected.value === t.id) show();
              else selected.value = t.id;
            },
          },
          t.label,
        ),
      ),
    );
    if (shown?.id === id) return;
    shown?.scope.dispose();
    shown = undefined;
    content.replaceChildren();
    if (id === undefined) return;
    const tabScope = scope.child();
    shown = { id, scope: tabScope };
    const native = NATIVE[id];
    if (native !== undefined) {
      content.append(...native.build(tabScope, layer));
    } else {
      // Not one of the platform's own: Neuroglancer's, as a component.
      const tab = options.get(id)!.getter();
      tabScope.ng.registerDisposer(tab as never);
      tab.visibility.value = Number.POSITIVE_INFINITY;
      content.append(embed(tab.element, "ins-ng-tab"));
    }
    content.scrollTop = 0;
  };

  const changed: Watch<unknown>[] = [selected, { value: undefined, changed: (layer as any).tabs.changed }];
  if (annotationStates !== undefined) changed.push({ value: undefined, changed: annotationStates.changed });
  for (const o of options.values()) if (o.hidden !== undefined) changed.push(o.hidden);
  scope.watchSoon(changed, show);

  return () => {
    scope.dispose();
    root.remove();
  };
}
