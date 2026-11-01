/** The smaller panels: Statistics, Jobs and Plugins. */
import type { LocalPlugins } from "../../platform/local_plugins.js";
import type { Manifest } from "../../sdk/types.js";
import { clear, h, icon, iconButton } from "../dom.js";
import { renderMarkdown } from "../markdown.js";
import { closeSheet, sheet, showMenu, showSheet } from "../overlays.js";
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
  host.append(list);
  const render = () => {
    const jobs = wb.jobs.list();
    if (jobs.length === 0) {
      clear(list, h("p", { class: "empty" }, "No jobs. Filters, statistics and scripts from plugins queue here, with progress and a cancel button."));
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
  return off;
}

// ----------------------------------------------------------------- plugins

const KIND_LABEL = { datatype: "Data type", tool: "Tool" } as const;
const GUIDE = "https://github.com/Andrew-Keenlyside/ngplatform/blob/platform-gui/plugins/README.md";

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

/** The first sentence of a description, for the one line a card shows. */
function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  return m ? m[1] : text;
}

export function renderPluginsPanel(host: HTMLElement, wb: Workbench, local: LocalPlugins): () => void {
  const list = h("div", { class: "list" });
  const localList = h("div", { class: "list" });
  const addButton = h("button", { class: "btn outline small", type: "button", "aria-haspopup": "menu" }, icon("plus"), "Add");
  addButton.addEventListener("click", () =>
    showMenu(addButton, [
      { label: "JavaScript or Python file…", run: () => void local.add(false) },
      { label: "Folder with manifest.json…", run: () => void local.add(true) },
      "-",
      { label: "How to write a plugin ↗", run: () => window.open(GUIDE, "_blank", "noopener") },
    ]),
  );
  host.append(
    h("div", { class: "panel-intro" }, h("p", { class: "note" }, "Formats and tools; switching one reloads the page with the same link."), addButton),
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
      ...(locals.length ? [h("h3", { class: "section-title" }, "From this computer")] : []),
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
              h("button", { class: "btn small", type: "button", title: "Read the file again and run the new code", onclick: () => void local.reload(p.key) }, "Reload"),
              iconButton("close", "Remove", () => void local.remove(p.key)),
            ),
          ),
          h("p", { class: p.status === "failed" ? "note error" : "note" }, `${p.name} · ${state}`),
        );
      }),
    );
  };
  const offs = [wb.plugins.onChange(render), local.onChange(render)];
  render();
  return () => offs.forEach((off) => off());
}

export { icon };
