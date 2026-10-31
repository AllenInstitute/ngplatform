/**
 * The smaller panels: Pointer, Selection, Statistics, Jobs, Python and
 * Plugins.
 */
import type { CursorInfo } from "../../engine/engine.js";
import { clear, h, icon, iconButton } from "../dom.js";
import type { Workbench } from "../workbench.js";
import { physical } from "./format.js";

// ----------------------------------------------------------------- pointer

function renderCursor(coords: HTMLElement, values: HTMLElement, cursor: CursorInfo): void {
  if (!cursor.active || cursor.position.length === 0) {
    clear(coords, h("p", { class: "empty" }, "Move the pointer over a view."));
    clear(values);
    return;
  }
  clear(
    coords,
    h(
      "div",
      { class: "coords" },
      ...cursor.names.map((axis, i) => {
        const [value, unit] = physical(cursor.position[i], cursor.units[i], cursor.scales[i]);
        return h(
          "div",
          { class: "coord" },
          h("div", { class: `axis axis-${i}` }, axis),
          h("div", { class: "value" }, value, " ", h("span", { class: "unit" }, unit)),
        );
      }),
    ),
  );
  const entries = Object.entries(cursor.values).filter(([, v]) => v !== undefined && v !== null);
  clear(
    values,
    entries.length === 0
      ? h("p", { class: "note" }, "Nothing under the pointer.")
      : h(
          "dl",
          { class: "facts" },
          ...entries.flatMap(([layer, v]) => [h("dt", {}, layer), h("dd", {}, typeof v === "string" ? v : JSON.stringify(v))]),
        ),
  );
}

export function renderPointerPanel(host: HTMLElement, wb: Workbench): () => void {
  const coords = h("div");
  const values = h("div");
  host.append(
    h("div", { class: "section" }, h("h3", { class: "section-title" }, "Pointer"), coords),
    h("div", { class: "section" }, h("h3", { class: "section-title" }, "Under the pointer"), values),
  );
  const update = () => renderCursor(coords, values, wb.engine.cursor());
  const off = wb.engine.onCursorChanged(update);
  update();
  return off;
}

// --------------------------------------------------------------- selection

export function renderSelectionPanel(host: HTMLElement, wb: Workbench): () => void {
  const panel = h("div", { class: "ng-host selection-host" });
  host.append(
    panel,
    h(
      "p",
      { class: "note" },
      "Ctrl + right-click in a view to pick and pin what is there; hover shows it until you pin it. Back and forward step through earlier picks.",
    ),
  );
  return wb.engine.mountSelection(panel);
}

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

export function renderPluginsPanel(host: HTMLElement, wb: Workbench): () => void {
  const list = h("div", { class: "list" });
  const services = h("div");
  host.append(
    h("div", { class: "section" }, h("h3", { class: "section-title" }, "Installed"), list),
    h("div", { class: "section" }, h("h3", { class: "section-title" }, "Services"), services),
    h(
      "p",
      { class: "note" },
      "Plugins add panels to these docks, sections to the Inspector and commands to the palette, through a declared manifest. Nothing loads until it is used. See docs/plugins.md.",
    ),
  );
  const render = () => {
    const records = wb.plugins.list();
    clear(
      list,
      ...(records.length === 0
        ? [h("p", { class: "empty" }, "None.")]
        : records.map((r) =>
            h(
              "div",
              { class: "plugin" },
              h(
                "div",
                { class: "plugin-head" },
                h("span", { class: "plugin-name" }, r.manifest.name),
                h("span", { class: "type" }, r.manifest.version),
                h("span", { class: `chip ${r.status}` }, r.builtin ? `built-in · ${r.status}` : r.status),
              ),
              r.manifest.description ? h("p", { class: "empty" }, r.manifest.description) : null,
              h(
                "p",
                { class: "note" },
                [
                  r.manifest.license ? `Licence ${r.manifest.license}` : undefined,
                  r.manifest.activation?.length ? `Loads on ${r.manifest.activation.join(", ")}` : "Loads when used",
                ]
                  .filter(Boolean)
                  .join(" · "),
              ),
              r.error ? h("p", { class: "empty error" }, r.error) : null,
              r.builtin
                ? null
                : h(
                    "div",
                    { class: "row-actions" },
                    r.status === "disabled"
                      ? h("button", { class: "btn small", type: "button", onclick: () => wb.plugins.enable(r.manifest.id) }, "Enable")
                      : h("button", { class: "btn small", type: "button", onclick: () => wb.plugins.disable(r.manifest.id) }, "Disable"),
                  ),
            ),
          )),
    );
    const provided = wb.services.list();
    clear(
      services,
      provided.length === 0
        ? h("p", { class: "empty" }, "None provided.")
        : h("dl", { class: "facts" }, ...provided.flatMap((s) => [h("dt", {}, s.name), h("dd", {}, s.owner)])),
    );
  };
  const off = wb.plugins.onChange(render);
  render();
  return off;
}

export { icon };
