/**
 * Settings → Compute: the computers this browser runs work on, for every
 * function (jobs, the render service, plugins' services): This computer's
 * runner, and others reached through an SSH tunnel, each with its pairing,
 * its GPUs and services and the files it serves; which of them takes work
 * that can run on any (`ctx.hosts.pick`); and adding another.  The jobs
 * on them are in Activity.
 */
import { LOCAL_HOST } from "../../platform/hosts.js";
import { card, field } from "../../sdk/dom.js";
import { clear, h } from "../dom.js";
import { addHostDialog, renderRunnerSection } from "../runner.js";
import type { Workbench } from "../workbench.js";

export function renderRemotePanel(host: HTMLElement, wb: Workbench): () => void {
  const choice = h("select", { class: "select remote-preferred", "aria-label": "Run work on" }) as HTMLSelectElement;
  choice.addEventListener("change", () => wb.hosts.prefer(choice.value || undefined));
  const choiceNote = h("p", { class: "note remote-preferred-note" });
  const renderChoice = () => {
    const hosts = wb.hosts.list();
    const preferred = wb.hosts.preferred() ?? "";
    clear(
      choice,
      h("option", { value: "" }, "Automatic (GPU first)"),
      ...hosts.map((x) => h("option", { value: x.name }, `${x.name}${x.available ? "" : " (not answering)"}`)),
    );
    choice.value = preferred;
    const used = wb.hosts.pick();
    choiceNote.textContent = hosts.length > 0 && used === undefined ? "None answers now." : "";
    choiceNote.hidden = choiceNote.textContent === "";
    // Nothing to choose until a computer is paired.
    head.hidden = hosts.length === 0;
  };
  // A section for each computer, made again only when one is added or removed: This computer in a card of its own, the others in one.
  const local = h("div", { class: "runner-hosts" });
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
      if (name === LOCAL_HOST) clear(local, section.element);
      else elements.push(section.element);
    }
    clear(computers, ...elements);
    others.querySelector(".card-badge")?.replaceChildren(elements.length ? String(elements.length) : "");
  };
  const others = card(
    "compute.others",
    "Other computers",
    { badge: " ", info: "Runners on other computers, reached through an SSH tunnel" },
    computers,
    h("div", { class: "row-actions runner-add-host" }, h("button", { class: "btn small outline", type: "button", onclick: () => addHostDialog(wb) }, "Add a computer (SSH)…")),
  );
  const head: HTMLElement = h(
    "div",
    { class: "section remote-head" },
    field("Run work on", choice, { info: "Work that can run on any computer goes here; a function that needs a service (rendering) uses the first computer that has it ready." }),
    choiceNote,
  );
  host.append(
    head,
    card("compute.this", "This computer", { open: true }, local),
    others,
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

