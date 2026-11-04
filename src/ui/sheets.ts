/**
 * The platform's dialogs: Open, Add dataset, Settings, Keyboard shortcuts
 * and Edit state.  Settings and the view bindings are Neuroglancer's own
 * panels, shown here instead of over the views.
 */
import { InputError, layerCount, parseInput } from "../core/state_io.js";
import { layerNameFor } from "../core/state_io.js";
import { closeSheet, sheet, showSheet, toast } from "./overlays.js";
import { collectDropped, LocalData, type FoundDataset, type LocalEntry } from "../virtual/local_data.js";
import { clear, h, icon, keyLabel } from "./dom.js";
import { kindLabel } from "./panels/format.js";
import { renderOverviewSettings } from "./overview.js";
import { setVectorCacheMegabytes, vectorCacheMegabytes } from "../virtual/vectors/formats.js";
import type { Workbench } from "./workbench.js";

// -------------------------------------------------------------------- open

export interface OpenActions {
  /** Opens pasted text; `asScene` opens a state as a new scene instead of replacing the workspace. */
  openText(text: string, from: string, asScene: boolean): Promise<boolean>;
  openExample(id: string): void;
  /** A new, empty scene. */
  openBlank(): void;
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
 * as Open from device reads them.  Call it from the drop event itself.
 */
export async function openDropped(wb: Workbench, transfer: DataTransfer): Promise<boolean> {
  const entry = await wb.localData.openDropped(collectDropped(transfer));
  return entry !== undefined && (await addLocalEntry(wb, entry));
}

/** Adds what a local entry holds as datasets of the scene; false when it holds nothing readable. */
async function addLocalEntry(wb: Workbench, entry: LocalEntry): Promise<boolean> {
  const local = wb.localData;
  const datasets = await local.detect(entry.id);
  if (datasets.length === 0) {
    toast(`Nothing to open in ${entry.name}. Files: ${LOCAL_FORMATS}.`, "error");
    void local.forget(entry.id);
    return false;
  }
  for (const dataset of datasets) wb.store.addDataset({ source: dataset.source, name: dataset.name, kind: dataset.kind, layer: dataset.layer });
  wb.docks.show("layer");
  return true;
}

/** What Open from device reads, for messages. */
const LOCAL_FORMATS = "NIfTI, FreeSurfer .mgz/.mgh, NumPy .npy, TIFF stacks, tractograms (.trk, .tck, .trx), meshes and surfaces (.obj, .stl, .ply, .gii, FreeSurfer), SWC neurons, point tables (.csv, .xyz) and LAS point clouds, OME-Zarr, zarr-vectors and precomputed";

export function showOpenSheet(wb: Workbench, actions: OpenActions): void {
  const input = h("textarea", {
    class: "state-input",
    id: "open-input",
    placeholder: 'https://…/#!{…}   or   {"layers": …}   or   gs://bucket/store.zarrvectors/|zarr-vectors:',
    "aria-label": "Link, state or data URL",
    spellcheck: "false",
  });
  const asScene = h("input", { type: "checkbox", id: "open-as-scene" });
  const asSceneLabel = h("label", { class: "field check" }, asScene, h("span", {}, "Open as a new scene, keeping this workspace"));
  const detected = h("span", { class: "detected" }, "Paste something to open.");
  const openButton = h("button", { class: "btn primary", type: "button", disabled: true }, "Open");
  const describe = () => {
    asSceneLabel.hidden = true;
    if (input.value.trim() === "") {
      detected.textContent = "Paste something to open.";
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
  asScene.addEventListener("change", describe);
  const submit = async () => {
    if (openButton.disabled) return;
    if (await actions.openText(input.value, "pasted text", asScene.checked)) closeSheet();
  };
  openButton.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  });
  const examples = wb.examples.list();
  const fromDevice = (folder: boolean) => async () => {
    try {
      if (await openFromDevice(wb, folder)) closeSheet();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const card = (title: string, desc: string, run: () => void, disabled = false) =>
    h(
      "div",
      { class: "example" },
      h("span", { class: "title" }, title),
      h("span", { class: "desc" }, desc),
      h("button", { class: "btn outline", type: "button", disabled, onclick: run }, "Open"),
    );
  showSheet(
    sheet(
      "Open",
      [
        ...(LocalData.supported
          ? [h(
              "div",
              { class: "row-actions open-device" },
              h("button", { class: "btn primary", type: "button", onclick: fromDevice(false) }, icon("open"), "Open from device…"),
              h("button", { class: "btn outline", type: "button", onclick: fromDevice(true) }, "Folder…"),
              h("span", { class: "note-inline" }, LOCAL_FORMATS + "; read in place, not uploaded."),
            )]
          : []),
        input,
        asSceneLabel,
        h("h3", { class: "section-title" }, "Examples and templates"),
        h(
          "div",
          { class: "examples" },
          card("Blank viewer", "An empty scene, beside the ones open now.", () => {
            closeSheet();
            actions.openBlank();
          }),
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
  const note = h("span", { class: "detected" }, "A URL Neuroglancer can read, with its format when it cannot be guessed.");
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
  const status = h("span", { class: "detected" }, "Nothing is uploaded: the viewer reads the files from here.");
  const add = h("button", { class: "btn primary", type: "button", disabled: true }, "Add");
  let choices: { dataset: FoundDataset; box: HTMLInputElement }[] = [];
  const pick = async (folder: boolean) => {
    status.textContent = "Opening…";
    try {
      const entry = await local.pick(folder);
      if (entry === undefined) {
        status.textContent = "Nothing picked.";
        return;
      }
      const datasets = await local.detect(entry.id);
      choices = datasets.map((dataset) => {
        const box = h("input", { type: "checkbox" });
        box.checked = true;
        return { dataset, box };
      });
      clear(
        found,
        ...choices.map(({ dataset, box }) =>
          h(
            "label",
            { class: "ds-row other pick" },
            box,
            h("span", { class: "ds-name" }, dataset.name),
            h("span", { class: "type" }, dataset.format),
            h("span", { class: "sub" }, dataset.path ? `${entry.name}/${dataset.path}` : entry.name),
          ),
        ),
      );
      add.disabled = choices.length === 0;
      status.classList.toggle("bad", choices.length === 0);
      status.textContent = choices.length
        ? `${choices.length} dataset${choices.length === 1 ? "" : "s"} in ${entry.name}.`
        : `No dataset found in ${entry.name}: it reads OME-Zarr, zarr-vectors, precomputed, NIfTI, tractograms and meshes (a folder of them is fine).`;
    } catch (e) {
      status.textContent = (e as Error).message;
      status.classList.add("bad");
    }
  };
  add.addEventListener("click", () => {
    for (const { dataset, box } of choices) {
      if (box.checked) wb.store.addDataset({ source: dataset.source, name: dataset.name, kind: dataset.kind });
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
        ),
        h(
          "p",
          { class: "note" },
          "A file (NIfTI, TIFF, a tractogram, mesh or surface, SWC, a point table) or a folder (OME-Zarr, zarr-vectors, precomputed, or several), read in place. ",
          "Links to it work only in this browser, while this tab is open.",
          LocalData.canWrite ? "" : " This browser cannot remember folders or write into them: use Chrome or Edge for that.",
        ),
        found,
      ],
      [status, h("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"), add],
    ),
  );
}

// ---------------------------------------------------------------- settings

export function showSettingsSheet(wb: Workbench): void {
  const panel = h("div", { class: "ng-host settings-host" });
  const overviews = h("div", { class: "section overview-section" });
  renderOverviewSettings(overviews, wb);
  let unmount: (() => void) | undefined;
  // Kept in this browser, not the workspace: what the tab may hold of large local files.
  const cache = h("input", { class: "text-input", type: "number", min: "0", step: "64", value: String(vectorCacheMegabytes()), "aria-label": "Memory for tractogram cells, MB" }) as HTMLInputElement;
  cache.addEventListener("change", () => setVectorCacheMegabytes(Math.max(0, Number(cache.value) || 0)));
  // Kept in this browser: offers of the plugins that are off (src/ui/plugin_offers.ts).
  const offers = h("input", { type: "checkbox", id: "show-offers" }) as HTMLInputElement;
  offers.checked = wb.offers.enabled;
  offers.addEventListener("change", () => wb.offers.setEnabled(offers.checked));
  showSheet(
    sheet(
      "View settings",
      [
        panel,
        h("p", { class: "note" }, "Saved with the workspace, so a shared link shows the same. Memory limits apply to this browser tab."),
        overviews,
        h(
          "label",
          { class: "field" },
          h("span", {}, "Tractograms on this computer: memory for decoded cells, MB (0: automatic, 1/32 of this device's memory, 64 to 512 MB)"),
          cache,
        ),
        h(
          "p",
          { class: "note" },
          "Kept in this browser. A large tractogram's points are copied into cells in the browser's private storage while it is open (about 1.2 to 1.5 times the file's size; deleted when it closes); only an index and the cells last used stay in memory.",
        ),
        h("label", { class: "field check" }, offers, h("span", {}, "Show offers for tools that are off")),
        h(
          "p",
          { class: "note" },
          "Kept in this browser. A plugin that is off is offered when you open data it works with. Ticking this again brings back the offers you said “Not now” to.",
        ),
      ],
      [h("button", { class: "btn primary", type: "button", onclick: () => closeSheet() }, "Done")],
    ),
    () => unmount?.(),
  );
  unmount = wb.engine.mountSettings(panel);
}

// --------------------------------------------------------------- shortcuts

export function showShortcutsSheet(wb: Workbench): void {
  const table = h("dl", { class: "facts keys" });
  for (const binding of wb.keybindings.list()) {
    const command = wb.commands.get(binding.command);
    if (command === undefined) continue;
    table.append(h("dt", {}, h("kbd", {}, keyLabel(binding.key))), h("dd", {}, command.title));
  }
  const views = h("div", { class: "ng-host bindings-host" });
  let unmount: (() => void) | undefined;
  showSheet(
    sheet(
      "Keyboard and mouse",
      [
        h("h3", { class: "section-title" }, "Workspace"),
        table,
        h("h3", { class: "section-title" }, "In the views"),
        views,
      ],
      [h("button", { class: "btn primary", type: "button", onclick: () => closeSheet() }, "Done")],
      { wide: true },
    ),
    () => unmount?.(),
  );
  unmount = wb.engine.mountBindingsHelp(views);
}

// -------------------------------------------------------------- edit state

export function showEditStateSheet(wb: Workbench, apply: (text: string) => Promise<boolean>): void {
  const area = h("textarea", { class: "state-input tall", id: "state-editor", spellcheck: "false", "aria-label": "Workspace state" });
  area.value = JSON.stringify(wb.store.workspace(), null, 2);
  const status = h("span", { class: "detected" }, "The whole workspace: {ng: this scene's Neuroglancer state, app: scenes, datasets and plugin state}.");
  const applyButton = h("button", { class: "btn primary", type: "button" }, "Apply");
  applyButton.addEventListener("click", async () => {
    try {
      JSON.parse(area.value);
    } catch (e) {
      status.textContent = `Does not parse: ${(e as Error).message}`;
      status.classList.add("bad");
      return;
    }
    if (await apply(area.value)) closeSheet();
  });
  showSheet(
    sheet("Edit state", [area], [status, h("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"), applyButton], { wide: true }),
  );
  area.focus();
}

export { InputError, toast };
