/**
 * The Annotations tab: the tools that draw annotations into the views, and
 * each source's annotations as a list (click one to go to it, double-click
 * its description to edit it, delete it); and the Schema tab, the per-
 * annotation properties of the layer's local annotations.
 */
import {
  type Annotation,
  AnnotationSource,
  AnnotationType,
  annotationTypeHandlers,
  type AnnotationUserLayer,
  restoreLegacyTool,
  transformPoint,
} from "../neuroglancer.js";
import { signal } from "./render.js";
import { button, colour, el, fromHex, note, row, type Scope, section, textInput, toHex, type Watch } from "./ui.js";

const TOOLS: { id: string; label: string; title: string }[] = [
  { id: "annotatePoint", label: "Point", title: "Click in a view to place a point" },
  { id: "annotateLine", label: "Line", title: "Click twice in a view to draw a line" },
  { id: "annotateBoundingBox", label: "Box", title: "Click two corners in a view to draw a box" },
  { id: "annotateSphere", label: "Ellipsoid", title: "Click the centre, then the extent" },
  { id: "annotatePolyline", label: "Polyline", title: "Click points; double-click to finish" },
];

/** An annotation's centre, in its source's coordinates. */
function centre(a: Annotation): Float32Array {
  const any = a as any;
  switch (a.type) {
    case AnnotationType.POINT:
      return Float32Array.from(any.point);
    case AnnotationType.LINE:
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
      return Float32Array.from(any.pointA, (v: number, i: number) => (v + any.pointB[i]) / 2);
    case AnnotationType.ELLIPSOID:
      return Float32Array.from(any.center);
    default:
      return Float32Array.from(any.points?.[0] ?? any.point ?? []);
  }
}

/** A packed colour property (red in the low byte, as Neuroglancer packs it), as #rrggbb. */
function packedHex(v: number): string {
  return toHex([(v >>> 0) & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff].map((c) => c / 255));
}

function packHex(hex: string): number {
  const [r, g, b] = fromHex(hex);
  return (Math.round(r * 255) | (Math.round(g * 255) << 8) | (Math.round(b * 255) << 16)) >>> 0;
}

function round(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Where an annotation is, in a line. */
function summary(a: Annotation): string {
  const any = a as any;
  const p = (x: ArrayLike<number>) => `(${Array.from(x, round).join(", ")})`;
  switch (a.type) {
    case AnnotationType.POINT:
      return p(any.point);
    case AnnotationType.LINE:
      return `${p(any.pointA)} to ${p(any.pointB)}`;
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
      return `${p(any.pointA)} to ${p(any.pointB)}`;
    case AnnotationType.ELLIPSOID:
      return `${p(any.center)}, radii ${p(any.radii)}`;
    default:
      return any.points ? `${any.points.length} points from ${p(any.points[0])}` : "";
  }
}

export function annotationsTab(scope: Scope, layer: AnnotationUserLayer): HTMLElement[] {
  const states = layer.annotationStates as any;
  const tool = layer.tool as unknown as Watch<{ toJSON(): unknown } | undefined>;
  const toolbox = el("div", { class: "ins-segmented ins-tools" });
  const buttons = TOOLS.map((t) =>
    button(t.label, () => {
      const current = tool.value?.toJSON();
      tool.value = current === t.id ? undefined : (restoreLegacyTool(layer, t.id) as never);
    }, t.title),
  );
  toolbox.append(...buttons);
  const mutable = () => states.states.some((s: any) => !s.source.readonly);
  scope.watch([tool, signal(states.changed)], () => {
    const current = tool.value?.toJSON();
    const editable = mutable();
    TOOLS.forEach((t, i) => {
      buttons[i].setAttribute("aria-pressed", String(current === t.id));
      buttons[i].disabled = !editable;
    });
  });

  const lists = el("div", { class: "ins-annotation-sources" });
  let built: Scope | undefined;
  scope.watchSoon([signal(states.changed)], () => {
    built?.dispose();
    built = scope.child();
    const all = states.states as any[];
    lists.replaceChildren(...(all.length === 0 ? [note("No annotation sources.")] : all.map((state, i) => sourceList(built!, layer, state, all.length > 1 ? i + 1 : 0))));
  });

  // A layer with nowhere to keep annotations (an image, say) can be given
  // one: a local annotation source, saved in the state like any annotation
  // layer's, beside its data.
  const start = el(
    "div",
    { class: "ins-actions" },
    button("Add annotations to this layer", () => {
      const source = (layer as any).addDataSource(undefined);
      source.spec = { ...source.spec, url: "local://annotations", setManually: true };
    }, "A local annotation source for this layer: points, lines, boxes and ellipsoids kept with it"),
  );
  scope.watch([signal(states.changed)], () => {
    start.hidden = mutable();
  });

  return [
    section(
      "Draw",
      el("div", { class: "ins-row ins-wide" }, toolbox),
      start,
      row("Colour", colour(scope, (layer.annotationDisplayState as any).color), "The colour annotations are drawn in, unless the shader says otherwise"),
      note("Choose a tool, then click in a view to place it; its description (its name) opens for typing. Choose the tool again, or press Escape, to stop. Labels can show descriptions beside the annotations (the Labels tab)."),
    ),
    lists,
  ];
}

function sourceList(scope: Scope, layer: AnnotationUserLayer, state: any, number: number): HTMLElement {
  const source = state.source;
  const title = `${source.readonly ? "Annotations (read-only)" : "Annotations"}${number ? ` ${number}` : ""}`;
  const list = el("div", { class: "ins-annotation-list" });
  const count = el("span", { class: "ins-faint" });
  const head = el("div", { class: "ins-section-head" }, el("h4", { class: "ins-section-title" }, title), count);
  const element = el("section", { class: "ins-section" }, head, list);
  if (!(source instanceof AnnotationSource)) {
    list.append(note("Drawn in the views but not listed (too many to list). Click one in a view to inspect it."));
    return element;
  }
  // The annotation just placed opens its description for typing: its name.
  let justAdded: string | undefined;
  if (!source.readonly) {
    scope.add(source.childAdded.add((a: Annotation) => {
      justAdded = a.id;
    }));
  }
  const watches = [signal(source.childAdded), signal(source.childUpdated), signal(source.childDeleted), signal(source.childrenReordered), signal(source.changed), signal(state.transform.changed)];
  scope.watchSoon(watches, () => {
    const annotations = [...(source as Iterable<Annotation>)];
    count.textContent = annotations.length.toLocaleString();
    const properties = (source.properties.value ?? []) as readonly { identifier: string; type: string }[];
    list.replaceChildren(
      ...(annotations.length === 0 ? [note(source.readonly ? "None." : "None yet: choose a tool above and click in a view.")] : []),
      ...annotations.slice(0, 2000).map((a) => {
        const row = annotationRow(layer, state, a, properties);
        if (a.id === justAdded) {
          justAdded = undefined;
          queueMicrotask(() => {
            row.scrollIntoView({ block: "nearest" });
            row.querySelector(".ins-ann-desc")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
          });
        }
        return row;
      }),
      ...(annotations.length > 2000 ? [note(`And ${(annotations.length - 2000).toLocaleString()} more.`)] : []),
    );
  });
  return element;
}

function annotationRow(layer: AnnotationUserLayer, state: any, a: Annotation, properties: readonly { identifier: string; type: string }[]): HTMLElement {
  const source = state.source;
  const goTo = () => {
    const transform = state.chunkTransform.value;
    if (transform?.error !== undefined || transform === undefined) return;
    const rank = transform.layerRank;
    const chunk = centre(a);
    const position = new Float32Array(rank);
    transformPoint(position, transform.chunkToLayerTransform, rank + 1, chunk, rank);
    (layer as any).setLayerPosition(transform.modelTransform, position);
    (layer as any).selectAnnotation(state, a.id, true);
  };
  const description = el("span", { class: "ins-ann-desc", title: source.readonly ? undefined : "Double-click to name it" }, a.description || (source.readonly ? "" : "(no description)"));
  if (!source.readonly) {
    description.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const edit = textInput(a.description ?? "", (v) => {
        const ref = source.getReference(a.id);
        try {
          source.update(ref, { ...ref.value, description: v || undefined });
          source.commit?.(ref);
        } finally {
          ref.dispose();
        }
      }, { "aria-label": "Description" });
      description.replaceWith(edit);
      edit.focus();
    });
  }
  const remove = source.readonly
    ? null
    : button("×", (e) => {
        e.stopPropagation();
        const ref = source.getReference(a.id);
        try {
          source.delete(ref);
        } finally {
          ref.dispose();
        }
      }, "Delete this annotation", "ins-chip-x");
  const values = properties.map((p, i) =>
    p.type === "rgb" || p.type === "rgba"
      ? el("span", { class: "ins-faint", title: p.identifier }, `${p.identifier} `, el("span", { class: "ins-swatch-inline", style: `background:${packedHex(a.properties[i])}` }))
      : el("span", { class: "ins-faint", title: p.identifier }, `${p.identifier} ${a.properties[i]}`),
  );
  const element = el(
    "div",
    { class: "ins-ann-row", title: "Click to go to it" },
    el("span", { class: "ins-ann-icon" }, annotationTypeHandlers[a.type].icon),
    el("div", { class: "ins-ann-main" }, el("span", { class: "ins-ann-pos" }, summary(a)), description, values.length ? el("div", { class: "ins-ann-props" }, ...values) : null),
    remove,
  );
  element.addEventListener("click", goTo);
  element.addEventListener("mouseenter", () => {
    (layer.annotationDisplayState as any).hoverState.value = { id: a.id, partIndex: 0, annotationLayerState: state };
  });
  return element;
}

// ----------------------------------------------------------------- schema

const PROPERTY_TYPES = ["float32", "uint32", "int32", "uint16", "int16", "uint8", "int8", "bool", "rgb", "rgba"];

export function schemaTab(scope: Scope, layer: AnnotationUserLayer): HTMLElement[] {
  const states = layer.annotationStates as any;
  const host = el("div", { class: "ins-schema" });
  const sources = () => (states.states as any[]).filter((s) => !s.source.readonly && "addProperty" in s.source).map((s) => s.source);
  const changed = () => {
    states.changed.dispatch();
    (layer as any).layersChanged.dispatch();
  };
  scope.watchSoon([signal(states.changed)], () => {
    const all = states.states as any[];
    const editable = sources().length > 0;
    const specs: any[] = all.flatMap((s) => s.source.properties.value ?? []).filter((p, i, arr) => arr.findIndex((q) => q.identifier === p.identifier) === i);
    const rows = specs.map((spec) => {
      const update = (patch: Record<string, unknown>) => {
        for (const s of sources()) s.updateProperty(spec, patch);
        changed();
      };
      const type = el("select", { class: "ins-select", disabled: !editable || spec.type === "bool" }, ...PROPERTY_TYPES.map((t) => el("option", { value: t }, t))) as HTMLSelectElement;
      type.value = spec.type;
      type.addEventListener("change", () => update({ type: type.value }));
      return el(
        "div",
        { class: "ins-schema-row" },
        editable ? textInput(spec.identifier, (v) => v.trim() && update({ identifier: v.trim() }), { "aria-label": "Identifier" }) : el("code", {}, spec.identifier),
        type,
        editable ? textInput(spec.description ?? "", (v) => update({ description: v || undefined }), { placeholder: "description", "aria-label": "Description" }) : el("span", { class: "ins-faint" }, spec.description ?? ""),
        !editable
          ? el("span", { class: "ins-faint" }, String(spec.default ?? ""))
          : spec.type === "rgb" || spec.type === "rgba"
            ? (() => {
                const input = el("input", { type: "color", class: "ins-colour", value: packedHex(spec.default ?? 0), "aria-label": "Default colour" }) as HTMLInputElement;
                input.addEventListener("change", () => update({ default: (packHex(input.value) | (spec.type === "rgba" ? 0xff000000 : 0)) >>> 0 }));
                return input;
              })()
            : textInput(String(spec.default ?? 0), (v) => {
                const n = Number(v);
                if (Number.isFinite(n)) update({ default: n });
              }, { class: "ins-text num", "aria-label": "Default" }),
        editable ? button("×", () => {
          for (const s of sources()) s.removeProperty(spec.identifier);
          changed();
        }, "Remove this property", "ins-chip-x") : el("span"),
      );
    });
    const add = () => {
      const taken = new Set(specs.map((s) => s.identifier));
      let n = specs.length + 1;
      while (taken.has(`property${n}`)) n++;
      const spec = { type: "float32", identifier: `property${n}`, default: 0, description: undefined };
      for (const s of sources()) s.addProperty(spec);
      changed();
    };
    host.replaceChildren(
      section(
        "Properties",
        note(editable ? "Values every annotation in this layer carries; the shader reads them as prop_<identifier>()." : "This layer's annotations are read-only; their properties are shown as the source defines them."),
        specs.length > 0 ? el("div", { class: "ins-schema-head" }, el("span", {}, "identifier"), el("span", {}, "type"), el("span", {}, "description"), el("span", {}, "default"), el("span")) : null,
        ...rows,
        editable ? el("div", { class: "ins-actions" }, button("Add a property", add)) : null,
      ),
    );
  });
  return [host];
}
