/**
 * A layer's shader, in the inspector: its code (Neuroglancer's GLSL editor,
 * as a component), compile and parse errors as text, the values the shader
 * can read, and its `#uicontrol`s as native controls. Contrast and
 * transfer-function controls keep Neuroglancer's histogram editors.
 */
import {
  channelInvlerpLayerControl,
  getShaderSelectOptionLabel,
  propertyInvlerpLayerControl,
  type RefCounted,
  ShaderCodeWidget,
  type ShaderControlState,
  transferFunctionLayerControl,
  type UserLayer,
} from "../neuroglancer.js";
import { button, checkbox, colour, el, embed, type Scope, select, slider, type Watch } from "./ui.js";

export interface ShaderModels {
  fragmentMain: Watch<string>;
  shaderError: Watch<unknown>;
  shaderControlState: ShaderControlState;
  /** Whether the code is shown (the layer's `codeVisible`). */
  codeVisible?: Watch<boolean>;
  /** Whether controls the compiled shader does not use are hidden. */
  hideInactive?: Watch<boolean>;
  legendShaderOptions?: unknown;
  /** Documentation for this kind of shader. */
  help: string;
  /** Per-object values the shader can read, by name and type. */
  properties?: () => { name: string; type: string; range?: string }[];
  propertiesChanged?: Watch<unknown>[];
}

/** The error text of a compile, link or `#uicontrol` parse failure. */
export function shaderErrorText(error: unknown): string | undefined {
  if (error == null) return undefined;
  const e = error as { errorMessages?: { line: number; message: string }[]; log?: string; message?: string };
  if (Array.isArray(e.errorMessages) && e.errorMessages.length > 0) {
    return e.errorMessages.map((m) => (m.line >= 0 ? `line ${m.line + 1}: ${m.message}` : m.message)).join("\n");
  }
  return e.log ?? e.message ?? String(error);
}

export function shaderSection(scope: Scope, layer: UserLayer, m: ShaderModels): HTMLElement {
  const root = el("section", { class: "ins-section ins-shader" });
  const code = new ShaderCodeWidget({
    fragmentMain: m.fragmentMain as never,
    shaderError: m.shaderError as never,
    shaderControlState: m.shaderControlState,
  });
  scope.ng.registerDisposer(code);
  const editor = embed(code.element, "ins-code");
  const refresh = () => requestAnimationFrame(() => code.textEditor.refresh());

  const head = el("div", { class: "ins-section-head" }, el("h4", { class: "ins-section-title" }, "Shader"));
  const tools = el("div", { class: "ins-head-tools" });
  if (m.codeVisible !== undefined) {
    const visible = m.codeVisible;
    const toggle = button("Code", () => (visible.value = !visible.value), "Show or hide the shader code");
    scope.watch(visible, () => {
      toggle.setAttribute("aria-pressed", String(visible.value));
      editor.hidden = !visible.value;
      if (visible.value) refresh();
    });
    tools.append(toggle);
  }
  const tall = button("Taller", () => {
    editor.classList.toggle("tall");
    tall.setAttribute("aria-pressed", String(editor.classList.contains("tall")));
    refresh();
  }, "A taller editor");
  tools.append(tall, el("a", { class: "ins-btn", href: m.help, target: "_blank", rel: "noopener", title: "Neuroglancer's documentation for this shader" }, "Docs"));
  head.append(tools);

  // What the shader can read.
  const props = el("div", { class: "ins-props" });
  if (m.properties !== undefined) {
    const list = m.properties;
    scope.watch(m.propertiesChanged ?? [], () => {
      const items = list();
      props.hidden = items.length === 0;
      props.replaceChildren(
        el("span", { class: "ins-props-label" }, "Values:"),
        ...items.map((p) => el("code", { class: "ins-prop", title: p.range }, `${p.type} ${p.name}`)),
      );
    });
  } else props.hidden = true;

  // Errors, as text under the code.
  const errors = el("pre", { class: "ins-error" });
  const parseErrors = m.shaderControlState.parseErrors as unknown as Watch<{ line: number; message: string }[]>;
  scope.watch([m.shaderError, parseErrors], () => {
    const lines = [
      ...parseErrors.value.map((e) => (e.line >= 0 ? `line ${e.line + 1}: ${e.message}` : e.message)),
      shaderErrorText(m.shaderError.value),
    ].filter((x): x is string => x !== undefined);
    errors.hidden = lines.length === 0;
    errors.textContent = lines.join("\n");
  });

  root.append(head, props, editor, errors, shaderControls(scope, layer, m));
  refresh();
  return root;
}

/** The shader's `#uicontrol`s, rebuilt when the shader's set of controls changes. */
function shaderControls(scope: Scope, layer: UserLayer, m: ShaderModels): HTMLElement {
  const state = m.shaderControlState;
  const host = el("div", { class: "ins-controls" });
  const list = el("div", { class: "ins-control-list" });
  const hiddenCount = el("span", { class: "ins-faint" });
  const hideRow =
    m.hideInactive !== undefined
      ? el(
          "label",
          { class: "ins-row ins-check-row", title: "Hide controls the compiled shader does not use (for example inside a branch that is off)." },
          checkbox(scope, m.hideInactive),
          el("span", { class: "ins-label" }, "Hide inactive controls "),
          hiddenCount,
        )
      : null;
  if (hideRow) host.append(hideRow);
  host.append(list);

  let built: Scope | undefined;
  const active = state.activeControls.hint as unknown as Watch<Set<string>>;
  const rebuild = () => {
    built?.dispose();
    const sub = (built = scope.child());
    const rows: HTMLElement[] = [];
    let hidden = 0;
    const entries = [...state.state];
    for (const [name, controlState] of entries) {
      if (m.hideInactive?.value && !active.value.has(name)) {
        hidden++;
        continue;
      }
      rows.push(controlRow(sub, layer, m, name, controlState, entries));
    }
    hiddenCount.textContent = hidden > 0 ? `(${hidden} hidden)` : "";
    list.replaceChildren(...rows);
    host.hidden = entries.length === 0;
  };
  scope.watchSoon([state.controls as unknown as Watch<unknown>, active, ...(m.hideInactive ? [m.hideInactive] : [])], rebuild);
  return host;
}

type ControlEntry = [string, { control: any; trackable: any }];

function controlRow(scope: Scope, layer: UserLayer, m: ShaderModels, name: string, controlState: ControlEntry[1], all: ControlEntry[]): HTMLElement {
  const { control, trackable } = controlState;
  const label = el("span", { class: "ins-label" }, name);
  const wrap = (body: Node, wide = false) => el("div", { class: `ins-row${wide ? " ins-wide" : ""}` }, label, el("div", { class: "ins-control" }, body));
  switch (control.type) {
    case "slider":
      return wrap(slider(scope, trackable, { min: control.min, max: control.max, step: control.step }));
    case "checkbox":
      return wrap(checkbox(scope, trackable));
    case "color":
      return wrap(colour(scope, trackable));
    case "select":
      return wrap(
        select(
          scope,
          control.options.map((o: { value: unknown }) => ({ value: o.value, label: getShaderSelectOptionLabel(o as never) })),
          () => trackable.value,
          (v) => (trackable.value = v),
          [trackable],
        ),
      );
  }
  // Histogram editors: Neuroglancer's own, as components.
  const histogramIndex = (() => {
    const imageLike = (t: string) => t === "imageInvlerp" || t === "transferFunction";
    const same = (t: string) => (control.type === "propertyInvlerp" ? t === "propertyInvlerp" : imageLike(t));
    let index = 0;
    for (const [other, { control: c }] of all) {
      if (other === name) break;
      if (same(c.type)) index++;
    }
    return index;
  })();
  const state = m.shaderControlState;
  let factory: { makeControl: (layer: never, context: RefCounted, options: never) => { controlElement: HTMLElement } } | undefined;
  if (control.type === "imageInvlerp") {
    factory = channelInvlerpLayerControl(() => ({
      dataType: control.dataType,
      defaultChannel: control.default.channel,
      watchableValue: trackable,
      channelCoordinateSpaceCombiner: state.channelCoordinateSpaceCombiner,
      histogramSpecifications: state.histogramSpecifications,
      histogramIndex,
      legendShaderOptions: m.legendShaderOptions as never,
    })) as never;
  } else if (control.type === "propertyInvlerp") {
    factory = propertyInvlerpLayerControl(() => ({
      properties: control.properties,
      watchableValue: trackable,
      histogramSpecifications: state.histogramSpecifications,
      histogramIndex,
      legendShaderOptions: m.legendShaderOptions as never,
    })) as never;
  } else if (control.type === "transferFunction") {
    factory = transferFunctionLayerControl(() => ({
      dataType: control.dataType,
      watchableValue: trackable,
      channelCoordinateSpaceCombiner: state.channelCoordinateSpaceCombiner,
      defaultChannel: control.default.channel,
      histogramSpecifications: state.histogramSpecifications,
      histogramIndex,
    })) as never;
  }
  if (factory === undefined) return wrap(el("span", { class: "ins-faint" }, `(${control.type})`));
  // Neuroglancer puts the channel picker (multi-channel contrast and
  // transfer functions) or the property picker (property contrast) in the
  // label container: shown beside the control's name.
  const pickers = el("div", { class: "ins-pickers" });
  const { controlElement } = factory.makeControl(layer as never, scope.ng, {
    labelContainer: pickers,
    labelTextContainer: el("div"),
    display: layer.manager.root.display,
    visibility: scope.visibility,
  } as never);
  return el("div", { class: "ins-row ins-wide" }, el("div", { class: "ins-label-with-pickers" }, label, pickers), embed(controlElement, "ins-histogram"));
}
