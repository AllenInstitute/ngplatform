/**
 * The workspace shell: top bar, docks, command palette, and the state loop
 * (URL <-> Neuroglancer state, undo history).  Neuroglancer renders inside
 * `engineHost`; everything else here is the platform's.
 */
import { type Command, CommandRegistry, keyOf } from "../core/commands.js";
import { StateHistory } from "../core/history.js";
import {
  type FragmentParser,
  InputError,
  layerCount,
  parseInput,
  type WorkspaceState,
  workspaceLink,
  encodeFragment,
} from "../core/state_io.js";
import type { ViewerBridge } from "../core/viewer_bridge.js";
import { h, icon, isMac, keyLabel, mark } from "./dom.js";
import { EXAMPLES, type Example } from "./examples.js";
import { closeSheet, copyText, sheetIsOpen, showPalette, showSheet, toast } from "./overlays.js";
import { ActivityLog, renderCursor, renderPlugins, renderSelection, renderWorkspace } from "./panels.js";

const LAYOUTS: [string, string][] = [
  ["4panel", "4 panels"],
  ["xy-3d", "XY + 3D"],
  ["3d", "3D"],
  ["xy", "XY"],
];

/** Per-viewer conveniences only: dock sizes and which docks are open. */
const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`ngplatform.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`ngplatform.${key}`, value);
    } catch {
      // Storage refused (private window, sandbox): the setting just is not kept.
    }
  },
};

/** Inside a frame (such as an artifact viewer), a link cannot carry the state. */
const framed = (() => {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
})();

export class Shell {
  // No id: Neuroglancer's stylesheet sizes #neuroglancer-container for a
  // full-page viewer, which would override the dock layout.
  readonly engineHost = h("div", { class: "engine-host" });
  readonly commands = new CommandRegistry();
  private readonly history = new StateHistory();
  private readonly log = new ActivityLog();
  private bridge!: ViewerBridge;
  private parseFragment!: FragmentParser;
  private app: Record<string, unknown> = {};
  private settleTimer: number | undefined;
  private lastHash = "";

  private readonly root: HTMLElement;
  private readonly workspace = h("div", { class: "workspace" });
  private readonly statusDot = h("span", { class: "dot" });
  private readonly statusText = h("span", {}, "Starting");
  private readonly undoButton = this.toolButton("undo", "Undo", "edit.undo");
  private readonly redoButton = this.toolButton("redo", "Redo", "edit.redo");
  private readonly layoutButtons = new Map<string, HTMLButtonElement>();
  private readonly left = this.dock("left", "Workspace", [["workspace", "Workspace"], ["plugins", "Plugins"]]);
  private readonly right = this.dock("right", "Inspector", [["inspector", "Inspector"]]);
  private readonly bottom = this.dock("bottom", "Activity", [
    ["activity", "Activity"],
    ["jobs", "Jobs"],
    ["python", "Python"],
  ]);
  private readonly selectionBox = h("div");
  private readonly cursorBox = h("div");
  private readonly valuesBox = h("div");

  constructor(root: HTMLElement) {
    this.root = root;
    this.buildLayout();
  }

  // ------------------------------------------------------------- layout

  private toolButton(name: string, label: string, command: string): HTMLButtonElement {
    return h(
      "button",
      { class: "btn icon", type: "button", title: label, "aria-label": label, onclick: () => this.run(command) },
      icon(name),
    );
  }

  private dock(side: "left" | "right" | "bottom", title: string, tabs: [string, string][]) {
    const body = h("div", { class: "dock-body" });
    const panels = new Map<string, HTMLElement>();
    const tabButtons = new Map<string, HTMLButtonElement>();
    const el = h("aside", {
      class: `dock dock-${side}`,
      "aria-label": title,
    });
    const toggle = h(
      "button",
      {
        class: "btn icon",
        type: "button",
        title: `Show or hide the ${title.toLowerCase()} dock`,
        "aria-label": `Toggle ${title.toLowerCase()} dock`,
        onclick: () => this.toggleDock(side),
      },
      icon(side === "left" ? "panel-left" : side === "right" ? "panel-right" : "panel-bottom"),
    );
    const head = h("div", { class: "dock-head", role: "tablist" });
    for (const [id, label] of tabs) {
      const panel = h("div", { role: "tabpanel", "aria-label": label });
      panels.set(id, panel);
      const button = h(
        "button",
        {
          class: "tab",
          type: "button",
          role: "tab",
          id: `tab-${id}`,
          onclick: () => select(id),
        },
        label,
      );
      tabButtons.set(id, button);
      head.append(button);
    }
    const select = (id: string) => {
      for (const [key, button] of tabButtons) button.setAttribute("aria-selected", String(key === id));
      body.replaceChildren(panels.get(id)!);
      prefs.set(`${side}.tab`, id);
    };
    head.append(h("span", { class: "spacer" }), h("span", { class: "rail-title" }, title), toggle);
    if (side === "left") head.prepend(toggle);
    el.append(head, body);
    const remembered = prefs.get(`${side}.tab`);
    select(remembered && panels.has(remembered) ? remembered : tabs[0][0]);
    return { el, panels, select, side };
  }

  private buildLayout(): void {
    const layoutGroup = h("div", { class: "segmented hide-narrow", role: "group", "aria-label": "Layout" });
    for (const [value, label] of LAYOUTS) {
      const button = h(
        "button",
        { type: "button", "aria-pressed": "false", onclick: () => this.run(`view.layout.${value}`) },
        label,
      );
      this.layoutButtons.set(value, button);
      layoutGroup.append(button);
    }
    const topbar = h(
      "header",
      { class: "topbar" },
      h("div", { class: "brand" }, mark(), h("span", { class: "brand-name" }, "ngplatform"), h("span", { class: "chip" }, "preview")),
      h(
        "div",
        { class: "group" },
        h("button", { class: "btn outline", type: "button", onclick: () => this.run("workspace.open") }, icon("open"), "Open"),
        h("button", { class: "btn", type: "button", onclick: () => this.run("workspace.share") }, icon("link"), "Share"),
        h(
          "button",
          { class: "btn hide-narrow", type: "button", onclick: () => this.run("workspace.copyState") },
          icon("copy"),
          "Copy state",
        ),
      ),
      h("span", { class: "sep hide-narrow" }),
      h("div", { class: "group" }, this.undoButton, this.redoButton),
      h("span", { class: "sep hide-narrow" }),
      layoutGroup,
      h("span", { class: "spacer" }),
      h("div", { class: "status", role: "status" }, this.statusDot, this.statusText),
      h(
        "button",
        { class: "palette-trigger", type: "button", onclick: () => this.run("help.palette"), "aria-label": "Search commands" },
        icon("search"),
        h("span", { class: "grow" }, "Search commands"),
        h("kbd", {}, keyLabel("Mod+K")),
      ),
    );

    const engine = h("section", { class: "engine", "aria-label": "Viewer" }, this.engineHost);
    const leftResizer = h("div", { class: "resizer", role: "separator", "aria-orientation": "vertical" });
    const rightResizer = h("div", { class: "resizer", role: "separator", "aria-orientation": "vertical" });
    this.workspace.append(this.left.el, leftResizer, engine, rightResizer, this.right.el);
    this.bindResizer(leftResizer, "left");
    this.bindResizer(rightResizer, "right");

    this.right.panels.get("inspector")!.append(
      h("div", { class: "section" }, h("h3", { class: "section-title" }, "Selected layer"), this.selectionBox),
      h("div", { class: "section" }, h("h3", { class: "section-title" }, "Pointer"), this.cursorBox),
      h("div", { class: "section" }, h("h3", { class: "section-title" }, "Under the pointer"), this.valuesBox),
    );
    renderPlugins(this.left.panels.get("plugins")!);
    this.bottom.panels.get("activity")!.append(this.log.element);
    this.bottom.panels
      .get("jobs")!
      .append(
        h(
          "p",
          { class: "empty" },
          "No jobs running. Filters, statistics and Python scripts will queue here, with progress and a cancel button, once the compute runtime lands.",
        ),
      );
    this.bottom.panels
      .get("python")!
      .append(
        h(
          "p",
          { class: "empty" },
          "A Python console (Pyodide, in a worker) will run here, with the workspace exposed as ",
          h("code", {}, "platform"),
          ". Not in this preview.",
        ),
      );

    this.root.append(topbar, this.workspace, this.bottom.el);
    const narrow = window.matchMedia("(max-width: 760px)");
    for (const side of ["left", "right", "bottom"] as const) {
      const size = prefs.get(`${side}.size`);
      if (size) this.root.style.setProperty(`--${side}`, size);
      if (prefs.get(`${side}.collapsed`) === "1" || (narrow.matches && side !== "bottom")) {
        this.setCollapsed(side, true, false);
      }
    }
    // Side docks start closed on a narrow screen, and close when one gets narrow.
    narrow.addEventListener("change", () => {
      if (narrow.matches) {
        this.setCollapsed("left", true, false);
        this.setCollapsed("right", true, false);
      }
    });
  }

  private dockFor(side: "left" | "right" | "bottom") {
    return side === "left" ? this.left : side === "right" ? this.right : this.bottom;
  }

  private setCollapsed(side: "left" | "right" | "bottom", collapsed: boolean, remember = true): void {
    const dock = this.dockFor(side);
    dock.el.classList.toggle("collapsed", collapsed);
    if (side !== "bottom") {
      const resizer = side === "left" ? this.workspace.children[1] : this.workspace.children[3];
      resizer?.classList.toggle("hidden", collapsed);
      const narrow = window.matchMedia("(max-width: 760px)").matches;
      const open = prefs.get(`${side}.size`) || (side === "left" ? "280px" : "300px");
      this.root.style.setProperty(`--${side}`, collapsed || narrow ? "34px" : open);
    }
    if (remember) prefs.set(`${side}.collapsed`, collapsed ? "1" : "0");
  }

  private toggleDock(side: "left" | "right" | "bottom"): void {
    this.setCollapsed(side, !this.dockFor(side).el.classList.contains("collapsed"));
  }

  private bindResizer(resizer: HTMLElement, side: "left" | "right"): void {
    resizer.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      resizer.setPointerCapture(down.pointerId);
      resizer.classList.add("dragging");
      const startX = down.clientX;
      const startWidth = this.dockFor(side).el.getBoundingClientRect().width;
      const move = (e: PointerEvent) => {
        const delta = side === "left" ? e.clientX - startX : startX - e.clientX;
        const width = Math.max(200, Math.min(window.innerWidth * 0.45, startWidth + delta));
        this.root.style.setProperty(`--${side}`, `${Math.round(width)}px`);
      };
      const up = () => {
        resizer.classList.remove("dragging");
        resizer.removeEventListener("pointermove", move);
        resizer.removeEventListener("pointerup", up);
        prefs.set(`${side}.size`, this.root.style.getPropertyValue(`--${side}`));
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", up);
    });
  }

  // ------------------------------------------------------------ wiring

  attach(bridge: ViewerBridge, parseFragment: FragmentParser, defaultExample: string): void {
    this.bridge = bridge;
    this.parseFragment = parseFragment;
    this.registerCommands();

    const refreshLayers = () => {
      renderWorkspace(this.left.panels.get("workspace")!, bridge);
      renderSelection(this.selectionBox, bridge);
      this.updateStatus();
    };
    bridge.onLayersChanged(refreshLayers);
    bridge.onSelectionChanged(refreshLayers);
    bridge.onCursorChanged(() => renderCursor(this.cursorBox, this.valuesBox, bridge.cursor()));
    renderCursor(this.cursorBox, this.valuesBox, bridge.cursor());
    bridge.onStateChanged(() => this.scheduleSettle());
    this.commands.onChange(() => this.updateControls());

    window.addEventListener("keydown", (e) => this.onKey(e), true);
    window.addEventListener("hashchange", () => {
      if (location.hash !== this.lastHash && location.hash.startsWith("#!")) {
        void this.openText(location.href, "the address bar");
      }
    });

    refreshLayers();
    if (location.hash.startsWith("#!")) {
      void this.openText(location.href, "the link");
    } else {
      this.openExample(EXAMPLES.find((e) => e.id === defaultExample) ?? EXAMPLES[0]);
    }
    this.log.add(
      framed
        ? "Running inside a frame: Share copies the workspace as JSON, since links here cannot carry it."
        : "Ready. The address bar always holds a link to the current workspace.",
    );
  }

  private serialize(): string {
    return JSON.stringify({ ng: this.bridge.getState(), app: this.app });
  }

  private scheduleSettle(): void {
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.settle(), 400);
  }

  /** Records a settled state: one undo step, and the address bar updated. */
  private settle(): void {
    window.clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    const snapshot = this.serialize();
    this.history.record(snapshot);
    if (!framed) {
      const ng = this.bridge.getState();
      const body = Object.keys(this.app).length ? { ng, app: this.app } : { ng };
      const hash = "#!" + encodeFragment(JSON.stringify(body));
      if (hash !== this.lastHash) {
        this.lastHash = hash;
        try {
          history.replaceState(null, "", hash);
        } catch {
          // A host that forbids it keeps the old address; Share still works.
        }
      }
    }
    this.commands.notify();
    this.updateStatus();
  }

  private apply(state: WorkspaceState): void {
    this.app = state.app;
    this.bridge.setState(state.ng);
  }

  private open(state: WorkspaceState, from: string): void {
    this.apply(state);
    this.settle();
    const n = layerCount(state.ng);
    this.log.add(`Opened ${n} layer${n === 1 ? "" : "s"} from ${from}.`, "ok");
  }

  private openExample(example: Example): void {
    this.open(example.state(), `the example “${example.title}”`);
  }

  /** Opens whatever was pasted or linked; returns whether it worked. */
  async openText(text: string, from: string): Promise<boolean> {
    try {
      const parsed = parseInput(text, this.parseFragment);
      if (parsed.kind === "state") {
        this.open(parsed.state, from);
      } else if (parsed.kind === "remote") {
        this.setStatus("busy", "Fetching state");
        const response = await fetch(parsed.url);
        if (!response.ok) throw new InputError(`${parsed.url} answered ${response.status} ${response.statusText}.`);
        const json = await response.json();
        const again = parseInput(JSON.stringify(json), this.parseFragment);
        if (again.kind !== "state") throw new InputError("That URL did not hold a state.");
        this.open(again.state, parsed.url);
      } else {
        this.bridge.addLayer({ name: parsed.name, source: parsed.url });
        this.settle();
        this.log.add(`Added layer “${parsed.name}” from ${parsed.url}.`, "ok");
      }
      return true;
    } catch (e) {
      const message = e instanceof InputError ? e.message : `Could not open that: ${(e as Error).message}`;
      this.log.add(message, "error");
      toast(message, "error");
      this.updateStatus();
      return false;
    }
  }

  private restore(snapshot: string | undefined, verb: string): void {
    if (snapshot === undefined) return;
    window.clearTimeout(this.settleTimer);
    this.apply(JSON.parse(snapshot) as WorkspaceState);
    this.settle();
    this.log.add(verb);
  }

  // ---------------------------------------------------------- commands

  private run(id: string): void {
    void this.commands.invoke(id).catch((e) => {
      this.log.add(`${id} failed: ${(e as Error).message}`, "error");
      toast((e as Error).message, "error");
    });
  }

  private registerCommands(): void {
    const c = this.commands;
    const add = (command: Command) => c.register(command);
    add({
      id: "help.palette",
      title: "Show all commands",
      group: "Help",
      keys: "Mod+K",
      run: () => showPalette(() => c.list(), (command) => this.run(command.id)),
    });
    add({
      id: "workspace.open",
      title: "Open a link, state or data URL…",
      group: "Workspace",
      keys: "Mod+O",
      hint: "Neuroglancer links, state JSON, remote state URLs, or a data source to add as a layer",
      run: () => this.showOpen(),
    });
    add({
      id: "workspace.share",
      title: "Copy a link to this workspace",
      group: "Workspace",
      hint: framed ? "Copies the workspace as JSON here, since this frame's links cannot carry it" : undefined,
      run: async () => {
        this.settle();
        if (framed) {
          if (await copyText(this.serialize(), "the workspace")) toast("Copied the workspace as JSON. Paste it into Open to restore it.");
          return;
        }
        const link = workspaceLink(location.href, JSON.parse(this.serialize()));
        if (await copyText(link, "the link")) toast(`Link copied (${(link.length / 1024).toFixed(1)} KB).`);
        this.log.add("Copied a link to the workspace.");
      },
    });
    add({
      id: "workspace.copyState",
      title: "Copy the Neuroglancer state",
      group: "Workspace",
      hint: "Plain Neuroglancer JSON: paste it into any Neuroglancer's Edit JSON state dialog",
      run: async () => {
        const json = JSON.stringify(this.bridge.getState(), null, 2);
        if (await copyText(json, "the state")) toast("Neuroglancer state copied.");
        this.log.add("Copied the Neuroglancer state.");
      },
    });
    for (const example of EXAMPLES) {
      add({
        id: `workspace.example.${example.id}`,
        title: `Open example: ${example.title}`,
        group: "Examples",
        hint: example.description,
        run: () => this.openExample(example),
      });
    }
    add({
      id: "edit.undo",
      title: "Undo",
      group: "Edit",
      keys: "Mod+Z",
      isAvailable: () => this.history.canUndo,
      run: () => {
        this.settle();
        this.restore(this.history.undo(), "Undid the last change.");
      },
    });
    add({
      id: "edit.redo",
      title: "Redo",
      group: "Edit",
      keys: "Mod+Shift+Z",
      isAvailable: () => this.history.canRedo,
      run: () => this.restore(this.history.redo(), "Redid the change."),
    });
    for (const [value, label] of LAYOUTS) {
      add({
        id: `view.layout.${value}`,
        title: `Layout: ${label}`,
        group: "View",
        run: () => {
          this.bridge.setLayout(value);
          this.updateControls();
        },
      });
    }
    add({ id: "view.dock.left", title: "Show or hide the workspace dock", group: "View", run: () => this.toggleDock("left") });
    add({ id: "view.dock.right", title: "Show or hide the inspector", group: "View", run: () => this.toggleDock("right") });
    add({ id: "view.dock.bottom", title: "Show or hide the activity dock", group: "View", run: () => this.toggleDock("bottom") });
  }

  private onKey(e: KeyboardEvent): void {
    const key = keyOf(e, isMac());
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const bindings: Record<string, string> = {
      "mod+k": "help.palette",
      "mod+o": "workspace.open",
    };
    if (!typing) {
      bindings["mod+z"] = "edit.undo";
      bindings["mod+shift+z"] = "edit.redo";
      bindings["mod+y"] = "edit.redo";
    }
    const id = bindings[key];
    if (id === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (sheetIsOpen() && id === "help.palette") {
      closeSheet();
      return;
    }
    this.run(id);
  }

  // ------------------------------------------------------------ dialogs

  private showOpen(): void {
    const input = h("textarea", {
      class: "state-input",
      id: "open-input",
      placeholder: "https://…/#!{…}   or   {\"layers\": …}   or   gs://bucket/store.zarrvectors/|zarr-vectors:",
      "aria-label": "Link, state or data URL",
      spellcheck: "false",
    });
    const detected = h("span", { class: "detected" }, "Paste something to open.");
    const openButton = h("button", { class: "btn primary", type: "button", disabled: true }, "Open");
    const describe = () => {
      if (input.value.trim() === "") {
        detected.textContent = "Paste something to open.";
        detected.classList.remove("bad");
        openButton.disabled = true;
        return;
      }
      try {
        const parsed = parseInput(input.value, this.parseFragment);
        detected.classList.remove("bad");
        openButton.disabled = false;
        if (parsed.kind === "state") {
          const n = layerCount(parsed.state.ng);
          detected.textContent = `Neuroglancer state, ${n} layer${n === 1 ? "" : "s"}${Object.keys(parsed.state.app).length ? ", with app state" : ""}. Replaces the workspace.`;
          openButton.textContent = "Open";
        } else if (parsed.kind === "remote") {
          detected.textContent = "A state stored at a URL. It will be fetched and opened.";
          openButton.textContent = "Fetch and open";
        } else {
          detected.textContent = `A data source. Adds the layer “${parsed.name}”.`;
          openButton.textContent = "Add layer";
        }
      } catch (e) {
        detected.textContent = (e as Error).message;
        detected.classList.add("bad");
        openButton.disabled = true;
      }
    };
    input.addEventListener("input", describe);
    const submit = async () => {
      if (openButton.disabled) return;
      if (await this.openText(input.value, "pasted text")) closeSheet();
    };
    openButton.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    });
    const examples = h(
      "div",
      { class: "examples" },
      ...EXAMPLES.map((example) =>
        h(
          "div",
          { class: "example" },
          h("span", { class: "title" }, example.title),
          h(
            "span",
            { class: "desc" },
            example.description + (example.remote && framed ? " Needs a hosted copy of the app: this frame only reaches files bundled with it." : ""),
          ),
          h(
            "button",
            {
              class: "btn outline",
              type: "button",
              disabled: example.remote && framed,
              onclick: () => {
                closeSheet();
                this.openExample(example);
              },
            },
            "Open",
          ),
        ),
      ),
    );
    const sheet = h(
      "div",
      { class: "sheet", role: "dialog", "aria-label": "Open" },
      h("div", { class: "sheet-head" }, h("h2", { class: "sheet-title" }, "Open")),
      h(
        "div",
        { class: "sheet-body" },
        input,
        h("h3", { class: "section-title" }, "Examples"),
        examples,
      ),
      h("div", { class: "sheet-foot" }, detected, h("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"), openButton),
    );
    showSheet(sheet);
    input.focus();
  }

  // ------------------------------------------------------------- status

  private setStatus(kind: "ok" | "busy" | "err" | "idle", text: string): void {
    this.statusDot.className = kind === "idle" ? "dot" : `dot ${kind}`;
    this.statusText.textContent = text;
  }

  private updateStatus(): void {
    if (this.bridge === undefined) return;
    const layers = this.bridge.layers();
    if (layers.length === 0) {
      this.setStatus("idle", "No layers");
      return;
    }
    const loading = layers.filter((l) => !l.ready).length;
    if (loading > 0) this.setStatus("busy", `Loading ${loading} of ${layers.length} layer${layers.length === 1 ? "" : "s"}`);
    else this.setStatus("ok", `${layers.length} layer${layers.length === 1 ? "" : "s"} ready`);
  }

  private updateControls(): void {
    this.undoButton.disabled = !this.commands.available("edit.undo");
    this.redoButton.disabled = !this.commands.available("edit.redo");
    const current = this.bridge?.layout();
    for (const [value, button] of this.layoutButtons) button.setAttribute("aria-pressed", String(value === current));
  }
}
