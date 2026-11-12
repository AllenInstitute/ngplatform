/**
 * The layer inspector: a layer's settings as the platform's own interface,
 * in a dataset's card in the Layers panel.
 *
 * Its sections are the layer's own tabs (Neuroglancer decides which a layer
 * has: Rendering, Source, Segments, Annotations, Schema…), Rendering first,
 * each opened and closed on its own; a section's content is made when it
 * is opened and let go when it is closed. Which are open is the caller's
 * (`SectionsOpen`), so it is the same for every layer and kept across
 * reloads. Each section is built here from the layer's models; a tab this
 * file does not know (a plugin's, or the graph tab of a graphene layer) is
 * shown as Neuroglancer draws it.
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

/** Which sections are open, by tab id: the same for every layer. */
export interface SectionsOpen {
  has(id: string): boolean;
  set(id: string, open: boolean): void;
}

export function mountInspector(host: HTMLElement, layer: UserLayer, open: SectionsOpen): () => void {
  const scope = new Scope();
  const options = (layer as any).tabs.options as Map<string, TabOption>;
  const annotationStates = (layer as any).annotationStates as { states: unknown[]; changed: { add(f: () => void): () => void } } | undefined;
  const root = el("div", { class: "ins-root ins-sections" });
  host.append(root);

  /** The sections shown: the layer's tabs, in their order, Rendering first (Annotations always, as Neuroglancer shows it). */
  const tabs = () =>
    [...options]
      .filter(([, o]) => !(o.hidden?.value ?? false))
      .sort(([a, x], [b, y]) => (a === "rendering" ? -1 : 0) - (b === "rendering" ? -1 : 0) || (x.order ?? 0) - (y.order ?? 0))
      .map(([id, o]) => ({ id, label: NATIVE[id]?.label ?? o.label }));

  const sections = new Map<string, { element: HTMLDetailsElement; content: HTMLElement; scope?: Scope }>();
  /** A section's content, made as it opens. */
  const fill = (id: string, section: { content: HTMLElement; scope?: Scope }) => {
    const tabScope = scope.child();
    section.scope = tabScope;
    const native = NATIVE[id];
    if (native !== undefined) {
      section.content.append(...native.build(tabScope, layer));
    } else {
      // Not one of the platform's own: Neuroglancer's, as a component.
      const tab = options.get(id)!.getter();
      tabScope.ng.registerDisposer(tab as never);
      tab.visibility.value = Number.POSITIVE_INFINITY;
      section.content.append(embed(tab.element, "ins-ng-tab"));
    }
  };
  const show = () => {
    const list = tabs();
    for (const [id, section] of sections) {
      if (list.some((t) => t.id === id)) continue;
      section.scope?.dispose();
      section.element.remove();
      sections.delete(id);
    }
    list.forEach(({ id, label }, i) => {
      let section = sections.get(id);
      if (section === undefined) {
        const content = el("div", { class: "card-body ins-content" });
        const element = el("details", { class: "card ins-part", "data-section": id }, el("summary", { class: "card-head" }, el("span", { class: "card-title" }, label)), content) as HTMLDetailsElement;
        const made: { element: HTMLDetailsElement; content: HTMLElement; scope?: Scope } = { element, content };
        section = made;
        sections.set(id, made);
        element.addEventListener("toggle", () => {
          if (element.open === (made.scope !== undefined)) return;
          open.set(id, element.open);
          if (element.open) fill(id, made);
          else {
            made.scope?.dispose();
            made.scope = undefined;
            content.replaceChildren();
          }
        });
        if (open.has(id)) {
          element.open = true;
          fill(id, made);
        }
      }
      if (root.children[i] !== section.element) root.insertBefore(section.element, root.children[i] ?? null);
    });
  };

  const changed: Watch<unknown>[] = [{ value: undefined, changed: (layer as any).tabs.changed }];
  if (annotationStates !== undefined) changed.push({ value: undefined, changed: annotationStates.changed });
  for (const o of options.values()) if (o.hidden !== undefined) changed.push(o.hidden);
  scope.watchSoon(changed, show);

  return () => {
    scope.dispose();
    root.remove();
  };
}
