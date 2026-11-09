/** The smaller panels: Statistics, Jobs and Plugins (the computers are in remote.ts). */
import type { LocalPlugins, UrlPluginOffer } from "../../platform/local_plugins.js";
import type { Manifest } from "../../sdk/types.js";
import { bytesText } from "../../sdk/format.js";
import type { ChunkSourceStatistics } from "../../engine/engine.js";
import { clear, h, icon, iconButton } from "../dom.js";
import { field, info, statusLine, toggle } from "../../sdk/dom.js";
import { renderMarkdown } from "../markdown.js";
import { closeSheet, sheet, showMenu, showSheet } from "../overlays.js";
import { LOCAL_HOST } from "../../platform/hosts.js";
import { renderRunnerSection } from "../runner.js";
import type { Workbench } from "../workbench.js";
import { type CatalogueEntry, GROUP_TITLES, type PluginGroup } from "../../../plugins/index.js";

// -------------------------------------------------------------- statistics

/** The table's columns after the source: heading, tooltip, and the cell. */
const STATISTICS: [string, string, (s: ChunkSourceStatistics) => string][] = [
  ["Visible", "Chunks the views need", (s) => count(s.visible)],
  ["Loading", "Of those, being downloaded", (s) => count(s.downloading)],
  ["In memory", "Of those, in system memory", (s) => count(s.memory)],
  ["On GPU", "Of those, in GPU memory", (s) => count(s.gpu)],
  ["Failed", "Of those, failed to load", (s) => count(s.failed)],
  ["GPU memory", "GPU memory of the chunks the views need", (s) => (s.gpuBytes > 0 ? bytesText(s.gpuBytes) : "–")],
  ["Latency", "Mean download time", (s) => (Number.isFinite(s.latency) ? `${Math.round(s.latency).toLocaleString()} ms` : "–")],
];
const count = (n: number) => (Number.isFinite(n) ? n.toLocaleString() : "–");

/** Chunk statistics (Settings › Developer): what each source has loaded for the views, as a table read again each second. */
export function renderStatisticsPanel(host: HTMLElement, wb: Workbench): () => void {
  const body = h("tbody");
  const table = h(
    "div",
    { class: "stats-wrap" },
    h(
      "table",
      { class: "stats-table" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Source"), ...STATISTICS.map(([label, title]) => h("th", { scope: "col", title }, label)))),
      body,
    ),
  );
  const empty = h("p", { class: "empty" }, "Nothing loaded yet.");
  host.append(table, empty);
  const render = (rows: ChunkSourceStatistics[]) => {
    rows.sort((a, b) => b.gpuBytes - a.gpuBytes || b.visible - a.visible || a.kind.localeCompare(b.kind));
    table.hidden = rows.length === 0;
    empty.hidden = rows.length > 0;
    clear(
      body,
      ...rows.map((s) =>
        h(
          "tr",
          {},
          h("td", { title: s.id }, h("div", { class: "stats-kind" }, s.kind), s.details.length ? h("div", { class: "stats-detail" }, s.details.join(" · ")) : null),
          ...STATISTICS.map(([, , cell]) => h("td", {}, cell(s))),
        ),
      ),
    );
  };
  let timer = 0;
  let stopped = false;
  const read = async () => {
    const rows = await wb.engine.chunkStatistics().catch(() => undefined);
    if (stopped) return;
    if (rows !== undefined) render(rows);
    timer = window.setTimeout(() => void read(), 1000);
  };
  void read();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

// -------------------------------------------------------------------- jobs

export function renderJobsPanel(host: HTMLElement, wb: Workbench): () => void {
  const list = h("div", { class: "jobs" });
  // The jobs on each paired computer (Settings → Compute), made again only when one is paired, added or removed.
  const computers = h("div", { class: "runner-hosts" });
  let sections: { name: string; dispose: () => void }[] = [];
  const renderHosts = () => {
    const names = [LOCAL_HOST, ...wb.hosts.others()].filter((name) => wb.hosts.runner(name)?.pairing() !== undefined);
    if (names.join("\n") === sections.map((s) => s.name).join("\n")) return;
    for (const section of sections) section.dispose();
    sections = [];
    const elements: HTMLElement[] = [];
    for (const name of names) {
      const service = wb.hosts.runner(name);
      if (service === undefined) continue;
      const section = renderRunnerSection(wb, service, name, "jobs");
      sections.push({ name, dispose: section.dispose });
      elements.push(section.element);
    }
    clear(computers, ...elements);
  };
  const here = h("div", { class: "section" }, h("h3", { class: "section-title" }, "Jobs"), list);
  host.append(here, computers);
  renderHosts();
  const offHosts = wb.hosts.onChange(renderHosts);
  const render = () => {
    const jobs = wb.jobs.list();
    // No jobs: nothing to show (the log is below).
    here.hidden = jobs.length === 0;
    if (jobs.length === 0) return clear(list);
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
    offHosts();
    for (const section of sections) section.dispose();
  };
}

// ----------------------------------------------------------------- plugins

const KIND_LABEL = { datatype: "Data type", tool: "Tool" } as const;
const GUIDE = "https://github.com/AllenInstitute/ngplatform/blob/main/plugins/README.md";

/** The "About" sheet: a plugin's guide, links and facts. */
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
  const status = statusLine();
  const next = h("button", { class: "btn primary", type: "button" }, "Continue") as HTMLButtonElement;
  let close = () => {};
  const submit = async () => {
    if (input.value.trim() === "") return;
    next.disabled = true;
    status.progress("Reading…");
    try {
      // The consent opens above this sheet: once agreed, both close; declined, this one is back.
      let agreed = false;
      await local.addUrl(input.value, async (offer) => (agreed = await confirmPlugin(offer)));
      if (agreed) return close();
      status.clear();
      next.disabled = false;
    } catch (e) {
      status.error((e as Error).message);
      next.disabled = false;
    }
  };
  next.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  close = showSheet(
    sheet("Add a plugin from a URL", [field("URL", input, { info: "A tool plugin's manifest.json (its code beside it) or module, served with CORS. Nothing runs until you agree." }), status], [
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
    let close = () => {};
    const answer = (yes: boolean) => {
      answered = true;
      close();
      resolve(yes);
    };
    const m = offer.manifest;
    const facts: [string, string][] = [["From", offer.url]];
    if (m !== undefined) facts.push(["Id", m.id], ["Version", m.version]);
    close = showSheet(
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

export function renderPluginsPanel(host: HTMLElement, wb: Workbench, local: LocalPlugins): () => void {
  const list = h("div", { class: "plugin-groups" });
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
    h(
      "div",
      { class: "panel-intro" },
      info("Tools turn on at once; turning one off reloads the page.", "About turning plugins on and off"),
      addButton,
    ),
    list,
    localList,
  );
  const render = () => {
    const records = new Map(wb.plugins.list().map((r) => [r.manifest.id, r]));
    const { catalogue, manifests, enabled, blocked, thisTab } = wb.pluginSwitches;
    const nameOf = (id: string) => manifests.find((m) => m.id === id)?.name ?? id;
    const row = (entry: CatalogueEntry) => {
      const { manifest } = entry;
      const on = enabled.has(manifest.id);
      const record = records.get(manifest.id);
      const missing = blocked.get(manifest.id);
      const onOff = toggle(manifest.name, on, () => {
        onOff.set(on); // shown as it is until the switch takes effect
        void wb.pluginSwitches.toggle(manifest.id, !on);
      }, { hideLabel: true });
      const problem =
        record?.status === "failed" || record?.status === "disabled"
          ? `Failed: ${record.error ?? "unknown error"}`
          : missing !== undefined
            ? `Off: needs ${missing.map(nameOf).join(", ")}`
            : undefined;
      const forTab = on && thisTab.has(manifest.id);
      return h(
        "div",
        { class: on ? "plugin on" : "plugin" },
        h(
          "div",
          { class: "plugin-head" },
          h("span", { class: "plugin-name" }, manifest.name),
          h("button", { class: "link", type: "button", title: `About ${manifest.name}`, onclick: () => showPluginInfo(manifest) }, "About"),
          h("span", { class: "switch-label" }, onOff),
        ),
        h("p", { class: "plugin-desc" }, entry.summary),
        forTab
          ? h(
              "p",
              { class: "note" },
              "On in this tab for the example. ",
              h("button", { class: "link", type: "button", onclick: () => wb.pluginSwitches.keep(manifest.id) }, "Keep it on"),
            )
          : null,
        problem ? h("p", { class: "note error" }, problem) : null,
      );
    };
    clear(
      list,
      ...(Object.keys(GROUP_TITLES) as PluginGroup[])
        .map((group) => [group, catalogue.filter((e) => e.group === group)] as const)
        .filter(([, entries]) => entries.length > 0)
        .map(([group, entries]) =>
          h("section", { class: "plugin-group" }, h("h3", { class: "section-title" }, GROUP_TITLES[group]), h("div", { class: "list plugin-list" }, ...entries.map(row))),
        ),
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
              record?.manifest ? h("button", { class: "link", type: "button", onclick: () => showPluginInfo(record.manifest) }, "About") : null,
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
  const offs = [wb.plugins.onChange(render), local.onChange(render), wb.pluginSwitches.onChange(render)];
  render();
  return () => offs.forEach((off) => off());
}

export { icon };
