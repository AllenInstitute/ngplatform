/**
 * The shell: lays out the top bar, the docks and the engine, creates the
 * platform's services and wires them together.  It holds no workspace state
 * itself (that is the WorkspaceStore's) and no panel logic (that is in
 * ui/panels); what remains here is composition and the core commands.
 */
import { CommandError, CommandRegistry } from "../core/commands.js";
import { KeybindingTable } from "../core/keybindings.js";
import { InputError, layerNameFor, neuroglancerLink, parseInput, type FragmentParser, workspaceLink } from "../core/state_io.js";
import { ContextKeys } from "../core/when.js";
import { activeScene, layersOf } from "../core/workspace.js";
import { type Engine, LAYOUTS } from "../engine/engine.js";
import { AuthRegistry, browserAuthEnvironment, middleauthProvider } from "../platform/auth.js";
import { JobService } from "../platform/jobs.js";
import { LocalData } from "../platform/local_data.js";
import { LocalPlugins } from "../platform/local_plugins.js";
import { PluginHost } from "../platform/plugin_host.js";
import { ExampleRegistry, OpenHandlerRegistry } from "../platform/registries.js";
import { ServiceRegistry } from "../platform/services.js";
import { WorkspaceStore } from "../platform/workspace_store.js";
import { type Choices, type Resolution, saveChoices, toggle as togglePlugin } from "../platform/plugin_switches.js";
import type { CatalogueEntry } from "../../plugins/index.js";
import { registerBuiltins } from "../builtins/index.js";
import { contextKeyFor } from "./context.js";
import { type DockTab, DockManager, prefs } from "./docks.js";
import { h, icon, iconButton, isMac, keyLabel, mark } from "./dom.js";
import { closeSheet, confirmDialog, copyText, formDialog, promptDialog, sheetIsOpen, showMenu, showPalette, toast } from "./overlays.js";
import { ActivityLog } from "./panels/activity.js";
import { renderAuthPanel } from "./panels/auth.js";
import { renderDatasetsPanel, showAddMenu } from "./panels/datasets.js";
import { forgetPython, renderPythonPanel, runPythonPlugin } from "./panels/python.js";
import { layerTarget, renderLayerPanel } from "./panels/layer.js";
import {
  renderJobsPanel,
  renderPluginsPanel,
  renderStatisticsPanel,
} from "./panels/misc.js";
import { showAddDatasetSheet, showEditStateSheet, showLocalSheet, showOpenSheet, showSettingsSheet, showShortcutsSheet } from "./sheets.js";
import type { Workbench } from "./workbench.js";
import { createPlatformApis } from "./apis.js";

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
  // full-page viewer, which would override the layout.
  readonly engineHost = h("div", { class: "engine-host" });
  private readonly root: HTMLElement;
  private readonly context = new ContextKeys();
  private readonly docks: DockManager;
  private readonly statusDot = h("span", { class: "dot" });
  private readonly statusText = h("span", {}, "Starting");
  private readonly statusStrip = h("div", { class: "ng-status", "aria-live": "polite" });
  private readonly sceneTabs = h("div", { class: "scene-tabs", role: "tablist", "aria-label": "Scenes" });
  private readonly undoButton = iconButton("undo", "Undo", () => this.wb.run("edit.undo"));
  private readonly redoButton = iconButton("redo", "Redo", () => this.wb.run("edit.redo"));
  private wb!: Workbench;
  /** A plugin's view beside Neuroglancer's, and the divider between them. */
  private readonly viewArea = h("div", { class: "engine-view", hidden: true });
  private readonly viewSplit = h("div", { class: "engine-split", hidden: true, role: "separator", "aria-orientation": "vertical", title: "Drag to resize" });
  private view: { owner: string; dispose: () => void } | undefined;
  private auth: AuthRegistry | undefined;
  private localPlugins: LocalPlugins | undefined;
  private lastHashSeen = "";

  constructor(root: HTMLElement) {
    this.root = root;
    this.docks = new DockManager(root, this.context);
    this.buildLayout();
  }

  // ------------------------------------------------------------- layout

  private buildLayout(): void {
    const topbar = h(
      "header",
      { class: "topbar" },
      h("div", { class: "brand" }, mark(), h("span", { class: "brand-name" }, "ngplatform")),
      h(
        "div",
        { class: "group" },
        h("button", { class: "btn outline", type: "button", onclick: () => this.wb.run("workspace.open") }, icon("open"), "Open"),
        h(
          "button",
          { class: "btn outline", type: "button", "aria-haspopup": "menu", onclick: (e: Event) => showAddMenu(e.currentTarget as HTMLElement, this.wb) },
          icon("plus"),
          h("span", { class: "hide-narrow" }, "Add"),
        ),
        h(
          "button",
          { class: "btn", type: "button", "aria-haspopup": "menu", onclick: (e: Event) => this.showShareMenu(e.currentTarget as HTMLElement) },
          icon("link"),
          h("span", { class: "hide-narrow" }, "Share"),
        ),
        h(
          "button",
          { class: "btn hide-phone", type: "button", title: "Open this scene in Neuroglancer, in a new tab", onclick: () => this.wb.run("workspace.openInNeuroglancer") },
          icon("external"),
          h("span", { class: "hide-narrow" }, "Neuroglancer"),
        ),
      ),
      h("span", { class: "sep hide-narrow" }),
      h("div", { class: "group hide-phone" }, this.undoButton, this.redoButton),
      h("span", { class: "sep hide-narrow" }),
      this.sceneTabs,
      h("span", { class: "spacer" }),
      h("div", { class: "status", role: "status" }, this.statusDot, this.statusText),
      h(
        "div",
        { class: "group" },
        iconButton("camera", "Screenshot", () => this.wb.run("view.screenshot")),
        iconButton("settings", "Settings and reloading", (e) =>
          showMenu(e.currentTarget as HTMLElement, [
            { label: "View settings…", run: () => this.wb.run("view.settings") },
            "-",
            { label: "Reload the scene's layers", run: () => this.wb.run("view.reloadLayers") },
            { label: "Hard reset: reload everything fresh", run: () => this.wb.run("view.hardReset") },
          ]),
        ),
        iconButton("keyboard", "Keyboard and mouse", () => this.wb.run("help.shortcuts"), { class: "btn icon hide-narrow" }),
      ),
      h(
        "button",
        { class: "palette-trigger", type: "button", onclick: () => this.wb.run("help.palette"), "aria-label": "Search commands" },
        icon("search"),
        h("span", { class: "grow" }, "Commands"),
        h("kbd", {}, keyLabel("Mod+K")),
      ),
    );
    const engine = h("section", { class: "engine", "aria-label": "Viewer" }, this.engineHost, this.viewSplit, this.viewArea);
    this.viewSplit.addEventListener("pointerdown", (e) => this.dragViewSplit(e, engine));
    const centre = h("div", { class: "centre" }, engine, this.statusStrip);
    const workspace = h(
      "div",
      { class: "workspace" },
      this.docks.element("left"),
      this.docks.resizer("left"),
      centre,
      this.docks.resizer("right"),
      this.docks.element("right"),
    );
    this.root.append(topbar, workspace, this.docks.resizer("bottom"), this.docks.element("bottom"));
    const narrow = window.matchMedia("(max-width: 520px)");
    this.docks.restore(narrow.matches);
    narrow.addEventListener("change", () => {
      if (narrow.matches) {
        this.docks.setCollapsed("left", true, false);
        this.docks.setCollapsed("right", true, false);
      }
    });
  }

  // ------------------------------------------------------------ wiring

  attach(
    engine: Engine,
    parseFragment: FragmentParser,
    defaultExample: string,
    plugins: { catalogue: CatalogueEntry[]; choices: Choices; resolution: Resolution },
  ): void {
    const log = new ActivityLog();
    const commands = new CommandRegistry();
    commands.useContext(this.context);
    const keybindings = new KeybindingTable();
    const examples = new ExampleRegistry();
    const openHandlers = new OpenHandlerRegistry();
    const jobs = new JobService();
    const services = new ServiceRegistry();
    const auth = new AuthRegistry(localStorage);
    auth.register(middleauthProvider(browserAuthEnvironment()), "platform");
    this.auth = auth;
    const store = new WorkspaceStore(engine, {
      framed,
      log: (message, level) => log.add(message, level),
    });
    const wb: Workbench = {
      engine,
      store,
      commands,
      keybindings,
      context: this.context,
      docks: this.docks,
      examples,
      openHandlers,
      jobs,
      services,
      plugins: undefined as unknown as PluginHost,
      pluginSwitches: {
        manifests: plugins.catalogue.map((e) => e.manifest),
        enabled: plugins.resolution.enabled,
        blocked: plugins.resolution.blocked,
        toggle: (id, on) => this.switchPlugin(plugins.catalogue, plugins.choices, id, on),
      },
      log,
      localData: new LocalData(),
      parseFragment,
      framed,
      run: (id, args) => {
        void commands.invoke(id, args).catch((e) => {
          const message = e instanceof CommandError ? e.message : `${id} failed: ${(e as Error).message}`;
          log.add(message, "error");
          toast((e as Error).message, "error");
        });
      },
    };
    this.wb = wb;
    // For debugging from the console, beside window.viewer.
    (window as unknown as { workbench: Workbench }).workbench = wb;
    const apis = createPlatformApis(wb);
    wb.plugins = new PluginHost({
      commands,
      keybindings,
      context: this.context,
      docks: { addTab: (tab) => this.docks.addTab(tab), show: (id) => this.docks.show(id) },
      views: { mount: (render, owner) => this.mountView(render, owner) },
      examples,
      open: openHandlers,
      ui: {
        toast,
        confirm: (message) => confirmDialog(message),
        viewToggle: (spec) => engine.viewToggle(spec),
        overlay: () => engine.addOverlay(),
        screenshotOverlay: (paint) => engine.addScreenshotOverlay(paint),
        form: (title, schema, initial) => formDialog(title, schema, initial),
      },
      workspace: apis.workspace,
      viewer: apis.viewer,
      slices: {
        get: (key) => store.rawSlice(key),
        set: (key, version, value) => store.setRawSlice(key, version, value),
        onChanged: (callback) => store.onSliceChanged(callback),
      },
      settings: {
        get: (key) => {
          const raw = prefs.get(key);
          if (raw === null) return undefined;
          try {
            return JSON.parse(raw);
          } catch {
            return undefined;
          }
        },
        set: (key, value) => prefs.set(key, JSON.stringify(value)),
      },
      jobs,
      services,
      auth,
      log: (message, level, source) => log.add(message, level, source),
    });

    this.registerPanels();
    this.registerCommands();
    this.registerKeys();
    registerBuiltins(wb);
    this.localPlugins = new LocalPlugins({
      host: wb.plugins,
      runPython: (owner, source) => runPythonPlugin(wb, owner, source),
      forgetPython,
      log: (message, level) => log.add(message, level ?? "info"),
    });
    void this.localPlugins.restore();
    // Local data opened on earlier visits: the workspace's links to it work
    // once reading is allowed again.
    for (const entry of plugins.catalogue) {
      if (entry.virtualFormats !== undefined && plugins.resolution.enabled.has(entry.manifest.id)) wb.localData.addFormats(entry.virtualFormats());
    }
    void wb.localData.restore();
    for (const entry of plugins.catalogue) {
      const enabled = plugins.resolution.enabled.has(entry.manifest.id);
      // A data type plugin has no platform code: it was loaded with the viewer.
      const load = entry.load ?? (async () => ({ activate() {} }));
      wb.plugins.register(entry.manifest, load, { builtin: true, enabled });
      if (enabled && entry.manifest.kind === "datatype") void wb.plugins.activate(entry.manifest.id).catch(() => {});
    }

    // Neuroglancer's own status messages (loading, errors) go below the views.
    engine.routeStatusMessages(this.statusStrip, (text, error) => {
      if (error) log.add(text, "error", "Neuroglancer");
    });

    const refresh = () => {
      this.updateContext();
      this.updateStatus();
      this.renderSceneTabs();
      this.updateControls();
    };
    store.onChange(refresh);
    // A plugin with state in the workspace (a filter in a shared link, say)
    // is loaded as the workspace opens, so its effect shows without opening
    // its tab.
    const withState = () => {
      for (const entry of plugins.catalogue) {
        const key = entry.manifest.contributes?.appState?.key;
        if (key === undefined || store.rawSlice(key) === undefined) continue;
        const record = wb.plugins.list().find((r) => r.manifest.id === entry.manifest.id);
        if (record?.status === "registered") void wb.plugins.activate(entry.manifest.id).catch(() => {});
      }
    };
    store.onChange(withState);
    engine.onLayersChanged(refresh);
    engine.onSelectionChanged(refresh);
    commands.onChange(() => this.updateControls());
    jobs.onChange(() => this.updateStatus());

    window.addEventListener("keydown", (e) => this.onKey(e), true);
    window.addEventListener("hashchange", () => {
      if (location.hash !== store.currentHash && location.hash !== this.lastHashSeen && location.hash.startsWith("#!")) {
        this.lastHashSeen = location.hash;
        void this.openText(location.href, "the address bar", false);
      }
    });

    if (location.hash.startsWith("#!")) {
      void this.openText(location.href, "the link", false);
    } else {
      const example = examples.get(defaultExample) ?? examples.list()[0];
      if (example !== undefined) store.open(example.state(), `the example “${example.title}”`);
      else store.settle();
    }
    refresh();
    setTimeout(() => this.checkFormats(), 1500);
    log.add(
      framed
        ? "Running inside a frame: Share copies the workspace as JSON, since links here cannot carry it."
        : "Ready. The address bar always holds a link to the current workspace.",
    );
  }

  private registerPanels(): void {
    const wb = this.wb;
    const add = (tab: DockTab) => this.docks.addTab(tab);
    add({ id: "datasets", title: "Datasets", slot: "left", order: 10, render: (host) => renderDatasetsPanel(host, wb) });
    add({ id: "auth", title: "Auth", slot: "left", order: 80, render: (host) => renderAuthPanel(host, wb, this.auth!) });
    add({ id: "plugins", title: "Plugins", slot: "left", order: 90, render: (host) => renderPluginsPanel(host, wb, this.localPlugins!) });
    add({ id: "layer", title: "Layer", slot: "right", order: 10, render: (host) => renderLayerPanel(host, wb) });
    add({
      id: "activity",
      title: "Activity",
      slot: "bottom",
      order: 10,
      render: (host) => {
        host.append(wb.log.element);
      },
    });
    add({ id: "jobs", title: "Jobs", slot: "bottom", order: 20, render: (host) => renderJobsPanel(host, wb) });
    add({ id: "statistics", title: "Chunk statistics", slot: "bottom", order: 30, transient: true, render: (host) => renderStatisticsPanel(host, wb) });
    add({ id: "python", title: "Python", slot: "bottom", order: 40, render: (host) => renderPythonPanel(host, wb) });
  }

  // ---------------------------------------------------------- commands

  private registerCommands(): void {
    const wb = this.wb;
    const { store, engine, commands: c } = wb;
    const add = c.register.bind(c);

    add({
      id: "help.palette",
      title: "Show all commands",
      group: "Help",
      run: () =>
        showPalette(
          () => c.list(),
          (command) => c.available(command.id),
          (command) => command.keys ?? wb.keybindings.keyFor(command.id),
          (command) => wb.run(command.id),
        ),
    });
    add({ id: "help.shortcuts", title: "Keyboard and mouse reference", group: "Help", run: () => showShortcutsSheet(wb) });

    // Workspace
    add({
      id: "workspace.open",
      title: "Open a link, state or data URL…",
      group: "Workspace",
      hint: "Neuroglancer links, state JSON, remote state URLs, or a data source to add as a dataset",
      run: () =>
        showOpenSheet(wb, {
          openText: (t, f, s) => this.openText(t, f, s),
          openExample: (id) => this.openExample(id),
          openBlank: () => store.newScene({ name: "Blank" }),
        }),
    });
    add({
      id: "workspace.share",
      title: "Copy a link to this workspace",
      group: "Workspace",
      hint: framed ? "Copies the workspace as JSON here, since this frame's links cannot carry it" : undefined,
      run: async () => {
        store.settle();
        if (framed) {
          if (await copyText(store.serialize(), "the workspace")) toast("Copied the workspace as JSON. Paste it into Open to restore it.");
          return;
        }
        const link = workspaceLink(location.href, store.workspace());
        if (await copyText(link, "the link")) toast(`Link copied (${(link.length / 1024).toFixed(1)} KB).`);
        wb.log.add("Copied a link to the workspace.");
      },
    });
    add({
      id: "workspace.copyState",
      title: "Copy this scene as a Neuroglancer state",
      group: "Workspace",
      hint: "Plain Neuroglancer JSON for any Neuroglancer",
      run: async () => {
        if (await copyText(JSON.stringify(store.ng(), null, 2), "the state")) toast("Neuroglancer state copied.");
      },
    });
    add({
      id: "workspace.copyPlainLink",
      title: "Copy this scene as a Neuroglancer link",
      group: "Workspace",
      hint: "For Neuroglancer itself, without this app",
      run: async () => {
        const { url, viewer } = neuroglancerLink(store.ng(), this.pluginFormatsIn(), location.href);
        if (await copyText(url, "the link")) toast(`Neuroglancer link copied (${viewer}).`);
      },
    });
    add({
      id: "workspace.openInNeuroglancer",
      title: "Open this scene in Neuroglancer",
      group: "Workspace",
      hint: "Google's Neuroglancer, in a new tab, without this app",
      run: () => {
        const { url } = neuroglancerLink(store.ng(), [], location.href);
        window.open(url, "_blank", "noopener");
        const missing = [
          ...this.pluginFormatsIn().map((f) => (f === "zarr-vectors" ? "Zarr Vectors" : f)),
          ...(this.usesLocalData() ? ["data on this computer"] : []),
        ];
        if (missing.length) toast(`Neuroglancer doesn't read ${missing.join(" or ")}, so only the other layers (images) are likely to show there.`);
        wb.log.add("Opened this scene in Neuroglancer.");
      },
    });
    add({
      id: "workspace.openInPlainNeuroglancer",
      title: "Open this scene in this site's Neuroglancer",
      group: "Workspace",
      hint: "Neuroglancer with this site's data type plugins (Zarr Vectors), in a new tab",
      run: () => {
        const { url } = neuroglancerLink(store.ng(), ["plugins"], location.href);
        window.open(url, "_blank", "noopener");
      },
    });
    add({
      id: "workspace.editState",
      title: "Edit the workspace state as JSON…",
      group: "Workspace",
      run: () => showEditStateSheet(wb, (text) => this.openText(text, "the state editor", false)),
    });
    add({
      id: "workspace.example",
      title: "Open an example",
      group: "Examples",
      args: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      run: ({ id }: { id: string }) => this.openExample(id),
    });
    wb.examples.onChange(() => this.registerExampleCommands());
    this.registerExampleCommands();

    // Edit
    add({ id: "edit.undo", title: "Undo", group: "Edit", when: "canUndo", run: () => store.undo() });
    add({ id: "edit.redo", title: "Redo", group: "Edit", when: "canRedo", run: () => store.redo() });

    // Scenes
    add({
      id: "scene.new",
      title: "New empty scene",
      group: "Scenes",
      hint: "Keeps the coordinate space and layout; add datasets to it",
      args: { type: "object", properties: { name: { type: "string" } } },
      run: ({ name }: { name?: string }) => store.newScene({ name }),
    });
    add({
      id: "scene.duplicate",
      title: "Duplicate this scene",
      group: "Scenes",
      args: { type: "object", properties: { name: { type: "string" } } },
      run: ({ name }: { name?: string }) => store.newScene({ copy: true, name }),
    });
    add({
      id: "scene.switch",
      title: "Switch to a scene",
      group: "Scenes",
      args: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      run: ({ id }: { id: string }) => store.switchScene(id),
    });
    const step = (delta: number) => {
      const p = store.state();
      const i = p.scenes.findIndex((s) => s.id === p.activeScene);
      const next = p.scenes[(i + delta + p.scenes.length) % p.scenes.length];
      store.switchScene(next.id);
    };
    add({ id: "scene.next", title: "Next scene", group: "Scenes", when: "sceneCount != 1", run: () => step(1) });
    add({ id: "scene.previous", title: "Previous scene", group: "Scenes", when: "sceneCount != 1", run: () => step(-1) });
    add({
      id: "scene.rename",
      title: "Rename this scene…",
      group: "Scenes",
      args: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      run: async ({ id, name }: { id?: string; name?: string }) => {
        const scene = store.state().scenes.find((s) => s.id === (id ?? store.state().activeScene));
        if (scene === undefined) return;
        const value = name ?? (await promptDialog("Rename scene", "Name", scene.name));
        if (value !== undefined) store.renameScene(scene.id, value);
      },
    });
    add({
      id: "scene.delete",
      title: "Delete this scene…",
      group: "Scenes",
      when: "sceneCount != 1",
      args: { type: "object", properties: { id: { type: "string" }, confirm: { type: "boolean", default: true } } },
      run: async ({ id, confirm }: { id?: string; confirm: boolean }) => {
        const scene = store.state().scenes.find((s) => s.id === (id ?? store.state().activeScene));
        if (scene === undefined) return;
        if (confirm && !(await confirmDialog(`Delete the scene “${scene.name}”? Undo brings it back.`, "Delete", true))) return;
        store.deleteScene(scene.id);
      },
    });

    // Datasets
    add({
      id: "dataset.add",
      title: "Add a dataset to this scene…",
      group: "Datasets",
      args: {
        type: "object",
        properties: { source: { type: "string" }, name: { type: "string" }, kind: { type: "string" } },
      },
      run: (args: { source?: string; name?: string; kind?: string }) => {
        if (args.source === undefined) return showAddDatasetSheet(wb);
        return store.addDataset({ source: args.source, name: args.name ?? layerNameFor(args.source), kind: args.kind });
      },
    });
    add({
      id: "view.reloadLayers",
      title: "Reload the scene's layers",
      group: "View",
      hint: "Opens every layer again, from its source",
      run: () => store.reloadLayers(),
    });
    add({
      id: "view.hardReset",
      title: "Hard reset: reload everything fresh",
      group: "View",
      hint: "Reloads the page, checking every file with its server, for data that changed since it was loaded",
      run: () => {
        store.settle();
        try {
          sessionStorage.setItem("ngplatform.revalidate", "1");
        } catch {
          // Storage refused: an ordinary reload.
        }
        location.reload();
      },
    });
    add({
      id: "dataset.addLocal",
      title: "Open data from this computer…",
      group: "Datasets",
      hint: "OME-Zarr, zarr-vectors, precomputed or NIfTI, read in place",
      isAvailable: () => LocalData.supported,
      run: () => showLocalSheet(wb, wb.localData),
    });
    add({
      id: "dataset.reconnectLocal",
      title: "Allow reading local data again",
      group: "Datasets",
      isAvailable: () => wb.localData.list().some((e) => e.needsPermission),
      run: async () => {
        const n = await wb.localData.reconnect();
        if (n > 0) {
          toast(`Reading ${n} local folder${n === 1 ? "" : "s"} again.`);
          store.reloadLayers();
        }
      },
    });
    add({
      id: "dataset.newAnnotations",
      title: "New annotation layer",
      group: "Datasets",
      hint: "An empty layer to draw points, lines, boxes and ellipsoids into",
      run: () => {
        store.newAnnotationLayer();
        wb.docks.show("layer");
      },
    });
    const datasetAt = (index: number) => store.sceneDatasets()[index - 1];
    add({
      id: "dataset.toggle",
      title: "Show or hide a dataset by number",
      group: "Datasets",
      args: { type: "object", required: ["index"], properties: { index: { type: "integer", minimum: 1 } } },
      run: ({ index }: { index: number }) => {
        const entry = datasetAt(index);
        if (entry === undefined) return;
        const visible = engine.layers().some((l) => entry.layers.includes(l.name) && l.visible);
        store.setDatasetVisible(entry.dataset.id, !visible);
      },
    });
    add({
      id: "dataset.select",
      title: "Select a dataset by number",
      group: "Datasets",
      args: { type: "object", required: ["index"], properties: { index: { type: "integer", minimum: 1 } } },
      run: ({ index }: { index: number }) => {
        const entry = datasetAt(index);
        if (entry === undefined) return;
        store.selectDataset(entry.dataset.id);
        this.docks.show("layer");
      },
    });
    const datasetArg = { type: "object" as const, properties: { id: { type: "string" as const } } };
    const selectedDatasetId = (id?: string) => id ?? layerTarget(wb).dataset?.id;
    add({
      id: "dataset.remove",
      title: "Remove the selected dataset from this scene",
      group: "Datasets",
      when: "selectedLayer",
      args: datasetArg,
      run: ({ id }: { id?: string }) => {
        const target = selectedDatasetId(id);
        if (target !== undefined) store.removeDatasetFromScene(target);
      },
    });
    add({
      id: "dataset.delete",
      title: "Delete the selected dataset from the workspace…",
      group: "Datasets",
      args: { type: "object", properties: { id: { type: "string" }, confirm: { type: "boolean", default: true } } },
      run: async ({ id, confirm }: { id?: string; confirm: boolean }) => {
        const target = selectedDatasetId(id);
        const dataset = target === undefined ? undefined : store.dataset(target);
        if (dataset === undefined) return;
        if (confirm && !(await confirmDialog(`Delete “${dataset.name}” from the workspace and every scene? Undo brings it back.`, "Delete", true))) return;
        store.deleteDataset(dataset.id);
      },
    });
    add({
      id: "dataset.rename",
      title: "Rename the selected dataset…",
      group: "Datasets",
      when: "selectedLayer",
      args: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      run: async ({ id, name }: { id?: string; name?: string }) => {
        const target = selectedDatasetId(id);
        const dataset = target === undefined ? undefined : store.dataset(target);
        if (dataset === undefined) return;
        const value = name ?? (await promptDialog("Rename dataset", "Name", dataset.name));
        if (value !== undefined) store.renameDataset(dataset.id, value);
      },
    });
    add({
      id: "dataset.addView",
      title: "Add another view of the selected dataset",
      group: "Datasets",
      hint: "A second layer of the same data, with its own colours and settings",
      when: "selectedLayer",
      run: () => {
        const { dataset, layer } = layerTarget(wb);
        if (dataset !== undefined) store.addLayerView(dataset.id, layer?.name);
      },
    });
    add({
      id: "dataset.showAll",
      title: "Show every dataset in this scene",
      group: "Datasets",
      when: "hasLayers",
      run: () => store.sceneDatasets().forEach((d) => store.setDatasetVisible(d.dataset.id, true)),
    });

    // View
    const layoutIds = LAYOUTS.map(([value]) => value);
    add({
      id: "view.layout",
      title: "Set the layout",
      group: "View",
      args: { type: "object", required: ["layout"], properties: { layout: { type: "string", enum: layoutIds } } },
      run: ({ layout }: { layout: string }) => {
        engine.setLayout(layout);
        store.scheduleSettle();
      },
    });
    for (const [value, label] of LAYOUTS) {
      add({ id: `view.layout.${value}`, title: `Layout: ${label}`, group: "View", run: () => c.invoke("view.layout", { layout: value }) });
    }
    add({ id: "view.zoomIn", title: "Zoom in", group: "View", run: () => engine.zoom(0.5) });
    add({ id: "view.zoomOut", title: "Zoom out", group: "View", run: () => engine.zoom(2) });
    add({ id: "view.resetRotation", title: "Reset the rotation", group: "View", run: () => engine.resetOrientation() });
    add({
      id: "view.setPosition",
      title: "Go to a position",
      group: "View",
      args: { type: "object", required: ["position"], properties: { position: { type: "array", items: { type: "number" } } } },
      run: ({ position }: { position: number[] }) => engine.setPosition(position),
    });
    add({ id: "view.settings", title: "View settings…", group: "View", run: () => showSettingsSheet(wb) });
    add({ id: "view.screenshot", title: "Screenshot…", group: "View", run: () => engine.showScreenshotDialog() });
    const options: [string, string][] = [
      ["showAxisLines", "axis lines"],
      ["showScaleBar", "scale bar"],
      ["showSlices", "cross sections in 3D"],
      ["showDefaultAnnotations", "bounding boxes"],
      ["wireFrame", "wire frame"],
    ];
    add({
      id: "view.toggleOption",
      title: "Toggle a display option",
      group: "View",
      args: { type: "object", required: ["option"], properties: { option: { type: "string", enum: options.map(([k]) => k) } } },
      run: ({ option }: { option: string }) => engine.setViewOption(option, !engine.viewOptions()[option]),
    });
    for (const [key, label] of options) {
      add({ id: `view.toggle.${key}`, title: `Show or hide ${label}`, group: "View", run: () => c.invoke("view.toggleOption", { option: key }) });
    }
    for (const [slot, title] of [
      ["left", "workspace"],
      ["right", "layer"],
      ["bottom", "activity"],
    ] as const) {
      add({ id: `view.dock.${slot}`, title: `Show or hide the ${title} dock`, group: "View", run: () => this.docks.toggle(slot) });
    }
    for (const [tab, title] of [
      ["datasets", "Datasets"],
      ["layer", "Layer"],
      ["activity", "Activity"],
      ["jobs", "Jobs"],
      ["statistics", "Chunk statistics"],
      ["python", "Python"],
      ["plugins", "Plugins"],
    ]) {
      add({ id: `panel.${tab}`, title: `Show the ${title} panel`, group: "Panels", run: () => this.docks.show(tab) });
    }
  }

  private exampleCommands: (() => void)[] = [];

  private registerExampleCommands(): void {
    this.exampleCommands.splice(0).forEach((d) => d());
    for (const example of this.wb.examples.list()) {
      this.exampleCommands.push(
        this.wb.commands.register({
          id: `workspace.example.${example.id}`,
          title: `Open example: ${example.title}`,
          group: "Examples",
          hint: example.description,
          owner: example.owner,
          run: () => this.openExample(example.id),
        }),
      );
    }
  }

  private registerKeys(): void {
    const k = this.wb.keybindings;
    k.add({ key: "mod+k", command: "help.palette", inInputs: true });
    k.add({ key: "mod+o", command: "workspace.open", inInputs: true });
    k.add({ key: "mod+z", command: "edit.undo" });
    k.add({ key: "mod+shift+z", command: "edit.redo" });
    k.add({ key: "mod+y", command: "edit.redo" });
    k.add({ key: "mod+/", command: "help.shortcuts" });
    k.add({ key: "shift+n", command: "dataset.add" });
    k.add({ key: "alt+pagedown", command: "scene.next" });
    k.add({ key: "alt+pageup", command: "scene.previous" });
    for (let i = 1; i <= 9; i++) {
      k.add({ key: String(i), command: "dataset.toggle", args: { index: i } });
      k.add({ key: `alt+${i}`, command: "dataset.select", args: { index: i } });
    }
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable === true;
    // A digit typed with Shift arrives as "!", "@"…; use the physical key for digits.
    const key = /^Digit\d$/.test(e.code) ? keyFromCode(e) : keyFromEvent(e);
    const binding = this.wb.keybindings.resolve(key, this.context.all(), typing);
    if (binding === undefined) return;
    if (sheetIsOpen() && binding.command === "help.palette") {
      e.preventDefault();
      closeSheet();
      return;
    }
    if (sheetIsOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    this.wb.run(binding.command, binding.args);
  }

  // ----------------------------------------------------------- plugins

  /**
   * Switches a plugin on or off (with what it requires, or what requires
   * it), keeps the choice, and reloads the page with the same link.
   */
  private async switchPlugin(catalogue: CatalogueEntry[], choices: Choices, id: string, on: boolean): Promise<void> {
    const manifests = catalogue.map((e) => e.manifest);
    const nameOf = (other: string) => manifests.find((m) => m.id === other)?.name ?? other;
    const { choices: next, also } = togglePlugin(manifests, choices, id, on);
    const message =
      `Switch ${nameOf(id)} ${on ? "on" : "off"}` +
      (also.length ? `, and with it ${also.map(nameOf).join(", ")}` : "") +
      "? The page reloads with the same link.";
    if (!(await confirmDialog(message, on ? "Switch on and reload" : "Switch off and reload"))) return;
    saveChoices(next);
    this.wb.store.settle();
    location.reload();
  }

  /** Says so when the workspace uses a format whose plugin is off. */
  /** Formats in this scene that only this app's plugins read, such as zarr-vectors. */
  private pluginFormatsIn(): string[] {
    const plugin = new Set(this.wb.pluginSwitches.manifests.filter((m) => m.kind === "datatype").map((m) => m.id.replace(/^org\.ngplatform\./, "")));
    const formats = new Set(this.wb.engine.layers().flatMap((l) => l.sources.map((s) => contextKeyFor(s) ?? "")));
    return [...formats].filter((f) => plugin.has(f));
  }

  /** Whether the scene shows data from this computer, which only this app can serve. */
  private usesLocalData(): boolean {
    const prefix = `${this.wb.localData.base}local/`;
    return this.wb.engine.layers().some((l) => l.sources.some((s) => s.includes(prefix)));
  }

  private checkFormats(): void {
    const formats = new Set(this.wb.engine.layers().flatMap((l) => l.sources.map((s) => contextKeyFor(s))));
    const zv = this.wb.pluginSwitches.manifests.find((m) => m.id === "org.ngplatform.zarr-vectors");
    if (zv !== undefined && formats.has("zarr-vectors") && !this.wb.pluginSwitches.enabled.has(zv.id)) {
      const message = "This workspace has Zarr Vectors data, but the Zarr Vectors plugin is off. Switch it on in the Plugins tab.";
      this.wb.log.add(message, "error");
      toast(message, "error");
      this.docks.show("plugins");
    }
  }

  // -------------------------------------------------------------- views

  private mountView(render: (host: HTMLElement) => (() => void) | void, owner: string): () => void {
    this.view?.dispose();
    const host = h("div", { class: "engine-view-host" });
    this.viewArea.replaceChildren(host);
    this.viewArea.hidden = false;
    this.viewSplit.hidden = false;
    this.viewArea.style.flexBasis = `${prefs.get("viewShare") ?? "50"}%`;
    let cleanup: (() => void) | void;
    const mounted = {
      owner,
      dispose: () => {
        if (this.view !== mounted) return;
        this.view = undefined;
        try {
          cleanup?.();
        } finally {
          host.remove();
          this.viewArea.hidden = true;
          this.viewSplit.hidden = true;
        }
      },
    };
    this.view = mounted;
    try {
      cleanup = render(host);
    } catch (e) {
      mounted.dispose();
      throw e;
    }
    return mounted.dispose;
  }

  private dragViewSplit(event: PointerEvent, engine: HTMLElement): void {
    event.preventDefault();
    const box = engine.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const share = Math.min(85, Math.max(15, (100 * (box.right - e.clientX)) / box.width));
      this.viewArea.style.flexBasis = `${share}%`;
      prefs.set("viewShare", share.toFixed(1));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // -------------------------------------------------------------- open

  private openExample(id: string): void {
    const example = this.wb.examples.get(id);
    if (example === undefined) throw new CommandError(`no example ${id}`);
    this.wb.store.open(example.state(), `the example “${example.title}”`);
  }

  /** Opens whatever was pasted or linked; returns whether it worked. */
  async openText(text: string, from: string, asScene: boolean): Promise<boolean> {
    const { store, log } = this.wb;
    try {
      const handler = this.wb.openHandlers.match(text);
      if (handler !== undefined) {
        await handler.open(text.trim());
        return true;
      }
      const parsed = parseInput(text, this.wb.parseFragment);
      if (parsed.kind === "state") {
        const hasScenes = (parsed.state.app.platform as { scenes?: unknown[] } | undefined)?.scenes !== undefined;
        if (asScene && !hasScenes) store.openAsScene(parsed.state.ng, "Opened scene", from);
        else store.open(parsed.state, from);
      } else if (parsed.kind === "remote") {
        this.setStatus("busy", "Fetching state");
        const response = await fetch(parsed.url);
        if (!response.ok) throw new InputError(`${parsed.url} answered ${response.status} ${response.statusText}.`);
        const json = await response.json();
        const again = parseInput(JSON.stringify(json), this.wb.parseFragment);
        if (again.kind !== "state") throw new InputError("That URL did not hold a state.");
        if (asScene) store.openAsScene(again.state.ng, layerNameFor(parsed.url), parsed.url);
        else store.open(again.state, parsed.url);
      } else {
        store.addDataset({ source: parsed.url, name: parsed.name });
        this.docks.show("datasets");
      }
      return true;
    } catch (e) {
      const message = e instanceof InputError ? e.message : `Could not open that: ${(e as Error).message}`;
      log.add(message, "error");
      toast(message, "error");
      this.updateStatus();
      return false;
    }
  }

  // ----------------------------------------------------------- display

  private updateContext(): void {
    const { engine, store } = this.wb;
    const layers = engine.layers();
    const target = layerTarget(this.wb);
    const set = (key: string, value: unknown) => this.context.set(key, value);
    set("hasLayers", layers.length > 0);
    set("sceneIsEmpty", layers.length === 0);
    set("sceneCount", store.state().scenes.length);
    set("selectedLayer", target.layer?.name);
    set("selectedLayerType", target.layer?.type);
    set("datasetKind", target.dataset?.kind);
    set("sourceFormat", contextKeyFor(target.layer?.sources[0]));
    set("canUndo", store.history.canUndo);
    set("canRedo", store.history.canRedo);
    set("framed", framed);
    const kinds = new Set(store.sceneDatasets().map((d) => d.dataset.kind));
    for (const kind of kinds) this.wb.plugins.datasetKindSeen(kind);
  }

  private showShareMenu(anchor: HTMLElement): void {
    const run = (id: string) => () => void this.wb.run(id);
    showMenu(anchor, [
      { label: "Copy link to the workspace", run: run("workspace.share") },
      { label: "Copy this scene as a Neuroglancer link", run: run("workspace.copyPlainLink") },
      { label: "Copy this scene as Neuroglancer JSON", run: run("workspace.copyState") },
      "-",
      { label: "Open in Neuroglancer ↗", run: run("workspace.openInNeuroglancer") },
      { label: "Open in Neuroglancer with Zarr Vectors ↗", run: run("workspace.openInPlainNeuroglancer") },
    ]);
  }

  private renderSceneTabs(): void {
    const { store } = this.wb;
    const p = store.state();
    const current = activeScene(p);
    const close = (id: string, name: string) => {
      store.deleteScene(id);
      toast(`Closed “${name}”. ${keyLabel("Mod+Z")} brings it back.`);
    };
    this.sceneTabs.replaceChildren(
      ...p.scenes.map((scene, index) => {
        const active = scene.id === current.id;
        const menu = (anchor: HTMLElement | { x: number; y: number }) =>
          showMenu(anchor, [
            { label: "Rename…", run: () => this.wb.run("scene.rename", { id: scene.id }) },
            {
              label: "Duplicate",
              run: () => {
                store.switchScene(scene.id);
                store.newScene({ copy: true });
              },
            },
            "-",
            { label: "Move left", disabled: index === 0, run: () => store.moveScene(scene.id, index - 1) },
            { label: "Move right", disabled: index === p.scenes.length - 1, run: () => store.moveScene(scene.id, index + 1) },
            "-",
            { label: "Close", run: () => close(scene.id, scene.name) },
          ]);
        return h(
          "div",
          {
            class: "scene-tab",
            role: "tab",
            tabindex: active ? 0 : -1,
            "aria-selected": String(active),
            title: active ? "Double-click to rename; right-click for more" : `Switch to ${scene.name}`,
            onclick: () => store.switchScene(scene.id),
            ondblclick: () => this.wb.run("scene.rename", { id: scene.id }),
            onauxclick: (e: Event) => {
              if ((e as MouseEvent).button === 1) close(scene.id, scene.name);
            },
            oncontextmenu: (e: Event) => {
              e.preventDefault();
              const m = e as MouseEvent;
              menu({ x: m.clientX, y: m.clientY });
            },
            onkeydown: (e: Event) => {
              const k = e as KeyboardEvent;
              if (k.key === "Enter") store.switchScene(scene.id);
              if (k.key === "Delete") close(scene.id, scene.name);
            },
          },
          h("span", { class: "scene-tab-name" }, scene.name),
          h(
            "button",
            {
              class: "scene-close",
              type: "button",
              title: p.scenes.length > 1 ? `Close ${scene.name}` : `Close ${scene.name}; a blank scene takes its place`,
              "aria-label": `Close ${scene.name}`,
              onclick: (e: Event) => {
                e.stopPropagation();
                close(scene.id, scene.name);
              },
            },
            icon("close"),
          ),
        );
      }),
      iconButton("plus", "New scene", () => this.wb.run("scene.new"), { class: "btn icon scene-add" }),
    );
  }

  /** Shown only while something loads or has failed; "ready" says nothing worth the space. */
  private setStatus(kind: "ok" | "busy" | "err" | "idle", text: string): void {
    this.statusDot.className = kind === "idle" ? "dot" : `dot ${kind}`;
    this.statusText.textContent = text;
    const status = this.statusDot.parentElement!;
    status.dataset.state = kind;
    status.hidden = kind === "ok" || kind === "idle";
  }

  private updateStatus(): void {
    if (this.wb === undefined) return;
    const layers = this.wb.engine.layers();
    const jobs = this.wb.jobs.running();
    const failed = layers.filter((l) => l.error !== undefined).length;
    const loading = layers.filter((l) => !l.ready && l.error === undefined).length;
    const n = layersOf(this.wb.store.ng()).length;
    if (n === 0 && jobs === 0) this.setStatus("idle", "Empty scene");
    else if (failed > 0) this.setStatus("err", `${failed} of ${layers.length} failed to load`);
    else if (loading > 0) this.setStatus("busy", `Loading ${loading} of ${layers.length}`);
    else if (jobs > 0) this.setStatus("busy", `${jobs} job${jobs === 1 ? "" : "s"} running`);
    else this.setStatus("ok", `${layers.length} layer${layers.length === 1 ? "" : "s"} ready`);
  }

  private updateControls(): void {
    this.undoButton.disabled = !this.wb.commands.available("edit.undo");
    this.redoButton.disabled = !this.wb.commands.available("edit.redo");
  }
}

function keyFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac() ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  // Alt changes the character on macOS; the physical key is what is bound.
  const key = e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

function keyFromCode(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac() ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(e.code.slice(5));
  return parts.join("+");
}
