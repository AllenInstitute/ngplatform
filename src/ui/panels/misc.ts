/** The smaller panels: Statistics, Jobs and Plugins. */
import type { LocalPlugins, UrlPluginOffer } from "../../platform/local_plugins.js";
import type { Manifest } from "../../sdk/types.js";
import { clear, h, icon, iconButton } from "../dom.js";
import { renderMarkdown } from "../markdown.js";
import { closeSheet, sheet, showMenu, showSheet } from "../overlays.js";
import { renderRunnerSection } from "../runner.js";
import type { Workbench } from "../workbench.js";

// -------------------------------------------------------------- statistics

export function renderStatisticsPanel(host: HTMLElement, wb: Workbench): () => void {
  const panel = h("div", { class: "ng-host statistics-host" });
  host.append(panel);
  return wb.engine.mountStatistics(panel);
}

// -------------------------------------------------------------------- jobs

export function renderJobsPanel(host: HTMLElement, wb: Workbench): () => void {
  const list = h("div", { class: "jobs" });
  const runner = renderRunnerSection(wb, wb.runner);
  host.append(h("div", { class: "section" }, h("h3", { class: "section-title" }, "In this page"), list), runner.element);
  const render = () => {
    const jobs = wb.jobs.list();
    if (jobs.length === 0) {
      clear(list, h("p", { class: "empty" }, "No jobs running."));
      return;
    }
    clear(
      list,
      h("div", { class: "row-actions" }, h("button", { class: "btn small", type: "button", onclick: () => wb.jobs.clearFinished() }, "Clear finished")),
      ...jobs.map((job) => {
        const bar = h("div", { class: "bar" }, h("div", { class: "fill", style: `width:${Math.round((job.progress ?? (job.state === "running" ? 0.15 : 1)) * 100)}%` }));
        if (job.progress === undefined && job.state === "running") bar.classList.add("indeterminate");
        return h(
          "div",
          { class: `job ${job.state}` },
          h("span", { class: "job-title" }, job.title),
          h("span", { class: "type" }, job.state),
          job.state === "running" ? iconButton("close", "Cancel", () => job.cancel()) : h("span"),
          bar,
          job.message ? h("span", { class: "sub" }, job.message) : null,
        );
      }),
    );
  };
  const off = wb.jobs.onChange(render);
  render();
  return () => {
    off();
    runner.dispose();
  };
}

// ----------------------------------------------------------------- plugins

const KIND_LABEL = { datatype: "Data type", tool: "Tool" } as const;
const GUIDE = "https://github.com/AllenInstitute/ngplatform/blob/main/plugins/README.md";

/** The "Read more" sheet: a plugin's guide, links and facts. */
export function showPluginInfo(manifest: Manifest): void {
  const facts: [string, string][] = [
    ["Kind", KIND_LABEL[manifest.kind]],
    ["Version", manifest.version],
    ["Id", manifest.id],
  ];
  if (manifest.license) facts.push(["Licence", manifest.license]);
  showSheet(
    sheet(
      manifest.name,
      [
        manifest.description ? h("p", { class: "lead" }, manifest.description) : h("span"),
        manifest.guide ? renderMarkdown(manifest.guide) : h("p", { class: "empty" }, "This plugin has no guide."),
        manifest.links?.length
          ? h("ul", { class: "links" }, ...manifest.links.map((l) => h("li", {}, h("a", { href: l.url, target: "_blank", rel: "noopener" }, l.title, " ↗"))))
          : h("span"),
        h("dl", { class: "facts" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
      ],
      [h("button", { class: "btn primary", type: "button", onclick: () => closeSheet() }, "Close")],
    ),
  );
}

/** Asks for a plugin's URL, then (addUrl) whether to run it. */
function addFromUrl(local: LocalPlugins): void {
  const input = h("input", {
    class: "text-input",
    type: "url",
    placeholder: "https://…/manifest.json   or   https://…/plugin.js",
    "aria-label": "Plugin URL",
    spellcheck: "false",
  }) as HTMLInputElement;
  const note = h("p", { class: "note" }, "A tool plugin's manifest.json (its code beside it) or module, served with CORS. Nothing runs until you agree.");
  const next = h("button", { class: "btn primary", type: "button" }, "Continue") as HTMLButtonElement;
  const submit = async () => {
    if (input.value.trim() === "") return;
    next.disabled = true;
    note.className = "note";
    note.textContent = "Reading…";
    try {
      await local.addUrl(input.value, confirmPlugin);
    } catch (e) {
      note.className = "note error";
      note.textContent = (e as Error).message;
      next.disabled = false;
    }
  };
  next.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  showSheet(
    sheet("Add a plugin from a URL", [h("label", { class: "field" }, h("span", {}, "URL"), input), note], [
      h("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"),
      next,
    ]),
  );
  input.focus();
}

/** The consent asked for before a plugin from a URL first runs. */
function confirmPlugin(offer: UrlPluginOffer): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (yes: boolean) => {
      answered = true;
      closeSheet();
      resolve(yes);
    };
    const m = offer.manifest;
    const facts: [string, string][] = [["From", offer.url]];
    if (m !== undefined) facts.push(["Id", m.id], ["Version", m.version]);
    showSheet(
      sheet(
        m !== undefined ? `Run “${m.name}”?` : "Run this plugin?",
        [
          m?.description ? h("p", { class: "lead" }, m.description) : h("span"),
          h("dl", { class: "facts" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
          h(
            "p",
            { class: "note" },
            "Its code runs in this page with the app's access: your workspace, the data you open, your sign-ins to data servers. Add plugins only from people you trust. It loads on later visits until you remove it.",
          ),
        ],
        [h("button", { class: "btn", type: "button", onclick: () => answer(false) }, "Cancel"), h("button", { class: "btn primary", type: "button", onclick: () => answer(true) }, "Run it")],
      ),
      () => {
        if (!answered) resolve(false);
      },
    );
  });
}

/** The first sentence of a description, for the one line a card shows. */
function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  return m ? m[1] : text;
}

export function renderPluginsPanel(host: HTMLElement, wb: Workbench, local: LocalPlugins): () => void {
  const list = h("div", { class: "list plugin-list" });
  const localList = h("div", { class: "list plugin-list" });
  const addButton = h("button", { class: "btn outline small", type: "button", "aria-haspopup": "menu" }, icon("plus"), "Add");
  addButton.addEventListener("click", () =>
    showMenu(addButton, [
      { label: "JavaScript or Python file…", run: () => void local.add(false) },
      { label: "Folder with manifest.json…", run: () => void local.add(true) },
      { label: "From a URL…", run: () => addFromUrl(local) },
      "-",
      { label: "How to write a plugin ↗", run: () => window.open(GUIDE, "_blank", "noopener") },
    ]),
  );
  host.append(
    h("div", { class: "panel-intro" }, h("p", { class: "note" }, "Switching one reloads the page."), addButton),
    list,
    localList,
  );
  const render = () => {
    const records = new Map(wb.plugins.list().map((r) => [r.manifest.id, r]));
    const { manifests, enabled, blocked } = wb.pluginSwitches;
    const nameOf = (id: string) => manifests.find((m) => m.id === id)?.name ?? id;
    clear(
      list,
      ...manifests.map((manifest) => {
        const on = enabled.has(manifest.id);
        const record = records.get(manifest.id);
        const missing = blocked.get(manifest.id);
        const toggle = h("input", {
          type: "checkbox",
          class: "switch",
          role: "switch",
          "aria-label": `${on ? "Switch off" : "Switch on"} ${manifest.name}`,
        });
        toggle.checked = on;
        toggle.addEventListener("change", () => {
          toggle.checked = on; // the reload shows the new state
          void wb.pluginSwitches.toggle(manifest.id, !on);
        });
        const problem =
          record?.status === "failed" || record?.status === "disabled"
            ? `Failed: ${record.error ?? "unknown error"}`
            : missing !== undefined
              ? `Off: needs ${missing.map(nameOf).join(", ")}`
              : undefined;
        return h(
          "div",
          { class: on ? "plugin on" : "plugin" },
          h(
            "div",
            { class: "plugin-head" },
            h("span", { class: "plugin-name" }, manifest.name),
            h("span", { class: `chip kind-${manifest.kind}` }, KIND_LABEL[manifest.kind]),
            h("label", { class: "switch-label", title: on ? "On" : "Off" }, toggle),
          ),
          h(
            "p",
            { class: "plugin-desc" },
            firstSentence(manifest.description ?? ""),
            " ",
            h("button", { class: "link", type: "button", onclick: () => showPluginInfo(manifest) }, "Read more"),
          ),
          problem ? h("p", { class: "note error" }, problem) : null,
        );
      }),
    );
    const locals = local.list();
    clear(
      localList,
      ...(locals.length ? [h("h3", { class: "section-title" }, "Added here")] : []),
      ...locals.map((p) => {
        const record = p.id !== undefined ? records.get(p.id) : undefined;
        const state =
          p.status === "loaded"
            ? `Loaded ${p.loadedAt?.toLocaleTimeString(undefined, { hour12: false }) ?? ""}`
            : p.status === "needs-permission"
              ? "Reload to allow reading it again"
              : p.status === "loading"
                ? "Loading…"
                : `Failed: ${p.error}`;
        return h(
          "div",
          { class: "plugin on" },
          h(
            "div",
            { class: "plugin-head" },
            h("span", { class: "plugin-name" }, record?.manifest.name ?? p.name),
            h("span", { class: "chip" }, p.kind === "python" ? "Python" : "Tool"),
            h(
              "span",
              { class: "plugin-actions" },
              record?.manifest ? h("button", { class: "link", type: "button", onclick: () => showPluginInfo(record.manifest) }, "Read more") : null,
              h(
                "button",
                { class: "btn small", type: "button", title: p.url ? "Fetch it again and run the new code" : "Read the file again and run the new code", onclick: () => void local.reload(p.key) },
                "Reload",
              ),
              iconButton("close", "Remove", () => void local.remove(p.key)),
            ),
          ),
          h("p", { class: p.status === "failed" ? "note error" : "note" }, `${p.url ? new URL(p.url).host : p.name} · ${state}`),
        );
      }),
    );
  };
  const offs = [wb.plugins.onChange(render), local.onChange(render)];
  render();
  return () => offs.forEach((off) => off());
}

export { icon };
