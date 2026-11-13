/**
 * The platform's dialogs: Open, Add dataset, Settings, Keyboard shortcuts
 * and Edit state.  Settings and the view bindings are Neuroglancer's own
 * panels, shown here instead of over the views.
 */
import { logFileName } from "../core/errors.js";
import { shortcutRows } from "../core/keybindings.js";
import { InputError, layerCount, parseInput } from "../core/state_io.js";
import { layerNameFor } from "../core/state_io.js";
import { closeSheet, sheet, showSheet, toast } from "./overlays.js";
import { type DroppedItem, LocalData, type FoundDataset, type LocalEntry } from "../virtual/local_data.js";
import { checkbox, downloadBlob, info, roving } from "../sdk/dom.js";
import { clear, h, icon, keyLabel } from "./dom.js";
import { kindLabel } from "./panels/format.js";
import { renderOverviewSettings } from "./overview.js";
import { renderAuthPanel } from "./panels/auth.js";
import { renderStatisticsPanel } from "./panels/misc.js";
import { renderRemotePanel } from "./panels/remote.js";
import { renderAbout } from "./about.js";
import { setTractogramDiskGigabytes, setVectorCacheMegabytes, tractogramDiskGigabytes, vectorCacheMegabytes } from "../virtual/vectors/formats.js";
import type { Workbench } from "./workbench.js";

// -------------------------------------------------------------------- open

export interface OpenActions {
  /** Opens pasted text; `asScene` opens a state as a new scene instead of replacing the workspace. */
  openText(text: string, from: string, asScene: boolean): Promise<boolean>;
  openExample(id: string): void;
}

/**
 * Asks for a file (or folder) on this device with the system's file picker
 * and adds what it holds as datasets of the scene; false when nothing was.
 */
export async function openFromDevice(wb: Workbench, folder: boolean): Promise<boolean> {
  const entry = await wb.localData.pick(folder);
  return entry !== undefined && (await addLocalEntry(wb, entry));
}

/**
 * Opens what was dropped on the window (files or folders): read in place,
 * as Open a file… reads them.  `dropped` is taken from the drop event
 * itself (`collectDropped`), which the browser empties once it returns.
 */
export async function openDroppedItems(wb: Workbench, dropped: Promise<DroppedItem[]>, name?: (name: string) => string): Promise<boolean> {
  const entry = await wb.localData.openDropped(dropped);
  return entry !== undefined && (await addLocalEntry(wb, entry, name));
}

/** Adds what a local entry holds as datasets of the scene; false when it holds nothing readable. */
async function addLocalEntry(wb: Workbench, entry: LocalEntry, name: (name: string) => string = (n) => n): Promise<boolean> {
  const local = wb.localData;
  const datasets = await local.detect(entry.id);
  if (datasets.length === 0) {
    toast(`Nothing readable in ${entry.name}. Open a file or folder of: ${LOCAL_FORMATS}.`, "error");
    void local.forget(entry.id);
    return false;
  }
  for (const dataset of datasets) wb.store.addDataset({ source: dataset.source, name: name(dataset.name), kind: dataset.kind, layer: dataset.layer });
  wb.docks.show("layer");
  return true;
}

/** What Open a file… reads, for messages. */
const LOCAL_FORMATS = "NIfTI, FreeSurfer .mgz/.mgh, NumPy .npy, TIFF stacks, tractograms (.trk, .tck, .trx), meshes and surfaces (.obj, .stl, .ply, .gii, FreeSurfer), SWC neurons, point tables (.csv, .xyz) and LAS point clouds, OME-Zarr, zarr-vectors and precomputed";

/** The datasets other scenes of the workspace show and this one does not, each added to this scene with a click. */
function otherScenes(wb: Workbench): HTMLElement {
  const { store } = wb;
  const datasets = store.datasetsNotInScene();
  if (datasets.length === 0) return h("span");
  return h(
    "div",
    { class: "section open-other-scenes" },
    h("h3", { class: "section-title" }, "In other scenes"),
    h(
      "div",
      { class: "list" },
      ...datasets.map((d) => {
        const scenes = store.scenesShowing(d.id);
        return h(
          "button",
          {
            class: "ds-row other pick",
            type: "button",
            title: `Add “${d.name}” to this scene`,
            onclick: () => {
              store.showDataset(d.id);
              closeSheet();
              wb.docks.show("layer");
            },
          },
          h("span", { class: "ds-icon" }, icon("database")),
          h("span", { class: "ds-name" }, d.name),
          h("span", { class: "type" }, kindLabel(d.kind)),
          h("span", { class: "ds-icon" }, icon("plus")),
          h("span", { class: "sub" }, scenes.length ? `in ${scenes.join(", ")}` : "in no scene"),
        );
      }),
    ),
  );
}

export function showOpenSheet(wb: Workbench, actions: OpenActions): void {
  const input = h("textarea", {
    class: "state-input",
    id: "open-input",
    placeholder: "Paste a Neuroglancer link, state JSON or data URL",
    "aria-label": "Link, state or data URL",
    spellcheck: "false",
  });
  const asSceneLabel = checkbox("As a new scene", false, () => describe());
  const asScene = asSceneLabel.input;
  asScene.id = "open-as-scene";
  const detected = h("span", { class: "detected" });
  const openButton = h("button", { class: "btn primary", type: "button", disabled: true }, "Open");
  const describe = () => {
    asSceneLabel.hidden = true;
    if (input.value.trim() === "") {
      detected.textContent = "";
      detected.classList.remove("bad");
      openButton.disabled = true;
      return;
    }
    const handler = wb.openHandlers.match(input.value);
    if (handler !== undefined) {
      detected.classList.remove("bad");
      detected.textContent = handler.title ?? `Opens with ${handler.owner ?? "a plugin"}.`;
      openButton.disabled = false;
      openButton.textContent = "Open";
      return;
    }
    try {
      const parsed = parseInput(input.value, wb.parseFragment);
      detected.classList.remove("bad");
      openButton.disabled = false;
      if (parsed.kind === "state") {
        const n = layerCount(parsed.state.ng);
        const scenes = (parsed.state.app.platform as { scenes?: unknown[] } | undefined)?.scenes?.length ?? 0;
        asSceneLabel.hidden = scenes > 1;
        detected.textContent = `Neuroglancer state, ${n} layer${n === 1 ? "" : "s"}${scenes > 1 ? `, ${scenes} scenes` : ""}. ${asScene.checked && scenes <= 1 ? "Opens as a new scene." : "Replaces the workspace."}`;
        openButton.textContent = "Open";
      } else if (parsed.kind === "remote") {
        asSceneLabel.hidden = false;
        detected.textContent = "A state stored at a URL. It will be fetched and opened.";
        openButton.textContent = "Fetch and open";
      } else {
        detected.textContent = `A data source. Adds the dataset “${parsed.name}” to this scene.`;
        openButton.textContent = "Add dataset";
      }
    } catch (e) {
      detected.textContent = (e as Error).message;
      detected.classList.add("bad");
      openButton.disabled = true;
    }
  };
  input.addEventListener("input", describe);
  // Closed by its own handle after the wait: a confirm may have come and gone above it meanwhile.
  let close = () => {};
  const submit = async () => {
    if (openButton.disabled) return;
    if (await actions.openText(input.value, "pasted text", asScene.checked)) close();
  };
  openButton.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  });
  const examples = wb.examples.list().filter((e) => e.listed !== false);
  const fromDevice = (folder: boolean) => async () => {
    try {
      if (await openFromDevice(wb, folder)) close();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  close = showSheet(
    sheet(
      "Open",
      [
        ...(LocalData.supported
          ? [h(
              "div",
              { class: "row-actions open-device" },
              h("button", { class: "btn primary", type: "button", title: `Read in place, not uploaded: ${LOCAL_FORMATS}`, onclick: fromDevice(false) }, icon("open"), "Open a file…"),
              h("button", { class: "btn outline", type: "button", onclick: fromDevice(true) }, "Folder…"),
            )]
          : []),
        input,
        asSceneLabel,
        otherScenes(wb),
        h("h3", { class: "section-title" }, "Examples"),
        h(
          "div",
          { class: "examples" },
          ...examples.map((example) =>
            h(
              "div",
              { class: "example" },
              h("span", { class: "title" }, example.title),
              h(
                "span",
                { class: "desc" },
                example.description + (example.remote && wb.framed ? " Needs a hosted copy of the app: this frame only reaches files bundled with it." : ""),
              ),
              h(
                "button",
                {
                  class: "btn outline",
                  type: "button",
                  disabled: example.remote && wb.framed,
                  onclick: () => {
                    closeSheet();
                    actions.openExample(example.id);
                  },
                },
                "Open",
              ),
            ),
          ),
        ),
      ],
      [detected, h("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"), openButton],
    ),
  );
  describe();
  input.focus();
}

// ------------------------------------------------------------- add dataset

const TYPES: [string, string][] = [
  ["auto", "Detect from the source"],
  ["image", "Image"],
  ["segmentation", "Segmentation"],
  ["annotation", "Annotations"],
  ["mesh", "Mesh"],
];

export function showAddDatasetSheet(wb: Workbench): void {
  const { store } = wb;
  const url = h("input", {
    class: "text-input mono",
    type: "text",
    id: "dataset-url",
    placeholder: "https://…/store.zarrvectors/|zarr-vectors:   or   precomputed://gs://…",
    "aria-label": "Data source URL",
    spellcheck: "false",
  });
  const name = h("input", { class: "text-input", type: "text", id: "dataset-name", placeholder: "From the URL", "aria-label": "Name" });
  const type = h("select", { class: "text-input", id: "dataset-type", "aria-label": "Show as" });
  for (const [value, label] of TYPES) type.append(h("option", { value }, label));
  const note = h("span", { class: "detected" });
  const add = h("button", { class: "btn primary", type: "button", disabled: true }, "Add");
  const update = () => {
    const value = url.value.trim();
    add.disabled = value === "";
    name.placeholder = value === "" ? "From the URL" : layerNameFor(value);
  };
  url.addEventListener("input", update);
  const submit = () => {
    const source = url.value.trim();
    if (source === "") return;
    const id = store.addDataset({ source, name: name.value.trim() || layerNameFor(source), kind: type.value });
    closeSheet();
    wb.log.add(`Added the dataset “${store.dataset(id)?.name}”.`, "ok");
    wb.docks.show("layer");
  };
  add.addEventListener("click", submit);
  url.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  const library = store.datasetsNotInScene();
  showSheet(
    sheet(
      "Add a dataset to this scene",
      [
        h("label", { class: "field" }, h("span", {}, "Source"), url),
        h("div", { class: "field-row" }, h("label", { class: "field" }, h("span", {}, "Name"), name), h("label", { class: "field" }, h("span", {}, "Show as"), type)),
        library.length
          ? h(
              "div",
              { class: "section" },
              h("h3", { class: "section-title" }, "From this workspace"),
              h(
                "div",
                { class: "list" },
                ...library.map((d) =>
                  h(
                    "button",
                    {
                      class: "ds-row other pick",
                      type: "button",
                      onclick: () => {
                        store.showDataset(d.id);
                        closeSheet();
                        wb.docks.show("layer");
                      },
                    },
                    h("span", { class: "ds-icon" }, icon("database")),
                    h("span", { class: "ds-name" }, d.name),
                    h("span", { class: "type" }, kindLabel(d.kind)),
                    h("span", { class: "ds-icon" }, icon("plus")),
                  ),
                ),
              ),
            )
          : h("span"),
      ],
      [note, h("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"), add],
    ),
  );
  url.focus();
}

// ------------------------------------------------------------ local data

/** Opens data on this computer: pick a folder or a file, then choose what in it to add. */
export function showLocalSheet(wb: Workbench, local: LocalData): void {
  const found = h("div", { class: "list" });
  const status = h("span", { class: "detected" });
  const add = h("button", { class: "btn primary", type: "button", disabled: true }, "Add");
  let choices: { dataset: FoundDataset; box: HTMLInputElement }[] = [];
  const pick = async (folder: boolean) => {
    status.textContent = "Opening…";
    try {
      const entry = await local.pick(folder);
      if (entry === undefined) {
        status.textContent = "";
        return;
      }
      const datasets = await local.detect(entry.id);
      const rows = datasets.map((dataset) => ({ dataset, pick: checkbox(dataset.name, true, () => {}) }));
      choices = rows.map(({ dataset, pick }) => ({ dataset, box: pick.input }));
      clear(
        found,
        ...rows.map(({ dataset, pick }) =>
          h(
            "div",
            { class: "ds-row local-pick" },
            pick,
            h("span", { class: "type" }, dataset.format),
            h("span", { class: "sub" }, dataset.path ? `${entry.name}/${dataset.path}` : entry.name),
          ),
        ),
      );
      add.disabled = choices.length === 0;
      status.classList.toggle("bad", choices.length === 0);
      status.textContent = choices.length
        ? ""
        : `Nothing readable in ${entry.name}. Choose a file or folder of: ${LOCAL_FORMATS}.`;
    } catch (e) {
      status.textContent = (e as Error).message;
      status.classList.add("bad");
    }
  };
  add.addEventListener("click", () => {
    for (const { dataset, box } of choices) {
      if (box.checked) wb.store.addDataset({ source: dataset.source, name: dataset.name, kind: dataset.kind, layer: dataset.layer });
    }
    closeSheet();
    wb.docks.show("layer");
  });
  showSheet(
    sheet(
      "Open from this computer",
      [
        h(
          "div",
          { class: "row-actions" },
          h("button", { class: "btn outline", type: "button", onclick: () => void pick(true) }, icon("open"), "Folder…"),
          h("button", { class: "btn outline", type: "button", onclick: () => void pick(false) }, icon("open"), "File…"),
          info(
            `Read in place, not uploaded. Links to it work only in this browser, while this tab is open.${LocalData.canWrite ? "" : " This browser cannot remember folders or write into them: use Chrome or Edge for that."}`,
            "About local data",
          ),
        ),
        found,
      ],
      [status, h("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"), add],
    ),
  );
}

// ---------------------------------------------------------------- settings

/** The sections of Settings, by the id `settings.open` takes. */
export const SETTINGS_SECTIONS = { view: "View", "sign-in": "Sign-in", compute: "Compute", storage: "Storage", developer: "Developer", about: "About" } as const;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

/**
 * Settings: the views (saved with the workspace), the sign-ins and the
 * computers this browser uses, what it keeps of local data, and tools for
 * developers.  One section at a time, each made when chosen.
 */
export function showSettingsSheet(wb: Workbench, section: SettingsSection = "view"): void {
  const nav = h("div", { class: "segmented settings-nav", role: "tablist", "aria-label": "Settings" });
  const body = h("div", { class: "settings-body", id: "settings-section", role: "tabpanel" });
  let dispose: (() => void) | undefined;
  const tabs = () => [...nav.querySelectorAll<HTMLButtonElement>("button")];
  // Left and Right go from section to section, as on any row of tabs.
  const keys = roving(nav, { items: tabs, orientation: "horizontal", tabStop: true, onMove: (b) => b.click() });
  const choose = (id: SettingsSection) => {
    dispose?.();
    dispose = undefined;
    body.replaceChildren();
    for (const b of tabs()) {
      const on = b.dataset.section === id;
      b.setAttribute("aria-selected", String(on));
      if (on) {
        body.setAttribute("aria-labelledby", b.id);
        keys.sync(b);
      }
    }
    dispose = SECTION_RENDER[id](body, wb);
  };
  for (const [id, title] of Object.entries(SETTINGS_SECTIONS) as [SettingsSection, string][]) {
    nav.append(
      h("button", { type: "button", role: "tab", id: `settings-tab-${id}`, "data-section": id, "aria-selected": "false", "aria-controls": "settings-section", onclick: () => choose(id) }, title),
    );
  }
  showSheet(sheet("Settings", [nav, body], [h("button", { class: "btn primary", type: "button", onclick: () => closeSheet() }, "Done")], { wide: true }), () => dispose?.());
  choose(section in SETTINGS_SECTIONS ? section : "view");
  // The keyboard starts on the section shown.
  nav.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
}

const SECTION_RENDER: Record<SettingsSection, (host: HTMLElement, wb: Workbench) => (() => void) | undefined> = {
  view: (host, wb) => {
    const settings = h("div", { class: "view-settings" });
    const dispose = wb.engine.mountSettings(settings);
    settings.append(
      h(
        "section",
        {},
        h(
          "h3",
          { class: "section-title" },
          "In this browser",
          info("Kept in this browser. The groups above are saved with the workspace.", "About In this browser"),
        ),
        h(
          "div",
          { class: "options" },
          h("div", { class: "row-actions" }, h("button", { class: "btn outline", type: "button", onclick: () => wb.run("view.panelConvention") }, "Orientation of the views…")),
        ),
      ),
    );
    host.append(settings);
    return dispose;
  },
  "sign-in": (host, wb) => renderAuthPanel(host, wb),
  compute: (host, wb) => renderRemotePanel(host, wb),
  about: (host, wb) => renderAbout(host, wb),
  storage: (host, wb) => {
    const overviews = h("div", { class: "section overview-section" });
    renderOverviewSettings(overviews, wb);
    // Kept in this browser, not the workspace: what the tab may hold of large local files.
    const cache = h("input", { class: "text-input", type: "number", min: "0", step: "64", value: String(vectorCacheMegabytes()), "aria-label": "Memory for tractogram cells, MB" }) as HTMLInputElement;
    cache.addEventListener("change", () => setVectorCacheMegabytes(Math.max(0, Number(cache.value) || 0)));
    const disk = h("input", { class: "text-input", type: "number", min: "0", step: "1", placeholder: "4", value: String(tractogramDiskGigabytes() ?? ""), "aria-label": "Browser storage for a tractogram, GB" }) as HTMLInputElement;
    disk.addEventListener("change", () => setTractogramDiskGigabytes(disk.value.trim() === "" || !(Number(disk.value) >= 0) ? undefined : Number(disk.value)));
    host.append(
      overviews,
      h("h3", { class: "section-title" }, "Local tractograms"),
      h(
        "label",
        {
          class: "field",
          title:
            "Kept in this browser. A large tractogram's points are copied into cells in the browser's private storage while it is open (about 1.2 to 1.5 times the file's size, deleted when it closes); only the cells last used stay in memory. 0 is automatic: 1/32 of this device's memory, 64 to 512 MB.",
        },
        h("span", {}, "Memory for cells (MB, 0 = automatic)"),
        cache,
      ),
      h(
        "label",
        {
          class: "field",
          title:
            "Kept in this browser. Reading a tractogram copies its points into the browser's storage, about 1.5 times the file, while it is open. Past this limit only a sample is copied (1 in 10, 100, … streamlines), and the runner on this computer is offered for the whole file. Never more than 10% of the browser's quota or 80% of what is free. Empty: 4 GB. 0: nothing on disk (a sample of up to 256 MB in memory).",
        },
        h("span", {}, "Storage per tractogram (GB, empty = 4)"),
        disk,
      ),
    );
    return undefined;
  },
  developer: (host, wb) => {
    const statistics = h("div", { class: "settings-statistics" });
    host.append(
      h(
        "div",
        { class: "row-actions" },
        h("button", { class: "btn outline small", type: "button", onclick: () => wb.run("view.reloadLayers") }, "Reload the scene's layers"),
        h("button", { class: "btn outline small", type: "button", title: "Reloads the page, checking every file with its server", onclick: () => wb.run("view.hardReset") }, "Reload page and all data"),
        h("button", { class: "btn outline small", type: "button", onclick: () => wb.run("workspace.editState") }, "Edit the state as JSON…"),
        h(
          "button",
          { class: "btn outline small", type: "button", title: "The Activity log, errors included, as a text file", onclick: () => downloadBlob(new Blob([wb.log.text()], { type: "text/plain" }), logFileName(new Date())) },
          "Save log",
        ),
      ),
      h("h3", { class: "section-title" }, "Chunk statistics"),
      statistics,
    );
    return renderStatisticsPanel(statistics, wb);
  },
};

// --------------------------------------------------------------- shortcuts

/** The keys and clicks most used, in plain words; the rest are under All keys. */
const COMMON_KEYS: [string[], string][] = [
  [["Mod+K"], "All commands"],
  [["Mod+O"], "Open"],
  [["Shift+N"], "Add data"],
  [["Mod+Z"], "Undo"],
  [["Mod+Shift+Z"], "Redo"],
  [["1–9"], "Show or hide a dataset"],
  [["Space"], "Change the layout"],
  [["drag"], "Move the section; turn the 3-D view"],
  [["Shift", "drag"], "Turn the section; move the 3-D view"],
  [["wheel"], "Next or previous section"],
  [["Ctrl", "wheel"], "Zoom"],
  [["right-click"], "Go to the point"],
  [["double-click"], "Select a segment"],
  [["Ctrl", "click"], "Draw with the annotation tool on"],
  [["S"], "Show or hide the sections in 3-D"],
  [["Alt+PageDown"], "Next scene"],
];

export function showShortcutsSheet(wb: Workbench): void {
  const common = h("dl", { class: "facts keys" });
  for (const [keys, title] of COMMON_KEYS) {
    common.append(h("dt", {}, ...keys.map((key) => h("kbd", {}, /^[a-z-]+$/.test(key) ? key : keyLabel(key)))), h("dd", {}, title));
  }
  const table = h("dl", { class: "facts keys" });
  for (const row of shortcutRows(wb.keybindings.list(), (id) => wb.commands.get(id)?.title)) {
    table.append(h("dt", {}, ...row.keys.map((key) => h("kbd", {}, keyLabel(key)))), h("dd", {}, row.title));
  }
  const views = h("div", { class: "ng-host bindings-host" });
  let unmount: (() => void) | undefined;
  // Neuroglancer's own list of its bindings, made when opened.
  const all = h("details", { class: "keys-all" }, h("summary", {}, "All keys"), table, h("h3", { class: "section-title" }, "In the views"), views);
  all.addEventListener("toggle", () => {
    if (all.open && unmount === undefined) unmount = wb.engine.mountBindingsHelp(views);
  });
  showSheet(
    sheet("Keyboard and mouse", [common, all], [h("button", { class: "btn primary", type: "button", onclick: () => closeSheet() }, "Done")], { wide: true }),
    () => unmount?.(),
  );
}

// -------------------------------------------------------------- edit state

export function showEditStateSheet(wb: Workbench, apply: (text: string) => Promise<boolean>): void {
  const area = h("textarea", { class: "state-input tall", id: "state-editor", spellcheck: "false", "aria-label": "Workspace state" });
  area.value = JSON.stringify(wb.store.workspace(), null, 2);
  const status = h("span", { class: "detected", title: "{ng: this scene's Neuroglancer state, app: scenes, datasets and plugin state}" });
  const applyButton = h("button", { class: "btn primary", type: "button" }, "Apply");
  let close = () => {};
  applyButton.addEventListener("click", async () => {
    try {
      JSON.parse(area.value);
    } catch (e) {
      status.textContent = `Does not parse: ${(e as Error).message}`;
      status.classList.add("bad");
      return;
    }
    if (await apply(area.value)) close();
  });
  close = showSheet(
    sheet("Edit state", [area], [status, h("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"), applyButton], { wide: true }),
  );
  area.focus();
}

export { InputError, toast };
