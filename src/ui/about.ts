/**
 * About (Settings › About): this build's version, the commit and date it
 * was built from, the Neuroglancer it was built against, and the version
 * of each paired runner, with a warning for one older than this app needs.
 * Also the one-off warning in Activity when a runner that old connects.
 */
import { type BuildInfo, buildInfo } from "../platform/build_info.js";
import { LOCAL_HOST } from "../platform/hosts.js";
import { runnerVersionWarning, type RunnerService } from "../platform/runner.js";
import { h } from "./dom.js";
import { toast } from "./overlays.js";
import type { Workbench } from "./workbench.js";

const REPOSITORY = "https://github.com/AllenInstitute/ngplatform";
const NEUROGLANCER_REPOSITORY = "https://github.com/Andrew-Keenlyside/neuroglancer";

/** A commit as a link to it (one with uncommitted changes, or unknown, as text). */
function commitLink(repository: string, commit: string): Node {
  const clean = /^[0-9a-f]{7,40}$/.test(commit);
  return clean ? h("a", { href: `${repository}/commit/${commit}`, target: "_blank", rel: "noopener" }, commit) : document.createTextNode(commit);
}

/** The build's facts, as label and text (the text of a commit, for tests). */
export function buildFacts(build: BuildInfo): [string, string][] {
  const date = build.date === "" ? "unknown" : build.date.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
  const pinned = build.neuroglancer.commit === build.neuroglancer.pin;
  return [
    ["Version", build.version],
    ["Commit", build.commit],
    ["Built", date],
    ["Neuroglancer", pinned ? build.neuroglancer.commit : `${build.neuroglancer.commit} (pinned: ${build.neuroglancer.pin})`],
  ];
}

/** A runner's line: its version and where, or why there is none. */
export function runnerFact(runner: RunnerService): { text: string; warning?: string } {
  const pairing = runner.pairing();
  if (pairing === undefined) return { text: "not paired" };
  const info = runner.info();
  if (runner.connection() !== "connected" || info === undefined) return { text: `${runner.connection()} (${pairing.address})` };
  return { text: `${info.version} at ${info.address}`, warning: runnerVersionWarning(info.version) };
}

export function renderAbout(host: HTMLElement, wb: Workbench): () => void {
  const build = buildInfo();
  const runners = h("dl", { class: "facts about-runners" });
  const drawRunners = () => {
    runners.replaceChildren();
    const names = wb.hosts.names();
    if (!names.includes(LOCAL_HOST)) names.unshift(LOCAL_HOST);
    for (const name of names) {
      const runner = name === LOCAL_HOST ? wb.runner : wb.hosts.runner(name);
      if (runner === undefined) continue;
      const fact = runnerFact(runner);
      runners.append(h("dt", {}, name), h("dd", {}, fact.text, fact.warning ? h("p", { class: "note error runner-outdated" }, fact.warning) : null));
    }
  };
  const facts = buildFacts(build);
  const linked: Record<string, Node> = {
    Commit: commitLink(REPOSITORY, build.commit),
    Neuroglancer: h("span", {}, commitLink(NEUROGLANCER_REPOSITORY, build.neuroglancer.commit), facts[3][1].slice(build.neuroglancer.commit.length)),
  };
  // Laid out as Settings › View is: a section per group, spaced by its grid.
  host.append(
    h(
      "div",
      { class: "view-settings about" },
      h("section", {}, h("h3", { class: "section-title" }, "ngplatform"), h("dl", { class: "facts about-build" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, linked[k] ?? v)]))),
      h("section", {}, h("h3", { class: "section-title" }, "Runners"), runners),
      h(
        "p",
        { class: "note" },
        "What changed in each version: ",
        h("a", { href: `${REPOSITORY}/blob/main/CHANGELOG.md`, target: "_blank", rel: "noopener" }, "the changelog"),
        ". The fonts are Source Sans 3 and Source Code Pro (SIL Open Font License); Python runs Pyodide, loaded from cdn.jsdelivr.net when the Python panel first opens.",
      ),
    ),
  );
  drawRunners();
  const off = [wb.runner.onChange(drawRunners), wb.hosts.onChange(drawRunners)];
  return () => off.forEach((f) => f());
}

/**
 * Tells the user once per page, in Activity and a toast, when a runner too
 * old for this app connects (each version once, so a poll does not repeat it).
 */
export function watchRunnerVersions(wb: Workbench): () => void {
  const told = new Set<string>();
  const check = () => {
    for (const name of wb.hosts.names()) {
      const runner = wb.hosts.runner(name);
      const info = runner?.connection() === "connected" ? runner.info() : undefined;
      const warning = info === undefined ? undefined : runnerVersionWarning(info.version);
      if (warning === undefined || told.has(`${name} ${info!.version}`)) continue;
      told.add(`${name} ${info!.version}`);
      wb.log.add(`${name}: ${warning}`, "error");
      toast(`${name}: the runner is older than this app needs. Settings › About says what to do.`, "error");
    }
  };
  const off = [wb.runner.onChange(check), wb.hosts.onChange(check)];
  check();
  return () => off.forEach((f) => f());
}
