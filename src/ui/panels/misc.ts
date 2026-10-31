/** The smaller panels: Statistics, Jobs, Python and Plugins. */
import { clear, h, icon, iconButton } from "../dom.js";
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

// ------------------------------------------------------------------ python

export function renderPythonPanel(host: HTMLElement): void {
  host.append(
    h(
      "p",
      { class: "empty" },
      "A Python console (Pyodide, in a worker) will run here, with the workspace's commands available as ",
      h("code", {}, "await ngp.invoke(\"…\", {…})"),
      ". Not in this release.",
    ),
  );
}

// ----------------------------------------------------------------- plugins

const KIND_LABEL = { datatype: "Data type", tool: "Tool" } as const;

export function renderPluginsPanel(host: HTMLElement, wb: Workbench): () => void {
  const list = h("div", { class: "list" });
  host.append(
    h(
      "div",
      { class: "section" },
      h("h3", { class: "section-title" }, "Plugins"),
      h(
        "p",
        { class: "note first" },
        "Plugins are built into the app. A data type plugin teaches the viewer a format; a tool plugin adds a tab here on the left. Switching one on or off reloads the page with the same link, so the workspace comes back as it was. The choice is kept in this browser.",
      ),
      list,
    ),
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
        const state =
          record?.status === "failed" || record?.status === "disabled"
            ? `failed: ${record.error ?? "unknown error"}`
            : missing !== undefined
              ? `off: needs ${missing.map(nameOf).join(", ")}`
              : on
                ? record?.status === "active" || manifest.kind === "datatype"
                  ? "on"
                  : "on, loads when first used"
                : "off";
        return h(
          "div",
          { class: on ? "plugin on" : "plugin" },
          h(
            "div",
            { class: "plugin-head" },
            h("span", { class: `chip kind-${manifest.kind}` }, KIND_LABEL[manifest.kind]),
            h("span", { class: "plugin-name" }, manifest.name),
            h("span", { class: "type" }, manifest.version),
            h("label", { class: "switch-label", title: state }, toggle),
          ),
          manifest.description ? h("p", { class: "empty" }, manifest.description) : null,
          h(
            "p",
            { class: record?.error ? "note error" : "note" },
            [
              state[0].toUpperCase() + state.slice(1),
              manifest.requires?.plugins?.length ? `requires ${manifest.requires.plugins.map(nameOf).join(", ")}` : undefined,
              manifest.license ? `licence ${manifest.license}` : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        );
      }),
    );
  };
  const off = wb.plugins.onChange(render);
  render();
  return off;
}

export { icon };
