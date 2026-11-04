/**
 * The runner in the interface: the Jobs tab's "This computer" section
 * (pairing, the runner's jobs with their PID, progress, log, Cancel and
 * Open), the chooser for paths under the runner's folders, opening a path
 * as a layer (served by the runner), and, for a tractogram past the
 * browser's storage limit, the choice of a sample in the browser or the
 * runner's conversion.
 */
import { isActive, normaliseAddress, pairingFromHash, type RunnerEntry, RunnerError, type RunnerService } from "../platform/runner.js";
import { bytesText } from "../sdk/format.js";
import type { RunnerApi, RunnerJob, RunnerOutput } from "../sdk/types.js";
import { clear, h, iconButton } from "./dom.js";
import { diskBudget, type SpillPlan, spillPlan, storageEstimate } from "../virtual/vectors/spill.js";
import { tractogramDiskGigabytes } from "../virtual/vectors/formats.js";
import { closeSheet, confirmDialog, offer, sheet, showSheet, toast } from "./overlays.js";
import type { Workbench } from "./workbench.js";

export const LOCAL_JOBS_GUIDE = "https://ngplatform.readthedocs.io/en/latest/guide/local-jobs/";
const START_COMMAND = "python -m ngplatform_runner --root ~/data";
const TRACTOGRAM = /\.(trk|tck|trx)$/i;

const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
const folderOf = (path: string) => path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || "/";
const joinPath = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, "")}/${name}`;

function elapsed(job: RunnerJob): string {
  if (job.started === null) return "";
  // Whole seconds first, so 119.6 s reads "1 min 59 s", never "1 min 60 s".
  const seconds = Math.floor(Math.max(0, (job.finished ?? Date.now() / 1000) - job.started));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds / 60) % 60} min`;
}

/** Whether an output can be added as a layer. */
export function openable(output: RunnerOutput): boolean {
  return output.type === "zarr-vectors" || output.type === "trk" || output.type === "nifti";
}

/** Adds a path under the runner's folders to the active scene, served by the runner. */
export async function openRunnerPath(wb: Workbench, runner: RunnerService, path: string, name?: string): Promise<string> {
  const served = await runner.serve(path);
  const id = wb.store.addDataset({ source: served.source, name: name ?? baseName(path).replace(/\.(zarr|zarrvectors|zv|trk|tck|trx|nii|nii\.gz)$/i, ""), kind: "auto" });
  wb.docks.show("layer");
  return id;
}

async function openOutput(wb: Workbench, runner: RunnerService, output: RunnerOutput): Promise<void> {
  toast(`Opening ${baseName(output.path)}…`);
  try {
    await openRunnerPath(wb, runner, output.path);
    toast(`Added ${baseName(output.path)}, served by the runner`);
  } catch (e) {
    toast(`Could not open ${baseName(output.path)}: ${(e as Error).message}`, "error");
  }
}

// ------------------------------------------------------------------ pairing

/** Pairs with the runner a link names (`#runner=…&token=…`, as the runner prints it), after asking; the fragment is removed either way. */
export function pairFromLink(wb: Workbench, runner: RunnerService, hash = location.hash): void {
  const pairing = pairingFromHash(hash);
  if (pairing === undefined) return;
  history.replaceState(null, "", location.pathname + location.search);
  void (async () => {
    const yes = await confirmDialog(
      `Pair this browser with the runner at ${pairing.address}? It runs jobs on this computer and serves files under its folders to this app.`,
      "Pair",
    );
    if (!yes) return;
    try {
      const info = await runner.pair(pairing.address, pairing.token);
      toast(`Paired with the runner at ${info.address}`);
      wb.docks.show("jobs");
    } catch (e) {
      toast(`Could not pair: ${(e as Error).message}`, "error");
    }
  })();
}

function pairForm(runner: RunnerService, note?: string): HTMLElement {
  const address = h("input", { class: "text-input mono runner-address", type: "text", value: runner.pairing()?.address ?? "http://127.0.0.1:8765", "aria-label": "Runner address", spellcheck: "false" }) as HTMLInputElement;
  const token = h("input", { class: "text-input mono runner-token", type: "password", placeholder: "Token", "aria-label": "Runner token", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const message = h("p", { class: "note runner-pair-error error", hidden: true });
  const pair = async () => {
    message.hidden = true;
    try {
      normaliseAddress(address.value);
      await runner.pair(address.value, token.value);
      toast("Paired with the runner on this computer");
    } catch (e) {
      message.textContent = (e as Error).message;
      message.hidden = false;
    }
  };
  token.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void pair();
  });
  return h(
    "div",
    { class: "runner-pair" },
    note ? h("p", { class: "note first" }, note) : null,
    h("div", { class: "auth-add runner-pair-row" }, address, token, h("button", { class: "btn outline small runner-pair-button", type: "button", onclick: () => void pair() }, "Pair")),
    message,
    h(
      "p",
      { class: "note" },
      "Runs long jobs (converting, filtering, density maps) as Python on this computer. Start it with ",
      h("code", { title: "In the Python that has zarr-vectors-tools" }, START_COMMAND),
      ", then open the link it prints or enter its address and token. ",
      h("a", { href: LOCAL_JOBS_GUIDE, target: "_blank", rel: "noopener" }, "Guide ↗"),
    ),
  );
}

// ------------------------------------------------------------------ jobs

function jobRow(wb: Workbench, runner: RunnerService, job: RunnerJob, openLogs: Map<string, HTMLElement>): HTMLElement {
  const progress = job.progress ?? (isActive(job) ? 0.15 : job.state === "done" ? 1 : 0);
  const bar = h("div", { class: "bar" }, h("div", { class: "fill", style: `width:${Math.round(progress * 100)}%` }));
  if (job.progress === null && job.state === "running") bar.classList.add("indeterminate");
  const facts = [job.pid !== null ? `PID ${job.pid}` : null, job.state === "queued" ? "waiting" : elapsed(job), job.progress !== null && isActive(job) ? `${Math.round(job.progress * 100)}%` : null].filter(Boolean).join(" · ");
  const actions = h("span", { class: "runner-actions" });
  const logButton = h("button", { class: "btn small runner-log-button", type: "button" }, openLogs.has(job.id) ? "Hide log" : "Log");
  logButton.addEventListener("click", () => {
    if (openLogs.has(job.id)) openLogs.delete(job.id);
    else openLogs.set(job.id, h("pre", { class: "runner-log" }, "…"));
    runnerRefresh.get(runner)?.();
  });
  actions.append(logButton);
  if (isActive(job)) {
    actions.append(
      h(
        "button",
        {
          class: "btn small runner-cancel",
          type: "button",
          // A served file is stopped by its serve (its record removed), not only its process: else a restarted runner serves it again.
          onclick: () => void (job.kind === "serve" && job.serve ? runner.stopServing(job.serve.id) : runner.cancel(job.id)).catch((e) => toast((e as Error).message, "error")),
        },
        job.kind === "serve" ? "Stop" : "Cancel",
      ),
    );
  } else if (job.kind !== "serve") {
    actions.append(iconButton("close", "Remove from the list (its files stay)", () => void runner.forget(job.id).catch((e) => toast((e as Error).message, "error"))));
  }
  const outputs =
    job.outputs.length === 0
      ? null
      : h(
          "ul",
          { class: "runner-outputs" },
          ...job.outputs.map((output) =>
            h(
              "li",
              {},
              h("span", { class: "mono runner-output-path", title: output.path }, output.path),
              job.state === "done" && openable(output) ? h("button", { class: "btn small outline runner-open", type: "button", onclick: () => void openOutput(wb, runner, output) }, "Open") : null,
            ),
          ),
        );
  const log = openLogs.get(job.id);
  return h(
    "div",
    { class: `job runner-job ${job.state}`, "data-job-id": job.id, "data-state": job.state, "data-kind": job.kind },
    h("span", { class: "job-title" }, job.title),
    h("span", { class: "type runner-state" }, job.state),
    actions,
    bar,
    h("span", { class: "sub runner-facts" }, facts, job.message ? ` · ${job.message}` : ""),
    outputs,
    log ?? null,
  );
}

/** Rerenders a runner section now (a log opened or closed). */
const runnerRefresh = new WeakMap<RunnerService, () => void>();

/** The Jobs tab's "This computer" section. */
export function renderRunnerSection(wb: Workbench, runner: RunnerService): { element: HTMLElement; dispose: () => void } {
  const body = h("div", { class: "runner-body" });
  const element = h("div", { class: "section runner-section" }, h("div", { class: "section-head" }, h("h3", { class: "section-title" }, "This computer"), h("span", { class: "type runner-connection" })), body);
  const connection = element.querySelector(".runner-connection") as HTMLElement;
  const openLogs = new Map<string, HTMLElement>();
  let form: HTMLElement | undefined;
  let formFor = "";

  const fillLogs = async () => {
    const client = runner.client();
    if (client === undefined) return;
    for (const [id, pre] of openLogs) {
      try {
        const log = await client.log(id);
        const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
        pre.textContent = (log.truncated ? "…\n" : "") + (log.text || "(nothing yet)");
        if (atEnd) pre.scrollTop = pre.scrollHeight;
      } catch (e) {
        pre.textContent = (e as Error).message;
      }
    }
  };

  const render = () => {
    const state = runner.connection();
    connection.textContent = state === "connected" ? "connected" : state === "unpaired" ? "not paired" : state;
    connection.dataset.state = state;
    if (state === "unpaired" || state === "refused") {
      // Kept while typing: only made again when the state changes.
      if (form === undefined || formFor !== state) {
        form = pairForm(runner, state === "refused" ? runner.error() : undefined);
        formFor = state;
        clear(body, form, state === "refused" ? h("div", { class: "row-actions" }, h("button", { class: "btn small", type: "button", onclick: () => runner.unpair() }, "Unpair")) : null);
      }
      return;
    }
    form = undefined;
    formFor = "";
    const info = runner.info();
    const pairing = runner.pairing()!;
    const head = h(
      "div",
      { class: "runner-info" },
      state === "connected" && info !== undefined
        ? h(
            "p",
            { class: "note first" },
            `Runner ${info.version} at ${info.address} (PID ${info.pid}), reading and writing under `,
            ...info.roots.flatMap((r, i) => [i > 0 ? ", " : "", h("code", {}, r)]),
            ". ",
            info.tools ? `zarr-vectors-tools ${info.tools}.` : h("strong", { class: "error" }, "zarr-vectors-tools is missing from the runner's Python: jobs will fail."),
          )
        : h("p", { class: "note first error runner-error" }, state === "connecting" ? `Connecting to ${pairing.address}…` : (runner.error() ?? `The runner at ${pairing.address} does not answer.`)),
      h(
        "div",
        { class: "row-actions" },
        state === "connected" ? h("button", { class: "btn small runner-convert", type: "button", onclick: () => void convertDialog(runner) }, "Convert a tractogram…") : null,
        state === "connected" ? h("button", { class: "btn small runner-open-path", type: "button", onclick: () => void openDialog(wb, runner) }, "Open a file…") : null,
        state !== "connected" ? h("button", { class: "btn small", type: "button", onclick: () => void runner.refresh() }, "Try again") : null,
        state === "connected" ? h("button", { class: "btn small runner-served", type: "button", title: "Files and folders the runner serves to the viewer", onclick: () => void servedDialog(runner) }, "Served…") : null,
        runner.jobs().some((j) => !isActive(j) && j.kind !== "serve") ? h("button", { class: "btn small", type: "button", onclick: () => void runner.clearFinished() }, "Clear finished") : null,
        h("button", { class: "btn small", type: "button", onclick: () => runner.unpair() }, "Unpair"),
      ),
    );
    const jobs = runner.jobs().filter((j) => j.kind !== "serve" || isActive(j));
    for (const id of [...openLogs.keys()]) if (!jobs.some((j) => j.id === id)) openLogs.delete(id);
    clear(
      body,
      head,
      jobs.length === 0 && state === "connected"
        ? h("p", { class: "empty runner-empty" }, "No jobs on this computer yet.")
        : h("div", { class: "jobs runner-jobs" }, ...jobs.map((job) => jobRow(wb, runner, job, openLogs))),
    );
    if (openLogs.size > 0) void fillLogs();
  };
  runnerRefresh.set(runner, render);
  const off = runner.onChange(render);
  const unwatch = runner.watch();
  render();
  return {
    element,
    dispose: () => {
      off();
      unwatch();
    },
  };
}

// ------------------------------------------------------------------ chooser

/**
 * A sheet for choosing a path under the runner's folders: a file or store
 * to read, or a new name to write in a folder.
 */
export function choosePath(runner: RunnerService, options: Parameters<RunnerApi["choose"]>[0]): Promise<string | undefined> {
  const client = runner.client();
  if (client === undefined || !runner.available()) return Promise.reject(new RunnerError("Pair with the runner first (Jobs tab, This computer)", 0));
  return new Promise((resolve) => {
    let answered = false;
    let folder = "";
    let picked: string | undefined;
    const answer = (value: string | undefined) => {
      if (answered) return;
      answered = true;
      closeSheet();
      resolve(value);
    };
    const crumbs = h("p", { class: "note first mono runner-folder" });
    const list = h("ul", { class: "runner-files" });
    const found = h("div", { class: "runner-found" });
    const name = h("input", { class: "text-input mono runner-name", type: "text", value: options.suggested ?? "", "aria-label": "File name", spellcheck: "false" }) as HTMLInputElement;
    const choose = h("button", { class: "btn primary runner-choose", type: "button", disabled: true }, "Choose");
    const update = () => {
      choose.disabled = options.mode === "save" ? folder === "" || name.value.trim() === "" || /[\\/]/.test(name.value) : picked === undefined;
    };
    name.addEventListener("input", update);
    choose.addEventListener("click", () => answer(options.mode === "save" ? joinPath(folder, name.value.trim()) : picked));
    const pick = (entry: RunnerEntry, row: HTMLElement) => {
      if (options.mode === "save") {
        if (entry.type === "file") name.value = entry.name;
        update();
        return;
      }
      picked = entry.path;
      for (const li of list.querySelectorAll(".chosen")) li.classList.remove("chosen");
      row.classList.add("chosen");
      update();
    };
    const go = async (path: string) => {
      try {
        const listing = await client.files(path);
        folder = listing.path;
        picked = undefined;
        crumbs.textContent = folder === "" ? "The runner's folders" : folder;
        const rows: HTMLElement[] = [];
        if (folder !== "") rows.push(h("li", { class: "runner-up" }, h("button", { class: "linkish", type: "button", onclick: () => void go(listing.parent ?? "") }, "↑ Up")));
        for (const entry of listing.entries) {
          const label = `${entry.name}${entry.type === "dir" ? "/" : ""}`;
          const row = h("li", { class: `runner-entry ${entry.type}`, "data-path": entry.path });
          const button = h("button", { class: "linkish", type: "button" }, label);
          button.addEventListener("click", () => (entry.type === "dir" ? void go(entry.path) : pick(entry, row)));
          if (entry.type === "store") button.addEventListener("dblclick", () => void go(entry.path));
          row.append(button, entry.size !== undefined ? h("span", { class: "type" }, bytesText(entry.size)) : entry.type === "store" ? h("span", { class: "type" }, "store") : "");
          rows.push(row);
        }
        if (listing.truncated) rows.push(h("li", { class: "note" }, "More entries are not shown."));
        clear(list, ...rows);
        update();
      } catch (e) {
        clear(list, h("li", { class: "error" }, (e as Error).message));
      }
    };
    if (options.find !== undefined) {
      const wanted = options.find;
      found.textContent = `Looking for ${wanted.name} under the runner's folders…`;
      void client
        .find(wanted.name)
        .then((result) => {
          const matches = result.matches.filter((m) => wanted.size === undefined || m.size === wanted.size || m.type === "dir");
          if (matches.length === 0) {
            found.textContent = `${wanted.name} is not under the runner's folders${result.complete ? "" : " (searched part of them)"}: choose it below, or start the runner with its folder as a --root.`;
            return;
          }
          clear(
            found,
            h("p", { class: "note first" }, matches.length === 1 ? "Found:" : "Found these:"),
            h("ul", { class: "runner-files" }, ...matches.map((m) => h("li", { class: "runner-match" }, h("button", { class: "linkish mono", type: "button", onclick: () => answer(m.path) }, m.path)))),
          );
        })
        .catch((e) => {
          found.textContent = (e as Error).message;
        });
    }
    showSheet(
      sheet(
        options.title,
        [
          options.note ? h("p", { class: "note first" }, options.note) : h("span"),
          found,
          crumbs,
          list,
          options.mode === "save" ? h("label", { class: "field" }, h("span", {}, "Name"), name) : h("span"),
        ],
        [h("button", { class: "btn", type: "button", onclick: () => answer(undefined) }, "Cancel"), choose],
        { wide: true },
      ),
      () => answer(undefined),
    );
    const start = options.suggested?.includes("/") ? folderOf(options.suggested) : "";
    if (options.mode === "save" && options.suggested?.includes("/")) name.value = baseName(options.suggested);
    void go(start).then(() => {
      if (start !== "" && folder === "") void go("");
    });
  });
}

async function openDialog(wb: Workbench, runner: RunnerService): Promise<void> {
  const path = await choosePath(runner, { title: "Open a file on this computer", mode: "open", note: "A Zarr Vectors store, a tractogram, mesh, SWC or point table (served as a store: the file is read whole first), or a NIfTI image. The runner serves it to the viewer." });
  if (path !== undefined) await openOutput(wb, runner, { path, type: "file" });
}

/** What the runner serves to the viewer, each with Stop (its address then answers nothing, now and after a restart). */
async function servedDialog(runner: RunnerService): Promise<void> {
  const list = h("div", { class: "list runner-serves" });
  const fill = async () => {
    try {
      const serves = await runner.serves();
      clear(
        list,
        ...(serves.length === 0
          ? [h("p", { class: "empty" }, "Nothing is served.")]
          : serves.map((s) =>
              h(
                "div",
                { class: "runner-entry" },
                h("span", { class: "grow mono", title: s.path }, s.path),
                h("span", { class: "type" }, s.mode === "virtual" ? "read by a process" : s.mode),
                h(
                  "button",
                  {
                    class: "btn small",
                    type: "button",
                    onclick: () =>
                      void runner.stopServing(s.id).then(
                        () => void fill(),
                        (e) => toast((e as Error).message, "error"),
                      ),
                  },
                  "Stop",
                ),
              ),
            )),
      );
    } catch (e) {
      clear(list, h("p", { class: "empty error" }, `Could not list them: ${(e as Error).message}`));
    }
  };
  showSheet(sheet("Served to the viewer", [h("p", { class: "note first" }, "A layer reading one of these stops loading when it is stopped."), list], [h("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Close")]));
  await fill();
}

async function convertDialog(runner: RunnerService): Promise<void> {
  const input = await choosePath(runner, { title: "Convert a tractogram: the file", mode: "open", note: "A .trk, .tck or .trx file. It becomes a Zarr Vectors store with coarser levels, which the viewer reads a chunk at a time however large the file." });
  if (input === undefined) return;
  const output = await choosePath(runner, { title: "Convert a tractogram: the store to make", mode: "save", suggested: `${folderOf(input)}/${baseName(input).replace(TRACTOGRAM, "")}.zarr` });
  if (output === undefined) return;
  try {
    const job = await runner.start("convert", { input, output, levels: 3 });
    toast(`Started ${job.title} (PID ${job.pid ?? "queued"})`);
    void runner.wait(job.id).catch((e: Error) => ({ state: "failed", title: job.title, message: e.message }) as unknown as RunnerJob).then((done) => {
      if (done.state === "done") toast(`${done.title}: done. Open it from the Jobs tab.`);
      else if (done.state === "failed") toast(`${done.title} failed: ${done.message}`, "error");
    });
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ------------------------------------------------------------------ large files

/**
 * What the browser will copy of a tractogram of `bytes` bytes (the vectors
 * worker decides the same way, `spillPlan` in src/virtual/vectors/spill.ts):
 * every streamline, or past the storage limit (View settings) a sample.
 */
export async function tractogramPlan(bytes: number): Promise<SpillPlan> {
  const setting = tractogramDiskGigabytes();
  return spillPlan(bytes, diskBudget(setting === undefined ? undefined : setting * 2 ** 30, await storageEstimate()), true);
}

/** Tractograms already asked about this visit (name and size), so the notice on opening is not shown again. */
const asked = new Set<string>();
const askedKey = (file: { name: string; size: number }) => `${file.name}|${file.size}`;

/** Why a tractogram is past the limit, in plain words. */
function limitText(file: { name: string; size: number }, plan: SpillPlan): string {
  const limit = plan.budget > 0 ? `past the ${bytesText(plan.budget)} limit` : "and none is allowed";
  return `${file.name} is ${bytesText(file.size)}. Reading all of it here would copy about ${bytesText(plan.wholeBytes)} into this browser's storage, ${limit} (View settings → Local tractograms).`;
}

/** What a sample keeps, in plain words. */
const sampleText = (plan: SpillPlan) => `about ${bytesText(plan.bytes)} copied${plan.place === "memory" ? ", in memory" : ", deleted when the tab closes"}`;

/** Converts (or serves) a tractogram through the runner, after finding where it is under the runner's folders. */
async function throughRunner(wb: Workbench, runner: RunnerService, file: { name: string; size: number }, choice: "serve" | "convert"): Promise<void> {
  if (!runner.available()) {
    toast(`Start the runner on this computer (${START_COMMAND}) and pair it in Jobs → This computer, then open ${file.name} again.`, "error");
    wb.docks.show("jobs");
    return;
  }
  const path = await choosePath(runner, { title: `Where is ${file.name}?`, mode: "open", find: { name: file.name, size: file.size }, note: "The browser does not tell the page where a dropped file is: choose it under the runner's folders." }).catch((e) => {
    toast((e as Error).message, "error");
    return undefined;
  });
  if (path === undefined) return;
  if (choice === "serve") {
    toast(`The runner is reading ${file.name}; it is added when it is ready`);
    void openRunnerPath(wb, runner, path).catch((e) => toast(`Could not open ${file.name}: ${(e as Error).message}`, "error"));
    return;
  }
  const output = `${folderOf(path)}/${baseName(path).replace(TRACTOGRAM, "")}.zarr`;
  try {
    const job = await runner.start("convert", { input: path, output, levels: 3 });
    toast(`Converting ${file.name} (PID ${job.pid ?? "queued"}); it is added when done`);
    wb.docks.show("jobs");
    const done = await runner.wait(job.id);
    if (done.state === "done") await openRunnerPath(wb, runner, output);
    else if (done.state === "failed") toast(`Converting ${file.name} failed: ${done.message}`, "error");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

/**
 * A dropped tractogram whose points would pass the browser's storage limit
 * (`tractogramPlan`): asks whether to open a sample of it here, or have the
 * runner on this computer convert (or serve) the whole file.  Resolves
 * `open` when the drop should be opened in the browser as usual (nothing
 * too large, or a sample chosen: `sample` says which file, how sparse).
 */
export async function offerRunnerForLarge(wb: Workbench, runner: RunnerService, files: { name: string; size: number }[]): Promise<{ open: boolean; sample?: { name: string; every: number } }> {
  const tractograms = files.filter((f) => TRACTOGRAM.test(f.name));
  if (tractograms.length === 0) return { open: true };
  const file = tractograms.reduce((a, b) => (b.size > a.size ? b : a));
  const plan = await tractogramPlan(file.size);
  if (plan.mode === "whole") return { open: true };
  asked.add(askedKey(file));
  const paired = runner.available();
  const every = `1 in ${plan.every.toLocaleString("en")}`;
  const item = (name: string, text: string) => h("li", {}, h("strong", {}, name), `: ${text}`);
  const choice = await new Promise<"serve" | "convert" | "sample" | undefined>((resolve) => {
    let answered = false;
    const answer = (value: "serve" | "convert" | "sample" | undefined) => {
      if (answered) return;
      answered = true;
      closeSheet();
      resolve(value);
    };
    showSheet(
      sheet(
        "Too large to copy into the browser",
        [
          h("p", { class: "lead" }, limitText(file, plan), plan.mode === "none" ? " Even 1 in 10,000 streamlines is past it." : ""),
          h(
            "ul",
            { class: "runner-drop-choices" },
            ...(plan.mode === "sample" ? [item(`Open ${every}`, `${sampleText(plan)}. The view, regions and groups use only those streamlines; Track filtering's Run on this computer filters the whole file.`)] : []),
            item("Convert it", "the runner on this computer writes a Zarr Vectors store next to the file (about the file's size, on your disk). The viewer reads it a chunk at a time, every streamline."),
            item("Serve it", "the runner reads the whole file into memory and serves it."),
          ),
          ...(paired ? [] : [h("p", { class: "note" }, `The runner is not paired: start it (${START_COMMAND}) and pair it in Jobs → This computer.`)]),
        ],
        [
          h("button", { class: "btn", type: "button", onclick: () => answer(undefined) }, "Cancel"),
          h("button", { class: "btn runner-drop-serve", type: "button", onclick: () => answer("serve") }, "Serve it"),
          h("button", { class: `btn${paired || plan.mode !== "sample" ? " primary" : ""} runner-drop-convert`, type: "button", onclick: () => answer("convert") }, "Convert it"),
          ...(plan.mode === "sample" ? [h("button", { class: `btn${paired ? "" : " primary"} runner-drop-sample`, type: "button", onclick: () => answer("sample") }, `Open ${every}`)] : []),
        ],
      ),
      () => answer(undefined),
    );
  });
  if (choice === "sample") return { open: true, sample: { name: file.name, every: plan.every } };
  if (choice !== undefined) await throughRunner(wb, runner, file, choice);
  return { open: false };
}

/**
 * Says so when a tractogram opened another way (Open from device, a
 * folder, a reload) is read as a sample, with the runner's conversion
 * offered.  A drop asks first instead (`offerRunnerForLarge`).
 */
export function offerSampledTractograms(wb: Workbench, runner: RunnerService): void {
  wb.localData.onVirtualOpen(({ file }) => {
    if (!TRACTOGRAM.test(file.name) || asked.has(askedKey(file))) return;
    asked.add(askedKey(file));
    void tractogramPlan(file.size).then((plan) => {
      if (plan.mode === "whole") return;
      const what = plan.mode === "sample" ? ` Showing about 1 in ${plan.every.toLocaleString("en")} streamlines (${sampleText(plan)}).` : " It cannot be read here.";
      offer(`${limitText(file, plan)}${what} The runner on this computer can convert the whole file.`, [
        { label: "Not now" },
        { label: "Convert it", primary: true, run: () => void throughRunner(wb, runner, file, "convert") },
      ], 60000);
    });
  });
}

/** The SDK's runner API, over the service and these dialogs. */
export function runnerApi(wb: () => Workbench, runner: RunnerService): RunnerApi {
  return {
    available: () => runner.available(),
    onChanged: (callback) => runner.onChange(callback),
    folders: () => runner.info()?.roots ?? [],
    jobs: () => runner.jobs(),
    start: (kind, args) => runner.start(kind, args),
    wait: (id, onProgress, signal) => runner.wait(id, onProgress, signal),
    cancel: (id) => runner.cancel(id),
    pathOf: (source) => runner.pathOf(source),
    choose: (options) => choosePath(runner, options),
    open: (path, options) => openRunnerPath(wb(), runner, path, options?.name),
  };
}
