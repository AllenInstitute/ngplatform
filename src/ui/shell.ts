/**
 * The shell: lays out the top bar, the docks and the engine, creates the
 * platform's services and wires them together.  It holds no workspace state
 * itself (that is the WorkspaceStore's) and no panel logic (that is in
 * ui/panels); what remains here is composition and the core commands.
 */
import { CommandError, CommandRegistry, runsWithoutArgs } from "../core/commands.js";
import { KeybindingTable } from "../core/keybindings.js";
import { InputError, layerNameFor, neuroglancerLink, parseInput, pasteAction, type FragmentParser, workspaceLink } from "../core/state_io.js";
import { ContextKeys } from "../core/when.js";
import { activeScene, layersOf, sourceUrls } from "../core/workspace.js";
import { type Engine, LAYOUTS } from "../engine/engine.js";
import { prefersReducedMotion } from "../engine/momentum.js";
import { AuthRegistry, browserAuthEnvironment, middleauthProvider, ngauthProvider } from "../platform/auth.js";
import { accountLabel, type GoogleSignIn, googleProvider } from "../platform/google_auth.js";
import { googleTokenTable, sourceWithRules } from "../core/sign_in_rules.js";
import { applyRulesToNewLayers, type SignInRules } from "../platform/sign_in_rules.js";
import { JobService } from "../platform/jobs.js";
import { HostList } from "../platform/hosts.js";
import { RunnerService } from "../platform/runner.js";
import { fetchRemoteState } from "../platform/deadline.js";
import { downloadBlob } from "../sdk/dom.js";
import { linkTooLong, workspaceFile } from "./export.js";
import { ComputedImages } from "../virtual/computed.js";
import { collectDropped, LocalData } from "../virtual/local_data.js";
import { LocalPlugins } from "../platform/local_plugins.js";
import { PluginHost } from "../platform/plugin_host.js";
import { ExampleRegistry, OpenHandlerRegistry } from "../platform/registries.js";
import { ServiceRegistry } from "../platform/services.js";
import { WorkspaceStore } from "../platform/workspace_store.js";
import { HistoryKeep, IndexedDbHistoryBackend } from "../platform/history_keep.js";
import type { HistoryData } from "../core/history.js";
import {
  type Choices,
  defaultsTold,
  formerlyOnNowOff,
  needsReload,
  noteDefaultsTold,
  type Resolution,
  resolveEnabled,
  saveChoices,
  saveThisTab,
  toggle as togglePlugin,
} from "../platform/plugin_switches.js";
import { listNames } from "../platform/plugin_offers.js";
import { PluginOffers } from "./plugin_offers.js";
import type { CatalogueEntry } from "../../plugins/index.js";
import { registerBuiltins } from "../builtins/index.js";
import { contextKeyFor } from "./context.js";
import { asTool, describeSize, followDrag, type DockTab, DockManager, prefs } from "./docks.js";
import { h, icon, iconButton, isMac, keyLabel, mark } from "./dom.js";
import { closeSheet, confirmDialog, copyText, formDialog, offer, promptDialog, sheet, sheetIsOpen, showMenu, showPalette, showSheet, toast } from "./overlays.js";
import { ActivityLog, WARNING_EVENT, warningLine } from "./panels/activity.js";
import { showAddMenu } from "./panels/datasets.js";
import { layerTarget } from "./panels/layer.js";
import { renderLayersPanel } from "./panels/layers.js";
import { renderJobsPanel, renderPluginsPanel } from "./panels/misc.js";
import { CONVENTION_LABELS, type PanelConvention } from "../engine/anatomical.js";
import { offerOverviews } from "./overview.js";
import { offerRunnerForLarge, offerSampledTractograms, pairFromLink, runnerApi } from "./runner.js";
import { openDroppedItems, SETTINGS_SECTIONS, type SettingsSection, showAddDatasetSheet, showEditStateSheet, showLocalSheet, showOpenSheet, showSettingsSheet, showShortcutsSheet } from "./sheets.js";
import type { Workbench } from "./workbench.js";
import { createPlatformApis } from "./apis.js";

/**
 * Code that only some sessions use, loaded the first time it is: the Python
 * panel (and Python plugins), the capture sheet, the history menu.
 */
const pythonPanel = () => import("./panels/python.js");
const captureSheet = () => import("./capture.js");
const historyView = () => import("./history_view.js");

/** The code and the guide, linked from Help. */
const REPOSITORY = "https://github.com/AllenInstitute/ngplatform";
const GUIDE = "https://ngplatform.readthedocs.io/en/latest/";

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
  /** Over an empty scene's views: the examples, opening a file, pasting a link. */
  private readonly startCard = h("div", { class: "start-card", hidden: true });
  /** In the Activity dock's head, also while it is collapsed: the running job, else the last message. */
  private readonly activityLine = h("button", { class: "dock-status", type: "button", title: "Show the activity" });
  private readonly undoButton = iconButton("undo", "Undo", () => this.wb.run("edit.undo"));
  private readonly redoButton = iconButton("redo", "Redo", () => this.wb.run("edit.redo"));
  private readonly historyButton: HTMLButtonElement = iconButton("more", "History of changes", () => this.showHistory());
  private wb!: Workbench;
  /** The Activity log (once attached). */
  get activity(): ActivityLog {
    return this.wb.log;
  }
  /** A plugin's view beside Neuroglancer's, and the divider between them. */
  private readonly viewArea = h("div", { class: "engine-view", hidden: true });
  private readonly viewSplit = h("div", {
    class: "engine-split",
    hidden: true,
    role: "separator",
    tabindex: 0,
    "aria-orientation": "vertical",
    "aria-label": "Resize the view beside the viewer",
    title: "Drag to resize",
  });
  private view: { owner: string; dispose: () => void } | undefined;
  private google: GoogleSignIn | undefined;
  private localPlugins: LocalPlugins | undefined;
  /** Which plugins are on: this browser's choices, what examples switched on for this tab, and the result. */
  private switches!: { catalogue: CatalogueEntry[]; choices: Choices; thisTab: Set<string>; resolution: Resolution };
  /** Activates the plugins with state in the workspace and refreshes the shell (set in attach). */
  private activateWithState: () => void = () => {};
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
          // Named for a screen reader also where a narrow window hides its label.
          { class: "btn", type: "button", "aria-haspopup": "menu", "aria-label": "Share", onclick: (e: Event) => this.showShareMenu(e.currentTarget as HTMLElement) },
          icon("link"),
          h("span", { class: "hide-narrow" }, "Share"),
        ),
      ),
      h("span", { class: "sep hide-narrow" }),
      h("div", { class: "group hide-phone" }, this.undoButton, this.redoButton, this.historyButton),
      h("span", { class: "sep hide-narrow" }),
      this.sceneTabs,
      h("span", { class: "spacer" }),
      h("div", { class: "status", role: "status" }, this.statusDot, this.statusText),
      h(
        "div",
        { class: "group" },
        iconButton("camera", "Capture", (e) =>
          showMenu(e.currentTarget as HTMLElement, [
            { label: "Picture…", run: () => this.wb.run("view.capture") },
            { label: "Movie: sweep slices or time…", run: () => this.wb.run("view.captureSweep") },
            { label: "Movie: turn the 3-D view…", run: () => this.wb.run("view.captureTurntable") },
            "-",
            { label: "Screenshot (Neuroglancer)…", run: () => this.wb.run("view.screenshot") },
          ]),
        ),
        iconButton("settings", "Settings", () => this.wb.run("settings.open")),
        iconButton("help", "Help", (e) =>
          showMenu(e.currentTarget as HTMLElement, [
            { label: "Keyboard and mouse", run: () => this.wb.run("help.shortcuts") },
            { label: "Guide ↗", run: () => window.open(GUIDE, "_blank", "noopener") },
            { label: "ngplatform on GitHub ↗", run: () => window.open(REPOSITORY, "_blank", "noopener") },
          ]),
        ),
      ),
      h(
        "button",
        { class: "palette-trigger", type: "button", onclick: () => this.wb.run("help.palette"), "aria-label": "Search commands" },
        icon("search"),
        h("span", { class: "grow" }, "Commands"),
        h("kbd", {}, keyLabel("Mod+K")),
      ),
    );
    const engine = h("section", { class: "engine", "aria-label": "Viewer" }, this.engineHost, this.viewSplit, this.viewArea, this.startCard);
    this.viewSplit.addEventListener("pointerdown", (e) => this.dragViewSplit(e, engine));
    this.viewSplit.addEventListener("keydown", (e) => this.stepViewSplit(e));
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
    this.activityLine.addEventListener("click", () => this.docks.show("activity"));
    this.docks.addToHead("bottom", this.activityLine);
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
    plugins: {
      catalogue: CatalogueEntry[];
      choices: Choices;
      resolution: Resolution;
      thisTab: Set<string>;
      returning: boolean;
      /** Data type plugins whose Neuroglancer module failed to load (src/main.ts), by id. */
      failed?: Map<string, Error>;
    },
    google: GoogleSignIn,
    rules: SignInRules,
  ): void {
    const log = new ActivityLog();
    const commands = new CommandRegistry();
    commands.useContext(this.context);
    const keybindings = new KeybindingTable();
    const examples = new ExampleRegistry();
    const openHandlers = new OpenHandlerRegistry();
    const jobs = new JobService();
    const runner = new RunnerService(localStorage);
    const hosts = new HostList(runner, localStorage);
    const services = new ServiceRegistry();
    const auth = new AuthRegistry(localStorage);
    const authEnvironment = browserAuthEnvironment();
    auth.register(googleProvider(google), "platform");
    auth.register(middleauthProvider(authEnvironment), "platform");
    auth.register(ngauthProvider(authEnvironment), "platform");
    this.google = google;
    // Data waiting for a Google account says so once per account, and gets the sign-in ready for the click.
    const told = new Set<string>();
    google.onChanged(() => {
      for (const account of told) if (google.token(account || undefined) !== undefined) told.delete(account);
      auth.changed();
    });
    rules.onChanged(() => auth.changed());
    google.onNeeded((account) => {
      if (google.clientId() !== undefined) void google.prepare().catch(() => {});
      if (told.has(account ?? "")) return;
      told.add(account ?? "");
      toast(
        account === undefined
          ? "Data from Google Cloud Storage waits for a Google sign-in (Settings → Sign-in)."
          : `Data from Google Cloud Storage waits for ${accountLabel(account)} to sign in (Settings → Sign-in).`,
      );
    });
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
      runner,
      hosts,
      services,
      auth,
      google,
      rules,
      plugins: undefined as unknown as PluginHost,
      pluginSwitches: {
        catalogue: plugins.catalogue,
        manifests: plugins.catalogue.map((e) => e.manifest),
        enabled: plugins.resolution.enabled,
        blocked: plugins.resolution.blocked,
        thisTab: plugins.thisTab,
        toggle: (id, on) => this.switchPlugin(id, on),
        keep: (id) => this.keepPlugin(id),
        onChange: (listener) => {
          this.pluginListeners.add(listener);
          return () => this.pluginListeners.delete(listener);
        },
      },
      offers: undefined as unknown as PluginOffers,
      log,
      localData: new LocalData(),
      computed: new ComputedImages(),
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
    this.switches = { catalogue: plugins.catalogue, choices: plugins.choices, thisTab: plugins.thisTab, resolution: plugins.resolution };
    wb.offers = new PluginOffers(wb, plugins.catalogue, (ids) => this.turnOnPlugins(ids));
    // For debugging from the console, beside window.viewer.
    (window as unknown as { workbench: Workbench }).workbench = wb;
    const apis = createPlatformApis(wb);
    wb.plugins = new PluginHost({
      commands,
      keybindings,
      context: this.context,
      // A plugin's panel in the left slot is a tool: it goes to the Tools dock, under the group its manifest names.
      docks: {
        addTab: (tab) => this.docks.addTab(asTool(tab)),
        show: (id) => this.docks.show(id),
      },
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
        sheet: (title, render, options) => {
          const body = h("div", { class: "plugin-sheet" });
          let dispose: (() => void) | void;
          const close = showSheet(sheet(title, [body], [h("button", { class: "btn", type: "button", onclick: () => close() }, "Close")], options), () => dispose?.());
          dispose = render(body, close);
          return close;
        },
      },
      workspace: apis.workspace,
      viewer: apis.viewer,
      slices: {
        get: (key, version) => store.rawSlice(key, version),
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
      runner: runnerApi(() => wb, runner),
      hosts: hosts.api(),
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
      runPython: async (owner, source) => (await pythonPanel()).runPythonPlugin(wb, owner, source),
      forgetPython: (owner) => void pythonPanel().then((m) => m.forgetPython(owner)),
      log: (message, level) => log.add(message, level ?? "info"),
    });
    void this.localPlugins.restore();
    // Local data opened on earlier visits: the workspace's links to it work
    // once reading is allowed again.
    for (const entry of plugins.catalogue) {
      if (entry.virtualFormats !== undefined && plugins.resolution.enabled.has(entry.manifest.id)) wb.localData.addFormats(entry.virtualFormats());
    }
    void wb.localData.restore();
    // The service worker from the start: a workspace's computed layers are
    // asked for as soon as it opens.
    wb.computed.listen();
    // Python a pipeline brings in a link runs only once allowed here, with its code shown.
    wb.computed.confirmPython = (code) =>
      confirmDialog(
        "A computed layer in this workspace runs the Python below in this tab. Run it? Only run code from people you trust: it can read what this tab can, files opened from this computer included.",
        "Run it",
        true,
        code.map((c) => (c.length > 4000 ? `${c.slice(0, 4000)}\n…` : c)).join("\n# ----\n"),
      );
    wb.computed.onAllowed = () => store.reloadLayers();
    // The engine's reader reads gs+google:// sources with each bucket's account's token.
    if (this.google !== undefined) {
      const google = this.google;
      const give = () =>
        wb.computed.setGoogleTokens(googleTokenTable(wb.rules.list(), google.token()?.accessToken, (account) => google.token(account)?.accessToken));
      google.onChanged(give);
      wb.rules.onChanged(give);
      give();
    }
    // Sign-in rules give the layers a workspace opens with, or that are added, their sign-in:
    // before they open when the platform opens them, else (Neuroglancer's own
    // layer controls) as soon as they appear.
    store.sourceRules = (source) => sourceWithRules(source, wb.rules.list(), wb.auth.sourceSignIns(sourceUrls(source)));
    applyRulesToNewLayers(store, wb.rules, (sources) => wb.auth.sourceSignIns(sources));
    void wb.localData.start();
    // A large image first viewed: offer to build its overview in the background.
    offerOverviews(wb);
    offerSampledTractograms(wb, wb.runner);
    // Local data opened again (dropped files go with a reload): the layers
    // that read it before read it again, under its new id.
    const relink = async () => {
      if (!wb.localData.restored) return;
      const sources = engine.layers().flatMap((l) => l.sources);
      for (const [from, to] of await wb.localData.reopened(sources)) {
        const n = store.relinkSources(`${wb.localData.base}local/${from}/`, `${wb.localData.base}local/${to}/`, "Local data opened again");
        if (n > 0) toast(`Reading ${n} layer${n === 1 ? "" : "s"} from the files opened again.`);
      }
    };
    wb.localData.onChange(() => void relink());
    for (const entry of plugins.catalogue) {
      const enabled = plugins.resolution.enabled.has(entry.manifest.id);
      // A data type plugin has no platform code: it was loaded with the viewer,
      // unless that failed; then its activation fails, and the Plugins panel says why.
      const failure = plugins.failed?.get(entry.manifest.id);
      const load =
        failure !== undefined
          ? async () => {
              throw new Error(`could not load: ${failure.message}`);
            }
          : (entry.load ?? (async () => ({ activate() {} })));
      wb.plugins.register(entry.manifest, load, { builtin: true, enabled });
      if (enabled && entry.manifest.kind === "datatype") void wb.plugins.activate(entry.manifest.id).catch(() => {});
    }
    if (plugins.failed !== undefined && plugins.failed.size > 0) {
      const names = plugins.catalogue.filter((e) => plugins.failed!.has(e.manifest.id)).map((e) => e.manifest.name);
      offer(`${listNames(names)} could not load.`, [{ label: "Show Plugins", primary: true, run: () => this.docks.show("plugins") }], 60000);
    }

    // Neuroglancer's own status messages (loading, errors) go below the views.
    engine.routeStatusMessages(this.statusStrip, (text, error) => {
      if (error) log.add(text, "error", "Neuroglancer");
    });

    const refresh = () => {
      this.updateContext();
      this.updateStatus();
      this.renderSceneTabs();
      this.showKindPanel();
      this.updateControls();
      this.updateStartCard();
    };
    // The activity line: a running job and its progress, else the last message.
    let last: { message: string; level: string } | undefined;
    const line = () => {
      const running = jobs.list().filter((j) => j.state === "running");
      const job = running[0];
      this.activityLine.classList.toggle("err", job === undefined && last?.level === "error");
      this.activityLine.textContent =
        job !== undefined
          ? `${job.title}${job.progress !== undefined ? ` ${Math.round(job.progress * 100)}%` : "…"}${running.length > 1 ? ` (+${running.length - 1})` : ""}`
          : (last?.message ?? "");
    };
    log.onAdd((message, level) => {
      last = { message, level };
      line();
    });
    // Data type plugins' warnings about what they read (a newer format, columns left out), each once per store.
    window.addEventListener(WARNING_EVENT, (e) => {
      const warning = warningLine((e as CustomEvent).detail);
      if (warning !== undefined) log.add(warning.message, "info", warning.source);
    });
    jobs.onChange(line);
    store.onChange(refresh);
    // A plugin with state in the workspace (a filter in a shared link, say)
    // is loaded as the workspace opens, so its effect shows without opening
    // its panel.
    const withState = () => {
      for (const entry of plugins.catalogue) {
        const key = entry.manifest.contributes?.appState?.key;
        if (key === undefined || store.rawSlice(key) === undefined) continue;
        const record = wb.plugins.list().find((r) => r.manifest.id === entry.manifest.id);
        if (record?.status === "registered") void wb.plugins.activate(entry.manifest.id).catch(() => {});
      }
    };
    store.onChange(withState);
    this.activateWithState = () => {
      withState();
      refresh();
    };
    engine.onLayersChanged(refresh);
    engine.onSelectionChanged(refresh);
    commands.onChange(() => this.updateControls());
    jobs.onChange(() => this.updateStatus());
    runner.onChange(() => this.updateStatus());
    hosts.onChange(() => this.updateStatus());
    // A link the runner printed pairs this browser (after asking); the fragment is removed.
    pairFromLink(wb, runner);
    if (runner.pairing() !== undefined) void runner.refresh();
    // Every 5 s: which paired computers answer, their GPUs and services.
    hosts.start();

    window.addEventListener("keydown", (e) => this.onKey(e), true);
    window.addEventListener("paste", (e) => this.onPaste(e));
    this.acceptDrops();
    // Changes before the user's first input after opening belong to opening (see WorkspaceStore.noteInput).
    for (const type of ["keydown", "pointerdown", "wheel"]) window.addEventListener(type, () => this.wb.store.noteInput(), { capture: true, passive: true });
    window.addEventListener("hashchange", () => {
      if (location.hash !== store.currentHash && location.hash !== this.lastHashSeen && location.hash.startsWith("#!")) {
        this.lastHashSeen = location.hash;
        void this.openText(location.href, "the address bar", false);
      }
    });

    // The history tree is kept in this browser beside the link (src/platform/history_keep.ts).
    const keep = framed ? undefined : new HistoryKeep(new IndexedDbHistoryBackend());
    if (keep !== undefined) this.keepHistory(keep);
    if (location.hash.startsWith("#!")) {
      const link = location.href;
      void (async () => {
        const resume = await keep?.find(location.hash);
        await this.openText(link, "the link", false, resume);
        if (resume !== undefined) log.add("The history of changes kept in this browser for this link is back (the ⋯ beside undo and redo).");
      })();
    } else {
      // An empty viewer, unless the link names an example (`#example=<id>`) or the build a default one.
      const named = /^#example=([\w.-]+)$/.exec(location.hash)?.[1];
      const example = examples.get(named ?? defaultExample);
      if (example !== undefined) this.openExample(example.id);
      else store.settle();
    }
    refresh();
    setTimeout(() => this.checkFormats(), 1500);
    // Offers of the plugins that are off, from the data opened (and the workspace's state).
    wb.offers.start();
    this.tellNewDefaults(plugins.returning);
    if (framed) log.add("In a frame, links cannot carry the workspace: Share copies it as JSON.");
  }

  private registerPanels(): void {
    const wb = this.wb;
    const add = (tab: DockTab) => this.docks.addTab(tab);
    add({ id: "layers", title: "Layers", slot: "left", order: 10, render: (host) => renderLayersPanel(host, wb) });
    add({ id: "plugins", title: "Plugins", slot: "left", order: 90, render: (host) => renderPluginsPanel(host, wb, this.localPlugins!) });
    add({
      id: "activity",
      title: "Activity",
      slot: "bottom",
      order: 10,
      render: (host) => {
        // The jobs (when there are any) above the log.
        const jobs = h("div", { class: "activity-jobs" });
        host.append(jobs, wb.log.element);
        return renderJobsPanel(jobs, wb);
      },
    });
    add({ id: "python", title: "Python", slot: "bottom", order: 40, render: async (host) => (await pythonPanel()).renderPythonPanel(host, wb) });
    // Tabs that were merged or moved into Settings: showing one shows where it went.
    this.docks.redirect("datasets", "layers");
    this.docks.redirect("layer", "layers");
    this.docks.redirect("jobs", "activity");
    const settings = (section: SettingsSection) => () => showSettingsSheet(wb, section);
    this.docks.redirect("auth", settings("sign-in"));
    this.docks.redirect("remote", settings("compute"));
    this.docks.redirect("statistics", settings("developer"));
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
          () => c.list().filter(runsWithoutArgs),
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
        if (linkTooLong(link)) {
          // A link this long is cut or refused by chat tools and mail: shared as a file, or as JSON.
          const FILE = "Save the workspace as a file";
          const JSON_TEXT = "Copy the workspace as JSON";
          const LINK = "Copy the long link anyway";
          const answer = await formDialog<{ how: string }>(
            "Share this workspace",
            {
              type: "object",
              properties: {
                how: {
                  type: "string",
                  title: "How",
                  enum: [FILE, JSON_TEXT, LINK],
                  default: FILE,
                  description: `Its link would be ${(link.length / 1024).toFixed(0)} KB, longer than chat tools and mail keep whole. A file or JSON opens with Open (paste it); a file put on the web opens from a link to it: ${location.href.replace(/#.*$/, "")}#!<its URL>.`,
                },
              },
              required: ["how"],
            },
            {},
            "Share",
          );
          if (answer?.how === FILE) await wb.run("workspace.saveFile");
          else if (answer?.how === JSON_TEXT) {
            if (await copyText(store.serialize(), "the workspace")) toast("Copied the workspace as JSON. Paste it into Open to restore it.");
          } else if (answer?.how === LINK && (await copyText(link, "the link"))) toast(`Link copied (${(link.length / 1024).toFixed(1)} KB). Some chat tools and mail may cut it short.`);
          return;
        }
        if (await copyText(link, "the link")) toast(`Link copied (${(link.length / 1024).toFixed(1)} KB).`);
        wb.log.add("Copied a link to the workspace.");
      },
    });
    add({
      id: "workspace.saveFile",
      title: "Save this workspace as a file",
      group: "Workspace",
      hint: "A JSON file to send or put on the web; it opens with Open",
      run: () => {
        store.settle();
        const file = workspaceFile(store.serialize(), activeScene(store.state()).name);
        downloadBlob(file.blob, file.name);
        toast(`Saved the workspace as ${file.name}. Paste it into Open, or link to it on the web with #!<its URL>, to open it.`);
        wb.log.add(`Saved the workspace as ${file.name}.`);
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
        if (!(await copyText(url, "the link"))) return;
        // Google's Neuroglancer reads neither this site's sign-in nor what this site computes or serves.
        const missing = viewer.includes("appspot") ? this.unreadableElsewhere() : this.unreadableElsewhere().filter((m) => !m.startsWith("gs+google"));
        toast(`Neuroglancer link copied (${viewer}).${missing.length ? ` It will not show ${missing.join(" or ")}.` : ""}`);
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
        const missing = [...this.pluginFormatsIn().map((f) => (f === "zarr-vectors" ? "Zarr Vectors" : f)), ...this.unreadableElsewhere()];
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
    wb.examples.onChange(() => {
      this.registerExampleCommands();
      this.startCardFor = undefined;
      this.updateStartCard();
    });
    this.registerExampleCommands();

    // Edit
    add({ id: "edit.undo", title: "Undo", group: "Edit", when: "canUndo", run: () => store.undo() });
    add({ id: "edit.redo", title: "Redo", group: "Edit", when: "canRedo", run: () => store.redo() });
    add({ id: "edit.history", title: "History of changes…", group: "Edit", run: () => this.showHistory() });
    const branch = (direction: 1 | -1) => () => {
      if (!store.switchBranch(direction)) toast("No other branch that way: branches start where a change was made after going back.");
    };
    add({ id: "edit.previousBranch", title: "Previous branch of the history", group: "Edit", run: branch(-1) });
    add({ id: "edit.nextBranch", title: "Next branch of the history", group: "Edit", run: branch(1) });

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
      title: "Reload page and all data",
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
    const conventions: [PanelConvention | "auto", string, string][] = [
      ["auto", "Automatic", "as Freeview for anatomy in millimetres or micrometres, as Neuroglancer for electron microscopy"],
      ["radiological", "As Freeview (radiological)", CONVENTION_LABELS.radiological],
      ["neurological", "Neurological", CONVENTION_LABELS.neurological],
      ["neuroglancer", "As Neuroglancer", CONVENTION_LABELS.neuroglancer],
    ];
    for (const [id, title] of conventions) {
      add({ id: `view.panels.${id}`, title: `Views: ${title}`, group: "View", run: () => engine.setPanelConvention(id) });
    }
    add({
      id: "view.momentum",
      title: "3-D view: keep turning after a drag (momentum) on or off",
      group: "View",
      run: () => {
        engine.momentum = !engine.momentum;
        toast(
          !engine.momentum
            ? "The 3-D view stops when you let go."
            : prefersReducedMotion()
              ? "The 3-D view keeps turning after a drag, though not while your system asks for less motion."
              : "The 3-D view keeps turning after a drag.",
        );
      },
    });
    add({
      id: "view.panelConvention",
      title: "View orientation…",
      group: "View",
      run: () => {
        const { preference } = engine.panelConvention();
        showMenu(
          this.root.querySelector<HTMLElement>('.topbar button[title="Settings"]') ?? { x: window.innerWidth - 320, y: 48 },
          conventions.map(([id, title]) => ({ label: `${preference === id ? "✓ " : ""}${title}`, current: preference === id, run: () => engine.setPanelConvention(id) })),
        );
      },
    });
    add({
      id: "view.setPosition",
      title: "Go to a position",
      group: "View",
      args: { type: "object", required: ["position"], properties: { position: { type: "array", items: { type: "number" } } } },
      run: ({ position }: { position: number[] }) => engine.setPosition(position),
    });
    add({
      id: "settings.open",
      title: "Settings…",
      group: "View",
      args: { type: "object", properties: { section: { type: "string", enum: Object.keys(SETTINGS_SECTIONS) } } },
      run: (args?: { section?: SettingsSection }) => showSettingsSheet(wb, args?.section),
    });
    add({ id: "view.settings", title: "View settings…", group: "View", run: () => showSettingsSheet(wb, "view") });
    add({ id: "settings.signIn", title: "Sign-in settings…", group: "View", run: () => showSettingsSheet(wb, "sign-in") });
    add({ id: "settings.compute", title: "Compute: pair a computer…", group: "View", run: () => showSettingsSheet(wb, "compute") });
    add({ id: "view.screenshot", title: "Screenshot (Neuroglancer)…", group: "View", run: () => engine.showScreenshotDialog() });
    add({ id: "view.capture", title: "Capture a picture (magnified, trimmed)…", group: "View", run: async () => (await captureSheet()).showCaptureSheet(wb, "picture") });
    add({ id: "view.captureSweep", title: "Capture a movie: sweep slices or time…", group: "View", run: async () => (await captureSheet()).showCaptureSheet(wb, "sweep") });
    add({ id: "view.captureTurntable", title: "Capture a movie: turn the 3-D view…", group: "View", run: async () => (await captureSheet()).showCaptureSheet(wb, "turntable") });
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
      ["left", "layers"],
      ["right", "tools"],
      ["bottom", "activity"],
    ] as const) {
      add({ id: `view.dock.${slot}`, title: `Show or hide the ${title} dock`, group: "View", run: () => this.docks.toggle(slot) });
    }
    for (const [tab, title] of [
      ["layers", "Layers"],
      ["activity", "Activity"],
      ["python", "Python"],
      ["plugins", "Plugins"],
    ]) {
      add({ id: `panel.${tab}`, title: `Show the ${title} panel`, group: "Panels", run: () => this.docks.show(tab) });
    }
  }

  /** Which examples the start card was made with (undefined: make it again). */
  private startCardFor: string | undefined;

  /** The start card: shown over a scene with no layers (not a plugin's kind of scene), made again when the examples change. */
  private updateStartCard(): void {
    const wb = this.wb;
    const scene = activeScene(wb.store.state());
    this.startCard.hidden = wb.engine.layers().length > 0 || scene.kind !== undefined;
    if (this.startCard.hidden) return;
    const examples = wb.examples.list().filter((e) => e.listed !== false && !(e.remote && wb.framed));
    const key = examples.map((e) => e.id).join(",");
    if (key === this.startCardFor) return;
    this.startCardFor = key;
    this.startCard.replaceChildren(
      h(
        "div",
        { class: "start-examples" },
        ...examples.map((e) =>
          h("button", { class: "start-example", type: "button", title: e.description, onclick: () => this.openExample(e.id) }, h("span", { class: "title" }, e.title), h("span", { class: "desc" }, e.description)),
        ),
      ),
      h(
        "div",
        { class: "row-actions" },
        h("button", { class: "btn primary", type: "button", disabled: !wb.commands.available("dataset.addLocal"), onclick: () => wb.run("dataset.addLocal") }, icon("open"), "Open a file…"),
        h("button", { class: "btn outline", type: "button", onclick: () => wb.run("workspace.open") }, icon("link"), "Paste a link…"),
      ),
      h("p", { class: "note" }, "Or drop files here."),
    );
  }

  private exampleCommands: (() => void)[] = [];

  private registerExampleCommands(): void {
    this.exampleCommands.splice(0).forEach((d) => d());
    for (const example of this.wb.examples.list()) {
      if (example.listed === false) continue;
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
    k.add({ key: "mod+alt+z", command: "edit.previousBranch" });
    k.add({ key: "mod+alt+shift+z", command: "edit.nextBranch" });
    k.add({ key: "mod+/", command: "help.shortcuts" });
    k.add({ key: "shift+n", command: "dataset.add" });
    k.add({ key: "alt+pagedown", command: "scene.next" });
    k.add({ key: "alt+pageup", command: "scene.previous" });
    for (let i = 1; i <= 9; i++) {
      k.add({ key: String(i), command: "dataset.toggle", args: { index: i } });
      k.add({ key: `alt+${i}`, command: "dataset.select", args: { index: i } });
    }
  }

  /**
   * Text pasted on the window, outside a text field: a data URL is added to
   * the scene; another web address, or a link or state (which replaces the
   * workspace), is asked about first (src/core/state_io.ts, pasteAction).
   */
  private onPaste(e: ClipboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable === true || sheetIsOpen()) return;
    const action = pasteAction(e.clipboardData?.getData("text/plain") ?? "", this.wb.parseFragment);
    if (action === undefined) return;
    e.preventDefault();
    const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
    const add = (url: string, name: string) => {
      this.wb.store.addDataset({ source: url, name });
      this.docks.show("datasets");
    };
    if (action.kind === "open") {
      const { text } = action;
      offer("Open the pasted link? It replaces this workspace (Undo brings it back).", [
        { label: "Not now" },
        { label: "As a new scene", run: () => void this.openText(text, "the pasted link", true) },
        { label: "Open", primary: true, run: () => void this.openText(text, "the pasted link", false) },
      ]);
      return;
    }
    const { url, name } = action;
    if (action.kind === "add") {
      add(url, name);
      toast(`Added the pasted address as “${name}”.`);
    } else offer(`Add ${short(url)} as a dataset?`, [{ label: "Not now" }, { label: "Add", primary: true, run: () => add(url, name) }]);
  }

  private onKey(e: KeyboardEvent): void {
    // The modifier no binding uses here (Ctrl on macOS, the Windows key elsewhere): not "1" pressed alone.
    if (isMac() ? e.ctrlKey : e.metaKey) return;
    const target = e.target as HTMLElement | null;
    // In a menu, a letter moves to the item starting with it, as typing does: not a shortcut.
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable === true ||
      target?.closest?.('[role="menu"]') != null;
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
   * it) and keeps the choice.  A tool plugin switches on at once; a data
   * type plugin switched on, or anything switched off, reloads the page
   * with the same link (after asking).
   */
  private async switchPlugin(id: string, on: boolean): Promise<void> {
    if (on) return this.turnOnPlugins([id]);
    const { catalogue, choices, thisTab } = this.switches;
    const manifests = catalogue.map((e) => e.manifest);
    const nameOf = (other: string) => manifests.find((m) => m.id === other)?.name ?? other;
    const { choices: next, also } = togglePlugin(manifests, choices, id, false, thisTab);
    const message = `Turn ${nameOf(id)} off${also.length ? `, and with it ${listNames(also.map(nameOf))}` : ""}? The page reloads with the same link.`;
    if (!(await confirmDialog(message, "Turn off and reload"))) return;
    saveChoices(next);
    this.wb.store.settle();
    location.reload();
  }

  /**
   * Turns plugins on (with what they require) and keeps the choice.  Tool
   * plugins come on at once, without a reload: their panels and commands
   * appear, and the first one's panel is shown.  A data type plugin needs the
   * page reloaded (with the same link, so the workspace is kept).
   */
  private async turnOnPlugins(ids: string[]): Promise<void> {
    const { catalogue, thisTab } = this.switches;
    const manifests = catalogue.map((e) => e.manifest);
    const nameOf = (other: string) => manifests.find((m) => m.id === other)?.name ?? other;
    let next = this.switches.choices;
    for (const id of ids) next = togglePlugin(manifests, next, id, true, thisTab).choices;
    const switchedOn = [...resolveEnabled(manifests, next, thisTab).enabled].filter((id) => !this.wb.pluginSwitches.enabled.has(id));
    if (needsReload(manifests, switchedOn)) {
      const message = `Turn on ${listNames(switchedOn.map(nameOf))}? The page reloads with the same link.`;
      if (!(await confirmDialog(message, "Turn on and reload"))) return;
      saveChoices(next);
      this.wb.store.settle();
      location.reload();
      return;
    }
    saveChoices(next);
    this.switches.choices = next;
    // Chosen now: no longer on for this tab only.
    for (const id of Object.keys(next)) thisTab.delete(id);
    saveThisTab(thisTab);
    this.applySwitches(switchedOn);
    const shown = ids.filter((id) => this.wb.pluginSwitches.enabled.has(id));
    if (shown.length === 0) return;
    const panel = manifests.find((m) => m.id === shown[0])?.contributes?.panels?.[0]?.id;
    // Its panel opening says it is on.
    if (panel !== undefined) this.docks.show(panel);
  }

  /** A plugin on for this tab only (an example's), kept on in this browser. */
  private keepPlugin(id: string): void {
    this.switches.choices = { ...this.switches.choices, [id]: true };
    saveChoices(this.switches.choices);
    this.switches.thisTab.delete(id);
    saveThisTab(this.switches.thisTab);
    this.applySwitches([]);
  }

  /**
   * Switches on, for this tab only, the tool plugins an example is shown
   * with, unless this browser chose them off (or one would need a reload).
   */
  private switchOnForTab(ids: string[]): void {
    const { catalogue, choices, thisTab } = this.switches;
    const manifests = catalogue.map((e) => e.manifest);
    const wanted = ids.filter((id) => choices[id] === undefined && !this.wb.pluginSwitches.enabled.has(id));
    if (wanted.length === 0) return;
    const after = new Set([...thisTab, ...wanted]);
    const switchedOn = [...resolveEnabled(manifests, choices, after).enabled].filter((id) => !this.wb.pluginSwitches.enabled.has(id));
    if (needsReload(manifests, switchedOn)) return;
    for (const id of wanted) thisTab.add(id);
    saveThisTab(thisTab);
    this.applySwitches(switchedOn);
  }

  /** Brings the plugins just switched on into the page, and brings up to date everything that shows which are on. */
  private applySwitches(switchedOn: string[]): void {
    const { catalogue, choices, thisTab } = this.switches;
    const manifests = catalogue.map((e) => e.manifest);
    const resolution = resolveEnabled(manifests, choices, thisTab);
    this.switches.resolution = resolution;
    // The workbench's sets are the ones panels hold: changed in place.
    const { enabled, blocked } = this.wb.pluginSwitches;
    enabled.clear();
    for (const id of resolution.enabled) enabled.add(id);
    blocked.clear();
    for (const [id, missing] of resolution.blocked) blocked.set(id, missing);
    // In the catalogue's order: what a plugin requires comes before it.
    for (const entry of catalogue) {
      if (!switchedOn.includes(entry.manifest.id)) continue;
      if (entry.virtualFormats !== undefined) this.wb.localData.addFormats(entry.virtualFormats());
      this.wb.plugins.switchOn(entry.manifest.id);
    }
    this.activateWithState();
    this.wb.offers.schedule(0);
    this.pluginsChanged();
  }

  private readonly pluginListeners = new Set<() => void>();

  private pluginsChanged(): void {
    for (const listener of this.pluginListeners) listener();
  }

  /**
   * Once, for a browser that used the app before every plugin but Zarr
   * Vectors was off by default: those it had on by default are off now,
   * with one click to turn them back on.
   */
  private tellNewDefaults(returning: boolean): void {
    const { catalogue, choices, resolution } = this.switches;
    const manifests = catalogue.map((e) => e.manifest);
    const ids = formerlyOnNowOff(manifests, choices, resolution.enabled, returning, defaultsTold());
    noteDefaultsTold();
    if (ids.length === 0) return;
    const names = listNames(ids.map((id) => manifests.find((m) => m.id === id)?.name ?? id));
    const one = ids.length === 1;
    offer(
      `${names} ${one ? "is" : "are"} now off until you turn ${one ? "it" : "them"} on.`,
      [
        { label: "Show Plugins", run: () => this.docks.show("plugins") },
        { label: "Turn back on", primary: true, run: () => void this.turnOnPlugins(ids) },
      ],
      60000,
    );
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
      const message = "This workspace has Zarr Vectors data: turn on Zarr Vectors in Plugins.";
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
    this.setViewShare(Number(prefs.get("viewShare") ?? "50"));
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

  /** The view beside the viewer takes `share` per cent of the width (15 to 85); returns what it took. */
  private setViewShare(share: number): number {
    const kept = Math.min(85, Math.max(15, Number.isFinite(share) ? share : 50));
    this.viewArea.style.flexBasis = `${kept}%`;
    describeSize(this.viewSplit, kept, 15, 85);
    return kept;
  }

  /** Dragging the split between the viewer and a view beside it: kept once let go, not at every move. */
  private dragViewSplit(event: PointerEvent, engine: HTMLElement): void {
    event.preventDefault();
    const box = engine.getBoundingClientRect();
    let share: number | undefined;
    followDrag(
      window,
      (e) => (share = this.setViewShare((100 * (box.right - e.clientX)) / box.width)),
      () => {
        if (share !== undefined) prefs.set("viewShare", share.toFixed(1));
      },
    );
  }

  /** The split with the keyboard: Left widens the view beside the viewer, Right narrows it (Shift for more). */
  private stepViewSplit(e: KeyboardEvent): void {
    const now = Number(this.viewSplit.getAttribute("aria-valuenow") ?? "50");
    const step = e.shiftKey ? 10 : 2;
    const share = e.key === "ArrowLeft" ? now + step : e.key === "ArrowRight" ? now - step : e.key === "Home" ? 15 : e.key === "End" ? 85 : undefined;
    if (share === undefined) return;
    e.preventDefault();
    prefs.set("viewShare", this.setViewShare(share).toFixed(1));
  }

  // -------------------------------------------------------------- open

  private openExample(id: string): void {
    const example = this.wb.examples.get(id);
    if (example === undefined) throw new CommandError(`no example ${id}`);
    this.switchOnForTab(example.plugins ?? []);
    this.wb.store.open(example.state(), `the example “${example.title}”`);
  }

  /** Opens whatever was pasted or linked; returns whether it worked. */
  async openText(text: string, from: string, asScene: boolean, resume?: HistoryData): Promise<boolean> {
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
        else store.open(parsed.state, from, { resume });
      } else if (parsed.kind === "remote") {
        this.setStatus("busy", "Fetching state");
        let json: unknown;
        try {
          json = await fetchRemoteState(parsed.url);
        } catch (e) {
          throw new InputError(`Could not read the state at ${parsed.url}: ${(e as Error).message}`);
        }
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
      { label: "Copy workspace link", run: run("workspace.share") },
      { label: "Save workspace as a file", run: run("workspace.saveFile") },
      { label: "Copy scene as Neuroglancer link", run: run("workspace.copyPlainLink") },
      { label: "Copy scene as Neuroglancer JSON", run: run("workspace.copyState") },
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
        const kind = scene.kind === undefined ? undefined : this.sceneKinds().find((k) => k.kind === scene.kind);
        return h(
          "div",
          {
            class: scene.kind === undefined ? "scene-tab" : `scene-tab scene-kind scene-kind-${scene.kind}`,
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
              // Arrow keys move between scenes (only the active tab is in the tab order).
              if (k.key === "ArrowLeft" || k.key === "ArrowRight") {
                const next = p.scenes[index + (k.key === "ArrowLeft" ? -1 : 1)];
                if (next === undefined) return;
                k.preventDefault();
                store.switchScene(next.id);
                requestAnimationFrame(() => this.sceneTabs.querySelector<HTMLElement>('.scene-tab[aria-selected="true"]')?.focus());
              }
            },
          },
          kind ? h("span", { class: "scene-kind-mark", title: kind.title, "aria-hidden": "true" }) : null,
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
      // Kinds of scene the plugins that are on add: a tab that runs the plugin's add command
      // (always there), or, not made yet, a tab that makes one.
      ...this.sceneKinds()
        .filter((k) => k.add !== undefined || !p.scenes.some((s) => s.kind === k.kind))
        .map((k) => {
          const open = () => (k.add !== undefined ? this.wb.run(k.add.command) : store.newScene({ name: k.title, kind: k.kind }));
          return h(
            "div",
            {
              class: `scene-tab scene-kind scene-kind-${k.kind} scene-kind-new${k.add ? " scene-kind-add" : ""}`,
              role: "button",
              tabindex: 0,
              title: k.add ? k.add.title : `Open ${k.title}`,
              onclick: open,
              onkeydown: (e: Event) => {
                if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
                  e.preventDefault();
                  open();
                }
              },
            },
            h("span", { class: "scene-kind-mark", "aria-hidden": "true" }),
            h("span", { class: "scene-tab-name" }, k.add ? k.add.title : k.title),
            k.add ? icon("plus") : null,
          );
        }),
    );
  }

  /**
   * What a Neuroglancer elsewhere cannot read of this scene: data on this
   * computer, images this site computes (they are answered by this tab), and
   * gs+google:// data (this site's sign-in).
   */
  private unreadableElsewhere(): string[] {
    const sources = this.wb.engine.layers().flatMap((l) => l.sources);
    return [
      ...(this.usesLocalData() ? ["data on this computer"] : []),
      ...(sources.some((s) => s.includes("/virtual/ngp/")) ? ["images computed in this tab (Filters)"] : []),
      ...(sources.some((s) => s.includes("gs+google://")) ? ["gs+google:// data (this site's Google sign-in)"] : []),
    ];
  }

  /** The kinds of scene the plugins that are on contribute. */
  private sceneKinds(): { kind: string; title: string; panel?: string; add?: { title: string; command: string } }[] {
    const s = this.wb.pluginSwitches;
    return s.manifests.filter((m) => s.enabled.has(m.id)).flatMap((m) => m.contributes?.sceneKinds ?? []);
  }

  /** On switching to a scene of a plugin's kind, its panel. */
  private showKindPanel(): void {
    const scene = activeScene(this.wb.store.state());
    if (scene.id === this.kindShownFor) return;
    this.kindShownFor = scene.id;
    const panel = scene.kind === undefined ? undefined : this.sceneKinds().find((k) => k.kind === scene.kind)?.panel;
    if (panel !== undefined) this.docks.show(panel);
  }

  private kindShownFor: string | undefined;

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
    const jobs =
      this.wb.jobs.running() +
      [this.wb.runner, ...this.wb.hosts.others().map((name) => this.wb.hosts.runner(name))].reduce((n, r) => n + (r?.jobs().filter((j) => j.state === "running" && j.kind !== "serve").length ?? 0), 0);
    const failed = layers.filter((l) => l.error !== undefined).length;
    const loading = layers.filter((l) => !l.ready && l.error === undefined).length;
    const n = layersOf(this.wb.store.ng()).length;
    if (n === 0 && jobs === 0) this.setStatus("idle", "Empty scene");
    else if (failed > 0) this.setStatus("err", `${failed} of ${layers.length} failed to load`);
    else if (loading > 0) this.setStatus("busy", `Loading ${loading} of ${layers.length}`);
    else if (jobs > 0) this.setStatus("busy", `${jobs} job${jobs === 1 ? "" : "s"} running`);
    else this.setStatus("ok", `${layers.length} layer${layers.length === 1 ? "" : "s"} ready`);
  }

  /**
   * Files and folders dropped anywhere on the window open as Open from
   * device opens them: read in place, as virtual stores where they are not
   * Zarr already.  A hint covers the window while files are dragged over it.
   */
  private acceptDrops(): void {
    const hint = h("div", { class: "drop-hint", hidden: true }, h("div", {}, icon("open"), h("span", {}, "Drop files or folders to open them"), h("small", {}, "Read in place, nothing is uploaded")));
    document.body.append(hint);
    const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") === true;
    let depth = 0;
    window.addEventListener("dragenter", (e) => {
      if (!carriesFiles(e)) return;
      depth++;
      hint.hidden = false;
    });
    window.addEventListener("dragleave", (e) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) hint.hidden = true;
    });
    window.addEventListener(
      "dragover",
      (e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "copy";
      },
      { capture: true },
    );
    window.addEventListener(
      "drop",
      (e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth = 0;
        hint.hidden = true;
        this.wb.store.noteInput();
        // What was dropped is taken now (the browser lets go of it after the event); a tractogram past the
        // browser's storage limit asks first: a sample here, or the runner on this computer.
        const files = Array.from(e.dataTransfer!.files).map((f) => ({ name: f.name, size: f.size }));
        const dropped = collectDropped(e.dataTransfer!);
        void (async () => {
          const { open, sample } = await offerRunnerForLarge(this.wb, this.wb.runner, files);
          // A sample's dataset says so in its name: "t17m (1 in 10)".
          const stem = sample?.name.replace(/\.(trk|tck|trx)$/i, "");
          if (open) await openDroppedItems(this.wb, dropped, (name) => (name === stem ? `${name} (1 in ${sample!.every.toLocaleString("en")})` : name));
        })().catch((err) => toast(`Could not open what was dropped: ${(err as Error).message}`, "error"));
      },
      { capture: true },
    );
  }

  /**
   * The history menu: every change in this workspace, newest at the top,
   * with what it was and when.  Undone changes are greyed until redone;
   * choosing a row goes back or forward to it.
   */
  private showHistory(): void {
    void historyView().then(({ closeHistoryView, showHistoryView }) => {
      if (closeHistoryView()) return;
      showHistoryView(this.historyButton, this.wb.store);
    });
  }

  /**
   * Saves the history tree in this browser a second after each change
   * settles, and when the page is hidden or left, filed under the link.
   */
  private keepHistory(keep: HistoryKeep): void {
    const store = this.wb.store;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      clearTimeout(timer);
      timer = undefined;
      if (store.currentHash !== "") void keep.save(store.currentHash, store.history.export());
    };
    store.onChange(() => {
      clearTimeout(timer);
      timer = setTimeout(save, 1000);
    });
    const flush = () => {
      if (timer !== undefined) save();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
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
