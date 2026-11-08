/**
 * The Remote tab: the computers this browser runs work on, for every
 * function (jobs, the render service, plugins' services): This computer's
 * runner, and others reached through an SSH tunnel, each with its pairing,
 * its GPUs and services and the files it serves; which of them takes work
 * that can run on any (`ctx.hosts.pick`); and adding another.  The jobs
 * on them are in the Jobs tab.
 */
import { LOCAL_HOST } from "../../platform/hosts.js";
import { clear, h } from "../dom.js";
import { addHostDialog, renderRunnerSection } from "../runner.js";
import type { Workbench } from "../workbench.js";

export function renderRemotePanel(host: HTMLElement, wb: Workbench): () => void {
  const choice = h("select", { class: "select remote-preferred", "aria-label": "Run work on", style: "max-width: 420px" }) as HTMLSelectElement;
  choice.addEventListener("change", () => wb.hosts.prefer(choice.value || undefined));
  const choiceNote = h("p", { class: "note remote-preferred-note" });
  const renderChoice = () => {
    const hosts = wb.hosts.list();
    const preferred = wb.hosts.preferred() ?? "";
    clear(
      choice,
      h("option", { value: "" }, "Automatic (a computer with a GPU first)"),
      ...hosts.map((x) => h("option", { value: x.name }, `${x.name}${x.available ? "" : " (not answering)"}`)),
    );
    choice.value = preferred;
    const used = wb.hosts.pick();
    choiceNote.textContent =
      hosts.length === 0
        ? "No computer is paired: pair This computer's runner below, or add another through an SSH tunnel."
        : used === undefined
          ? "None of them answers now."
          : `Work that can run on any computer goes to ${used.name}; a function that needs a service (rendering) uses the first computer that has it ready.`;
  };
  // A section for each computer, made again only when one is added or removed.
  const computers = h("div", { class: "runner-hosts" });
  let sections: { name: string; dispose: () => void }[] = [];
  const renderHosts = () => {
    const names = [LOCAL_HOST, ...wb.hosts.others()];
    if (names.join("\n") === sections.map((s) => s.name).join("\n")) return;
    for (const section of sections) section.dispose();
    sections = [];
    const elements: HTMLElement[] = [];
    for (const name of names) {
      const service = wb.hosts.runner(name);
      if (service === undefined) continue;
      const section = renderRunnerSection(wb, service, name, "host");
      sections.push({ name, dispose: section.dispose });
      elements.push(section.element);
    }
    clear(computers, ...elements);
  };
  host.append(
    h(
      "div",
      { class: "section remote-head" },
      h("h3", { class: "section-title" }, "Remote compute"),
      h(
        "p",
        { class: "note first" },
        "The computers this browser runs work on: this one's runner, and others reached through an SSH tunnel. Jobs, rendering and plugins' services all use the computers paired here; the jobs on them are in the Jobs tab.",
      ),
      h("label", { class: "field" }, h("span", {}, "Run work on"), choice),
      choiceNote,
    ),
    computers,
    h(
      "div",
      { class: "row-actions runner-add-host" },
      h("button", { class: "btn small outline", type: "button", title: "A runner on another computer, reached through an SSH tunnel", onclick: () => addHostDialog(wb) }, "Add a computer (SSH)…"),
    ),
  );
  renderHosts();
  renderChoice();
  const off = wb.hosts.onChange(() => {
    renderHosts();
    renderChoice();
  });
  return () => {
    off();
    for (const section of sections) section.dispose();
  };
}

